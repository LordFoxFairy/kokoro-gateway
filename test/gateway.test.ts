import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import test from "node:test"
import { gzipSync } from "node:zlib"
import { buildApp } from "../src/app.js"
import { configFromEnv, type GatewayConfig } from "../src/config.js"

const baseConfig: GatewayConfig = {
  domain: "dev.kokoro.localhost",
  sessionBaseUrl: undefined,
  hubBaseUrl: undefined,
  userBaseUrl: undefined,
  systemBaseUrl: undefined,
  agentBaseUrl: undefined,
  paymentBaseUrl: undefined,
  billingBaseUrl: undefined,
  gatewaySharedSecret: "web-bff-secret",
  sessionInternalSecret: "session-secret",
  hubInternalSecret: "hub-secret",
  userInternalSecret: "user-secret",
  systemInternalSecret: "system-secret",
  agentInternalSecret: "agent-secret",
  paymentInternalSecret: "payment-secret",
  billingInternalSecret: "billing-secret",
  sessionServiceValue: "kokoro-gateway",
  upstreamTimeoutMs: 500,
  bodyLimitBytes: 1024 * 1024,
}

test("normalizes the deployment domain using the Web BFF hostname contract", () => {
  const config = configFromEnv({
    NODE_ENV: "test",
    KOKORO_DOMAIN: "DEV.KOKORO.LOCALHOST.",
    KOKORO_GATEWAY_SHARED_SECRET: "web-bff-secret",
  })
  assert.equal(config.domain, "dev.kokoro.localhost")
  assert.throws(() => configFromEnv({
    NODE_ENV: "test",
    KOKORO_DOMAIN: "dev.kokoro.localhost:3000",
    KOKORO_GATEWAY_SHARED_SECRET: "web-bff-secret",
  }), /hostname without a port/)
})

test("health and readiness distinguish liveness from configured upstream", async () => {
  const notReady = buildApp(baseConfig)
  assert.equal((await notReady.inject("/healthz")).statusCode, 200)
  assert.equal((await notReady.inject("/readyz")).statusCode, 503)
  await notReady.close()

  const ready = buildApp({ ...baseConfig, sessionBaseUrl: "http://127.0.0.1:12345" })
  assert.equal((await ready.inject("/readyz")).statusCode, 200)
  await ready.close()
})

test("accepts the billing paths used by the Web Session client", async () => {
  await withUpstream(async ({ url, headers }) => {
    assert.equal(url, "/billing/summary")
    assert.equal(headers.forwarded, "host=dev.kokoro.localhost")
  }, async (url) => {
    const app = buildApp({ ...baseConfig, sessionBaseUrl: url })
    const response = await app.inject({
      method: "GET",
      url: "/billing/summary",
      headers: { "x-kokoro-service": "web-bff", "x-kokoro-internal-secret": "web-bff-secret" },
    })
    assert.equal(response.statusCode, 200)
    await app.close()
  })
})

test("covers every Web billing compatibility read without routing it to billing-service", async () => {
  const observed: string[] = []
  await withUpstream(async ({ url }) => {
    observed.push(url)
  }, async (url) => {
    const app = buildApp({ ...baseConfig, sessionBaseUrl: url, billingBaseUrl: `${url}/independent-billing` })
    const headers = { "x-kokoro-service": "web-bff", "x-kokoro-internal-secret": "web-bff-secret" }
    for (const path of ["/billing/summary", "/billing/ledger?cursor=CURSOR", "/billing/by-model"]) {
      const response = await app.inject({ method: "GET", url: path, headers })
      assert.equal(response.statusCode, 200)
    }
    await app.close()
  })
  assert.deepEqual(observed, [
    "/billing/summary",
    "/billing/ledger?cursor=CURSOR",
    "/billing/by-model",
  ])
})

test("enforces the principal header allowlist for each bounded-context route", async () => {
  type UpstreamUrlKey =
    | "sessionBaseUrl"
    | "hubBaseUrl"
    | "userBaseUrl"
    | "systemBaseUrl"
    | "agentBaseUrl"
    | "paymentBaseUrl"
    | "billingBaseUrl"
  type Scenario = {
    path: string
    upstream: UpstreamUrlKey
    expected: Record<string, string | undefined>
  }
  const scenarios: Scenario[] = [
    {
      path: "/sessions/session_fixture",
      upstream: "sessionBaseUrl",
      expected: { namespace: undefined, user: undefined, actor: undefined, legacy: undefined },
    },
    {
      path: "/hub/self/skills",
      upstream: "hubBaseUrl",
      expected: { namespace: "namespace_fixture", user: "user_fixture", actor: undefined, legacy: undefined },
    },
    {
      path: "/auth/refresh",
      upstream: "userBaseUrl",
      expected: { namespace: undefined, user: undefined, actor: undefined, legacy: undefined },
    },
    {
      path: "/bff/teams",
      upstream: "userBaseUrl",
      expected: { namespace: undefined, user: undefined, actor: undefined, legacy: "legacy_user_fixture" },
    },
    {
      path: "/system/runtime-manifest",
      upstream: "systemBaseUrl",
      expected: { namespace: undefined, user: undefined, actor: "actor_fixture", legacy: undefined },
    },
    {
      path: "/connections/setup",
      upstream: "agentBaseUrl",
      expected: { namespace: "namespace_fixture", user: "user_fixture", actor: undefined, legacy: undefined },
    },
    {
      path: "/payment/plans",
      upstream: "paymentBaseUrl",
      expected: { namespace: undefined, user: undefined, actor: undefined, legacy: undefined },
    },
    {
      path: "/billing-service/summary",
      upstream: "billingBaseUrl",
      expected: { namespace: undefined, user: undefined, actor: undefined, legacy: undefined },
    },
  ]

  for (const scenario of scenarios) {
    await withUpstream(async ({ headers }) => {
      assert.equal(headers["x-kokoro-namespace"], scenario.expected.namespace)
      assert.equal(headers["x-kokoro-user-id"], scenario.expected.user)
      assert.equal(headers["x-kokoro-actor-id"], scenario.expected.actor)
      assert.equal(headers["x-user-id"], scenario.expected.legacy)
    }, async (url) => {
      const app = buildApp({ ...baseConfig, [scenario.upstream]: url })
      const response = await app.inject({
        method: "GET",
        url: scenario.path,
        headers: {
          "x-kokoro-service": "web-bff",
          "x-kokoro-internal-secret": "web-bff-secret",
          "x-kokoro-namespace": "namespace_fixture",
          "x-kokoro-user-id": "user_fixture",
          "x-kokoro-actor-id": "actor_fixture",
          "x-user-id": "legacy_user_fixture",
        },
      })
      assert.equal(response.statusCode, 200)
      await app.close()
    })
  }
})

test("routes Chat and each business namespace without changing the Web BFF paths", async () => {
  await withUpstream(async ({ url, headers }) => {
    assert.equal(url, "/hub/self/skills/pool?scope=all")
    assert.equal(headers.forwarded, "host=dev.kokoro.localhost")
    assert.equal(headers["x-kokoro-service"], "kokoro-gateway")
    assert.equal(headers["x-kokoro-internal-secret"], "hub-secret")
    assert.equal(headers["x-kokoro-namespace"], "namespace_fixture")
    assert.equal(headers["x-kokoro-user-id"], "user_fixture")
  }, async (url) => {
    const app = buildApp({ ...baseConfig, hubBaseUrl: url })
    const response = await app.inject({
      method: "GET",
      url: "/hub/self/skills/pool?scope=all",
      headers: {
        "x-kokoro-service": "web-bff",
        "x-kokoro-internal-secret": "web-bff-secret",
        "x-kokoro-namespace": "namespace_fixture",
        "x-kokoro-user-id": "user_fixture",
      },
    })
    assert.equal(response.statusCode, 200)
    await app.close()
  })

  await withUpstream(async ({ url, headers }) => {
    assert.equal(url, "/connections/setup?platform=telegram")
    assert.equal(headers["x-kokoro-internal-secret"], "agent-secret")
    assert.equal(headers["x-kokoro-namespace"], "namespace_fixture")
    assert.equal(headers["x-kokoro-user-id"], "user_fixture")
  }, async (url) => {
    const app = buildApp({ ...baseConfig, agentBaseUrl: url })
    const response = await app.inject({
      method: "GET",
      url: "/connections/setup?platform=telegram",
      headers: {
        "x-kokoro-service": "web-bff",
        "x-kokoro-internal-secret": "web-bff-secret",
        "x-kokoro-namespace": "namespace_fixture",
        "x-kokoro-user-id": "user_fixture",
      },
    })
    assert.equal(response.statusCode, 200)
    await app.close()
  })

  await withUpstream(async ({ url }) => {
    assert.equal(url, "/billing/plans")
  }, async (url) => {
    const app = buildApp({ ...baseConfig, paymentBaseUrl: url })
    const response = await app.inject({
      method: "GET",
      url: "/payment/billing/plans",
      headers: { "x-kokoro-service": "web-bff", "x-kokoro-internal-secret": "web-bff-secret" },
    })
    assert.equal(response.statusCode, 200)
    await app.close()
  })
})

test("accepts only the Web BFF service credential, not the browser bearer", async () => {
  const app = buildApp({ ...baseConfig, sessionBaseUrl: "http://session.invalid" })
  const browserBearer = await app.inject({
    method: "GET",
    url: "/sessions",
    headers: { authorization: "Bearer web-bff-secret" },
  })
  assert.equal(browserBearer.statusCode, 401)

  const missingService = await app.inject({
    method: "GET",
    url: "/sessions",
    headers: { "x-kokoro-internal-secret": "web-bff-secret" },
  })
  assert.equal(missingService.statusCode, 401)
  await app.close()
})

async function withUpstream(
  handler: (request: { method: string; url: string; headers: Record<string, string | undefined>; body: Buffer }) => void | Promise<void>,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    await handler({
      method: request.method ?? "GET",
      url: request.url ?? "/",
      headers: {
        host: header(request.headers.host),
        forwarded: header(request.headers.forwarded),
        authorization: header(request.headers.authorization),
        "x-kokoro-service": header(request.headers["x-kokoro-service"]),
        "x-kokoro-internal-secret": header(request.headers["x-kokoro-internal-secret"]),
        "x-kokoro-namespace": header(request.headers["x-kokoro-namespace"]),
        "x-kokoro-user-id": header(request.headers["x-kokoro-user-id"]),
        "x-kokoro-actor-id": header(request.headers["x-kokoro-actor-id"]),
        "x-user-id": header(request.headers["x-user-id"]),
        "x-forwarded-for": header(request.headers["x-forwarded-for"]),
        "x-domain": header(request.headers["x-domain"]),
        "x-kokoro-request-id": header(request.headers["x-kokoro-request-id"]),
      },
      body: Buffer.concat(chunks),
    })
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ ok: true }))
  })
  upstream.listen(0, "127.0.0.1")
  await once(upstream, "listening")
  const address = upstream.address()
  assert.ok(address && typeof address !== "string")
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    upstream.close()
    await once(upstream, "close")
  }
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

test("rebuilds trusted Forwarded and preserves the user runtime bearer", async () => {
  await withUpstream(async ({ url, headers, body }) => {
    assert.equal(url, "/sessions/session_fixture/messages?view=full")
    assert.equal(headers.host?.startsWith("127.0.0.1:"), true)
    assert.equal(headers.forwarded, "host=dev.kokoro.localhost")
    assert.equal(headers.authorization, "Bearer runtime-jwt-fixture")
    assert.equal(headers["x-kokoro-service"], "kokoro-gateway")
    assert.equal(headers["x-kokoro-internal-secret"], "session-secret")
    assert.equal(headers["x-kokoro-namespace"], undefined)
    assert.equal(headers["x-kokoro-user-id"], undefined)
    assert.equal(headers["x-forwarded-for"], undefined)
    assert.equal(headers["x-domain"], undefined)
    assert.equal(headers["x-kokoro-request-id"], "request-fixture")
    assert.deepEqual(JSON.parse(body.toString("utf8")), { message: "fixture" })
  }, async (url) => {
    const app = buildApp({ ...baseConfig, sessionBaseUrl: url })
    const response = await app.inject({
      method: "POST",
      url: "/sessions/session_fixture/messages?view=full",
      headers: {
        authorization: "Bearer runtime-jwt-fixture",
        "x-kokoro-service": "web-bff",
        "x-kokoro-internal-secret": "web-bff-secret",
        "x-forwarded-for": "attacker",
        forwarded: "for=attacker",
        "x-domain": "evil.test",
        "x-kokoro-namespace": "attacker_namespace",
        "x-kokoro-user-id": "attacker_user",
        "x-kokoro-request-id": "request-fixture",
        "content-type": "application/json",
      },
      payload: JSON.stringify({ message: "fixture" }),
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { ok: true })
    await app.close()
  })
})

test("forwards the complete Chat message, control, share, and file path surface", async () => {
  const observed: Array<{ method: string; url: string; body: string }> = []
  await withUpstream(async ({ method, url, body }) => {
    observed.push({ method, url, body: body.toString("utf8") })
  }, async (url) => {
    const app = buildApp({ ...baseConfig, sessionBaseUrl: url })
    const headers = { "x-kokoro-service": "web-bff", "x-kokoro-internal-secret": "web-bff-secret" }
    const requests = [
      { method: "POST", url: "/sessions/SESSION_ID/messages", payload: { content: "hello", idempotency_key: "KEY" } },
      { method: "POST", url: "/sessions/SESSION_ID/runs/RUN_ID/control", payload: { kind: "run.cancel", decision_id: "DECISION_ID" } },
      { method: "PATCH", url: "/sessions/SESSION_ID/title", payload: { title: "Fixture title" } },
      { method: "DELETE", url: "/sessions/SESSION_ID", payload: undefined },
      { method: "POST", url: "/sessions/SESSION_ID/share", payload: { expires_in: 3600 } },
      { method: "DELETE", url: "/sessions/SESSION_ID/share", payload: undefined },
      { method: "GET", url: "/sessions/SESSION_ID/files/fixture.txt", payload: undefined },
      { method: "GET", url: "/sessions/SESSION_ID/deliveries/CONTENT_HASH", payload: undefined },
    ] as const
    for (const request of requests) {
      const response = await app.inject({
        method: request.method,
        url: request.url,
        headers: request.payload === undefined ? headers : { ...headers, "content-type": "application/json" },
        ...(request.payload === undefined ? {} : { payload: JSON.stringify(request.payload) }),
      })
      assert.equal(response.statusCode, 200)
    }
    await app.close()
  })
  assert.deepEqual(observed, [
    { method: "POST", url: "/sessions/SESSION_ID/messages", body: '{"content":"hello","idempotency_key":"KEY"}' },
    { method: "POST", url: "/sessions/SESSION_ID/runs/RUN_ID/control", body: '{"kind":"run.cancel","decision_id":"DECISION_ID"}' },
    { method: "PATCH", url: "/sessions/SESSION_ID/title", body: '{"title":"Fixture title"}' },
    { method: "DELETE", url: "/sessions/SESSION_ID", body: "" },
    { method: "POST", url: "/sessions/SESSION_ID/share", body: '{"expires_in":3600}' },
    { method: "DELETE", url: "/sessions/SESSION_ID/share", body: "" },
    { method: "GET", url: "/sessions/SESSION_ID/files/fixture.txt", body: "" },
    { method: "GET", url: "/sessions/SESSION_ID/deliveries/CONTENT_HASH", body: "" },
  ])
})

test("passes an SSE stream through without converting it to JSON", async () => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    response.write("event: message\\ndata: fixture\\n\\n")
    response.end()
  })
  upstream.listen(0, "127.0.0.1")
  await once(upstream, "listening")
  const address = upstream.address()
  assert.ok(address && typeof address !== "string")
  const app = buildApp({ ...baseConfig, sessionBaseUrl: `http://127.0.0.1:${address.port}` })
  const listener = await app.listen({ host: "127.0.0.1", port: 0 })
  try {
    const response = await fetch(`${listener}/agents/run?stream=true`, {
      headers: {
        accept: "text/event-stream",
        authorization: "Bearer runtime-jwt-fixture",
        "x-kokoro-service": "web-bff",
        "x-kokoro-internal-secret": "web-bff-secret",
      },
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("content-type"), "text/event-stream")
    assert.match(await response.text(), /data: fixture/)
  } finally {
    await app.close()
    upstream.close()
    await once(upstream, "close")
  }
})

test("keeps compressed upstream responses from corrupting file content-length", async () => {
  const payload = Buffer.from("synthetic artifact payload")
  const compressed = gzipSync(payload)
  const upstream = createServer((request, response) => {
    if (request.headers["accept-encoding"]?.includes("gzip")) {
      response.writeHead(200, {
        "content-type": "application/pdf",
        "content-encoding": "gzip",
        "content-length": String(compressed.length),
        "cache-control": "private, no-store",
        "content-disposition": 'attachment; filename="fixture.pdf"',
      })
      response.end(compressed)
      return
    }
    response.writeHead(200, {
      "content-type": "application/pdf",
      "content-length": String(payload.length),
      "cache-control": "private, no-store",
      "content-disposition": 'attachment; filename="fixture.pdf"',
    })
    response.end(payload)
  })
  upstream.listen(0, "127.0.0.1")
  await once(upstream, "listening")
  const address = upstream.address()
  assert.ok(address && typeof address !== "string")
  const app = buildApp({ ...baseConfig, sessionBaseUrl: `http://127.0.0.1:${address.port}` })
  const listener = await app.listen({ host: "127.0.0.1", port: 0 })
  try {
    const response = await fetch(`${listener}/sessions/session_fixture/deliveries/CONTENT_HASH`, {
      headers: {
        accept: "application/pdf",
        "accept-encoding": "gzip",
        "x-kokoro-service": "web-bff",
        "x-kokoro-internal-secret": "web-bff-secret",
      },
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("content-length"), String(payload.length))
    assert.equal(response.headers.get("cache-control"), "private, no-store")
    assert.equal(response.headers.get("content-disposition"), 'attachment; filename="fixture.pdf"')
    assert.equal(response.headers.get("content-encoding"), null)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload)
  } finally {
    await app.close()
    upstream.close()
    await once(upstream, "close")
  }
})

test("maps Session upstream timeouts to the Web session_unreachable error", async () => {
  const upstream = createServer((_request, response) => {
    setTimeout(() => response.end(JSON.stringify({ late: true })), 100)
  })
  upstream.listen(0, "127.0.0.1")
  await once(upstream, "listening")
  const address = upstream.address()
  assert.ok(address && typeof address !== "string")
  const app = buildApp({
    ...baseConfig,
    sessionBaseUrl: `http://127.0.0.1:${address.port}`,
    upstreamTimeoutMs: 10,
  })
  try {
    const response = await app.inject({
      method: "GET",
      url: "/sessions/session_fixture",
      headers: { "x-kokoro-service": "web-bff", "x-kokoro-internal-secret": "web-bff-secret" },
    })
    assert.equal(response.statusCode, 502)
    assert.deepEqual(response.json(), { error: "session_unreachable" })
  } finally {
    await app.close()
    upstream.close()
    await once(upstream, "close")
  }
})

test("preserves fixed artifact response headers and maps upstream failures", async () => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "application/pdf",
      "content-length": "7",
      "content-disposition": "attachment; filename=fixture.pdf",
    })
    response.end("fixture")
  })
  upstream.listen(0, "127.0.0.1")
  await once(upstream, "listening")
  const address = upstream.address()
  assert.ok(address && typeof address !== "string")
  const app = buildApp({ ...baseConfig, sessionBaseUrl: `http://127.0.0.1:${address.port}` })
  try {
    const response = await app.inject({
      method: "GET",
      url: "/artifacts/fixture.pdf",
      headers: { "x-kokoro-service": "web-bff", "x-kokoro-internal-secret": "web-bff-secret" },
    })
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers["content-type"], "application/pdf")
    assert.equal(response.headers["content-length"], "7")
    assert.equal(response.headers["content-disposition"], "attachment; filename=fixture.pdf")
    assert.equal(response.body, "fixture")
  } finally {
    await app.close()
    upstream.close()
    await once(upstream, "close")
  }

  const unavailable = buildApp({ ...baseConfig, sessionBaseUrl: "http://127.0.0.1:1" })
  const failed = await unavailable.inject({
    method: "GET",
    url: "/sessions",
    headers: { "x-kokoro-service": "web-bff", "x-kokoro-internal-secret": "web-bff-secret" },
  })
  assert.equal(failed.statusCode, 502)
  assert.deepEqual(failed.json(), { error: "session_unreachable" })
  await unavailable.close()
})
