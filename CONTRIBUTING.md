# Contributing to bugsink-mcp

Thanks for wanting to help. This is a small project with a narrow scope (bridge Bugsink's REST API to MCP), so we want to keep the surface tight — but there's real room for contribution: new tools, security hardening, better docs, CI, examples.

## Ground rules

- **Be kind.** Assume good faith in reviews and issues.
- **One concern per PR.** A refactor + a new tool + a docs pass is three PRs, not one.
- **Open an issue before a big PR.** Fix-a-typo, add-a-tool-that-mirrors-one-Bugsink-endpoint: send the PR. Anything larger — new dependencies, auth changes, architectural shifts — start with an issue so we can align before you write code.
- **Keep the code style boring.** Straight TypeScript, no clever meta-programming. If a feature adds a runtime dependency, justify it in the PR description.

## Dev loop

Requirements: Node ≥ 18, pnpm ≥ 9, and access to any Bugsink instance for real end-to-end testing (a local docker-compose Bugsink is fine).

```bash
git clone https://github.com/YOUR-FORK/bugsink-mcp.git
cd bugsink-mcp
pnpm install
cp .env.example .env      # point at a test Bugsink and put a real token in

# Terminal 1 — TypeScript compiler in watch mode
pnpm run dev

# Terminal 2 — Node in watch mode, reads the compiled JS
node --env-file=.env --watch dist/index.js
```

Sanity check:

```bash
curl http://localhost:8787/healthz    # -> ok

# Minimal MCP handshake — should return a list of tools
curl -X POST http://localhost:8787/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Adding a new tool

Two files change:

1. **`src/bugsink-client.ts`** — add a typed wrapper around the Bugsink REST endpoint. Follow the pattern of existing functions (`listIssues`, `resolveIssue`, etc.). If the endpoint returns a shape we haven't seen, add an `interface` for it.
2. **`src/index.ts`** — register the tool inside `createMcpServer()` with a `zod` `inputSchema`, a short `title`, and a `description` written for the LLM (say *when* to use it, not just *what* it does).

Prefer `jsonResult(...)` for structured responses and `textResult(...)` for rendered text (like stacktraces).

Then rebuild and re-test with a real MCP client — `curl` alone can verify the tool is registered, but not that it behaves well with an LLM in the loop.

## Style

- **TypeScript strict mode is on.** Fix type errors properly; don't reach for `any` or `@ts-ignore`.
- **Comments explain *why*, not *what*.** The existing code has some fairly detailed comments where the behavior is non-obvious (stateless mode, content-type handling) — match that bar. Skip comments where the code speaks for itself.
- **No lint config is checked in yet.** If you want to add ESLint/Prettier, do it in its own PR with sensible defaults so we can discuss the config.

## Security-sensitive changes

If your PR touches authentication, request validation, the fetch client, or anything that changes what's logged, **call it out explicitly in the PR description**. Reviewers should be able to see the risk without reading the whole diff.

If you discover a security issue and disclosing it publicly would put users at risk, please open a [private security advisory](https://github.com/Nshuti7/bugsink-mcp/security/advisories/new) on GitHub instead of a public issue.

## Commit and PR conventions

- Present-tense, imperative commit subjects: `Add unmute_issue tool`, not `Added unmute_issue tool` or `unmute_issue`.
- Reference the issue in the PR body: `Closes #12`.
- Keep the diff minimal — unrelated formatting churn makes review harder.

## Releases

There aren't formal releases yet. If the project grows to the point where tagged versions and a changelog make sense, we'll add them then.

## Questions

Open an issue with the `question` label, or start a discussion. There's no private channel — everything happens on GitHub so future contributors can find it.
