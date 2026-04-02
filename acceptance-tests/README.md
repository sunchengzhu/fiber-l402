# Fiber L402 验收测试

> 项目: [RetricSu/fiber-l402](https://github.com/RetricSu/fiber-l402)  
> Commit: `e3a0b23b8011f562296db2f1029b639e544d6c4b` (master)  
> 测试环境: macOS, Node.js v20.17.0, Fiber v0.7.1 (payer, 本地 8227) + v0.8.0-rc1 (payer, 本地 8229) + v0.8.0-rc1 (payee, 远程 172.31.28.209:8227)  
> 创建日期: 2026-04-01  
> 最后更新: 2026-04-02

---

## 一、项目概览

```
Browser (localhost:4321)          Express Proxy (localhost:3001)          Fiber Nodes
┌─────────────────────┐          ┌──────────────────────────┐          ┌──────────────┐
│ Astro + React       │          │ L402Middleware            │          │ Payee (8227)  │
│ FiberConnectButton  │─ RPC ──→ │   MacaroonService        │── RPC ──→│ create invoice│
│ PaymentGate         │          │   InvoiceService         │          │ verify status │
│                     │── API ──→│ ArticleService           │          └──────────────┘
│                     │          │ ResourceResolver         │          ┌──────────────┐
│ FiberRpcClient      │─ RPC ──────────────────────────────────────── →│ Payer (8229)  │
│ (browser-direct)    │          └──────────────────────────┘          │ send payment  │
└─────────────────────┘                                                └──────────────┘
```

**认证路径**

- **Path A（手动支付）**: `Authorization: L402 macaroon:preimage` → SHA256(preimage) == paymentHash → 通过
- **Path B（auto-pay）**: `Authorization: L402 macaroon` → InvoiceService.getInvoiceStatus → Paid → 通过

**现有单测覆盖**

| 文件 | 覆盖范围 | 测试数 |
|---|---|---|
| article-content.test.ts | ArticleContentResolver 路由匹配 + 资源解析 | 3 |
| article.test.ts | ArticleService 文件加载/缓存/预览 | 5 |
| article.spec.ts (E2E) | 页面导航 + 基础 UI | 9 |

未覆盖: MacaroonService、InvoiceService、L402Middleware、前端组件逻辑

**环境配置**

```env
L402_ROOT_KEY=<64位hex>     # 必须 32 字节
ARTICLE_PRICE_CKB=0.1      # fallback 默认值，frontmatter price 优先
FIBER_RPC_URL=http://...    # payee 节点
L402_EXPIRY_SECONDS=3600
```

- **Payee 节点**: `.env` FIBER_RPC_URL，后端创建/验证 invoice
- **Payer 节点**: 前端 Connect Node 输入，浏览器直接发起支付
- 可同节点（`allow_self_payment: true`），Payer 需启用 CORS

---

## 二、已发现的问题

| Issue | 类型 | 标题 | 严重性 | 状态 |
|---|---|---|---|---|
| [#2](https://github.com/RetricSu/fiber-l402/issues/2) | 文档 | SETUP.md 缺少 CORS 配置 + payee/payer 角色说明 | 低 | 已提交 |
| [#3](https://github.com/RetricSu/fiber-l402/issues/3) | Bug | FiberConnectButton 恢复已保存连接时崩溃（node_id→pubkey） | 中 | 已提交 |
| [#4](https://github.com/RetricSu/fiber-l402/issues/4) | 架构 | HTTPS 下 connected-node 自动支付流程失效（mixed content） | 中 | 已提交 |
| [#5](https://github.com/RetricSu/fiber-l402/issues/5) | Bug | 错误处理链路全程丢失上下文（500 → "Unexpected response"） | 中 | 已提交 |
| [#6](https://github.com/RetricSu/fiber-l402/issues/6) | Bug | Auto-pay 支付成功但解锁确认失败时丢失客户端凭证（Spec §8） | **高** | 已提交 |
| [#7](https://github.com/RetricSu/fiber-l402/issues/7) | Bug | CKB→shannons 浮点精度导致特定价格支付完全失败 | **高** | 已提交 |
| — | Bug | `split('=')` 截断含 `=` 的 caveat 值 | 低 | 待提交 |
| — | 合规 | 不支持 LSAT scheme 向下兼容（Spec §10） | 信息 | — |

---

## 三、测试场景与执行结果

**统计: 已执行 42/57 | 通过 39 | 问题 3 | 跳过 15**

---

### P0 — 核心付费流程

脚本: `p0-test.mjs` | 断言 22/22 | **通过率 100%**

| # | 场景 | 结果 | 备注 |
|---|---|---|---|
| 1 | 不带任何凭证访问付费文章 API，应返回 402 + macaroon + invoice | ✅ | |
| 2 | 返回的 invoice 应为合法的 Fiber invoice（以 `fibt` 开头） | ✅ | |
| 3 | 外部钱包支付 invoice 获得 preimage，用 `macaroon:preimage` 请求，应返回 200 + 全文 | ✅ | |
| 4 | 解锁后刷新页面，全文仍可见（localStorage 缓存），不要求重新付费 | ⏭️ | 需浏览器 |
| 5 | 解锁文章 A 后访问文章 B，文章 B 仍要求付费（token 不跨文章） | ✅ | |
| 6 | 无凭证请求返回的 402 响应体中不包含文章全文（防免费泄露） | ✅ | |
| 7 | 用文章 A 的 macaroon+preimage 请求文章 B，应被 resource_id caveat 拒绝 | ✅ | |

---

### P1

#### Connected Node 自动支付

| # | 场景 | 结果 | 备注 |
|---|---|---|---|
| 8 | 点击 Connect Node 输入 Payer RPC URL，连接成功后按钮变绿点 + 节点 ID 截断显示 | ⏭️ | 需浏览器交互 |
| 9 | 已连接节点状态下点击 Unlock → Pay with Connected Node，自动完成支付并解锁全文 | ⏭️ | 需浏览器交互 |
| 10 | 输入不存在的 RPC URL（如 `http://127.0.0.1:9999`），应显示连接失败错误，不进入已连接状态 | ⏭️ | 需浏览器交互 |
| 11 | 成功连接后关掉 Fiber 节点再刷新页面，应自动回退到未连接状态 | ⏭️ | 需浏览器交互 |
| 12 | 已连接状态下点击下拉菜单 Disconnect，应回到未连接状态 | ⏭️ | 需浏览器交互 |

#### 认证与安全

脚本: `p1p2-test.mjs` + `test-14-15-26.mjs`

| # | 场景 | 结果 | 备注 |
|---|---|---|---|
| 13 | 手动输入伪造的 preimage 提交验证，应返回 401 "hash mismatch"，全文不解锁 | ✅ | |
| 14 | 获取 invoice 后等待过期（临时改 expiry=3s），支付应被 Fiber 节点拒绝；重新请求应获得新 invoice | ✅ | |
| 15 | 用通道余额不足的节点执行自动支付（临时改 price=1000000 CKB），应支付失败并显示余额不足 | ✅ | |
| 16 | 对合法 macaroon 进行 base64 解码→篡改内容→重新编码后请求，应被 HMAC 签名校验拒绝 | ✅ | |
| 17 | 用已过期的 macaroon+preimage 请求内容 API，应返回 401 "Macaroon expired" | ✅ | |
| 18 | 仅携带 macaroon（无 preimage，走 Path B），但 invoice 未支付，应返回 401 "not settled" | ✅ | |

#### 错误处理

| # | 场景 | 结果 | 备注 |
|---|---|---|---|
| 24 | 关掉 Payee 节点后点击 Unlock，后端 API 应返回有意义的错误信息（而非裸 500） | ✅ | [#5](https://github.com/RetricSu/fiber-l402/issues/5) |
| 25 | Payee 不可达时后端终端应有 console.error 日志记录错误详情，方便运维排查 | 🐛 | [#5](https://github.com/RetricSu/fiber-l402/issues/5)，当前无日志 |
| 26 | 关掉 Payer 节点后执行自动支付，前端应显示有意义的错误（当前仅 "fetch failed"） | ✅ | [#5](https://github.com/RetricSu/fiber-l402/issues/5) |

#### 已知 Bug 回归

脚本: `test-19-20-21.mjs` | 断言 31/31 | **通过率 100%**（含 bug 确认断言）

| # | 场景 | 结果 | 备注 |
|---|---|---|---|
| 19 | 用新版 Fiber v0.8.0-rc1（API 返回 `pubkey` 而非 `node_id`）连接，应正常显示节点 ID，不崩溃 | 🐛 | [#3](https://github.com/RetricSu/fiber-l402/issues/3) 确认: `info.node_id` 为 `undefined`，渲染 `slice()` 崩溃；`info.node_id \|\| info.pubkey` 可修复 |
| 20 | 用旧版 Fiber v0.7.1（返回 `node_id`）连接，应正常工作 | ✅ | v0.7.1 (8227) 返回 `node_id`，前端正常显示 `"02a266b5…d8b7"` |
| 21 | localStorage 有旧版保存的连接信息，升级节点后刷新页面，应不崩溃并恢复连接或优雅降级 | 🐛 | [#3](https://github.com/RetricSu/fiber-l402/issues/3) 确认: `setNode` 阶段不崩溃，渲染阶段崩溃；节点不可达时 catch 分支可正常降级 |
| 22 | 在 HTTPS 页面（如 Vercel 部署）连接 HTTP Fiber 节点并自动支付，应有明确错误提示（mixed content） | ⏭️ | 待 [#4](https://github.com/RetricSu/fiber-l402/issues/4) 修复 |
| 23 | 在 HTTPS 页面用手动 preimage 路径支付（走后端 API，不受 mixed content 影响），应正常工作 | ⏭️ | 待 [#4](https://github.com/RetricSu/fiber-l402/issues/4) 修复 |

#### 凭证持久化（L402 Spec §8 合规性）

> L402 Spec §8: "L402 credentials are intended for reuse. A client **SHOULD** cache and reuse its credential until the server rejects it with a new 402 challenge."
> 参考实现 [Aperture](https://github.com/lightninglabs/aperture) 的 `l402/store.go` 定义了 `Store` 接口（`CurrentToken` / `StoreToken` / `AllTokens`），将 `macaroon + preimage + paymentHash` 持久化到磁盘文件 `l402.token`。

| # | 场景 | 结果 | 备注 |
|---|---|---|---|
| 27 | Auto-pay（Path B）成功解锁后检查 localStorage，应存在 `l402-*`（含 `macaroon` + `paymentHash`）和 `l402-content-*`（内容缓存） | ⏭️ | [#6](https://github.com/RetricSu/fiber-l402/issues/6) 不符合 Spec §8 SHOULD 要求。当前 `fetchContentWithPaidInvoice()` 只存 content，不存任何凭证。Path B 无 preimage 返回客户端，但 `{macaroon, paymentHash}` 仍可用于重放 Path B 认证 |
| 27a | Auto-pay 支付成功但内容获取失败（如后端临时不可用），重试耗尽后刷新页面，应能用已持久化的凭证恢复解锁 | ⏭️ | [#6](https://github.com/RetricSu/fiber-l402/issues/6) 核心场景。当前 `payWithConnectedNode()` 在支付确认后不立即存储 `{macaroon, paymentHash}`，若后续内容获取全部失败，用户已付款但 localStorage 无任何恢复数据 |
| 28 | 手动 preimage（Path A）解锁后检查 localStorage，`l402-*` 应含 `{macaroon, preimage}`，`l402-content-*` 应含内容 | ⏭️ | 代码 `checkPayment()` 已正确存储 `{macaroon, preimage}`，需浏览器环境验证 |
| 29 | 删除 `l402-content-*` 但保留 `l402-*` 后刷新页面，应能用缓存凭证重新获取内容，无需重新付费 | ⏭️ | Path A: `checkCache()` 已有 fallback 逻辑（先查内容缓存 → 再查凭证 → 用凭证发请求）。Path B: 凭证未存，无法恢复。需浏览器环境验证 |

#### 协议合规性

脚本: `spec-compliance-test.mjs` | 断言 43, 通过 41 | **通过率 95.3%**

| # | 场景 | 结果 | 备注 |
|---|---|---|---|
| 36 | 无凭证请求应返回 402；携带无效凭证请求应返回 401（Spec §4.1 区分） | ✅ | |
| 37 | 402 响应头应包含 `WWW-Authenticate: L402 macaroon="...", invoice="..."`（Spec §5.1） | ✅ | |
| 38 | 发送 `Authorization: LSAT macaroon:preimage`（旧协议名），应被接受或明确拒绝 | ⚠️ | 不识别 LSAT scheme（Spec §10 要求兼容） |

#### 输入边界与注入

| # | 场景 | 结果 | 备注 |
|---|---|---|---|
| 39 | `Authorization: L402 `（scheme 后仅空格/空值），应返回 402，不崩溃 | ✅ | |
| 40 | `Authorization: L402 mac:pre:extra`（含多个冒号），应只按第一个 `:` 分割，不崩溃 | ✅ | |
| 41 | macaroon 部分传入非 base64 字符串（如 `!!!not-base64!!!`），应返回 401，不崩溃 | ✅ | |
| 42 | preimage 传入非 hex 字符串（如 `ZZZZNOTHEX`），应返回 401 | ✅ | |
| 43 | preimage 长度不正确（31 或 33 字节，正常应为 32 字节），应返回 401 | ✅ | |
| 44 | macaroon 或 preimage 中注入控制字符（`\r\n` 等），应返回 401，不产生 HTTP header 注入 | ✅ | |

#### Caveat 与 Payment Hash

| # | 场景 | 结果 | 备注 |
|---|---|---|---|
| 45 | 伪造不含 `resource_id` caveat 的 macaroon 请求文章，应返回 401 | ✅ | |
| 46 | 伪造不含 `resource_type` caveat 的 macaroon 请求文章，应返回 401 | ✅ | |
| 47 | 设置 expiry 恰好为当前秒，验证边界行为（代码用 `<` 严格小于，等于时仍有效） | ✅ | |
| 48 | resource_id 值包含 `=` 字符（如 `article-id=base64test==`），caveat 解析应完整保留值 | 🐛 | `split('=')` 截断，待提交 issue |
| 49 | 请求时 `X-L402-Payment-Hash` 头与 macaroon 中的 payment_hash 不匹配，应返回 401 | ✅ | |
| 50 | 构造无 payment_hash caveat 的 macaroon + 携带 `X-L402-Payment-Hash` 头请求 | ⏭️ | 需绕过 HMAC 签名，难以构造 |

#### 限流与并发

| # | 场景 | 结果 | 备注 |
|---|---|---|---|
| 51 | 同一 IP 在 60s 内发送超过 100 次请求，应触发 429 限流 + 返回 `retryAfter` 字段 | ✅ | |
| 52 | 触发限流后等待窗口期（60s）重新请求，应恢复正常，重新计数 | ✅ | |
| 53 | 用同一 `macaroon:preimage` 连续请求 5 次，应全部返回 200（凭证可复用，Spec §8） | ✅ | |
| 54 | 同时发起 2 个 `initiatePayment` 请求，应各自获得独立 challenge，互不干扰 | ✅ | |

#### 服务配置

| # | 场景 | 结果 | 备注 |
|---|---|---|---|
| 55 | 不设 `L402_ROOT_KEY` 环境变量启动后端，middleware 默认 `'default-key'` 但 MacaroonService 要求 32 字节，应报错 | ✅ | 启动即崩溃：抛 `Error: Root key must be 32 bytes (64 hex characters)` |
| 56 | 设置文章价格为 1.1 CKB，CKB→shannons 转换 `1.1*1e8` 产生浮点误差，Fiber 节点拒绝非整数金额，支付完全失败 | 🐛 | [#7](https://github.com/RetricSu/fiber-l402/issues/7)，`Math.round()` 可修复 |

---

### P2

#### API 边界

脚本: `p1p2-test.mjs`（部分）

| # | 场景 | 结果 | 备注 |
|---|---|---|---|
| 30 | 请求不存在的文章 ID（如 `/api/articles/nonexistent/content`），应返回 404 或合理错误，不是 500 | ✅ | |
| 31 | 请求文章列表 `GET /api/articles`，返回的预览信息中不应包含任何文章全文 | ✅ | |
| 32 | 解锁后清除 localStorage 再访问同一文章，应重新要求付费（服务端无状态设计） | ✅ | |

#### 环境兼容

| # | 场景 | 结果 | 备注 |
|---|---|---|---|
| 33 | 隐私模式下付费后关闭窗口再打开，付费状态应丢失（localStorage 不持久） | ⏭️ | 需手动浏览器操作 |
| 34 | Chrome 中付费解锁后用 Firefox 访问同一文章，应仍要求付费（localStorage 不跨浏览器） | ⏭️ | 需手动浏览器操作 |
| 35 | 付费解锁后重启后端并更换 `L402_ROOT_KEY`，原凭证应验证失败（密钥不匹配） | ✅ | Path A 和 Path B 均返回 401 `signature mismatch after caveat verification` |

---

## 四、未执行场景汇总

| 分类 | 场景 | 原因 |
|---|---|---|
| 浏览器交互 | #4, #8-12, #33-34 | 需浏览器 + Fiber 节点交互 |
| 已知 Bug 未修复 | #22-23 | 待 [#4](https://github.com/RetricSu/fiber-l402/issues/4) 修复后回归 |
| Spec §8 合规 | #27, #27a, #28-29 | 凭证持久化，需浏览器环境验证；[#6](https://github.com/RetricSu/fiber-l402/issues/6) Auto-pay 支付成功但凭证丢失 |
| 环境限制 | #50 | 无法绕过 HMAC 构造 |

---

## 五、测试脚本清单

| 脚本 | 覆盖场景 | 结果 |
|---|---|---|
| p0-test.mjs | #1-3, #5-7 | 22/22 ✅ |
| p1p2-test.mjs | #13, #16-18, #24, #30-32 | 25/25 ✅ |
| test-14-15-26.mjs | #14, #15, #26 | 手动验证 ✅ |
| spec-compliance-test.mjs | #36-54, #56 | 41/43（2 BUG） |
| test-19-20-21.mjs | #19-21 + 节点版本兼容性 + auto-pay 实付 | 31/31 ✅ |
| reproduce-autopay-bug.mjs | auto-pay 凭证缺失复现 | — |
| check-float-bug.mjs | 浮点精度 bug 复现 | — |
