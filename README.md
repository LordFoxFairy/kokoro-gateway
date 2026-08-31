# @kokoro/gateway

`kokoro-gateway` 是 Kokoro 的独立业务编排与服务间网关子仓库。它不是 Web 应用、不是
`kokoro-platform` 的业务模块，也不是 `kokoro-app` 的 workspace package。

第一阶段提供与 `kokoro-app` 当前 BFF 兼容的 Session upstream：

```text
Browser
  → same-origin kokoro-app /api/session/*
  → server-only kokoro-app BFF
  → kokoro-gateway /sessions/*
  → kokoro-session
```

浏览器路径不变。`kokoro-app` 只需要把 server-only 的 `KOKORO_SESSION_BASE_URL` 指向网关，
不在前端增加 gateway URL、token 或 header selector。

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

当前只暴露 Session-compatible upstream：

- `GET /healthz`
- `GET /readyz`
- `GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS /sessions[/*]`
- 同样的方法和路径范围：`/models[/*]`、`/agents[/*]`、`/artifacts[/*]`

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

在 `kokoro-app/.env.local` 中保留同源 Web BFF 语义，只有 server-only upstream 改为：

```dotenv
KOKORO_SESSION_BASE_URL=http://127.0.0.1:8080
KOKORO_INTERNAL_SECRET_WEB_BFF=replace-with-web-bff-secret
```

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

Root-owned API/AIP contract 仍以父仓 `contract/` 为准；本仓不复制或修改 Root Proto/OpenAPI。
跨仓边界与迁移顺序见 `docs/architecture.md`。
