# Kokoro Gateway code map

`kokoro-gateway` is an independent Fastify/Node service. It is deployed and
versioned separately from `kokoro-app`; it must not be added as a workspace,
file dependency, submodule, or source import of the Web repository.

## Runtime entry points

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | Loads environment configuration and starts Fastify on `HOST`/`PORT`. |
| `src/config.ts` | Validates deployment domain, upstream URLs, secrets, timeout, and body limit. |
| `src/app.ts` | Registers health/readiness endpoints, authenticated route namespaces, header policy, URL mapping, and streaming passthrough. |
| `test/gateway.test.ts` | Synthetic HTTP upstream tests for auth, routing, headers, SSE, artifacts, and failure mapping. |
| `Dockerfile` | Builds and runs only this repository's compiled service. |
| `.github/workflows/ci.yml` | Typecheck, build, test, and image build checks. |
| `.github/workflows/release-image.yml` | Publishes immutable semver-tagged GHCR images. |

## Request boundary

```text
kokoro-app same-origin /api/* BFF
  → kokoro-gateway server-only namespace
  → Session / Hub / User / System / Agent / Payment / Billing upstream
```

The gateway accepts only the Web BFF service credential pair:
`x-kokoro-service: web-bff` and `x-kokoro-internal-secret`. It reconstructs
`x-kokoro-service` and `Forwarded: host=<KOKORO_DOMAIN>` for the selected
upstream. `Host`, `X-Domain`, `X-Forwarded-*`, cookies, service credentials,
and legacy tenant/site headers are not caller-controlled transport context.

Common transport headers are allowlisted in `src/app.ts`. Principal headers
are opt-in per bounded context: Hub and Agent routes can carry the declared
workspace/user scope; Session-compatible Chat routes do not accept principal
headers. The gateway does not own browser UI, session envelopes, Session
facts, fixture data, or runtime namespace authority.

## Route ownership

| Prefix | Upstream | Web capability |
| --- | --- | --- |
| `/sessions`, `/models`, `/agents`, `/artifacts`, `/billing`, `/shared` | Session | Chat, catalog, artifacts, compatibility billing, shared reads |
| `/hub` | Hub | Skills, MCP, connectors, scheduled, settings, mail |
| `/auth`, `/bff` | User | Auth/server BFF and team surfaces |
| `/system` | System | Runtime manifest |
| `/connections` | Agent | Agent connection setup |
| `/payment`, `/billing-service` | Payment/Billing | Explicitly namespaced service surfaces; gateway prefix is stripped upstream |

`docs/api-contract-v1.md` defines the transport contract. Root `contract/`
remains the cross-repository schema authority; this repository does not copy
Root Proto/OpenAPI or create a second business DTO source.
