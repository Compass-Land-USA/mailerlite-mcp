#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const API_KEY = process.env.MAILERLITE_API_KEY;
const API_BASE = "https://api.mailerlite.com/api/v2";

if (!API_KEY) {
  console.error("MAILERLITE_API_KEY env var is required");
  process.exit(1);
}

async function ml(path, { method = "GET", body } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      "X-MailerLite-ApiKey": API_KEY,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`MailerLite ${method} ${path} → ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

const tools = [
  {
    name: "list_groups",
    description:
      "List MailerLite subscriber groups. Each group has id, name, total subscribers, and aggregate send/open/click counts. Use to find the group_id before creating a campaign.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max groups to return (default 50)" },
      },
    },
    handler: async ({ limit = 50 }) => ml(`/groups?limit=${limit}`),
  },
  {
    name: "list_segments",
    description: "List MailerLite segments. Use to find a segment_id before creating a campaign.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max segments to return (default 50)" },
      },
    },
    handler: async ({ limit = 50 }) => ml(`/segments?limit=${limit}`),
  },
  {
    name: "list_campaigns",
    description:
      "List campaigns by status. status = sent | outbox (scheduled) | draft. Returns recent campaigns with subject, date, and aggregate stats when sent.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["sent", "outbox", "draft"], description: "Default: sent" },
        limit: { type: "number", description: "Default 10" },
      },
    },
    handler: async ({ status = "sent", limit = 10 }) =>
      ml(`/campaigns/${status}?limit=${limit}`),
  },
  {
    name: "get_campaign",
    description: "Fetch details for a single campaign by id.",
    inputSchema: {
      type: "object",
      properties: { campaign_id: { type: ["string", "number"] } },
      required: ["campaign_id"],
    },
    handler: async ({ campaign_id }) => ml(`/campaigns/${campaign_id}`),
  },
  {
    name: "create_campaign_draft",
    description:
      "Step 1 of the send flow. Creates a regular campaign as a DRAFT with subject/from/audience. Returns the new campaign id. Content is added separately via set_campaign_content. Does NOT send.",
    inputSchema: {
      type: "object",
      properties: {
        subject: { type: "string" },
        from_email: { type: "string" },
        from_name: { type: "string" },
        name: { type: "string", description: "Internal campaign name (optional)" },
        language_id: { type: "number", description: "Optional — account default used if omitted" },
        group_ids: {
          type: "array",
          items: { type: ["string", "number"] },
          description: "At least one of group_ids or segment_ids is required.",
        },
        segment_ids: {
          type: "array",
          items: { type: ["string", "number"] },
        },
      },
      required: ["subject", "from_email", "from_name"],
    },
    handler: async (args) => {
      const payload = {
        type: "regular",
        subject: args.subject,
        from: args.from_email,
        from_name: args.from_name,
        ...(args.name ? { name: args.name } : {}),
        ...(args.language_id ? { language_id: args.language_id } : {}),
        ...(args.group_ids?.length ? { groups: args.group_ids } : {}),
        ...(args.segment_ids?.length ? { segments: args.segment_ids } : {}),
      };
      return ml("/campaigns", { method: "POST", body: payload });
    },
  },
  {
    name: "set_campaign_content",
    description:
      "Step 2 of the send flow. Sets HTML and plain-text content on a draft campaign. HTML must include an unsubscribe link token — MailerLite v2 requires {$unsubscribe} somewhere in the HTML.",
    inputSchema: {
      type: "object",
      properties: {
        campaign_id: { type: ["string", "number"] },
        html: { type: "string" },
        plain: { type: "string" },
      },
      required: ["campaign_id", "html", "plain"],
    },
    handler: async ({ campaign_id, html, plain }) =>
      ml(`/campaigns/${campaign_id}/content`, {
        method: "PUT",
        body: { html, plain },
      }),
  },
  {
    name: "schedule_campaign",
    description:
      "Step 3 of the send flow. Schedules or immediately sends a draft campaign. type='instant' sends now; type='schedule' requires date (YYYY-MM-DD HH:MM in account timezone). Recommended: use 'schedule' one day out for human review, then human clicks Send (or cancel_campaign) in MailerLite UI.",
    inputSchema: {
      type: "object",
      properties: {
        campaign_id: { type: ["string", "number"] },
        type: { type: "string", enum: ["instant", "schedule"] },
        date: { type: "string", description: "YYYY-MM-DD HH:MM (required if type=schedule)" },
        analytics: { type: "number", description: "1 to enable link tracking (default 1)" },
        followup_schedule: {
          type: "string",
          enum: ["specific", "timezone"],
          description: "specific = single moment; timezone = by-subscriber timezone. Default specific.",
        },
      },
      required: ["campaign_id", "type"],
    },
    handler: async ({ campaign_id, type, date, analytics = 1, followup_schedule = "specific" }) => {
      const body = { type, analytics };
      if (type === "schedule") {
        body.date = date;
        body.followup_schedule = followup_schedule;
      }
      return ml(`/campaigns/${campaign_id}/actions/send`, { method: "POST", body });
    },
  },
  {
    name: "cancel_campaign",
    description: "Cancel a scheduled (outbox) campaign — returns it to draft. Use if human review rejects the preview.",
    inputSchema: {
      type: "object",
      properties: { campaign_id: { type: ["string", "number"] } },
      required: ["campaign_id"],
    },
    handler: async ({ campaign_id }) =>
      ml(`/campaigns/${campaign_id}/actions/cancel`, { method: "POST" }),
  },
  {
    name: "delete_campaign",
    description: "Delete a draft campaign permanently.",
    inputSchema: {
      type: "object",
      properties: { campaign_id: { type: ["string", "number"] } },
      required: ["campaign_id"],
    },
    handler: async ({ campaign_id }) =>
      ml(`/campaigns/${campaign_id}`, { method: "DELETE" }),
  },
  {
    name: "get_campaign_stats",
    description:
      "Get aggregate stats for a sent campaign: opened, clicked, unsubscribed, bounced, total, open_rate, click_rate. Use for the DOTW analyzer.",
    inputSchema: {
      type: "object",
      properties: { campaign_id: { type: ["string", "number"] } },
      required: ["campaign_id"],
    },
    handler: async ({ campaign_id }) => {
      const c = await ml(`/campaigns/${campaign_id}`);
      return {
        id: c.id,
        subject: c.subject,
        name: c.name,
        status: c.status,
        date_send: c.date_send,
        opened: c.opened,
        open_rate: c.opened_rate,
        clicked: c.clicked,
        click_rate: c.clicked_rate,
        unsubscribed: c.unsubscribed,
        bounced: c.bounced,
        total_recipients: c.total_recipients,
      };
    },
  },
  {
    name: "get_account",
    description: "Fetch the account info — useful to confirm which MailerLite account this MCP is talking to, and to read the default timezone for scheduling.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ml(`/me`),
  },
];

const server = new Server(
  { name: "mailerlite-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = tools.find((t) => t.name === req.params.name);
  if (!tool) {
    return { content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }], isError: true };
  }
  try {
    const result = await tool.handler(req.params.arguments || {});
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${err.message}\n${err.body ? JSON.stringify(err.body, null, 2) : ""}`,
        },
      ],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("mailerlite-mcp (v2 classic) running on stdio");
