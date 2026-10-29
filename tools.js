const API_BASE = "https://api.mailerlite.com/api/v2";
// Largest page the /campaigns/:status list accepts in one call.
const CAMPAIGN_PAGE = 1000;

export function buildTools(apiKey) {
  async function ml(path, { method = "GET", body } = {}) {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        "X-MailerLite-ApiKey": apiKey,
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

  // v2 has no single-campaign GET: /campaigns/:x is the list-by-status route.
  // Walk the sent, outbox and draft lists (newest first) until the id turns up.
  async function findCampaign(campaign_id) {
    for (const status of ["sent", "outbox", "draft"]) {
      for (let offset = 0; ; offset += CAMPAIGN_PAGE) {
        const page = await ml(`/campaigns/${status}?limit=${CAMPAIGN_PAGE}&offset=${offset}&order=DESC`);
        const match = page.find((c) => String(c.id) === String(campaign_id));
        if (match) return match;
        if (page.length < CAMPAIGN_PAGE) break;
      }
    }
    throw new Error(`Campaign ${campaign_id} not found in sent, outbox or draft campaigns`);
  }

  return [
    {
      name: "list_groups",
      description:
        "List MailerLite subscriber groups. Each group has id, name, total subscribers, and aggregate send/open/click counts. Use to find the group_id before creating a campaign.",
      inputSchema: {
        type: "object",
        properties: { limit: { type: "number", description: "Max groups to return (default 50)" } },
      },
      handler: async ({ limit = 50 }) => ml(`/groups?limit=${limit}`),
    },
    {
      name: "list_segments",
      description:
        "List MailerLite segments: id, title, total subscribers, and aggregate sent/opened/clicked counts. Use to find a segment_id before creating a campaign.",
      inputSchema: {
        type: "object",
        properties: { limit: { type: "number", description: "Max segments to return (default 50)" } },
      },
      // The raw payload includes each segment's filter rules, which can contain
      // subscriber email addresses; only the summary fields are passed on.
      handler: async ({ limit = 50 }) => {
        const res = await ml(`/segments?limit=${limit}`);
        return (res.data || []).map(({ id, title, total, sent, opened, clicked }) => ({
          id, title, total, sent, opened, clicked,
        }));
      },
    },
    {
      name: "list_campaigns",
      description:
        "List campaigns by status, newest first. status = sent | outbox (scheduled) | draft. Returns id, name, subject, dates, recipients, and opened/clicked count + rate (sent campaigns only).",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["sent", "outbox", "draft"], description: "Default: sent" },
          limit: { type: "number", description: "Default 10" },
          offset: { type: "number", description: "Skip this many campaigns, for paging. Default 0" },
        },
      },
      handler: async ({ status = "sent", limit = 10, offset = 0 }) =>
        ml(`/campaigns/${status}?limit=${limit}&offset=${offset}&order=DESC`),
    },
    {
      name: "get_campaign",
      description:
        "Fetch one campaign by id (searches sent, scheduled and draft campaigns): name, subject, status, type, dates, recipients, and opened/clicked count + rate when sent.",
      inputSchema: {
        type: "object",
        properties: { campaign_id: { type: ["string", "number"] } },
        required: ["campaign_id"],
      },
      handler: async ({ campaign_id }) => findCampaign(campaign_id),
    },
    {
      name: "create_campaign_draft",
      description:
        "Step 1 of the send flow. Creates a regular campaign as a DRAFT with subject/from/audience. Returns the new campaign id. Content is added separately via set_campaign_content. Does NOT send. If segment_ids are given, MailerLite ignores group_ids.",
      inputSchema: {
        type: "object",
        properties: {
          subject: { type: "string" },
          from_email: { type: "string" },
          from_name: { type: "string" },
          name: { type: "string", description: "Internal campaign name. Defaults to the subject." },
          language: { type: "string", description: "Language code, e.g. 'en'. Optional — account default used if omitted" },
          group_ids: {
            type: "array",
            items: { type: ["string", "number"] },
            description: "At least one of group_ids or segment_ids is required.",
          },
          segment_ids: {
            type: "array",
            items: { type: ["string", "number"] },
            description: "If given, group_ids are ignored.",
          },
        },
        required: ["subject", "from_email", "from_name"],
      },
      handler: async (args) => {
        if (!args.group_ids?.length && !args.segment_ids?.length) {
          throw new Error("At least one of group_ids or segment_ids is required");
        }
        const payload = {
          type: "regular",
          name: args.name || args.subject,
          subject: args.subject,
          from: args.from_email,
          from_name: args.from_name,
          ...(args.language ? { language: args.language } : {}),
          ...(args.group_ids?.length ? { groups: args.group_ids } : {}),
          ...(args.segment_ids?.length ? { segments: args.segment_ids } : {}),
        };
        return ml("/campaigns", { method: "POST", body: payload });
      },
    },
    {
      name: "set_campaign_content",
      description:
        "Step 2 of the send flow. Sets HTML and plain-text content on a draft campaign. The HTML must be a full document with <head> and <body> tags, and must include the unsubscribe token {$unsubscribe}.",
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
        ml(`/campaigns/${campaign_id}/content`, { method: "PUT", body: { html, plain } }),
    },
    {
      name: "schedule_campaign",
      description:
        "Step 3 of the send flow. Schedules or immediately sends a draft campaign that has content. type='instant' sends now; type='schedule' requires date (YYYY-MM-DD HH:MM in the account timezone, see get_account). For DOTW always use 'schedule' at least 24h out to leave human review time.",
      inputSchema: {
        type: "object",
        properties: {
          campaign_id: { type: ["string", "number"] },
          type: { type: "string", enum: ["instant", "schedule"] },
          date: { type: "string", description: "YYYY-MM-DD HH:MM (required if type=schedule)" },
          analytics: { type: "number", description: "1 to enable link tracking (default 1)" },
        },
        required: ["campaign_id", "type"],
      },
      // The API takes type 1 (send now, its default) or 2 (schedule).
      handler: async ({ campaign_id, type, date, analytics = 1 }) => {
        if (type !== "instant" && type !== "schedule") {
          throw new Error("type must be 'instant' or 'schedule'");
        }
        const body = { type: type === "schedule" ? 2 : 1, analytics };
        if (type === "schedule") {
          if (!date || !/^\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}$/.test(date)) {
            throw new Error("type='schedule' requires date as YYYY-MM-DD HH:MM");
          }
          body.date = date;
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
      handler: async ({ campaign_id }) => ml(`/campaigns/${campaign_id}/actions/cancel`, { method: "POST" }),
    },
    {
      name: "delete_campaign",
      description: "Delete a campaign permanently. A scheduled (outbox) campaign must be cancelled with cancel_campaign first.",
      inputSchema: {
        type: "object",
        properties: { campaign_id: { type: ["string", "number"] } },
        required: ["campaign_id"],
      },
      handler: async ({ campaign_id }) => ml(`/campaigns/${campaign_id}`, { method: "DELETE" }),
    },
    {
      name: "get_campaign_stats",
      description:
        "Get stats for a sent campaign: recipients, opens and clicks (count + rate %). Unsubscribe and bounce counts per campaign are not available in the MailerLite Classic API.",
      inputSchema: {
        type: "object",
        properties: { campaign_id: { type: ["string", "number"] } },
        required: ["campaign_id"],
      },
      handler: async ({ campaign_id }) => {
        const c = await findCampaign(campaign_id);
        return {
          id: c.id,
          subject: c.subject,
          name: c.name,
          status: c.status,
          date_send: c.date_send,
          total_recipients: c.total_recipients,
          opened: c.opened?.count ?? 0,
          open_rate: c.opened?.rate ?? 0,
          clicked: c.clicked?.count ?? 0,
          click_rate: c.clicked?.rate ?? 0,
        };
      },
    },
    {
      name: "get_account_stats",
      description:
        "Account-wide stats: subscribed and unsubscribed totals, campaigns sent, emails sent, and overall open/click/bounce rates (fractions, e.g. 0.29 = 29%). Pass timestamp (UNIX seconds) to get the values as of a past date.",
      inputSchema: {
        type: "object",
        properties: { timestamp: { type: "number", description: "Optional UNIX timestamp for a past point in time" } },
      },
      handler: async ({ timestamp }) => ml(timestamp ? `/stats?timestamp=${timestamp}` : `/stats`),
    },
    {
      name: "get_account",
      description: "Fetch the account info — confirms which MailerLite account this MCP talks to, and default timezone for scheduling.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => ml(`/me`),
    },
  ];
}

export function registerHandlers(server, tools, listToolsSchema, callToolSchema) {
  server.setRequestHandler(listToolsSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));
  server.setRequestHandler(callToolSchema, async (req) => {
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
          { type: "text", text: `Error: ${err.message}\n${err.body ? JSON.stringify(err.body, null, 2) : ""}` },
        ],
        isError: true,
      };
    }
  });
}
