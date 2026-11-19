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
  members: Array<{ id: number; identifier: string; name: string; isFieldTech: boolean }>;
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
  /** What this member may do; empty until they are fully signed in. */
  permissions: string[];
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

// ---- Administration (iam.manage) ----
export interface AdminRole {
  id: number;
  name: string;
  description: string | null;
  isSystem: boolean;
  customized: boolean;
  permissions: string[];
  memberCount: number;
}
export interface AdminMember {
  id: number;
  identifier: string;
  firstName: string;
  lastName: string;
  email: string;
  isActive: boolean;
  hasLogin: boolean;
  mfaEnabled: boolean;
  roleIds: number[];
}
export interface PermissionInfo {
  key: string;
  description: string;
}
export const adminPermissions = () => get<{ items: PermissionInfo[] }>("/api/v1/admin/permissions");
export const adminRoles = () => get<{ items: AdminRole[] }>("/api/v1/admin/roles");
export const adminMembers = () => get<{ items: AdminMember[] }>("/api/v1/admin/members");
export const adminCreateRole = (body: {
  name: string;
  description?: string;
  permissions: string[];
}) => request<AdminRole>("POST", "/api/v1/admin/roles", body);
export const adminUpdateRole = (
  id: number,
  body: { name?: string; description?: string | null; permissions?: string[] },
) => request<AdminRole>("PATCH", `/api/v1/admin/roles/${id}`, body);
export const adminResetRole = (id: number) =>
  request<AdminRole>("POST", `/api/v1/admin/roles/${id}/reset`);
export const adminDeleteRole = (id: number) =>
  request<undefined>("DELETE", `/api/v1/admin/roles/${id}`);
export const adminSetMemberRoles = (id: number, roleIds: number[]) =>
  request<{ memberId: number; roleIds: number[] }>("PUT", `/api/v1/admin/members/${id}/roles`, {
    roleIds,
  });
export const adminSetMemberActive = (id: number, isActive: boolean) =>
  request<{ id: number; isActive: boolean }>("PATCH", `/api/v1/admin/members/${id}`, { isActive });

// ---- Ticket resources and attachments ----
export interface TicketResource {
  memberId: number;
  identifier: string;
  name: string;
  addedAt: string;
}
export interface TicketAttachment {
  id: number;
  ticketId: number;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadedByMemberId: number | null;
  createdAt: string;
}
export const listResources = (ticketId: number) =>
  get<{ items: TicketResource[] }>(`/api/v1/tickets/${ticketId}/resources`);
export const addResource = (ticketId: number, memberId: number) =>
  request<{ items: TicketResource[] }>("POST", `/api/v1/tickets/${ticketId}/resources`, {
    memberId,
  });
export const removeResource = (ticketId: number, memberId: number) =>
  request<{ items: TicketResource[] }>(
    "DELETE",
    `/api/v1/tickets/${ticketId}/resources/${memberId}`,
  );
export const listAttachments = (ticketId: number) =>
  get<{ items: TicketAttachment[] }>(`/api/v1/tickets/${ticketId}/attachments`);
export const deleteAttachment = (ticketId: number, id: number) =>
  request<undefined>("DELETE", `/api/v1/tickets/${ticketId}/attachments/${id}`);

/** The file itself is the request body; the API reads its name from the query string. */
export async function uploadAttachment(ticketId: number, file: File): Promise<TicketAttachment> {
  const res = await fetch(
    `/api/v1/tickets/${ticketId}/attachments?filename=${encodeURIComponent(file.name)}`,
    {
      method: "POST",
      headers: {
        "x-dev-member-id": DEV_MEMBER_ID,
        "x-requested-with": "hoosier-psa",
        "content-type": file.type || "application/octet-stream",
      },
      body: file,
    },
  );
  if (res.status === 401) window.dispatchEvent(new Event("psa:unauthorized"));
  if (!res.ok) {
    let message = res.status === 413 ? "That file is too large (25 MB limit)" : res.statusText;
    try {
      const p = (await res.json()) as { title?: string; detail?: string };
      if (res.status !== 413) message = p.detail ?? p.title ?? message;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as TicketAttachment;
}

/** Fetches with the same headers as every other call, then hands the bytes to the browser as a download. */
export async function downloadAttachment(att: TicketAttachment): Promise<void> {
  const res = await fetch(`/api/v1/tickets/${att.ticketId}/attachments/${att.id}/download`, {
    headers: { "x-dev-member-id": DEV_MEMBER_ID },
  });
  if (!res.ok) throw new ApiError(res.status, res.statusText);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = att.fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
