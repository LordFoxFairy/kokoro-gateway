# Kokoro Business / Gateway 子仓库边界契约 v1

状态：架构基线（2026-09-01）。本文件回答一个明确的仓库边界问题：
`kokoro-app` 需要同源 BFF 来承接浏览器请求，但业务编排不应塞进 Web，也不应把 Gateway
误认为业务层或复制一套平行 DTO。未来业务编排服务与本仓库 Gateway 是两个不同的独立子仓库。

## 1. 结论

浏览器侧的统一业务接入由 `kokoro-app` 的同源 BFF 负责；未来业务层规划为独立的
`kokoro-business` 服务；`kokoro-gateway` 只作为可选的传输/入口适配器：

```text
Browser
  → kokoro-app same-origin /api/* BFF
       ├─ Chat adapter → (optional) kokoro-gateway /sessions/* → kokoro-session
       └─ business adapter → kokoro-business → domain services
```

`kokoro-business` 与 `kokoro-gateway` 都是独立 GitHub 仓库、独立版本线、独立部署单元。它们
不能作为 Web 的 `workspace:`、`file:`、git submodule 或源码目录引入。浏览器永远不知道
Gateway、Business 或领域服务 URL，也不直接调用领域服务。

本文件不宣称 `kokoro-business` 已实现；其仓库名称、HTTP 契约和上线计划需在单独的业务层
设计中确定。本仓库只记录 Gateway 已有的传输路由与边界。

## 2. `kokoro-app`、Business 与 Gateway 各自负责什么

### `kokoro-app`：浏览器同源 BFF 与 Chat adapter

- 浏览器同源 `/api/*` 路径、HttpOnly session envelope、Origin 检查和公开错误投影；
- Composer/SessionEngine 使用的 `/api/session/*` Chat adapter；
- 将 Direct Chat 与 Project Chat 映射到同一 Session contract，并保留 `project_ref`/scope；
- 面向页面的聚合、加载/错误状态和浏览器安全边界。

### `kokoro-business`：未来独立业务编排服务

- 跨领域业务用例、业务规则、聚合 DTO 和业务级幂等/审计策略；
- Projects、Skills、Scheduled、Agents、Billing 等需要跨服务协作的业务流程；
- 通过稳定的服务端契约调用领域服务，不包含 React、浏览器 Cookie 或页面状态。

以上是目标边界，不代表本仓库已经实现 `kokoro-business`。

### `kokoro-gateway`：可选传输/入口适配器

Gateway 只统一 server-to-server 的传输边界，不是业务入口的权威，也不拥有领域事实：

- Web BFF 服务认证、请求 ID 和受信来源上下文的传输处理；
- `/sessions`、`/hub`、`/auth`、`/bff`、`/system`、`/connections`、`/payment`、
  `/billing-service` 等 namespace 路由；
- path/query 保留与必要的 namespace 前缀移除；
- principal header 的路由级 allowlist；
- SSE、artifact、file、delivery 的流式透传；
- 上游状态、错误、超时和不可用状态的边界表达；
- 已由调用方/上游定义好的请求的传输，不在 Gateway 中新增业务规则。

当前实现中，Gateway 可被 `kokoro-app` 的 Chat adapter 选择为中间传输 hop，也可以在本地/迁移
阶段绕过。未来若 `kokoro-business` 需要经过 Gateway，必须先定义独立的 service-auth 与
业务传输契约；这不属于本仓库当前实现。Gateway 不重复持有 Session、Skill、Project、Billing
或 Runtime 的业务事实，也不实现跨领域编排、业务级幂等或审计权威。

## 3. 领域服务各自拥有的事实

| 领域服务 | 权威事实与生命周期 |
| --- | --- |
| `kokoro-session` | Session、Message、Run、SSE、HITL、artifact/delivery、Chat billing compatibility |
| `kokoro-hub` | Skills、MCP、Projects、Scheduled、Settings、Mail、workspace capability |
| `kokoro-user` | 登录、会话身份、团队/用户 BFF |
| `kokoro-system` | Runtime manifest、系统配置投影 |
| `kokoro-agent` | Agent connection setup 与连接状态 |
| Payment/Billing | 收银台、订单、独立计费事实 |

Web 只渲染这些领域服务经过 BFF 暴露的公开投影；Business（实现后）负责跨服务用例，
Gateway 只负责可选传输；Web 不持有数据库、队列、runtime JWT、内部 namespace 或服务
secret。

## 4. Web 配置契约

Web 侧在选择 Gateway 传输 hop 的生产/集成环境可配置一个 server-only 地址：

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
`KOKORO_BILLING_BASE_URL` 可以作为分阶段迁移或直连覆盖项；是否使用 Gateway 由各 BFF 的
部署配置决定。统一设置 Gateway 不是业务层的替代方案。

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
2. 选择 Gateway hop 时，用 `KOKORO_GATEWAY_BASE_URL` 让非生产 Web BFF 通过 Gateway，
   保持浏览器路径为 `/api/*`；Chat 也可以在迁移阶段直连 `kokoro-session`；
3. 业务层实现后，先验证 `kokoro-business` 的业务契约，再逐个接通 Hub、User、System、
   Agent、Payment、Billing，并验证各自 allowlist；
4. 验证真实 ACL、secret、TLS、域名 `Forwarded`、回滚，以及由 Business/Session 所属的
   重复提交幂等；
5. 完成后才把对应部署标记为 live，不用 preview fixture 代替真实后端联调。

这套拆分使 `kokoro` 保持一个独立的 Web 子仓库，同时让 `kokoro-business`、领域服务和
可选 Gateway 在后续替换、扩展或拆分时，浏览器 API 和页面组件保持稳定。
