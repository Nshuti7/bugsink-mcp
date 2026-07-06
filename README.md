# bugsink-mcp

A hosted MCP server exposing your self-hosted [Bugsink](https://www.bugsink.com/) error tracker (at `bugsink.example.com`) as tools Claude can call directly — list issues, pull stacktraces, resolve/mute issues, tag releases.

Bugsink isn't in Cowork's connector registry (it's self-hosted, so there's no shared OAuth endpoint to register), so this runs as its own small service — the same shape as hosted MCP servers like `mcp.vercel.com` or `mcp.render.com`, just deployed by you instead of a vendor. Claude connects to it over `POST /mcp`; this service makes the actual HTTPS calls to your Bugsink instance using your API token.

## What it covers

Every read/write endpoint in Bugsink's public API (`/api/canonical/0/*`):

- **Teams & projects** — `list_teams`, `list_projects`, `get_project`
- **Issues** — `list_issues`, `get_issue`, `add_issue_comment`, `resolve_issue` (now / on latest release / on next release), `mute_issue` (indefinite / for a period / until an event threshold), `unmute_issue`, `delete_issue`
- **Events** — `list_events`, `get_event`, `get_event_stacktrace` (the rendered, readable version — usually more useful than the raw JSON)
- **Releases** — `list_releases`, `create_release`, `get_release`

## Security posture — read this before deploying

This endpoint has **no authentication of its own**. Whoever can reach the URL can call every tool above against your real Bugsink instance, including `delete_issue`. That was your call, and it's a reasonable one if:

- the URL isn't linked from anywhere public, and
- you're comfortable with "security through obscurity + it's just my own data" for this particular service.

The cheapest mitigation that doesn't touch any code: an IP allowlist at the Traefik layer (a commented-out example is in `docker-compose.yml`). If you ever want real auth without much effort, the natural next step is checking a shared-secret header (e.g. `X-MCP-Token`) at the top of the `/mcp` handler in `src/index.ts` before it does anything else — a few lines, not a redesign.

## Get your Bugsink API token

In your Bugsink instance, go to your account/API settings and create a token. Same "token" concept as a Sentry SDK DSN, but this one authenticates the *management* API, not event ingestion.

## Local development

```bash
pnpm install
pnpm run build
cp .env.example .env    # fill in your real token
node --env-file=.env dist/index.js
```

It should print `bugsink-mcp listening on port 8787`. Sanity check with:

```bash
curl http://localhost:8787/healthz   # -> "ok"
```

## Deploying with Docker

```bash
BUGSINK_TOKEN=your-real-token docker compose up -d --build
```

`docker-compose.yml` assumes you already have a Traefik instance running on this VPS (the same one fronting SkillSwap) with an external network called `web`. Adjust the `entrypoints` / `certresolver` names in the labels to match your actual Traefik config, and swap `mcp.example.com` for whichever subdomain you want to use.

If you'd rather run it without Traefik for now, drop the `labels`/`networks` blocks and add a straight `ports: ["8787:8787"]` mapping instead.

## Pushing this to GitHub

No GitHub tool was available to push this for you automatically this session (the connector never finished authorizing), so do it from your machine:

```bash
cd bugsink-mcp
git init
git add .
git commit -m "Initial commit: Bugsink MCP server"
git branch -M main
git remote add origin git@github.com:<your-username>/bugsink-mcp.git
git push -u origin main
```

Create the empty repo on GitHub first (via the website, or `gh repo create bugsink-mcp --public --source=. --remote=origin` if you have the `gh` CLI). The `.gitignore` already excludes `node_modules`, `dist`, and `.env`, so your token won't end up in the repo as long as it only ever lives in `.env` or your deploy environment's variables — never commit it directly into `docker-compose.yml` or any other tracked file.

## Registering it with Claude

Once deployed, this becomes a **remote** MCP server (URL-based), not a local one — register it the same way you would any hosted MCP endpoint:

```bash
claude mcp add --transport http bugsink https://mcp.example.com/mcp
```

Or via Cowork/Claude Desktop's connector settings, if there's a "custom connector by URL" option there.

## Why a bearer token to Bugsink, but no OAuth

Registry connectors like Vercel or GitHub use OAuth because they're multi-tenant SaaS — Claude needs to prove *which* account it's acting as. Your Bugsink instance is single-tenant (just you), so a static bearer token is the simpler, correct primitive for the Bugsink side — it's exactly what Bugsink's own docs recommend for their API. The *this service's own endpoint* auth question is separate (see "Security posture" above) and currently unimplemented, by choice.
