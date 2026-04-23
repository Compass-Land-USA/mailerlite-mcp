# mailerlite-mcp

MCP server for MailerLite Classic v2. Two transports:
- `server.js` — HTTP/Streamable for Railway deployment (remote, used by claude.ai)
- `index.js` — stdio for local Claude Code (still registered in `~/.claude.json`)

## Tools exposed

`list_groups`, `list_segments`, `list_campaigns`, `get_campaign`, `create_campaign_draft`, `set_campaign_content`, `schedule_campaign`, `cancel_campaign`, `delete_campaign`, `get_campaign_stats`, `get_account`.

## Environment variables

| Variable | Where it lives | Purpose |
|---|---|---|
| `MAILERLITE_API_KEY` | Railway env | MailerLite Classic API token |
| `MCP_BEARER_TOKEN` | Railway env + claude.ai connector | Auth between claude.ai and this server |
| `PORT` | Railway sets automatically | HTTP listen port |

Generate the bearer token locally:

```bash
openssl rand -hex 32
```

Store the output. You'll paste it into Railway env AND into the claude.ai connector configuration.

## Deploy to Railway (step by step)

1. Create a GitHub repo for this folder (`~/.claude/mcp-servers/mailerlite-mcp/`) and push it.
2. Go to https://railway.com/new → "Deploy from GitHub repo" → pick the repo.
3. Railway auto-detects Node. In the service settings:
   - **Variables** tab → add `MAILERLITE_API_KEY` (your MailerLite key) and `MCP_BEARER_TOKEN` (the value from openssl above).
   - **Settings** → **Networking** → **Generate Domain** (gives you a public URL like `mailerlite-mcp-production.up.railway.app`).
4. Wait for the first deploy. Check logs — should see `mailerlite-mcp HTTP server listening on :...`.
5. Quick sanity check from your terminal:
   ```bash
   curl https://YOUR-RAILWAY-URL/
   # → {"status":"ok","service":"mailerlite-mcp","transport":"streamable-http"}
   ```

## Connect to claude.ai

1. https://claude.ai/settings/connectors → **Add custom connector**.
2. Name: `mailerlite`
3. MCP Server URL: `https://YOUR-RAILWAY-URL/mcp`
4. Authentication: **Bearer token** → paste the same `MCP_BEARER_TOKEN` value.
5. Save → connect → the tools should show up.

## Keep the local stdio version too?

Yes — for interactive Claude Code sessions on your Mac, stdio is faster and doesn't route through the internet. Both can coexist. Use stdio locally, use the Railway HTTP deploy for remote `/schedule` agents.
