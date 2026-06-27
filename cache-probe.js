#!/usr/bin/env node
// cache-probe.js — 绕开压测工具，直接探测渠道对某模型的 prompt cache 支持
// 重点: 对比【非流式】vs【流式】，验证是不是流式导致 cache token 读不到/不缓存
// 用法:
//   BASE_URL=https://你的渠道 API_KEY=sk-xxx MODEL=claude-opus-4-6 node cache-probe.js

const https = require("https");
const http = require("http");
const urlmod = require("url");

const BASE_URL = (process.env.BASE_URL || process.argv[2] || "").replace(/\/+$/, "");
const API_KEY = process.env.API_KEY || process.argv[3] || "";
const MODEL = process.env.MODEL || process.argv[4] || "claude-opus-4-6";
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_PROMPT_CACHING_BETA = "prompt-caching-2024-07-31";

if (!BASE_URL || !API_KEY) {
  console.error("缺少参数。用法: BASE_URL=... API_KEY=... MODEL=claude-opus-4-6 node cache-probe.js");
  process.exit(1);
}

// 稳定 ~2000 token 多样文本（和压测工具同款，>1024 门槛）
const words = ["system","context","reference","document","section","analysis","summary","detail","example","note","policy","guide","overview","metric","baseline","scenario","parameter","threshold","latency","throughput","cache","prefix","token","payload","request","response","channel","upstream","model","session"];
let PAD = ""; let i = 0;
while (PAD.length < 8000) { PAD += words[i % words.length] + "-" + (i % 97) + " "; i++; }
const SYS_TEXT = "You are a helpful assistant. Be concise.\n\n" + PAD;

// 统一请求：stream=false 直接拿 JSON usage；stream=true 解析 SSE 聚合 usage
function call(body, stream) {
  return new Promise(function (resolve, reject) {
    const u = urlmod.parse(BASE_URL + "/v1/messages");
    const mod = u.protocol === "https:" ? https : http;
    const payload = JSON.stringify(Object.assign({}, body, { stream: !!stream }));
    const baseHeaders = {
      "x-api-key": API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-beta": ANTHROPIC_PROMPT_CACHING_BETA,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    };

    function sendOnce(headers, done) {
      const req = mod.request({
        hostname: u.hostname, port: u.port, path: u.path, method: "POST", headers: headers,
      }, done);
      req.on("error", reject);
      req.write(payload); req.end();
    }

    function finish(res, raw) {
      if (!stream) {
        let j; try { j = JSON.parse(raw); } catch (e) { j = { parseError: raw.slice(0, 300) }; }
        return resolve({ status: res.statusCode, usage: (j && j.usage) || {}, text: textOf(j), raw: raw });
      }
      // 解析 SSE：message_start 带 cache usage，message_delta 带 output
      const usage = {}; let text = "";
      raw.split("\n").forEach(function (line) {
        const t = line.trim();
        if (!t.startsWith("data:")) return;
        const p = t.slice(5).trim();
        if (!p || p === "[DONE]") return;
        let evt; try { evt = JSON.parse(p); } catch (e) { return; }
        if (evt.type === "message_start" && evt.message && evt.message.usage) Object.assign(usage, evt.message.usage);
        else if (evt.type === "message_delta" && evt.usage) Object.assign(usage, evt.usage);
        else if (evt.type === "content_block_delta" && evt.delta && evt.delta.text) text += evt.delta.text;
      });
      resolve({ status: res.statusCode, usage: usage, text: text, raw: raw });
    }

    function collect(res, headersUsed, allowRetry) {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", function (c) { raw += c; });
      res.on("end", function () {
        if (allowRetry && res.statusCode === 400 && headersUsed["anthropic-beta"] && /invalid beta flag/i.test(raw)) {
          const retryHeaders = Object.assign({}, headersUsed);
          delete retryHeaders["anthropic-beta"];
          return sendOnce(retryHeaders, function(retryRes) { collect(retryRes, retryHeaders, false); });
        }
        finish(res, raw);
      });
    }

    sendOnce(baseHeaders, function (res) {
      collect(res, baseHeaders, true);
    });
  });
}

function textOf(j) {
  if (j && j.content && j.content[0] && j.content[0].text) return j.content[0].text;
  return "ok";
}

function show(tag, r) {
  const u = r.usage || {};
  console.log(tag, "status=" + r.status,
    "| input=" + u.input_tokens,
    "create=" + u.cache_creation_input_tokens,
    "read=" + u.cache_read_input_tokens,
    "| tier=" + u.service_tier, "geo=" + u.inference_geo);
  if (r.status >= 400) console.log("   错误:", r.raw.slice(0, 250));
}

// 跑两轮（共享同一 system 前缀）：第1次应 create>0，第2次应 read>0
async function twoTurns(stream) {
  const label = stream ? "【流式 stream=true】" : "【非流式 stream=false】";
  console.log("\n===== " + label + " system+cache_control，连发2次 =====");
  const sys = [{ type: "text", text: SYS_TEXT, cache_control: { type: "ephemeral" } }];
  let msgs = [{ role: "user", content: "推荐一部电影" }];
  const r1 = await call({ model: MODEL, system: sys, messages: msgs, max_tokens: 50 }, stream);
  show("第1次:", r1);
  msgs.push({ role: "assistant", content: r1.text || "ok" });
  msgs.push({ role: "user", content: "为什么推荐它" });
  const r2 = await call({ model: MODEL, system: sys, messages: msgs, max_tokens: 50 }, stream);
  show("第2次:", r2);
  return [r1, r2];
}

(async function () {
  console.log("渠道:", BASE_URL, "| 模型:", MODEL, "| PAD≈", Math.round(PAD.length / 4), "tokens");
  const ns = await twoTurns(false);   // 非流式
  const st = await twoTurns(true);    // 流式
  console.log("\n========== 判定 ==========");
  const nsCreate = Number((ns[0].usage || {}).cache_creation_input_tokens) || 0;
  const stCreate = Number((st[0].usage || {}).cache_creation_input_tokens) || 0;
  if (nsCreate > 0 && stCreate === 0) {
    console.log("→ 非流式能缓存、流式不能/读不到：问题在【流式】。压测工具缓存请求应改用非流式，或修流式 usage 解析。");
  } else if (nsCreate > 0 && stCreate > 0) {
    console.log("→ 流式/非流式都能缓存：渠道没问题，是压测工具其它环节，把这个输出发我。");
  } else {
    console.log("→ 两种都 create=0：这个 key/模型在渠道侧就不建缓存（和工具、和流式都无关），拿这个结果找渠道。");
  }
})();
