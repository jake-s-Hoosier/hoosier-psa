import type { Company, Ticket, TicketNote, TimeEntry } from "@hoosier/shared";

export interface ListResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// Only used when the API runs with AUTH_MODE=dev (local development).
const DEV_MEMBER_ID = import.meta.env.VITE_DEV_MEMBER_ID ?? "1";

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  // x-dev-member-id only matters when the API runs with AUTH_MODE=dev; x-requested-with is the CSRF
  // header the API demands on every state-changing request when real sign-in is on.
  const headers: Record<string, string> = {
    "x-dev-member-id": DEV_MEMBER_ID,
    "x-requested-with": "hoosier-psa",
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (res.status === 401 && !path.startsWith("/api/v1/auth/")) {
    window.dispatchEvent(new Event("psa:unauthorized"));
  }
  if (!res.ok) {
    let title = res.statusText;
    try {
      const p = (await res.json()) as { title?: string; detail?: string };
      title = p.detail ?? p.title ?? title;
    } catch {
      /* body was not JSON */
    }
    throw new ApiError(res.status, title);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const get = <T>(path: string, signal?: AbortSignal) => request<T>("GET", path, undefined, signal);

export function listCompanies(q: string, signal?: AbortSignal): Promise<ListResponse<Company>> {
  const params = new URLSearchParams({ limit: "100" });
  if (q.trim()) params.set("q", q.trim());
  return get(`/api/v1/companies?${params}`, signal);
}

export interface SystemStatus {
  environment: "development" | "test" | "uat" | "shadow" | "production";
  writeMode: "read_only" | "read_write";
}

export function getSystemStatus(signal?: AbortSignal): Promise<SystemStatus> {
  return get("/api/v1/system/status", signal);
}

export interface Lookups {
  boards: Array<{
    id: number;
    name: string;
    statuses: Array<{ id: number; name: string; isClosed: boolean; isDefault: boolean }>;
  }>;
  priorities: Array<{ id: number; name: string; color: string | null }>;
  workRoles: Array<{ id: number; name: string }>;
  workTypes: Array<{ id: number; name: string; billTime: string }>;
}

export const getLookups = () => get<Lookups>("/api/v1/lookups");

export function listTickets(
  p: { q: string; state: "open" | "closed" | "all"; boardId?: number },
  signal?: AbortSignal,
): Promise<ListResponse<Ticket>> {
  const params = new URLSearchParams({ limit: "100", state: p.state });
  if (p.q.trim()) params.set("q", p.q.trim());
  if (p.boardId) params.set("boardId", String(p.boardId));
  return get(`/api/v1/tickets?${params}`, signal);
}

export const createTicket = (body: {
  summary: string;
  companyId: number;
  boardId: number;
  description?: string;
}) => request<Ticket>("POST", "/api/v1/tickets", body);

export const updateTicket = (id: number, body: { statusId?: number; priorityId?: number }) =>
  request<Ticket>("PATCH", `/api/v1/tickets/${id}`, body);

export const listNotes = (id: number, signal?: AbortSignal) =>
  get<{ items: TicketNote[] }>(`/api/v1/tickets/${id}/notes`, signal);

export const addNote = (id: number, body: { kind: string; body: string }) =>
  request<TicketNote>("POST", `/api/v1/tickets/${id}/notes`, body);

export const getTimer = (signal?: AbortSignal) =>
  get<{ timer: TimeEntry | null }>("/api/v1/time-entries/timer", signal);

export const startTimer = (body: {
  ticketId: number;
  workRoleId: number;
  workTypeId: number;
  notes?: string;
}) => request<TimeEntry>("POST", "/api/v1/time-entries/timer/start", body);

export const stopTimer = (notes?: string) =>
  request<TimeEntry>("POST", "/api/v1/time-entries/timer/stop", { notes });

export const logTime = (body: {
  ticketId: number;
  workRoleId: number;
  workTypeId: number;
  workDate: string;
  hours: number;
  notes?: string;
}) => request<TimeEntry>("POST", "/api/v1/time-entries", body);

export type AuthStage = "password_change" | "mfa_enroll" | "mfa_required" | "ok";
export interface AuthView {
  stage: AuthStage;
  member: { id: number; identifier: string; email: string; firstName: string; lastName: string };
}

export const authMe = () => get<AuthView>("/api/v1/auth/me");
export const authLogin = (identifier: string, password: string) =>
  request<AuthView>("POST", "/api/v1/auth/login", { identifier, password });
export const authLogout = () => request<undefined>("POST", "/api/v1/auth/logout").catch(() => {});
export const authVerifyMfa = (code: string) =>
  request<AuthView>("POST", "/api/v1/auth/mfa/verify", { code });
export const authChangePassword = (currentPassword: string, newPassword: string) =>
  request<AuthView>("POST", "/api/v1/auth/password", { currentPassword, newPassword });
export const authMfaSetup = () =>
  request<{ secret: string; otpauthUri: string }>("POST", "/api/v1/auth/mfa/setup");
export const authMfaEnable = (code: string) =>
  request<AuthView & { recoveryCodes: string[] }>("POST", "/api/v1/auth/mfa/enable", { code });
