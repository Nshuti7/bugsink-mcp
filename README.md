# bugsink-mcp

> A hosted **[Model Context Protocol](https://modelcontextprotocol.io/)** server that exposes your self-hosted [Bugsink](https://www.bugsink.com/) error tracker as tools an LLM (Claude, or anything else speaking MCP) can call directly.

[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/typescript-strict-blue)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

List issues, pull stacktraces, resolve or mute noise, tag releases — all from a chat prompt, without the LLM ever touching your Bugsink credentials directly.

---

## Table of contents

- [Why this exists](#why-this-exists)
- [What it covers](#what-it-covers)
- [Quick start](#quick-start)
- [Deploying](#deploying)
- [Registering with Claude (or another MCP client)](#registering-with-claude-or-another-mcp-client)
- [Security posture](#security-posture)
- [Configuration reference](#configuration-reference)
- [Contributing](#contributing)
- [License](#license)

---

## Why this exists

Bugsink is a self-hosted, single-tenant error tracker, so it isn't in Claude's public connector registry (there's no shared OAuth endpoint to register). That leaves two options:

1. **stdio MCP server** — Claude spawns the process locally per session. Works, but every machine needs the binary and env vars.
2. **hosted (Streamable HTTP) MCP server** — same shape as `mcp.vercel.com` or `mcp.render.com`, just deployed by you. Register once by URL and any Claude client can call it.

This project is option 2. You deploy it (Docker, VPS, one small container) and point Claude at `https://mcp.yourdomain.tld/mcp`. Claude never sees your Bugsink API token — this service holds it, translates MCP tool calls into REST calls, and streams the results back.

## What it covers

Every read/write endpoint in Bugsink's public API (`/api/canonical/0/*`):

| Area | Tools |
|---|---|
| **Teams & projects** | `list_teams`, `list_projects`, `get_project` |
| **Issues** | `list_issues`, `get_issue`, `add_issue_comment`, `resolve_issue` (now / on latest release / on next release), `mute_issue` (indefinite / for a period / until an event threshold), `unmute_issue`, `delete_issue` |
| **Events** | `list_events`, `get_event`, `get_event_stacktrace` (the rendered readable version — usually more useful than the raw JSON) |
| **Releases** | `list_releases`, `create_release`, `get_release` |

Each tool's input schema is declared with [zod](https://zod.dev/), so the MCP SDK rejects malformed calls before your handler runs.

## Quick start

Requirements: **Node ≥ 18**, **pnpm ≥ 9**, and an API token from your Bugsink instance (Account settings → API tokens).

```bash
git clone https://github.com/Nshuti7/bugsink-mcp.git
cd bugsink-mcp
pnpm install
pnpm run build

cp .env.example .env         # fill in BUGSINK_BASE_URL and BUGSINK_TOKEN
node --env-file=.env dist/index.js
```

You should see `bugsink-mcp listening on port 8787`. Verify with:

```bash
curl http://localhost:8787/healthz   # -> "ok"
```

For a live-rebuild dev loop:

```bash
pnpm run dev        # tsc --watch in one terminal
node --env-file=.env --watch dist/index.js   # in another
```

## Deploying

### Docker Compose (recommended)

The bundled `docker-compose.yml` assumes you already run [Traefik](https://traefik.io/) on the same host with an external network called `web`. Adjust the labels to match your setup, then:

```bash
export BUGSINK_TOKEN=your-real-token
docker compose up -d --build
```

### Docker without Traefik

Drop the `labels` and `networks` blocks and add a direct port mapping:

```yaml
    ports:
      - "8787:8787"
```

### Any other platform

It's a plain Node HTTP server on `$PORT` (default `8787`). Anything that can run a container or a Node process will host it — Fly.io, Render, Railway, a bare VPS with `pm2`, etc. There's no persistent state, so you can scale it horizontally without coordination.

## Registering with Claude (or another MCP client)

Once your instance is reachable over HTTPS:

```bash
claude mcp add --transport http bugsink https://mcp.yourdomain.tld/mcp
```

Or use Claude Desktop / Cowork's "custom connector by URL" setting if available. The endpoint speaks standard Streamable HTTP MCP, so [any compliant client](https://modelcontextprotocol.io/clients) will work.

## Security posture

**Read this before deploying.** The `/mcp` endpoint has **no authentication of its own**. Whoever can reach the URL can call every tool, including `delete_issue`. Two ways to handle that:

- **IP allowlist at Traefik** (cheapest, no code) — an example is commented into `docker-compose.yml`. Restrict to your home/office IP plus wherever your MCP client's egress comes from.
- **Shared-secret header** (code change) — check `req.headers['x-mcp-token']` at the top of the `/mcp` handler in [`src/index.ts`](src/index.ts) before doing anything else. A few lines, not a redesign. PRs for a first-class implementation of this are welcome — see [Contributing](#contributing).

The Bugsink API token itself lives only in this service's environment. It's never sent to the LLM, never logged, never persisted to disk.

## Configuration reference

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `BUGSINK_BASE_URL` | ✅ | — | Root URL of your Bugsink instance, e.g. `https://bugsink.example.com` |
| `BUGSINK_TOKEN` | ✅ | — | Bugsink API token (Account settings → API tokens) |
| `PORT` | | `8787` | HTTP port the MCP server binds to |

Missing `BUGSINK_BASE_URL` or `BUGSINK_TOKEN` fails fast on startup with a clear message.

## Contributing

Contributions are welcome — issues, PRs, docs fixes, new tools, security hardening, all of it. Start with [`CONTRIBUTING.md`](CONTRIBUTING.md) for the ground rules and dev loop.

Good first PRs, if you're looking for ideas:

- Add a shared-secret auth middleware for the `/mcp` endpoint (opt-in via env var)
- Cover any Bugsink endpoints that get added upstream
- A GitHub Actions workflow that runs `pnpm run build` on PRs
- Example client scripts (curl / Python / TS) that exercise the MCP endpoint end-to-end
- Structured logging with request IDs

Have an idea that's not on the list? Open an issue first so we can align on the shape before you write code.

## License

[MIT](LICENSE) © contributors
