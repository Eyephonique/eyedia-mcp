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
  const RATE_LIMIT = 10; // requests per window
  const RATE_WINDOW_MS = 86_400_000; // 24 hours
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
  }, 60 * 60_000); // cleanup every hour

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
        error: `Rate limit exceeded: max ${RATE_LIMIT} requests per day`,
        retryAfter: 86400,
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

  app.get("/.well-known/mcp-server-card.json", (_req, res) => {
    res.json({
      "@context": "https://agenticresourcediscovery.org/context/v1",
      schema: "mcp-server-card/v1",
      name: "eyedia Website Checker",
      version: "1.0.0",
      description: "AI-readiness audit for websites: validates ARD discovery files, llms.txt, Schema.org JSON-LD, and rel=\"ard\" link tags.",
      publisher: "eyedia",
      publisherUrl: "https://eyedia.de",
      endpoint: "https://mcp.eyedia.de/mcp",
      auth: {
        type: "bearer",
        description: "API key required. Contact hallo@eyedia.de to request access."
      },
      tools: [
        {
          name: "check_ard",
          description: "Validates ard.json and ai-catalog.json entries (URN format, required fields) and checks rel=\"ard\" in HTML head."
        },
        {
          name: "check_llms_txt",
          description: "Fetches /llms.txt and returns its content."
        },
        {
          name: "check_ai_readiness",
          description: "Full audit: ARD, llms.txt, robots.txt, Schema.org JSON-LD, rel=\"ard\". Returns score and improvement suggestions."
        }
      ]
    });
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
