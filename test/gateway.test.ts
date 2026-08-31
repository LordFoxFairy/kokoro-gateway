import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import test from "node:test"
import { buildApp } from "../src/app.js"
import type { GatewayConfig } from "../src/config.js"

const baseConfig: GatewayConfig = {
  domain: "dev.kokoro.localhost",
  sessionBaseUrl: undefined,
  gatewaySharedSecret: "web-bff-secret",
  sessionInternalSecret: "session-secret",
  sessionServiceValue: "kokoro-gateway",
  upstreamTimeoutMs: 500,
  bodyLimitBytes: 1024 * 1024,
}

test("health and readiness distinguish liveness from configured upstream", async () => {
  const notReady = buildApp(baseConfig)
  assert.equal((await notReady.inject("/healthz")).statusCode, 200)
  assert.equal((await notReady.inject("/readyz")).statusCode, 503)
  await notReady.close()

  const ready = buildApp({ ...baseConfig, sessionBaseUrl: "http://127.0.0.1:12345" })
  assert.equal((await ready.inject("/readyz")).statusCode, 200)
  await ready.close()
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
  handler: (request: { url: string; headers: Record<string, string | undefined>; body: Buffer }) => void | Promise<void>,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    await handler({
      url: request.url ?? "/",
      headers: {
        host: header(request.headers.host),
        forwarded: header(request.headers.forwarded),
        authorization: header(request.headers.authorization),
        "x-kokoro-service": header(request.headers["x-kokoro-service"]),
        "x-kokoro-internal-secret": header(request.headers["x-kokoro-internal-secret"]),
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
