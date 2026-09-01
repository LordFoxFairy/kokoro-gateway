export interface GatewayConfig {
  /** Deployment hostname used only to construct the server-side Forwarded context. */
  domain: string
  /** Session-compatible upstream. Missing means the process is intentionally not ready. */
  sessionBaseUrl: string | undefined
  /** Optional business upstreams. The gateway remains useful when only Session is deployed. */
  hubBaseUrl: string | undefined
  userBaseUrl: string | undefined
  systemBaseUrl: string | undefined
  agentBaseUrl: string | undefined
  paymentBaseUrl: string | undefined
  billingBaseUrl: string | undefined
  /** Credential accepted only from the trusted Web BFF service boundary. */
  gatewaySharedSecret: string
  /** Separate credential used when this gateway calls kokoro-session. */
  sessionInternalSecret: string | undefined
  hubInternalSecret: string | undefined
  userInternalSecret: string | undefined
  systemInternalSecret: string | undefined
  agentInternalSecret: string | undefined
  paymentInternalSecret: string | undefined
  billingInternalSecret: string | undefined
  sessionServiceValue: string
  upstreamTimeoutMs: number
  bodyLimitBytes: number
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function positiveInteger(value: string | undefined, name: string, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

function validateBaseUrl(value: string | undefined, name: string): string | undefined {
  if (!value) return undefined
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must use http or https`)
  }
  if (url.search || url.hash) throw new Error(`${name} must not contain query or hash`)
  return url.toString().replace(/\/$/, "")
}

function validateDomain(value: string): string {
  const domain = value.trim().toLowerCase().replace(/\.$/u, "")
  if (domain.length === 0 || domain.length > 253 || /[\s/?#:]/u.test(domain)) {
    throw new Error("KOKORO_DOMAIN must be a hostname without a port")
  }
  const labels = domain.split(".")
  if (labels.some((label) =>
    label.length === 0 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
  )) {
    throw new Error("KOKORO_DOMAIN must be a hostname without a port")
  }
  return domain
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const sessionBaseUrl = validateBaseUrl(env.KOKORO_SESSION_BASE_URL?.trim() || undefined, "KOKORO_SESSION_BASE_URL")
  if (env.NODE_ENV === "production" && !env.KOKORO_SESSION_INTERNAL_SECRET?.trim()) {
    throw new Error("KOKORO_SESSION_INTERNAL_SECRET is required in production")
  }
  return {
    domain: validateDomain(required(env, "KOKORO_DOMAIN")),
    sessionBaseUrl,
    hubBaseUrl: validateBaseUrl(env.KOKORO_HUB_BASE_URL?.trim() || undefined, "KOKORO_HUB_BASE_URL"),
    userBaseUrl: validateBaseUrl(env.KOKORO_USER_BASE_URL?.trim() || undefined, "KOKORO_USER_BASE_URL"),
    systemBaseUrl: validateBaseUrl(env.KOKORO_SYSTEM_BASE_URL?.trim() || undefined, "KOKORO_SYSTEM_BASE_URL"),
    agentBaseUrl: validateBaseUrl(env.KOKORO_AGENT_BASE_URL?.trim() || undefined, "KOKORO_AGENT_BASE_URL"),
    paymentBaseUrl: validateBaseUrl(env.KOKORO_PAYMENT_BASE_URL?.trim() || undefined, "KOKORO_PAYMENT_BASE_URL"),
    billingBaseUrl: validateBaseUrl(env.KOKORO_BILLING_BASE_URL?.trim() || undefined, "KOKORO_BILLING_BASE_URL"),
    gatewaySharedSecret: required(env, "KOKORO_GATEWAY_SHARED_SECRET"),
    sessionInternalSecret: env.KOKORO_SESSION_INTERNAL_SECRET?.trim() || undefined,
    hubInternalSecret: env.KOKORO_HUB_INTERNAL_SECRET?.trim() || undefined,
    userInternalSecret: env.KOKORO_USER_INTERNAL_SECRET?.trim() || undefined,
    systemInternalSecret: env.KOKORO_SYSTEM_INTERNAL_SECRET?.trim() || undefined,
    agentInternalSecret: env.KOKORO_AGENT_INTERNAL_SECRET?.trim() || undefined,
    paymentInternalSecret: env.KOKORO_PAYMENT_INTERNAL_SECRET?.trim() || undefined,
    billingInternalSecret: env.KOKORO_BILLING_INTERNAL_SECRET?.trim() || undefined,
    sessionServiceValue: env.KOKORO_SESSION_SERVICE_VALUE?.trim() || "kokoro-gateway",
    upstreamTimeoutMs: positiveInteger(env.KOKORO_UPSTREAM_TIMEOUT_MS, "KOKORO_UPSTREAM_TIMEOUT_MS", 30_000),
    bodyLimitBytes: positiveInteger(
      env.KOKORO_GATEWAY_BODY_LIMIT_BYTES,
      "KOKORO_GATEWAY_BODY_LIMIT_BYTES",
      10 * 1024 * 1024,
    ),
  }
}
