# Gateway architecture and Web handoff

## Repository boundary

`kokoro-gateway` is a separate deployable repository. It must not be added as a `file:` dependency,
git submodule, or workspace member of `kokoro-app`. The Web repository owns its pages, Composer,
capsules, same-origin BFF, Chat adapter, HttpOnly session envelope and Origin checks. This repository
is only an optional transport/ingress adapter. A future independent `kokoro-business` service owns
cross-domain business orchestration, business rules, aggregate DTOs, idempotency storage and audit
authority; those responsibilities must not be moved into this gateway by implication.

The first migration keeps the browser contract stable:

```text
kokoro-app /api/session/*
  → kokoro-app same-origin BFF + Chat adapter
  → (optional) kokoro-gateway Session-compatible /sessions/*
  → kokoro-session
```

Chat is intentionally not exposed as a second `/chat/*` API. The Web Composer and SessionEngine
continue to call `/api/session/sessions/{session_id}/messages`; the Web BFF/Chat adapter either maps
that request directly to Session or maps it to `/sessions/{session_id}/messages` on this gateway when
the optional transport hop is enabled. Project Chat uses the same path and only changes the session
scope/project reference.

For business surfaces, the intended ownership is separate from this Chat transport path:

```text
kokoro-app same-origin /api/* BFF
  → kokoro-business (future business orchestration service)
  → domain services
```

The exact business service API is not implemented or defined in this repository. The routes currently
available in this gateway remain compatibility namespaces for server-only upstream calls; they do not
turn the gateway into the business layer. The current gateway authentication contract accepts the
`kokoro-app` Web BFF service identity; a future Business-to-Gateway hop would require its own explicit
versioned service-auth contract and is outside this repository's current implementation.

The browser never knows the gateway URL and never sends `X-Domain`, `Forwarded`, service credentials,
internal tenant ids, runtime tokens or gateway selectors.

## Credential boundary

The Web BFF sends `x-kokoro-service: web-bff` and `x-kokoro-internal-secret`. The gateway validates
that pair using `KOKORO_GATEWAY_SHARED_SECRET`. The incoming `Authorization: Bearer ...` remains the
user runtime credential and is forwarded to Session; it is never treated as the gateway shared secret.
The gateway emits `x-kokoro-service: kokoro-gateway`, an optional
`x-kokoro-internal-secret` from `KOKORO_SESSION_INTERNAL_SECRET`, and exactly one server-generated
`Forwarded: host=<KOKORO_DOMAIN>`. HTTP `Host` is left to the upstream URL authority.

## Phase 1 transport contract

The compatible upstream covers the existing Web session paths:

- session list, snapshot, message, title and delete;
- event SSE with `Last-Event-ID`;
- run control/HITL;
- model and agent catalog;
- artifact and delivery streaming paths under the allowed Session prefixes;
- billing summary, ledger and model breakdown reads under `/billing/*`, because Web uses the
  same Session-compatible BFF base URL for them.

The gateway also has optional server-only namespaces for the rest of the Web BFF boundary:
`/hub/*`, `/auth/*`, `/bff/*`, `/system/*`, `/connections/*`, `/payment/*`, and
`/billing-service/*`. They are explicit routing namespaces, not browser APIs. `/billing/*` remains
Session-owned so the existing Chat billing reads cannot collide with a separate billing service.
The optional upstreams can be enabled independently; a missing one returns a typed 503 instead of
silently falling back to a fixture or another service.

The gateway forwards these requests without owning Session facts. It must preserve status,
content type, SSE cache headers, opaque ids, request id, binary response headers (`content-length`
and `content-disposition`) and user-visible error semantics. Network failure and timeout are mapped
to the Web-compatible `502 {"error":"session_unreachable"}`. Business idempotency, audit and
cross-service business authorization belong to the relevant business or domain service. The gateway
only transports the already-authenticated server-to-server request and must not implement a second
business authority while Session remains the Chat authority.

The gateway sends `Accept-Encoding: identity` to its upstreams before streaming a response. Node fetch
otherwise transparently decodes compressed bodies while retaining the upstream compressed
`content-length`, which would make an artifact response's framing disagree with its body. The gateway
passes through `content-type`, `content-length`, `content-disposition`, `cache-control` and other
end-to-end headers, while omitting `content-encoding`, cookies, and hop-by-hop headers from the
decoded response.

## Shared contract policy

Root `contract/` is the single source of cross-repository Proto/OpenAPI authority. This repository
may consume generated artifacts and keep implementation notes, but must not create a parallel DTO
source. A future shared package may contain only browser-safe request/response types, Zod schemas,
SSE event names, error codes and client interfaces. Gateway URLs, service secrets, database models,
queues and adapters remain server-only here.

## Migration gates

1. Add `kokoro-gateway` to the Root contract consumer manifest and generate its declared closure.
2. Run the gateway in compatibility mode against a synthetic Session fixture.
3. If the optional hop is selected, point non-production `kokoro-app` `KOKORO_GATEWAY_BASE_URL`
   to the gateway; keep browser paths at `/api/*`. The Web BFF resolves the matching transport
   namespace without exposing the gateway URL to the browser. Chat may instead use a direct
   `kokoro-session` URL during migration.
4. Use explicit `KOKORO_*_BASE_URL` overrides when a bounded context is connected directly or
   migrated separately. A single Gateway base can cover the current transport namespaces, but it is
   not a requirement and does not replace `kokoro-business`.
5. Verify duplicate-submit behavior at the owning business/Session service, then verify SSE reconnect,
   HITL cancel/resume, 401/403/409/5xx,
   artifact streaming and exact `Forwarded` reconstruction for Chat first, then verify each
   optional namespace independently.
6. Only then enable the selected business service path. This gateway remains a transport adapter;
   keep Session as lifecycle/projection owner until any authority transfer is explicitly versioned.
