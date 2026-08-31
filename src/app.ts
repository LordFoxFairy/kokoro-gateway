import { timingSafeEqual } from "node:crypto"
import { Readable } from "node:stream"
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify"
import type { GatewayConfig } from "./config.js"

const ROUTE_PREFIXES = ["/sessions", "/models", "/agents", "/artifacts"] as const
const ROUTE_METHODS = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"] as const
const BFF_SERVICE = "web-bff"
const GATEWAY_SERVICE = "kokoro-gateway"

// Only these caller headers are part of the Session-compatible public transport.
// Service credentials and all deployment-context headers are reconstructed below.
const REQUEST_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "authorization",
  "cache-control",
  "content-type",
  "if-match",
  "if-none-match",
  "if-modified-since",
  "last-event-id",
  "prefer",
  "user-agent",
  "x-kokoro-request-id",
  "traceparent",
  "tracestate",
])
const RESPONSE_HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "content-encoding",
  "set-cookie",
])

export function buildApp(config: GatewayConfig): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: config.bodyLimitBytes })
  app.removeAllContentTypeParsers()
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => done(null, body))

  app.get("/healthz", async () => ({ status: "ok" }))
  app.get("/readyz", async (_request, reply) => {
    if (!config.sessionBaseUrl) {
      return reply.code(503).send({ status: "not_ready", reason: "live_upstream_not_configured" })
    }
    return { status: "ready" }
  })

  const passthrough = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isTrustedWebBff(request, config.gatewaySharedSecret)) {
      return reply.code(401).send({ error: "unauthorized" })
    }
    if (!config.sessionBaseUrl) {
      return reply.code(503).send({ error: "upstream_not_configured" })
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), config.upstreamTimeoutMs)
    const abortOnClientDisconnect = () => controller.abort()
    request.raw.once("aborted", abortOnClientDisconnect)

    try {
      const upstream = await fetch(toUpstreamUrl(config.sessionBaseUrl, request.raw.url ?? "/"), {
        method: request.method,
        headers: forwardedRequestHeaders(request, config),
        body: ["GET", "HEAD", "DELETE", "OPTIONS"].includes(request.method)
          ? undefined
          : request.body instanceof Buffer && request.body.length > 0
            ? request.body
            : undefined,
        signal: controller.signal,
        duplex: "half",
      } as RequestInit & { duplex: "half" })

      reply.code(upstream.status)
      for (const [name, value] of upstream.headers) {
        if (!RESPONSE_HOP_BY_HOP_HEADERS.has(name.toLowerCase())) reply.header(name, value)
      }
      if (!upstream.body) return reply.send()
      // Keep SSE and artifact bodies as a stream; do not buffer them in the gateway.
      // Node's undici and stream/web declarations expose equivalent streams
      // through different lib.dom versions; the runtime value is the Node
      // fetch stream accepted by Readable.fromWeb.
      return reply.send(Readable.fromWeb(upstream.body as never))
    } catch (error) {
      if (controller.signal.aborted) return reply.code(504).send({ error: "upstream_timeout" })
      request.log.error({ err: error }, "upstream request failed")
      return reply.code(502).send({ error: "upstream_unavailable" })
    } finally {
      clearTimeout(timeout)
      request.raw.removeListener("aborted", abortOnClientDisconnect)
    }
  }

  for (const prefix of ROUTE_PREFIXES) {
    app.route({ method: [...ROUTE_METHODS], url: prefix, handler: passthrough })
    app.route({ method: [...ROUTE_METHODS], url: `${prefix}/*`, handler: passthrough })
  }
  return app
}

function isTrustedWebBff(request: FastifyRequest, sharedSecret: string): boolean {
  const service = request.headers["x-kokoro-service"]
  const provided = request.headers["x-kokoro-internal-secret"]
  return service === BFF_SERVICE && typeof provided === "string" && constantTimeEqual(provided, sharedSecret)
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  if (leftBytes.length !== rightBytes.length) return false
  return timingSafeEqual(leftBytes, rightBytes)
}

function forwardedRequestHeaders(request: FastifyRequest, config: GatewayConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "x-kokoro-service": config.sessionServiceValue || GATEWAY_SERVICE,
    forwarded: `host=${config.domain}`,
  }
  if (config.sessionInternalSecret !== undefined) {
    headers["x-kokoro-internal-secret"] = config.sessionInternalSecret
  }
  for (const [name, value] of Object.entries(request.headers)) {
    const lowerName = name.toLowerCase()
    if (!REQUEST_HEADERS.has(lowerName)) continue
    if (typeof value === "string") headers[lowerName] = value
    else if (Array.isArray(value)) headers[lowerName] = value.join(", ")
  }
  return headers
}

function toUpstreamUrl(baseUrl: string, incomingUrl: string): string {
  const base = new URL(baseUrl)
  const incoming = new URL(incomingUrl, "http://gateway.invalid")
  const basePath = base.pathname.replace(/\/+$/, "")
  return new URL(`${basePath}${incoming.pathname}${incoming.search}`, base.origin).toString()
}
