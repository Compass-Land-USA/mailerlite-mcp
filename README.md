# mailerlite-mcp

MCP server for MailerLite Classic v2. Two transports:
- `server.js` — HTTP/Streamable, runs on vps1 and is published at `https://mailerlite-mcp.compasslandusa.com` (used by the team's Claude Desktop connectors)
- `index.js` — stdio for local Claude Code

## Tools exposed

`list_groups`, `list_segments`, `list_campaigns`, `get_campaign`, `create_campaign_draft`, `set_campaign_content`, `schedule_campaign`, `cancel_campaign`, `delete_campaign`, `get_campaign_stats`, `get_account_stats`, `get_account`.

MailerLite Classic v2 has no single-campaign GET, so `get_campaign` and `get_campaign_stats` look the id up in the sent, outbox and draft lists. `list_segments` returns summary fields only: the raw segment filter rules can contain subscriber emails. API reference: https://developers-classic.mailerlite.com/llms.txt

## Environment variables

Kept in `.env` in this folder (gitignored, `chmod 600`). See `.env.example`.

| Variable | Purpose |
|---|---|
| `MAILERLITE_API_KEY` | MailerLite Classic API token |
| `MCP_BEARER_TOKEN` | Access token issued after sign-in (`openssl rand -hex 32`) |
| `MCP_LOGIN_PASSWORD` | Shared team password asked for when connecting (`openssl rand -base64 18`) |
| `PORT` | Listen port (`3100`) |
| `HOST` | Listen address (`172.19.0.1`, the n8n-server Docker network gateway, so Caddy can reach it) |

Changing `MCP_BEARER_TOKEN` disconnects everyone; they reconnect with the team password. Changing `MCP_LOGIN_PASSWORD` only affects new connections.

## How it runs on vps1

- **systemd**: `/etc/systemd/system/mailerlite-mcp.service` runs `node server.js` from `/root/github/mailerlite-mcp` with `EnvironmentFile=.env`, `Restart=always`, `MemoryMax=256M` (uses ~100 MB).
  - Logs: `journalctl -u mailerlite-mcp -f`
  - Deploy a change: `git pull && npm ci --omit=dev && systemctl restart mailerlite-mcp`
  - Node comes from nvm (`/root/.nvm/versions/node/v26.7.0/bin/node`); update `ExecStart` if that changes.
- **Caddy**: the `mailerlite-mcp.compasslandusa.com` block in `n8n-server/caddy/Caddyfile` proxies `/`, `/mcp`, `/authorize`, `/token`, `/register` and `/.well-known/*` to `172.19.0.1:3100`; everything else is 404. Reload with `docker exec n8n-server-caddy-1 caddy reload --config /etc/caddy/Caddyfile`.
- **ufw**: `allow from 172.19.0.0/16 to 172.19.0.1 port 3100` (Caddy container → host).
- **DNS**: A record `mailerlite-mcp.compasslandusa.com → 5.161.203.14`.

## Auth

OAuth 2.1 with Dynamic Client Registration, as Claude expects. `/authorize` shows a password page; the right team password issues a single-use, 5-minute code (PKCE S256 required, redirect only to Claude's callback URLs). `/token` exchanges it for `MCP_BEARER_TOKEN`. 10 wrong passwords from one IP lock it out for 15 minutes.

## Connect from Claude Desktop

1. Settings → Connectors → **Add custom connector**.
2. Name: `mailerlite`
3. URL: `https://mailerlite-mcp.compasslandusa.com/mcp`
4. Click **Connect**, enter the team password in the browser page that opens.

## Local stdio version

`MAILERLITE_API_KEY=... node index.js` — register it in `~/.claude.json` for Claude Code if you want to skip the network hop.
