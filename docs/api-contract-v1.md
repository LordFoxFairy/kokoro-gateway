# Kokoro Gateway API Contract v1

本文是 `kokoro-gateway` 与独立 `kokoro-app` Web BFF 的**传输边界**，不是新的业务 DTO
来源。跨仓库 JSON、错误码、SSE event 和 schema 仍以 Root `contract/` 及
`kokoro-app/docs/integration/user-web-api-contract-v4.md` 为准。

## 1. 设计结论

Chat 不新增 `/chat/*` 路由。浏览器只访问 Web 同源路径：

```text
Composer / SessionEngine
  → kokoro-app /api/session/* BFF + Chat adapter
  → (optional) kokoro-gateway /sessions/*
  → kokoro-session
```

Direct Chat 和 Project Chat 都使用这一条链路；项目上下文通过 Session contract 中的
`project_ref`/scope 表达，不通过 Gateway 路由分叉。

`kokoro-app` 的 BFF/Chat adapter 是浏览器契约的所有者：它负责同源路径、HttpOnly session
envelope、Origin 检查、浏览器错误投影和 Chat 请求适配。Gateway 是独立部署进程，不是 Web
workspace package，不包含页面、React 状态、Composer、胶囊、侧栏或 fixture 数据；它只接受
可信 Web BFF 的调用，按配置作为可选传输 hop。当前实现不定义 Business-to-Gateway 的调用
身份；未来若业务服务也需要经过 Gateway，必须另行增加版本化的 service-auth 契约。

跨领域业务编排属于未来独立的 `kokoro-business` 服务，不属于本 Gateway。本文件只定义
Gateway 的 HTTP transport、header、streaming 和 namespace 语义；Business 的业务规则、
聚合 DTO、幂等和审计契约应在其独立子仓库维护。当前已存在的 `/hub/*` 等 namespace 仍按
下文路由表提供兼容透传，不代表 Gateway 拥有这些业务能力。

## 2. 入站认证与上下文

每个业务路由都要求：

```http
x-kokoro-service: web-bff
x-kokoro-internal-secret: <KOKORO_GATEWAY_SHARED_SECRET>
```

浏览器 bearer 不能替代这组服务凭据。Gateway 对每个上游请求重新生成：

```http
x-kokoro-service: <KOKORO_SESSION_SERVICE_VALUE>
Forwarded: host=<KOKORO_DOMAIN>
```

`KOKORO_SESSION_SERVICE_VALUE` 默认为 `kokoro-gateway`，但它是可配置的服务身份值；文档中的
尖括号表示 Gateway 当前运行时配置，而不是浏览器可提交的值。Gateway 到 Session 的
`KOKORO_SESSION_INTERNAL_SECRET` 与 Web BFF 到 Gateway 的共享密钥始终是两组独立凭据。

`Authorization`、`Last-Event-ID`、`x-kokoro-request-id` 和 Web BFF 派生的 principal 头按
**路由所属 bounded context 的 allowlist** 转发：Hub 允许 `x-kokoro-namespace` 与
`x-kokoro-user-id`，User `/bff/*` 只允许 `x-user-id`，System 只允许
`x-kokoro-actor-id`，Agent `/connections/*` 允许 `x-kokoro-namespace` 与
`x-kokoro-user-id`；User `/auth/*`、Session、Payment 和 Billing 面不接收 principal 头。
`Cookie`、`X-Domain`、`Host`、`X-Forwarded-*`、service credential 和旧的 tenant/site header
不转发。Gateway 不信任浏览器自己提供的部署域名。

Principal allowlist is route-scoped and intentionally explicit:

| Gateway route | Principal headers forwarded upstream |
| --- | --- |
| `/hub/*` | `x-kokoro-namespace`, `x-kokoro-user-id` |
| `/bff/*` | `x-user-id` |
| `/system/*` | `x-kokoro-actor-id` |
| `/connections/*` | `x-kokoro-namespace`, `x-kokoro-user-id` |
| `/auth/*`, `/sessions/*`, `/models/*`, `/agents/*`, `/artifacts/*`, `/billing/*`, `/shared/*`, `/payment/*`, `/billing-service/*` | none |

The Web BFF derives these headers from its server-side session envelope before calling the gateway;
the gateway does not derive identity from a browser query, body, or deployment-context header.

这一区分是刻意的：`x-kokoro-namespace` 只表示 Hub 的业务 workspace scope，不是 GA
RuntimeNamespace，也不是浏览器可选择的身份轴。Chat 的 `/sessions/*` 仅接收 Session
传输所需的公共头和服务端 bearer。

### 2.1 Chat compatibility endpoint matrix

Gateway 不重写 Chat 的资源名或 JSON；下表只固定当前 Web BFF 允许通过的 Session 路径。
`{session_id}`、`{run_id}`、`{decision_id}`、`{content_hash}` 和 `{share_id}` 都是不透明引用，
请求体、响应体和 SSE event 的权威字段继续以 `kokoro-app/docs/integration/user-web-api-contract-v4.md`
及 Root `contract/` 为准。

| Method | Gateway path | Web capability | Transport rule |
| --- | --- | --- | --- |
| `GET` | `/sessions` | Session list | Preserve cursor/query and JSON status/body |
| `GET` | `/sessions/{session_id}` | Snapshot | Preserve JSON status/body; `404/410` remains upstream semantics |
| `POST` | `/sessions/{session_id}/messages` | Create message/run | Preserve `project_ref`, agent/model/mode, skills, connectors and idempotency fields |
| `GET` | `/sessions/{session_id}/events` | SSE replay/live stream | Preserve `text/event-stream`, `Last-Event-ID`, cache headers and event bytes |
| `POST` | `/sessions/{session_id}/runs/{run_id}/control` | Cancel/HITL resume | Preserve decision body and receipt/status codes |
| `PATCH` | `/sessions/{session_id}/title` | Rename session | Preserve flat rename receipt and validation errors |
| `DELETE` | `/sessions/{session_id}` | Soft delete | Preserve delete receipt and idempotent status |
| `POST` | `/sessions/{session_id}/share` | Create share | Preserve share receipt and idempotency semantics |
| `DELETE` | `/sessions/{session_id}/share` | Revoke share | Preserve revoke receipt/status |
| `GET` | `/sessions/{session_id}/files/{path}` | Workspace file | Stream binary body and content headers without buffering |
| `GET` | `/sessions/{session_id}/deliveries/{content_hash}` | Delivery download | Stream binary body with `content-length`/`content-disposition` |
| `GET` | `/models` and `/models/*` | Model catalog | Pass through Session catalog response |
| `GET` | `/agents` and `/agents/*` | Agent catalog | Pass through Session catalog response |
| `GET` | `/artifacts` and `/artifacts/*` | Library/artifacts | Preserve cursor and binary projections |
| `GET` | `/billing/*` | Compatibility billing reads | Remains Session-owned; do not route to `/billing-service` |
| `GET` | `/shared/*` | Shared reads | Preserve public shared response/status |

For every listed path, the gateway preserves upstream HTTP status and response body. Network failure
or timeout is mapped only at this transport boundary to the namespace-specific `502` error; upstream
`401/403/409/422/5xx` is not normalized into a generic success or fixture response.

For streamed files and deliveries, the gateway asks the upstream for identity encoding. This avoids
Node fetch transparently decoding a compressed upstream body while leaving its compressed
`content-length` attached to the decoded stream. `content-type`, `content-length`,
`content-disposition`, `cache-control` and other end-to-end response headers are passed through;
`content-encoding` and hop-by-hop headers are not synthesized on the decoded stream.

## 3. 路由表

所有业务路由接受 `GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS`，并保留上游 status、JSON、SSE
和二进制 body。未配置的可选 upstream 返回对应的 `503` typed error；连接失败或超时返回
对应的 `502` typed error。

| Gateway path | Upstream | Forwarded path | Web BFF 对应能力 |
| --- | --- | --- | --- |
| `/sessions/*` | `KOKORO_SESSION_BASE_URL` | 原路径 | Chat sessions、message、Run、HITL、SSE |
| `/models/*` | `KOKORO_SESSION_BASE_URL` | 原路径 | Chat model catalog |
| `/agents/*` | `KOKORO_SESSION_BASE_URL` | 原路径 | Chat agent catalog |
| `/artifacts/*` | `KOKORO_SESSION_BASE_URL` | 原路径 | Library/artifact |
| `/shared/*` | `KOKORO_SESSION_BASE_URL` | 原路径 | Shared read |
| `/billing/*` | `KOKORO_SESSION_BASE_URL` | 原路径 | Chat billing compatibility reads |
| `/hub/*` | `KOKORO_HUB_BASE_URL` | 原路径 | Skills、MCP、connectors、Projects、Scheduled、Settings、Mail |
| `/auth/*`、`/bff/*` | `KOKORO_USER_BASE_URL` | 原路径 | Auth server calls、team BFF |
| `/system/*` | `KOKORO_SYSTEM_BASE_URL` | 原路径 | Runtime manifest |
| `/connections/*` | `KOKORO_AGENT_BASE_URL` | 原路径 | Agent connection setup |
| `/payment/*` | `KOKORO_PAYMENT_BASE_URL` | 去掉 `/payment` | Payment storefront |
| `/billing-service/*` | `KOKORO_BILLING_BASE_URL` | 去掉 `/billing-service` | 独立 billing service |

`/billing/*` 故意保留给 Session。Payment 和独立 Billing 必须使用显式 namespace，防止同一个
`/billing/plans` 在 Session compatibility 与 storefront 之间发生歧义。

## 4. Web 配置方式（可选 Gateway hop）

浏览器配置不变。部署选择 Gateway hop 时，Web BFF 使用以下 server-only 配置：

```dotenv
NEXT_PUBLIC_SESSION_PREVIEW=0
KOKORO_GATEWAY_BASE_URL=http://kokoro-gateway:8080
KOKORO_INTERNAL_SECRET_WEB_BFF=<shared-with-gateway>
KOKORO_WEB_SESSION_SECRET=<web-session-envelope-secret>
```

配置 Gateway 基址后，Web BFF 可按路由使用 `/sessions`、`/hub`、`/system`、`/connections`、
`/payment` 和 `/billing-service` namespace。`KOKORO_*_BASE_URL` 显式值仍可让单个 bounded
context 直连或覆盖 Gateway；浏览器路径和客户端契约保持不变。Chat 在没有 Gateway hop 的
部署中直接使用 `KOKORO_SESSION_BASE_URL` 连接 `kokoro-session`，不新增浏览器 API。

若把其它 Web BFF 也迁移到同一个 Gateway，Web 侧可使用以下 server-only 地址；支付和独立
Billing 使用 namespace 前缀。此配置只选择传输入口，不把 Gateway 变成业务编排服务：

```dotenv
KOKORO_USER_BASE_URL=http://kokoro-gateway:8080
KOKORO_HUB_BASE_URL=http://kokoro-gateway:8080
KOKORO_SYSTEM_BASE_URL=http://kokoro-gateway:8080
KOKORO_AGENT_BASE_URL=http://kokoro-gateway:8080
KOKORO_PAYMENT_BASE_URL=http://kokoro-gateway:8080/payment
KOKORO_BILLING_BASE_URL=http://kokoro-gateway:8080/billing-service
```

Gateway 进程里的同名变量填写真实后端地址，并可为每个 upstream 设置独立的
`KOKORO_*_INTERNAL_SECRET`。变量绝不使用 `NEXT_PUBLIC_*`，也不写入 shared package。

Gateway 运行时还可通过以下变量调整 transport 行为；默认值来自 `.env.example`：

```dotenv
KOKORO_SESSION_SERVICE_VALUE=kokoro-gateway
KOKORO_UPSTREAM_TIMEOUT_MS=30000
KOKORO_GATEWAY_BODY_LIMIT_BYTES=10485760
```

`KOKORO_SESSION_SERVICE_VALUE` 只用于 Gateway → Session 的服务身份头；timeout 和 body limit
只影响 Gateway 自身的请求边界，不改变浏览器 API 或领域业务 DTO。

## 5. Chat 迁移验收

启用 Gateway hop 或迁移 Web 的 `KOKORO_SESSION_BASE_URL` 前，使用合成 Session upstream 验证：

1. `POST /sessions/{id}/messages` 的 JSON body 与 receipt 不变，重复幂等键不重复创建 Run。
2. `GET /sessions/{id}/events` 保持 `text/event-stream`、`Last-Event-ID` 和增量 event。
3. `POST /sessions/{id}/runs/{run_id}/control` 覆盖 cancel/resume/HITL 回执。
4. artifacts/deliveries 保持 `content-type`、`content-length`、`content-disposition` 和流式 body。
5. 401/403/409/422/5xx 保留上游语义；Gateway 只把网络失败映射为对应的 unreachable error。
6. 上游看到的唯一部署上下文为服务端生成的 `Forwarded: host=<KOKORO_DOMAIN>`。

Preview fixture 只能验证 Web UI，不代表 Gateway 或真实 Session 已联调。生产启用前必须
完成真实 upstream、ACL、secret、SSE、HITL、artifact 和回滚验收。

## 6. Project Chat scope transport gate（v223）

Gateway 对 Project Chat 只做传输保真，不解释或授权 `project_ref`：

```text
GET  /sessions?scope=project&project_ref=PROJECT_REF&cursor=CURSOR
  → upstream 同路径与 query

POST /sessions/SESSION_ID/messages
     { ..., "project_ref": "PROJECT_REF" }
  → upstream 同 JSON 字段
```

`PROJECT_REF` 是不透明项目引用；Gateway 不把它转换成 namespace、tenant、域名或路由前缀，也不把
Direct/Project scope 合并。项目归属的首次绑定、后续 mismatch、权限检查、持久化和 Direct/Project
列表过滤由 `kokoro-session` 的 canonical Chat contract 负责。

在 Session 完成以下能力并通过其自身 contract tests 之前，Gateway 只能宣称“project_ref 已透传”，
不能宣称 Project Chat 的 Live 业务闭环：

1. 消息 schema 接收 `project_ref`，且后续消息必须匹配首条消息绑定的项目引用；
2. Session 元数据/存储保留项目归属，但 snapshot、SSE、control 不额外泄露该字段；
3. `GET /sessions?scope=direct` 只返回无项目归属会话，`scope=project&project_ref=...` 只返回精确匹配；
4. Memory/Mongo、分页 cursor、越权和 mismatch 错误均有独立回归测试。

本节是 Gateway 的跨仓库发布门槛说明，不向 `kokoro-app` 引入 `kokoro-session` 源码或 `site` 子目录。
