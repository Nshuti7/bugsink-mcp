/**
 * Bugsink MCP server — hosted (Streamable HTTP) version.
 *
 * This now runs as a long-lived HTTP service instead of a stdio subprocess:
 * Claude (or anything else speaking MCP) connects over the network to
 * `POST /mcp`, the same shape as hosted servers like mcp.vercel.com or
 * mcp.render.com. That's what makes it "hostable" — you deploy this once
 * (e.g. in Docker on your VPS) and point Claude at a URL instead of a local
 * command.
 *
 * We use *stateless* mode (`sessionIdGenerator: undefined`), which the MCP
 * SDK's own docs recommend for simple deployments: instead of one long-lived
 * server instance shared across every caller (which would need session
 * tracking to keep requests from colliding), we spin up a fresh McpServer +
 * transport pair for *each* incoming request, handle it, then let it get
 * garbage collected. That's why all the tool registration lives inside
 * `createMcpServer()` below rather than at the top level — every request
 * gets its own isolated instance.
 *
 * Auth: the endpoint is gated by an optional shared-secret bearer token
 * (env var MCP_AUTH_TOKEN). When set, callers must present
 * `Authorization: Bearer <token>` on every /mcp POST. When unset, the
 * endpoint is open (matches the original behavior — kept opt-in so upgrading
 * doesn't lock existing deployments out). Either way, an IP allowlist at the
 * proxy layer is still a good defense-in-depth layer; see docker-compose.yml.
 *
 * Each `server.registerTool(...)` call maps one Bugsink REST endpoint to one
 * callable tool. The `inputSchema` (a zod object) is what lets Claude know
 * what arguments a tool takes and validates them before your code ever runs
 * — if a required field is missing, the SDK rejects the call before it
 * reaches the handler.
 */

import { timingSafeEqual } from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import * as bugsink from "./bugsink-client.js";

/** Small helper: every tool below returns its result as pretty-printed JSON text. */
function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * Builds one fully-configured McpServer instance with every tool registered.
 * Called fresh for each incoming HTTP request in stateless mode (see the
 * comment at the top of this file for why).
 */
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "bugsink-mcp",
    version: "1.0.0",
  });

  // ---- Teams & Projects -------------------------------------------------------

  server.registerTool(
    "list_teams",
    {
      title: "List Bugsink teams",
      description: "List every team on this Bugsink instance, ordered by name.",
      inputSchema: { cursor: z.string().optional().describe("Pagination cursor from a previous response") },
    },
    async ({ cursor }) => jsonResult(await bugsink.listTeams(cursor))
  );

  server.registerTool(
  "list_projects",
  {
    title: "List Bugsink projects",
    description: "List projects, optionally filtered to a single team.",
    inputSchema: {
      team: z.string().uuid().optional().describe("Team UUID to filter by"),
      cursor: z.string().optional(),
    },
  },
  async ({ team, cursor }) => jsonResult(await bugsink.listProjects({ team, cursor }))
);

server.registerTool(
  "get_project",
  {
    title: "Get a Bugsink project",
    description: "Retrieve one project by its integer ID. Use list_projects first to find the ID.",
    inputSchema: {
      id: z.number().int().describe("Integer project ID"),
      expandTeam: z.boolean().optional().describe("Include the full team object inline"),
    },
  },
  async ({ id, expandTeam }) => jsonResult(await bugsink.getProject(id, expandTeam ? "team" : undefined))
);

// ---- Issues -----------------------------------------------------------------

server.registerTool(
  "list_issues",
  {
    title: "List issues for a project",
    description:
      "List issues (grouped errors) for a project — this is usually the starting point for debugging: " +
      "find the issue, then use get_issue / list_events to dig into specific occurrences.",
    inputSchema: {
      project: z.number().int().describe("Integer project ID from list_projects"),
      order: z.enum(["asc", "desc"]).optional(),
      sort: z.enum(["digest_order", "last_seen"]).optional(),
      cursor: z.string().optional(),
    },
  },
  async ({ project, order, sort, cursor }) =>
    jsonResult(await bugsink.listIssues({ project, order, sort, cursor }))
);

server.registerTool(
  "get_issue",
  {
    title: "Get issue details",
    description: "Retrieve a single issue by UUID or friendly ID (e.g. 'PROJ-123').",
    inputSchema: { id: z.string().describe("Issue UUID or friendly ID") },
  },
  async ({ id }) => jsonResult(await bugsink.getIssue(id))
);

server.registerTool(
  "add_issue_comment",
  {
    title: "Comment on an issue",
    description: "Add a comment to an issue — handy for leaving a note on what you found while debugging.",
    inputSchema: {
      issue: z.string().describe("Issue UUID or friendly ID"),
      comment: z.string().describe("Comment text"),
    },
  },
  async ({ issue, comment }) => jsonResult(await bugsink.addIssueComment(issue, comment))
);

server.registerTool(
  "resolve_issue",
  {
    title: "Resolve an issue",
    description:
      "Mark an issue resolved. Variants: 'now' (immediately), 'latest_release' (resolved as of the " +
      "most recent release), or 'next_release' (will be considered resolved once the next release ships).",
    inputSchema: {
      id: z.string().describe("Issue UUID or friendly ID"),
      when: z.enum(["now", "latest_release", "next_release"]).default("now"),
    },
  },
  async ({ id, when }) => {
    if (when === "latest_release") return jsonResult(await bugsink.resolveIssueLatest(id));
    if (when === "next_release") return jsonResult(await bugsink.resolveIssueNext(id));
    return jsonResult(await bugsink.resolveIssue(id));
  }
);

server.registerTool(
  "mute_issue",
  {
    title: "Mute an issue",
    description:
      "Silence alerts for an issue. Omit period/threshold for an indefinite mute, set a period for a " +
      "temporary mute (e.g. 3 days), or set a threshold to auto-unmute once event volume passes it.",
    inputSchema: {
      id: z.string().describe("Issue UUID or friendly ID"),
      period_name: z.enum(["year", "month", "week", "day", "hour", "minute"]).optional(),
      nr_of_periods: z.number().int().min(1).optional(),
      gte_threshold: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("If set along with period_name/nr_of_periods, unmute once this many events land in that window"),
    },
  },
  async ({ id, period_name, nr_of_periods, gte_threshold }) => {
    if (gte_threshold !== undefined && period_name && nr_of_periods !== undefined) {
      return jsonResult(await bugsink.muteIssueUntil(id, period_name, nr_of_periods, gte_threshold));
    }
    if (period_name && nr_of_periods !== undefined) {
      return jsonResult(await bugsink.muteIssueFor(id, period_name, nr_of_periods));
    }
    return jsonResult(await bugsink.muteIssue(id));
  }
);

server.registerTool(
  "unmute_issue",
  {
    title: "Unmute an issue",
    description: "Remove any mute on an issue so alerts resume.",
    inputSchema: { id: z.string().describe("Issue UUID or friendly ID") },
  },
  async ({ id }) => jsonResult(await bugsink.unmuteIssue(id))
);

server.registerTool(
  "delete_issue",
  {
    title: "Delete an issue",
    description: "Permanently delete an issue and its events. There's no undo — confirm with the user first.",
    inputSchema: { id: z.string().describe("Issue UUID or friendly ID") },
  },
  async ({ id }) => {
    await bugsink.deleteIssue(id);
    return textResult(`Issue ${id} deleted.`);
  }
);

// ---- Events -----------------------------------------------------------------

server.registerTool(
  "list_events",
  {
    title: "List events for an issue",
    description: "List individual occurrences (events) that make up an issue, newest first by default.",
    inputSchema: {
      issue: z.string().describe("Issue UUID or friendly ID"),
      order: z.enum(["asc", "desc"]).optional(),
      cursor: z.string().optional(),
    },
  },
  async ({ issue, order, cursor }) => jsonResult(await bugsink.listEvents({ issue, order, cursor }))
);

server.registerTool(
  "get_event",
  {
    title: "Get event detail",
    description: "Retrieve one event's full payload (tags, context, request data) by its Bugsink-internal UUID.",
    inputSchema: { id: z.string().uuid().describe("Bugsink-internal event UUID, from list_events") },
  },
  async ({ id }) => jsonResult(await bugsink.getEvent(id))
);

server.registerTool(
  "get_event_stacktrace",
  {
    title: "Get event stacktrace",
    description:
      "Get the rendered stacktrace for one event as readable text (frames, source context, locals) — " +
      "usually more useful for diagnosis than the raw JSON from get_event.",
    inputSchema: { id: z.string().uuid().describe("Bugsink-internal event UUID, from list_events") },
  },
  async ({ id }) => textResult(await bugsink.getEventStacktrace(id))
);

// ---- Releases ---------------------------------------------------------------

server.registerTool(
  "list_releases",
  {
    title: "List releases for a project",
    description: "List releases recorded for a project.",
    inputSchema: {
      project: z.number().int().describe("Integer project ID"),
      cursor: z.string().optional(),
    },
  },
  async ({ project, cursor }) => jsonResult(await bugsink.listReleases({ project, cursor }))
);

server.registerTool(
    "create_release",
    {
      title: "Record a new release",
      description: "Register a new release for a project, e.g. right after a deploy, so issues can be tied to it.",
      inputSchema: {
        project: z.number().int(),
        version: z.string().describe("Version string, e.g. 'my-app@1.4.2'"),
        timestamp: z.string().datetime().optional(),
      },
    },
    async ({ project, version, timestamp }) => jsonResult(await bugsink.createRelease(project, version, timestamp))
  );

  return server;
}

// ---- HTTP entry point -------------------------------------------------------

const PORT = Number(process.env.PORT ?? 8787);

/**
 * Optional shared-secret gate on the /mcp endpoint. When MCP_AUTH_TOKEN is set,
 * every /mcp request must present the token as *either*:
 *   - `Authorization: Bearer <token>` (preferred, RFC 6750-clean), or
 *   - `?token=<token>` query param
 *
 * The query-param path exists so this server works with MCP client UIs that
 * only let you paste a URL (e.g. Cowork's "add custom connector" dialog),
 * with no way to attach a custom header. The token is only visible to
 * whoever already holds the URL, and this process doesn't log request URLs
 * — so the leakage vectors RFC 6750 warns about (access logs, referer
 * headers, browser history) don't apply to this deployment shape. Prefer
 * the header form when your client supports it.
 *
 * When MCP_AUTH_TOKEN is unset, the endpoint is open (matches prior
 * behavior — kept opt-in so upgrading doesn't lock existing deployments
 * out). Comparisons use timingSafeEqual so a byte-by-byte early return
 * can't leak the token via response-time differences.
 */
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
const MCP_AUTH_TOKEN_BUF = MCP_AUTH_TOKEN ? Buffer.from(MCP_AUTH_TOKEN, "utf8") : null;

function tokensMatch(presented: string): boolean {
  if (!MCP_AUTH_TOKEN_BUF) return true;
  const buf = Buffer.from(presented, "utf8");
  if (buf.length !== MCP_AUTH_TOKEN_BUF.length) return false;
  return timingSafeEqual(buf, MCP_AUTH_TOKEN_BUF);
}

function isAuthorized(req: express.Request): boolean {
  if (!MCP_AUTH_TOKEN_BUF) return true;

  const header = req.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    return tokensMatch(header.slice("Bearer ".length));
  }

  const queryToken = req.query.token;
  if (typeof queryToken === "string") {
    return tokensMatch(queryToken);
  }

  return false;
}

function unauthorized(res: express.Response) {
  res.setHeader("WWW-Authenticate", 'Bearer realm="bugsink-mcp"');
  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Unauthorized" },
    id: null,
  });
}

const app = express();
app.use(express.json());

/**
 * Handles a single MCP request. Stateless mode: a fresh server + transport
 * are created per request, so there's no shared state between callers and
 * no session bookkeeping to get wrong.
 */
app.post("/mcp", async (req, res) => {
  if (!isAuthorized(req)) {
    unauthorized(res);
    return;
  }
  try {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Stateless mode doesn't support server-initiated notifications over GET,
// or session teardown over DELETE — both just return "not supported".
const methodNotAllowed = (_req: express.Request, res: express.Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed in stateless mode." },
    id: null,
  });
};
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

// Plain health check for Docker/Traefik, unrelated to the MCP protocol itself.
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

app.listen(PORT, () => {
  console.log(`bugsink-mcp listening on port ${PORT}`);
  if (!MCP_AUTH_TOKEN) {
    console.warn(
      "[warn] MCP_AUTH_TOKEN is not set — /mcp is open to anyone who can reach this port. " +
        "Set MCP_AUTH_TOKEN or restrict access at the proxy layer (see README)."
    );
  }
});
