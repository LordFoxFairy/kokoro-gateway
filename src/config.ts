export interface GatewayConfig {
  /** Deployment hostname used only to construct the server-side Forwarded context. */
  domain: string
  /** Session-compatible upstream. Missing means the process is intentionally not ready. */
  sessionBaseUrl: string | undefined
  /** Credential accepted only from the trusted Web BFF service boundary. */
  gatewaySharedSecret: string
  /** Separate credential used when this gateway calls kokoro-session. */
  sessionInternalSecret: string | undefined
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

function validateBaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("KOKORO_SESSION_BASE_URL must use http or https")
  }
  if (url.search || url.hash) throw new Error("KOKORO_SESSION_BASE_URL must not contain query or hash")
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
  const sessionBaseUrl = validateBaseUrl(env.KOKORO_SESSION_BASE_URL?.trim() || undefined)
  if (env.NODE_ENV === "production" && !env.KOKORO_SESSION_INTERNAL_SECRET?.trim()) {
    throw new Error("KOKORO_SESSION_INTERNAL_SECRET is required in production")
  }
  return {
    domain: validateDomain(required(env, "KOKORO_DOMAIN")),
    sessionBaseUrl,
    gatewaySharedSecret: required(env, "KOKORO_GATEWAY_SHARED_SECRET"),
    sessionInternalSecret: env.KOKORO_SESSION_INTERNAL_SECRET?.trim() || undefined,
    sessionServiceValue: env.KOKORO_SESSION_SERVICE_VALUE?.trim() || "kokoro-gateway",
    upstreamTimeoutMs: positiveInteger(env.KOKORO_UPSTREAM_TIMEOUT_MS, "KOKORO_UPSTREAM_TIMEOUT_MS", 30_000),
    bodyLimitBytes: positiveInteger(
      env.KOKORO_GATEWAY_BODY_LIMIT_BYTES,
      "KOKORO_GATEWAY_BODY_LIMIT_BYTES",
      10 * 1024 * 1024,
    ),
  }
}
