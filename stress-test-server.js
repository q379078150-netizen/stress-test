#!/usr/bin/env node
// stress-test-server.js — 渠道压力测试（固定时长 + 连续对话 + Cache）
// 用法: node stress-test-server.js
// 默认端口: 3457

const http = require("http");
const url = require("url");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3457;
const HTML_FILE = path.join(__dirname, "index.html");
const REPORT_DIR = path.join(__dirname, "..", "..", "logs", "stress-tests");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function timestampForFile(date) {
  const pad = function(n) { return String(n).padStart(2, "0"); };
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function sanitizeConfig(config) {
  if (!config) return {};
  return {
    baseUrl: config.baseUrl || "",
    concurrency: Number(config.concurrency) || 0,
    durationSeconds: Number(config.durationSeconds) || 0,
    targetRpm: Number(config.targetRpm) || 0,
    rpmCache: !!config.rpmCache,
    mode: config.mode || "",
    roundsPerSession: Number(config.roundsPerSession) || 0,
    timeout: Number(config.timeout) || 0,
    models: Array.isArray(config.models) ? config.models : [],
    imageSize: config.imageSize || "1024x1024",
  };
}

function normalizeConfig(config) {
  return {
    baseUrl: String(config.baseUrl || "").trim().replace(/\/+$/, ""),
    apiKey: String(config.apiKey || "").trim(),
    concurrency: Math.max(1, Number(config.concurrency) || 1),
    durationSeconds: Math.max(1, Number(config.durationSeconds) || 20),
    targetRpm: Math.max(0, Number(config.targetRpm) || 0),
    rpmCache: !!config.rpmCache,
    roundsPerSession: Math.max(1, Number(config.roundsPerSession) || 6),
    timeout: Math.max(1000, Number(config.timeout) || 120000),
    mode: String(config.mode || "burst").trim(),
    maxTokens: Math.max(5, Number(config.maxTokens) || (config.mode === 'conversation' ? 20 : 5)),
    imageSize: config.imageSize || "1024x1024",
    models: [...new Set((Array.isArray(config.models) ? config.models : []).map(function(model) {
      return String(model || "").trim();
    }).filter(Boolean))],
  };
}

function saveReportToDisk(report) {
  ensureDir(REPORT_DIR);
  const filename = report.runId + ".json";
  const filePath = path.join(REPORT_DIR, filename);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2), "utf8");
  return filePath;
}

// ============================================================
// 图片生成压测 prompt 池
// 原则：最短英文名词，token 消耗极低（1-2 tokens），安全无风险
// ============================================================
const IMAGE_PROMPTS = [
  "a cat",
  "a dog",
  "a tree",
  "a flower",
  "a mountain",
  "a lake",
  "a bird",
  "a fish",
];

// ============================================================
// 简短真实语句池 — 模拟真人随手发的短句（替代 "hi"，不易被识别为压测）
// 用于 burst / RPM 单句模式
// ============================================================
const SHORT_MSGS = [
  "你好",
  "在吗",
  "今天天气怎么样",
  "讲个冷笑话",
  "1+1等于几",
  "推荐一本书",
  "用一句话介绍你自己",
  "周末适合做什么",
  "怎么快速入睡",
  "帮我想个网名",
  "什么是黑洞",
  "中午吃什么好",
  "怎么提高专注力",
  "翻译一下 good morning",
  "说句鼓励的话",
];

// 多轮简短对话题库 — 每轮一句短追问，保持同一话题（用于缓存/连续对话模式）
// ============================================================
// 连续对话题库
// ============================================================
const CONVERSATION_TOPICS = [
  {
    topic: "chat",
    system: "You are a helpful assistant. Be concise. Reply in one short sentence.",
    turns: [
      "推荐一部电影",
      "为什么推荐它",
      "还有类似的吗",
      "哪部最经典",
      "适合周末看吗",
      "谢谢",
    ],
  },
];

// ============================================================
// 客户端身份池 — 模拟不同真实客户端/SDK
// 每个 worker / session 固定一个身份，整轮压测不变（像一个真实 agent）
// ============================================================
const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  "python-requests/2.31.0",
  "axios/1.6.8",
  "OpenAI/NodeJS/4.38.0",
  "curl/8.4.0",
];

// 为第 idx 个 worker/session 生成一个稳定身份（同一 idx 多次调用结果一致）
function makeIdentity(idx) {
  const ua = UA_POOL[idx % UA_POOL.length];
  // 身份内的稳定后缀：用 idx 派生，不用随机，确保整轮不变
  const clientId = "client-" + idx.toString(36).padStart(4, "0");
  return {
    ua: ua,
    clientId: clientId,
  };
}

// ============================================================
// 压测引擎
// ============================================================
class StressTestEngine {
  constructor() {
    this.reset();
  }

  reset() {
    this.running = false;
    this.startTime = null;
    this.endTime = null;
    this.config = {};
    this.runId = null;
    this.reportPath = null;
    this.stopRequested = false;
    this.totalSent = 0;
    this.totalDone = 0;
    this.success = 0;
    this.fail = 0;
    this.rateLimited = 0;   // 429 单独计数 — 综合压测核心指标：判断承载力上限
    this.inflight = 0;      // RPM 开环模式：当前在途请求数
    this.peakInflight = 0;  // RPM 开环模式：峰值在途并发（=真实洪峰打到服务端的并发）
    this.arrivals = 0;      // RPM 开环模式：已到达单元数（缓存模式=用户数，否则=请求数）
    this.launchEndTime = null;  // RPM 发射阶段结束时间
    this.cacheHits = 0;
    this.latencies = [];
    this.allLatencies = [];
    this.modelStats = {};
    this.perTurnCache = {};
    this.errors = [];
    this.conversationsDone = 0;
    this.conversationsFailed = 0;
    this.lastReport = null;
  }

  async run(config) {
    this.reset();
    this.config = config;
    this.runId = "stress-" + timestampForFile(new Date()) + "-" + Math.random().toString(36).slice(2, 6);
    this.running = true;
    this.stopRequested = false;
    this.startTime = Date.now();

    const { baseUrl, apiKey, concurrency, durationSeconds, models, roundsPerSession, mode, maxTokens } = config;
    const isBurst = mode === "burst";
    const rounds = roundsPerSession || 6;
    const maxTok = maxTokens || (isBurst ? 20 : 150);

    // RPM 开环模式
    if (mode === "rpm") {
      await this.rpmOpenLoop(config);
      this.endTime = Date.now();
      this.running = false;
      this.stopRequested = false;
      const report = this.generateReport();
      try {
        this.reportPath = saveReportToDisk(report);
        report.reportPath = this.reportPath;
      } catch (e) {
        report.reportSaveError = e.message;
        console.error("[压测报告保存失败]", e.message);
      }
      this.lastReport = report;
      return this.lastReport;
    }

    // 图片生成模式 — 一次性批量并发，所有请求同时发出，全部完成即结束
    if (mode === "image") {
      const imageSize = config.imageSize || "1024x1024";
      this._rpmControllers = new Set();
      const promises = [];
      for (let w = 0; w < concurrency; w++) {
        const identity = makeIdentity(w);
        const model = models[w % models.length];
        const prompt = IMAGE_PROMPTS[w % IMAGE_PROMPTS.length];
        promises.push(this.fireImageGeneration(baseUrl, apiKey, model, prompt, imageSize, config.timeout, identity));
      }
      console.log("[压测] 图片生成 一次性 " + concurrency + " 个并发请求");
      await Promise.all(promises);
      this._rpmControllers = null;
      this.endTime = Date.now();
      this.running = false;
      this.stopRequested = false;
      const report = this.generateReport();
      try { this.reportPath = saveReportToDisk(report); report.reportPath = this.reportPath; } catch (e) { report.reportSaveError = e.message; }
      this.lastReport = report;
      return this.lastReport;
    }

    // 独立请求模式 — 一次性批量并发，所有请求同时发出，全部完成即结束
    if (isBurst) {
      this._rpmControllers = new Set();
      const promises = [];
      for (let w = 0; w < concurrency; w++) {
        const identity = makeIdentity(w);
        const model = models[w % models.length];
        const q = SHORT_MSGS[w % SHORT_MSGS.length];
        promises.push(this.fireOneOpenLoop(baseUrl, apiKey, model, q, maxTok, config.timeout, identity));
      }
      console.log("[压测] 独立请求 一次性 " + concurrency + " 个并发请求");
      await Promise.all(promises);
      this._rpmControllers = null;
      this.endTime = Date.now();
      this.running = false;
      this.stopRequested = false;
      const report = this.generateReport();
      try { this.reportPath = saveReportToDisk(report); report.reportPath = this.reportPath; } catch (e) { report.reportSaveError = e.message; }
      this.lastReport = report;
      return this.lastReport;
    }

    // 连续对话模式 — 多 session 并发，每 session 顺序做 N 轮对话
    const sessions = [];
    const sessionsPerModelTarget = Math.ceil(concurrency / (models.length || 1));
    let topicIdx = 0;

    for (const model of models) {
      for (let s = 0; s < sessionsPerModelTarget; s++) {
        const topic = CONVERSATION_TOPICS[topicIdx % CONVERSATION_TOPICS.length];
        const sid = model.slice(0, 12) + "-s" + s + "-" + Math.random().toString(36).slice(2, 5);
        sessions.push({
          model,
          sessionId: sid,
          identity: makeIdentity(topicIdx),
          system: topic.system + " [SessionID: " + sid + "]",
          turns: topic.turns.slice(0, rounds),
          topic: topic.topic,
        });
        topicIdx++;
      }
    }

    for (let i = sessions.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [sessions[i], sessions[j]] = [sessions[j], sessions[i]];
    }

    console.log("[压测] 连续对话 " + sessions.length + " 个会话, 并发 " + concurrency + " 每会话最多 " + rounds + " 轮");

    const sessionQueue = [...sessions];
    this._activeSessions = sessions;
    const workers = [];

    for (let w = 0; w < concurrency; w++) {
      workers.push(this.sessionWorker(sessionQueue, w, sessions));
    }

    const durationMs = (durationSeconds || 20) * 1000;
    const stopTimer = setTimeout(() => {
      this.running = false;
      if (this._activeSessions) {
        for (const session of this._activeSessions) {
          if (session._currentController) {
            try { session._currentController.abort(); } catch (e) {}
          }
          if (session._currentTimer) {
            clearTimeout(session._currentTimer);
            session._currentTimer = null;
          }
          session._currentController = null;
        }
      }
    }, durationMs);

    await Promise.all(workers);
    clearTimeout(stopTimer);

    this.endTime = Date.now();
    this.running = false;
    this.stopRequested = false;

    const report = this.generateReport();
    try {
      this.reportPath = saveReportToDisk(report);
      report.reportPath = this.reportPath;
    } catch (e) {
      report.reportSaveError = e.message;
      console.error("[压测报告保存失败]", e.message);
    }
    this.lastReport = report;
    return this.lastReport;
  }

  // ============================================================
  // RPM 开环压测 — 按固定速率发射请求，不等返回（Little's 法则验证）
  // 真实用户 = 固定发射频率；在途并发由「速率 × 延迟」自然形成
  // ============================================================
  async rpmOpenLoop(config) {
    const { baseUrl, apiKey, targetRpm, durationSeconds, models, timeout, maxTokens, rpmCache, roundsPerSession } = config;
    const maxTok = maxTokens || 20;
    const rps = targetRpm / 60;
    const intervalMs = rps > 0 ? 1000 / rps : 1000;
    const durationMs = (durationSeconds || 20) * 1000;
    const deadline = this.startTime + durationMs;
    const burstQuestions = SHORT_MSGS;
    const rounds = rpmCache ? Math.max(1, roundsPerSession || 4) : 1;
    const isImage = config.mode === "image";
    const imageSize = config.imageSize || "1024x1024";

    let launched = 0;
    const inflightPromises = new Set();
    // 记录所有在途请求的 AbortController，硬停时立即中止
    this._rpmControllers = new Set();

    // 发射一个单元（用户或单请求）——不阻塞发射节拍
    const self = this;
    function fireOne() {
      const identity = makeIdentity(launched);
      const model = models[launched % models.length];
      launched++;
      self.arrivals = launched;   // 到达单元数：缓存模式=用户数，否则=请求数

      let p;
      if (isImage) {
        const prompt = IMAGE_PROMPTS[launched % IMAGE_PROMPTS.length];
        p = self.fireImageGeneration(baseUrl, apiKey, model, prompt, imageSize, timeout, identity);
      } else if (rpmCache) {
        const sid = "rpmuser-" + launched + "-" + identity.clientId;
        const session = {
          model: model,
          sessionId: sid,
          identity: identity,
          system: "You are a helpful assistant. Be concise. [SessionID: " + sid + "]",
          turns: CONVERSATION_TOPICS[0].turns.slice(0, rounds),
        };
        p = self.runCachedConversation(session, baseUrl, apiKey, timeout, maxTokens || 150);
      } else {
        const q = burstQuestions[Math.floor(Math.random() * burstQuestions.length)];
        p = self.fireOneOpenLoop(baseUrl, apiKey, model, q, maxTok, timeout, identity);
      }
      inflightPromises.add(p);
      p.finally(function() { inflightPromises.delete(p); });
    }

    // 绝对时间锚点发射：第 n 个单元在 startTime + n*intervalMs 发射
    // 不被会话启动开销拖累，无累积漂移 → 速率精准稳定维持
    let fireIdx = 0;
    while (this.running) {
      const nextFireAt = this.startTime + fireIdx * intervalMs;
      if (nextFireAt >= deadline) break;          // 60 秒后不再发新单元
      const wait = nextFireAt - Date.now();
      if (wait > 0) {
        await new Promise(function(r) { setTimeout(r, wait); });
        if (!this.running) break;
      }
      // 若已落后（系统卡顿），补发追平节拍，保证维持目标 RPM
      fireOne();
      fireIdx++;
    }
    // 发射阶段结束时间（用于精准计算达成速率，不被收尾时间稀释）
    this.launchEndTime = Date.now();

    // 到点：硬停。给在途请求 2 秒宽限收尾，超时一律 abort
    const GRACE_MS = 2000;
    const graceEnd = Date.now() + GRACE_MS;
    while (inflightPromises.size > 0 && Date.now() < graceEnd && this.running) {
      await new Promise(function(r) { setTimeout(r, 100); });
    }
    // 仍未收尾的，强制中止
    for (const ctrl of this._rpmControllers) {
      try { ctrl.abort(); } catch (e) {}
    }
    // 标记停止，让会话内部的轮次循环不再继续
    const wasRunning = this.running;
    this.running = false;
    await Promise.allSettled([...inflightPromises]);
    this.running = wasRunning;   // 恢复（外层 run 会再设 false）
    this._rpmControllers = null;
  }

  // 一段完整的多轮缓存对话（用于 RPM 缓存模式的每个到达用户）
  // 串行做 N 轮，用 inflight 计数体现"这个用户占着一个并发槽"
  async runCachedConversation(session, baseUrl, apiKey, timeout, maxTok) {
    this.inflight++;
    if (this.inflight > this.peakInflight) this.peakInflight = this.inflight;
    let sessionOk = true;
    try {
      const cacheBreak = "CB-" + Math.random().toString(36).slice(2, 8) + "-" + Date.now();
      const cacheHeaders = {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
        "User-Agent": session.identity.ua,
        "X-Client-Id": session.identity.clientId,
      };
      const msgs = [];
      let turnNum = 0;

      for (const userMsg of (session.turns || [])) {
        if (!this.running) break;
        turnNum++;
        msgs.push({ role: "user", content: userMsg });
        const start = Date.now();
        this.totalSent++;

        try {
          const cachePad = "CACHE_PADDING_" + cacheBreak + "X".repeat(4000);
          const body = JSON.stringify({
            model: session.model,
            system: [
              { type: "text", text: session.system, cache_control: { type: "ephemeral" } },
              { type: "text", text: cachePad, cache_control: { type: "ephemeral" } }
            ],
            messages: msgs,
            max_tokens: maxTok,
            stream: true,                       // 流式：SSE
          });

          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), timeout || 30000);
          session._currentController = ctrl;
          if (this._rpmControllers) this._rpmControllers.add(ctrl);
          const parsed = url.parse(baseUrl + "/v1/messages");
          const httpModule = parsed.protocol === "https:" ? require("https") : require("http");
          const res = await new Promise(function(resolve, reject) {
            const req = httpModule.request({
              hostname: parsed.hostname, port: parsed.port, path: parsed.path, method: "POST",
              headers: Object.assign({ "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }, cacheHeaders),
            }, function(r) { resolve(r); });
            req.on("error", function(e) { reject(e); });
            session._currentReq = req;
            ctrl.signal.addEventListener("abort", function() { try { req.destroy(); } catch (e) {} });
            req.write(body); req.end();
          });

          // 错误状态：读完 body 报错
          if (res.statusCode >= 400) {
            const chunks = [];
            res.on("data", function(c) { chunks.push(c); });
            await new Promise(function(resolve) { res.on("end", resolve); });
            clearTimeout(t);
            session._currentController = null; session._currentReq = null;
            if (this._rpmControllers) this._rpmControllers.delete(ctrl);
            const errText = Buffer.concat(chunks).toString();
            let errData; try { errData = JSON.parse(errText); } catch (e) { errData = null; }
            const errMsg = (errData && errData.error && errData.error.message) || "HTTP " + res.statusCode;
            this.fail++;
            if (res.statusCode === 429) this.rateLimited++;
            this.totalDone++;
            this.errors.push({ model: session.model, sessionId: session.sessionId, turn: turnNum, error: errMsg, status: res.statusCode, time: Date.now() });
            this._ensureModelStat(session.model);
            sessionOk = false; break;
          }

          // 流式解析 SSE：message_start 带 cache usage，content_block_delta 带文本，message_delta 带 output tokens
          let ttfb = 0;
          let fullContent = "";
          const usage = {};
          let buffer = "";
          const self2 = this;
          res.setEncoding("utf8");
          await new Promise(function(resolve, reject) {
            res.on("data", function(chunk) {
              if (ttfb === 0) ttfb = Date.now() - start;   // 首字节时间
              if (!self2.running) { try { res.destroy(); } catch (e) {} return; }
              buffer += chunk;
              const parts = buffer.split("\n");
              buffer = parts.pop();
              for (const line of parts) {
                const trimmed = line.trim();
                if (!trimmed.startsWith("data:")) continue;
                const payload = trimmed.slice(5).trim();
                if (!payload || payload === "[DONE]") continue;
                let evt; try { evt = JSON.parse(payload); } catch (e) { continue; }
                if (evt.type === "message_start" && evt.message && evt.message.usage) {
                  Object.assign(usage, evt.message.usage);    // input/cache_read/cache_creation tokens
                } else if (evt.type === "content_block_delta" && evt.delta && evt.delta.text) {
                  fullContent += evt.delta.text;
                } else if (evt.type === "message_delta" && evt.usage) {
                  Object.assign(usage, evt.usage);            // output_tokens
                }
              }
            });
            res.on("end", resolve);
            res.on("error", reject);
          });
          clearTimeout(t);
          session._currentController = null; session._currentReq = null;
          if (this._rpmControllers) this._rpmControllers.delete(ctrl);
          if (ttfb === 0) ttfb = Date.now() - start;

          this.totalDone++;
          if (fullContent.length > 0) {
            this.handleSuccess(session, turnNum, start, ttfb, fullContent, usage);
            msgs.push({ role: "assistant", content: fullContent });
          } else {
            this.fail++;
            this.errors.push({ model: session.model, sessionId: session.sessionId, turn: turnNum, error: "空响应", status: 200, time: Date.now() });
            this._ensureModelStat(session.model);
            sessionOk = false; break;
          }
        } catch (e) {
          if (!this.running || this.stopRequested) { this.totalDone++; sessionOk = false; break; }
          this.fail++; this.totalDone++;
          this.allLatencies.push(Date.now() - start);
          this.errors.push({ model: session.model, sessionId: session.sessionId, turn: turnNum, error: e.name === "AbortError" ? "timeout" : e.message, time: Date.now() });
          this._ensureModelStat(session.model);
          sessionOk = false; break;
        }
      }
      if (sessionOk) this.conversationsDone++; else this.conversationsFailed++;
    } finally {
      this.inflight--;
    }
  }

  // 确保某模型的 fail 计数存在（错误路径用）
  _ensureModelStat(model) {
    if (!this.modelStats[model]) {
      this.modelStats[model] = { success: 0, fail: 1, latencies: [], ttfbList: [], cacheHits: 0, totalPromptTokens: 0, totalCompletionTokens: 0, turnLatencies: {} };
    } else {
      this.modelStats[model].fail++;
    }
  }

  async fireOneOpenLoop(baseUrl, apiKey, model, q, maxTok, timeout, identity) {
    const start = Date.now();
    this.totalSent++;
    this.inflight++;
    if (this.inflight > this.peakInflight) this.peakInflight = this.inflight;

    const fakeSession = { model: model, sessionId: identity.clientId, identity: identity };

    try {
      const body = JSON.stringify({
        model: model,
        messages: [{ role: "user", content: q }],
        max_tokens: maxTok,
        stream: true,
        stream_options: { include_usage: true },
      });
      const headers = {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json",
        "User-Agent": identity.ua,
        "X-Client-Id": identity.clientId,
      };

      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeout || 30000);
      if (this._rpmControllers) this._rpmControllers.add(ctrl);
      const res = await fetch(baseUrl + "/v1/chat/completions", {
        method: "POST", headers: headers, body: body, signal: ctrl.signal,
      });
      clearTimeout(t);
      if (this._rpmControllers) this._rpmControllers.delete(ctrl);
      const ttfb = Date.now() - start;

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        let errData;
        try { errData = JSON.parse(errText); } catch (e) { errData = null; }
        const errMsg = (errData && errData.error && errData.error.message) || "HTTP " + res.status;
        this.fail++;
        if (res.status === 429) this.rateLimited++;
        this.totalDone++;
        this.allLatencies.push(Date.now() - start);
        this.errors.push({ model: model, turn: 1, error: errMsg, status: res.status, time: Date.now() });
        if (!this.modelStats[model]) {
          this.modelStats[model] = { success: 0, fail: 1, latencies: [], ttfbList: [], cacheHits: 0, totalPromptTokens: 0, totalCompletionTokens: 0, turnLatencies: {} };
        } else { this.modelStats[model].fail++; }
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "", fullContent = "", usage = {};
      while (true) {
        if (!this.running) { reader.cancel(); break; }
        const r = await reader.read();
        if (r.value) buffer += decoder.decode(r.value, { stream: !r.done });
        if (r.done) break;
      }
      const lines = buffer.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:") || trimmed === "data: [DONE]") continue;
        try {
          const chunk = JSON.parse(trimmed.slice(5).trim());
          if (chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content) {
            fullContent += chunk.choices[0].delta.content;
          }
          if (chunk.usage) usage = chunk.usage;
        } catch (e) {}
      }

      this.totalDone++;
      if (fullContent.length > 0) {
        this.handleSuccess(fakeSession, 1, start, ttfb, fullContent, usage);
      } else {
        this.fail++;
        if (!this.modelStats[model]) {
          this.modelStats[model] = { success: 0, fail: 1, latencies: [], ttfbList: [], cacheHits: 0, totalPromptTokens: 0, totalCompletionTokens: 0, turnLatencies: {} };
        } else { this.modelStats[model].fail++; }
      }
    } catch (e) {
      if (!this.running || this.stopRequested) { this.totalDone++; return; }
      this.fail++;
      this.totalDone++;
      this.allLatencies.push(Date.now() - start);
      this.errors.push({ model: model, turn: 1, error: e.name === "AbortError" ? "timeout" : e.message, time: Date.now() });
      if (!this.modelStats[model]) {
        this.modelStats[model] = { success: 0, fail: 1, latencies: [], ttfbList: [], cacheHits: 0, totalPromptTokens: 0, totalCompletionTokens: 0, turnLatencies: {} };
      } else { this.modelStats[model].fail++; }
    } finally {
      this.inflight--;
    }
  }

  // ============================================================
  // 图片生成单次请求
  // 成本最小化：n=1, size=1024x1024(最小), quality=low(最低档)
  // 不存储 base64 图片数据，只判断成功/失败
  // 安全：prompt 仅用极短名词，绝对不触发内容审核
  // ============================================================
  async fireImageGeneration(baseUrl, apiKey, model, prompt, imageSize, timeout, identity) {
    const start = Date.now();
    this.totalSent++;
    this.inflight++;
    if (this.inflight > this.peakInflight) this.peakInflight = this.inflight;

    const fakeSession = { model: model, sessionId: identity.clientId, identity: identity };

    try {
      const body = JSON.stringify({
        model: model,
        prompt: prompt,
        n: 1,
        size: imageSize || "1024x1024",
        quality: "low",
      });

      const headers = {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json",
        "User-Agent": identity.ua,
        "X-Client-Id": identity.clientId,
      };

      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeout || 120000);
      if (this._rpmControllers) this._rpmControllers.add(ctrl);

      const res = await fetch(baseUrl + "/v1/images/generations", {
        method: "POST", headers: headers, body: body, signal: ctrl.signal,
      });
      clearTimeout(t);
      if (this._rpmControllers) this._rpmControllers.delete(ctrl);
      const ttfb = Date.now() - start;

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        let errData; try { errData = JSON.parse(errText); } catch (e) { errData = null; }
        const errMsg = (errData && errData.error && errData.error.message) || "HTTP " + res.status;
        this.fail++;
        if (res.status === 429) this.rateLimited++;
        this.totalDone++;
        this.allLatencies.push(Date.now() - start);
        this.errors.push({ model: model, turn: 1, error: errMsg, status: res.status, time: Date.now() });
        this._ensureModelStat(model);
        return;
      }

      // 读取响应，仅取 data[0] 是否存在，不保留 b64_json 内容
      const json = await res.json().catch(() => null);
      this.totalDone++;

      if (json && json.data && json.data.length > 0) {
        this.handleSuccess(fakeSession, 1, start, ttfb, "ok", {});
      } else {
        this.fail++;
        this._ensureModelStat(model);
        this.errors.push({ model: model, turn: 1, error: "空响应", status: 200, time: Date.now() });
      }
    } catch (e) {
      if (!this.running || this.stopRequested) { this.totalDone++; return; }
      this.fail++;
      this.totalDone++;
      this.allLatencies.push(Date.now() - start);
      this.errors.push({ model: model, turn: 1, error: e.name === "AbortError" ? "timeout" : e.message, time: Date.now() });
      this._ensureModelStat(model);
    } finally {
      this.inflight--;
    }
  }

  async sessionWorker(queue, workerIdx, sessionsRef) {
    const { baseUrl, apiKey, timeout, mode, maxTokens } = this.config;
    const isBurst = mode === "burst";
    const maxTok = maxTokens || (isBurst ? 20 : 150);
    const headers = {
      "Authorization": "Bearer " + apiKey,
      "Content-Type": "application/json",
    };

    // 独立请求模式的题库 — 使用简短真实语句
    const burstQuestions = SHORT_MSGS;

    while (this.running && (queue.length > 0 || isBurst)) {
      let session;
      if (isBurst) {
        // 独立请求模式：每个 worker 用自己的 session（含固定身份），不停地发新请求
        session = sessionsRef[workerIdx];
        if (!session) break;
      } else {
        session = queue.shift();
        if (!session) break;
      }

      if (isBurst) {
        // 独立请求：不带历史，使用本 worker 的固定客户端身份（像一个稳定的真实客户端）
        if (!this.running) continue;
        const q = burstQuestions[Math.floor(Math.random() * burstQuestions.length)];
        const start = Date.now();
        this.totalSent++;

        try {
          const body = JSON.stringify({
            model: session.model,
            messages: [{ role: "user", content: q }],
            max_tokens: maxTok,
            stream: true,
            stream_options: { include_usage: true },
          });

          // 使用本 worker 固定身份的 headers（整轮压测不变，模拟一个真实客户端）
          const burstHeaders = {
            "Authorization": "Bearer " + apiKey,
            "Content-Type": "application/json",
            "User-Agent": session.identity.ua,
            "X-Client-Id": session.identity.clientId,
          };

          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), timeout || 30000);
          session._currentController = ctrl;
          session._currentTimer = t;
          const res = await fetch(baseUrl + "/v1/chat/completions", {
            method: "POST", headers: burstHeaders, body, signal: ctrl.signal,
          });
          clearTimeout(t);
          session._currentController = null;
          session._currentTimer = null;

          const ttfb = Date.now() - start;

          if (!res.ok) {
            const errText = await res.text().catch(() => "");
            let errData;
            try { errData = JSON.parse(errText); } catch (e) { errData = null; }
            const errMsg = (errData && errData.error && errData.error.message) || "HTTP " + res.status;
            this.fail++;
            if (res.status === 429) this.rateLimited++;   // 限流单独计数
            this.totalDone++;
            this.errors.push({ model: session.model, turn: 1, error: errMsg, status: res.status, time: Date.now() });
            if (!this.modelStats[session.model]) {
              this.modelStats[session.model] = { success: 0, fail: 1, latencies: [], ttfbList: [], cacheHits: 0, totalPromptTokens: 0, totalCompletionTokens: 0, turnLatencies: {} };
            } else { this.modelStats[session.model].fail++; }
            this.allLatencies.push(Date.now() - start);
            continue;
          }

          // 流式读取 — 检查 stop 信号，立即中止
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "", fullContent = "", usage = {};
          while (true) {
            if (!this.running) { reader.cancel(); break; }
            const { value, done } = await reader.read();
            if (!this.running) break;
            if (value) buffer += decoder.decode(value, { stream: !done });
            if (done) break;
          }
          const lines = buffer.split("\n");
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data:") || trimmed === "data: [DONE]") continue;
            try {
              const chunk = JSON.parse(trimmed.slice(5).trim());
              if (chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content) {
                fullContent += chunk.choices[0].delta.content;
              }
              if (chunk.usage) usage = chunk.usage;
            } catch (e) {}
          }

          const latency = Date.now() - start;
          this.totalDone++;
          if (fullContent.length > 0) {
            this.handleSuccess(session, 1, start, ttfb, fullContent, usage);
          } else {
            this.fail++;
            if (!this.modelStats[session.model]) {
              this.modelStats[session.model] = { success: 0, fail: 1, latencies: [], ttfbList: [], cacheHits: 0, totalPromptTokens: 0, totalCompletionTokens: 0, turnLatencies: {} };
            } else { this.modelStats[session.model].fail++; }
          }
        } catch (e) {
          const latency = Date.now() - start;
          // 如果是主动中止，不记录失败
          if (!this.running || this.stopRequested) {
            this.totalDone++;
            break;
          }
          this.fail++;
          this.totalDone++;
          this.allLatencies.push(latency);
          if (!this.modelStats[session.model]) {
            this.modelStats[session.model] = { success: 0, fail: 1, latencies: [], ttfbList: [], cacheHits: 0, totalPromptTokens: 0, totalCompletionTokens: 0, turnLatencies: {} };
          } else { this.modelStats[session.model].fail++; }
        }
        continue;
      }

      // 连续对话模式（走 Anthropic 原生 Messages API，带 cache_control）
      // 每个 session 用唯一的 cache break marker，确保独立缓存
      var cacheBreak = "CB-" + Math.random().toString(36).slice(2, 8) + "-" + Date.now();
      // 不用 anthropic-beta header — AWS Bedrock 原生支持 cache_control，不需要 beta flag
      const cacheHeaders = {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
        "User-Agent": (session.identity && session.identity.ua) || "stress-test/1.0",
        "X-Client-Id": (session.identity && session.identity.clientId) || session.sessionId,
      };
      let msgs = [];
      let turnNum = 0;
      let sessionOk = true;

      for (const userMsg of (session.turns || [])) {
        if (!this.running) break;
        turnNum++;

        // 所有 user 消息都不带 cache_control — 只用 system 块做缓存
        // Bedrock 要求被缓存的块 ≥1024 tokens，短消息放 cache_control 无效且干扰匹配
        var userText = userMsg;

        msgs.push({
          role: "user",
          content: userText
        });

        const start = Date.now();
        this.totalSent++;

        try {
          // Anthropic 原生 Messages API — 非流式，确保 cache 数据不丢失
          // 每个 session 的 cachePad 带唯一后缀，确保独立缓存 epoch
          var cachePad = "CACHE_PADDING_" + cacheBreak + "X".repeat(4000);
          const body = JSON.stringify({
            model: session.model,
            system: [
              { type: "text", text: session.system, cache_control: { type: "ephemeral" } },
              { type: "text", text: cachePad, cache_control: { type: "ephemeral" } }
            ],
            messages: msgs,
            max_tokens: maxTok,
          });

          // 用原生 http/https 发请求，确保 Content-Length + 复杂 JSON 不被截断
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), timeout || 30000);
          session._currentController = ctrl;
          session._currentTimer = t;

          const parsed = url.parse(baseUrl + "/v1/messages");
          const httpModule = parsed.protocol === "https:" ? require("https") : require("http");
          const res = await new Promise(function(resolve, reject) {
            const req = httpModule.request({
              hostname: parsed.hostname,
              port: parsed.port,
              path: parsed.path,
              method: "POST",
              headers: Object.assign({
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
              }, cacheHeaders),
            }, function(r) { resolve(r); });
            req.on("error", function(e) { reject(e); });
            // 停止时立即 destroy socket
            session._currentReq = req;
            ctrl.signal.addEventListener("abort", function() {
              try { req.destroy(); } catch (e) {}
            });
            req.write(body);
            req.end();
          });
          clearTimeout(t);
          session._currentController = null;
          session._currentTimer = null;
          session._currentReq = null;

          const ttfb = Date.now() - start;

          if (res.statusCode >= 400) {
            if (!this.running) { sessionOk = false; break; }
            const chunks = [];
            res.on("data", function(c) { chunks.push(c); });
            await new Promise(function(resolve) { res.on("end", resolve); });
            if (!this.running) { sessionOk = false; break; }
            const errText = Buffer.concat(chunks).toString();
            let errData;
            try { errData = JSON.parse(errText); } catch (e) { errData = null; }
            const errMsg = (errData && errData.error && errData.error.message) || "HTTP " + res.statusCode;
            this.fail++;
            if (res.statusCode === 429) this.rateLimited++;   // 限流单独计数
            this.totalDone++;
            this.errors.push({
              model: session.model, sessionId: session.sessionId,
              turn: turnNum, error: errMsg, status: res.statusCode, time: Date.now(),
            });
            if (!this.modelStats[session.model]) {
              this.modelStats[session.model] = {
                success: 0, fail: 1, latencies: [], cacheHits: 0, ttfbList: [],
                totalPromptTokens: 0, totalCompletionTokens: 0, turnLatencies: {},
              };
            } else {
              this.modelStats[session.model].fail++;
            }
            sessionOk = false;
            break;
          }

          // 读取完整响应
          const resChunks = [];
          res.on("data", function(c) { resChunks.push(c); });
          await new Promise(function(resolve) { res.on("end", resolve); });
          const text = Buffer.concat(resChunks).toString();
          const latency = Date.now() - start;
          this.totalDone++;

          let data;
          try { data = JSON.parse(text); } catch (e) { data = null; }

          if (data && data.content) {
            const fullContent = data.content.map(function(b) { return b.text || ""; }).join("");
            const usage = data.usage || {};
            this.handleSuccess(session, turnNum, start, ttfb, fullContent, usage);
            msgs.push({ role: "assistant", content: data.content[0].text });
          } else {
            const errMsg = (data && data.error && data.error.message) || "空响应";
            this.fail++;
            this.errors.push({
                  model: session.model, sessionId: session.sessionId,
                  turn: turnNum, error: errMsg, status: 200, time: Date.now(),
                });
                if (!this.modelStats[session.model]) {
                  this.modelStats[session.model] = {
                    success: 0, fail: 1, latencies: [], cacheHits: 0, ttfbList: [],
                    totalPromptTokens: 0, totalCompletionTokens: 0, turnLatencies: {},
                  };
                } else {
                  this.modelStats[session.model].fail++;
                }
                sessionOk = false;
                break;
              }
        } catch (e) {
          const latency = Date.now() - start;
          const errMsg = e.name === "AbortError" ? "timeout" : e.message;
          this.fail++;
          this.allLatencies.push(latency);
          this.totalDone++;
          this.errors.push({
            model: session.model, sessionId: session.sessionId,
            turn: turnNum, error: errMsg, time: Date.now(),
          });

          if (!this.modelStats[session.model]) {
            this.modelStats[session.model] = {
              success: 0, fail: 1, latencies: [], cacheHits: 0,
              totalPromptTokens: 0, totalCompletionTokens: 0, turnLatencies: {},
            };
          } else {
            this.modelStats[session.model].fail++;
          }
          sessionOk = false;
          break;
        }
      }

      if (sessionOk) this.conversationsDone++;
      else this.conversationsFailed++;
    }
  }

  handleSuccess(session, turnNum, startTime, ttfb, content, usage) {
    const latency = Date.now() - startTime;
    const ttfbs = ttfb;

    const promptTokens = usage.input_tokens || usage.prompt_tokens || 0;
    const completionTokens = usage.output_tokens || usage.completion_tokens || 0;

    // 覆盖 Anthropic 原生 Messages API 和 OpenAI 兼容格式的所有 cache 字段
    var cacheRead = usage.cache_read_input_tokens || 0;
    var ephem5 = (usage.cache_creation && usage.cache_creation.ephemeral_5m_input_tokens) || 0;
    var ephem1h = (usage.cache_creation && usage.cache_creation.ephemeral_1h_input_tokens) || 0;
    var cacheCreate = usage.cache_creation_input_tokens || (ephem5 + ephem1h);
    var cachedTokens = (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0;

    var wasCacheHit = cacheRead > 0 || cachedTokens > 0 || (usage.prompt_cache_hit_tokens > 0);
    var wasCacheWrite = cacheCreate > 0;

    // 延迟阈值检测：如果 system prompt 够大（>1000 tokens）且延迟比第一轮低 >30%，也视为延迟型 cache hit
    var estimatedSystemTokens = usage.input_tokens ? (usage.input_tokens - 30) : 0;
    if (!wasCacheHit && turnNum > 1 && estimatedSystemTokens > 1000) {
      // 检查是否有之前轮的延迟记录用于对比
      if (this.modelStats[session.model] && this.modelStats[session.model].latencies && this.modelStats[session.model].latencies.length > 0) {
        var prevLatencies = this.modelStats[session.model].latencies;
        var firstLatency = prevLatencies[0] || 0;
        if (firstLatency > 0 && latency < firstLatency * 0.7) {
          wasCacheHit = true;
        }
      }
    }

    // 对于第1轮，cache_write 也算 cache 活动（写入缓存）
    if (turnNum === 1 && wasCacheWrite) {
      // 不算 hit，但要记录到 perTurnCache
    }

    this.success++;
    this.latencies.push(latency);
    this.allLatencies.push(latency);
    if (wasCacheHit) this.cacheHits++;

    const turnKey = "turn" + turnNum;
    if (!this.perTurnCache[turnKey]) this.perTurnCache[turnKey] = { total: 0, hits: 0 };
    this.perTurnCache[turnKey].total++;
    if (wasCacheHit) this.perTurnCache[turnKey].hits++;

    if (!this.modelStats[session.model]) {
      this.modelStats[session.model] = {
        success: 0, fail: 0, latencies: [], ttfbList: [], cacheHits: 0,
        totalPromptTokens: 0, totalCompletionTokens: 0, turnLatencies: {},
      };
    }
    const ms = this.modelStats[session.model];
    ms.success++;
    ms.latencies.push(latency);
    ms.ttfbList.push(ttfbs);
    if (wasCacheHit) ms.cacheHits++;
    ms.totalPromptTokens += promptTokens;
    ms.totalCompletionTokens += completionTokens;
    if (!ms.turnLatencies[turnKey]) ms.turnLatencies[turnKey] = [];
    ms.turnLatencies[turnKey].push(latency);
  }

  getSnapshot() {
    const effectiveEnd = this.running ? Date.now() : (this.endTime || Date.now());
    const elapsedMs = this.startTime ? Math.max(0, effectiveEnd - this.startTime) : 0;
    const elapsedSec = (elapsedMs / 1000).toFixed(1);
    const qps = elapsedMs > 0 ? (this.totalDone / (elapsedMs / 1000)).toFixed(2) : "0";

    const sorted = [...this.latencies].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.50)] || 0;
    const p90 = sorted[Math.floor(sorted.length * 0.90)] || 0;
    const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
    const p99 = sorted[Math.floor(sorted.length * 0.99)] || 0;
    const avg = this.latencies.length > 0
      ? Math.round(this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length * 100) / 100
      : 0;
    const min = sorted[0] || 0;
    const max = sorted[sorted.length - 1] || 0;

    // 实际发射速率（rpm）：已发出请求数 / 已耗分钟
    // RPM 实际达成速率：用「发射阶段时长」作分母，不被收尾时间稀释
    const launchMs = this.startTime ? ((this.launchEndTime || Date.now()) - this.startTime) : 0;
    const actualRpm = (this.config.mode === "rpm")
      ? (launchMs > 0 ? Math.round((this.arrivals / (launchMs / 1000)) * 60) : 0)
      : (elapsedMs > 0 ? Math.round((this.totalSent / (elapsedMs / 1000)) * 60) : 0);
    // 等效 rpm（并发模式）：Little's 法则 并发 ÷ 平均延迟(秒) × 60
    const avgSec = avg / 1000;
    const equivalentRpm = (this.config.mode !== "rpm" && avgSec > 0)
      ? Math.round((this.config.concurrency || 0) / avgSec * 60) : 0;

    return {
      status: this.running ? "running" : ((this.startTime && !this.endTime) ? "stopping" : (this.lastReport ? "done" : "idle")),
      runId: this.runId,
      startedAt: this.startTime ? new Date(this.startTime).toISOString() : null,
      endedAt: this.endTime ? new Date(this.endTime).toISOString() : null,
      reportPath: this.reportPath,
      config: sanitizeConfig(this.config),
      elapsed: elapsedSec + "s",
      elapsedMs,
      totalSent: this.totalSent,
      totalDone: this.totalDone,
      success: this.success,
      fail: this.fail,
      rateLimited: this.rateLimited,
      cacheHits: this.cacheHits,
      qps,
      actualRpm,
      arrivals: this.arrivals,
      equivalentRpm,
      targetRpm: this.config.targetRpm || 0,
      inflight: this.inflight,
      peakInflight: this.peakInflight,
      conversationsDone: this.conversationsDone,
      conversationsFailed: this.conversationsFailed,
      errorCount: this.errors.length,
      latency: { avg, min, max, p50, p90, p95, p99 },
    };
  }

  generateReport() {
    const elapsedMs = this.endTime && this.startTime ? (this.endTime - this.startTime) : 0;
    const elapsedSec = (elapsedMs / 1000).toFixed(2);
    const qps = elapsedMs > 0 ? (this.totalDone / (elapsedMs / 1000)).toFixed(2) : "0";

    const sorted = [...this.latencies].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.50)] || 0;
    const p90 = sorted[Math.floor(sorted.length * 0.90)] || 0;
    const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
    const p99 = sorted[Math.floor(sorted.length * 0.99)] || 0;
    const avg = this.latencies.length > 0
      ? Math.round(this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length * 100) / 100
      : 0;
    const min = sorted[0] || 0;
    const max = sorted[sorted.length - 1] || 0;

    // 逐轮 cache
    const perTurnCache = [];
    for (const [turn, data] of Object.entries(this.perTurnCache)) {
      const turnNum = turn.replace("turn", "");
      perTurnCache.push({
        turn: turnNum,
        total: data.total,
        hits: data.hits,
        rate: data.total > 0 ? ((data.hits / data.total) * 100).toFixed(1) : "0",
      });
    }
    perTurnCache.sort((a, b) => parseInt(a.turn) - parseInt(b.turn));

    let totalCacheOps = 0, totalCacheHits = 0;
    for (const [turn, data] of Object.entries(this.perTurnCache)) {
      if (turn !== "turn1") {
        totalCacheOps += data.total;
        totalCacheHits += data.hits;
      }
    }
    const overallCacheRate = totalCacheOps > 0 ? ((totalCacheHits / totalCacheOps) * 100).toFixed(1) : "N/A";

    const modelReports = [];
    for (const [model, s] of Object.entries(this.modelStats)) {
      const sl = [...s.latencies].sort((a, b) => a - b);
      const modelTotal = s.success + s.fail;
      modelReports.push({
        model,
        success: s.success,
        fail: s.fail,
        rate: ((s.success / modelTotal) * 100).toFixed(1),
        avgLatency: s.success > 0 ? Math.round(s.latencies.reduce((a, b) => a + b, 0) / s.latencies.length * 100) / 100 : 0,
        avgTtfb: s.ttfbList && s.ttfbList.length > 0 ? Math.round(s.ttfbList.reduce((a, b) => a + b, 0) / s.ttfbList.length * 100) / 100 : 0,
        p50: sl[Math.floor(sl.length * 0.5)] || 0,
        p90: sl[Math.floor(sl.length * 0.9)] || 0,
        p95: sl[Math.floor(sl.length * 0.95)] || 0,
        p99: sl[Math.floor(sl.length * 0.99)] || 0,
        min: sl[0] || 0,
        max: sl[sl.length - 1] || 0,
        cacheHits: s.cacheHits,
        avgPromptTokens: s.success > 0 ? Math.round(s.totalPromptTokens / s.success) : 0,
        avgCompletionTokens: s.success > 0 ? Math.round(s.totalCompletionTokens / s.success) : 0,
      });
    }
    modelReports.sort((a, b) => a.avgLatency - b.avgLatency);

    const errorTypes = {};
    for (const e of this.errors) {
      const key = e.error ? e.error.slice(0, 60) : "unknown";
      errorTypes[key] = (errorTypes[key] || 0) + 1;
    }

    const successRate = this.totalDone > 0 ? ((this.success / this.totalDone) * 100).toFixed(1) : "0";

    const avgSec = avg / 1000;
    // RPM 实际达成速率：用「发射阶段时长」作分母，不被收尾时间稀释
    const launchMs = this.startTime ? ((this.launchEndTime || Date.now()) - this.startTime) : 0;
    const actualRpm = (this.config.mode === "rpm")
      ? (launchMs > 0 ? Math.round((this.arrivals / (launchMs / 1000)) * 60) : 0)
      : (elapsedMs > 0 ? Math.round((this.totalSent / (elapsedMs / 1000)) * 60) : 0);
    const equivalentRpm = (this.config.mode !== "rpm" && avgSec > 0)
      ? Math.round((this.config.concurrency || 0) / avgSec * 60) : 0;
    const modeLabel = this.config.mode === "rpm" ? "RPM 开环压测"
      : this.config.mode === "conversation" ? "连续对话压测"
      : this.config.mode === "image" ? "图片生成压测"
      : "独立请求压测";

    return {
      runId: this.runId,
      startedAt: this.startTime ? new Date(this.startTime).toISOString() : null,
      endedAt: this.endTime ? new Date(this.endTime).toISOString() : null,
      testMode: modeLabel,
      config: sanitizeConfig(this.config),
      summary: {
        duration: elapsedSec + "s",
        concurrency: this.config.concurrency,
        targetRpm: this.config.targetRpm || 0,
        actualRpm: actualRpm,
        equivalentRpm: equivalentRpm,
        peakInflight: this.peakInflight,
        totalSent: this.totalSent,
        totalDone: this.totalDone,
        success: this.success,
        fail: this.fail,
        rateLimited: this.rateLimited,
        successRate: successRate + "%",
        qps,
        cacheHitRate: overallCacheRate,
        conversationsDone: this.conversationsDone,
        conversationsFailed: this.conversationsFailed,
      },
      latency: { avg, min, max, p50, p90, p95, p99 },
      perTurnCache,
      models: modelReports,
      errorSummary: Object.entries(errorTypes).sort((a, b) => b[1] - a[1]).slice(0, 10).map(function(e) { return { type: e[0], count: e[1] }; }),
      errors: this.errors.slice(0, 100),
    };
  }
}

// ============================================================
// HTTP 服务器
// ============================================================
const engine = new StressTestEngine();

const requestHandler = function(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204); res.end(); return;
  }

  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // 主页
  if (pathname === "/" || pathname === "/index.html") {
    fs.readFile(HTML_FILE, "utf8", function(err, html) {
      if (err) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("index.html not found");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    });
    return;
  }

  // 扫描模型
  if (pathname === "/api/models" && req.method === "POST") {
    let body = "";
    req.on("data", function(chunk) { body += chunk; });
    req.on("end", async function() {
      try {
        const config = JSON.parse(body);
        if (!config.baseUrl || !config.apiKey) throw new Error("缺少 URL 或 Key");

        const baseUrl = config.baseUrl.trim().replace(/\/+$/, "");

        const headers = {
          "Authorization": "Bearer " + config.apiKey,
          "Content-Type": "application/json",
        };

        // 拉模型列表 — 尝试多个路径
        let models = [];
        const paths = [baseUrl + "/v1/models", baseUrl + "/models"];
        let lastError = "";

        for (const fullUrl of paths) {
          try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 15000);
            const resp = await fetch(fullUrl, { headers, signal: ctrl.signal });
            clearTimeout(t);

            if (!resp.ok) {
              lastError = "HTTP " + resp.status;
              continue;
            }

            const data = await resp.json();
            const raw = data.data || data.models || [];
            if (raw.length > 0) {
              models = raw.map(function(m) {
                return m.id || m.name || m.model || "";
              }).filter(Boolean);
              console.log("[模型扫描] " + fullUrl + " → " + models.length + " 个");
              break;
            }
            lastError = "返回空列表";
          } catch (e) {
            lastError = e.name === "AbortError" ? "请求超时" : e.message.slice(0, 60);
            console.log("[模型扫描] " + fullUrl + " → " + lastError);
          }
        }

        if (models.length === 0) {
          console.log("[模型扫描] " + baseUrl + " 全部路径失败: " + lastError);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "无法获取模型列表 — " + lastError + "。请检查 URL 和 Key 是否正确。" }));
          return;
        }

        // 分类：chat vs 非chat
        const CHAT = /^gpt|^o[134]|^claude|^deepseek|^gemini|^llama|^qwen|^mistral|^mixtral|^yi-|^moonshot|^abab|^ernie|^spark|^hunyuan|^glm|^doubao|^minimax/;
        const NON = /^dall-e|^tts-|^whisper|^gpt-image|^text-embedding|^text-moderation|^babbage|^davinci/;

        const result = models.map(function(m) {
          return { id: m, isChat: CHAT.test(m) && !NON.test(m) };
        });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ models: result }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // 启动
  if (pathname === "/api/start" && req.method === "POST") {
    let body = "";
    req.on("data", function(chunk) { body += chunk; });
    req.on("end", function() {
      try {
        if (engine.running) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "已有压测任务在运行，请先停止或等待完成" }));
          return;
        }

        const config = normalizeConfig(JSON.parse(body));
        if (!config.baseUrl || !config.apiKey) throw new Error("缺少 URL 或 Key");
        if (!config.models || config.models.length === 0) throw new Error("需要至少一个模型");

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, config: sanitizeConfig(config) }));

        engine.run(config).catch(function(e) {
          console.error("[压测异常]", e.message);
        });
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // 停止
  if (pathname === "/api/stop" && req.method === "POST") {
    engine.running = false;
    engine.stopRequested = true;
    // 批量/RPM 模式：abort 所有 in-flight 请求
    if (engine._rpmControllers) {
      for (const ctrl of engine._rpmControllers) {
        try { ctrl.abort(); } catch (e) {}
      }
    }
    // 连续对话模式：abort 每个 session 的请求
    if (engine._activeSessions) {
      for (const session of engine._activeSessions) {
        if (session._currentController) {
          try { session._currentController.abort(); } catch (e) {}
        }
        if (session._currentTimer) {
          clearTimeout(session._currentTimer);
          session._currentTimer = null;
        }
        session._currentController = null;
        if (session._currentReq) {
          try { session._currentReq.destroy(); } catch (e) {}
          session._currentReq = null;
        }
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, aborted: true }));
    return;
  }

  // 实时快照
  if (pathname === "/api/snapshot") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(engine.getSnapshot()));
    return;
  }

  // 最终报告
  if (pathname === "/api/report") {
    const report = engine.lastReport || engine.generateReport();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(report));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
};

const server = http.createServer(requestHandler);
const HOST = process.env.HOST || "0.0.0.0";   // 绑定所有网卡，允许局域网访问
server.listen(PORT, HOST, function() {
  console.log("🦞 压测面板:");
  console.log("   本机:   http://localhost:" + PORT);
  // 列出局域网可访问地址
  const nets = require("os").networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name]) {
      if (ni.family === "IPv4" && !ni.internal) {
        console.log("   局域网: http://" + ni.address + ":" + PORT + "  (" + name + ")");
      }
    }
  }
});
