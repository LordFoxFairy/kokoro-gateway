# @kokoro/gateway

`kokoro-gateway` 是 Kokoro 的独立业务编排与服务间网关子仓库。它不是 Web 应用、不是
`kokoro-platform` 的业务模块，也不是 `kokoro-app` 的 workspace package。

Chat 在这里的准确承接是 **Session-compatible `/sessions/*`**，不是另造一个 `/chat/*` API：
Composer/Engine 仍提交到 Web 的同源 `/api/session/sessions/{session_id}/messages`，Web BFF
把它转给网关 `/sessions/{session_id}/messages`，网关再转给 Session。Direct Chat 与 Project
Chat 只在 Session scope/project_ref 上不同，消息、Run、SSE、HITL、取消、文件、成果和分享
继续共用这一条承接链路。

第一阶段提供与 `kokoro-app` 当前 BFF 兼容的 Session upstream；现在同时保留了可选的业务
namespace，让同一个独立网关能够承接 Web 的 Hub、User、System、Agent 和支付面：

```text
Browser
  → same-origin kokoro-app /api/session/*
  → server-only kokoro-app BFF
  → kokoro-gateway /sessions/*
  → kokoro-session
```

浏览器路径不变。`kokoro-app` 只需要把 server-only 的 `KOKORO_SESSION_BASE_URL` 指向网关，
不在前端增加 gateway URL、token 或 header selector。

完整的 Chat、业务 namespace、认证边界与迁移验收见 [`docs/api-contract-v1.md`](docs/api-contract-v1.md)。

## 当前边界

网关负责：

- 校验 `x-kokoro-service: web-bff` 与 `x-kokoro-internal-secret`；
- 重新生成唯一的 RFC 7239 `Forwarded: host=<KOKORO_DOMAIN>`；
- 保留用户 runtime `Authorization`，并用独立 session service credential 调用 Session；
- 统一超时、错误和 request id 传递；
- JSON、SSE、artifact 流式透传，不把 SSE 缓冲成 JSON；
- 为后续幂等、审计、跨服务业务编排保留 server-only 入口。

网关不负责：

- UI、Composer、胶囊、路由或 React 状态；
- HttpOnly 登录信封、refresh 和浏览器 Origin 检查（这些属于 `kokoro-app` BFF）；
- Session 消息/事件/文件事实、Agent 执行、模型 Provider、Billing、Capability 数据库；
- `Host`、`X-Domain`、`X-Forwarded-*` 等浏览器可控部署上下文；
- 共享 package 中的业务实现或密钥。

## Routes

Chat/Session 主路由：

- `GET /healthz`
- `GET /readyz`
- `GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS /sessions[/*]`
- 同样的方法和路径范围：`/models[/*]`、`/agents[/*]`、`/artifacts[/*]`、`/billing[/*]`、`/shared[/*]`

`/billing/summary`、`/billing/ledger` 与 `/billing/by-model` 目前也由 Web 的
`/api/session` client 发起，因此必须和 Chat 一起经过兼容网关；它们仍由 Session/Hub
提供事实，Gateway 不在此阶段实现计费规则。

可选业务路由（配置对应 upstream 后启用）：

| Gateway namespace | Upstream env | Web BFF 用法 |
| --- | --- | --- |
| `/hub/*` | `KOKORO_HUB_BASE_URL` | Skills、MCP、connectors、Projects、Scheduled、Settings、Mail |
| `/auth/*`、`/bff/*` | `KOKORO_USER_BASE_URL` | 登录换签、团队自助面；principal 头由 Web BFF 派生 |
| `/system/*` | `KOKORO_SYSTEM_BASE_URL` | runtime manifest |
| `/connections/*` | `KOKORO_AGENT_BASE_URL` | Agent connection setup |
| `/payment/*` | `KOKORO_PAYMENT_BASE_URL` | payment storefront；会去掉 `/payment` 前缀 |
| `/billing-service/*` | `KOKORO_BILLING_BASE_URL` | 独立 billing service；会去掉 `/billing-service` 前缀 |

`/billing/*` 保留给 Session 的兼容读面，避免和 payment/billing service 产生歧义。Web BFF
仍只访问自己的同源 `/api/*`，这些 namespace 只存在于 Web BFF 与 Gateway 的 server-only
网络之间。

`/readyz` 只在 `KOKORO_SESSION_BASE_URL` 已配置时返回 ready；它不会把未配置 upstream
伪装成 live。真正的上游可用性由后续部署探针和集成 smoke 验证。

## Local

```bash
cp .env.example .env
npm ci
npm run check
npm run dev
curl http://127.0.0.1:8080/healthz
```

在 `kokoro-app/.env.local` 中保留同源 Web BFF 语义，只有 server-only upstream 改为
Gateway 的 authority root（不要写成 `.../sessions`）：

```dotenv
KOKORO_GATEWAY_BASE_URL=http://127.0.0.1:8080
KOKORO_INTERNAL_SECRET_WEB_BFF=replace-with-web-bff-secret
```

这一个 Web 变量会让 Chat、User、Hub、System、Agent、Payment 和独立 Billing 的 server-only
请求自动进入对应 Gateway namespace：Web BFF 在 path 上生成 `/sessions/*`、`/auth/*`、
`/bff/*`、`/hub/*`、`/system/*`、`/connections/*`，支付 adapter 使用 `/payment/*` 和
`/billing-service/*`。显式的 `KOKORO_*_BASE_URL` 仍可单独覆盖，用于分阶段迁移：

```dotenv
KOKORO_USER_BASE_URL=http://127.0.0.1:8080
KOKORO_HUB_BASE_URL=http://127.0.0.1:8080
KOKORO_SYSTEM_BASE_URL=http://127.0.0.1:8080
KOKORO_AGENT_BASE_URL=http://127.0.0.1:8080
KOKORO_PAYMENT_BASE_URL=http://127.0.0.1:8080/payment
KOKORO_BILLING_BASE_URL=http://127.0.0.1:8080/billing-service
```

Gateway 侧对应变量则填写各真实业务服务地址（变量名相同但只存在 Gateway 进程内）：

```dotenv
KOKORO_SESSION_BASE_URL=http://kokoro-session:3900
KOKORO_USER_BASE_URL=http://kokoro-user:4211
KOKORO_HUB_BASE_URL=http://kokoro-hub:4251
KOKORO_SYSTEM_BASE_URL=http://kokoro-system:4240
KOKORO_AGENT_BASE_URL=http://kokoro-agent:4260
KOKORO_PAYMENT_BASE_URL=http://kokoro-payment:4241
KOKORO_BILLING_BASE_URL=http://kokoro-billing:4245
```

每个业务 upstream 可选配置独立的 `KOKORO_*_INTERNAL_SECRET`；不配置则不向该 upstream
发送内部 secret。生产环境仍必须为 Session 配置 `KOKORO_SESSION_INTERNAL_SECRET`，并用网络
ACL 限制只有 Web BFF 可以调用网关。

网关侧对应：

```dotenv
KOKORO_GATEWAY_SHARED_SECRET=replace-with-web-bff-secret
KOKORO_SESSION_INTERNAL_SECRET=replace-with-session-secret
```

本地 `KOKORO_DOMAIN=dev.kokoro.localhost` 只用于服务端 `Forwarded`；不进入浏览器 body、
localStorage、URL 或公开 UI。网关不会信任浏览器发送的 `X-Domain`。

## Deployment

- `Dockerfile` 适合自有服务器或 Kubernetes；运行时通过 env/secret 注入配置。
- `.github/workflows/ci.yml` 在 PR、main 和 semver tag 上运行 typecheck、build、test、Docker build。
- 生产部署前必须配置 `KOKORO_SESSION_INTERNAL_SECRET`，并通过网络 ACL 只允许可信 Web BFF 调用。
- 不把真实 secret 提交到 `.env`、GitHub Actions 日志、Docker image 或任何 shared package。

Gateway 在兼容阶段保持 Web 可见错误语义：上游连接失败或超时返回
`502 {"error":"session_unreachable"}`；上游自身的 HTTP 状态、JSON、SSE、二进制 body、
`content-length` 与 `content-disposition` 按原响应转发。Root-owned API/AIP contract 仍以父仓
`contract/` 为准；本仓不复制或修改 Root Proto/OpenAPI。
跨仓边界与迁移顺序见 `docs/architecture.md`。
