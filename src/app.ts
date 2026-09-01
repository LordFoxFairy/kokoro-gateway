import { timingSafeEqual } from "node:crypto"
import { Readable } from "node:stream"
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify"
import type { GatewayConfig } from "./config.js"

const ROUTE_METHODS = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"] as const
const BFF_SERVICE = "web-bff"
const GATEWAY_SERVICE = "kokoro-gateway"

type UpstreamKey =
  | "sessionBaseUrl"
  | "hubBaseUrl"
  | "userBaseUrl"
  | "systemBaseUrl"
  | "agentBaseUrl"
  | "paymentBaseUrl"
  | "billingBaseUrl"

type SecretKey =
  | "sessionInternalSecret"
  | "hubInternalSecret"
  | "userInternalSecret"
  | "systemInternalSecret"
  | "agentInternalSecret"
  | "paymentInternalSecret"
  | "billingInternalSecret"

type RouteDefinition = {
  prefix: string
  upstream: UpstreamKey
  secret: SecretKey
  /** Remove the gateway namespace before forwarding, e.g. `/payment/billing/plans`. */
  stripPrefix?: boolean
  /** Principal headers are explicit per bounded context, never global. */
  principalHeaders: readonly string[]
  unavailableError: string
  unreachableError: string
}

// The browser contract stays same-origin in kokoro-app. These are server-only
// gateway namespaces: Session keeps the canonical `/sessions/*` surface for
// Chat; the remaining namespaces let Web BFFs share this deployable gateway
// without importing each other's source code. `/billing` deliberately remains
// Session-owned; storefront/billing services use explicit `/payment` and
// `/billing-service` namespaces to avoid an ambiguous route.
const ROUTES: readonly RouteDefinition[] = [
  { prefix: "/sessions", upstream: "sessionBaseUrl", secret: "sessionInternalSecret", principalHeaders: [], unavailableError: "upstream_not_configured", unreachableError: "session_unreachable" },
  { prefix: "/models", upstream: "sessionBaseUrl", secret: "sessionInternalSecret", principalHeaders: [], unavailableError: "upstream_not_configured", unreachableError: "session_unreachable" },
  { prefix: "/agents", upstream: "sessionBaseUrl", secret: "sessionInternalSecret", principalHeaders: [], unavailableError: "upstream_not_configured", unreachableError: "session_unreachable" },
  { prefix: "/artifacts", upstream: "sessionBaseUrl", secret: "sessionInternalSecret", principalHeaders: [], unavailableError: "upstream_not_configured", unreachableError: "session_unreachable" },
  { prefix: "/billing", upstream: "sessionBaseUrl", secret: "sessionInternalSecret", principalHeaders: [], unavailableError: "upstream_not_configured", unreachableError: "session_unreachable" },
  { prefix: "/shared", upstream: "sessionBaseUrl", secret: "sessionInternalSecret", principalHeaders: [], unavailableError: "upstream_not_configured", unreachableError: "session_unreachable" },
  { prefix: "/hub", upstream: "hubBaseUrl", secret: "hubInternalSecret", principalHeaders: ["x-kokoro-namespace", "x-kokoro-user-id"], unavailableError: "hub_not_configured", unreachableError: "hub_unreachable" },
  { prefix: "/auth", upstream: "userBaseUrl", secret: "userInternalSecret", principalHeaders: [], unavailableError: "user_not_configured", unreachableError: "user_unreachable" },
  { prefix: "/bff", upstream: "userBaseUrl", secret: "userInternalSecret", principalHeaders: ["x-user-id"], unavailableError: "user_not_configured", unreachableError: "user_unreachable" },
  { prefix: "/system", upstream: "systemBaseUrl", secret: "systemInternalSecret", principalHeaders: ["x-kokoro-actor-id"], unavailableError: "system_not_configured", unreachableError: "system_unreachable" },
  { prefix: "/connections", upstream: "agentBaseUrl", secret: "agentInternalSecret", principalHeaders: ["x-kokoro-namespace", "x-kokoro-user-id"], unavailableError: "agent_not_configured", unreachableError: "agent_unreachable" },
  { prefix: "/payment", upstream: "paymentBaseUrl", secret: "paymentInternalSecret", principalHeaders: [], stripPrefix: true, unavailableError: "payment_not_configured", unreachableError: "payment_unreachable" },
  { prefix: "/billing-service", upstream: "billingBaseUrl", secret: "billingInternalSecret", principalHeaders: [], stripPrefix: true, unavailableError: "billing_not_configured", unreachableError: "billing_unreachable" },
]

// Only these caller headers are part of the common public transport.
// Service credentials, principal headers and deployment-context headers are
// reconstructed or explicitly allowed by the route below.
const REQUEST_HEADERS = new Set([
  "accept",
  "authorization",
  "cache-control",
  "content-type",
  "idempotency-key",
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

  const passthrough = (route: RouteDefinition) => async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isTrustedWebBff(request, config.gatewaySharedSecret)) {
      return reply.code(401).send({ error: "unauthorized" })
    }
    const baseUrl = config[route.upstream]
    if (!baseUrl) {
      return reply.code(503).send({ error: route.unavailableError })
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), config.upstreamTimeoutMs)
    const abortOnClientDisconnect = () => controller.abort()
    request.raw.once("aborted", abortOnClientDisconnect)

    try {
      const upstream = await fetch(toUpstreamUrl(baseUrl, request.raw.url ?? "/", route), {
        method: request.method,
        headers: forwardedRequestHeaders(request, config, route),
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
      if (controller.signal.aborted) return reply.code(502).send({ error: route.unreachableError })
      request.log.error({ err: error }, "upstream request failed")
      return reply.code(502).send({ error: route.unreachableError })
    } finally {
      clearTimeout(timeout)
      request.raw.removeListener("aborted", abortOnClientDisconnect)
    }
  }

  for (const route of ROUTES) {
    app.route({ method: [...ROUTE_METHODS], url: route.prefix, handler: passthrough(route) })
    app.route({ method: [...ROUTE_METHODS], url: `${route.prefix}/*`, handler: passthrough(route) })
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

function forwardedRequestHeaders(
  request: FastifyRequest,
  config: GatewayConfig,
  route: RouteDefinition,
): Record<string, string> {
  const headers: Record<string, string> = {
    "x-kokoro-service": config.sessionServiceValue || GATEWAY_SERVICE,
    forwarded: `host=${config.domain}`,
    // Node fetch transparently decodes compressed upstream bodies. Requesting
    // identity keeps an upstream content-length aligned with the stream that
    // Fastify sends to the Web BFF.
    "accept-encoding": "identity",
  }
  const internalSecret = config[route.secret]
  if (internalSecret !== undefined) {
    headers["x-kokoro-internal-secret"] = internalSecret
  }
  for (const [name, value] of Object.entries(request.headers)) {
    const lowerName = name.toLowerCase()
    if (!REQUEST_HEADERS.has(lowerName) && !route.principalHeaders.includes(lowerName)) continue
    if (typeof value === "string") headers[lowerName] = value
    else if (Array.isArray(value)) headers[lowerName] = value.join(", ")
  }
  return headers
}

function toUpstreamUrl(baseUrl: string, incomingUrl: string, route: RouteDefinition): string {
  const base = new URL(baseUrl)
  const incoming = new URL(incomingUrl, "http://gateway.invalid")
  const basePath = base.pathname.replace(/\/+$/, "")
  const path = route.stripPrefix
    ? incoming.pathname.slice(route.prefix.length) || "/"
    : incoming.pathname
  return new URL(`${basePath}${path}${incoming.search}`, base.origin).toString()
}
