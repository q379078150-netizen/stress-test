# LLM 渠道压力测试方法论与实现说明

> 面向接手工程师 / 高级后端工程师。本文解释本压测工具的测试模型、隔离边界、统计口径、精度保障和运维约束。

## 目标

本工具用于评估 LLM 中转渠道在不同负载形态下的可用性、承载能力和缓存能力。它不是单纯的 `ab`/`wrk` 型 HTTP 压测器，而是按 LLM 请求的真实行为建模：

- 文字流式响应的首字节、完整响应、成功率、限流率。
- 固定并发闭环请求，用于寻找渠道瞬时并发上限。
- 固定 RPM 开环请求，用于模拟真实用户到达率。
- Anthropic Messages Prompt Cache 命中率，用于验证缓存前缀、路由粘性和上游账号池行为。
- 图片生成请求，用于评估长延迟、非流式、高成本接口的并发与 RPM 承载。

核心原则：**测试发射端尽量精准，统计口径尽量闭合，用户会话完全隔离，渠道侧影响如实暴露。**

## 系统架构

组件：

- `index.html`：单页前端，采集 Base URL、API Key、模型、模式和压测参数。
- `stress-test-server.js`：HTTP 服务 + 压测引擎，负责模型扫描、请求发射、实时快照、最终报告和数据清理。
- `report-template.html`：独立报告模板。
- `Dockerfile`：线上 k3s Pod 镜像。

线上运行方式：

- 单 Pod，Node.js 20 Alpine。
- Service 暴露 `3457`，Ingress 走 `https://stress.akria.net`。
- Pod 无 PV，报告落容器内 `logs/stress-tests/`，重启即清空。

多用户隔离：

- 前端首次访问生成 `SESSION_ID`，保存在浏览器 localStorage。
- 所有 API 请求携带 `X-Session-Id`。
- 后端维护 `Map<sessionId, StressTestEngine>`。
- 每个用户有独立 engine、独立配置、独立实时状态、独立报告、独立停止控制。
- 全局最多允许 8 个 engine 同时运行，超过返回 429，保护单 Pod。

这意味着多人各自使用不同 URL 和 Key 时，工具层面不会串数据、串停止、串报告。

## 测试模式

### 1. 独立请求模式：Burst / 高 QPS

目的：

- 测渠道瞬时并发承载。
- 快速暴露连接池、上游账号池、反代、数据库或网关瓶颈。

实现：

- 输入 `concurrency = N`。
- 一次性创建 N 个 Promise，同时发出 N 个 `/v1/chat/completions` 请求。
- 所有请求结束后生成报告。
- 无持续时间参数。

请求特征：

- 使用 OpenAI Chat Completions 兼容接口。
- `stream: true`，并带 `stream_options.include_usage`。
- Prompt 从短中文语句池选择，降低 token 成本，模拟真实短问句。
- 每个 worker 使用稳定 UA 和 `X-Client-Id`，避免所有请求完全同质。

统计含义：

- `successRate` 代表这批并发请求的实际完成质量。
- `qps` 是完成吞吐，不是发射速率。
- `equivalentRpm = concurrency / avgLatencySeconds * 60`，用于把闭环并发换算成近似 RPM。

适用判断：

- 如果并发升高后 429、5xx、连接断开、空响应明显增加，说明渠道瓶颈已出现。
- 该模式不适合模拟真实用户持续流量，因为它是一次性批量发射。

### 2. 连续对话模式：Prompt Cache 测试

目的：

- 验证 `/v1/messages` + `cache_control` 的 Prompt Cache 写入和读取。
- 判断渠道是否支持 Anthropic Messages 兼容协议。
- 判断中转渠道是否具备会话粘性路由。

实现：

- 创建多个 session。
- 每个 session 顺序执行多轮 user/assistant 对话。
- 每轮请求复用同一 system cache block 和历史 messages。
- 到达设定时间后不再取新 session，但正在跑的 session 会尽量做满全部轮数。

缓存布局：

```json
{
  "system": [
    {
      "type": "text",
      "text": "<system instruction>\\n\\nCACHE_PADDING_<stable-id><stable-pad>",
      "cache_control": { "type": "ephemeral" }
    }
  ],
  "messages": ["history grows by append"],
  "metadata": {
    "user_id": "<stable uuid per session>"
  },
  "stream": true
}
```

关键点：

- cache block 使用约 8000 字符的确定性多样文本，避免重复字符被 BPE 合并后低于 1024 token 门槛。
- `metadata.user_id` 固定在同一 session 内，用于中转层粘性路由。
- 同一 session 的缓存前缀逐字节稳定。
- SSE 中从 `message_start.usage` 和 `message_delta.usage` 聚合 usage 字段。

统计含义：

- 第 1 轮通常是 cache creation，不计入有效命中率。
- 第 2 轮起看 `cache_read_input_tokens > 0`。
- `cacheHitRate` 按第 2 轮及以后计算。
- `cacheCreateTokens` 和 `cacheReadTokens` 可用于判断渠道到底返回了哪些 cache usage 字段。

判断方法：

- 并发 1、多轮对话仍命中低，通常是渠道不支持缓存或中转没有粘性。
- 同样配置在 A 渠道 100% 命中、B 渠道低命中，基本可归因为 B 渠道路由或上游账号池问题。

### 3. RPM 开环模式：真实流量模型

目的：

- 按固定到达率模拟真实用户流量。
- 避免闭环压测中“请求慢导致发射也变慢”的反馈误差。
- 通过 `peakInflight` 验证 Little's Law：`inflight ≈ RPS × latency`。

实现：

- 输入 `targetRpm` 和 `durationSeconds`。
- 计算 `intervalMs = 1000 / (targetRpm / 60)`。
- 第 n 个请求计划在 `startTime + n * intervalMs` 发射。
- 使用绝对时间锚点，避免 `setInterval` 漂移和累计误差。

核心伪代码：

```js
let fireIdx = 0;
while (running) {
  const nextFireAt = startTime + fireIdx * intervalMs;
  if (nextFireAt >= deadline) break;
  await sleep(max(0, nextFireAt - Date.now()));
  fireOne(); // fire-and-forget
  fireIdx++;
}
launchEndTime = Date.now();
await drainInflight();
```

统计口径：

- `targetRpm`：目标发射速率。
- `actualRpm`：`totalSent / launchWindow * 60`，只按发射窗口计算，不被 drain 阶段稀释。
- `totalSent`：真实发射请求数。
- `totalDone`：已结算请求数。
- `success + fail` 应尽量等于 `totalDone`。
- `peakInflight`：压测期间的峰值在途请求数。

drain 策略：

- 发射时间结束后不再发新请求。
- 等所有已发请求自然返回，保证成功/失败闭合。
- 为避免上游 TCP 挂死，设置总宽限：
  - `timeout > 0`：`timeout + 5s`
  - 文字默认：35s
  - 图片默认：180s
- 超过宽限仍未返回的请求会 abort，并计入 timeout 失败。

缓存 RPM 子模式：

- RPM 始终表示真实请求/分钟，不表示用户/分钟。
- 缓存对话中，每次节拍只发一轮请求。
- 用户池维护多轮上下文，用户做完指定轮数后退休。
- `总请求 ≈ targetRpm × durationSeconds / 60`，与轮数无关。

### 4. 图片生成模式

目的：

- 测图片生成模型的成功率、延迟、限流和长请求堆积。
- 支持一次性并发和 RPM 开环两种形态。

接口分流：

- `gpt-image-*`、`dall-e-*`、`sora`：走 OpenAI 兼容 `/v1/images/generations`。
- `nano banana`、`gemini...image`：走 Gemini 原生 `/v1beta/models/{model}:generateContent`。

成本控制：

- `n = 1`
- `size = 1024x1024` 或 Gemini `imageSize = "1K"`
- gpt-image 类使用 `quality = "low"`
- Prompt 使用短安全词或轻量中文随机组合。
- 不落盘、不保存 base64，只判断响应中是否有图片。

统计特点：

- 图片生成无 Prompt Cache。
- 单请求延迟远高于文字，RPM 高时 `peakInflight` 会迅速增加。
- 发射端可以达到目标 RPM，但渠道成功率可能下降，这是渠道承载问题，不是发射误差。

## 精准性保障

### 会话隔离精准

- 前端所有 API 都走 `apiFetch()`，自动注入 `X-Session-Id`。
- 后端所有状态接口都先 `getEngine(sessionId)`。
- `/api/stop` 只修改当前 session 的 engine。
- `/api/report` 只读取当前 session 的 `lastReport`。
- 空闲 engine 30 分钟回收，防止内存无限增长。

边界：

- 同一个浏览器 profile 的多个标签页会共享同一个 `SESSION_ID`。
- 多人应使用各自电脑、各自浏览器 profile，或各自隐身窗口。

### 发射速率精准

- RPM 使用绝对时间锚点，不依赖普通 `setInterval`。
- `actualRpm` 只按发射窗口计算，不按总运行时间计算。
- drain 阶段不影响 RPM 口径。
- 背压 `maxInflight` 可选，默认 0 表示纯开环。

边界：

- Node.js 事件循环被极端请求量或 CPU 消耗阻塞时，发射可能短时抖动。
- 上游 DNS、TLS、代理、连接复用不稳定会影响响应质量，但不改变发射计数。

### 统计闭合

- 每个请求发射时增加 `totalSent`。
- 返回成功、HTTP 错误、空响应、timeout、网络错误都会进入结算路径。
- 报告记录 `success`、`fail`、`rateLimited`、`errors`、`latency`。
- `errors` 最多保留前 100 条，避免单个报告过大。

边界：

- 用户手动 stop 会 abort 在途请求，此时报告重点看已结算部分。
- 上游连接挂死超过 drain 宽限后会被记为 timeout。

## 数据与清理

内存：

- 每个浏览器 session 一个 engine。
- 未运行且 30 分钟无访问的 engine 自动回收。

磁盘：

- 报告 JSON 写入 `logs/stress-tests/`。
- Pod 无 PV，重启即清空。
- 服务启动时会先清理一次旧报告。
- 运行中每 30 分钟清理一次。
- 默认删除 3 小时前的报告。
- 默认最多保留 200 份最新 JSON。

可调环境变量：

```bash
REPORT_RETENTION_MS=10800000       # 默认 3 小时
REPORT_CLEAN_INTERVAL_MS=1800000   # 默认 30 分钟
REPORT_MAX_FILES=200               # 默认最多 200 份
```

## 资源与并发边界

线上默认资源：

- requests：`100m CPU / 128Mi memory`
- limits：`1 CPU / 512Mi memory`
- 当前空闲占用约 `1m CPU / 7-8Mi memory`

并发边界：

- 工具限制最多 8 个同时运行的用户任务。
- 这个限制保护的是 Pod 和 Node 进程。
- 不限制单个用户的 `concurrency` 或 `targetRpm`。

推荐策略：

- 多人同时使用时，每人测试不同渠道 URL/Key。
- 单人先低并发验证连通性，再逐步增加。
- 图片 RPM 从 20-60 起测，观察 `peakInflight` 和成功率。
- 文字 RPM 可先按目标渠道预期容量阶梯递增。

## 结果解读

重点指标：

- `successRate`：整体成功质量。
- `rateLimited`：渠道明确限流数量。
- `actualRpm`：开环发射是否达到目标。
- `peakInflight`：渠道是否出现积压。
- `avg/p50/p95/p99`：延迟分布。
- `cacheHitRate`：第 2 轮及以后缓存读取命中率。
- `errorSummary`：错误类型聚合。

常见结论：

- `actualRpm` 达标但成功率低：发射端没问题，渠道承载不足。
- `peakInflight` 持续升高：响应延迟高于目标速率可承受范围。
- 429 增加：渠道限流或上游额度受限。
- 5xx / connection reset：渠道网关、连接池或上游不稳定。
- cache create 有、read 低：中转路由不粘，或缓存绑定到了不同上游账号。
- cache create/read 都为 0：模型、接口或渠道不支持 Prompt Cache。

## 设计取舍

- 单 Pod：部署简单，状态在内存中，适合小团队内部压测面板。
- 不接数据库：避免存储敏感 URL/Key/报告，降低运维复杂度。
- 不持久化报告：压测报告通常短期使用，导出后即可丢弃。
- 全局 8 任务上限：优先保证多人互不影响和结果稳定，而不是无限并行。
- 纯开环 RPM 默认无背压：更真实地暴露渠道积压；需要保护渠道时可启用 `maxInflight`。

## 已知边界

- 工具无法隔离渠道侧共享资源池。如果不同 key 背后共享同一渠道账号池、余额池或上游限流池，结果仍可能互相影响。
- 浏览器 localStorage 保存 API Key 和 URL，仅限当前浏览器本机；不要在公共机器上复用。
- 本工具发起的是真实请求，会消耗真实额度。
- 图片生成请求成本高、延迟长，建议小步递增。
- 真正 AWS Bedrock IAM 凭证需要 SigV4/SDK，本工具只直接支持 Anthropic/OpenAI/Gemini 兼容 HTTP 入口。

## 维护检查清单

上线后建议检查：

- `kubectl get pod -n dev-4-lj -l app=stress-test`
- `kubectl top pod -n dev-4-lj -l app=stress-test`
- `kubectl logs -n dev-4-lj deploy/stress-test --tail=50`
- 确认容器内 `MAX_CONCURRENT_RUNNING = 8`
- 确认容器内存在 `REPORT_RETENTION_MS`、`REPORT_CLEAN_INTERVAL_MS`、`REPORT_MAX_FILES`
- 用两个不同浏览器启动小压测，确认 stop/report 不互串

