# kokoro-gateway deployment (optional transport hop)

This repository is one independent, optional deployable service. It is not imported into
`kokoro-app`; deploy it as a separate process/container only when an ingress or server-to-server
transport hop is useful. The default Chat path does not require this service:

```text
Browser → kokoro-app BFF /api/session/* → kokoro-session
```

When enabled, the gateway is inserted without changing the browser contract:

```text
Browser → kokoro-app BFF /api/session/* → kokoro-gateway /sessions/* → kokoro-session
```

`kokoro-app` owns the same-origin BFF and Chat adapter, `kokoro-session` owns Chat/session
lifecycle facts, and the future `kokoro-business` service (name pending) owns cross-service
business orchestration. This gateway owns none of those business rules or source-of-truth data.

## Docker

```bash
docker build -t ghcr.io/lordfoxfairy/kokoro-gateway:VERSION .
docker run --rm --name kokoro-gateway \
  --env-file .env.prod \
  -p 8080:8080 \
  ghcr.io/lordfoxfairy/kokoro-gateway:VERSION
```

Required production variables:

```dotenv
NODE_ENV=production
HOST=0.0.0.0
PORT=8080
KOKORO_DOMAIN=app.example.com
KOKORO_GATEWAY_SHARED_SECRET=SECRET_SHARED_WITH_WEB_BFF
KOKORO_SESSION_BASE_URL=http://kokoro-session:3900
KOKORO_SESSION_INTERNAL_SECRET=SECRET_SHARED_WITH_SESSION
KOKORO_SESSION_SERVICE_VALUE=kokoro-gateway
KOKORO_UPSTREAM_TIMEOUT_MS=30000
KOKORO_GATEWAY_BODY_LIMIT_BYTES=10485760
```

Optional downstream transport upstreams (enable only the services deployed in this environment):

These variables configure server-only pass-through destinations. They do not make this gateway a
business layer and do not imply that the gateway owns the corresponding domain. Cross-service
business flows belong in the future `kokoro-business` service (name pending), with the Web BFF
delegating to that service when needed.

```dotenv
KOKORO_USER_BASE_URL=http://kokoro-user:4211
KOKORO_HUB_BASE_URL=http://kokoro-hub:4251
KOKORO_SYSTEM_BASE_URL=http://kokoro-system:4240
KOKORO_AGENT_BASE_URL=http://kokoro-agent:4260
KOKORO_PAYMENT_BASE_URL=http://kokoro-payment:4241
KOKORO_BILLING_BASE_URL=http://kokoro-billing:4245
# Optional per-upstream service credentials:
# KOKORO_USER_INTERNAL_SECRET=...
# KOKORO_HUB_INTERNAL_SECRET=...
# KOKORO_SYSTEM_INTERNAL_SECRET=...
# KOKORO_AGENT_INTERNAL_SECRET=...
# KOKORO_PAYMENT_INTERNAL_SECRET=...
# KOKORO_BILLING_INTERNAL_SECRET=...
```

`KOKORO_GATEWAY_SHARED_SECRET` and `KOKORO_SESSION_INTERNAL_SECRET` are separate credentials. Put
them in the deployment secret store, not in the image or repository. `/healthz` is liveness;
`/readyz` is 503 until the Session upstream is configured.

## Web BFF binding (opt-in)

Only set the server-side Gateway binding in the independently deployed `kokoro-app` when this
optional transport hop is part of the deployment:

```dotenv
KOKORO_GATEWAY_BASE_URL=http://kokoro-gateway:8080
KOKORO_INTERNAL_SECRET_WEB_BFF=SECRET_SHARED_WITH_WEB_BFF
KOKORO_WEB_SESSION_SECRET=SECRET_FOR_WEB_SESSION_ENVELOPE
```

The browser still calls `kokoro-app` `/api/session/*`. No gateway URL or service credential is
added to React code. The Web BFF sends `x-kokoro-service: web-bff` and
`x-kokoro-internal-secret`; the gateway then sends `x-kokoro-service: kokoro-gateway` and the
separate Session credential upstream.

Chat uses this exact path without a new `/chat` surface: `/api/session/*` → optional `/sessions/*`
transport hop → Session.
Without the Gateway binding, `kokoro-app` connects its server-side Chat adapter directly to
`kokoro-session`. For a staged migration, `KOKORO_SESSION_BASE_URL=http://kokoro-gateway:8080`
remains a supported legacy override; `KOKORO_GATEWAY_BASE_URL` is the explicit opt-in binding for
the gateway transport hop.

Other Web BFF surfaces should not be pointed at this gateway merely because it is deployed. Add a
transport route only when the selected deployment needs it; business orchestration still belongs
to `kokoro-business` (name pending). If the other server-only variables intentionally use this
gateway for compatibility transport, the collision-free prefixes are:

```dotenv
KOKORO_USER_BASE_URL=http://kokoro-gateway:8080
KOKORO_HUB_BASE_URL=http://kokoro-gateway:8080
KOKORO_SYSTEM_BASE_URL=http://kokoro-gateway:8080
KOKORO_AGENT_BASE_URL=http://kokoro-gateway:8080
KOKORO_PAYMENT_BASE_URL=http://kokoro-gateway:8080/payment
KOKORO_BILLING_BASE_URL=http://kokoro-gateway:8080/billing-service
```

## Cloud deployment

A platform that builds from GitHub can deploy the repository directly as a Node service. Configure
Node 22, `npm ci`, `npm run build`, and `node dist/index.js`; expose port `PORT` and inject the same
runtime secrets. A container platform can use the provided Dockerfile. In both modes, restrict
inbound traffic to the Web BFF network identity and configure TLS at the edge.

## Release

A strict `vMAJOR.MINOR.PATCH` tag runs CI and publishes a GHCR image through
`.github/workflows/release-image.yml`. Deploy an immutable version tag first; move `latest` only for
a deliberate release. The workflow never receives runtime secrets.
