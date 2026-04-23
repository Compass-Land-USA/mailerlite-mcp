#!/usr/bin/env node
// HTTP MCP server for Railway deployment.
// Exposes MailerLite Classic v2 tools over Streamable HTTP.
// Auth: OAuth 2.1 with Dynamic Client Registration (MCP spec).
// Single-user/single-tenant: every successful OAuth flow issues the same
// static MCP_BEARER_TOKEN as the access token.
import express from "express";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { buildTools, registerHandlers } from "./tools.js";

const MAILERLITE_API_KEY = process.env.MAILERLITE_API_KEY;
const MCP_BEARER_TOKEN = process.env.MCP_BEARER_TOKEN;
const PORT = process.env.PORT || 3000;

if (!MAILERLITE_API_KEY) {
  console.error("FATAL: MAILERLITE_API_KEY env var is required");
  process.exit(1);
}
if (!MCP_BEARER_TOKEN) {
  console.error("FATAL: MCP_BEARER_TOKEN env var is required (generate with: openssl rand -hex 32)");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

function baseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  return `${proto}://${req.get("host")}`;
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
    code_challenge_methods_supported: ["S256", "plain"],
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

// Authorize — no user interaction, auto-approve (single-tenant).
app.get("/authorize", (req, res) => {
  const { redirect_uri, state } = req.query;
  if (!redirect_uri || typeof redirect_uri !== "string") {
    return res.status(400).send("Missing redirect_uri");
  }
  let url;
  try {
    url = new URL(redirect_uri);
  } catch {
    return res.status(400).send("Invalid redirect_uri");
  }
  url.searchParams.set("code", "auth-" + randomUUID());
  if (state) url.searchParams.set("state", String(state));
  res.redirect(302, url.toString());
});

// Token — accept any code, always issue the shared MCP_BEARER_TOKEN.
app.post("/token", (req, res) => {
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
  if (scheme !== "Bearer" || token !== MCP_BEARER_TOKEN) {
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

app.post("/mcp", requireAuth, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  let transport = sessionId ? transports.get(sessionId) : undefined;

  if (!transport) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => transports.set(id, transport),
    });
    transport.onclose = () => {
      if (transport.sessionId) transports.delete(transport.sessionId);
    };

    const server = new Server(
      { name: "mailerlite-mcp", version: "0.1.0" },
      { capabilities: { tools: {} } }
    );
    const tools = buildTools(MAILERLITE_API_KEY);
    registerHandlers(server, tools, ListToolsRequestSchema, CallToolRequestSchema);
    await server.connect(transport);
  }

  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", requireAuth, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) return res.status(400).json({ error: "No active session" });
  await transport.handleRequest(req, res);
});

app.delete("/mcp", requireAuth, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) return res.status(400).json({ error: "No active session" });
  await transport.handleRequest(req, res);
});

app.listen(PORT, () => {
  console.log(`mailerlite-mcp HTTP server listening on :${PORT}`);
});
