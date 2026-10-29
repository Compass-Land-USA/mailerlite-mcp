#!/usr/bin/env node
// Stdio MCP server for local Claude Code. Same tools as server.js (tools.js).
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { buildTools, registerHandlers } from "./tools.js";

const API_KEY = process.env.MAILERLITE_API_KEY;

if (!API_KEY) {
  console.error("MAILERLITE_API_KEY env var is required");
  process.exit(1);
}

const server = new Server(
  { name: "mailerlite-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);
registerHandlers(server, buildTools(API_KEY), ListToolsRequestSchema, CallToolRequestSchema);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("mailerlite-mcp (v2 classic) running on stdio");
