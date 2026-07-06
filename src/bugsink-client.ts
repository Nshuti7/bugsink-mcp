/**
 * Thin wrapper around the Bugsink REST API (`/api/canonical/0/*`).
 *
 * Every Bugsink endpoint is namespaced under a stable "canonical/0" prefix
 * (Bugsink's own docs call this out — the layout stays flat even as internal
 * relationships change, so this client shouldn't need updates across minor
 * Bugsink versions).
 *
 * Auth: Bugsink uses a single bearer token per API key, sent as
 * `Authorization: Bearer <token>` on every request — no OAuth dance, no
 * refresh flow, which is why this can be a plain fetch wrapper instead of
 * something heavier.
 */

const BASE_URL = process.env.BUGSINK_BASE_URL;
const TOKEN = process.env.BUGSINK_TOKEN;

if (!BASE_URL) {
  throw new Error(
    "BUGSINK_BASE_URL is not set. Point it at your instance, e.g. https://bugsink.example.com"
  );
}
if (!TOKEN) {
  throw new Error(
    "BUGSINK_TOKEN is not set. Create an API token in your Bugsink instance's settings and set it as an env var."
  );
}

// Strip any trailing slash so we don't end up with "//api" in the URL.
const API_ROOT = `${BASE_URL.replace(/\/+$/, "")}/api/canonical/0`;

export type PeriodName = "year" | "month" | "week" | "day" | "hour" | "minute";
export type SortOrder = "asc" | "desc";

interface Paginated<T> {
  next: string | null;
  previous: string | null;
  results: T[];
}

/**
 * Builds a query string from an object, skipping any undefined/null values
 * so callers can pass optional filters without manually filtering them out.
 */
function toQuery(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return "";
  const search = new URLSearchParams(entries.map(([k, v]) => [k, String(v)]));
  return `?${search.toString()}`;
}

/**
 * Low-level request helper. Handles auth headers, error surfacing, and
 * picks JSON vs. plain text based on the response's content type (the
 * stacktrace-render endpoint returns `text/markdown`, everything else
 * returns `application/json`).
 */
async function request<T>(
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  const res = await fetch(`${API_ROOT}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Bugsink API ${options.method ?? "GET"} ${path} -> ${res.status}: ${detail}`);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return (await res.json()) as T;
  }
  return (await res.text()) as unknown as T;
}

// ---- Teams ----------------------------------------------------------------

export interface Team {
  id: string;
  name: string;
  visibility: "joinable" | "discoverable" | "hidden";
}

export function listTeams(cursor?: string) {
  return request<Paginated<Team>>(`/teams/${toQuery({ cursor })}`);
}

export function getTeam(id: string) {
  return request<Team>(`/teams/${id}/`);
}

// ---- Projects ---------------------------------------------------------------

export interface Project {
  id: number;
  team: string;
  name: string;
  slug: string;
  dsn: string;
  digested_event_count: number;
  stored_event_count: number;
  alert_on_new_issue: boolean;
  alert_on_regression: boolean;
  alert_on_unmute: boolean;
  visibility: "joinable" | "discoverable" | "team_members";
  retention_max_event_count: number;
}

export function listProjects(params: { team?: string; cursor?: string } = {}) {
  return request<Paginated<Project>>(`/projects/${toQuery(params)}`);
}

export function getProject(id: number, expand?: "team") {
  return request<Project>(`/projects/${id}/${toQuery({ expand })}`);
}

// ---- Issues -----------------------------------------------------------------

export interface Issue {
  id: string;
  friendly_id: string;
  project: number;
  digest_order: number;
  last_seen: string;
  first_seen: string;
  digested_event_count: number;
  stored_event_count: number;
  calculated_type: string;
  calculated_value: string;
  transaction: string;
  is_resolved: boolean;
  is_resolved_by_next_release: boolean;
  is_muted: boolean;
}

export function listIssues(params: {
  project: number;
  cursor?: string;
  order?: SortOrder;
  sort?: "digest_order" | "last_seen";
}) {
  return request<Paginated<Issue>>(`/issues/${toQuery(params)}`);
}

export function getIssue(id: string) {
  return request<Issue>(`/issues/${id}/`);
}

export function deleteIssue(id: string) {
  return request<void>(`/issues/${id}/`, { method: "DELETE" });
}

export function muteIssue(id: string) {
  return request<Issue>(`/issues/${id}/mute/`, { method: "POST" });
}

export function muteIssueFor(id: string, period_name: PeriodName, nr_of_periods: number) {
  return request<Issue>(`/issues/${id}/mute-for/`, {
    method: "POST",
    body: { period_name, nr_of_periods },
  });
}

export function muteIssueUntil(
  id: string,
  period_name: PeriodName,
  nr_of_periods: number,
  gte_threshold: number
) {
  return request<Issue>(`/issues/${id}/mute-until/`, {
    method: "POST",
    body: { period_name, nr_of_periods, gte_threshold },
  });
}

export function unmuteIssue(id: string) {
  return request<Issue>(`/issues/${id}/unmute/`, { method: "POST" });
}

export function resolveIssue(id: string) {
  return request<Issue>(`/issues/${id}/resolve/`, { method: "POST" });
}

export function resolveIssueLatest(id: string) {
  return request<Issue>(`/issues/${id}/resolve-latest/`, { method: "POST" });
}

export function resolveIssueNext(id: string) {
  return request<Issue>(`/issues/${id}/resolve-next/`, { method: "POST" });
}

export function addIssueComment(issue: string, comment: string) {
  return request<{ id: number; issue: string; project: number; timestamp: string; comment: string; user: number }>(
    `/issue-comments/`,
    { method: "POST", body: { issue, comment } }
  );
}

// ---- Events -----------------------------------------------------------------

export interface EventSummary {
  id: string;
  ingested_at: string;
  digested_at: string;
  issue: string;
  grouping: number;
  event_id: string;
  project: number;
  timestamp: string;
  digest_order: number;
}

export interface EventDetail extends EventSummary {
  data: unknown;
  stacktrace_md: string;
}

export function listEvents(params: { issue: string; cursor?: string; order?: SortOrder }) {
  return request<Paginated<EventSummary>>(`/events/${toQuery(params)}`);
}

export function getEvent(id: string) {
  return request<EventDetail>(`/events/${id}/`);
}

/** Returns the rendered stacktrace as markdown-ish plain text, not JSON. */
export function getEventStacktrace(id: string) {
  return request<string>(`/events/${id}/stacktrace/`);
}

// ---- Releases ---------------------------------------------------------------

export interface Release {
  id: string;
  project: number;
  version: string;
  date_released: string | null;
  semver?: string;
  is_semver?: boolean;
  sort_epoch?: number;
}

export function listReleases(params: { project: number; cursor?: string }) {
  return request<Paginated<Release>>(`/releases/${toQuery(params)}`);
}

export function getRelease(id: string) {
  return request<Release>(`/releases/${id}/`);
}

export function createRelease(project: number, version: string, timestamp?: string) {
  return request<Release>(`/releases/`, {
    method: "POST",
    body: { project, version, timestamp },
  });
}
