#!/usr/bin/env node
// HTTP MCP server, run on vps1 under systemd and published by the n8n-server
// Caddy at https://mailerlite-mcp.compasslandusa.com.
// Exposes MailerLite Classic v2 tools over Streamable HTTP.
// Auth: OAuth 2.1 with Dynamic Client Registration (MCP spec). /authorize asks
// for the shared team password (MCP_LOGIN_PASSWORD); every successful flow
// issues the same static MCP_BEARER_TOKEN as the access token.
import express from "express";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { buildTools, registerHandlers } from "./tools.js";

const MAILERLITE_API_KEY = process.env.MAILERLITE_API_KEY;
const MCP_BEARER_TOKEN = process.env.MCP_BEARER_TOKEN;
const MCP_LOGIN_PASSWORD = process.env.MCP_LOGIN_PASSWORD;
const PORT = process.env.PORT || 3100;
const HOST = process.env.HOST || "127.0.0.1";

if (!MAILERLITE_API_KEY) {
  console.error("FATAL: MAILERLITE_API_KEY env var is required");
  process.exit(1);
}
if (!MCP_BEARER_TOKEN) {
  console.error("FATAL: MCP_BEARER_TOKEN env var is required (generate with: openssl rand -hex 32)");
  process.exit(1);
}
if (!MCP_LOGIN_PASSWORD) {
  console.error("FATAL: MCP_LOGIN_PASSWORD env var is required (the shared team password)");
  process.exit(1);
}

// Only Claude's OAuth callbacks may receive an authorization code.
const ALLOWED_REDIRECT_URIS = new Set([
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
]);
const CODE_TTL_MS = 5 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const SESSION_IDLE_MS = 60 * 60 * 1000;

function safeEqual(a, b) {
  const ha = createHash("sha256").update(String(a)).digest();
  const hb = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

const app = express();
// Caddy is the one proxy in front: trust its X-Forwarded-* headers.
app.set("trust proxy", 1);
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

function baseUrl(req) {
  return `${req.protocol}://${req.get("host")}`;
}

app.get("/", (_req, res) => {
  res.json({ status: "ok", service: "mailerlite-mcp", transport: "streamable-http" });
});

// --- OAuth 2.1 discovery + endpoints (MCP spec) -----------------------------

app.get("/.well-known/oauth-authorization-server", (req, res) => {
  const base = baseUrl(req);
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: [
      "client_secret_post",
      "client_secret_basic",
      "none",
    ],
  });
});

app.get("/.well-known/oauth-protected-resource", (req, res) => {
  const base = baseUrl(req);
  res.json({
    resource: base,
    authorization_servers: [base],
    bearer_methods_supported: ["header"],
  });
});

// Dynamic Client Registration — accept any request, issue stable creds.
// Harmless: a client id alone gets nothing without the team password.
app.post("/register", (req, res) => {
  const redirect_uris = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris : [];
  res.status(201).json({
    client_id: "mcp-client-" + randomUUID(),
    client_secret: "not-used",
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris,
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
});

// Authorization codes awaiting exchange: code -> { redirect_uri, code_challenge, expires }
const authCodes = new Map();
// Failed logins per client IP: ip -> { count, resetAt }
const loginFailures = new Map();

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function loginPage(params, error) {
  const hidden = ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method"]
    .map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(params[k])}">`)
    .join("\n      ");
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>MailerLite MCP sign-in</title>
<style>
  body { font-family: system-ui, sans-serif; background: #f5f5f4; color: #1c1917; display: grid; place-items: center; min-height: 100vh; margin: 0; }
  form { background: #fff; padding: 2rem; border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,.1); width: min(320px, 90vw); }
  h1 { font-size: 1.1rem; margin: 0 0 1rem; }
  input[type=password] { width: 100%; box-sizing: border-box; padding: .6rem; margin-bottom: 1rem; font-size: 1rem; }
  button { width: 100%; padding: .6rem; font-size: 1rem; cursor: pointer; }
  .err { color: #b91c1c; margin: 0 0 1rem; }
</style></head>
<body>
  <form method="post" action="/authorize">
    <h1>Connect MailerLite MCP</h1>
    ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
    <input type="password" name="password" placeholder="Team password" autofocus required>
      ${hidden}
    <button type="submit">Connect</button>
  </form>
</body></html>`;
}

// Shared checks for GET and POST /authorize. Returns an error string or null.
function checkAuthorizeParams(p) {
  if (!p.redirect_uri || !ALLOWED_REDIRECT_URIS.has(p.redirect_uri)) return "Invalid redirect_uri";
  if (!p.code_challenge || p.code_challenge_method !== "S256") return "PKCE (S256) is required";
  return null;
}

app.get("/authorize", (req, res) => {
  const bad = checkAuthorizeParams(req.query);
  if (bad) return res.status(400).send(bad);
  res.type("html").send(loginPage(req.query));
});

app.post("/authorize", (req, res) => {
  const p = req.body || {};
  const bad = checkAuthorizeParams(p);
  if (bad) return res.status(400).send(bad);

  const now = Date.now();
  let fails = loginFailures.get(req.ip);
  if (fails && fails.resetAt < now) {
    loginFailures.delete(req.ip);
    fails = undefined;
  }
  if (fails && fails.count >= LOGIN_MAX_FAILURES) {
    return res.status(429).type("html").send(loginPage(p, "Too many attempts. Try again in 15 minutes."));
  }

  if (!safeEqual(p.password || "", MCP_LOGIN_PASSWORD)) {
    if (fails) fails.count += 1;
    else loginFailures.set(req.ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    console.warn(`login failed from ${req.ip}`);
    return res.status(401).type("html").send(loginPage(p, "Wrong password."));
  }
  loginFailures.delete(req.ip);

  const code = randomBytes(32).toString("base64url");
  authCodes.set(code, {
    redirect_uri: p.redirect_uri,
    code_challenge: p.code_challenge,
    expires: now + CODE_TTL_MS,
  });
  const url = new URL(p.redirect_uri);
  url.searchParams.set("code", code);
  if (p.state) url.searchParams.set("state", String(p.state));
  console.log(`login ok from ${req.ip}`);
  res.redirect(302, url.toString());
});

// Token — exchange a valid, unexpired, single-use code (PKCE-verified) for the
// shared MCP_BEARER_TOKEN.
app.post("/token", (req, res) => {
  const { grant_type, code, code_verifier, redirect_uri } = req.body || {};
  if (grant_type !== "authorization_code") {
    return res.status(400).json({ error: "unsupported_grant_type" });
  }
  const entry = code ? authCodes.get(code) : undefined;
  if (code) authCodes.delete(code);
  if (
    !entry ||
    entry.expires < Date.now() ||
    (redirect_uri && redirect_uri !== entry.redirect_uri) ||
    !code_verifier ||
    createHash("sha256").update(String(code_verifier)).digest("base64url") !== entry.code_challenge
  ) {
    return res.status(400).json({ error: "invalid_grant" });
  }
  res.json({
    access_token: MCP_BEARER_TOKEN,
    token_type: "Bearer",
    expires_in: 60 * 60 * 24 * 365,
  });
});

// --- MCP transport ----------------------------------------------------------

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !safeEqual(token || "", MCP_BEARER_TOKEN)) {
    const base = baseUrl(req);
    res.set(
      "WWW-Authenticate",
      `Bearer realm="mcp", resource_metadata="${base}/.well-known/oauth-protected-resource"`
    );
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// Per-session transports keyed by the MCP session id header
const transports = new Map();
// Last activity per session id, so abandoned sessions can be evicted
const lastSeen = new Map();

app.post("/mcp", requireAuth, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  let transport = sessionId ? transports.get(sessionId) : undefined;

  if (!transport) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport);
        lastSeen.set(id, Date.now());
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        transports.delete(transport.sessionId);
        lastSeen.delete(transport.sessionId);
      }
    };

    const server = new Server(
      { name: "mailerlite-mcp", version: "0.1.0" },
      { capabilities: { tools: {} } }
    );
    const tools = buildTools(MAILERLITE_API_KEY);
    registerHandlers(server, tools, ListToolsRequestSchema, CallToolRequestSchema);
    await server.connect(transport);
  } else {
    lastSeen.set(sessionId, Date.now());
  }

  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", requireAuth, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) return res.status(400).json({ error: "No active session" });
  lastSeen.set(sessionId, Date.now());
  await transport.handleRequest(req, res);
});

app.delete("/mcp", requireAuth, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) return res.status(400).json({ error: "No active session" });
  await transport.handleRequest(req, res);
});

// Housekeeping: drop expired auth codes, stale login counters, and MCP
// sessions idle for over an hour (clients don't always send DELETE).
setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of authCodes) if (entry.expires < now) authCodes.delete(code);
  for (const [ip, f] of loginFailures) if (f.resetAt < now) loginFailures.delete(ip);
  for (const [id, t] of lastSeen) {
    if (now - t > SESSION_IDLE_MS) {
      const transport = transports.get(id);
      transports.delete(id);
      lastSeen.delete(id);
      transport?.close().catch(() => {});
    }
  }
}, 5 * 60 * 1000).unref();

app.listen(PORT, HOST, () => {
  console.log(`mailerlite-mcp HTTP server listening on ${HOST}:${PORT}`);
});
