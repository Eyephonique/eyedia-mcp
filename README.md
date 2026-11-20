# eyedia-mcp

An MCP server that checks websites for AI-readiness: ARD discovery files, `llms.txt`, Schema.org structured data, and more.

Built by [eyedia](https://eyedia.de) — Webdesign & KI Agentur aus Köln.

## What it checks

| Check | What it looks for |
|-------|------------------|
| `ard.json` | `/.well-known/ard.json` — Agentic Resource Discovery manifest |
| `ai-catalog.json` | `/.well-known/ai-catalog.json` — AI catalog file |
| `llms.txt` | `/llms.txt` — Markdown site summary for LLMs |
| `robots.txt` | Presence and AI-crawler friendliness |
| Schema.org JSON-LD | `Organization` or `LocalBusiness` structured data |
| `rel="ard"` | Discovery link tag in the HTML `<head>` |

## Tools

### `check_ard`
Fetches and validates `ard.json` / `ai-catalog.json`. Checks URN identifier format, required fields (`type`, `representativeQueries`), and the `rel="ard"` link tag.

### `check_llms_txt`
Fetches `/llms.txt` and returns its content.

### `check_ai_readiness`
Full audit across all 6 checks. Returns a score (e.g. `6/6`) and improvement suggestions for failing checks.

## Quick Start — Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "eyedia-checker": {
      "command": "npx",
      "args": ["tsx", "/path/to/eyedia-mcp/src/index.ts", "--stdio"]
    }
  }
}
```

Then restart Claude Desktop. Ask it: *"Check the AI readiness of https://example.com"*

## Self-Hosting (HTTP Server)

### Local development

```bash
git clone https://github.com/Eyephonique/eyedia-mcp.git
cd eyedia-mcp
npm install
cp .env.example .env
npm start
# → eyedia-mcp HTTP server running on port 3000 — no auth (dev mode)
```

Test with curl:
```bash
curl http://localhost:3000/health
```

### With API key auth

Set `API_KEYS` in your `.env`:
```
API_KEYS=ey_live_your_key_here
```

Generate a key:
```bash
node -e "console.log('ey_live_' + require('crypto').randomBytes(24).toString('hex'))"
```

Then include it in requests:
```
Authorization: Bearer ey_live_your_key_here
```

### Docker

```bash
docker build -t eyedia-mcp .
docker run -p 3000:3000 -e API_KEYS=ey_live_yourkey eyedia-mcp
```

### Reverse proxy (Caddy example)

```caddyfile
mcp.yourdomain.com {
  reverse_proxy localhost:3000
}
```

## MCP Endpoint

The HTTP server exposes a standard MCP StreamableHTTP endpoint:

```
POST /mcp   — MCP requests
GET  /mcp   — SSE stream (for server-initiated messages)
GET  /health — Health check
```

Compatible with any MCP client that supports the StreamableHTTP transport (MCP spec 2024-11-05+).

## Rate limits

60 requests per key per minute (in-memory, resets on restart). Adjust `RATE_LIMIT` and `RATE_WINDOW_MS` in `src/index.ts`.

## About ARD

[Agentic Resource Discovery (ARD)](https://agenticresourcediscovery.org/spec/) is an open specification (v0.91) that makes websites and their resources discoverable by AI agents — similar to how `robots.txt` and `sitemap.xml` work for search engines.

An ARD entry looks like this:

```json
{
  "identifier": "urn:air:example.com:products:my-tool",
  "displayName": "My Tool",
  "url": "https://example.com/my-tool",
  "type": "text/html",
  "description": "What this tool does.",
  "representativeQueries": ["query one", "query two"]
}
```

## License

MIT — use freely, attribution appreciated.
