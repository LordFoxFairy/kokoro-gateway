# Kokoro 统一业务 / Gateway 子仓库契约 v1

状态：实施基线（2026-08-31）。本文件回答一个明确的仓库边界问题：
`kokoro-app` 需要一个统一的服务端业务接入入口，但这个入口不应把所有领域服务的数据和代码
合并到 Web，也不应复制一套平行 DTO。

## 1. 结论

统一业务接入子仓库就是独立的 `LordFoxFairy/kokoro-gateway`：

```text
Browser
  → kokoro-app same-origin /api/* BFF
  → kokoro-gateway server-only unified entry
  → Session / Hub / User / System / Agent / Payment / Billing
```

`kokoro-gateway` 是独立 GitHub 仓库、独立版本线、独立部署单元。它不能作为 Web 的
`workspace:`、`file:`、git submodule 或源码目录引入。浏览器永远不知道 Gateway URL，
也不直接调用领域服务。

## 2. Gateway 统一什么

Gateway 统一的是跨服务接入边界和业务入口，不是所有领域事实：

- Web BFF 服务认证、请求 ID 和受信来源上下文；
- `/sessions`、`/hub`、`/auth`、`/bff`、`/system`、`/connections`、`/payment`、
  `/billing-service` 等 namespace 路由；
- path/query 保留与必要的 namespace 前缀移除；
- principal header 的路由级 allowlist；
- SSE、artifact、file、delivery 的流式透传；
- 上游状态、错误、超时和不可用状态的边界表达；
- 未来显式迁移进来的跨域编排、幂等存储和审计能力。

当前兼容阶段，Gateway 不重复持有 Session、Skill、Project、Billing 或 Runtime 的业务事实。

## 3. 领域服务各自拥有的事实

| 领域服务 | 权威事实与生命周期 |
| --- | --- |
| `kokoro-session` | Session、Message、Run、SSE、HITL、artifact/delivery、Chat billing compatibility |
| `kokoro-hub` | Skills、MCP、Projects、Scheduled、Settings、Mail、workspace capability |
| `kokoro-user` | 登录、会话身份、团队/用户 BFF |
| `kokoro-system` | Runtime manifest、系统配置投影 |
| `kokoro-agent` | Agent connection setup 与连接状态 |
| Payment/Billing | 收银台、订单、独立计费事实 |

Web 只渲染这些领域服务经过 BFF/Gateway 暴露的公开投影；Web 不持有数据库、队列、
runtime JWT、内部 namespace 或服务 secret。

## 4. Web 配置契约

Web 侧生产/集成环境优先只配置一个 server-only 地址：

```dotenv
KOKORO_DOMAIN="app.example.com"
KOKORO_GATEWAY_BASE_URL="http://kokoro-gateway:8080"
KOKORO_INTERNAL_SECRET_WEB_BFF="<web-to-gateway-secret>"
KOKORO_WEB_SESSION_SECRET="<web-session-envelope-secret>"
```

本地对应为：

```dotenv
KOKORO_DOMAIN="dev.kokoro.localhost"
KOKORO_GATEWAY_BASE_URL="http://127.0.0.1:8080"
NEXT_PUBLIC_SESSION_PREVIEW="0"
```

`KOKORO_USER_BASE_URL`、`KOKORO_SESSION_BASE_URL`、`KOKORO_HUB_BASE_URL`、
`KOKORO_SYSTEM_BASE_URL`、`KOKORO_AGENT_BASE_URL`、`KOKORO_PAYMENT_BASE_URL` 和
`KOKORO_BILLING_BASE_URL` 只保留为分阶段迁移覆盖项；统一部署不需要设置它们。

## 5. Gateway 配置契约

Gateway 进程配置真实领域服务地址：

```dotenv
KOKORO_DOMAIN="app.example.com"
KOKORO_GATEWAY_SHARED_SECRET="<web-to-gateway-secret>"
KOKORO_SESSION_BASE_URL="http://kokoro-session:3900"
KOKORO_SESSION_INTERNAL_SECRET="<gateway-to-session-secret>"
KOKORO_USER_BASE_URL="http://kokoro-user:4211"
KOKORO_HUB_BASE_URL="http://kokoro-hub:4251"
KOKORO_SYSTEM_BASE_URL="http://kokoro-system:4240"
KOKORO_AGENT_BASE_URL="http://kokoro-agent:4260"
KOKORO_PAYMENT_BASE_URL="http://kokoro-payment:4241"
KOKORO_BILLING_BASE_URL="http://kokoro-billing:4245"
KOKORO_SESSION_SERVICE_VALUE="kokoro-gateway"
KOKORO_UPSTREAM_TIMEOUT_MS="30000"
KOKORO_GATEWAY_BODY_LIMIT_BYTES="10485760"
```

Web 与 Gateway 的 `KOKORO_DOMAIN` 必须是同一个不带端口的规范 hostname。域名只由 env
切换；浏览器不发送 `X-Domain`、自选 `Forwarded`、Host、tenant/site 或内部身份头。
Gateway 根据服务端配置重新生成：

```http
Forwarded: host=<KOKORO_DOMAIN>
```

`KOKORO_WEB_SESSION_SECRET` 属于 Web BFF 的服务端配置，不会传给 Gateway，也不会进入
浏览器；它用于签发/校验 Web 的 HttpOnly session envelope。只有本地 preview 才可以省略。

`KOKORO_SESSION_SERVICE_VALUE` 可按部署环境覆盖 Gateway → Session 的服务身份值；后两个
变量分别限定上游请求超时和入站 body 大小。它们只属于 Gateway 运行时，不是 Web 浏览器
环境变量。

## 6. API 契约来源与验收顺序

跨仓库 JSON、OpenAPI/Proto、错误码和 SSE event 的单一事实来源仍是 Root `contract/`。
本仓库的两个文档分工如下：

- [`api-contract-v1.md`](./api-contract-v1.md)：Gateway HTTP transport、header、streaming、
  namespace 和 failure mapping；
- 本文件：Web → Gateway → 领域服务的仓库边界、配置和 ownership。

验收顺序固定为：

1. 用合成 Session upstream 验证 Chat message、SSE、HITL、artifact 和 status/body 保真；
2. 用 `KOKORO_GATEWAY_BASE_URL` 让非生产 Web BFF 只连接 Gateway；
3. 逐个接通 Hub、User、System、Agent、Payment、Billing，并验证各自 allowlist；
4. 验证真实 ACL、secret、TLS、域名 `Forwarded`、回滚和重复提交幂等；
5. 完成后才把对应部署标记为 live，不用 preview fixture 代替真实后端联调。

这套拆分使 `kokoro` 保持一个独立的 Web 子仓库，同时让后续业务服务替换、扩展或拆分时，
浏览器 API 和页面组件保持稳定。
