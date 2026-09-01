# kokoro-gateway deployment

This repository is one independent deployable service. It is not imported into `kokoro-app`; deploy
it as a separate process/container and make the Web BFF the only network caller.

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
KOKORO_SESSION_BASE_URL=http://kokoro-session:8085
KOKORO_SESSION_INTERNAL_SECRET=SECRET_SHARED_WITH_SESSION
```

Optional business upstreams (enable only the services deployed in this environment):

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

## Web BFF binding

In the independently deployed `kokoro-app`, set only the server-side upstream:

```dotenv
KOKORO_SESSION_BASE_URL=http://kokoro-gateway:8080
KOKORO_INTERNAL_SECRET_WEB_BFF=SECRET_SHARED_WITH_WEB_BFF
```

The browser still calls `kokoro-app` `/api/session/*`. No gateway URL or service credential is
added to React code. The Web BFF sends `x-kokoro-service: web-bff` and
`x-kokoro-internal-secret`; the gateway then sends `x-kokoro-service: kokoro-gateway` and the
separate Session credential upstream.

Chat uses this exact path without a new `/chat` surface: `/api/session/*` → `/sessions/*` → Session.
To route the other Web BFF surfaces through the same gateway, point the Web server-only variables
to the gateway root, except for the explicit collision-free payment prefixes:

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
