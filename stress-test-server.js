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
const REPORT_RETENTION_MS = Number(process.env.REPORT_RETENTION_MS) || 3 * 60 * 60 * 1000;
const REPORT_CLEAN_INTERVAL_MS = Number(process.env.REPORT_CLEAN_INTERVAL_MS) || 30 * 60 * 1000;
const REPORT_MAX_FILES = Math.max(1, Number(process.env.REPORT_MAX_FILES) || 200);
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_PROMPT_CACHING_BETA = "prompt-caching-2024-07-31";
const IMAGE_RPM_SAFE_MAX = Math.max(1, Number(process.env.IMAGE_RPM_SAFE_MAX) || 1000);
const IMAGE_RPM_DEFAULT_MAX_INFLIGHT = Math.max(1, Number(process.env.IMAGE_RPM_DEFAULT_MAX_INFLIGHT) || 2000);
const IMAGE_MIXED_SIZE_SET = ["1024x1024", "1536x1024", "1024x1536", "1920x1088", "2048x1152", "2560x1440", "3840x2160"];
const IMAGE_MIXED_QUALITY_SET = ["low", "medium", "high"];
const IMAGE_MIXED_WORKLOAD_SET = ["text-to-image", "image-to-image-intent"];
const WORKER_MODE = String(process.env.WORKER_MODE || "").trim() === "1";
const WORKER_SHARED_TOKEN = String(process.env.WORKER_SHARED_TOKEN || "stress-worker-local");
const WORKER_URLS = String(process.env.WORKER_URLS || "")
  .split(",")
  .map(function(s) { return s.trim().replace(/\/+$/, ""); })
  .filter(Boolean);
const WORKER_TARGET_THRESHOLD_RPM = Math.max(1, Number(process.env.WORKER_TARGET_THRESHOLD_RPM) || 300);
// 文字 RPM 走 worker 分摊的阈值（与图片 300 分开）。低于此值文字仍单机跑，语义/缓存口径不变。
const WORKER_TEXT_TARGET_THRESHOLD_RPM = Math.max(1, Number(process.env.WORKER_TEXT_TARGET_THRESHOLD_RPM) || 500);
const WORKER_DEFAULT_MAX_INFLIGHT = Math.max(1, Number(process.env.WORKER_DEFAULT_MAX_INFLIGHT) || 800);
const RPM_CACHE_DEFAULT_NEW_USER_RATIO = 0;          // 默认不再持续造新用户：让老用户反复回访读缓存，命中率才反映真实缓存能力
const RPM_CACHE_DEFAULT_SESSION_LENGTH_PRESET = "sticky";   // 默认多轮会话：写1次缓存、读多次
const RPM_CACHE_DEFAULT_RETURN_INTERVAL_PRESET = "bursty";  // 默认快速回访：5分钟 TTL 内回来，读得到刚写的缓存
const RPM_CACHE_DEFAULT_MAX_ROUNDS = 6;

// 进程级持久记忆：「这个 渠道+模型+key 不认 anthropic-beta 头」。
// 必须跨测试、跨子引擎(多模型顺序)持久——否则每开一次新测试都会重新带 beta 头、重新吃 400
// (这正是「昨天修了今天跟没修一样」的根因：旧版存在引擎实例上、每次 run() 被 reset 清零)。
// key 带 apiKey 哈希：同一 baseUrl+model 在 Key1(原生 Anthropic 认 beta)/Key2(Bedrock 不认) 下互不污染。
const GLOBAL_BETA_HEADER_BYPASS = new Set();
const RPM_CACHE_SESSION_LENGTH_PRESETS = {
  realistic: [
    { turns: 1, weight: 40 },
    { turns: 2, weight: 30 },
    { turns: 3, weight: 15 },
    { turns: 4, weight: 10 },
    { turns: 5, weight: 3 },
    { turns: 6, weight: 2 },
  ],
  short: [
    { turns: 1, weight: 55 },
    { turns: 2, weight: 25 },
    { turns: 3, weight: 10 },
    { turns: 4, weight: 6 },
    { turns: 5, weight: 3 },
    { turns: 6, weight: 1 },
  ],
  sticky: [
    { turns: 1, weight: 20 },
    { turns: 2, weight: 25 },
    { turns: 3, weight: 20 },
    { turns: 4, weight: 15 },
    { turns: 5, weight: 10 },
    { turns: 6, weight: 10 },
  ],
};
const RPM_CACHE_RETURN_INTERVAL_PRESETS = {
  realistic: [
    { minMs: 0, maxMs: 3000, weight: 30 },
    { minMs: 3000, maxMs: 15000, weight: 40 },
    { minMs: 15000, maxMs: 60000, weight: 20 },
    { minMs: 60000, maxMs: 300000, weight: 10 },
  ],
  bursty: [
    { minMs: 0, maxMs: 1000, weight: 35 },
    { minMs: 1000, maxMs: 5000, weight: 40 },
    { minMs: 5000, maxMs: 15000, weight: 20 },
    { minMs: 15000, maxMs: 60000, weight: 5 },
  ],
  slow: [
    { minMs: 3000, maxMs: 15000, weight: 25 },
    { minMs: 15000, maxMs: 60000, weight: 35 },
    { minMs: 60000, maxMs: 180000, weight: 25 },
    { minMs: 180000, maxMs: 600000, weight: 15 },
  ],
};

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
    maxInflight: Number(config.maxInflight) || 0,
    rpmCache: !!config.rpmCache,
    rpmCacheTrafficMode: config.rpmCacheTrafficMode === "realistic" ? "realistic" : "legacy",  // 默认 legacy:用户连续做完多轮,毫秒级交错,第2轮起命中(文档1713-1714原始正确设计)
    rpmMultiModelMode: config.rpmMultiModelMode === "mixed" ? "mixed" : "sequential",
    mode: config.mode || "",
    roundsPerSession: Number(config.roundsPerSession) || 0,
    rpmCacheNewUserRatio: Number(config.rpmCacheNewUserRatio) != null && !isNaN(config.rpmCacheNewUserRatio) ? Number(config.rpmCacheNewUserRatio) : RPM_CACHE_DEFAULT_NEW_USER_RATIO,
    rpmCacheSessionLengthPreset: normalizeRpmCacheSessionPreset(config.rpmCacheSessionLengthPreset),
    rpmCacheReturnIntervalPreset: normalizeRpmCacheReturnPreset(config.rpmCacheReturnIntervalPreset),
    rpmCacheMaxRounds: Number(config.rpmCacheMaxRounds) || RPM_CACHE_DEFAULT_MAX_ROUNDS,
    timeout: Number(config.timeout) || 0,
    contextScale: config.contextScale || DEFAULT_CONTEXT_SCALE,
    randomParams: !!config.randomParams,
    authenticityAddon: false,
    models: Array.isArray(config.models) ? config.models : [],
    imageSize: config.imageSize || "1024x1024",
    imageSizeMode: config.imageSizeMode || "mixed",
    imageQualityMode: config.imageQualityMode || "mixed",
    imageWorkloadMode: config.imageWorkloadMode || "mixed",
    imageMode: config.imageMode || "burst",
  };
}

function normalizeConfig(config) {
  const mode = String(config.mode || "burst").trim();
  const imageMode = config.imageMode === "rpm" ? "rpm" : "burst";
  const isImageRpm = mode === "image" && imageMode === "rpm";
  const targetRpm = Math.max(0, Number(config.targetRpm) || 0);
  if (isImageRpm && targetRpm > IMAGE_RPM_SAFE_MAX) {
    throw new Error("当前服务器图片 RPM 安全上限为 " + IMAGE_RPM_SAFE_MAX + "，请降低目标 RPM 或启用多 Worker 分摊");
  }
  let maxInflight = Math.max(0, Number(config.maxInflight) || 0);
  if (isImageRpm && maxInflight < 1) maxInflight = IMAGE_RPM_DEFAULT_MAX_INFLIGHT;
  return {
    baseUrl: String(config.baseUrl || "").trim().replace(/\/+$/, ""),
    apiKey: String(config.apiKey || "").trim(),
    concurrency: Math.max(1, Number(config.concurrency) || 1),
    durationSeconds: Math.max(1, Number(config.durationSeconds) || 20),
    targetRpm: targetRpm,
    maxInflight: maxInflight,   // RPM 背压：在途上限，0=不限；图片 RPM 默认开启保护
    rpmCache: !!config.rpmCache,
    rpmCacheTrafficMode: config.rpmCacheTrafficMode === "realistic" ? "realistic" : "legacy",  // 默认 legacy:用户连续做完多轮,毫秒级交错,第2轮起命中(文档1713-1714原始正确设计)
    rpmMultiModelMode: config.rpmMultiModelMode === "mixed" ? "mixed" : "sequential",
    roundsPerSession: Math.max(1, Number(config.roundsPerSession) || 6),
    rpmCacheNewUserRatio: Math.max(0, Math.min(100, config.rpmCacheNewUserRatio != null ? Number(config.rpmCacheNewUserRatio) : RPM_CACHE_DEFAULT_NEW_USER_RATIO)),
    rpmCacheSessionLengthPreset: normalizeRpmCacheSessionPreset(config.rpmCacheSessionLengthPreset),
    rpmCacheReturnIntervalPreset: normalizeRpmCacheReturnPreset(config.rpmCacheReturnIntervalPreset),
    rpmCacheMaxRounds: Math.max(1, Math.min(10, Number(config.rpmCacheMaxRounds) || Number(config.roundsPerSession) || RPM_CACHE_DEFAULT_MAX_ROUNDS)),
    timeout: Math.max(0, Number(config.timeout) || 0),
    mode: mode,
    maxTokens: Math.max(5, Number(config.maxTokens) || (config.mode === 'conversation' ? 20 : 5)),
    contextScale: CONTEXT_SCALES[config.contextScale] ? config.contextScale : DEFAULT_CONTEXT_SCALE,
    randomParams: !!config.randomParams,
    authenticityAddon: false,
    imageSize: config.imageSize || "1024x1024",
    imageSizeMode: (config.imageSizeMode === "fixed") ? "fixed" : "mixed",
    imageQualityMode: (config.imageQualityMode === "fixed") ? "fixed" : "mixed",
    imageWorkloadMode: (config.imageWorkloadMode === "text-to-image" || config.imageWorkloadMode === "image-to-image-intent") ? config.imageWorkloadMode : "mixed",
    imageMode: imageMode,
    // 多 Worker 分摊：保留 shard/count，否则 worker 经 normalizeConfig 后丢失 → 各 worker 都 shard=0 互相撞车（图片矩阵/文字缓存用户都受影响）
    workerShard: Math.max(0, Number(config.workerShard) || 0),
    workerCount: Math.max(1, Number(config.workerCount) || 1),
    models: [...new Set((Array.isArray(config.models) ? config.models : []).map(function(model) {
      return String(model || "").trim();
    }).filter(Boolean))],
  };
}

function saveReportToDisk(report) {
  ensureDir(REPORT_DIR);
  const filename = buildReportFilename(report);
  const filePath = path.join(REPORT_DIR, filename);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2), "utf8");
  return filePath;
}

function buildReportFilename(report) {
  if (report && report.worker && report.worker.runId && report.worker.id) {
    return String(report.worker.runId) + "--" + String(report.worker.id) + ".json";
  }
  return String((report && report.runId) || ("stress-" + timestampForFile(new Date()))) + ".json";
}

function loadReportFromDisk(filename) {
  if (!filename) return null;
  const filePath = path.join(REPORT_DIR, filename);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    return null;
  }
}

function loadWorkerShardReport(runId, workerId) {
  if (!runId || !workerId) return null;
  return loadReportFromDisk(String(runId) + "--" + String(workerId) + ".json");
}

function classifyError(err, status) {
  const msg = String(err || "").toLowerCase();
  const code = Number(status) || 0;

  if (msg === "timeout" || msg.includes("timed out") || msg.includes("timeout")) return "超时";
  if (msg.includes("手动停止")) return "手动停止";
  if (msg.includes("本地超时取消")) return "本地超时取消";
  if (msg.includes("收尾强制取消")) return "收尾强制取消";
  if (msg.includes("服务侧中止")) return "服务侧中止";
  if (msg.includes("socket hang up") || msg.includes("connection reset by peer") || msg.includes("econnreset")) return "对端断开";
  if (msg === "aborted" || msg.includes("aborted")) return "本地中止";
  if (code === 429 || msg.includes("rate limit") || msg.includes("too many requests")) return "限流(429)";
  if (code >= 500) return "上游服务错误(" + code + ")";
  if (code >= 400) return "请求错误(" + code + ")";
  if (msg === "空响应") return "空响应";
  return (String(err || "unknown")).slice(0, 60);
}

function previewText(value, maxLen) {
  const text = String(value || "");
  const limit = Number(maxLen) || 4000;
  return text.length > limit ? text.slice(0, limit) + "...[truncated]" : text;
}

function summarizeNodeHeaders(res) {
  const headers = (res && res.headers) || {};
  const pick = function(name) {
    const v = headers[String(name).toLowerCase()];
    if (Array.isArray(v)) return v[0] ? String(v[0]) : "";
    return v ? String(v) : "";
  };
  return {
    requestId: pick("x-request-id") || pick("request-id") || pick("x-amzn-requestid") || pick("x-ms-request-id") || pick("openai-request-id"),
    upstreamStatus: pick("x-upstream-status") || pick("upstream-status") || pick("x-origin-status"),
    contentType: pick("content-type"),
  };
}

function makeErrorSampleKey(status, rawText) {
  return String(Number(status) || "") + "|" + String(rawText || "").trim();
}

function mergeErrorSamples(target, seen, samples) {
  (samples || []).forEach(function(sample) {
    if (!sample) return;
    const key = makeErrorSampleKey(sample.status, sample.rawBody || sample.error);
    const existing = seen[key];
    if (existing) {
      existing.count += Number(sample.count) || 1;
      return;
    }
    if (target.length >= 50) return;
    const item = Object.assign({}, sample, {
      count: Number(sample.count) || 1,
      rawBody: previewText(sample.rawBody || sample.error || "", 4000),
    });
    target.push(item);
    seen[key] = item;
  });
}

function makeAnthropicCacheHeaders(apiKey, extraHeaders) {
  return Object.assign({
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    "anthropic-beta": ANTHROPIC_PROMPT_CACHING_BETA,
    "Content-Type": "application/json",
  }, extraHeaders || {});
}

function makeAnthropicHeaders(apiKey, extraHeaders) {
  return Object.assign({
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    "Content-Type": "application/json",
  }, extraHeaders || {});
}

function readResponseText(res) {
  return new Promise(function(resolve) {
    const chunks = [];
    res.on("data", function(c) { chunks.push(c); });
    res.on("end", function() { resolve(Buffer.concat(chunks).toString()); });
  });
}

function isInvalidBetaFlagError(errText) {
  return /invalid beta flag/i.test(String(errText || ""));
}

function isBetaHeaderCompatibilityError(errText) {
  const text = String(errText || "");
  return /invalid beta flag/i.test(text) ||
    /unexpected value\(s\).+anthropic-beta/i.test(text) ||
    /try again without the header/i.test(text);
}

function abortWithReason(ctrl, reason) {
  if (!ctrl) return;
  ctrl.__abortReason = String(reason || "本地中止");
  try { ctrl.abort(ctrl.__abortReason); } catch (e) {}
}

function describeAbortError(e, ctrl, running, stopRequested) {
  if (e && e.name === "AbortError") {
    if (ctrl && ctrl.__abortReason) return ctrl.__abortReason;
    if (stopRequested) return "手动停止";
    if (!running) return "服务侧中止";
    return "本地中止";
  }
  return (e && e.message) ? e.message : String(e || "unknown");
}

function pickHeader(headers, names) {
  if (!headers || !names || !names.length) return "";
  for (const name of names) {
    const v = headers.get(name);
    if (v) return String(v);
  }
  return "";
}

function parsePositiveMs(value) {
  if (value == null || value === "") return 0;
  const n = Number(String(value).trim());
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function buildDeliveryMetaFromFetch(res, ttfb, latency) {
  const headers = res && res.headers;
  return {
    requestId: pickHeader(headers, ["x-request-id", "request-id", "x-amzn-requestid", "x-ms-request-id", "openai-request-id"]),
    upstreamStatus: pickHeader(headers, ["x-upstream-status", "upstream-status", "x-origin-status"]),
    retryHint: pickHeader(headers, ["x-retry-count", "x-retries", "x-should-retry", "x-openai-retries"]),
    processingMs: parsePositiveMs(pickHeader(headers, ["openai-processing-ms", "x-processing-ms", "processing-ms"])),
    ttfb: Number(ttfb) || 0,
    latency: Number(latency) || 0,
  };
}

function buildDeliveryMetaFromNodeRes(res, ttfb, latency) {
  const headers = (res && res.headers) || {};
  const get = function(name) {
    const v = headers[String(name).toLowerCase()];
    if (Array.isArray(v)) return v[0] ? String(v[0]) : "";
    return v ? String(v) : "";
  };
  return {
    requestId: get("x-request-id") || get("request-id") || get("x-amzn-requestid") || get("x-ms-request-id") || get("openai-request-id"),
    upstreamStatus: get("x-upstream-status") || get("upstream-status") || get("x-origin-status"),
    retryHint: get("x-retry-count") || get("x-retries") || get("x-should-retry") || get("x-openai-retries"),
    processingMs: parsePositiveMs(get("openai-processing-ms") || get("x-processing-ms") || get("processing-ms")),
    ttfb: Number(ttfb) || 0,
    latency: Number(latency) || 0,
  };
}

function summarizeDeliveryDiagnosis(samples) {
  const list = Array.isArray(samples) ? samples.filter(Boolean) : [];
  const processingSamples = list.filter(function(s) { return Number(s.processingMs) > 0; });
  const retryHintSamples = list.filter(function(s) { return String(s.retryHint || "").length > 0; });
  const upstreamStatusSamples = list.filter(function(s) {
    const txt = String(s.upstreamStatus || "");
    return /4\d\d|5\d\d|429|404|503/.test(txt);
  });
  const slowGapSamples = list.filter(function(s) {
    const latency = Number(s.latency) || 0;
    const processing = Number(s.processingMs) || 0;
    return latency > 0 && processing > 0 && latency >= processing + 8000;
  });
  const strongSignals = [];
  if (retryHintSamples.length) strongSignals.push("响应头带重试标记");
  if (upstreamStatusSamples.length) strongSignals.push("响应头暴露过上游异常状态");
  if (slowGapSamples.length) strongSignals.push("总耗时显著大于上游处理耗时");

  const severity = strongSignals.length >= 2 ? "warn"
    : strongSignals.length === 1 ? "info"
    : "none";
  const likely = strongSignals.length > 0;
  const note = likely
    ? "用户端拿到的是最终成功结果，但链路上可能经历过网关重试、上游切换或排队。"
    : "未观察到足够强的交付链路信号；不代表上游一定没有重试，只是本次响应头证据不足。";

  return {
    likelyRetried: likely,
    severity: severity,
    signals: strongSignals,
    note: note,
    sampleCount: list.length,
    samplesWithProcessingMs: processingSamples.length,
    samplesWithRetryHint: retryHintSamples.length,
    samplesWithUpstreamStatus: upstreamStatusSamples.length,
    samplesWithSlowGap: slowGapSamples.length,
    sampleRequestIds: list.map(function(s) { return s.requestId; }).filter(Boolean).slice(0, 5),
  };
}

async function postAnthropicMessages(baseUrl, body, headers, ctrl, onRequest, agent) {
  const parsed = url.parse(anthropicMessagesEndpoint(baseUrl));
  const httpModule = parsed.protocol === "https:" ? require("https") : require("http");

  async function sendOnce(reqHeaders) {
    return await new Promise(function(resolve, reject) {
      const opts = {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.path,
        method: "POST",
        headers: Object.assign({
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        }, reqHeaders),
      };
      if (agent) opts.agent = agent;   // 每会话固定 keep-alive 连接 → 同会话多轮走同一后端 → 写入后续轮可读到缓存
      const req = httpModule.request(opts, function(r) { resolve(r); });
      if (typeof onRequest === "function") onRequest(req);
      req.on("error", function(e) { reject(e); });
      ctrl.signal.addEventListener("abort", function() {
        try { req.destroy(); } catch (e) {}
      }, { once: true });
      req.write(body);
      req.end();
    });
  }

  const initialHeaders = Object.assign({}, headers);
  const res = await sendOnce(initialHeaders);
  let preloadedErrorText = null;
  // 上游不认 beta 头时：本条请求照常按失败记录、绝不重试；只标记「后续请求去掉该头」，
  // 这样起步那批带头的请求会真实地记成失败，之后不带头的请求才正常 —— 符合真实压测口径。
  let betaIncompatible = false;

  if (res.statusCode === 400 && initialHeaders["anthropic-beta"]) {
    const errText = await readResponseText(res);
    preloadedErrorText = errText;   // body 交给调用方,按 4xx 失败如实记录
    if (isBetaHeaderCompatibilityError(errText)) {
      betaIncompatible = true;      // 记住:后面的请求不再带 beta 头(不是重试这一条)
    }
  }

  return { res: res, preloadedErrorText: preloadedErrorText, betaIncompatible: betaIncompatible };
}

// 每个用户/会话一个 keep-alive 连接（maxSockets:1 → 同会话所有轮次复用同一条 socket → 同一后端 → 写入后能读到缓存）。
// keepAliveMsecs 5 分钟，覆盖 RPM 穿插模式里同用户两轮之间的间隔，避免连接被回收后又被分到别的后端。
function makeSessionAgent(baseUrl) {
  try {
    const parsed = url.parse(anthropicMessagesEndpoint(baseUrl));
    const mod = parsed.protocol === "https:" ? require("https") : require("http");
    return new mod.Agent({ keepAlive: true, maxSockets: 1, keepAliveMsecs: 300000 });
  } catch (e) { return null; }
}

function endpointBase(baseUrl) {
  return String(baseUrl || "").trim().replace(/\/+$/, "");
}

function anthropicMessagesEndpoint(baseUrl) {
  const base = endpointBase(baseUrl);
  return /\/v1$/i.test(base) ? base + "/messages" : base + "/v1/messages";
}

function openAIChatEndpoint(baseUrl) {
  const base = endpointBase(baseUrl);
  return /\/v1$/i.test(base) ? base + "/chat/completions" : base + "/v1/chat/completions";
}

function openAIResponsesEndpoints(baseUrl) {
  const base = endpointBase(baseUrl);
  if (/\/v1$/i.test(base)) return [base + "/responses"];
  // 有些中转面板记录为 /responses，有些是标准 /v1/responses；两条都兼容。
  return [base + "/v1/responses", base + "/responses"];
}

function shouldFallbackClaudeAuditToOpenAI(status, errText) {
  const code = Number(status) || 0;
  const text = String(errText || "").toLowerCase();
  if ([400, 404, 405, 415, 422, 501].includes(code)) return true;
  if (code === 403 && (text.includes("model") || text.includes("endpoint") || text.includes("unsupported") || text.includes("messages"))) return true;
  return text.includes("/v1/messages") ||
    text.includes("messages api") ||
    text.includes("anthropic") ||
    text.includes("unsupported") ||
    text.includes("not support") ||
    text.includes("not supported") ||
    text.includes("endpoint") ||
    text.includes("invalid request") ||
    text.includes("bad request");
}

function shouldFallbackOpenAIResponses(status, errText) {
  const text = String(errText || "").toLowerCase();
  // 很多中转只开放裸 /responses，不开放标准 /v1/responses；
  // 这时 /v1/responses 可能返回 403，但同一个 key 打 /responses 是通的。
  if (Number(status) === 403) return true;
  if ([404, 405, 501].includes(Number(status))) return true;
  if (Number(status) === 400) {
    return text.includes("responses") ||
      text.includes("endpoint") ||
      text.includes("route") ||
      text.includes("path") ||
      text.includes("unsupported") ||
      text.includes("not support") ||
      text.includes("unknown url") ||
      text.includes("max_output_tokens") ||
      text.includes("input_text") ||
      text.includes("instructions");
  }
  return false;
}

async function postOpenAIResponsesWithFallback(baseUrl, body, headers, ctrl) {
  const endpoints = openAIResponsesEndpoints(baseUrl);
  let last = null;
  for (const endpoint of endpoints) {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: headers,
      body: body,
      signal: ctrl.signal,
    });
    if (res.ok) return { res: res, endpoint: endpoint, errorText: null, canFallbackToChat: false };

    const errText = await res.text().catch(function() { return ""; });
    last = { status: res.status, statusText: res.statusText, endpoint: endpoint, errorText: errText };
    if (!shouldFallbackOpenAIResponses(res.status, errText)) {
      return Object.assign({ res: null, canFallbackToChat: false }, last);
    }
  }
  return Object.assign({ res: null, canFallbackToChat: true }, last || {});
}

async function readFetchBodyText(res, shouldContinue) {
  if (!res || !res.body || typeof res.body.getReader !== "function") {
    return res ? await res.text().catch(function() { return ""; }) : "";
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    if (typeof shouldContinue === "function" && !shouldContinue()) {
      try { await reader.cancel(); } catch (e) {}
      break;
    }
    const r = await reader.read();
    if (r.value) buffer += decoder.decode(r.value, { stream: !r.done });
    if (r.done) break;
  }
  return buffer;
}

function extractResponsesText(response) {
  if (!response) return "";
  if (typeof response.output_text === "string") return response.output_text;
  const output = Array.isArray(response.output) ? response.output : [];
  const parts = [];
  output.forEach(function(item) {
    const content = Array.isArray(item && item.content) ? item.content : [];
    content.forEach(function(part) {
      if (typeof part.text === "string") parts.push(part.text);
      else if (typeof part.output_text === "string") parts.push(part.output_text);
    });
  });
  return parts.join("");
}

function parseOpenAIChatBodyText(text) {
  let fullContent = "";
  let usage = {};
  const raw = String(text || "");
  const lines = raw.split("\n");
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
  if (!fullContent && raw.trim().startsWith("{")) {
    try {
      const data = JSON.parse(raw);
      if (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) {
        fullContent = data.choices[0].message.content;
      }
      if (data.usage) usage = data.usage;
    } catch (e) {}
  }
  return { fullContent: fullContent, usage: usage };
}

function parseOpenAIResponsesBodyText(text) {
  let fullContent = "";
  let finalText = "";
  let usage = {};
  const raw = String(text || "");
  const lines = raw.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("data:") || trimmed === "data: [DONE]") continue;
    try {
      const chunk = JSON.parse(trimmed.slice(5).trim());
      if (chunk.type === "response.output_text.delta" && typeof chunk.delta === "string") {
        fullContent += chunk.delta;
      }
      if (typeof chunk.output_text === "string") finalText = chunk.output_text;
      if (chunk.usage) usage = chunk.usage;
      if (chunk.response) {
        if (chunk.response.usage) usage = chunk.response.usage;
        const textFromResponse = extractResponsesText(chunk.response);
        if (textFromResponse) finalText = textFromResponse;
      }
    } catch (e) {}
  }
  if (!fullContent && raw.trim().startsWith("{")) {
    try {
      const data = JSON.parse(raw);
      finalText = extractResponsesText(data);
      if (data.usage) usage = data.usage;
    } catch (e) {}
  }
  return { fullContent: fullContent || finalText, usage: usage };
}

function buildOpenAIResponsesInput(messages) {
  return (messages || []).filter(function(m) { return m && m.role !== "system"; }).map(function(m) {
    const role = String(m.role || "user");
    return {
      role: role,
      content: [{ type: "input_text", text: String(m.content || "") }],
    };
  });
}

function extractUsageMetrics(usage) {
  usage = usage || {};
  const promptTokens = usage.input_tokens || usage.prompt_tokens || 0;
  const completionTokens = usage.output_tokens || usage.completion_tokens || 0;
  const promptCachedTokens = Number((usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0);
  const inputCachedTokens = Number((usage.input_tokens_details && usage.input_tokens_details.cached_tokens) || 0);
  const cacheRead = Math.max(
    Number(usage.cache_read_input_tokens) || 0,
    Number(usage.cache_read_tokens) || 0,
    Number(usage.cached_input_tokens) || 0,
    Number(usage.prompt_cache_hit_tokens) || 0,
    promptCachedTokens,
    inputCachedTokens
  );
  const ephem5 = (usage.cache_creation && usage.cache_creation.ephemeral_5m_input_tokens) || 0;
  const ephem1h = (usage.cache_creation && usage.cache_creation.ephemeral_1h_input_tokens) || 0;
  const cacheCreate = usage.cache_creation_input_tokens || (ephem5 + ephem1h) || 0;
  return {
    promptTokens: Number(promptTokens) || 0,
    completionTokens: Number(completionTokens) || 0,
    totalTokens: Number(usage.total_tokens || 0) || ((Number(promptTokens) || 0) + (Number(completionTokens) || 0)),
    cacheReadTokens: Number(cacheRead) || 0,
    cacheCreateTokens: Number(cacheCreate) || 0,
  };
}

function median(values) {
  const arr = (values || []).map(Number).filter(function(v) { return Number.isFinite(v); }).sort(function(a, b) { return a - b; });
  if (!arr.length) return 0;
  return arr[Math.floor(arr.length / 2)];
}

function avg(values) {
  const arr = (values || []).map(Number).filter(function(v) { return Number.isFinite(v); });
  if (!arr.length) return 0;
  return arr.reduce(function(a, b) { return a + b; }, 0) / arr.length;
}

function coefficientOfVariation(values) {
  const arr = (values || []).map(Number).filter(function(v) { return Number.isFinite(v) && v >= 0; });
  if (arr.length < 2) return 0;
  const mean = avg(arr);
  if (mean <= 0) return 0;
  const variance = arr.reduce(function(acc, v) { return acc + Math.pow(v - mean, 2); }, 0) / arr.length;
  return Math.sqrt(variance) / mean;
}

function buildAuthenticityProbeSuite(seed) {
  const a = 37 + (seed % 23);
  const b = 19 + (seed % 17);
  const c = 11 + (seed % 13);
  const mathAnswer = (a * b) + c;
  const needle = "ZX-" + String(seed % 10000).padStart(4, "0") + "-VERIFY-" + String((seededInt(seed) % 9000) + 1000);
  const planId = "PLAN-" + String((seededInt(seed + 17) % 9000) + 1000);
  const riskId = "RISK-" + String((seededInt(seed + 31) % 9000) + 1000);
  const ownerId = "OWNER-" + String((seededInt(seed + 47) % 9000) + 1000);
  const docs = [];
  for (let i = 0; i < 18; i++) {
    docs.push("第" + (i + 1) + "段：这是一段用于黑盒模型真实性检测的业务资料，包含订单、缓存、路由、账单、上下文和错误处理说明。编号 " + i + " 的内容用于增加上下文长度和干扰项。");
    if (i === 11) docs.push("第12段隐藏审计编号：" + needle + "。只有阅读完整上下文才能返回这个编号。");
    if (i === 4) docs.push("第5段项目计划编号：" + planId + "，负责人字段为临时值，不可作为最终答案。");
    if (i === 8) docs.push("第9段最终负责人编号：" + ownerId + "，该字段覆盖所有临时负责人字段。");
    if (i === 15) docs.push("第16段风险登记编号：" + riskId + "，只有同时读到计划、风险、最终负责人时才算完成审计。");
  }
  const longDoc = docs.join("\n");
  return [
    {
      id: "identity-leak",
      category: "裸请求污染",
      evidenceLevel: "B",
      prompt: "hi",
      judge: function(text) {
        const t = String(text || "").toLowerCase();
        const leaked = /(kiro|claude code|cursor|windsurf|copilot|antigravity|cline|roocode|roo code)/i.test(t);
        return {
          passed: !leaked,
          score: leaked ? 0 : 1,
          note: leaked ? "裸请求出现未设置的客户端/代理身份" : "未发现明显身份泄漏",
        };
      },
    },
    {
      id: "math-exact",
      category: "能力指纹",
      evidenceLevel: "A",
      prompt: "只输出最终整数，不要解释。计算：(" + a + " * " + b + ") + " + c + " = ?",
      judge: function(text) {
        const got = String(text || "").match(/-?\d+/);
        const ok = !!got && Number(got[0]) === mathAnswer;
        return { passed: ok, score: ok ? 1 : 0, note: ok ? "数学唯一答案正确" : "数学唯一答案错误，期望 " + mathAnswer };
      },
    },
    {
      id: "json-format",
      category: "格式遵循",
      evidenceLevel: "B",
      prompt: "严格只输出一行 JSON，不要 Markdown。对象必须等于 {\"audit\":\"ok\",\"value\":" + mathAnswer + "}。",
      judge: function(text) {
        try {
          const data = JSON.parse(String(text || "").trim());
          const ok = data && data.audit === "ok" && Number(data.value) === mathAnswer;
          return { passed: ok, score: ok ? 1 : 0, note: ok ? "JSON 格式与字段正确" : "JSON 可解析但字段不匹配" };
        } catch (e) {
          return { passed: false, score: 0, note: "未严格输出可解析 JSON" };
        }
      },
    },
    {
      id: "long-needle",
      category: "长上下文",
      evidenceLevel: "A",
      prompt: "阅读资料后，只输出隐藏审计编号，不要解释。\n\n【资料】\n" + longDoc + "\n\n【问题】隐藏审计编号是什么？",
      judge: function(text) {
        const ok = String(text || "").includes(needle);
        return { passed: ok, score: ok ? 1 : 0, note: ok ? "长上下文找针成功" : "未找回隐藏编号 " + needle };
      },
    },
    {
      id: "long-multihop",
      category: "长上下文多跳",
      evidenceLevel: "A",
      prompt: "阅读资料后，严格只输出一行 JSON，不要 Markdown。字段必须为 plan、risk、owner。\n\n【资料】\n" + longDoc + "\n\n【问题】输出最终计划编号、风险登记编号、最终负责人编号。",
      judge: function(text) {
        try {
          const data = JSON.parse(String(text || "").trim());
          const ok = data && data.plan === planId && data.risk === riskId && data.owner === ownerId;
          return { passed: ok, score: ok ? 1 : 0, note: ok ? "长上下文多跳信息合成正确" : "多跳字段不匹配，期望 " + planId + "/" + riskId + "/" + ownerId };
        } catch (e) {
          return { passed: false, score: 0, note: "长上下文多跳未输出严格 JSON" };
        }
      },
    },
    {
      id: "code-debug",
      category: "代码调试",
      evidenceLevel: "A",
      prompt: [
        "只输出 JSON，不要 Markdown。字段：bug、fix、test。",
        "阅读这段 JavaScript，找出隐藏 bug，并给出最小修复。",
        "代码：",
        "function percentile(sorted, ratio) {",
        "  if (!sorted.length) return 0;",
        "  return sorted[Math.floor(sorted.length * ratio)] || 0;",
        "}",
        "function p95(values) {",
        "  const sorted = values.sort((a, b) => a - b);",
        "  return percentile(sorted, 0.95);",
        "}",
        "const xs = [100, 2, 30];",
        "console.log(p95(xs));",
        "要求指出：这个函数会修改调用方数组；最小修复必须包含复制数组再排序。"
      ].join("\n"),
      judge: function(text) {
        const t = String(text || "");
        let data = null;
        try { data = JSON.parse(t.trim()); } catch (e) {}
        const hay = (data ? JSON.stringify(data) : t).toLowerCase();
        const mentionsMutation = /(mutat|修改|原数组|in-place|副作用|调用方数组|输入数组)/i.test(hay);
        const mentionsCopySort = /(\[\.\.\.|slice\(\)|array\.from|copy|复制).{0,60}sort|sort.{0,60}(\[\.\.\.|slice\(\)|array\.from|copy|复制)/i.test(hay);
        const ok = mentionsMutation && mentionsCopySort;
        return { passed: ok, score: ok ? 1 : 0, note: ok ? "代码隐蔽副作用定位正确" : "未准确指出 sort 原地修改及复制后排序修复" };
      },
    },
    {
      id: "code-refactor",
      category: "代码重构",
      evidenceLevel: "A",
      prompt: [
        "只输出 JSON，不要 Markdown。字段：invariant、edge_cases、patch_summary。",
        "请审查下面函数，目标是行为保持型重构，不要改变空输入、非法数字和并列值的行为。",
        "function topUser(rows) {",
        "  let best = null;",
        "  for (const row of rows) {",
        "    if (!row || typeof row.score !== 'number' || Number.isNaN(row.score)) continue;",
        "    if (!best || row.score > best.score) best = row;",
        "  }",
        "  return best;",
        "}",
        "要求：说明必须保持的行为，并指出不能用 sort 直接重写，因为并列时会改变返回第一个最高分对象的语义。"
      ].join("\n"),
      judge: function(text) {
        const t = String(text || "");
        let data = null;
        try { data = JSON.parse(t.trim()); } catch (e) {}
        const hay = (data ? JSON.stringify(data) : t).toLowerCase();
        const keepsFirstTie = /(并列|tie|相同分|最高分相同).{0,80}(第一个|first|原顺序|语义)/i.test(hay);
        const avoidsSort = /(不要|不能|避免|not).{0,40}sort|sort.{0,60}(改变|并列|顺序|语义|不适合)/i.test(hay);
        const handlesInvalid = /(nan|非法|无效|typeof|score|空输入|null)/i.test(hay);
        const ok = keepsFirstTie && avoidsSort && handlesInvalid;
        return { passed: ok, score: ok ? 1 : 0, note: ok ? "行为保持型重构约束识别正确" : "未完整识别并列语义、非法输入或 sort 风险" };
      },
    },
  ];
}

// ============================================================
// 图片生成随机 prompt 组件（普通 image 模型）
// 目的：不要让 gpt-image-2 / dall-e / sora 长期只打 8 个固定词，
// 否则上游面板会出现“输入/输出/花费几乎一模一样”的整齐记录，看起来像在重复同一张图。
// 同时也避免只做“标签拼接”太像机器，改成更自然的真人短句模板：
// 主体 + 场景 + 光线/氛围 + 风格，长度仍然很短，更像真实用户随手生图。
// ============================================================
const IMAGE_SUBJECTS = [
  "一只橘猫", "一只柴犬", "一只白色小鸟", "一条锦鲤", "一棵樱花树", "一束向日葵",
  "一座雪山", "一片安静的湖面", "一辆复古自行车", "一座海边灯塔", "一间山间小木屋",
  "一艘帆船", "一列绿皮火车", "一杯咖啡", "一只水母", "一只热气球",
  "一只红狐狸", "一只熊猫", "一只金毛犬", "一只虎斑小猫", "一只北极熊", "一只海龟",
  "一只蜂鸟", "一匹棕马", "一把小提琴", "一台打字机", "一盏旧灯", "一台黑胶唱片机",
  "一家独立书店", "一碗拉面", "一块草莓蛋糕", "一间玻璃花房", "一座风车", "一辆有轨电车",
  "一辆露营车", "一只纸船", "一家街角咖啡馆", "一株沙漠仙人掌", "一座月光下的城堡", "一棵盆景",
];
const IMAGE_SCENES = [
  "坐在窗边", "在日落时分", "在雨后的街道", "在星空下", "在海边", "在森林里",
  "在安静的街道上", "在花田中", "在刚下过雪的空地上", "在夜晚", "在晨光里", "放在木桌上",
  "在屋顶上", "在温暖的咖啡馆里", "在小书店里", "在河边", "在火车站附近",
  "在有薄雾的山谷里", "在山路边", "在落叶里", "在樱花树下", "在傍晚金色阳光里",
  "在雨后", "在篝火旁", "在玻璃房里", "在面包店橱窗边", "在安静的小巷里",
  "在清晨", "在黄昏", "在阳台上", "在城市公园里", "在灯塔旁", "在雪地木屋附近",
];
const IMAGE_STYLES = [
  "水彩画风格", "电影感", "胶片摄影", "油画风格", "动漫风格",
  "绘本风格", "极简插画", "柔和光线", "暖色调", "像素风",
  "粉彩配色", "杂志摄影风格", "情绪感光线", "复古海报风格", "梦幻氛围",
  "干净构图", "柔和阴影", "高细节", "棚拍质感", "旅行摄影风格",
  "数字绘景风格", "3D 渲染风格", "生活方式杂志风格", "明亮日光", "温馨氛围",
];
const IMAGE_QUALIFIERS = [
  "", "", "",
  "柔和阴影", "暖光", "浅景深", "干净构图",
  "安静氛围", "细节丰富", "梦幻感", "自然色彩",
  "晨间阳光", "电影式取景", "温暖感觉", "清晰对焦",
];
const IMAGE_PROMPT_TEMPLATES = [
  "{subject}{scene}，{style}",
  "{subject}{scene}，{qualifier}，{style}",
  "{subject}{scene}，{style}，{qualifier}",
  "{subject}，{scene}，{style}",
  "{subject}，{scene}，{qualifier}，{style}",
  "{subject}{scene}，高细节，{style}",
];

const IMAGE_EDIT_TASKS = [
  "把参考模特换上一件米白色风衣，保持人物姿势和背景自然不变",
  "把参考人物换成深蓝色西装造型，保留真实街拍质感",
  "把服装替换为黑色皮夹克和白色内搭，人物五官和光线保持一致",
  "把参考上衣改成浅灰色连帽卫衣，整体像电商详情页主图",
  "把模特换上一条红色连衣裙，保留原始站姿和干净棚拍背景",
  "把衣服替换成卡其色工装外套，增加自然褶皱和真实布料纹理",
  "把参考人物换成夏季白色衬衫造型，保持画面像真实试衣效果",
  "把服装改成黑色运动套装，保持身体比例自然",
  "把参考产品放到木质桌面场景中，保留产品外形和品牌感",
  "把手提包换到城市通勤穿搭场景里，保持商品主体清晰",
  "把鞋子放到雨后街道路面上，保留鞋型和材质细节",
  "把参考家具放入明亮客厅，保持真实比例和自然阴影",
  "把商品背景换成浅色摄影棚，保留主体边缘干净",
  "把参考人物的外套改为羊羔绒材质，保留脸部和发型",
  "把衣服替换成绿色针织开衫，整体风格自然生活化",
  "把模特换成秋冬通勤穿搭，保留原始构图和真实光照",
];

// ============================================================
// nano banana / gemini 原生图片模型识别
// 这类模型走 Gemini 原生 /v1beta/models/{model}:generateContent，而非 OpenAI /v1/images/generations
// ============================================================
function isNanoBananaModel(model) {
  const m = String(model || "");
  return /nano[\s_-]?banana/i.test(m) || /gemini[-\w.]*image/i.test(m);
}

// nano 生图「人类化随机提示词」组件 —— 主体 × 场景 × 风格 自由组合
// 目的：模拟真人随手生图，海量组合（远超单次压测请求数）→ 天然不重复
// 同时保持短句（少 token，省额度），不触发内容审核
const NANO_SUBJECTS = [
  "一只橘猫", "一杯热拿铁", "一辆复古自行车", "一束向日葵", "一座灯塔",
  "一只柴犬", "一碗拉面", "一只热气球", "一棵樱花树", "一只水母",
  "一台老相机", "一双跑鞋", "一只北极熊", "一座小木屋", "一艘帆船", "一列绿皮火车",
];
const NANO_SCENES = [
  "在窗台上", "在雨后的街道", "在雪山脚下", "在夕阳下", "在霓虹夜市",
  "在海边", "在森林里", "在咖啡馆角落", "在星空下", "在花田中", "在地铁站台", "在屋顶花园",
];
const NANO_STYLES = [
  "水彩画风格", "赛博朋克风格", "电影感光影", "极简插画", "胶片质感",
  "油画笔触", "日系清新", "低多边形", "蒸汽波配色", "黑白纪实",
];

// ============================================================
// Prompt Cache 填充文本（缓存块必须 ≥1024 tokens 才会被缓存）
// 旧版用 "X" 重复 4000 次：连续相同字符被 BPE 合并，真实 token 数远少于字符数，
// 可能卡在 1024 门槛附近浮动 → 个别后端 tokenize 偏少时低于门槛，缓存块被静默忽略 → 0 命中。
// 改为「确定性生成的多样文本」(~8000 字符，稳定 ≈1500–2000 tokens)，远超门槛、不再浮动。
// 内容固定 → 同一用户跨轮逐字节一致 → 缓存前缀稳定。
// ============================================================
// ============================================================
// 真实长文本语料库 — 模拟真人/真实应用会发的长上下文
// （文档摘录、知识问答、客服记录、代码片段、产品说明等真实风格）
// 用途：① 长上下文档位拼输入 ② 缓存模式 padding（替代机械的 word-N 重复）
// 这些是“真实散文”，BPE 切分稳定，token 数不再像重复字符那样飘忽
// ============================================================
const TEXT_CORPUS = [
  // 0 - 产品/技术说明
  "我们的订单系统采用读写分离架构，主库负责写入，三个只读副本承担查询流量。每笔订单创建后会先写入主库，再通过 binlog 异步同步到副本，正常情况下延迟在 200 毫秒以内。下单接口的幂等性由客户端生成的请求 ID 保证，服务端用 Redis 做了 24 小时的去重缓存，重复提交的请求会直接返回首次结果，不会重复扣减库存。秒杀场景下，库存预热到 Redis，扣减走 Lua 脚本保证原子性，避免超卖。",
  // 1 - 故事/叙事
  "周末的清晨总是来得格外安静。她推开窗，街角的早餐铺刚升起白色的蒸汽，卖豆浆的老人照例把第一杯留给巷口那只橘猫。她沿着熟悉的石板路慢慢走，想着昨晚没写完的那封信，想着那些一直没说出口的话。阳光斜斜地铺在墙上，把斑驳的影子拉得很长，像是把整条街都浸在一种温柔的旧时光里。她忽然觉得，有些事不必急着有答案，慢慢走着，也挺好。",
  // 2 - 知识科普
  "黑洞并不是宇宙中的一个洞，而是一个引力极强、连光都无法逃逸的天体区域。它的边界称为事件视界，一旦越过这条界线，任何物质和信息都无法返回。黑洞通常由大质量恒星在生命末期坍缩形成。我们无法直接看到黑洞本身，但可以通过它对周围物质的影响来探测——比如吸积盘发出的高能辐射，或者它对邻近恒星轨道的扰动。2019 年，人类首次拍摄到了黑洞的影像。",
  // 3 - 客服/对话记录
  "用户反馈：我昨天充值的会员到现在还没到账，订单号是 8829301，麻烦帮忙查一下。客服回复：您好，已经为您核实，这笔订单支付成功但因为银行通道延迟导致权益未能即时下发，现在已经为您手动补发，请退出账号重新登录后查看。如果五分钟内仍未到账，请把支付凭证截图发给我们，会优先为您处理。给您带来不便非常抱歉。",
  // 4 - 代码与解释
  "下面这个函数实现了带超时的重试逻辑：每次请求失败后按指数退避等待，最多重试三次。注意第 12 行用了 AbortController 来确保超时后底层连接被真正取消，否则即使 Promise 已经 reject，TCP 连接可能仍挂在那里占用资源。retryDelay 用了抖动（jitter）来避免大量客户端在同一时刻重试造成的惊群效应。生产环境建议把最大重试次数和基础延迟做成可配置，方便针对不同下游服务调优。",
  // 5 - 新闻/评论风格
  "随着大模型推理成本持续下降，越来越多的中小团队开始把 AI 能力直接嵌入到业务流程中。过去需要专门算法团队才能落地的功能，如今通过调用 API 就能在几天内上线。不过业内人士也提醒，模型输出的不确定性给质量控制带来新的挑战，尤其在金融、医疗等高风险领域，仍然需要严格的人工复核和兜底机制。如何在效率和可靠性之间找到平衡，是接下来一年行业要共同面对的课题。",
  // 6 - 操作手册/FAQ
  "常见问题：为什么我的设备连不上 Wi-Fi？请依次检查：第一，确认路由器工作正常，其他设备能否上网；第二，确认输入的密码正确，注意区分大小写；第三，尝试忘记该网络后重新连接；第四，重启设备和路由器；第五，确认设备没有开启飞行模式或被 MAC 地址过滤拦截。如果以上步骤都无效，可能是设备网卡驱动异常，建议联系售后做进一步诊断。",
  // 7 - 学术/论述
  "语言的习得并非简单的模仿，而是一个主动建构规则的过程。儿童在很小的年纪就能说出他们从未听过的句子，这说明他们掌握的不是一串固定的表达，而是一套可以无限组合的生成规则。乔姆斯基由此提出，人类天生具备一种普遍语法的能力。尽管这一观点至今仍有争议，但它深刻地改变了我们对心智和语言关系的理解，也推动了认知科学的诞生。",
  // 8 - 旅行/生活
  "如果你只有三天时间在京都，建议把节奏放慢。第一天去东山一带，清水寺的清晨人少，沿着二年坂、三年坂的石阶慢慢走下来，路边的小店刚开门，可以买一支抹茶冰淇淋。第二天去岚山，竹林小径之外，更值得花时间的是渡月桥附近的河岸。第三天留给伏见稻荷，沿着千本鸟居一直往山上走，越往上人越少，能看到整座城市在脚下铺开。",
  // 9 - 商业/产品需求
  "这一期我们要做的是消息中心的重构。当前所有通知都堆在同一个列表里，用户反馈找不到重点。新方案把通知分成三类：交易相关、互动相关、系统公告，分别用三个标签页承载，未读数在标签上单独显示。交易类通知优先级最高，进入应用时如有未读会弹出轻提醒。后端需要给每条通知打上分类标签并支持按类拉取，前端做好已读状态的本地缓存，减少重复请求。",
];

// 上下文规模档位：控制注入到 prompt 的语料段落数 / 目标体量
// short = 保留原来的短句风格；medium/long 拼接真实长文本
const CONTEXT_SCALES = {
  simple: { docs: 0, label: "简单测试(原始方式)" },   // 已从前端下拉移除（与 short 完全相同），保留仅为兼容旧报告/旧配置
  short:  { docs: 0, label: "短(随手短句)" },
  medium: { docs: 2, label: "中(数百 token)" },
  long:   { docs: 6, label: "长(数千 token)" },
};
const DEFAULT_CONTEXT_SCALE = "short";

// 字符串 → 32 位整数（FNV-1a 变体），确定性，用于把 clientId/sessionId 转成 seed
function hashStr(str) {
  let h = 2166136261 >>> 0;
  const s = String(str || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// 确定性散列（xorshift），同 seed → 同结果。用于“同用户稳定、跨用户不同”地取语料
function seededInt(seed) {
  let x = ((seed >>> 0) + 0x9e3779b9) >>> 0;
  x ^= x << 13; x >>>= 0;
  x ^= x >> 17;
  x ^= x << 5;  x >>>= 0;
  return x >>> 0;
}

// 按 seed 确定性地从语料里取 n 段拼成一篇“文档”（同 seed 永远拼出同一篇）
function pickDocs(n, seed) {
  if (n <= 0) return "";
  const parts = [];
  let s = seed >>> 0;
  const used = new Set();
  for (let i = 0; i < n; i++) {
    s = seededInt(s + i);
    let idx = s % TEXT_CORPUS.length;
    // 尽量不在同一篇里重复同一段
    let guard = 0;
    while (used.has(idx) && used.size < TEXT_CORPUS.length && guard++ < TEXT_CORPUS.length) {
      idx = (idx + 1) % TEXT_CORPUS.length;
    }
    used.add(idx);
    parts.push(TEXT_CORPUS[idx]);
  }
  return parts.join("\n\n");
}

// 组装一条“真实用户问题”：按档位在短问题前贴一段/几段真实文档背景
// scale=short → 直接返回短句；medium/long → 文档 + 基于文档的问题（模拟 RAG/长对话）
function buildUserContent(scale, shortQ, seed) {
  const cfg = CONTEXT_SCALES[scale] || CONTEXT_SCALES[DEFAULT_CONTEXT_SCALE];
  if (cfg.docs <= 0) return shortQ;
  const doc = pickDocs(cfg.docs, seed);
  return "请阅读下面的资料，然后回答我的问题。\n\n【资料】\n" + doc + "\n\n【问题】" + shortQ;
}

// 缓存模式 padding：必须稳超 1024 token 且同用户逐字节稳定（否则前缀失配、命中归零）。
// 做法：从 seed 决定的起点开始，确定性地拼接真实文档段落，直到累计字符数达标。
// 跨用户不同（seed 不同 → 起点/顺序不同），同用户固定（同 seed → 同结果）。
// 中文每字约 0.6~1.5 token，取 ~3000 字符兜住 1024 门槛（远超），不受上下文档位影响。
function buildCachePad(scale, seed) {
  const cfg = CONTEXT_SCALES[scale] || CONTEXT_SCALES[DEFAULT_CONTEXT_SCALE];
  // 长档位再加量；下限 3000 字符保证稳超 1024 token
  const targetChars = cfg.docs >= 6 ? 5000 : 3000;
  const parts = [];
  let total = 0;
  let s = seed >>> 0;
  let i = 0;
  while (total < targetChars && i < 200) {
    s = seededInt(s + i);
    const seg = TEXT_CORPUS[s % TEXT_CORPUS.length];
    parts.push(seg);
    total += seg.length + 2;
    i++;
  }
  return "参考资料（请基于以下内容保持回答一致）：\n\n" + parts.join("\n\n");
}

// 按模型决定注入哪些“真实客户端会带的”随机参数，让请求不再千篇一律。
// ⚠️ Claude/Anthropic 系列经 OpenAI 兼容接口常拒收 temperature/top_p（nexaxis 直接 400），
//    所以对 Claude 只注入安全字段（system 提示、max_tokens 抖动），不碰采样参数。
function isClaudeLikeModel(model) {
  const m = String(model || "").toLowerCase();
  return m.includes("claude") || m.includes("anthropic") ||
         m.includes("opus") || m.includes("sonnet") || m.includes("haiku");
}

function isOpenAIStyleModel(model) {
  return !isClaudeLikeModel(model);
}
const SYSTEM_PERSONAS = [
  "You are a helpful assistant. Be concise.",
  "你是一个乐于助人的助手，请简明扼要地回答。",
  "You are a knowledgeable assistant. Answer clearly and briefly.",
  "请用简短、口语化的方式回答用户的问题。",
];
// 返回 { extra: {...合并进 body 的字段}, system: string|null }
// enabled=false 时返回空，完全不改变原有请求形状
function buildRandomParams(model, enabled, seed) {
  if (!enabled) return { extra: {}, system: null };
  const s = seededInt((seed >>> 0) + 1);
  const r = (s % 1000) / 1000;            // 0..1 确定性
  const r2 = ((s >>> 10) % 1000) / 1000;  // 无符号右移，避免负数
  const r3 = ((s >>> 20) % 1000) / 1000;
  const extra = {};
  const claude = isClaudeLikeModel(model);
  // system 提示词对所有渠道安全 —— 始终可以随机挑一个
  const system = SYSTEM_PERSONAS[s % SYSTEM_PERSONAS.length];
  if (!claude) {
    // OpenAI 风格采样参数：真实客户端常带，且每次略有不同
    extra.temperature = Math.round((0.3 + r * 0.7) * 100) / 100;   // 0.30 - 1.00
    extra.top_p = Math.round((0.85 + r2 * 0.15) * 100) / 100;       // 0.85 - 1.00
    if (r3 > 0.6) extra.presence_penalty = Math.round((r * 0.6) * 100) / 100;
    if (r2 > 0.6) extra.frequency_penalty = Math.round((r2 * 0.6) * 100) / 100;
  }
  return { extra: extra, system: system };
}

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
      "主演是谁",
      "豆瓣评分多少",
      "有续集吗",
      "适合和家人一起看吗",
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

// 把 idx 派生成一个稳定的、真实用户风格的 UUID v4 字符串（同一 idx 结果一致）
// 真实客户端的 metadata.user_id 通常是 UUID/哈希，不是 "session-1" 这种压测味的串
function makeUserId(idx) {
  // 基于 idx 的确定性伪随机（xorshift），生成 32 个 hex 字符，组装成 UUID v4 格式
  let x = (idx + 1) * 2654435761 >>> 0;   // Knuth 乘法散列做种子
  let hex = "";
  while (hex.length < 32) {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5;  x >>>= 0;
    hex += x.toString(16).padStart(8, "0");
  }
  hex = hex.slice(0, 32);
  // UUID v4 布局：第13位固定 4，第17位取 8/9/a/b
  const variant = "89ab"[parseInt(hex[16], 16) % 4];
  return (
    hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-4" + hex.slice(13, 16) +
    "-" + variant + hex.slice(17, 20) + "-" + hex.slice(20, 32)
  );
}

function makeDeterministicUuid(seed) {
  let x = hashStr(seed || "seed");
  let hex = "";
  let i = 0;
  while (hex.length < 32) {
    x = seededInt(x + i * 2654435761);
    hex += x.toString(16).padStart(8, "0");
    i++;
  }
  hex = hex.slice(0, 32);
  const variant = "89ab"[parseInt(hex[16], 16) % 4];
  return (
    hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-4" + hex.slice(13, 16) +
    "-" + variant + hex.slice(17, 20) + "-" + hex.slice(20, 32)
  );
}

function makeRunScopeTag(runId) {
  return "r" + hashStr(String(runId || "run")).toString(36);
}

function scopeSessionIdForRun(sessionId, runId) {
  const sid = String(sessionId || "session");
  const scope = makeRunScopeTag(runId);
  return sid.endsWith("-" + scope) ? sid : (sid + "-" + scope);
}

function scopeIdentityForRun(identity, runId, stableLabel) {
  const base = identity || makeIdentity(0);
  const scope = makeRunScopeTag(runId);
  const label = String(stableLabel || base.clientId || "session");
  return {
    ua: base.ua,
    clientId: base.clientId + "-" + scope,
    userId: makeDeterministicUuid(base.userId + "|" + scope + "|" + label),
  };
}

// 为第 idx 个 worker/session 生成一个稳定身份（同一 idx 多次调用结果一致）
function makeIdentity(idx) {
  const ua = UA_POOL[idx % UA_POOL.length];
  // 身份内的稳定后缀：用 idx 派生，不用随机，确保整轮不变
  const clientId = "client-" + idx.toString(36).padStart(4, "0");
  return {
    ua: ua,
    clientId: clientId,
    userId: makeUserId(idx),    // 真实用户风格 UUID，用于 metadata.user_id 粘性路由
  };
}

function parsePercentNumber(value) {
  if (typeof value === "number") return value;
  return parseFloat(String(value || "").replace("%", "")) || 0;
}

function parseDurationSeconds(value) {
  if (typeof value === "number") return value;
  return parseFloat(String(value || "").replace("s", "")) || 0;
}

function pickWeighted(items, fallback) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length) return fallback;
  const total = list.reduce(function(sum, item) {
    return sum + Math.max(0, Number(item.weight) || 0);
  }, 0);
  if (total <= 0) return fallback != null ? fallback : list[0];
  let n = Math.random() * total;
  for (const item of list) {
    n -= Math.max(0, Number(item.weight) || 0);
    if (n <= 0) return item;
  }
  return list[list.length - 1];
}

function normalizeRpmCacheSessionPreset(value) {
  const preset = String(value || "").trim();
  return RPM_CACHE_SESSION_LENGTH_PRESETS[preset] ? preset : RPM_CACHE_DEFAULT_SESSION_LENGTH_PRESET;
}

function normalizeRpmCacheReturnPreset(value) {
  const preset = String(value || "").trim();
  return RPM_CACHE_RETURN_INTERVAL_PRESETS[preset] ? preset : RPM_CACHE_DEFAULT_RETURN_INTERVAL_PRESET;
}

function sampleSessionTurns(preset, maxRounds) {
  const dist = RPM_CACHE_SESSION_LENGTH_PRESETS[normalizeRpmCacheSessionPreset(preset)] || RPM_CACHE_SESSION_LENGTH_PRESETS.realistic;
  const item = pickWeighted(dist, dist[0]);
  return Math.max(1, Math.min(Math.max(1, Number(maxRounds) || RPM_CACHE_DEFAULT_MAX_ROUNDS), Number(item.turns) || 1));
}

function sampleReturnDelayMs(preset) {
  const dist = RPM_CACHE_RETURN_INTERVAL_PRESETS[normalizeRpmCacheReturnPreset(preset)] || RPM_CACHE_RETURN_INTERVAL_PRESETS.realistic;
  const item = pickWeighted(dist, dist[0]);
  const minMs = Math.max(0, Number(item.minMs) || 0);
  const maxMs = Math.max(minMs, Number(item.maxMs) || minMs);
  if (maxMs <= minMs) return minMs;
  return minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
}

function aggregateSequentialReports(config, reports, startedAt, endedAt, runId) {
  const totals = {
    totalSent: 0,
    totalDone: 0,
    success: 0,
    fail: 0,
    rateLimited: 0,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    conversationsDone: 0,
    conversationsFailed: 0,
    cacheHits: 0,
    latencyWeight: 0,
    avgLatencyWeighted: 0,
    avgTtfbWeighted: 0,
    p50Weighted: 0,
    p90Weighted: 0,
    p95Weighted: 0,
    p99Weighted: 0,
    minLatency: Infinity,
    maxLatency: 0,
    peakInflight: 0,
    actualRpmWeighted: 0,
    equivalentRpmWeighted: 0,
  };
  const perTurnMap = {};
  const errorMap = {};
  const errorSamples = [];
  const errorSampleSeen = {};
  const modelRows = [];
  const modelRuns = [];

  for (let i = 0; i < reports.length; i++) {
    const report = reports[i];
    const s = report.summary || {};
    const l = report.latency || {};
    const weight = Math.max(1, Number(s.success) || 0);

    totals.totalSent += Number(s.totalSent) || 0;
    totals.totalDone += Number(s.totalDone) || 0;
    totals.success += Number(s.success) || 0;
    totals.fail += Number(s.fail) || 0;
    totals.rateLimited += Number(s.rateLimited) || 0;
    totals.cacheCreateTokens += Number(s.cacheCreateTokens) || 0;
    totals.cacheReadTokens += Number(s.cacheReadTokens) || 0;
    totals.conversationsDone += Number(s.conversationsDone) || 0;
    totals.conversationsFailed += Number(s.conversationsFailed) || 0;
    totals.peakInflight = Math.max(totals.peakInflight, Number(s.peakInflight) || 0);
    totals.latencyWeight += weight;
    totals.avgLatencyWeighted += (Number(l.avg) || 0) * weight;
    totals.avgTtfbWeighted += (((report.models && report.models[0] && Number(report.models[0].avgTtfb)) || 0) * weight);
    totals.p50Weighted += (Number(l.p50) || 0) * weight;
    totals.p90Weighted += (Number(l.p90) || 0) * weight;
    totals.p95Weighted += (Number(l.p95) || 0) * weight;
    totals.p99Weighted += (Number(l.p99) || 0) * weight;
    totals.minLatency = Math.min(totals.minLatency, Number(l.min) || Infinity);
    totals.maxLatency = Math.max(totals.maxLatency, Number(l.max) || 0);
    totals.actualRpmWeighted += (Number(s.actualRpm) || 0) * weight;
    totals.equivalentRpmWeighted += (Number(s.equivalentRpm) || 0) * weight;

    (report.perTurnCache || []).forEach(function(turn) {
      const key = String(turn.turn);
      if (!perTurnMap[key]) perTurnMap[key] = { turn: key, total: 0, hits: 0 };
      perTurnMap[key].total += Number(turn.total) || 0;
      perTurnMap[key].hits += Number(turn.hits) || 0;
    });

    (report.errorSummary || []).forEach(function(err) {
      const key = err.type || "unknown";
      errorMap[key] = (errorMap[key] || 0) + (Number(err.count) || 0);
    });
    mergeErrorSamples(errorSamples, errorSampleSeen, report.errorSamples);

    (report.models || []).forEach(function(modelRow) {
      modelRows.push(Object.assign({}, modelRow, {
        sequenceOrder: i + 1,
        reportPath: report.reportPath || null,
        duration: s.duration || null,
        actualRpm: Number(s.actualRpm) || 0,
        equivalentRpm: Number(s.equivalentRpm) || 0,
      }));
    });

    modelRuns.push({
      order: i + 1,
      model: (report.config && report.config.models && report.config.models[0]) || ((report.models && report.models[0] && report.models[0].model) || ("model-" + (i + 1))),
      startedAt: report.startedAt || null,
      endedAt: report.endedAt || null,
      reportPath: report.reportPath || null,
      summary: report.summary || {},
      latency: report.latency || {},
      perTurnCache: report.perTurnCache || [],
      errorSummary: report.errorSummary || [],
    });
  }

  const elapsedSec = startedAt && endedAt ? Math.max(0, (endedAt - startedAt) / 1000) : 0;
  const successRate = totals.totalDone > 0 ? ((totals.success / totals.totalDone) * 100).toFixed(1) : "0.0";
  const qps = elapsedSec > 0 ? (totals.totalDone / elapsedSec).toFixed(2) : "0.00";
  const cacheOps = Object.keys(perTurnMap)
    .reduce(function(acc, turn) {
      if (Number(turn) <= 1) return acc;
      acc.total += perTurnMap[turn].total;
      acc.hits += perTurnMap[turn].hits;
      return acc;
    }, { total: 0, hits: 0 });
  const cacheObserved = totals.cacheReadTokens > 0 || cacheOps.hits > 0;
  const cacheHitRate = cacheOps.total > 0 ? ((cacheOps.hits / cacheOps.total) * 100).toFixed(1) : "N/A";
  const cacheHitDisplay = cacheOps.total > 0 ? cacheHitRate : (cacheObserved ? "已检测到缓存读" : "N/A");
  const warmedCacheOps = cacheOps;
  const warmedCacheHitRate = cacheHitRate;
  const warmedCacheHitDisplay = cacheHitDisplay;
  const latencyWeight = totals.latencyWeight || 1;

  const perTurnCache = Object.values(perTurnMap).map(function(turn) {
    return {
      turn: turn.turn,
      total: turn.total,
      hits: turn.hits,
      rate: turn.total > 0 ? ((turn.hits / turn.total) * 100).toFixed(1) : "0.0",
    };
  }).sort(function(a, b) { return Number(a.turn) - Number(b.turn); });

  modelRows.sort(function(a, b) { return (a.sequenceOrder - b.sequenceOrder) || ((a.avgLatency || 0) - (b.avgLatency || 0)); });

  return {
    runId: runId,
    startedAt: startedAt ? new Date(startedAt).toISOString() : null,
    endedAt: endedAt ? new Date(endedAt).toISOString() : null,
    testMode: ((config.mode === "rpm") ? "RPM 开环压测"
      : config.mode === "conversation" ? "连续对话压测"
      : (config.mode === "image" && config.imageMode === "rpm") ? "图片生成 RPM 开环压测"
      : config.mode === "image" ? "图片生成压测"
      : "独立请求压测") + "（多模型顺序排队）",
    sequence: {
      enabled: true,
      strategy: "sequential",
      totalModels: (config.models || []).length,
      completedModels: reports.length,
      eachModelGetsFullLoad: true,
    },
    config: sanitizeConfig(config),
    summary: {
      duration: elapsedSec.toFixed(2) + "s",
      concurrency: config.concurrency,
      targetRpm: config.targetRpm || 0,
      actualRpm: Math.round(totals.actualRpmWeighted / latencyWeight),
      equivalentRpm: Math.round(totals.equivalentRpmWeighted / latencyWeight),
      peakInflight: totals.peakInflight,
      totalSent: totals.totalSent,
      totalDone: totals.totalDone,
      success: totals.success,
      fail: totals.fail,
      rateLimited: totals.rateLimited,
      successRate: successRate + "%",
      qps: qps,
      cacheHitRate: cacheHitRate,
      cacheHitDisplay: cacheHitDisplay,
      warmedCacheHitRate: warmedCacheHitRate,
      warmedCacheHitDisplay: warmedCacheHitDisplay,
      cacheObserved: cacheObserved,
      cacheCreateTokens: totals.cacheCreateTokens,
      cacheReadTokens: totals.cacheReadTokens,
      conversationsDone: totals.conversationsDone,
      conversationsFailed: totals.conversationsFailed,
    },
    latency: {
      avg: Math.round(totals.avgLatencyWeighted / latencyWeight * 100) / 100,
      min: totals.minLatency === Infinity ? 0 : totals.minLatency,
      max: totals.maxLatency,
      p50: Math.round(totals.p50Weighted / latencyWeight),
      p90: Math.round(totals.p90Weighted / latencyWeight),
      p95: Math.round(totals.p95Weighted / latencyWeight),
      p99: Math.round(totals.p99Weighted / latencyWeight),
    },
    perTurnCache: perTurnCache,
    models: modelRows,
    modelRuns: modelRuns,
    errorSummary: Object.entries(errorMap).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 10).map(function(e) {
      return { type: e[0], count: e[1] };
    }),
    errorSamples: errorSamples,
    errors: reports.flatMap(function(report) { return report.errors || []; }).slice(0, 100),
  };
}

function percentile(sorted, ratio) {
  if (!sorted || sorted.length === 0) return 0;
  return sorted[Math.floor(sorted.length * ratio)] || 0;
}

function parseDurationMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  const m = String(value || "").trim().match(/^([0-9]+(?:\.[0-9]+)?)s$/i);
  return m ? Math.max(0, Math.round(Number(m[1]) * 1000)) : 0;
}

function resolveLaunchWindowMs(rawLaunchMs, configuredMs, launchCompletedNaturally) {
  const rawMs = Math.max(0, Number(rawLaunchMs) || 0);
  const plannedMs = Math.max(0, Number(configuredMs) || 0);
  return launchCompletedNaturally ? Math.max(rawMs, plannedMs) : rawMs;
}

function orderedConfiguredModels(config, statsMap) {
  const seen = new Set();
  const ordered = [];
  (config && Array.isArray(config.models) ? config.models : []).forEach(function(model) {
    const key = String(model || "").trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    ordered.push(key);
  });
  Object.keys(statsMap || {}).forEach(function(model) {
    const key = String(model || "").trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    ordered.push(key);
  });
  return ordered;
}

function mergeWorkerReports(config, reports, startedAt, endedAt, runId) {
  const elapsedMs = startedAt && endedAt ? Math.max(0, endedAt - startedAt) : 0;
  const elapsedSec = (elapsedMs / 1000).toFixed(2);
  const totals = {
    totalSent: 0,
    totalDone: 0,
    success: 0,
    fail: 0,
    rateLimited: 0,
    peakInflight: 0,
  };
  const latencies = [];
  const errorMap = {};
  const errors = [];
  const errorSamples = [];
  const errorSampleSeen = {};
  const workerRuns = [];
  const modelMap = {};
  const imageCaseStats = { workload: {}, size: {}, quality: {}, result: {} };
  // 文字缓存汇总累加器（图片模式这些保持 0/空，行为不变）
  const isImage = config.mode === "image";
  const perTurnMap = {};   // { "1": {total,hits}, "2": {...} }  跨 worker 按轮号求和
  let cacheCreateTokens = 0, cacheReadTokens = 0, conversationsDone = 0, conversationsFailed = 0;
  let cacheObserved = false;
  function mergeCountMap(target, source) {
    Object.keys(source || {}).forEach(function(key) {
      target[key] = (target[key] || 0) + (Number(source[key]) || 0);
    });
  }

  reports.forEach(function(report, idx) {
    const s = report.summary || {};
    totals.totalSent += Number(s.totalSent) || 0;
    totals.totalDone += Number(s.totalDone) || 0;
    totals.success += Number(s.success) || 0;
    totals.fail += Number(s.fail) || 0;
    totals.rateLimited += Number(s.rateLimited) || 0;
    totals.peakInflight += Number(s.peakInflight) || 0;
    // 文字缓存：跨 worker 求和缓存 token / 会话数；按轮号合并 perTurnCache
    cacheCreateTokens += Number(s.cacheCreateTokens) || 0;
    cacheReadTokens += Number(s.cacheReadTokens) || 0;
    conversationsDone += Number(s.conversationsDone) || 0;
    conversationsFailed += Number(s.conversationsFailed) || 0;
    if (s.cacheObserved) cacheObserved = true;
    (report.perTurnCache || []).forEach(function(pt) {
      const turn = String(pt.turn);
      if (!perTurnMap[turn]) perTurnMap[turn] = { total: 0, hits: 0 };
      perTurnMap[turn].total += Number(pt.total) || 0;
      perTurnMap[turn].hits += Number(pt.hits) || 0;
    });
    ((report.latencySamples || [])).forEach(function(v) {
      v = Number(v) || 0;
      if (v > 0) latencies.push(v);
    });
    (report.errorSummary || []).forEach(function(e) {
      if (!e || !e.type) return;
      errorMap[e.type] = (errorMap[e.type] || 0) + (Number(e.count) || 0);
    });
    (report.errors || []).forEach(function(e) { errors.push(e); });
    mergeErrorSamples(errorSamples, errorSampleSeen, report.errorSamples);
    if (report.imageCaseStats) {
      mergeCountMap(imageCaseStats.workload, report.imageCaseStats.workload);
      mergeCountMap(imageCaseStats.size, report.imageCaseStats.size);
      mergeCountMap(imageCaseStats.quality, report.imageCaseStats.quality);
      mergeCountMap(imageCaseStats.result, report.imageCaseStats.result);
    }
    (report.models || []).forEach(function(m) {
      const key = m.model || "unknown";
      if (!modelMap[key]) {
        modelMap[key] = { model: key, success: 0, fail: 0, latencies: [],
          cacheHits: 0, cacheCreateTokens: 0, cacheReadTokens: 0,
          promptTokenSum: 0, completionTokenSum: 0, turn1Count: 0 };
      }
      const ms = Number(m.success) || 0;
      modelMap[key].success += ms;
      modelMap[key].fail += Number(m.fail) || 0;
      // 文字缓存：命中/创建/读取 token 直接求和；prompt/completion 平均按 success 加权
      modelMap[key].cacheHits += Number(m.cacheHits) || 0;
      modelMap[key].cacheCreateTokens += Number(m.cacheCreateTokens) || 0;
      modelMap[key].cacheReadTokens += Number(m.cacheReadTokens) || 0;
      modelMap[key].promptTokenSum += (Number(m.avgPromptTokens) || 0) * ms;
      modelMap[key].completionTokenSum += (Number(m.avgCompletionTokens) || 0) * ms;
      modelMap[key].turn1Count += Number(m.turn1Count) || 0;
      if (Array.isArray(m.latencySamples)) {
        m.latencySamples.forEach(function(v) {
          v = Number(v) || 0;
          if (v > 0) modelMap[key].latencies.push(v);
        });
      }
    });
    workerRuns.push({
      worker: (report.worker && report.worker.id) || ("worker-" + (idx + 1)),
      workerUrl: (report.worker && report.worker.url) || null,
      runId: report.runId || null,
      summary: report.summary || {},
      latency: report.latency || {},
    });
  });

  latencies.sort(function(a, b) { return a - b; });
  const avg = latencies.length ? Math.round(latencies.reduce(function(a, b) { return a + b; }, 0) / latencies.length * 100) / 100 : 0;
  const min = latencies[0] || 0;
  const max = latencies[latencies.length - 1] || 0;
  const workerLaunchMs = reports.map(function(report) {
    return parseDurationMs(report && report.summary && report.summary.duration);
  }).filter(function(ms) { return ms > 0; });
  const launchMs = Math.max(workerLaunchMs.length ? Math.max.apply(null, workerLaunchMs) : 0, 1);
  const actualRpm = reports.length
    ? reports.reduce(function(sum, report) { return sum + (Number(report && report.summary && report.summary.actualRpm) || 0); }, 0)
    : Math.round((totals.totalSent / (launchMs / 1000)) * 60);
  const successRate = totals.totalDone > 0 ? ((totals.success / totals.totalDone) * 100).toFixed(1) : "0";
  const modelRows = orderedConfiguredModels(config, modelMap).map(function(key) {
    const m = modelMap[key] || {
      model: key,
      success: 0,
      fail: 0,
      latencies: [],
      cacheHits: 0,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
      promptTokenSum: 0,
      completionTokenSum: 0,
      turn1Count: 0,
    };
    const sl = m.latencies.sort(function(a, b) { return a - b; });
    const total = m.success + m.fail;
    const mTurn1 = m.turn1Count || 0;
    const mCacheDenom = total - mTurn1;
    return {
      model: m.model,
      success: m.success,
      fail: m.fail,
      rate: total > 0 ? ((m.success / total) * 100).toFixed(1) : "0.0",
      avgLatency: sl.length ? Math.round(sl.reduce(function(a, b) { return a + b; }, 0) / sl.length * 100) / 100 : 0,
      avgTtfb: 0,
      p50: percentile(sl, 0.50),
      p90: percentile(sl, 0.90),
      p95: percentile(sl, 0.95),
      p99: percentile(sl, 0.99),
      min: sl[0] || 0,
      max: sl[sl.length - 1] || 0,
      cacheHits: m.cacheHits || 0,
      avgPromptTokens: m.success > 0 ? Math.round((m.promptTokenSum || 0) / m.success) : 0,
      avgCompletionTokens: m.success > 0 ? Math.round((m.completionTokenSum || 0) / m.success) : 0,
      cacheCreateTokens: m.cacheCreateTokens || 0,
      cacheReadTokens: m.cacheReadTokens || 0,
      cacheHitRate: mCacheDenom > 0 ? ((m.cacheHits / mCacheDenom) * 100).toFixed(1) : "0.0",
      cacheHitDisplay: mCacheDenom > 0 ? (m.cacheHits / mCacheDenom * 100).toFixed(1) + "%（请求级，第2轮起）" : "0.0%",
      rawUsageSample: [],
      turn1Count: mTurn1,
    };
  });

  // 文字缓存：按轮号排序重建 perTurnCache；总命中率排除第1轮（turn>=2，沿用单机口径）
  const perTurnCacheArr = Object.keys(perTurnMap).sort(function(a, b) { return Number(a) - Number(b); }).map(function(turn) {
    const e = perTurnMap[turn];
    return { turn: turn, total: e.total, hits: e.hits, rate: e.total > 0 ? ((e.hits / e.total) * 100).toFixed(1) : "0" };
  });
  let warmTotal = 0, warmHits = 0;
  Object.keys(perTurnMap).forEach(function(turn) {
    if (Number(turn) >= 2) { warmTotal += perTurnMap[turn].total; warmHits += perTurnMap[turn].hits; }
  });
  const textCacheRate = warmTotal > 0 ? ((warmHits / warmTotal) * 100).toFixed(1) : null;
  const textCacheDisplay = textCacheRate != null ? (textCacheRate + "% (已排除第1轮)") : (cacheObserved ? "已检测到缓存读" : "N/A");
  const multiModelMixed = !isImage && config.rpmMultiModelMode === "mixed" && (config.models || []).length > 1;

  return {
    runId: runId,
    startedAt: startedAt ? new Date(startedAt).toISOString() : null,
    endedAt: endedAt ? new Date(endedAt).toISOString() : null,
    testMode: isImage ? "图片生成 RPM 多 Worker 压测" : ((config.rpmCache ? "RPM 缓存" : "RPM 开环") + "多 Worker 压测" + (multiModelMixed ? "(多模型随机混合 " + (config.models || []).length + " 个)" : "")),
    multiModelMixed: multiModelMixed,
    config: sanitizeConfig(config),
    distributed: {
      enabled: true,
      workerCount: reports.length,
      perWorkerRpm: Math.ceil((Number(config.targetRpm) || 0) / Math.max(1, reports.length)),
      workerRuns: workerRuns,
    },
    summary: {
      duration: elapsedSec + "s",
      concurrency: config.concurrency,
      targetRpm: config.targetRpm || 0,
      actualRpm: actualRpm,
      equivalentRpm: 0,
      peakInflight: totals.peakInflight,
      totalSent: totals.totalSent,
      totalDone: totals.totalDone,
      success: totals.success,
      fail: totals.fail,
      rateLimited: totals.rateLimited,
      successRate: successRate + "%",
      qps: elapsedMs > 0 ? (totals.totalDone / (elapsedMs / 1000)).toFixed(2) : "0",
      cacheHitRate: isImage ? "N/A" : (textCacheRate != null ? textCacheRate : "N/A"),
      cacheHitDisplay: isImage ? "N/A" : textCacheDisplay,
      warmedCacheHitRate: isImage ? "N/A" : (textCacheRate != null ? textCacheRate : "N/A"),
      warmedCacheHitDisplay: isImage ? "N/A" : textCacheDisplay,
      cacheObserved: isImage ? false : cacheObserved,
      cacheCreateTokens: isImage ? 0 : cacheCreateTokens,
      cacheReadTokens: isImage ? 0 : cacheReadTokens,
      conversationsDone: isImage ? 0 : conversationsDone,
      conversationsFailed: isImage ? 0 : conversationsFailed,
    },
    latency: {
      avg: avg,
      min: min,
      max: max,
      p50: percentile(latencies, 0.50),
      p90: percentile(latencies, 0.90),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
    },
    imageCaseStats: isImage ? imageCaseStats : {},
    deliveryHint: null,
    authenticity: null,
    perTurnCache: isImage ? [] : perTurnCacheArr,
    models: modelRows,
    modelRuns: workerRuns,
    errorSummary: Object.entries(errorMap).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 10).map(function(e) {
      return { type: e[0], count: e[1] };
    }),
    errorSamples: errorSamples,
    errors: errors.slice(0, 100),
  };
}

async function postJson(urlString, body, timeoutMs, headers) {
  const ctrl = new AbortController();
  const t = setTimeout(function() { ctrl.abort(); }, timeoutMs || 30000);
  try {
    const resp = await fetch(urlString, {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, headers || {}),
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
    const text = await resp.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) {}
    if (!resp.ok) {
      throw new Error((json && json.error) || ("HTTP " + resp.status));
    }
    return json || {};
  } finally {
    clearTimeout(t);
  }
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
    this._stopNewSessions = false;   // 连续对话(b)：到点后停止取新会话，但存量会话做满全部轮
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
    this.launchCompletedNaturally = false;
    this.cacheHits = 0;
    this.turn1Contamination = 0;  // turn-1 出现 cache_read>0 的次数 = 渠道跨会话串缓存信号(正常应为0)
    this.cacheCreateTokens = 0;   // 缓存写入 token 累计（第1轮 cache_creation_input_tokens）
    this.cacheReadTokens = 0;     // 缓存读取 token 累计（后续轮 cache_read_input_tokens）
    this._rawUsageSample = {};    // 每模型首个成功响应的原始 usage 对象（诊断渠道到底回了什么字段）
    this._deliveryMetaSamples = [];
    this.latencies = [];
    this.allLatencies = [];
    this.modelStats = {};
    this.perTurnCache = {};
    this.errors = [];
    this.errorSamples = [];
    this._errorSampleMap = {};
    this._usedImagePrompts = new Set();   // nano 生图：本轮已用过的提示词，去重防重复
    this._imageCaseSeq = 0;
    this.imageCaseStats = {};
    this.conversationsDone = 0;
    this.conversationsFailed = 0;
    this.lastReport = null;
    this._workerMeta = null;
    this._activeChildEngine = null;
    this._sequenceReports = [];
    this._sequenceProgress = null;
    // 注：beta 头不兼容记忆已改为进程级全局 GLOBAL_BETA_HEADER_BYPASS，不再每次 run 清零
    // 记住「这个渠道+模型的 /v1/responses 端点不存在」→ 之后直接走 chat，不再反复探测
    this._openaiResponsesUnsupported = new Set();
  }

  _betaBypassKey(baseUrl, model) {
    return String(baseUrl || "").trim().replace(/\/+$/, "") + "||" + String(model || "").trim();
  }

  // beta 头记忆 key 额外带 apiKey 哈希：同 baseUrl+model 不同 key(原生/Bedrock) 互不污染
  _betaBypassKeyAuth(baseUrl, model, apiKey) {
    return this._betaBypassKey(baseUrl, model) + "||" + hashStr(String(apiKey || ""));
  }

  _shouldBypassBetaHeader(baseUrl, model, apiKey) {
    return GLOBAL_BETA_HEADER_BYPASS.has(this._betaBypassKeyAuth(baseUrl, model, apiKey));
  }

  _rememberBetaHeaderBypass(baseUrl, model, apiKey) {
    GLOBAL_BETA_HEADER_BYPASS.add(this._betaBypassKeyAuth(baseUrl, model, apiKey));
  }

  // OpenAI 风格端点记忆：探明某渠道+模型只支持 chat 后锁定，避免每条请求都重探 /v1/responses 吃 404
  _shouldSkipOpenAIResponses(baseUrl, model) {
    return this._openaiResponsesUnsupported.has(this._betaBypassKey(baseUrl, model));
  }

  _rememberOpenAIResponsesUnsupported(baseUrl, model) {
    this._openaiResponsesUnsupported.add(this._betaBypassKey(baseUrl, model));
  }

  _buildAnthropicCacheHeaders(baseUrl, model, apiKey, extraHeaders) {
    const headers = makeAnthropicCacheHeaders(apiKey, extraHeaders);
    if (this._shouldBypassBetaHeader(baseUrl, model, apiKey)) {
      delete headers["anthropic-beta"];
    }
    return headers;
  }

  async _attachAuthenticityAddon(report) {
    if (!this.config || !this.config.authenticityAddon) return report;
    if (!report || report.authenticity) return report;
    const model = this.config.models && this.config.models[0];
    if (!model || this.config.mode === "authenticity" || this.config.mode === "image") return report;
    try {
      const child = new StressTestEngine();
      const childConfig = Object.assign({}, this.config, {
        mode: "authenticity",
        models: [model],
        authenticityAddon: false,
        randomParams: false,
        contextScale: "simple",
        maxTokens: 220,
        authRepeatCount: 10,
      });
      const childReport = await child.run(childConfig);
      if (childReport && childReport.authenticity) {
        report.authenticity = childReport.authenticity;
        report.authenticity.attached = true;
        report.authenticity.sourceRunId = childReport.runId || null;
      }
    } catch (e) {
      report.authenticity = {
        score: 0,
        verdict: "真实性检测失败",
        confidence: "低",
        note: "附加真实性检测执行失败：" + e.message,
        risks: [{ level: "B", type: "检测执行失败", note: e.message }],
        evidence: [],
      };
    }
    return report;
  }

  _shouldUseWorkers(config) {
    if (!config || WORKER_URLS.length === 0) return false;
    // 图片 RPM（原逻辑）
    if (config.mode === "image" && config.imageMode === "rpm") {
      return Number(config.targetRpm || 0) >= WORKER_TARGET_THRESHOLD_RPM;
    }
    // 文字 RPM：单模型 或 多模型混合才分摊；多模型顺序排队保持单机（顺序语义不能被分布式打散）
    if (config.mode === "rpm") {
      const multi = (config.models || []).length > 1;
      if (multi && config.rpmMultiModelMode !== "mixed") return false;
      return Number(config.targetRpm || 0) >= WORKER_TEXT_TARGET_THRESHOLD_RPM;
    }
    return false;
  }

  async runDistributed(config) {
    const isImage = config.mode === "image";
    const workers = WORKER_URLS.slice();
    const startedAt = Date.now();
    const workerCount = workers.length;
    const targetRpm = Number(config.targetRpm || 0);
    const baseRpm = Math.floor(targetRpm / workerCount);
    let remainder = targetRpm % workerCount;
    const startAt = Date.now() + 8000;
    this._workerJob = {
      workers: workers.map(function(workerUrl, idx) {
        return {
          id: "worker-" + (idx + 1),
          url: workerUrl,
          targetRpm: baseRpm + (remainder-- > 0 ? 1 : 0),
          status: "starting",
          snapshot: null,
          report: null,
          error: null,
        };
      }),
      startAt: startAt,
    };

    console.log("[多Worker] " + (isImage ? "图片" : "文字") + " RPM " + targetRpm + " 拆分到 " + workerCount + " 个 worker");
    const startResults = await Promise.all(this._workerJob.workers.map(async (worker, idx) => {
      const workerConfig = Object.assign({}, config, {
        targetRpm: worker.targetRpm,
        maxInflight: Math.max(1, Math.ceil(Number(config.maxInflight || 0) / workerCount) || WORKER_DEFAULT_MAX_INFLIGHT),
        workerShard: idx,
        workerCount: workerCount,
      });
      try {
        const accepted = await postJson(worker.url + "/worker/start", {
          runId: this.runId,
          workerId: worker.id,
          startAt: startAt,
          config: workerConfig,
        }, 30000, { "X-Worker-Token": WORKER_SHARED_TOKEN });
        worker.status = "running";
        worker.accepted = accepted;
        return true;
      } catch (e) {
        // worker 忙（"worker 正在运行"）或不可用 → 记错，不抛（否则 Promise.all reject → run 抛错 → running 不复位 → UI 挂死）
        worker.status = "error";
        worker.error = "启动失败: " + e.message;
        return false;
      }
    }));

    // 必须全部 worker 就绪才继续；否则干净中止（停掉已启动的），返回带错误的终止报告，绝不挂死 UI。
    const acceptedCount = startResults.filter(Boolean).length;
    if (acceptedCount < this._workerJob.workers.length) {
      await Promise.all(this._workerJob.workers.map(async (worker) => {
        if (worker.status === "running") {
          try { await postJson(worker.url + "/worker/stop", { runId: this.runId }, 10000, { "X-Worker-Token": WORKER_SHARED_TOKEN }); } catch (e) {}
        }
      }));
      this.endTime = Date.now();
      this.running = false;
      this.stopRequested = false;
      const workerErrors = this._workerJob.workers.filter(function(w) { return w.error; }).map(function(w) { return { worker: w.id, url: w.url, error: w.error }; });
      const note = "部分 Worker 忙或不可用（就绪 " + acceptedCount + "/" + this._workerJob.workers.length + "）。多 Worker 分摊一次只能跑一个，请等上一个分摊测试结束、或先点停止后重试。";
      const errReport = {
        runId: this.runId,
        startedAt: startedAt ? new Date(startedAt).toISOString() : null,
        endedAt: new Date(this.endTime).toISOString(),
        testMode: "多 Worker 分摊未启动",
        config: sanitizeConfig(config),
        distributed: { enabled: true, workerCount: this._workerJob.workers.length, accepted: acceptedCount, workerErrors: workerErrors },
        summary: {
          duration: "0s", concurrency: config.concurrency, targetRpm: config.targetRpm || 0,
          actualRpm: 0, equivalentRpm: 0, peakInflight: 0, totalSent: 0, totalDone: 0,
          success: 0, fail: 0, rateLimited: 0, successRate: "0%", qps: "0",
          cacheHitRate: "N/A", cacheHitDisplay: "N/A", cacheObserved: false,
          cacheCreateTokens: 0, cacheReadTokens: 0, conversationsDone: 0, conversationsFailed: 0,
        },
        latency: { avg: 0, min: 0, max: 0, p50: 0, p90: 0, p95: 0, p99: 0 },
        imageCaseStats: {}, deliveryHint: null, authenticity: null, perTurnCache: [],
        models: [], modelRuns: [], errorSummary: [], errorSamples: [], errors: [],
        startupError: note,
      };
      console.error("[多Worker] 启动未就绪，已中止：" + note);
      try { this.reportPath = saveReportToDisk(errReport); errReport.reportPath = this.reportPath; } catch (e) {}
      this.lastReport = errReport;
      this._workerJob = null;
      return errReport;
    }

    const timeoutMs = Number(config.timeout || 0) || 600000;
    const deadline = startAt + (Number(config.durationSeconds || 0) * 1000) + timeoutMs + 60000;
    const selfRunId = String(this.runId);
    while (this.running && !this.stopRequested) {
      await new Promise(function(resolve) { setTimeout(resolve, 2000); });
      await Promise.all(this._workerJob.workers.map(async (worker) => {
        try {
          const snap = await postJson(worker.url + "/worker/snapshot", { runId: this.runId }, 15000, { "X-Worker-Token": WORKER_SHARED_TOKEN });
          worker.snapshot = snap;
          worker.status = snap.status || worker.status;
        } catch (e) {
          worker.error = e.message;
        }
      }));
      // ⚠️ 完成判定必须校验 runId 匹配 + 已过启动时刻：否则会把 worker「上一次旧 run 残留的 done」误判为本次完成，
      // 在开跑瞬间就提前退出 → 合并出 0 数据报告（ftds 事故根因）。
      const allDone = Date.now() > startAt && this._workerJob.workers.every(function(worker) {
        return worker.snapshot && worker.snapshot.status === "done" && String(worker.snapshot.runId) === selfRunId;
      });
      if (allDone) break;
      if (Date.now() > deadline) break;
    }

    if (this.stopRequested) {
      await Promise.all(this._workerJob.workers.map(async (worker) => {
        try { await postJson(worker.url + "/worker/stop", { runId: this.runId }, 15000, { "X-Worker-Token": WORKER_SHARED_TOKEN }); } catch (e) {}
      }));
    }

    const reports = [];
    await Promise.all(this._workerJob.workers.map(async (worker) => {
      try {
        const report = await postJson(worker.url + "/worker/report", { runId: this.runId }, 30000, { "X-Worker-Token": WORKER_SHARED_TOKEN });
        report.worker = { id: worker.id, url: worker.url };
        worker.report = report;
        reports.push(report);
      } catch (e) {
        worker.error = e.message;
      }
    }));

    this.endTime = Date.now();
    this.running = false;
    this.stopRequested = false;
    const report = mergeWorkerReports(config, reports, startedAt, this.endTime, this.runId);
    report.distributed.workerErrors = this._workerJob.workers.filter(function(worker) { return worker.error; }).map(function(worker) {
      return { worker: worker.id, url: worker.url, error: worker.error };
    });
    try {
      this.reportPath = saveReportToDisk(report);
      report.reportPath = this.reportPath;
    } catch (e) {
      report.reportSaveError = e.message;
      console.error("[多Worker报告保存失败]", e.message);
    }
    this.lastReport = report;
    return report;
  }

  async run(config) {
    this.reset();
    this.config = config;
    this._workerMeta = (WORKER_MODE && config && config.workerRunId)
      ? {
          id: String(config.workerId || workerId || "worker"),
          runId: String(config.workerRunId),
        }
      : null;
    this.runId = (this._workerMeta && this._workerMeta.runId)
      ? this._workerMeta.runId
      : ("stress-" + timestampForFile(new Date()) + "-" + Math.random().toString(36).slice(2, 6));
    this.running = true;
    this.stopRequested = false;
    // 开始前预检测：若本次会走 /v1/messages(缓存/连续对话) 且模型是 Claude 风格，
    // 先用 1 个不计入报告的探测请求判明该渠道认不认 anthropic-beta 头；不认则提前登记去头，
    // 让正式负载从第一条起就不带该头 → 第一次点击也不会整批吃 400。
    await this._preflightBetaProbe(config);
    this.startTime = Date.now();

    const { baseUrl, apiKey, concurrency, durationSeconds, models, roundsPerSession, mode, maxTokens } = config;
    const isBurst = mode === "burst";
    const rounds = roundsPerSession || 6;
    const maxTok = maxTokens || (isBurst ? 20 : 150);

    if (!WORKER_MODE && this._shouldUseWorkers(config)) {
      return await this.runDistributed(config);
    }

    // 多模型：默认顺序排队单独跑（runSequentialModels）；
    // 但 RPM 开环 + 多模型混合（rpmMultiModelMode==="mixed"）时放行，落进 rpmOpenLoop，
    // 由其内置的 models[序号 % 模型数] 轮流分配，一次连续跑、出一份带各模型明细的合并报告。
    const wantsMixedRpm = mode === "rpm" && config.rpmMultiModelMode === "mixed";
    if ((models || []).length > 1 && mode !== "image" && !wantsMixedRpm) {
      return await this.runSequentialModels(config);
    }

    if (mode === "authenticity") {
      await this.runAuthenticityAudit(config);
      this.endTime = Date.now();
      this.running = false;
      this.stopRequested = false;
      let report = this.generateReport();
      try {
        this.reportPath = saveReportToDisk(report);
        report.reportPath = this.reportPath;
      } catch (e) {
        report.reportSaveError = e.message;
        console.error("[真实性报告保存失败]", e.message);
      }
      this.lastReport = report;
      return this.lastReport;
    }

    // RPM 开环模式（含图片生成的 RPM 子模式：mode==="image" 且 imageMode==="rpm"）
    if (mode === "rpm" || (mode === "image" && config.imageMode === "rpm")) {
      await this.rpmOpenLoop(config);
      this.endTime = Date.now();
      this.running = false;
      this.stopRequested = false;
      let report = this.generateReport();
      report = await this._attachAuthenticityAddon(report);
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
      this._rpmControllers = new Set();
      const promises = [];
      for (let w = 0; w < concurrency; w++) {
        const identity = makeIdentity(w);
        const model = models[w % models.length];
        const imageCase = this._nextImageCase(config);
        promises.push(this.fireImageGeneration(baseUrl, apiKey, model, imageCase, config.timeout, identity));
      }
      console.log("[压测] 图片生成 一次性 " + concurrency + " 个并发请求");
      await Promise.all(promises);
      this._rpmControllers = null;
      this.endTime = Date.now();
      this.running = false;
      this.stopRequested = false;
      let report = this.generateReport();
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
      let report = this.generateReport();
      report = await this._attachAuthenticityAddon(report);
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
        const baseSid = model.slice(0, 12) + "-s" + s + "-" + Math.random().toString(36).slice(2, 5);
        const sid = scopeSessionIdForRun(baseSid, this.runId);
        const identity = scopeIdentityForRun(makeIdentity(topicIdx), this.runId, sid);
        sessions.push({
          model,
          sessionId: sid,
          identity: identity,
          system: topic.system + " [SessionID: " + sid + "]",
          turns: topic.turns.slice(0, rounds),
          topic: topic.topic,
          cacheBreak: "CB-" + sid,
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
    // (b) 到点：不再从队列取新 session，但让正在进行的 session 做满全部轮数，不 abort。
    // 只设标志，不动 this.running，也不 abort 在途请求 —— 每个请求自身有 timeout 兜底。
    // 代价：总时长可能超过设定时长（等存量会话各自做满全部轮）。手动 /api/stop 仍可强停。
    const stopTimer = setTimeout(() => {
      this._stopNewSessions = true;
    }, durationMs);

    await Promise.all(workers);
    clearTimeout(stopTimer);

    this.endTime = Date.now();
    this.running = false;
    this.stopRequested = false;

    let report = this.generateReport();
    report = await this._attachAuthenticityAddon(report);
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

  async runSequentialModels(config) {
    const models = Array.isArray(config.models) ? config.models.slice() : [];
    const reports = [];
    const overallStart = Date.now();
    this._sequenceReports = [];
    this._sequenceProgress = {
      enabled: true,
      totalModels: models.length,
      completedModels: 0,
      currentModel: models[0] || null,
      strategy: "sequential",
    };

    for (let i = 0; i < models.length; i++) {
      if (!this.running || this.stopRequested) break;
      const model = models[i];
      const child = new StressTestEngine();
      this._activeChildEngine = child;
      const childConfig = Object.assign({}, config, { models: [model], authenticityAddon: false });

      console.log("[压测] 多模型顺序模式 " + (i + 1) + "/" + models.length + " → " + model + "，使用完整负载单独测试");
      const report = await child.run(childConfig);
      if (report) {
        report.sequenceOrder = i + 1;
        reports.push(report);
      }
      this._sequenceReports = reports.slice();
      this._sequenceProgress = {
        enabled: true,
        totalModels: models.length,
        completedModels: reports.length,
        currentModel: models[i + 1] || null,
        strategy: "sequential",
      };
      if (this.stopRequested) break;
    }
    this._activeChildEngine = null;

    this.endTime = Date.now();
    this.running = false;
    this.stopRequested = false;

    let report = aggregateSequentialReports(config, reports, overallStart, this.endTime, this.runId);
    report = await this._attachAuthenticityAddon(report);
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
    const rpmCacheRealistic = !!rpmCache && config.rpmCacheTrafficMode !== "legacy";
    const rpmCacheNewUserRatio = Math.max(0, Math.min(100, config.rpmCacheNewUserRatio != null ? Number(config.rpmCacheNewUserRatio) : RPM_CACHE_DEFAULT_NEW_USER_RATIO));
    const isImage = config.mode === "image";
    // 背压：在途上限。>0 时，同时在跑的请求到此上限就暂停发射，等有返回再继续 —— 保护渠道不被堆爆。
    // =0（默认）为纯开环，不限在途（旧行为）。
    const maxInflight = Math.max(0, Number(config.maxInflight) || 0);
    // 多 Worker 分摊时防撞车：每个 worker 的用户/身份序号落在独立 lane（shard 偏移、步进 workerCount），
    // 否则 4 worker 都从 0 起 → 造出相同 sessionId/user_id/cacheBreak 互相串缓存。单机时 shard=0/count=1 → 旧行为。
    const workerShard = Math.max(0, Number(config.workerShard) || 0);
    const workerCount = Math.max(1, Number(config.workerCount) || 1);

    let launched = 0;
    const inflightPromises = new Set();
    // 记录所有在途请求的 AbortController，硬停时立即中止
    this._rpmControllers = new Set();

    // 缓存模式：维护用户池。pendingUsers 是「已准备好、等着发下一轮」的用户队列。
    // 每个节拍取队首用户发一轮；该轮返回后若还有下一轮，把用户重新入队；做满轮数或失败则退休。
    // 队列空了就造一个新用户。这样发射单位 = 单轮请求 → targetRpm 就是真实请求/分。
    const self = this;
    const pendingUsers = [];
    const returningUsers = [];
    let userSeq = workerShard;
    function makeNewUser() {
      const seq = userSeq;
      const model = models[seq % models.length];
      const baseIdentity = makeIdentity(seq);
      const baseSid = "rpmuser-" + seq + "-" + baseIdentity.clientId;
      const sid = scopeSessionIdForRun(baseSid, self.runId);
      const identity = scopeIdentityForRun(baseIdentity, self.runId, sid);
      userSeq += workerCount;
      const topic = CONVERSATION_TOPICS[seq % CONVERSATION_TOPICS.length] || CONVERSATION_TOPICS[0];
      const sessionTurns = rpmCacheRealistic
        ? sampleSessionTurns(config.rpmCacheSessionLengthPreset, config.rpmCacheMaxRounds || rounds)
        : rounds;
      return {
        model: model,
        sessionId: sid,
        identity: identity,
        system: (topic.system || "You are a helpful assistant. Be concise.") + " [SessionID: " + sid + "]",
        turns: (topic.turns || CONVERSATION_TOPICS[0].turns).slice(0, sessionTurns),
        msgs: [],
        turnNum: 0,
        cacheBreak: "CB-" + sid,
        nextEligibleAt: 0,
        hadFailure: false,
      };
    }

    function takeReadyReturningUser(now) {
      let bestIdx = -1;
      let bestAt = Infinity;
      for (let i = 0; i < returningUsers.length; i++) {
        const eligibleAt = Number(returningUsers[i] && returningUsers[i].nextEligibleAt) || 0;
        if (eligibleAt > now) continue;
        if (eligibleAt < bestAt) {
          bestAt = eligibleAt;
          bestIdx = i;
        }
      }
      if (bestIdx < 0) return null;
      return returningUsers.splice(bestIdx, 1)[0] || null;
    }

    // 发射一个单元（缓存模式=单轮请求；其它=单请求/单图）——不阻塞发射节拍
    function fireOne() {
      launched++;
      self.arrivals = launched;   // 缓存模式下 = 真实请求数（每节拍一轮）

      let p;
      if (isImage) {
        const identity = makeIdentity(launched);
        const model = models[launched % models.length];
        const imageCase = self._nextImageCase(config);
        p = self.fireImageGeneration(baseUrl, apiKey, model, imageCase, timeout, identity);
      } else if (rpmCache) {
        let user = null;
        if (rpmCacheRealistic) {
          const readyReturningUser = takeReadyReturningUser(Date.now());
          const shouldUseNewUser = !readyReturningUser || (Math.random() * 100 < rpmCacheNewUserRatio);
          user = shouldUseNewUser ? makeNewUser() : readyReturningUser;
          if (!user) user = readyReturningUser || makeNewUser();
          if (readyReturningUser && shouldUseNewUser) returningUsers.unshift(readyReturningUser);
        } else {
          // legacy：取一个待发用户（队空则造新用户）
          user = pendingUsers.shift() || makeNewUser();
        }
        p = self.fireCachedTurn(user, baseUrl, apiKey, timeout, maxTokens || 150)
          .then(function(hasNext) {
            // realistic：同一用户等待一段回访时间后再回来，避免“打完立刻回队列”的伪流量。
            if (hasNext && self.running) {
              if (rpmCacheRealistic) {
                user.nextEligibleAt = Date.now() + sampleReturnDelayMs(config.rpmCacheReturnIntervalPreset);
                returningUsers.push(user);
              } else {
                pendingUsers.push(user);
              }
            } else if (user._agent) { try { user._agent.destroy(); } catch (e) {} user._agent = null; }
          });
      } else {
        const identity = makeIdentity(launched * workerCount + workerShard);   // 防撞车：普通文字身份也按 shard 落独立 lane
        const model = models[launched % models.length];
        const q = burstQuestions[Math.floor(Math.random() * burstQuestions.length)];
        p = self.fireOneOpenLoop(baseUrl, apiKey, model, q, maxTok, timeout, identity);
      }
      inflightPromises.add(p);
      p.finally(function() { inflightPromises.delete(p); });
    }

    // 绝对时间锚点发射：第 n 个单元在 startTime + n*intervalMs 发射
    // 不被会话启动开销拖累，无累积漂移 → 速率精准稳定维持
    let fireIdx = 0;
    let launchReachedDeadline = false;
    while (this.running) {
      const nextFireAt = this.startTime + fireIdx * intervalMs;
      if (nextFireAt >= deadline) { launchReachedDeadline = true; break; }          // 60 秒后不再发新单元
      const wait = nextFireAt - Date.now();
      if (wait > 0) {
        await new Promise(function(r) { setTimeout(r, wait); });
        if (!this.running) break;
      }
      // 背压门：在途到上限就等，不发射 —— 保护渠道，避免一次性堆爆。
      // 等待期间不推进 fireIdx，渠道消化得快就接近目标 RPM，消化不动则实际 RPM 自然降为可持续速率。
      if (maxInflight > 0) {
        while (this.inflight >= maxInflight && this.running && Date.now() < deadline) {
          await new Promise(function(r) { setTimeout(r, 50); });
        }
        if (!this.running) break;
        if (Date.now() >= deadline) { launchReachedDeadline = true; break; }
      }
      // 若已落后（系统卡顿），补发追平节拍，保证维持目标 RPM
      fireOne();
      fireIdx++;
    }
    // 发射阶段结束时间（用于精准计算达成速率，不被收尾时间稀释）
    this.launchEndTime = Date.now();
    this.launchCompletedNaturally = launchReachedDeadline && !this.stopRequested;

    // 收尾（drain）：不再发射新请求，但等所有已发出的在途请求自然跑完，
    // 不主动 abort —— 让每个请求都拿到 success/fail 结果，保证 总数 = 成功 + 失败 闭合。
    // 默认只在对端返回/断开时结束；只有手动停止时，才强制中止在途请求。
    // 注意：drain 期间保持 this.running = true，否则请求内部的流式循环会提前 destroy。
    //
    // ⚠️ 兜底总宽限：timeout=0（图片默认不主动超时）时，若个别连接被上游挂死（TCP 开着但永不返回），
    // 纯 while(inflight>0) 会永远等下去 → 整个测试卡死。这里给 drain 一个总上限：
    // timeout>0 → timeout+5s；timeout=0 → 图片给 180s、文字给 35s（远超正常 P99，不误杀正常慢请求）。
    // 超过宽限仍在途的判定为挂死，abort 掉让它们各记一次 timeout 失败，数字依旧闭合。
    const graceMs = timeout > 0 ? timeout + 5000 : (isImage ? 180000 : 35000);
    const drainDeadline = Date.now() + graceMs;
    while (inflightPromises.size > 0 && this.running && !this.stopRequested) {
      if (Date.now() >= drainDeadline) {
        console.log("[压测] drain 超过宽限 " + Math.round(graceMs / 1000) + "s，强制中止挂死的 " + inflightPromises.size + " 个在途请求");
        // 仍保持 running=true 再 abort：让被中止的请求落进各自 catch 记一次 timeout 失败，
        // 保证 总数 = 成功 + 失败 闭合（若先置 running=false 会被当作"主动中止"不计失败 → 数字凭空少）。
        for (const ctrl of this._rpmControllers) {
          try { ctrl.abort(); } catch (e) {}
        }
        // 给被 abort 的请求最多 3s 落地结算，再退出
        await Promise.race([
          Promise.allSettled([...inflightPromises]),
          new Promise(function(r) { setTimeout(r, 3000); }),
        ]);
        break;
      }
      await new Promise(function(r) { setTimeout(r, 100); });
    }
    // 手动停止时，强制中止仍在途的请求
    if (this.stopRequested) {
      for (const ctrl of this._rpmControllers) {
        try { ctrl.abort(); } catch (e) {}
      }
    }
    const wasRunning = this.running;
    this.running = false;
    // 手动停止时，被 abort 的请求可能不会立即 reject（fetch 已开始传输 body）。
    // 给 allSettled 加 2s 硬上限竞速，避免卡到单请求 timeout 才结束 → 前端"停止中"久不消失。
    await Promise.race([
      Promise.allSettled([...inflightPromises]),
      new Promise(function(r) { setTimeout(r, 2000); }),
    ]);
    this.running = wasRunning;   // 恢复（外层 run 会再设 false）
    this._rpmControllers = null;
    // 收尾：销毁池中残留用户的 keep-alive 连接，避免 socket 泄漏。
    // pendingUsers(legacy 池) + returningUsers(realistic 主池) 都要清——
    // realistic 模式等待回访的用户结束时拿不到 .then 退休，其 _agent 不清就漏 socket。
    for (const u of pendingUsers.concat(returningUsers)) {
      if (u && u._agent) { try { u._agent.destroy(); } catch (e) {} u._agent = null; }
    }
  }

  // 发送缓存对话中的「单一轮次」（RPM 缓存模式按请求节拍发射用）
  // user 是一个跨轮持续的状态对象：{ model, sessionId, identity, system, turns, msgs, turnNum, cacheBreak }
  // 每次调用发 user.turns[user.turnNum] 这一轮，成功则把 assistant 回复 push 进 user.msgs，turnNum++
  // 返回 true=本轮成功且还有下一轮，false=失败或已是最后一轮（用户应退休）
  async fireCachedTurn(user, baseUrl, apiKey, timeout, maxTok) {
    if (isOpenAIStyleModel(user.model)) {
      return await this.fireOpenAICachedTurn(user, baseUrl, apiKey, timeout, maxTok);
    }

    this.inflight++;
    if (this.inflight > this.peakInflight) this.peakInflight = this.inflight;
    try {
      const userMsg = user.turns[user.turnNum];
      if (userMsg === undefined) return false;
      const turnNum = user.turnNum + 1;   // 1-based 给报告用
      user.msgs.push({ role: "user", content: userMsg });
      const start = Date.now();
      this.totalSent++;

      const cacheHeaders = this._buildAnthropicCacheHeaders(baseUrl, user.model, apiKey, {
        "User-Agent": user.identity.ua,
        "X-Client-Id": user.identity.clientId,
        "X-Claude-Code-Session-Id": makeDeterministicUuid(user.sessionId),
      });

      // ctrl/t 提升到 try 外：内层 catch 要引用 ctrl，若用 const 声明在 try 内则 catch 里 ctrl 越界 → ReferenceError 崩进程
      let ctrl = null, t = null;
      try {
        const scale = (this.config && this.config.contextScale) || DEFAULT_CONTEXT_SCALE;
        const cachePad = "CACHE_PADDING_" + user.cacheBreak + "\n\n" + buildCachePad(scale, hashStr(user.cacheBreak));
        const body = JSON.stringify({
          model: user.model,
          system: [
            // 单一缓存块：system 指令 + pad 合并，只打一个 cache_control 断点（~2040 token，稳超 1024 门槛）。
            // 旧版拆两块、第一块(指令)仅 ~30 token < 1024，会让该断点被忽略、甚至整个请求不缓存 → creation 长期为 0。
            { type: "text", text: user.system + "\n\n" + cachePad, cache_control: { type: "ephemeral" } }
          ],
          messages: user.msgs,
          max_tokens: maxTok,
          metadata: { user_id: user.identity.userId },   // 粘性路由
          stream: true,
        });

        ({ ctrl, timer: t } = this._makeAbortTools(timeout));
        if (this._rpmControllers) this._rpmControllers.add(ctrl);
        if (!user._agent) user._agent = makeSessionAgent(baseUrl);   // 该用户固定一条连接，多轮复用 → 同后端 → 命中
        const postResult = await postAnthropicMessages(baseUrl, body, cacheHeaders, ctrl, null, user._agent);
        const res = postResult.res;
        if (postResult.betaIncompatible) this._rememberBetaHeaderBypass(baseUrl, user.model, apiKey);

        if (res.statusCode >= 400) {
          const errText = postResult.preloadedErrorText != null ? postResult.preloadedErrorText : await readResponseText(res);
          if (t) clearTimeout(t);
          if (this._rpmControllers) this._rpmControllers.delete(ctrl);
          let errData; try { errData = JSON.parse(errText); } catch (e) { errData = null; }
          const errMsg = (errData && errData.error && errData.error.message) || "HTTP " + res.statusCode;
          this.fail++;
          if (res.statusCode === 429) this.rateLimited++;
          this.totalDone++;
          this.errors.push({ model: user.model, sessionId: user.sessionId, turn: turnNum, error: errMsg, status: res.statusCode, time: Date.now() });
          this._recordErrorSample(Object.assign({
            model: user.model, sessionId: user.sessionId, turn: turnNum,
            error: errMsg, status: res.statusCode, rawBody: errText, time: Date.now(),
          }, summarizeNodeHeaders(res)));
          this._ensureModelStat(user.model);
          return this._continueUserAfterFailedTurn(user);
        }

        let ttfb = 0;
        let fullContent = "";
        const usage = {};
        let buffer = "";
        const self2 = this;
        res.setEncoding("utf8");
        await new Promise(function(resolve, reject) {
          res.on("data", function(chunk) {
            if (ttfb === 0) ttfb = Date.now() - start;
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
                Object.assign(usage, evt.message.usage);
              } else if (evt.type === "content_block_delta" && evt.delta && evt.delta.text) {
                fullContent += evt.delta.text;
              } else if (evt.type === "message_delta" && evt.usage) {
                Object.assign(usage, evt.usage);
              }
            }
          });
          res.on("end", resolve);
          res.on("error", reject);
        });
        if (t) clearTimeout(t);
        if (this._rpmControllers) this._rpmControllers.delete(ctrl);
        if (ttfb === 0) ttfb = Date.now() - start;

      this.totalDone++;
      if (fullContent.length > 0) {
        this._recordDeliveryMeta(buildDeliveryMetaFromNodeRes(res, ttfb, Date.now() - start));
        this.handleSuccess({ model: user.model, sessionId: user.sessionId }, turnNum, start, ttfb, fullContent, usage);
        user.msgs.push({ role: "assistant", content: fullContent });
          user.turnNum++;
          // 最后一轮做完 → 整段对话成功
          if (user.turnNum >= user.turns.length) {
            if (user.hadFailure) this.conversationsFailed++;
            else this.conversationsDone++;
            return false;
          }
          return true;   // 还有下一轮
        } else {
          this.fail++;
          this.errors.push({ model: user.model, sessionId: user.sessionId, turn: turnNum, error: "空响应", status: 200, time: Date.now() });
          this._ensureModelStat(user.model);
          return this._continueUserAfterFailedTurn(user);
        }
      } catch (e) {
        if (!this.running || this.stopRequested) { return false; }
        this.fail++; this.totalDone++;
        this.allLatencies.push(Date.now() - start);
        this.errors.push({ model: user.model, sessionId: user.sessionId, turn: turnNum, error: describeAbortError(e, ctrl, this.running, this.stopRequested), time: Date.now() });
        this._ensureModelStat(user.model);
        return this._continueUserAfterFailedTurn(user);
      }
    } finally {
      this.inflight--;
    }
  }

  async fireOpenAICachedTurn(user, baseUrl, apiKey, timeout, maxTok) {
    this.inflight++;
    if (this.inflight > this.peakInflight) this.peakInflight = this.inflight;
    try {
      const userMsg = user.turns[user.turnNum];
      if (userMsg === undefined) return false;
      const turnNum = user.turnNum + 1;
      const start = Date.now();
      this.totalSent++;

      if (!user.openaiCachePrefix) {
        const scale = (this.config && this.config.contextScale) || DEFAULT_CONTEXT_SCALE;
        user.openaiCachePrefix = "CACHE_PADDING_" + user.cacheBreak + "\n\n" + buildCachePad(scale, hashStr(user.cacheBreak));
      }

      user.msgs.push({ role: "user", content: userMsg });
      const messages = [
        { role: "system", content: user.system + "\n\n" + user.openaiCachePrefix }
      ].concat(user.msgs);
      const chatBody = JSON.stringify({
        model: user.model,
        messages: messages,
        max_tokens: maxTok,
        stream: true,
        stream_options: { include_usage: true },
        user: user.identity.userId,
      });
      const responsesBody = JSON.stringify({
        model: user.model,
        instructions: user.system + "\n\n" + user.openaiCachePrefix,
        input: buildOpenAIResponsesInput(user.msgs),
        max_output_tokens: maxTok,
        stream: true,
        user: user.identity.userId,
      });
      const headers = {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json",
        "User-Agent": user.identity.ua,
        "X-Client-Id": user.identity.clientId,
      };

      let ctrl = null, t = null;   // 提升到 try 外，避免内层 catch 引用 ctrl 越界 → ReferenceError 崩进程
      try {
        ({ ctrl, timer: t } = this._makeAbortTools(timeout));
        if (this._rpmControllers) this._rpmControllers.add(ctrl);
        let usedResponsesApi = false;
        let res = null;
        let errText = "";
        let errStatus = 0;
        if (this._shouldSkipOpenAIResponses(baseUrl, user.model)) {
          // 已知该渠道无 /v1/responses，直接走 chat，不再重探
          res = await fetch(openAIChatEndpoint(baseUrl), {
            method: "POST", headers: headers, body: chatBody, signal: ctrl.signal,
          });
        } else {
          const responseAttempt = await postOpenAIResponsesWithFallback(baseUrl, responsesBody, headers, ctrl);
          if (responseAttempt.res) {
            res = responseAttempt.res;
            usedResponsesApi = true;
          } else if (responseAttempt.canFallbackToChat) {
            this._rememberOpenAIResponsesUnsupported(baseUrl, user.model);
            res = await fetch(openAIChatEndpoint(baseUrl), {
              method: "POST", headers: headers, body: chatBody, signal: ctrl.signal,
            });
          } else {
            errText = responseAttempt.errorText || "";
            errStatus = responseAttempt.status || 0;
          }
        }
        if (t) clearTimeout(t);
        if (this._rpmControllers) this._rpmControllers.delete(ctrl);
        const ttfb = Date.now() - start;

        if (!res || !res.ok) {
          if (res && !errText) {
            errStatus = res.status;
            errText = await res.text().catch(() => "");
          }
          let errData; try { errData = JSON.parse(errText); } catch (e) { errData = null; }
          const errMsg = (errData && errData.error && errData.error.message) || "HTTP " + (errStatus || (res && res.status) || 0);
          this.fail++;
          if ((errStatus || (res && res.status)) === 429) this.rateLimited++;
          this.totalDone++;
          this.errors.push({ model: user.model, sessionId: user.sessionId, turn: turnNum, error: errMsg, status: errStatus || (res && res.status), time: Date.now() });
          this._ensureModelStat(user.model);
          return this._continueUserAfterFailedTurn(user);
        }

        let buffer = await readFetchBodyText(res, () => this.running);
        let parsed = usedResponsesApi ? parseOpenAIResponsesBodyText(buffer) : parseOpenAIChatBodyText(buffer);
        let fullContent = parsed.fullContent;
        let usage = parsed.usage || {};
        if (usedResponsesApi && fullContent.length === 0) {
          res = await fetch(openAIChatEndpoint(baseUrl), {
            method: "POST", headers: headers, body: chatBody, signal: ctrl.signal,
          });
          if (!res.ok) {
            errStatus = res.status;
            errText = await res.text().catch(() => "");
          } else {
            usedResponsesApi = false;
            this._rememberOpenAIResponsesUnsupported(baseUrl, user.model);
            buffer = await readFetchBodyText(res, () => this.running);
            parsed = parseOpenAIChatBodyText(buffer);
            fullContent = parsed.fullContent;
            usage = parsed.usage || {};
          }
        }
        if (res && !res.ok) {
          let errData; try { errData = JSON.parse(errText); } catch (e) { errData = null; }
          const errMsg = (errData && errData.error && errData.error.message) || "HTTP " + (errStatus || res.status);
          this.fail++;
          if ((errStatus || res.status) === 429) this.rateLimited++;
          this.totalDone++;
          this.errors.push({ model: user.model, sessionId: user.sessionId, turn: turnNum, error: errMsg, status: errStatus || res.status, time: Date.now() });
          this._ensureModelStat(user.model);
          return this._continueUserAfterFailedTurn(user);
        }

        this.totalDone++;
        if (fullContent.length > 0) {
          this._recordDeliveryMeta(buildDeliveryMetaFromFetch(res, ttfb, Date.now() - start));
          this.handleSuccess({ model: user.model, sessionId: user.sessionId }, turnNum, start, ttfb, fullContent, usage);
          user.msgs.push({ role: "assistant", content: fullContent });
          user.turnNum++;
          if (user.turnNum >= user.turns.length) {
            if (user.hadFailure) this.conversationsFailed++;
            else this.conversationsDone++;
            return false;
          }
          return true;
        }

        this.fail++;
        this.errors.push({ model: user.model, sessionId: user.sessionId, turn: turnNum, error: "空响应", status: 200, time: Date.now() });
        this._ensureModelStat(user.model);
        return this._continueUserAfterFailedTurn(user);
      } catch (e) {
        if (!this.running || this.stopRequested) { return false; }
        this.fail++; this.totalDone++;
        this.allLatencies.push(Date.now() - start);
        this.errors.push({ model: user.model, sessionId: user.sessionId, turn: turnNum, error: describeAbortError(e, ctrl, this.running, this.stopRequested), time: Date.now() });
        this._ensureModelStat(user.model);
        return this._continueUserAfterFailedTurn(user);
      }
    } finally {
      this.inflight--;
    }
  }

  async runOpenAIConversationSession(session, baseUrl, apiKey, timeout, maxTok) {
    const scale = (this.config && this.config.contextScale) || DEFAULT_CONTEXT_SCALE;
    const cacheBreak = "CB-" + session.sessionId;
    const cachePrefix = "CACHE_PADDING_" + cacheBreak + "\n\n" + buildCachePad(scale, hashStr(cacheBreak));
    const msgs = [];
    let sessionOk = true;

    for (const userMsg of (session.turns || [])) {
      if (!this.running) break;
      const turnNum = msgs.filter(function(m) { return m.role === "user"; }).length + 1;
      msgs.push({ role: "user", content: userMsg });
      const start = Date.now();
      this.totalSent++;

      const messages = [
        { role: "system", content: session.system + "\n\n" + cachePrefix }
      ].concat(msgs);
      const chatBody = JSON.stringify({
        model: session.model,
        messages: messages,
        max_tokens: maxTok,
        stream: true,
        stream_options: { include_usage: true },
        user: (session.identity && session.identity.userId) || session.sessionId,
      });
      const responsesBody = JSON.stringify({
        model: session.model,
        instructions: session.system + "\n\n" + cachePrefix,
        input: buildOpenAIResponsesInput(msgs),
        max_output_tokens: maxTok,
        stream: true,
        user: (session.identity && session.identity.userId) || session.sessionId,
      });
      const headers = {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json",
        "User-Agent": (session.identity && session.identity.ua) || "stress-test/1.0",
        "X-Client-Id": (session.identity && session.identity.clientId) || session.sessionId,
      };

      let ctrl = null, t = null;   // 提升到 try 外，避免内层 catch 引用 ctrl 越界 → ReferenceError 崩进程
      try {
        ({ ctrl, timer: t } = this._makeAbortTools(timeout));
        session._currentController = ctrl;
        session._currentTimer = t;
        let usedResponsesApi = false;
        let res = null;
        let errText = "";
        let errStatus = 0;
        if (this._shouldSkipOpenAIResponses(baseUrl, session.model)) {
          // 已知该渠道无 /v1/responses，直接走 chat，不再重探
          res = await fetch(openAIChatEndpoint(baseUrl), {
            method: "POST", headers: headers, body: chatBody, signal: ctrl.signal,
          });
        } else {
          const responseAttempt = await postOpenAIResponsesWithFallback(baseUrl, responsesBody, headers, ctrl);
          if (responseAttempt.res) {
            res = responseAttempt.res;
            usedResponsesApi = true;
          } else if (responseAttempt.canFallbackToChat) {
            this._rememberOpenAIResponsesUnsupported(baseUrl, session.model);
            res = await fetch(openAIChatEndpoint(baseUrl), {
              method: "POST", headers: headers, body: chatBody, signal: ctrl.signal,
            });
          } else {
            errText = responseAttempt.errorText || "";
            errStatus = responseAttempt.status || 0;
          }
        }
        if (t) clearTimeout(t);
        session._currentController = null;
        session._currentTimer = null;
        const ttfb = Date.now() - start;

        if (!res || !res.ok) {
          if (res && !errText) {
            errStatus = res.status;
            errText = await res.text().catch(() => "");
          }
          let errData; try { errData = JSON.parse(errText); } catch (e) { errData = null; }
          const errMsg = (errData && errData.error && errData.error.message) || "HTTP " + (errStatus || (res && res.status) || 0);
          this.fail++;
          if ((errStatus || (res && res.status)) === 429) this.rateLimited++;
          this.totalDone++;
          this.errors.push({ model: session.model, sessionId: session.sessionId, turn: turnNum, error: errMsg, status: errStatus || (res && res.status), time: Date.now() });
          this._ensureModelStat(session.model);
          sessionOk = false;
          continue;
        }

        let buffer = await readFetchBodyText(res, () => this.running);
        let parsed = usedResponsesApi ? parseOpenAIResponsesBodyText(buffer) : parseOpenAIChatBodyText(buffer);
        let fullContent = parsed.fullContent;
        let usage = parsed.usage || {};
        if (usedResponsesApi && fullContent.length === 0) {
          res = await fetch(openAIChatEndpoint(baseUrl), {
            method: "POST", headers: headers, body: chatBody, signal: ctrl.signal,
          });
          if (!res.ok) {
            errStatus = res.status;
            errText = await res.text().catch(() => "");
          } else {
            usedResponsesApi = false;
            this._rememberOpenAIResponsesUnsupported(baseUrl, session.model);
            buffer = await readFetchBodyText(res, () => this.running);
            parsed = parseOpenAIChatBodyText(buffer);
            fullContent = parsed.fullContent;
            usage = parsed.usage || {};
          }
        }
        if (res && !res.ok) {
          let errData; try { errData = JSON.parse(errText); } catch (e) { errData = null; }
          const errMsg = (errData && errData.error && errData.error.message) || "HTTP " + (errStatus || res.status);
          this.fail++;
          if ((errStatus || res.status) === 429) this.rateLimited++;
          this.totalDone++;
          this.errors.push({ model: session.model, sessionId: session.sessionId, turn: turnNum, error: errMsg, status: errStatus || res.status, time: Date.now() });
          this._ensureModelStat(session.model);
          sessionOk = false;
          continue;
        }

        this.totalDone++;
        if (fullContent.length > 0) {
          this._recordDeliveryMeta(buildDeliveryMetaFromFetch(res, ttfb, Date.now() - start));
          this.handleSuccess(session, turnNum, start, ttfb, fullContent, usage);
          msgs.push({ role: "assistant", content: fullContent });
        } else {
          this.fail++;
          this.errors.push({ model: session.model, sessionId: session.sessionId, turn: turnNum, error: "空响应", status: 200, time: Date.now() });
          this._ensureModelStat(session.model);
          sessionOk = false;
          continue;
        }
      } catch (e) {
        if (!this.running || this.stopRequested) { sessionOk = false; break; }
        this.fail++;
        this.totalDone++;
        this.allLatencies.push(Date.now() - start);
        this.errors.push({ model: session.model, sessionId: session.sessionId, turn: turnNum, error: describeAbortError(e, ctrl, this.running, this.stopRequested), time: Date.now() });
        this._ensureModelStat(session.model);
        sessionOk = false;
        continue;
      }
    }

    if (sessionOk) this.conversationsDone++;
    else this.conversationsFailed++;
  }

  // 一段完整的多轮缓存对话（用于 RPM 缓存模式的每个到达用户）
  // 串行做 N 轮，用 inflight 计数体现"这个用户占着一个并发槽"
  async runCachedConversation(session, baseUrl, apiKey, timeout, maxTok) {
    this.inflight++;
    if (this.inflight > this.peakInflight) this.peakInflight = this.inflight;
    let sessionOk = true;
    try {
      const cacheBreak = session.cacheBreak || ("CB-" + session.sessionId);
      const cacheHeaders = this._buildAnthropicCacheHeaders(baseUrl, session.model, apiKey, {
        "User-Agent": session.identity.ua,
        "X-Client-Id": session.identity.clientId,
        "X-Claude-Code-Session-Id": makeDeterministicUuid(session.sessionId),
      });
      const msgs = [];
      let turnNum = 0;

      for (const userMsg of (session.turns || [])) {
        if (!this.running) break;
        turnNum++;
        msgs.push({ role: "user", content: userMsg });
        const start = Date.now();
        this.totalSent++;

        let ctrl = null, t = null;   // 提升到 try 外，避免内层 catch 引用 ctrl 越界 → ReferenceError 崩进程
        try {
          const scale = (this.config && this.config.contextScale) || DEFAULT_CONTEXT_SCALE;
          const cachePad = "CACHE_PADDING_" + cacheBreak + "\n\n" + buildCachePad(scale, hashStr(cacheBreak));
          const body = JSON.stringify({
            model: session.model,
            system: [
              // 单一缓存块（见 fireCachedTurn 说明）：避免第一块 < 1024 门槛导致整请求不缓存
              { type: "text", text: session.system + "\n\n" + cachePad, cache_control: { type: "ephemeral" } }
            ],
            messages: msgs,
            max_tokens: maxTok,
            metadata: { user_id: session.identity.userId },   // 粘性路由：同会话固定真实风格 user_id → 命中缓存
            stream: true,                       // 流式：SSE
          });

          ({ ctrl, timer: t } = this._makeAbortTools(timeout));
          session._currentController = ctrl;
          if (this._rpmControllers) this._rpmControllers.add(ctrl);
          if (!session._agent) session._agent = makeSessionAgent(baseUrl);   // 该会话固定一条连接，多轮复用 → 同后端 → 命中
          const postResult = await postAnthropicMessages(baseUrl, body, cacheHeaders, ctrl, function(req) {
            session._currentReq = req;
          }, session._agent);
          const res = postResult.res;
          if (postResult.betaIncompatible) this._rememberBetaHeaderBypass(baseUrl, session.model, apiKey);

          // 错误状态：读完 body 报错
          if (res.statusCode >= 400) {
            const errText = postResult.preloadedErrorText != null ? postResult.preloadedErrorText : await readResponseText(res);
            if (t) clearTimeout(t);
            session._currentController = null; session._currentReq = null;
            if (this._rpmControllers) this._rpmControllers.delete(ctrl);
            let errData; try { errData = JSON.parse(errText); } catch (e) { errData = null; }
            const errMsg = (errData && errData.error && errData.error.message) || "HTTP " + res.statusCode;
            this.fail++;
            if (res.statusCode === 429) this.rateLimited++;
            this.totalDone++;
            this.errors.push({ model: session.model, sessionId: session.sessionId, turn: turnNum, error: errMsg, status: res.statusCode, time: Date.now() });
            this._recordErrorSample(Object.assign({
              model: session.model, sessionId: session.sessionId, turn: turnNum,
              error: errMsg, status: res.statusCode, rawBody: errText, time: Date.now(),
            }, summarizeNodeHeaders(res)));
            this._ensureModelStat(session.model);
            sessionOk = false;
            continue;
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
          if (t) clearTimeout(t);
          session._currentController = null; session._currentReq = null;
          if (this._rpmControllers) this._rpmControllers.delete(ctrl);
          if (ttfb === 0) ttfb = Date.now() - start;

          this.totalDone++;
          if (fullContent.length > 0) {
            this._recordDeliveryMeta(buildDeliveryMetaFromNodeRes(res, ttfb, Date.now() - start));
            this.handleSuccess(session, turnNum, start, ttfb, fullContent, usage);
            msgs.push({ role: "assistant", content: fullContent });
          } else {
            this.fail++;
            this.errors.push({ model: session.model, sessionId: session.sessionId, turn: turnNum, error: "空响应", status: 200, time: Date.now() });
            this._ensureModelStat(session.model);
            sessionOk = false;
            continue;
          }
        } catch (e) {
          if (!this.running || this.stopRequested) { sessionOk = false; break; }
          this.fail++; this.totalDone++;
          this.allLatencies.push(Date.now() - start);
          this.errors.push({ model: session.model, sessionId: session.sessionId, turn: turnNum, error: describeAbortError(e, ctrl, this.running, this.stopRequested), time: Date.now() });
          this._ensureModelStat(session.model);
          sessionOk = false;
          continue;
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
      this.modelStats[model] = { success: 0, fail: 1, latencies: [], ttfbList: [], cacheHits: 0, totalPromptTokens: 0, totalCompletionTokens: 0, turnLatencies: {}, cacheCreateTokens: 0, cacheReadTokens: 0 };
    } else {
      this.modelStats[model].fail++;
    }
  }

  _continueUserAfterFailedTurn(user) {
    if (user.msgs && user.msgs.length > 0) user.msgs.pop();
    user.turnNum++;
    user.hadFailure = true;
    if (user.turnNum >= user.turns.length) {
      this.conversationsFailed++;
      return false;
    }
    return this.running && !this.stopRequested;
  }

  _makeAbortTools(timeout) {
    const ctrl = new AbortController();
    let timer = null;
    if (timeout > 0) timer = setTimeout(() => abortWithReason(ctrl, "本地超时取消"), timeout);
    return { ctrl, timer };
  }

  // 开始前 beta 头预检测：仅当本次会用 /v1/messages(缓存/连续对话) + Claude 风格模型时执行。
  // 用 1 个最小请求(不计入 totalSent/success/fail/报告)探出渠道认不认 anthropic-beta 头；
  // 不认则登记全局去头记忆，使正式负载第一条起就不带该头。探测任何异常都吞掉，绝不影响测试。
  async _preflightBetaProbe(config) {
    try {
      const baseUrl = config && config.baseUrl;
      const apiKey = config && config.apiKey;
      if (!baseUrl || !apiKey) return;
      const usesMessages = !!config.rpmCache || config.mode === "conversation";
      if (!usesMessages) return;
      const models = [...new Set((Array.isArray(config.models) ? config.models : [])
        .filter(function(m) { return isClaudeLikeModel(m); }))]
        .filter((m) => !this._shouldBypassBetaHeader(baseUrl, m, apiKey));   // 已知的不必再探
      // 并行探测各模型，总耗时 = 最慢一个(≤5s)，不随模型数累加 → 多模型也不会卡开头
      await Promise.all(models.map(async (model) => {
        try {
          const headers = makeAnthropicCacheHeaders(apiKey, {});
          const body = JSON.stringify({ model: model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] });
          const { ctrl, timer } = this._makeAbortTools(5000);
          const postResult = await postAnthropicMessages(baseUrl, body, headers, ctrl);
          if (timer) clearTimeout(timer);
          if (postResult.betaIncompatible) this._rememberBetaHeaderBypass(baseUrl, model, apiKey);
          try { if (postResult.res) postResult.res.destroy(); } catch (e) {}   // 释放连接，不读 body
        } catch (e) { /* 单个模型探测失败不影响其它模型与测试 */ }
      }));
    } catch (e) { /* 预检测整体异常也不影响测试 */ }
  }

  _recordDeliveryMeta(meta) {
    if (!meta) return;
    if (!this._deliveryMetaSamples) this._deliveryMetaSamples = [];
    if (this._deliveryMetaSamples.length >= 20) return;
    this._deliveryMetaSamples.push(meta);
  }

  _recordErrorSample(sample) {
    if (!sample) return;
    const raw = String(sample.rawBody || "");
    const key = makeErrorSampleKey(sample.status, raw || sample.error);
    if (!this._errorSampleMap) this._errorSampleMap = {};
    if (!this.errorSamples) this.errorSamples = [];
    const existing = this._errorSampleMap[key];
    if (existing) {
      existing.count++;
      return;
    }
    if (this.errorSamples.length >= 50) return;
    const item = Object.assign({}, sample, {
      count: 1,
      rawBody: previewText(raw, 4000),
    });
    this.errorSamples.push(item);
    this._errorSampleMap[key] = item;
  }

  async _fireAuditChat(baseUrl, apiKey, model, messages, maxTok, timeout, identity) {
    const start = Date.now();
    const { ctrl, timer: t } = this._makeAbortTools(timeout);
    const runOpenAICompatAudit = async () => {
      const headers = {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json",
        "User-Agent": identity.ua,
        "X-Client-Id": identity.clientId,
      };
      const body = JSON.stringify({
        model: model,
        messages: messages,
        max_tokens: maxTok,
        stream: true,
        stream_options: { include_usage: true },
        temperature: 0,
      });
      const res = await fetch(openAIChatEndpoint(baseUrl), {
        method: "POST",
        headers: headers,
        body: body,
        signal: ctrl.signal,
      });
      const ttfb = Date.now() - start;
      if (!res.ok) {
        const errText = await res.text().catch(function() { return ""; });
        let errData; try { errData = JSON.parse(errText); } catch (e) { errData = null; }
        const errMsg = (errData && errData.error && errData.error.message) || ("HTTP " + res.status);
        return {
          ok: false,
          status: res.status,
          error: errMsg,
          latency: Date.now() - start,
          ttfb: ttfb,
          usage: {},
          content: "",
          requestId: pickHeader(res.headers, ["x-request-id", "request-id", "openai-request-id", "x-amzn-requestid"]),
        };
      }
      const raw = await readFetchBodyText(res, () => this.running);
      const parsed = parseOpenAIChatBodyText(raw);
      return {
        ok: parsed.fullContent.length > 0,
        status: 200,
        error: parsed.fullContent.length > 0 ? "" : "空响应",
        latency: Date.now() - start,
        ttfb: ttfb,
        usage: parsed.usage || {},
        content: parsed.fullContent,
        requestId: pickHeader(res.headers, ["x-request-id", "request-id", "openai-request-id", "x-amzn-requestid"]),
      };
    };

    if (isClaudeLikeModel(model)) {
      const headers = makeAnthropicHeaders(apiKey, {
        "User-Agent": identity.ua,
        "X-Client-Id": identity.clientId,
      });
      const body = JSON.stringify({
        model: model,
        messages: messages,
        max_tokens: maxTok,
        stream: true,
      });
      try {
        const postResult = await postAnthropicMessages(baseUrl, body, headers, ctrl);
        const res = postResult.res;
        const ttfb = Date.now() - start;
        if (!res || res.statusCode >= 400) {
          const errText = postResult.preloadedErrorText != null ? postResult.preloadedErrorText : await readResponseText(res);
          if (shouldFallbackClaudeAuditToOpenAI(res && res.statusCode, errText)) {
            return await runOpenAICompatAudit();
          }
          if (t) clearTimeout(t);
          let errData; try { errData = JSON.parse(errText); } catch (e) { errData = null; }
          const errMsg = (errData && errData.error && errData.error.message) || ("HTTP " + (res && res.statusCode ? res.statusCode : 500));
          return {
            ok: false,
            status: res && res.statusCode ? res.statusCode : 500,
            error: errMsg,
            latency: Date.now() - start,
            ttfb: ttfb,
            usage: {},
            content: "",
            requestId: summarizeNodeHeaders(res).requestId || "",
          };
        }
        if (t) clearTimeout(t);
        let firstByteAt = 0;
        let fullContent = "";
        const usage = {};
        let buffer = "";
        await new Promise(function(resolve, reject) {
          res.setEncoding("utf8");
          res.on("data", function(chunk) {
            if (!firstByteAt) firstByteAt = Date.now();
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
                Object.assign(usage, evt.message.usage);
              } else if (evt.type === "content_block_delta" && evt.delta && evt.delta.text) {
                fullContent += evt.delta.text;
              } else if (evt.type === "message_delta" && evt.usage) {
                Object.assign(usage, evt.usage);
              }
            }
          });
          res.on("end", resolve);
          res.on("error", reject);
        });
        return {
          ok: fullContent.length > 0,
          status: 200,
          error: fullContent.length > 0 ? "" : "空响应",
          latency: Date.now() - start,
          ttfb: firstByteAt ? (firstByteAt - start) : ttfb,
          usage: usage,
          content: fullContent,
          requestId: summarizeNodeHeaders(res).requestId || "",
        };
      } catch (e) {
        if (t) clearTimeout(t);
        return {
          ok: false,
          status: 0,
          error: describeAbortError(e, ctrl, this.running, this.stopRequested),
          latency: Date.now() - start,
          ttfb: 0,
          usage: {},
          content: "",
          requestId: "",
        };
      }
    }
    try {
      if (t) clearTimeout(t);
      return await runOpenAICompatAudit();
    } catch (e) {
      if (t) clearTimeout(t);
      return {
        ok: false,
          status: 0,
          error: describeAbortError(e, ctrl, this.running, this.stopRequested),
          latency: Date.now() - start,
          ttfb: 0,
          usage: {},
        content: "",
        requestId: "",
      };
    }
  }

  async _runMultiTurnAuditProbe(baseUrl, apiKey, model, timeout, identity) {
    const secret = "MT-" + String(seededInt(hashStr(model + "|" + identity.clientId)) % 900000).padStart(6, "0");
    const messages = [
      { role: "user", content: "我们做一个三轮审计。请记住：最终暗号是 " + secret + "；规则A=如果我提到蓝队，最终输出 BLUE；规则B=如果我提到回滚，最终输出 ROLLBACK。现在只回复 READY。" },
    ];
    const first = await this._fireAuditChat(baseUrl, apiKey, model, messages, 80, timeout, identity);
    if (first.ok) messages.push({ role: "assistant", content: first.content });
    messages.push({ role: "user", content: "蓝队已经完成演练，但暂时不要输出最终答案。只回复 ACK。" });
    const second = await this._fireAuditChat(baseUrl, apiKey, model, messages, 80, timeout, identity);
    if (second.ok) messages.push({ role: "assistant", content: second.content });
    messages.push({ role: "user", content: "现在触发回滚。严格只输出 JSON：{\"secret\":\"...\",\"team\":\"...\",\"action\":\"...\"}" });
    const third = await this._fireAuditChat(baseUrl, apiKey, model, messages, 160, timeout, identity);
    const latency = [first, second, third].reduce(function(sum, r) { return sum + (Number(r.latency) || 0); }, 0);
    const ttfb = [first, second, third].reduce(function(sum, r) { return sum + (Number(r.ttfb) || 0); }, 0);
    const ok = first.ok && second.ok && third.ok;
    let passed = false;
    let note = "";
    if (ok) {
      try {
        const data = JSON.parse(String(third.content || "").trim());
        passed = data && data.secret === secret && data.team === "BLUE" && data.action === "ROLLBACK";
        note = passed ? "多轮规则记忆与组合输出正确" : "多轮最终 JSON 字段不匹配，期望 " + secret + "/BLUE/ROLLBACK";
      } catch (e) {
        note = "多轮最终轮未输出严格 JSON";
      }
    } else {
      note = (first.error || second.error || third.error || "多轮请求失败");
    }
    const usage = extractUsageMetrics(third.usage || {});
    return {
      id: "multi-turn-memory",
      category: "多轮一致性",
      evidenceLevel: "A",
      ok: ok,
      passed: passed,
      score: passed ? 1 : 0,
      note: note,
      latency: latency,
      ttfb: ttfb,
      status: third.status || second.status || first.status,
      outputTokens: usage.completionTokens,
      promptTokens: usage.promptTokens,
      cacheReadTokens: usage.cacheReadTokens,
      requestId: third.requestId || second.requestId || first.requestId,
      responsePreview: String(third.content || "").slice(0, 180),
      requestCount: 3,
    };
  }

  async runAuthenticityAudit(config) {
    const baseUrl = config.baseUrl;
    const apiKey = config.apiKey;
    const model = (config.models && config.models[0]) || "";
    const timeout = config.timeout || 0;
    const seed = seededInt(hashStr(baseUrl + "|" + model + "|" + Date.now()));
    const probes = buildAuthenticityProbeSuite(seed);
    const samples = [];
    const identity = makeIdentity(0);
    const maxTok = Math.max(50, config.maxTokens || 220);

    console.log("[真实性检测] " + model + " 探针 " + probes.length + " 个 + 重复采样");

    for (let i = 0; i < probes.length; i++) {
      if (!this.running) break;
      const probe = probes[i];
      this.totalSent++;
      this.inflight++;
      if (this.inflight > this.peakInflight) this.peakInflight = this.inflight;
      try {
        const r = await this._fireAuditChat(baseUrl, apiKey, model, [{ role: "user", content: probe.prompt }], maxTok, timeout, makeIdentity(i));
        this.totalDone++;
        const metrics = extractUsageMetrics(r.usage);
        const verdict = r.ok ? probe.judge(r.content) : { passed: false, score: 0, note: r.error || "请求失败" };
        if (r.ok) {
          this.success++;
          this.latencies.push(r.latency);
          this.allLatencies.push(r.latency);
          this.handleSuccess({ model: model, sessionId: "auth-" + probe.id }, 1, Date.now() - r.latency, r.ttfb, r.content, r.usage);
        } else {
          this.fail++;
          if (r.status === 429) this.rateLimited++;
          this.allLatencies.push(r.latency);
          this.errors.push({ model: model, turn: 1, probe: probe.id, error: r.error, status: r.status, time: Date.now() });
          this._ensureModelStat(model);
        }
        samples.push({
          id: probe.id,
          category: probe.category,
          evidenceLevel: probe.evidenceLevel,
          ok: r.ok,
          passed: verdict.passed,
          score: verdict.score,
          note: verdict.note,
          latency: r.latency,
          ttfb: r.ttfb,
          status: r.status,
          outputTokens: metrics.completionTokens,
          promptTokens: metrics.promptTokens,
          cacheReadTokens: metrics.cacheReadTokens,
          requestId: r.requestId,
          responsePreview: String(r.content || "").slice(0, 180),
        });
      } catch (e) {
        if (!this.running || this.stopRequested) { this.totalDone++; break; }
        this.fail++;
        this.totalDone++;
        this.errors.push({ model: model, probe: probe.id, error: describeAbortError(e, null, this.running, this.stopRequested), time: Date.now() });
        this._ensureModelStat(model);
        samples.push({ id: probe.id, category: probe.category, evidenceLevel: probe.evidenceLevel, ok: false, passed: false, score: 0, note: e.message });
      } finally {
        this.inflight--;
      }
    }

    if (this.running) {
      this.totalSent += 3;
      this.inflight++;
      if (this.inflight > this.peakInflight) this.peakInflight = this.inflight;
      try {
        const multi = await this._runMultiTurnAuditProbe(baseUrl, apiKey, model, timeout, makeIdentity(800));
        this.totalDone += 3;
        if (multi.ok) {
          this.success += 3;
          this.latencies.push(multi.latency);
          this.allLatencies.push(multi.latency);
          this.handleSuccess({ model: model, sessionId: "auth-" + multi.id }, 1, Date.now() - multi.latency, multi.ttfb, multi.responsePreview, {
            prompt_tokens: multi.promptTokens,
            completion_tokens: multi.outputTokens,
            total_tokens: (Number(multi.promptTokens) || 0) + (Number(multi.outputTokens) || 0),
          });
          if (this.modelStats[model]) {
            this.modelStats[model].success += 2;
            this.modelStats[model].latencies.push(multi.latency, multi.latency);
          }
        } else {
          this.fail += 3;
          this.allLatencies.push(multi.latency || 0);
          this.errors.push({ model: model, turn: 3, probe: multi.id, error: multi.note || "多轮请求失败", status: multi.status, time: Date.now() });
          this._ensureModelStat(model);
          this._ensureModelStat(model);
          this._ensureModelStat(model);
        }
        samples.push(multi);
      } catch (e) {
        if (!this.running || this.stopRequested) { this.totalDone++; }
        else {
          this.fail += 3;
          this.totalDone += 3;
          this.errors.push({ model: model, probe: "multi-turn-memory", error: describeAbortError(e, null, this.running, this.stopRequested), time: Date.now() });
          this._ensureModelStat(model);
          samples.push({ id: "multi-turn-memory", category: "多轮一致性", evidenceLevel: "A", ok: false, passed: false, score: 0, note: e.message, requestCount: 3 });
        }
      } finally {
        this.inflight--;
      }
    }

    const repeatPrompt = "只输出最终整数，不要解释。计算：(47 * 29) + 13 = ?";
    const repeatExpected = 1376;
    const repeatCount = Math.max(6, Math.min(30, Number(config.authRepeatCount) || 10));
    const repeatSamples = [];
    for (let i = 0; i < repeatCount; i++) {
      if (!this.running) break;
      this.totalSent++;
      this.inflight++;
      if (this.inflight > this.peakInflight) this.peakInflight = this.inflight;
      try {
        const r = await this._fireAuditChat(baseUrl, apiKey, model, [{ role: "user", content: repeatPrompt }], 80, timeout, makeIdentity(100 + i));
        this.totalDone++;
        const metrics = extractUsageMetrics(r.usage);
        const got = String(r.content || "").match(/-?\d+/);
        const correct = r.ok && !!got && Number(got[0]) === repeatExpected;
        if (r.ok) {
          this.success++;
          this.latencies.push(r.latency);
          this.allLatencies.push(r.latency);
          this.handleSuccess({ model: model, sessionId: "auth-repeat" }, 1, Date.now() - r.latency, r.ttfb, r.content, r.usage);
        } else {
          this.fail++;
          if (r.status === 429) this.rateLimited++;
          this.allLatencies.push(r.latency);
          this.errors.push({ model: model, turn: 1, probe: "repeat", error: r.error, status: r.status, time: Date.now() });
          this._ensureModelStat(model);
        }
        repeatSamples.push({
          ok: r.ok,
          correct: correct,
          latency: r.latency,
          ttfb: r.ttfb,
          status: r.status,
          outputTokens: metrics.completionTokens,
          promptTokens: metrics.promptTokens,
          cacheReadTokens: metrics.cacheReadTokens,
          preview: String(r.content || "").slice(0, 80),
        });
      } catch (e) {
        if (!this.running || this.stopRequested) { this.totalDone++; break; }
        this.fail++;
        this.totalDone++;
        this.errors.push({ model: model, probe: "repeat", error: describeAbortError(e, null, this.running, this.stopRequested), time: Date.now() });
        this._ensureModelStat(model);
        repeatSamples.push({ ok: false, correct: false, error: e.message });
      } finally {
        this.inflight--;
      }
    }

    this.authenticity = this._buildAuthenticitySummary(model, samples, repeatSamples, config);
  }

  _buildAuthenticitySummary(model, samples, repeatSamples, config) {
    const successSamples = samples.filter(function(s) { return s.ok; });
    const scored = samples.filter(function(s) { return typeof s.score === "number"; });
    const capabilityRate = scored.length ? (scored.reduce(function(a, s) { return a + s.score; }, 0) / scored.length) : 0;
    const longProbe = samples.find(function(s) { return s.id === "long-needle"; });
    const professionalProbeIds = {
      "code-debug": true,
      "code-refactor": true,
      "long-multihop": true,
      "multi-turn-memory": true,
    };
    const professionalScored = samples.filter(function(s) { return professionalProbeIds[s.id] && typeof s.score === "number"; });
    const professionalRate = professionalScored.length ? (professionalScored.reduce(function(a, s) { return a + s.score; }, 0) / professionalScored.length) : 0;
    const identityProbe = samples.find(function(s) { return s.id === "identity-leak"; });
    const repeatOk = repeatSamples.filter(function(s) { return s.ok; });
    const repeatCorrect = repeatSamples.filter(function(s) { return s.correct; });
    const outputCv = coefficientOfVariation(repeatOk.map(function(s) { return s.outputTokens; }));
    const latencyCv = coefficientOfVariation(repeatOk.map(function(s) { return s.latency; }));
    const splitRisk = (outputCv > 0.65 || latencyCv > 0.75) ? 1 : (outputCv > 0.35 || latencyCv > 0.45 ? 0.5 : 0);
    const usagePresentRate = repeatOk.length ? (repeatOk.filter(function(s) { return Number(s.promptTokens) > 0 || Number(s.outputTokens) > 0; }).length / repeatOk.length) : 0;
    const requestOkRate = (samples.length + repeatSamples.length) ? ((successSamples.length + repeatOk.length) / (samples.length + repeatSamples.length)) : 0;
    const longScore = longProbe && longProbe.passed ? 1 : 0;
    const identityScore = identityProbe && identityProbe.passed ? 1 : 0;
    const repeatAccuracy = repeatSamples.length ? (repeatCorrect.length / repeatSamples.length) : 0;
    const interfaceScore = usagePresentRate;
    const stabilityScore = 1 - splitRisk;

    const weighted = (
      requestOkRate * 15 +
      capabilityRate * 15 +
      professionalRate * 20 +
      longScore * 20 +
      interfaceScore * 15 +
      stabilityScore * 15 +
      identityScore * 10
    );
    const score = Math.round(weighted * 10) / 10;
    const risks = [];
    if (requestOkRate < 0.9) risks.push({ level: "A", type: "可用性异常", note: "真实性检测请求成功率低于 90%" });
    if (capabilityRate < 0.75) risks.push({ level: "A", type: "能力指纹异常", note: "动态私有题正确率偏低" });
    if (professionalRate < 0.75) risks.push({ level: "A", type: "专业能力异常", note: "代码调试、多轮一致性或长上下文多跳探针通过率偏低" });
    if (!longScore) risks.push({ level: "A", type: "长上下文异常", note: "长上下文找针失败" });
    if (splitRisk >= 1) risks.push({ level: "A", type: "疑似混路由", note: "重复采样 output_tokens 或 latency 分裂明显" });
    else if (splitRisk > 0) risks.push({ level: "B", type: "稳定性波动", note: "重复采样分布波动偏大" });
    if (usagePresentRate < 0.8) risks.push({ level: "B", type: "Usage 不完整", note: "多数响应缺少 token usage，计费审计可信度下降" });
    if (!identityScore) risks.push({ level: "B", type: "身份污染", note: "裸请求疑似泄漏客户端/代理身份" });

    const verdict = score >= 85 ? "高度可信"
      : score >= 70 ? "基本可信"
      : score >= 50 ? "疑似掺水/混路由"
      : score >= 30 ? "高度疑似降级套壳"
      : "基本不可信";
    const confidence = (config && config.officialBaseline) ? "高" : (repeatSamples.length >= 20 ? "中" : "中低");
    return {
      model: model,
      score: score,
      verdict: verdict,
      confidence: confidence,
      note: "黑盒风险评估，非绝对定罪；建议结合官方 baseline、渠道后台账单与 request id 复核。",
      metrics: {
        requestOkRate: Math.round(requestOkRate * 1000) / 10,
        capabilityRate: Math.round(capabilityRate * 1000) / 10,
        professionalRate: Math.round(professionalRate * 1000) / 10,
        longContextPassed: !!longScore,
        identityClean: !!identityScore,
        repeatAccuracy: Math.round(repeatAccuracy * 1000) / 10,
        outputTokenCv: Math.round(outputCv * 1000) / 1000,
        latencyCv: Math.round(latencyCv * 1000) / 1000,
        usagePresentRate: Math.round(usagePresentRate * 1000) / 10,
        repeatSamples: repeatSamples.length,
      },
      risks: risks,
      evidence: samples,
      repeatSummary: {
        count: repeatSamples.length,
        correct: repeatCorrect.length,
        outputTokens: repeatOk.map(function(s) { return s.outputTokens; }),
        latencies: repeatOk.map(function(s) { return s.latency; }),
        medianOutputTokens: median(repeatOk.map(function(s) { return s.outputTokens; })),
        medianLatency: median(repeatOk.map(function(s) { return s.latency; }),
        ),
      },
      scoring: [
        "请求成功率 15",
        "基础能力指纹 15",
        "代码/多轮/多跳专业探针 20",
        "长上下文 20",
        "usage/接口完整性 15",
        "重复采样稳定性 15",
        "裸请求身份污染 10",
      ],
    };
  }

  async fireOneOpenLoop(baseUrl, apiKey, model, q, maxTok, timeout, identity) {
    const start = Date.now();
    this.totalSent++;
    this.inflight++;
    if (this.inflight > this.peakInflight) this.peakInflight = this.inflight;

    const fakeSession = { model: model, sessionId: identity.clientId, identity: identity };

    let ctrl = null, t = null;   // 提升到 try 外，避免 catch 引用 ctrl 越界 → ReferenceError 崩进程
    try {
      // 按档位把短问题包成长上下文（RAG/长对话风格）；seed 用 identity 派生 → 同客户端稳定、跨客户端不同
      const scale = (this.config && this.config.contextScale) || DEFAULT_CONTEXT_SCALE;
      const seed = seededInt(hashStr(identity.clientId));
      const content = buildUserContent(scale, q, seed);
      // 随机参数：真实客户端会带 temperature/top_p/system 等，让请求不再千篇一律
      const rp = buildRandomParams(model, this.config && this.config.randomParams, seed);
      const reqBody = {
        model: model,
        messages: [{ role: "user", content: content }],
        max_tokens: maxTok,
        stream: true,
        stream_options: { include_usage: true },
      };
      if (rp.system) reqBody.messages.unshift({ role: "system", content: rp.system });
      Object.assign(reqBody, rp.extra);
      const body = JSON.stringify(reqBody);
      const headers = {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json",
        "User-Agent": identity.ua,
        "X-Client-Id": identity.clientId,
      };

      ({ ctrl, timer: t } = this._makeAbortTools(timeout));
      if (this._rpmControllers) this._rpmControllers.add(ctrl);
      const res = await fetch(baseUrl + "/v1/chat/completions", {
        method: "POST", headers: headers, body: body, signal: ctrl.signal,
      });
      if (t) clearTimeout(t);
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
          this.modelStats[model] = { success: 0, fail: 1, latencies: [], ttfbList: [], cacheHits: 0, totalPromptTokens: 0, totalCompletionTokens: 0, turnLatencies: {}, cacheCreateTokens: 0, cacheReadTokens: 0 };
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
        this._recordDeliveryMeta(buildDeliveryMetaFromFetch(res, ttfb, Date.now() - start));
        this.handleSuccess(fakeSession, 1, start, ttfb, fullContent, usage);
      } else {
        this.fail++;
        if (!this.modelStats[model]) {
          this.modelStats[model] = { success: 0, fail: 1, latencies: [], ttfbList: [], cacheHits: 0, totalPromptTokens: 0, totalCompletionTokens: 0, turnLatencies: {}, cacheCreateTokens: 0, cacheReadTokens: 0 };
        } else { this.modelStats[model].fail++; }
      }
    } catch (e) {
      if (!this.running || this.stopRequested) { return; }
      this.fail++;
      this.totalDone++;
      this.allLatencies.push(Date.now() - start);
      this.errors.push({ model: model, turn: 1, error: describeAbortError(e, ctrl, this.running, this.stopRequested), time: Date.now() });
      if (!this.modelStats[model]) {
        this.modelStats[model] = { success: 0, fail: 1, latencies: [], ttfbList: [], cacheHits: 0, totalPromptTokens: 0, totalCompletionTokens: 0, turnLatencies: {}, cacheCreateTokens: 0, cacheReadTokens: 0 };
      } else { this.modelStats[model].fail++; }
    } finally {
      this.inflight--;
    }
  }

  // ============================================================
  // nano 生图：取一条「人类化、不重复」的随机提示词
  // 主体 × 场景 × 风格 = 16×12×10 ≈ 1920 种组合，远超单次压测量 → 天然不重复
  // 本轮内用 _usedImagePrompts 去重；万一组合用尽（极端高量）再允许复用
  // ============================================================
  _nextNanoImagePrompt() {
    const pick = function(arr) { return arr[Math.floor(Math.random() * arr.length)]; };
    for (let i = 0; i < 8; i++) {
      const p = pick(NANO_SUBJECTS) + pick(NANO_SCENES) + "，" + pick(NANO_STYLES);
      if (!this._usedImagePrompts.has(p)) {
        this._usedImagePrompts.add(p);
        return p;
      }
    }
    return pick(NANO_SUBJECTS) + pick(NANO_SCENES) + "，" + pick(NANO_STYLES);
  }

  _nextImagePrompt() {
    const pick = function(arr) { return arr[Math.floor(Math.random() * arr.length)]; };
    for (let i = 0; i < 8; i++) {
      const p = pick(IMAGE_PROMPT_TEMPLATES)
        .replace("{subject}", pick(IMAGE_SUBJECTS))
        .replace("{scene}", pick(IMAGE_SCENES))
        .replace("{style}", pick(IMAGE_STYLES))
        .replace("{qualifier}", pick(IMAGE_QUALIFIERS))
        .replace(/[，,]\s*$/, "")
        .replace(/[，,]\s*[，,]/g, "，")
        .trim();
      if (!this._usedImagePrompts.has(p)) {
        this._usedImagePrompts.add(p);
        return p;
      }
    }
    return pick(IMAGE_PROMPT_TEMPLATES)
      .replace("{subject}", pick(IMAGE_SUBJECTS))
      .replace("{scene}", pick(IMAGE_SCENES))
      .replace("{style}", pick(IMAGE_STYLES))
      .replace("{qualifier}", pick(IMAGE_QUALIFIERS))
      .replace(/[，,]\s*$/, "")
      .replace(/[，,]\s*[，,]/g, "，")
      .trim();
  }

  _nextImageEditPrompt() {
    const pick = function(arr) { return arr[Math.floor(Math.random() * arr.length)]; };
    for (let i = 0; i < 8; i++) {
      const p = pick(IMAGE_EDIT_TASKS) + "，参考图编号 REF-" + (1000 + Math.floor(Math.random() * 9000)) + "，" + pick(IMAGE_STYLES);
      if (!this._usedImagePrompts.has(p)) {
        this._usedImagePrompts.add(p);
        return p;
      }
    }
    return pick(IMAGE_EDIT_TASKS) + "，参考图编号 REF-" + Date.now().toString(36) + "，" + pick(IMAGE_STYLES);
  }

  _nextImageCase(config) {
    const cfg = config || this.config || {};
    const workerShard = Math.max(0, Number(cfg.workerShard) || 0);
    const workerCount = Math.max(1, Number(cfg.workerCount) || 1);
    const seq = this._imageCaseSeq++;
    const globalSeq = (seq * workerCount) + workerShard;
    const fixedSize = cfg.imageSize || "1024x1024";
    const size = cfg.imageSizeMode === "fixed" ? fixedSize : IMAGE_MIXED_SIZE_SET[globalSeq % IMAGE_MIXED_SIZE_SET.length];
    const quality = cfg.imageQualityMode === "fixed" ? "low" : IMAGE_MIXED_QUALITY_SET[Math.floor(globalSeq / IMAGE_MIXED_SIZE_SET.length) % IMAGE_MIXED_QUALITY_SET.length];
    const workloadMode = cfg.imageWorkloadMode || "mixed";
    const workload = workloadMode === "text-to-image" || workloadMode === "image-to-image-intent"
      ? workloadMode
      : IMAGE_MIXED_WORKLOAD_SET[Math.floor(globalSeq / (IMAGE_MIXED_SIZE_SET.length * IMAGE_MIXED_QUALITY_SET.length)) % IMAGE_MIXED_WORKLOAD_SET.length];
    const tierHint = quality === "high" ? "高清精修质感" : quality === "medium" ? "标准成片质感" : "快速预览质感";
    const basePrompt = workload === "image-to-image-intent" ? this._nextImageEditPrompt() : this._nextImagePrompt();
    const prompt = basePrompt + "，" + tierHint + "，请求编号 " + globalSeq;
    return {
      id: "imgcase-" + globalSeq,
      sequence: globalSeq,
      workload: workload,
      prompt: prompt,
      size: size,
      quality: quality,
    };
  }

  _recordImageCase(imageCase, ok) {
    if (!imageCase) return;
    const bump = (obj, key) => { obj[key] = (obj[key] || 0) + 1; };
    if (!this.imageCaseStats) this.imageCaseStats = {};
    if (!this.imageCaseStats.workload) this.imageCaseStats.workload = {};
    if (!this.imageCaseStats.size) this.imageCaseStats.size = {};
    if (!this.imageCaseStats.quality) this.imageCaseStats.quality = {};
    if (!this.imageCaseStats.result) this.imageCaseStats.result = {};
    bump(this.imageCaseStats.workload, imageCase.workload || "unknown");
    bump(this.imageCaseStats.size, imageCase.size || "unknown");
    bump(this.imageCaseStats.quality, imageCase.quality || "unknown");
    bump(this.imageCaseStats.result, ok ? "success" : "fail");
  }

  // ============================================================
  // 图片生成单次请求
  // 混合矩阵：文生图 + 图生图意图、不同尺寸、不同 quality 档位轮转。
  // 不存储 base64 图片数据，只判断成功/失败
  // 图生图意图按“只发送测试需求”模拟，不上传真实素材，避免 pod 存储膨胀。
  // ============================================================
  async fireImageGeneration(baseUrl, apiKey, model, imageCase, timeout, identity) {
    const start = Date.now();
    this.totalSent++;
    this.inflight++;
    if (this.inflight > this.peakInflight) this.peakInflight = this.inflight;
    let ctrl = null;
    let abortTimer = null;
    let ctrlTracked = false;

    const fakeSession = { model: model, sessionId: identity.clientId, identity: identity };
    const reqCase = (typeof imageCase === "string")
      ? { prompt: imageCase, size: (this.config && this.config.imageSize) || "1024x1024", quality: "low", workload: "text-to-image" }
      : (imageCase || this._nextImageCase(this.config));
    const prompt = reqCase.prompt || this._nextImagePrompt();
    const imageSize = reqCase.size || "1024x1024";
    const quality = reqCase.quality || "low";
    let caseRecorded = false;
    const markCase = (ok) => {
      if (caseRecorded) return;
      caseRecorded = true;
      this._recordImageCase(reqCase, ok);
    };
    const caseMeta = () => ({
      imageCaseId: reqCase.id || null,
      imageWorkload: reqCase.workload || null,
      imageSize: reqCase.size || null,
      imageQuality: reqCase.quality || null,
    });
    const attachAbortTools = () => {
      const tools = this._makeAbortTools(timeout);
      ctrl = tools.ctrl;
      abortTimer = tools.timer;
      if (this._rpmControllers && ctrl) {
        this._rpmControllers.add(ctrl);
        ctrlTracked = true;
      }
      return ctrl;
    };
    const releaseAbortTools = () => {
      if (abortTimer) {
        clearTimeout(abortTimer);
        abortTimer = null;
      }
      if (ctrlTracked && this._rpmControllers && ctrl) {
        this._rpmControllers.delete(ctrl);
      }
      ctrlTracked = false;
    };

    try {
      // nano banana / gemini 原生图片模型 → 走 Gemini 原生 generateContent 接口
      if (isNanoBananaModel(model)) {
        const nanoPrompt = prompt || this._nextNanoImagePrompt();   // 人类化、不重复
        const geminiSize = imageSize === "3840x2160" ? "4K" : imageSize === "2560x1440" ? "2K" : "1K";
        const body = JSON.stringify({
          contents: [{ parts: [{ text: nanoPrompt }] }],
          generationConfig: {
            responseModalities: ["IMAGE"],
            imageConfig: { imageSize: geminiSize },
          },
        });
        const headers = {
          "Authorization": "Bearer " + apiKey,
          "Content-Type": "application/json",
          "User-Agent": identity.ua,
          "X-Client-Id": identity.clientId,
        };
        attachAbortTools();
        const genUrl = baseUrl + "/v1beta/models/" + encodeURIComponent(model) + ":generateContent";
        const res = await fetch(genUrl, {
          method: "POST", headers: headers, body: body, signal: ctrl.signal,
        });
        releaseAbortTools();
        const ttfb = Date.now() - start;

        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          let errData; try { errData = JSON.parse(errText); } catch (e) { errData = null; }
          const errMsg = (errData && errData.error && errData.error.message) || "HTTP " + res.status;
          this.fail++;
          if (res.status === 429) this.rateLimited++;
          this.totalDone++;
          this.allLatencies.push(Date.now() - start);
          markCase(false);
          this.errors.push(Object.assign({ model: model, turn: 1, error: errMsg, status: res.status, time: Date.now() }, caseMeta()));
          this._ensureModelStat(model);
          return;
        }

        // 只判断有没有图，不保留 base64 数据（省内存，不落盘）
        const json = await res.json().catch(() => null);
        this.totalDone++;
        const parts = (json && json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts) || [];
        const hasImage = parts.some(function(p) {
          return p && p.inlineData && /^image\//.test(p.inlineData.mimeType || "") && p.inlineData.data;
        });
        if (hasImage) {
          markCase(true);
          this._recordDeliveryMeta(buildDeliveryMetaFromFetch(res, ttfb, Date.now() - start));
          this.handleSuccess(fakeSession, 1, start, ttfb, "ok", {});
        } else {
          // 模型只回文本(拒答/安全拦截)→ 记为失败，附文本前 80 字便于排查
          this.fail++;
          this._ensureModelStat(model);
          markCase(false);
          const textPart = parts.find(function(p) { return p && p.text; });
          this.errors.push(Object.assign({ model: model, turn: 1, error: textPart ? ("仅文本无图: " + String(textPart.text).slice(0, 80)) : "空响应", status: 200, time: Date.now() }, caseMeta()));
        }
        return;
      }

      // gpt-image-2 支持 "low"/"medium"/"high"/"auto"
      // dall-e-3 只支持 "standard"/"hd"
      // dall-e-2 不支持 quality 参数
      const isDallE3 = /dall-e-3/i.test(model);
      const isDallE2 = /dall-e-2/i.test(model);
      const imageQuality = isDallE3 ? (quality === "high" ? "hd" : "standard") : undefined;

      const bodyObj = { model, prompt, n: 1, size: imageSize || "1024x1024" };
      if (imageQuality !== undefined) bodyObj.quality = imageQuality;
      const body = JSON.stringify(bodyObj);

      const headers = {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json",
        "User-Agent": identity.ua,
        "X-Client-Id": identity.clientId,
      };

      attachAbortTools();

      const res = await fetch(baseUrl + "/v1/images/generations", {
        method: "POST", headers: headers, body: body, signal: ctrl.signal,
      });
      releaseAbortTools();
      const ttfb = Date.now() - start;

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        let errData; try { errData = JSON.parse(errText); } catch (e) { errData = null; }
        const errMsg = (errData && errData.error && errData.error.message) || "HTTP " + res.status;
        this.fail++;
        if (res.status === 429) this.rateLimited++;
        this.totalDone++;
        this.allLatencies.push(Date.now() - start);
        markCase(false);
        this.errors.push(Object.assign({ model: model, turn: 1, error: errMsg, status: res.status, time: Date.now() }, caseMeta()));
        this._ensureModelStat(model);
        return;
      }

      // 读取响应，仅取 data[0] 是否存在，不保留 b64_json 内容
      const json = await res.json().catch(() => null);
      this.totalDone++;

      if (json && json.data && json.data.length > 0) {
        markCase(true);
        this._recordDeliveryMeta(buildDeliveryMetaFromFetch(res, ttfb, Date.now() - start));
        this.handleSuccess(fakeSession, 1, start, ttfb, "ok", {});
      } else {
        this.fail++;
        this._ensureModelStat(model);
        markCase(false);
        this.errors.push(Object.assign({ model: model, turn: 1, error: "空响应", status: 200, time: Date.now() }, caseMeta()));
      }
    } catch (e) {
      if (!this.running || this.stopRequested) { return; }
      this.fail++;
      this.totalDone++;
      this.allLatencies.push(Date.now() - start);
      markCase(false);
      // fetch failed 的真正原因藏在 e.cause（DNS/拒连/TLS/对端断开），带出来方便排查
      let errMsg = describeAbortError(e, ctrl, this.running, this.stopRequested);
      if (e.cause) {
        const c = e.cause;
        errMsg += " (" + (c.code || c.message || String(c)).toString().slice(0, 60) + ")";
      }
      this.errors.push(Object.assign({ model: model, turn: 1, error: errMsg, time: Date.now() }, caseMeta()));
      this._ensureModelStat(model);
    } finally {
      releaseAbortTools();
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
        // (b) 到点后不再取新会话，但本 worker 上一个会话已做满全部轮次才会走到这里
        if (this._stopNewSessions) break;
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

          const { ctrl, timer: t } = this._makeAbortTools(timeout);
          session._currentController = ctrl;
          session._currentTimer = t;
          const res = await fetch(baseUrl + "/v1/chat/completions", {
            method: "POST", headers: burstHeaders, body, signal: ctrl.signal,
          });
          if (t) clearTimeout(t);
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
              this.modelStats[session.model] = { success: 0, fail: 1, latencies: [], ttfbList: [], cacheHits: 0, totalPromptTokens: 0, totalCompletionTokens: 0, turnLatencies: {}, cacheCreateTokens: 0, cacheReadTokens: 0 };
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
            this._recordDeliveryMeta(buildDeliveryMetaFromFetch(res, ttfb, Date.now() - start));
            this.handleSuccess(session, 1, start, ttfb, fullContent, usage);
          } else {
            this.fail++;
            if (!this.modelStats[session.model]) {
              this.modelStats[session.model] = { success: 0, fail: 1, latencies: [], ttfbList: [], cacheHits: 0, totalPromptTokens: 0, totalCompletionTokens: 0, turnLatencies: {}, cacheCreateTokens: 0, cacheReadTokens: 0 };
            } else { this.modelStats[session.model].fail++; }
          }
        } catch (e) {
          const latency = Date.now() - start;
          // 如果是主动中止，不记录失败
          if (!this.running || this.stopRequested) {
            break;
          }
          this.fail++;
          this.totalDone++;
          this.allLatencies.push(latency);
          if (!this.modelStats[session.model]) {
            this.modelStats[session.model] = { success: 0, fail: 1, latencies: [], ttfbList: [], cacheHits: 0, totalPromptTokens: 0, totalCompletionTokens: 0, turnLatencies: {}, cacheCreateTokens: 0, cacheReadTokens: 0 };
          } else { this.modelStats[session.model].fail++; }
        }
        continue;
      }

      if (isOpenAIStyleModel(session.model)) {
        await this.runOpenAIConversationSession(session, baseUrl, apiKey, timeout, maxTok);
        continue;
      }

      // 连续对话模式（走 Anthropic 原生 Messages API，带 cache_control）
      // 每个 session 用唯一的 cache break marker，确保独立缓存
      var cacheBreak = session.cacheBreak || ("CB-" + session.sessionId);
      // 某些兼容链路不认 anthropic-beta，命中一次后仅对当前 baseUrl+model 自动绕过。
      const cacheHeaders = this._buildAnthropicCacheHeaders(baseUrl, session.model, apiKey, {
        "User-Agent": (session.identity && session.identity.ua) || "stress-test/1.0",
        "X-Client-Id": (session.identity && session.identity.clientId) || session.sessionId,
        "X-Claude-Code-Session-Id": makeDeterministicUuid(session.sessionId || session.cacheBreak || "CB-" + session.sessionId),
      });
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

        let ctrl = null, t = null;   // 提升到 try 外，避免内层 catch 引用 ctrl 越界 → ReferenceError 崩进程
        try {
          // Anthropic 原生 Messages API — 流式 SSE
          // 每个 session 的 cachePad 带唯一后缀，确保独立缓存 epoch
          var scale = (this.config && this.config.contextScale) || DEFAULT_CONTEXT_SCALE;
          var cachePad = "CACHE_PADDING_" + cacheBreak + "\n\n" + buildCachePad(scale, hashStr(cacheBreak));
          const body = JSON.stringify({
            model: session.model,
            system: [
              // 单一缓存块（见 fireCachedTurn 说明）：避免第一块 < 1024 门槛导致整请求不缓存
              { type: "text", text: session.system + "\n\n" + cachePad, cache_control: { type: "ephemeral" } }
            ],
            messages: msgs,
            max_tokens: maxTok,
            metadata: { user_id: (session.identity && session.identity.userId) || session.sessionId },   // 粘性路由：同会话固定真实风格 user_id → 命中缓存
            stream: true,
          });

          // 用原生 http/https 发请求，确保 Content-Length + 复杂 JSON 不被截断
          ({ ctrl, timer: t } = this._makeAbortTools(timeout));
          session._currentController = ctrl;
          session._currentTimer = t;
          if (!session._agent) session._agent = makeSessionAgent(baseUrl);   // 该会话固定一条连接，多轮复用 → 同后端 → 命中
          const postResult = await postAnthropicMessages(baseUrl, body, cacheHeaders, ctrl, null, session._agent);
          const res = postResult.res;
          if (postResult.betaIncompatible) this._rememberBetaHeaderBypass(baseUrl, session.model, apiKey);

          let ttfb = 0;

          if (res.statusCode >= 400) {
            if (!this.running) { sessionOk = false; break; }
            const errText = postResult.preloadedErrorText != null ? postResult.preloadedErrorText : await readResponseText(res);
            if (t) clearTimeout(t);
            session._currentController = null; session._currentTimer = null; session._currentReq = null;
            if (!this.running) { sessionOk = false; break; }
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
            this._recordErrorSample(Object.assign({
              model: session.model, sessionId: session.sessionId, turn: turnNum,
              error: errMsg, status: res.statusCode, rawBody: errText, time: Date.now(),
            }, summarizeNodeHeaders(res)));
            if (!this.modelStats[session.model]) {
              this.modelStats[session.model] = {
                success: 0, fail: 1, latencies: [], cacheHits: 0, ttfbList: [],
                totalPromptTokens: 0, totalCompletionTokens: 0, turnLatencies: {},
                cacheCreateTokens: 0, cacheReadTokens: 0,
              };
            } else {
              this.modelStats[session.model].fail++;
            }
            sessionOk = false;
            break;
          }

          // 流式解析 SSE：message_start 带 cache usage，content_block_delta 带文本，message_delta 带 output tokens
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
                  Object.assign(usage, evt.message.usage);
                } else if (evt.type === "content_block_delta" && evt.delta && evt.delta.text) {
                  fullContent += evt.delta.text;
                } else if (evt.type === "message_delta" && evt.usage) {
                  Object.assign(usage, evt.usage);
                }
              }
            });
            res.on("end", resolve);
            res.on("error", reject);
          });
          if (t) clearTimeout(t);
          session._currentController = null;
          session._currentTimer = null;
          session._currentReq = null;
          if (ttfb === 0) ttfb = Date.now() - start;

          this.totalDone++;

          if (fullContent.length > 0) {
            this._recordDeliveryMeta(buildDeliveryMetaFromNodeRes(res, ttfb, Date.now() - start));
            this.handleSuccess(session, turnNum, start, ttfb, fullContent, usage);
            msgs.push({ role: "assistant", content: fullContent });
          } else {
            const errMsg = "空响应";
            this.fail++;
            this.errors.push({
                  model: session.model, sessionId: session.sessionId,
                  turn: turnNum, error: errMsg, status: 200, time: Date.now(),
                });
                if (!this.modelStats[session.model]) {
                  this.modelStats[session.model] = {
                    success: 0, fail: 1, latencies: [], cacheHits: 0, ttfbList: [],
                    totalPromptTokens: 0, totalCompletionTokens: 0, turnLatencies: {},
                    cacheCreateTokens: 0, cacheReadTokens: 0,
                  };
                } else {
                  this.modelStats[session.model].fail++;
                }
                sessionOk = false;
                break;
              }
        } catch (e) {
          const latency = Date.now() - start;
          if (!this.running || this.stopRequested) {
            sessionOk = false;
            break;
          }
          const errMsg = describeAbortError(e, ctrl, this.running, this.stopRequested);
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
              cacheCreateTokens: 0, cacheReadTokens: 0,
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

    // 覆盖 Anthropic 原生 Messages API、OpenAI 兼容格式，以及部分中转自定义字段。
    // gpt-5.x 这类 OpenAI 风格链路常把缓存命中放在 input_tokens_details.cached_tokens，
    // 如果只看 Anthropic 的 cache_read_input_tokens，会把“上游已命中缓存”误判成 0 命中。
    var cacheRead = Math.max(
      Number(usage.cache_read_input_tokens) || 0,
      Number(usage.cache_read_tokens) || 0,
      Number(usage.cached_input_tokens) || 0
    );
    var ephem5 = (usage.cache_creation && usage.cache_creation.ephemeral_5m_input_tokens) || 0;
    var ephem1h = (usage.cache_creation && usage.cache_creation.ephemeral_1h_input_tokens) || 0;
    var cacheCreate = usage.cache_creation_input_tokens || (ephem5 + ephem1h);
    var promptCachedTokens = Number((usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0);
    var inputCachedTokens = Number((usage.input_tokens_details && usage.input_tokens_details.cached_tokens) || 0);
    var cachedTokens = Math.max(
      promptCachedTokens,
      inputCachedTokens,
      Number(usage.prompt_cache_hit_tokens) || 0
    );

    var wasCacheHit = cacheRead > 0 || cachedTokens > 0;
    var wasCacheWrite = cacheCreate > 0;

    // 累计缓存 token（诊断用）：creation=写入(第1轮)，read=读取(后续轮)。
    // 兼容 OpenAI 风格的 prompt/input_tokens_details.cached_tokens 作为读取量。
    var cacheReadThis = Math.max(cacheRead, cachedTokens, 0);
    this.cacheCreateTokens += cacheCreate;
    this.cacheReadTokens += cacheReadThis;

    // 采样：每个模型保留前 2 条原始 usage（含渠道返回的真实字段名），诊断渠道到底回了什么
    if (!this._rawUsageSample[session.model]) this._rawUsageSample[session.model] = [];
    if (this._rawUsageSample[session.model].length < 2) {
      this._rawUsageSample[session.model].push({ turn: turnNum, usage: usage });
    }

    // 缓存命中只认「渠道真实返回的 cache_read token」。
    // 旧版有一段「延迟猜测」：某轮延迟比第1轮快>30% 就当命中——但这会和真实 token 打架，
    // 制造假阳性（例：cache_read=0 却显示某轮命中），已移除。命中 = wasCacheHit（cache_read>0）。

    // 对于第1轮，cache_write 也算 cache 活动（写入缓存）
    if (turnNum === 1 && wasCacheWrite) {
      // 不算 hit，但要记录到 perTurnCache
    }

    // 命中只认 turn≥2：turn-1 是缓存「写入」(全新唯一前缀)，永远不该算命中。
    // turn-1 若返回 cache_read>0 → 渠道在跨会话串缓存(或 usage 造假)，单独记为污染告警，不计进命中。
    const countedHit = wasCacheHit && turnNum >= 2;
    if (turnNum === 1 && wasCacheHit) this.turn1Contamination = (this.turn1Contamination || 0) + 1;

    this.success++;
    this.latencies.push(latency);
    this.allLatencies.push(latency);
    if (countedHit) this.cacheHits++;

    const turnKey = "turn" + turnNum;
    if (!this.perTurnCache[turnKey]) this.perTurnCache[turnKey] = { total: 0, hits: 0 };
    this.perTurnCache[turnKey].total++;
    if (countedHit) this.perTurnCache[turnKey].hits++;

    if (!this.modelStats[session.model]) {
      this.modelStats[session.model] = {
        success: 0, fail: 0, latencies: [], ttfbList: [], cacheHits: 0,
        totalPromptTokens: 0, totalCompletionTokens: 0, turnLatencies: {},
        cacheCreateTokens: 0, cacheReadTokens: 0, turn1Count: 0,
      };
    }
    const ms = this.modelStats[session.model];
    ms.success++;
    ms.latencies.push(latency);
    ms.ttfbList.push(ttfbs);
    if (countedHit) ms.cacheHits++;   // 同口径：turn-1 不计命中
    if (turnNum === 1) ms.turn1Count = (ms.turn1Count || 0) + 1;
    ms.totalPromptTokens += promptTokens;
    ms.totalCompletionTokens += completionTokens;
    ms.cacheCreateTokens = (ms.cacheCreateTokens || 0) + cacheCreate;
    ms.cacheReadTokens = (ms.cacheReadTokens || 0) + cacheReadThis;
    if (!ms.turnLatencies[turnKey]) ms.turnLatencies[turnKey] = [];
    ms.turnLatencies[turnKey].push(latency);
  }

  getSnapshot() {
    if (this.running && this._workerJob) {
      const totals = {
        totalSent: 0,
        totalDone: 0,
        success: 0,
        fail: 0,
        rateLimited: 0,
        inflight: 0,
        peakInflight: 0,
      };
      const latencies = [];
      this._workerJob.workers.forEach(function(worker) {
        const snap = worker.snapshot || {};
        totals.totalSent += Number(snap.totalSent) || 0;
        totals.totalDone += Number(snap.totalDone) || 0;
        totals.success += Number(snap.success) || 0;
        totals.fail += Number(snap.fail) || 0;
        totals.rateLimited += Number(snap.rateLimited) || 0;
        totals.inflight += Number(snap.inflight) || 0;
        totals.peakInflight += Number(snap.peakInflight) || 0;
        if (snap.latency) {
          ["p50", "p90", "p95", "p99"].forEach(function(k) {
            const v = Number(snap.latency[k]) || 0;
            if (v > 0) latencies.push(v);
          });
        }
      });
      latencies.sort(function(a, b) { return a - b; });
      const effectiveEnd = Date.now();
      const elapsedMs = this.startTime ? Math.max(0, effectiveEnd - this.startTime) : 0;
      const distributedActualRpm = this._workerJob.workers.reduce(function(sum, worker) {
        return sum + (Number(worker && worker.snapshot && worker.snapshot.actualRpm) || 0);
      }, 0);
      return {
        status: "running",
        runId: this.runId,
        startedAt: this.startTime ? new Date(this.startTime).toISOString() : null,
        endedAt: null,
        reportPath: this.reportPath,
        config: sanitizeConfig(this.config),
        elapsed: (elapsedMs / 1000).toFixed(1) + "s",
        elapsedMs,
        totalSent: totals.totalSent,
        totalDone: totals.totalDone,
        success: totals.success,
        fail: totals.fail,
        rateLimited: totals.rateLimited,
        cacheHits: 0,
        qps: elapsedMs > 0 ? (totals.totalDone / (elapsedMs / 1000)).toFixed(2) : "0",
        actualRpm: distributedActualRpm,
        arrivals: totals.totalSent,
        equivalentRpm: 0,
        targetRpm: this.config.targetRpm || 0,
        inflight: totals.inflight,
        peakInflight: totals.peakInflight,
        conversationsDone: 0,
        conversationsFailed: 0,
        errorCount: this._workerJob.workers.filter(function(worker) { return worker.error; }).length,
        latency: {
          avg: 0,
          min: latencies[0] || 0,
          max: latencies[latencies.length - 1] || 0,
          p50: percentile(latencies, 0.50),
          p90: percentile(latencies, 0.90),
          p95: percentile(latencies, 0.95),
          p99: percentile(latencies, 0.99),
        },
        sequence: {
          enabled: true,
          mode: "workers",
          totalModels: this._workerJob.workers.length,
          completedModels: this._workerJob.workers.filter(function(worker) {
            return worker.snapshot && worker.snapshot.status === "done";
          }).length,
          currentModel: (this.config.mode === "image" ? "图片 RPM" : ("文字 RPM" + (this.config.rpmCache ? " 缓存" : "") + ((this.config.models || []).length > 1 ? " 多模型混合" : ""))),
          reportsReady: this._workerJob.workers.filter(function(worker) { return worker.report; }).length,
        },
      };
    }

    if (this.running && this._activeChildEngine) {
      const childSnap = this._activeChildEngine.getSnapshot();
      childSnap.sequence = Object.assign({}, this._sequenceProgress || {}, {
        reportsReady: (this._sequenceReports || []).length,
      });
      childSnap.config = sanitizeConfig(this.config);
      childSnap.runId = this.runId;
      return childSnap;
    }

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

    // 实际达成速率（rpm）= 真实发出的请求数 / 发射阶段时长。涵盖文字 RPM 与图片 RPM 子模式。
    const isRpmMode = (this.config.mode === "rpm") || (this.config.mode === "image" && this.config.imageMode === "rpm");
    // 运行中用真实流逝时间；发射已结束(launchEndTime 存在)时用「实际/设定」较大者兜底，防止早退导致 RPM 爆表。
    const rawLaunchMs = this.startTime ? ((this.launchEndTime || Date.now()) - this.startTime) : 0;
    const configuredMs = (Number(this.config.durationSeconds) || 0) * 1000;
    const launchMs = (isRpmMode && this.launchEndTime)
      ? resolveLaunchWindowMs(rawLaunchMs, configuredMs, this.launchCompletedNaturally)
      : rawLaunchMs;
    const actualRpm = isRpmMode
      ? (launchMs > 0 ? Math.round((this.totalSent / (launchMs / 1000)) * 60) : 0)
      : (elapsedMs > 0 ? Math.round((this.totalSent / (elapsedMs / 1000)) * 60) : 0);
    // 等效 rpm（并发模式）：Little's 法则 并发 ÷ 平均延迟(秒) × 60
    const avgSec = avg / 1000;
    const equivalentRpm = (!isRpmMode && avgSec > 0)
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
      sequence: this._sequenceProgress ? Object.assign({}, this._sequenceProgress, {
        reportsReady: (this._sequenceReports || []).length,
      }) : null,
      multiModelMixed: this.config && this.config.mode === "rpm" && this.config.rpmMultiModelMode === "mixed" && (this.config.models || []).length > 1,
      modelLive: orderedConfiguredModels(this.config, this.modelStats).map(function(m) {
        const s = this.modelStats[m] || {};
        const done = (s.success || 0) + (s.fail || 0);
        return {
          model: m,
          success: s.success || 0,
          fail: s.fail || 0,
          done: done,
          avgLatency: (s.success > 0 && s.latencies && s.latencies.length)
            ? Math.round(s.latencies.reduce(function(a, b) { return a + b; }, 0) / s.latencies.length / 10) / 100
            : 0,
        };
      }, this),
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
      const turnNum = Number(turn.replace("turn", ""));
      if (turnNum <= 1) continue;
      totalCacheOps += data.total;
      totalCacheHits += data.hits;
    }
    const cacheObserved = this.cacheReadTokens > 0 || totalCacheHits > 0;
    const overallCacheRate = totalCacheOps > 0 ? ((totalCacheHits / totalCacheOps) * 100).toFixed(1) : "N/A";
    const cacheHitDisplay = totalCacheOps > 0 ? overallCacheRate : (cacheObserved ? "已检测到缓存读" : "N/A");
    const warmedCacheRate = overallCacheRate;
    const warmedCacheHitDisplay = cacheHitDisplay;

    // 加权命中率(token 口径,跟上游仪表盘同口径)= 命中读到的缓存 token ÷ 全部消耗的 input token。
    // 分母含三块:cache_read(命中) + cache_creation(首次写,没命中) + 普通 input(新算,没命中)——
    // 没命中但烧掉的 token 也老实算进分母,所以这个数反映"真实省了多少",可直接对账上游。
    let totalNewInputTokens = 0;
    for (const m of Object.keys(this.modelStats)) {
      totalNewInputTokens += Number(this.modelStats[m].totalPromptTokens) || 0;
    }
    const weightedDenom = this.cacheReadTokens + this.cacheCreateTokens + totalNewInputTokens;
    const weightedCacheRate = weightedDenom > 0 ? ((this.cacheReadTokens / weightedDenom) * 100).toFixed(1) : "N/A";
    const contamination = this.turn1Contamination || 0;
    // 好/差判定:基于加权命中率;串缓存(turn-1命中)高时加一句"可能含跨会话缓存"的提醒。
    let cacheVerdict;
    if (weightedDenom <= 0 || !cacheObserved) {
      cacheVerdict = "未检测到缓存(create/read 均为 0)";
    } else {
      const r = Number(weightedCacheRate);
      const base = r >= 60 ? "✅ 命中好" : (r >= 30 ? "⚠️ 一般" : "❌ 命中差");
      cacheVerdict = base + "(加权 " + weightedCacheRate + "%)"
        + (contamination > 0 ? ";⚠️含跨会话串缓存 " + contamination + " 次,数字偏乐观" : "");
    }

    const modelReports = [];
    for (const model of orderedConfiguredModels(this.config, this.modelStats)) {
      const s = this.modelStats[model] || {
        success: 0,
        fail: 0,
        latencies: [],
        ttfbList: [],
        cacheHits: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        cacheCreateTokens: 0,
        cacheReadTokens: 0,
        turn1Count: 0,
      };
      const sl = [...s.latencies].sort((a, b) => a - b);
      const modelTotal = s.success + s.fail;
      const modelTurn1 = s.turn1Count || 0;
      const modelCacheDenom = modelTotal - modelTurn1;  // 排除 turn1，与汇总口径一致
      modelReports.push({
        model,
        success: s.success,
        fail: s.fail,
        rate: modelTotal > 0 ? ((s.success / modelTotal) * 100).toFixed(1) : "0.0",
        avgLatency: s.success > 0 ? Math.round(s.latencies.reduce((a, b) => a + b, 0) / s.latencies.length * 100) / 100 : 0,
        avgTtfb: s.ttfbList && s.ttfbList.length > 0 ? Math.round(s.ttfbList.reduce((a, b) => a + b, 0) / s.ttfbList.length * 100) / 100 : 0,
        p50: sl[Math.floor(sl.length * 0.5)] || 0,
        p90: sl[Math.floor(sl.length * 0.9)] || 0,
        p95: sl[Math.floor(sl.length * 0.95)] || 0,
        p99: sl[Math.floor(sl.length * 0.99)] || 0,
        min: sl[0] || 0,
        max: sl[sl.length - 1] || 0,
        latencySamples: sl.slice(0, 10000),
        cacheHits: s.cacheHits,
        avgPromptTokens: s.success > 0 ? Math.round(s.totalPromptTokens / s.success) : 0,
        avgCompletionTokens: s.success > 0 ? Math.round(s.totalCompletionTokens / s.success) : 0,
        cacheCreateTokens: s.cacheCreateTokens || 0,
        cacheReadTokens: s.cacheReadTokens || 0,
        cacheHitRate: modelCacheDenom > 0 ? ((s.cacheHits / modelCacheDenom) * 100).toFixed(1) : "0.0",
        cacheHitDisplay: modelCacheDenom > 0 ? (s.cacheHits / modelCacheDenom * 100).toFixed(1) + "%（请求级，第2轮起）" : "0.0%",
        rawUsageSample: (this._rawUsageSample && this._rawUsageSample[model]) || [],
        turn1Count: modelTurn1,
      });
    }
    modelReports.sort((a, b) => {
      const aDone = (a.success || 0) + (a.fail || 0);
      const bDone = (b.success || 0) + (b.fail || 0);
      if (!aDone && bDone) return 1;
      if (aDone && !bDone) return -1;
      return a.avgLatency - b.avgLatency;
    });

    const errorTypes = {};
    for (const e of this.errors) {
      const key = classifyError(e.error, e.status);
      errorTypes[key] = (errorTypes[key] || 0) + 1;
    }

    const successRate = this.totalDone > 0 ? ((this.success / this.totalDone) * 100).toFixed(1) : "0";

    const avgSec = avg / 1000;
    // RPM 实际达成速率 = 真实发出的请求数 / 发射阶段时长。涵盖文字 RPM 与图片 RPM 子模式。
    const isRpmMode = (this.config.mode === "rpm") || (this.config.mode === "image" && this.config.imageMode === "rpm");
    // 发射窗口分母：取「实际发射时长」与「设定时长」中较大者，避免请求秒失败导致窗口过短、RPM 被放大成天文数字。
    // RPM 发射本就按 durationSeconds 铺开节拍，正常跑完两者相等；异常早退时用设定时长才是真实速率。
    const rawLaunchMs = this.startTime ? ((this.launchEndTime || Date.now()) - this.startTime) : 0;
    const configuredMs = (Number(this.config.durationSeconds) || 0) * 1000;
    const launchMs = (isRpmMode && this.launchEndTime)
      ? resolveLaunchWindowMs(rawLaunchMs, configuredMs, this.launchCompletedNaturally)
      : rawLaunchMs;
    const actualRpm = isRpmMode
      ? (launchMs > 0 ? Math.round((this.totalSent / (launchMs / 1000)) * 60) : 0)
      : (elapsedMs > 0 ? Math.round((this.totalSent / (elapsedMs / 1000)) * 60) : 0);
    const equivalentRpm = (!isRpmMode && avgSec > 0)
      ? Math.round((this.config.concurrency || 0) / avgSec * 60) : 0;
    const modelCount = (this.config.models || []).length;
    const isMixedMulti = this.config.mode === "rpm" && this.config.rpmMultiModelMode === "mixed" && modelCount > 1;
    const modeLabel = (this.config.mode === "rpm" ? "RPM 开环压测"
      : this.config.mode === "conversation" ? "连续对话压测"
      : (this.config.mode === "image" && this.config.imageMode === "rpm") ? "图片生成 RPM 开环压测"
      : this.config.mode === "image" ? "图片生成压测"
      : "独立请求压测") + (isMixedMulti ? "（多模型随机混合 " + modelCount + " 个）" : "");
    const deliveryHint = summarizeDeliveryDiagnosis(this._deliveryMetaSamples);

    const report = {
      runId: this.runId,
      startedAt: this.startTime ? new Date(this.startTime).toISOString() : null,
      endedAt: this.endTime ? new Date(this.endTime).toISOString() : null,
      testMode: modeLabel,
      multiModelMixed: isMixedMulti,
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
        cacheHitDisplay: cacheHitDisplay,
        warmedCacheHitRate: warmedCacheRate,
        warmedCacheHitDisplay: warmedCacheHitDisplay,
        // 加权命中率(token 口径,跟上游仪表盘同口径,看"命中好不好"主要看这个)+ 一句好/差判定
        weightedCacheHitRate: weightedCacheRate,
        cacheVerdict: cacheVerdict,
        cacheObserved: cacheObserved,
        cacheCreateTokens: this.cacheCreateTokens,
        cacheReadTokens: this.cacheReadTokens,
        // 命中可信度信号:
        // warmSamples = 真正能命中的 turn≥2 请求数。<100 时命中率噪声大,仅供参考。
        // turn1Contamination = turn-1(全新前缀)却读到缓存的次数,>0 = 渠道跨会话串缓存,命中率被污染。
        warmSamples: totalCacheOps,
        turn1Contamination: this.turn1Contamination || 0,
        conversationsDone: this.conversationsDone,
        conversationsFailed: this.conversationsFailed,
      },
      latency: { avg, min, max, p50, p90, p95, p99 },
      latencySamples: this.latencies.slice(0, 10000),
      imageCaseStats: this.imageCaseStats || {},
      deliveryHint,
      authenticity: this.authenticity || null,
      perTurnCache,
      models: modelReports,
      errorSummary: Object.entries(errorTypes).sort((a, b) => b[1] - a[1]).slice(0, 10).map(function(e) { return { type: e[0], count: e[1] }; }),
      errorSamples: (this.errorSamples || []).slice(0, 50),
      errors: this.errors.slice(0, 100),
    };
    if (this._workerMeta && this._workerMeta.id && this._workerMeta.runId) {
      report.worker = {
        id: this._workerMeta.id,
        runId: this._workerMeta.runId,
      };
    }
    return report;
  }
}

// ============================================================
// HTTP 服务器
// ============================================================
// 多用户会话隔离：每个浏览器一个 sessionId → 独立 engine。
// 最多 8 个浏览器会话同时各测各的 key，数据互不串、停止只停自己的。
const engines = new Map();               // sessionId -> { engine, lastSeen }
const MAX_CONCURRENT_RUNNING = 8;        // 全局同时在跑上限（保护单 pod）
const ENGINE_TTL_MS = 30 * 60 * 1000;    // 空闲会话 30 分钟后回收
const workerEngine = new StressTestEngine();
let workerRunId = null;
let workerId = process.env.WORKER_ID || "";

function getSessionId(req, parsed) {
  const fromHeader = req.headers["x-session-id"];
  const fromQuery = parsed && parsed.query && parsed.query.sid;
  return String(fromHeader || fromQuery || "anon").slice(0, 64);
}

function getEngine(sid) {
  let slot = engines.get(sid);
  if (!slot) { slot = { engine: new StressTestEngine(), lastSeen: 0 }; engines.set(sid, slot); }
  slot.lastSeen = Date.now();
  return slot.engine;
}

function runningCount() {
  let n = 0;
  for (const slot of engines.values()) if (slot.engine.running) n++;
  return n;
}

function readJsonBody(req, cb) {
  let body = "";
  req.on("data", function(chunk) { body += chunk; });
  req.on("end", function() {
    try { cb(null, body ? JSON.parse(body) : {}); } catch (e) { cb(e); }
  });
}

function isWorkerAuthorized(req) {
  return String(req.headers["x-worker-token"] || "") === WORKER_SHARED_TOKEN;
}

// 定时回收：空闲超 TTL 且未在跑的会话清掉，避免 Map 无限增长
setInterval(function() {
  const cutoff = Date.now() - ENGINE_TTL_MS;
  for (const [sid, slot] of engines) {
    if (!slot.engine.running && slot.lastSeen < cutoff) engines.delete(sid);
  }
}, 5 * 60 * 1000);

const requestHandler = function(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Session-Id");

  if (req.method === "OPTIONS") {
    res.writeHead(204); res.end(); return;
  }

  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, workerMode: WORKER_MODE }));
    return;
  }

  if (WORKER_MODE && pathname.indexOf("/worker/") === 0) {
    if (!isWorkerAuthorized(req)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "forbidden" }));
      return;
    }
    if (pathname === "/worker/start" && req.method === "POST") {
      readJsonBody(req, async function(err, payload) {
        try {
          if (err) throw err;
          if (workerEngine.running) throw new Error("worker 正在运行");
          workerRunId = String(payload.runId || "");
          workerId = String(payload.workerId || workerId || "worker");
          const config = normalizeConfig(payload.config || {});
          config.workerRunId = workerRunId;
          config.workerId = workerId;
          const startAt = Math.max(Date.now(), Number(payload.startAt) || Date.now());
          workerEngine.reset();
          workerEngine.runId = workerRunId;
          workerEngine.config = config;
          workerEngine.startTime = startAt;
          workerEngine.running = true;
          workerEngine.stopRequested = false;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, workerId: workerId, runId: workerRunId, startAt: startAt, config: sanitizeConfig(config) }));
          setTimeout(function() {
            workerEngine.run(config).catch(function(e) {
              console.error("[worker压测异常]", e.message);
            });
          }, Math.max(0, startAt - Date.now()));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    if (pathname === "/worker/snapshot" && req.method === "POST") {
      const snap = workerEngine.getSnapshot();
      snap.workerId = workerId;
      snap.workerRunId = workerRunId;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(snap));
      return;
    }
    if (pathname === "/worker/report" && req.method === "POST") {
      readJsonBody(req, function(err, payload) {
        if (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
          return;
        }
        const requestedRunId = String((payload && payload.runId) || workerRunId || "");
        const requestedWorkerId = String((payload && payload.workerId) || workerId || "");
        let report = workerEngine.lastReport || workerEngine.generateReport();
        if (requestedRunId && (!report || report.runId !== requestedRunId)) {
          const diskReport = loadWorkerShardReport(requestedRunId, requestedWorkerId);
          if (diskReport) report = diskReport;
        }
        if (report && !report.worker) {
          report.worker = { id: requestedWorkerId, runId: requestedRunId || null };
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(report));
      });
      return;
    }
    if (pathname === "/worker/stop" && req.method === "POST") {
      workerEngine.running = false;
      workerEngine.stopRequested = true;
      if (workerEngine._rpmControllers) {
        for (const ctrl of workerEngine._rpmControllers) {
          try { ctrl.abort(); } catch (e) {}
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
  }

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
        const NON = /^dall-e|^tts-|^whisper|^gpt-image|^nano[ -]?banana|^gemini-3-pro-image$|^gemini-3\.1-flash-image$|^text-embedding|^text-moderation|^babbage|^davinci/i;

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
        const sid = getSessionId(req, parsed);
        const engine = getEngine(sid);
        if (engine.running) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "你已有一个压测任务在运行，请先停止或等待完成" }));
          return;
        }
        // 全局并发保护：同时在跑的会话数到上限就拒绝（保护单 pod，不影响已在跑的人）
        if (runningCount() >= MAX_CONCURRENT_RUNNING) {
          res.writeHead(429, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "服务器并发已满（最多 " + MAX_CONCURRENT_RUNNING + " 个同时压测），请稍后再试" }));
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
    const engine = getEngine(getSessionId(req, parsed));
    engine.running = false;
    engine.stopRequested = true;
    if (engine._workerJob && engine._workerJob.workers) {
      engine._workerJob.workers.forEach(function(worker) {
        postJson(worker.url + "/worker/stop", { runId: engine.runId }, 10000, { "X-Worker-Token": WORKER_SHARED_TOKEN }).catch(function() {});
      });
    }
    if (engine._activeChildEngine) {
      engine._activeChildEngine.running = false;
      engine._activeChildEngine.stopRequested = true;
    }
    // 批量/RPM 模式：abort 所有 in-flight 请求
    if (engine._rpmControllers) {
      for (const ctrl of engine._rpmControllers) {
        abortWithReason(ctrl, "手动停止");
      }
    }
    if (engine._activeChildEngine && engine._activeChildEngine._rpmControllers) {
      for (const ctrl of engine._activeChildEngine._rpmControllers) {
        abortWithReason(ctrl, "手动停止");
      }
    }
    // 连续对话模式：abort 每个 session 的请求
    if (engine._activeSessions) {
      for (const session of engine._activeSessions) {
        if (session._currentController) {
          abortWithReason(session._currentController, "手动停止");
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
    if (engine._activeChildEngine && engine._activeChildEngine._activeSessions) {
      for (const session of engine._activeChildEngine._activeSessions) {
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
    const engine = getEngine(getSessionId(req, parsed));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(engine.getSnapshot()));
    return;
  }

  // 最终报告
  if (pathname === "/api/report") {
    const engine = getEngine(getSessionId(req, parsed));
    const report = engine.lastReport || engine.generateReport();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(report));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
};

// 定期清理旧压测报告：报告只用于短期下载，Pod 无 PV，重启也会清空。
function cleanOldReports() {
  try {
    if (!fs.existsSync(REPORT_DIR)) return;
    const cutoff = Date.now() - REPORT_RETENTION_MS;
    const reports = [];
    let removed = 0;
    for (const f of fs.readdirSync(REPORT_DIR)) {
      if (!f.endsWith(".json")) continue;
      const fp = path.join(REPORT_DIR, f);
      try {
        const stat = fs.statSync(fp);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(fp);
          removed++;
        } else {
          reports.push({ file: fp, mtimeMs: stat.mtimeMs });
        }
      } catch (e) {}
    }
    reports.sort(function(a, b) { return a.mtimeMs - b.mtimeMs; });
    while (reports.length > REPORT_MAX_FILES) {
      const old = reports.shift();
      try { fs.unlinkSync(old.file); removed++; } catch (e) {}
    }
    if (removed > 0) {
      console.log("[清理] 删除 " + removed + " 个旧报告，保留 " + reports.length + " 个");
    }
  } catch (e) {
    console.error("[清理失败]", e.message);
  }
}
cleanOldReports();
setInterval(cleanOldReports, REPORT_CLEAN_INTERVAL_MS);

// 进程级兜底：单个请求/异步链路里的未捕获异常或 Promise 拒绝，只记日志、绝不退出进程。
// 历史教训：fireCachedTurn 的 `ctrl is not defined` 等单点 bug 曾把整个主服务打崩、所有 session 监控归零。
// 即使后续再出现别的未知单点异常，也不能让一次压测把整台服务带走。
process.on("uncaughtException", function(e) {
  try { console.error("[uncaughtException 已兜底，不退出]", (e && e.stack) || e); } catch (_) {}
});
process.on("unhandledRejection", function(reason) {
  try { console.error("[unhandledRejection 已兜底，不退出]", (reason && reason.stack) || reason); } catch (_) {}
});

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
