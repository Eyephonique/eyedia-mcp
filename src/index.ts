import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response, NextFunction } from "express";
import { createServer } from "./server.js";

// ─── Mode detection ──────────────────────────────────────────────────────────
// Use stdio for Claude Desktop: MODE=stdio or --stdio flag
// Default: HTTP server for public deployment

const isStdio =
  process.env.MODE === "stdio" || process.argv.includes("--stdio");

// ─── Stdio mode (Claude Desktop) ─────────────────────────────────────────────
if (isStdio) {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("eyedia-mcp running (stdio)");

// ─── HTTP mode (public server) ───────────────────────────────────────────────
} else {
  const app = express();
  const PORT = parseInt(process.env.PORT ?? "3000", 10);

  // API keys — comma-separated in API_KEYS env var.
  // If unset, the server runs without auth (useful for local development).
  const API_KEYS = new Set(
    (process.env.API_KEYS ?? "").split(",").filter((k) => k.trim().length > 0)
  );

  // ─── Rate limiting (in-memory, per key) ─────────────────────────────────────
  const RATE_LIMIT = 60; // requests per window
  const RATE_WINDOW_MS = 60_000; // 1 minute
  const rateLimits = new Map<string, { count: number; resetAt: number }>();

  function checkRateLimit(key: string): boolean {
    const now = Date.now();
    const entry = rateLimits.get(key);
    if (!entry || entry.resetAt < now) {
      rateLimits.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
      return true;
    }
    if (entry.count >= RATE_LIMIT) return false;
    entry.count++;
    return true;
  }

  // Periodically clean up stale entries (every 5 minutes)
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimits) {
      if (entry.resetAt < now) rateLimits.delete(key);
    }
  }, 5 * 60_000);

  // ─── Auth middleware ─────────────────────────────────────────────────────────
  function authMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (API_KEYS.size === 0) {
      next();
      return;
    }
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing Authorization header. Use: Authorization: Bearer <key>" });
      return;
    }
    const key = auth.slice(7).trim();
    if (!API_KEYS.has(key)) {
      res.status(401).json({ error: "Invalid API key" });
      return;
    }
    if (!checkRateLimit(key)) {
      res.status(429).json({
        error: `Rate limit exceeded: max ${RATE_LIMIT} requests per minute`,
        retryAfter: 60,
      });
      return;
    }
    next();
  }

  // ─── Express setup ───────────────────────────────────────────────────────────
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", server: "eyedia-mcp", version: "1.0.0" });
  });

  // MCP endpoint — POST for requests, GET for SSE streams
  app.post("/mcp", authMiddleware, async (req, res) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = createServer();
    res.on("finish", () => server.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get("/mcp", authMiddleware, async (req, res) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = createServer();
    res.on("finish", () => server.close());
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });

  app.listen(PORT, () => {
    const authStatus = API_KEYS.size > 0 ? `auth enabled (${API_KEYS.size} key(s))` : "no auth (dev mode)";
    console.log(`eyedia-mcp HTTP server running on port ${PORT} — ${authStatus}`);
  });
}
