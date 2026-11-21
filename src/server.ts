import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fetch from "node-fetch";
import dns from "node:dns";
import net from "node:net";

type FetchResult = { ok: boolean; status: number; text: string };

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_REDIRECTS = 5;

function ipToLong(ip: string): number {
  return ip.split(".").reduce((acc, octet) => ((acc << 8) | parseInt(octet, 10)) >>> 0, 0) >>> 0;
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::1") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA fc00::/7
    if (lower.startsWith("fe80")) return true; // link-local fe80::/10
    const v4mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (v4mapped) return isPrivateIp(v4mapped[1]);
    return false;
  }
  if (!net.isIPv4(ip)) return true; // unknown format — block
  const n = ipToLong(ip);
  const ranges: [string, number][] = [
    ["0.0.0.0",       8],  // this network
    ["10.0.0.0",      8],  // RFC 1918
    ["100.64.0.0",   10],  // shared/CGN
    ["127.0.0.0",     8],  // loopback
    ["169.254.0.0",  16],  // link-local / AWS metadata
    ["172.16.0.0",   12],  // RFC 1918
    ["192.168.0.0",  16],  // RFC 1918
    ["198.18.0.0",   15],  // benchmarking
    ["240.0.0.0",     4],  // reserved
    ["255.255.255.255", 32], // broadcast
  ];
  for (const [base, prefix] of ranges) {
    const mask = prefix === 32 ? 0xffffffff : (~((1 << (32 - prefix)) - 1)) >>> 0;
    if ((n & mask) === (ipToLong(base) & mask)) return true;
  }
  return false;
}

async function validateUrl(urlStr: string): Promise<void> {
  let parsed: URL;
  try { parsed = new URL(urlStr); } catch { throw new Error("Invalid URL"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http/https URLs are allowed");
  }
  const hostname = parsed.hostname;
  if (net.isIP(hostname) !== 0) {
    if (isPrivateIp(hostname)) throw new Error("Access to private IP ranges is not allowed");
    return;
  }
  let addresses: dns.LookupAddress[];
  try {
    addresses = await dns.promises.lookup(hostname, { all: true });
  } catch {
    throw new Error(`Cannot resolve hostname: ${hostname}`);
  }
  for (const { address } of addresses) {
    if (isPrivateIp(address)) throw new Error(`Hostname resolves to a private address (${address})`);
  }
}

async function tryFetch(url: string): Promise<FetchResult> {
  try {
    await validateUrl(url);
  } catch (e) {
    return { ok: false, status: 0, text: String((e as Error).message) };
  }
  let currentUrl = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetch(currentUrl, { signal: AbortSignal.timeout(8000), redirect: "manual" });
    } catch {
      return { ok: false, status: 0, text: "" };
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return { ok: false, status: res.status, text: "" };
      const nextUrl = new URL(location, currentUrl).toString();
      try { await validateUrl(nextUrl); } catch (e) {
        return { ok: false, status: 0, text: String((e as Error).message) };
      }
      currentUrl = nextUrl;
      continue;
    }
    if (!res.ok) return { ok: false, status: res.status, text: "" };
    // Read body with size cap
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const chunk of res.body as AsyncIterable<Buffer>) {
        total += chunk.length;
        chunks.push(chunk);
        if (total >= MAX_RESPONSE_BYTES) break;
      }
    } catch {
      return { ok: false, status: res.status, text: "" };
    }
    return { ok: true, status: res.status, text: Buffer.concat(chunks).toString("utf-8") };
  }
  return { ok: false, status: 0, text: "Too many redirects" };
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "eyedia-website-checker",
    version: "1.0.0",
    description: "AI-readiness checks for websites: ARD, llms.txt, structured data",
  });

  // ─── check_ard ──────────────────────────────────────────────────────────────
  server.tool(
    "check_ard",
    "Checks whether a website has a valid ard.json and/or ai-catalog.json, validates all entries, and verifies the rel=\"ard\" link tag in the HTML head.",
    { url: z.string().url().describe("Website URL to check (e.g. https://example.com)") },
    async ({ url }) => {
      const base = new URL(url).origin;
      const lines: string[] = [`🔍 ARD Check for ${base}\n`];

      // ard.json
      const ard = await tryFetch(`${base}/.well-known/ard.json`);
      lines.push(ard.ok
        ? `✅ ard.json found`
        : `❌ ard.json not found (${ard.status || "unreachable"})`
      );

      // ai-catalog.json
      const catalog = await tryFetch(`${base}/.well-known/ai-catalog.json`);
      lines.push(catalog.ok
        ? `✅ ai-catalog.json found`
        : `⚠️  ai-catalog.json not found (${catalog.status || "unreachable"})`
      );

      // rel="ard" in HTML head
      const html = await tryFetch(base);
      const hasRelArd = html.text.includes('rel="ard"') || html.text.includes("rel='ard'");
      const hasRelCatalog = html.text.includes('rel="ai-catalog"') || html.text.includes("rel='ai-catalog'");
      lines.push(hasRelArd ? `✅ rel="ard" found in HTML head` : `❌ rel="ard" missing from HTML head`);
      lines.push(hasRelCatalog ? `✅ rel="ai-catalog" found in HTML head` : `⚠️  rel="ai-catalog" missing`);

      // validate entries
      const rawData = ard.ok ? ard.text : catalog.ok ? catalog.text : null;
      if (rawData) {
        try {
          const data = JSON.parse(rawData);
          const entries: Record<string, unknown>[] = Array.isArray(data.entries) ? data.entries : [];
          if (entries.length === 0) {
            lines.push(`\n❌ No entries found — 'entries' array is missing or empty`);
          } else {
            lines.push(`\n📋 ${entries.length} entries found:`);
            for (const entry of entries) {
              const id = String(entry.identifier || "MISSING");
              const name = String(entry.displayName || entry.name || "MISSING");
              const hasType = !!entry.type;
              const hasQueries = Array.isArray(entry.representativeQueries) && entry.representativeQueries.length > 0;
              const urnOk = id.startsWith("urn:air:");
              const queries = hasQueries
                ? (entry.representativeQueries as string[]).slice(0, 2).join(", ")
                : "missing";
              lines.push(
                `  ${urnOk ? "✅" : "❌"} ${name}\n` +
                `     identifier: ${id}\n` +
                `     type: ${hasType ? String(entry.type) : "❌ missing"}\n` +
                `     representativeQueries: ${hasQueries ? "✅ " + queries : "⚠️  " + queries}`
              );
            }
          }
        } catch {
          lines.push(`\n❌ Failed to parse JSON`);
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ─── check_llms_txt ─────────────────────────────────────────────────────────
  server.tool(
    "check_llms_txt",
    "Checks if a website has a /llms.txt file and returns its content. llms.txt is a Markdown summary of a website for LLMs.",
    { url: z.string().url().describe("Website URL to check") },
    async ({ url }) => {
      const base = new URL(url).origin;
      const llmsUrl = `${base}/llms.txt`;
      const result = await tryFetch(llmsUrl);
      if (!result.ok) {
        return { content: [{ type: "text", text: `❌ llms.txt not found (${result.status || "unreachable"}): ${llmsUrl}` }] };
      }
      const content = result.text.length > 3000
        ? result.text.slice(0, 3000) + "\n\n[truncated — full file at " + llmsUrl + "]"
        : result.text;
      return {
        content: [{ type: "text", text: `✅ llms.txt found: ${llmsUrl}\n\n---\n${content}` }],
      };
    }
  );

  // ─── check_ai_readiness ─────────────────────────────────────────────────────
  server.tool(
    "check_ai_readiness",
    "Full AI-readiness audit: checks ard.json, ai-catalog.json, llms.txt, robots.txt, Schema.org JSON-LD, and rel=\"ard\" in the HTML head. Returns a score and improvement suggestions.",
    { url: z.string().url().describe("Website URL to audit") },
    async ({ url }) => {
      const base = new URL(url).origin;
      const checks: { label: string; ok: boolean; detail: string }[] = [];

      const [ard, catalog, llms, robots, html] = await Promise.all([
        tryFetch(`${base}/.well-known/ard.json`),
        tryFetch(`${base}/.well-known/ai-catalog.json`),
        tryFetch(`${base}/llms.txt`),
        tryFetch(`${base}/robots.txt`),
        tryFetch(base),
      ]);

      checks.push({ label: "ard.json", ok: ard.ok, detail: ard.ok ? "present" : "missing" });
      checks.push({ label: "ai-catalog.json", ok: catalog.ok, detail: catalog.ok ? "present" : "missing" });
      checks.push({ label: "llms.txt", ok: llms.ok, detail: llms.ok ? "present" : "missing" });

      // robots.txt — check for overly broad AI blocking
      const robotsText = robots.text.toLowerCase();
      const broadBlock = robotsText.includes("user-agent: *") &&
        robotsText.includes("disallow: /") &&
        !robotsText.match(/disallow: \/\s*\n/);
      checks.push({
        label: "robots.txt",
        ok: robots.ok,
        detail: robots.ok
          ? broadBlock ? "present (warning: may block AI crawlers)" : "present, no broad block"
          : "missing"
      });

      // Schema.org JSON-LD
      const hasSchema = html.text.includes("application/ld+json");
      const hasOrgType = html.text.includes('"Organization"') || html.text.includes('"LocalBusiness"');
      checks.push({
        label: "Schema.org JSON-LD",
        ok: hasSchema,
        detail: hasSchema ? (hasOrgType ? "Organization/LocalBusiness found" : "present") : "missing"
      });

      // rel="ard"
      const hasRelArd = html.text.includes('rel="ard"') || html.text.includes("rel='ard'");
      checks.push({ label: 'rel="ard" in HTML head', ok: hasRelArd, detail: hasRelArd ? "present" : "missing" });

      const passed = checks.filter((c) => c.ok).length;
      const total = checks.length;

      const lines = [
        `🔍 AI Readiness Audit: ${base}`,
        `Score: ${passed}/${total}\n`,
        ...checks.map((c) => `${c.ok ? "✅" : "❌"} ${c.label}: ${c.detail}`),
      ];

      // Suggestions for failing checks
      const failed = checks.filter((c) => !c.ok);
      if (failed.length > 0) {
        lines.push("\n💡 Suggestions:");
        for (const f of failed) {
          if (f.label === "ard.json") lines.push("  • Add /.well-known/ard.json — see https://agenticresourcediscovery.org/spec/");
          if (f.label === "llms.txt") lines.push("  • Add /llms.txt — a Markdown summary of your site for LLMs");
          if (f.label === "Schema.org JSON-LD") lines.push("  • Add JSON-LD structured data (Organization or LocalBusiness)");
          if (f.label === 'rel="ard" in HTML head') lines.push('  • Add <link rel="ard" href="/.well-known/ard.json"> to your HTML <head>');
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  return server;
}
