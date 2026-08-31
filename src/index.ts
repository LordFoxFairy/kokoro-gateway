import { buildApp } from "./app.js"
import { configFromEnv } from "./config.js"

const config = configFromEnv()
const app = buildApp(config)
const port = Number(process.env.PORT ?? 8080)
const host = process.env.HOST ?? "0.0.0.0"

if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error("PORT must be a valid TCP port")
await app.listen({ host, port })
