# @kokoro/gateway

`kokoro-gateway` 是 Kokoro 的独立、可选的传输/入口适配子仓库。它不是 Web 应用、不是
`kokoro-app` 的 BFF，也不是业务编排层或 workspace package。浏览器同源 BFF 与浏览器可见
的业务聚合由 `kokoro-app` 负责；未来跨领域的业务编排由独立的 `kokoro-business` 服务负责。

Chat 在 Web 侧的准确承接仍是 **`kokoro-app` 的 `/api/session/*` BFF/Chat adapter**，不是另造
一个浏览器 `/chat/*` API。Web BFF 可以在部署中选择直连 `kokoro-session`，也可以把同一请求
转给本仓库的 Session-compatible `/sessions/*`，再由本仓库透传给 Session。Direct Chat 与
Project Chat 只在 Session scope/project_ref 上不同，消息、Run、SSE、HITL、取消、文件、成果
和分享继续共用这一条承接链路。

本阶段保留与 `kokoro-app` 当前 BFF 兼容的 Session upstream 及若干可选路由 namespace。它们
只提供路由、认证边界和流式透传，不把 Hub、User、System、Agent、Payment 或 Billing 的业务
编排搬进网关：

```text
Browser
  → kokoro-app same-origin /api/session/* BFF + Chat adapter
  → (optional) kokoro-gateway /sessions/*
  → kokoro-session
```

浏览器路径不变。部署选择 Gateway 时，Web 只配置 server-only 的
`KOKORO_GATEWAY_BASE_URL=http://kokoro-gateway:8080`，并由 BFF 按 namespace 调用本仓库；
分阶段迁移也可以用 `KOKORO_SESSION_BASE_URL` 让 Chat 直连 Session，或让单个业务 BFF 直连
自己的服务。所有配置都不进入前端，也不会把 gateway URL、token 或 header selector 暴露给
浏览器。

完整的 Chat、业务 namespace、认证边界与迁移验收见 [`docs/api-contract-v1.md`](docs/api-contract-v1.md)。

## 当前边界

网关负责：

- 校验 `x-kokoro-service: web-bff` 与 `x-kokoro-internal-secret`；
- 重新生成唯一的 RFC 7239 `Forwarded: host=<KOKORO_DOMAIN>`；
- 保留用户 runtime `Authorization`，并用独立 session service credential 调用 Session；
- 统一超时、错误和 request id 传递；
- JSON、SSE、artifact 流式透传，不把 SSE 缓冲成 JSON；
- 在需要时承接 server-only 的入口路由；幂等、审计和跨服务业务编排由业务服务或领域服务
  按其契约负责，不在本仓库重复实现。

网关不负责：

- UI、Composer、胶囊、路由或 React 状态；
- HttpOnly 登录信封、refresh 和浏览器 Origin 检查（这些属于 `kokoro-app` BFF）；
- Session 消息/事件/文件事实、Agent 执行、模型 Provider、Billing、Capability 数据库；
- 跨领域业务用例、业务规则、聚合 DTO、幂等存储和审计权威（规划中的 `kokoro-business`）；
- `Host`、`X-Domain`、`X-Forwarded-*` 等浏览器可控部署上下文；
- 共享 package 中的业务实现或密钥。

## Routes

Chat/Session 主路由：

- `GET /healthz`
- `GET /readyz`
- `GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS /sessions[/*]`
- 同样的方法和路径范围：`/models[/*]`、`/agents[/*]`、`/artifacts[/*]`、`/billing[/*]`、`/shared[/*]`

`/billing/summary`、`/billing/ledger` 与 `/billing/by-model` 目前也由 Web 的
`/api/session` client 发起；当 Chat 选择 Gateway hop 时，它们可和 Chat 一起经过兼容网关，
也可在直连迁移阶段使用 Session base URL。它们仍由 Session/Hub 提供事实，Gateway 不在此
阶段实现计费规则。

可选 server-only 路由（配置对应 upstream 后启用；这些是传输 namespace，不代表网关拥有业务
编排）：

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

在 `kokoro-app/.env.local` 中保留同源 Web BFF 语义，新部署只配置 Gateway 的 authority
root（不要写成 `.../sessions`）：

```dotenv
KOKORO_GATEWAY_BASE_URL=http://127.0.0.1:8080
KOKORO_INTERNAL_SECRET_WEB_BFF=replace-with-web-bff-secret
```

这一个 Web 变量可供选择 Gateway 的 BFF 请求进入对应 namespace：Web BFF 在 path 上生成
`/sessions/*`、`/auth/*`、`/bff/*`、`/hub/*`、`/system/*`、`/connections/*`，支付 adapter
使用 `/payment/*` 和 `/billing-service/*`。是否使用 Gateway 由各 BFF 的部署配置决定；显式
的 `KOKORO_*_BASE_URL` 仍可单独覆盖，用于分阶段迁移：

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
localStorage、URL 或公开 UI。网关不会信任浏览器发送的 `X-Domain`。`kokoro-business` 的
业务契约与实现属于其独立子仓库，不在本仓库复制。

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
