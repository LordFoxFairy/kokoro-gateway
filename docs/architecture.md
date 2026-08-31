# Gateway architecture and Web handoff

## Repository boundary

`kokoro-gateway` is a separate deployable repository. It must not be added as a `file:` dependency,
git submodule, or workspace member of `kokoro-app`. The Web repository owns its pages, Composer,
capsules, same-origin BFF, HttpOnly session envelope and Origin checks. The gateway owns business
orchestration and service-to-service adapters.

The first migration keeps the browser contract stable:

```text
kokoro-app /api/session/*
  → kokoro-app server BFF
  → kokoro-gateway Session-compatible /sessions/*
  → kokoro-session
```

The browser never knows the gateway URL and never sends `X-Domain`, `Forwarded`, service credentials,
internal tenant ids, runtime tokens or gateway selectors.

## Credential boundary

The Web BFF sends `x-kokoro-service: web-bff` and `x-kokoro-internal-secret`. The gateway validates
that pair using `KOKORO_GATEWAY_SHARED_SECRET`. The incoming `Authorization: Bearer ...` remains the
user runtime credential and is forwarded to Session; it is never treated as the gateway shared secret.
The gateway emits `x-kokoro-service: kokoro-gateway`, an optional
`x-kokoro-internal-secret` from `KOKORO_SESSION_INTERNAL_SECRET`, and exactly one server-generated
`Forwarded: host=<KOKORO_DOMAIN>`. HTTP `Host` is left to the upstream URL authority.

## Phase 1 contract

The compatible upstream covers the existing Web session paths:

- session list, snapshot, message, title and delete;
- event SSE with `Last-Event-ID`;
- run control/HITL;
- model and agent catalog;
- artifact and delivery streaming paths under the allowed Session prefixes.

The gateway initially forwards these requests without owning Session facts. It must preserve status,
content type, SSE cache headers, opaque ids, request id and user-visible error semantics. Business
idempotency, audit and cross-service authorization are later gateway capabilities; they must not be
implemented twice while Session remains the authority.

## Shared contract policy

Root `contract/` is the single source of cross-repository Proto/OpenAPI authority. This repository
may consume generated artifacts and keep implementation notes, but must not create a parallel DTO
source. A future shared package may contain only browser-safe request/response types, Zod schemas,
SSE event names, error codes and client interfaces. Gateway URLs, service secrets, database models,
queues and adapters remain server-only here.

## Migration gates

1. Add `kokoro-gateway` to the Root contract consumer manifest and generate its declared closure.
2. Run the gateway in compatibility mode against a synthetic Session fixture.
3. Point non-production `kokoro-app` `KOKORO_SESSION_BASE_URL` to the gateway.
4. Verify duplicate-submit idempotency, SSE reconnect, HITL cancel/resume, 401/403/409/5xx,
   artifact streaming and exact `Forwarded` reconstruction.
5. Only then enable gateway-owned orchestration; keep Session as lifecycle/projection owner until
   the authority transfer is explicitly versioned.
