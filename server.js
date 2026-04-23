#!/usr/bin/env node
// HTTP MCP server for Railway deployment.
// Exposes MailerLite Classic v2 tools over Streamable HTTP, with bearer auth.
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

app.get("/", (_req, res) => {
  res.json({ status: "ok", service: "mailerlite-mcp", transport: "streamable-http" });
});

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || token !== MCP_BEARER_TOKEN) {
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
