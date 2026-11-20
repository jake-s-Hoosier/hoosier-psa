import type {
  Activity,
  ActivityCreate,
  AdditionCreate,
  Agreement,
  AgreementAddition,
  AgreementCreate,
  AgreementDetail,
  AgreementServiceReport,
  AgreementUpdate,
  BillingMilestone,
  BillingRun,
  BillingRunPreview,
  Company,
  CompanyNote,
  CompanyNoteCreate,
  CompanyOverview,
  CompanyUpdate,
  Contact,
  ContactInput,
  CreditMemo,
  CreditMemoCreate,
  DispatchBoard,
  ExternalEntityType,
  ExternalRef,
  ExternalRefCreate,
  Invoice,
  InvoiceLineUpdate,
  InvoiceUpdate,
  MilestoneInput,
  Opportunity,
  OpportunityCreate,
  OpportunityUpdate,
  OrderConvert,
  OrderLineInput,
  PayPeriod,
  Payment,
  PaymentCreate,
  PayrollRow,
  Phase,
  PhaseCreate,
  PhaseUpdate,
  ProductChoice,
  Project,
  ProjectBilling,
  ProjectBillingMode,
  ProjectCreate,
  ProjectMarginReport,
  ProjectUpdate,
  RmrGrouping,
  RmrReport,
  SalesOrder,
  SalesOrderCreate,
  SalesOrderLine,
  SalesOrderUpdate,
  SalesStage,
  ScheduleEntry,
  ScheduleEntryCreate,
  ScheduleEntryUpdate,
  Site,
  SiteInput,
  Ticket,
  TicketCharge,
  TicketNote,
  TimeEntry,
  TimeEntryCreate,
  TimeEntryUpdate,
} from "@hoosier/shared";

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
  companyStatuses: Array<{ id: number; name: string }>;
  territories: Array<{ id: number; name: string }>;
  agreementTypes: Array<{
    id: number;
    name: string;
    billCycle: string;
    coverage: string;
    autoRenew: boolean;
  }>;
}

export const getLookups = () => get<Lookups>("/api/v1/lookups");

export function listTickets(
  p: {
    q: string;
    state: "open" | "closed" | "all";
    boardId?: number;
    companyId?: number;
    siteId?: number;
    contactId?: number;
  },
  signal?: AbortSignal,
): Promise<ListResponse<Ticket>> {
  const params = new URLSearchParams({ limit: "100", state: p.state });
  if (p.q.trim()) params.set("q", p.q.trim());
  if (p.boardId) params.set("boardId", String(p.boardId));
  if (p.companyId) params.set("companyId", String(p.companyId));
  if (p.siteId) params.set("siteId", String(p.siteId));
  if (p.contactId) params.set("contactId", String(p.contactId));
  return get(`/api/v1/tickets?${params}`, signal);
}

export const getTicket = (id: number, signal?: AbortSignal) =>
  get<Ticket>(`/api/v1/tickets/${id}`, signal);

export const createTicket = (body: {
  summary: string;
  companyId: number;
  siteId?: number;
  contactId?: number;
  boardId: number;
  description?: string;
  projectId?: number;
  phaseId?: number;
}) => request<Ticket>("POST", "/api/v1/tickets", body);

export const updateTicket = (
  id: number,
  body: {
    statusId?: number;
    priorityId?: number;
    companyId?: number;
    siteId?: number | null;
    agreementId?: number | null;
    contactId?: number | null;
    billingMethod?: Ticket["billingMethod"];
    billingAmount?: number | null;
  },
) => request<Ticket>("PATCH", `/api/v1/tickets/${id}`, body);

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
export const listCharges = (ticketId: number) =>
  get<{ items: TicketCharge[] }>(`/api/v1/tickets/${ticketId}/charges`);
export const addCharge = (
  ticketId: number,
  body: {
    kind: "product" | "expense";
    productId?: number;
    description?: string;
    quantity: number;
    unitPrice?: number;
    unitCost?: number;
    taxable?: boolean;
    billable?: TicketCharge["billable"];
    incurredOn?: string;
  },
) => request<TicketCharge>("POST", `/api/v1/tickets/${ticketId}/charges`, body);
export const deleteCharge = (ticketId: number, id: number) =>
  request<undefined>("DELETE", `/api/v1/tickets/${ticketId}/charges/${id}`);
export const searchProducts = (q: string) =>
  get<{ items: ProductChoice[] }>(`/api/v1/lookups/products?q=${encodeURIComponent(q)}`);

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

// ---- Inbound email (service.mailbox.manage) ----
export interface MailboxView {
  id: number;
  address: string;
  boardId: number;
  board: string;
  priorityId: number | null;
  fallbackCompanyId: number;
  fallbackCompany: string;
  reopenOnReply: boolean;
  isActive: boolean;
  pollFrom: string;
  lastReceivedAt: string | null;
  lastPolledAt: string | null;
  lastError: string | null;
}
export interface InboundMessage {
  id: number;
  mailbox: string;
  fromAddress: string;
  fromName: string | null;
  subject: string;
  receivedAt: string;
  outcome: "created" | "created_unmatched" | "appended" | "ignored" | "error";
  reason: string | null;
  ticketId: number | null;
  attachmentsStored: number;
  attachmentsSkipped: number;
}
export const listMailboxes = () => get<{ items: MailboxView[] }>("/api/v1/mailboxes");
export const createMailbox = (body: {
  address: string;
  boardId: number;
  fallbackCompanyId: number;
}) => request<MailboxView>("POST", "/api/v1/mailboxes", body);
export const updateMailbox = (
  id: number,
  body: {
    isActive?: boolean;
    reopenOnReply?: boolean;
    boardId?: number;
    fallbackCompanyId?: number;
  },
) => request<MailboxView>("PATCH", `/api/v1/mailboxes/${id}`, body);
export const listInboundMessages = (outcome?: string) =>
  get<{ items: InboundMessage[] }>(
    `/api/v1/mailboxes/messages${outcome ? `?outcome=${outcome}` : ""}`,
  );

// ---- CRM records ------------------------------------------------------------------------------

export const getCompanyOverview = (id: number, signal?: AbortSignal) =>
  get<CompanyOverview>(`/api/v1/companies/${id}/overview`, signal);
export const createCompany = (body: {
  identifier: string;
  name: string;
  statusId: number;
  phone?: string;
  website?: string;
}) => request<Company>("POST", "/api/v1/companies", body);
export const updateCompany = (id: number, body: CompanyUpdate) =>
  request<Company>("PATCH", `/api/v1/companies/${id}`, body);

export const createSite = (companyId: number, body: SiteInput) =>
  request<Site>("POST", `/api/v1/companies/${companyId}/sites`, body);
export const updateSite = (companyId: number, siteId: number, body: Partial<SiteInput>) =>
  request<Site>("PATCH", `/api/v1/companies/${companyId}/sites/${siteId}`, body);
export const deleteSite = (companyId: number, siteId: number) =>
  request<undefined>("DELETE", `/api/v1/companies/${companyId}/sites/${siteId}`);

export const createContact = (companyId: number, body: ContactInput) =>
  request<Contact>("POST", `/api/v1/companies/${companyId}/contacts`, body);
export const updateContact = (companyId: number, contactId: number, body: Partial<ContactInput>) =>
  request<Contact>("PATCH", `/api/v1/companies/${companyId}/contacts/${contactId}`, body);
export const deleteContact = (companyId: number, contactId: number) =>
  request<undefined>("DELETE", `/api/v1/companies/${companyId}/contacts/${contactId}`);

export const listCompanyNotes = (companyId: number, signal?: AbortSignal) =>
  get<{ items: CompanyNote[] }>(`/api/v1/companies/${companyId}/notes`, signal);
export const addCompanyNote = (companyId: number, body: CompanyNoteCreate) =>
  request<CompanyNote>("POST", `/api/v1/companies/${companyId}/notes`, body);

export const listCompanyTime = (companyId: number, signal?: AbortSignal) =>
  get<ListResponse<TimeEntry>>(`/api/v1/time-entries?companyId=${companyId}&limit=25`, signal);

// ---- Time: timesheet, approvals, pay periods ----
export const listTimeEntries = (
  from: string,
  to: string,
  memberId?: number,
  signal?: AbortSignal,
) =>
  get<ListResponse<TimeEntry>>(
    `/api/v1/time-entries?from=${from}&to=${to}&limit=200${memberId ? `&memberId=${memberId}` : ""}`,
    signal,
  );
export const createTimeEntry = (body: TimeEntryCreate) =>
  request<TimeEntry>("POST", "/api/v1/time-entries", body);
export const updateTimeEntry = (id: number, body: TimeEntryUpdate) =>
  request<TimeEntry>("PATCH", `/api/v1/time-entries/${id}`, body);
export const deleteTimeEntry = (id: number) =>
  request<undefined>("DELETE", `/api/v1/time-entries/${id}`);

export const submitTimesheet = (from: string, to: string) =>
  request<{ submitted: number }>("POST", "/api/v1/timesheets/submit", { from, to });
export const recallTimesheet = (from: string, to: string) =>
  request<{ recalled: number }>("POST", "/api/v1/timesheets/recall", { from, to });
export const approveTimesheet = (memberId: number, from: string, to: string) =>
  request<{ approved: number }>("POST", "/api/v1/timesheets/approve", { memberId, from, to });

export interface TimesheetSummaryRow {
  memberId: number;
  identifier: string;
  status: string;
  entries: number;
  hours: number;
}
export const timesheetSummary = (from: string, to: string, signal?: AbortSignal) =>
  get<{ items: TimesheetSummaryRow[] }>(`/api/v1/timesheets/summary?from=${from}&to=${to}`, signal);

export interface PayrollPreview {
  period: PayPeriod;
  unsubmittedEntries: number;
  items: PayrollRow[];
  warnings: string[];
}
export const listPayPeriods = (signal?: AbortSignal) =>
  get<{ items: PayPeriod[] }>("/api/v1/pay-periods", signal);
export const generatePayPeriods = (year: number, month: number) =>
  request<{ items: PayPeriod[] }>("POST", "/api/v1/pay-periods/generate", { year, month });
export const getPayrollPreview = (id: number, signal?: AbortSignal) =>
  get<PayrollPreview>(`/api/v1/pay-periods/${id}/payroll`, signal);
export const lockPayPeriod = (id: number) =>
  request<PayPeriod>("POST", `/api/v1/pay-periods/${id}/lock`);

/** The first export marks the period exported; the file itself is handed to the browser as a download. */
export async function exportPayPeriodCsv(id: number): Promise<void> {
  const res = await fetch(`/api/v1/pay-periods/${id}/export?format=csv`, {
    method: "POST",
    headers: { "x-dev-member-id": DEV_MEMBER_ID, "x-requested-with": "hoosier-psa" },
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const p = (await res.json()) as { title?: string; detail?: string };
      message = p.detail ?? p.title ?? message;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, message);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1];
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name ?? `payroll-${id}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---- Agreements ----
export const listAgreements = (
  p: { q?: string; status?: string; companyId?: number; typeId?: number },
  signal?: AbortSignal,
) => {
  const params = new URLSearchParams({ limit: "200", status: p.status ?? "active" });
  if (p.q?.trim()) params.set("q", p.q.trim());
  if (p.companyId) params.set("companyId", String(p.companyId));
  if (p.typeId) params.set("typeId", String(p.typeId));
  return get<ListResponse<Agreement>>(`/api/v1/agreements?${params}`, signal);
};
export const getAgreement = (id: number, signal?: AbortSignal) =>
  get<AgreementDetail>(`/api/v1/agreements/${id}`, signal);
export const createAgreement = (body: AgreementCreate) =>
  request<Agreement>("POST", "/api/v1/agreements", body);
export const updateAgreement = (id: number, body: AgreementUpdate) =>
  request<Agreement>("PATCH", `/api/v1/agreements/${id}`, body);
export const cancelAgreement = (id: number, date: string, reason: string) =>
  request<Agreement>("POST", `/api/v1/agreements/${id}/cancel`, { date, reason });
export const addAddition = (id: number, body: AdditionCreate) =>
  request<AgreementAddition>("POST", `/api/v1/agreements/${id}/additions`, body);
export const changeAddition = (
  id: number,
  additionId: number,
  body: { effectiveFrom: string; quantity?: number; unitPrice?: number; unitCost?: number },
) =>
  request<AgreementAddition>(
    "POST",
    `/api/v1/agreements/${id}/additions/${additionId}/change`,
    body,
  );
export const endAddition = (id: number, additionId: number, date: string) =>
  request<AgreementAddition>("POST", `/api/v1/agreements/${id}/additions/${additionId}/end`, {
    date,
  });
export const createAgreementType = (body: {
  name: string;
  billCycle: string;
  coverage: string;
  autoRenew: boolean;
}) => request<{ id: number }>("POST", "/api/v1/agreements/types", body);

// ---- Billing ----
export const listBillingRuns = (signal?: AbortSignal) =>
  get<{ items: BillingRun[] }>("/api/v1/billing/runs", signal);
export const getBillingRun = (id: number, signal?: AbortSignal) =>
  get<BillingRun>(`/api/v1/billing/runs/${id}`, signal);
/** An agreement run bills a month; a ticket run bills approved time through a date. */
export type RunTarget =
  | { kind: "agreement"; month: string }
  | { kind: "ticket"; throughDate: string }
  | {
      kind: "project";
      projectId: number;
      phaseId?: number;
      mode: ProjectBillingMode;
      throughDate?: string;
      amount?: number;
      percent?: number;
      description?: string;
      milestoneId?: number;
    };
export const previewBillingRun = (target: RunTarget, invoiceDate: string) =>
  request<BillingRunPreview>("POST", "/api/v1/billing/runs", {
    ...target,
    invoiceDate,
    preview: true,
  });
export const createBillingRun = (target: RunTarget, invoiceDate: string, notes?: string) =>
  request<BillingRun>("POST", "/api/v1/billing/runs", { ...target, invoiceDate, notes });
export const discardBillingRun = (id: number) =>
  request<BillingRun>("POST", `/api/v1/billing/runs/${id}/discard`);
export const postBillingRun = (id: number) =>
  request<BillingRun>("POST", `/api/v1/billing/runs/${id}/post`);
export const listInvoices = (
  p: { q?: string; status?: string; companyId?: number },
  signal?: AbortSignal,
) => {
  const params = new URLSearchParams({ limit: "200", status: p.status ?? "all" });
  if (p.q?.trim()) params.set("q", p.q.trim());
  if (p.companyId) params.set("companyId", String(p.companyId));
  return get<ListResponse<Invoice>>(`/api/v1/billing/invoices?${params}`, signal);
};
export const getInvoice = (id: number, signal?: AbortSignal) =>
  get<Invoice>(`/api/v1/billing/invoices/${id}`, signal);
export const updateInvoice = (id: number, body: InvoiceUpdate) =>
  request<Invoice>("PATCH", `/api/v1/billing/invoices/${id}`, body);
export const deleteInvoice = (id: number) =>
  request<void>("DELETE", `/api/v1/billing/invoices/${id}`);
export const updateInvoiceLine = (id: number, lineId: number, body: InvoiceLineUpdate) =>
  request<Invoice>("PATCH", `/api/v1/billing/invoices/${id}/lines/${lineId}`, body);
export const deleteInvoiceLine = (id: number, lineId: number) =>
  request<Invoice>("DELETE", `/api/v1/billing/invoices/${id}/lines/${lineId}`);
export const voidInvoice = (id: number, reason: string) =>
  request<Invoice>("POST", `/api/v1/billing/invoices/${id}/void`, { reason });

export const listPayments = (
  p: { state?: string; companyId?: number; invoiceId?: number },
  signal?: AbortSignal,
) => {
  const params = new URLSearchParams({ limit: "200", state: p.state ?? "posted" });
  if (p.companyId) params.set("companyId", String(p.companyId));
  if (p.invoiceId) params.set("invoiceId", String(p.invoiceId));
  return get<ListResponse<Payment>>(`/api/v1/payments?${params}`, signal);
};
export const createPayment = (body: PaymentCreate) =>
  request<Payment>("POST", "/api/v1/payments", body);
export const applyPayment = (id: number, invoiceId: number, amount: number) =>
  request<Payment>("POST", `/api/v1/payments/${id}/apply`, { invoiceId, amount });
export const unapplyPayment = (id: number, applicationId: number) =>
  request<Payment>("DELETE", `/api/v1/payments/${id}/applications/${applicationId}`);
export const voidPayment = (id: number, reason: string) =>
  request<Payment>("POST", `/api/v1/payments/${id}/void`, { reason });

/** Fetches the invoice PDF with the same headers as every other call, then opens it in a new tab. */
export async function openInvoicePdf(id: number): Promise<void> {
  const res = await fetch(`/api/v1/billing/invoices/${id}/pdf`, {
    headers: { "x-dev-member-id": DEV_MEMBER_ID, "x-requested-with": "hoosier-psa" },
  });
  if (!res.ok) throw new ApiError(res.status, res.statusText);
  const url = URL.createObjectURL(await res.blob());
  window.open(url, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export const listCreditMemos = (
  p: { state?: string; companyId?: number; invoiceId?: number },
  signal?: AbortSignal,
) => {
  const params = new URLSearchParams({ limit: "200", state: p.state ?? "posted" });
  if (p.companyId) params.set("companyId", String(p.companyId));
  if (p.invoiceId) params.set("invoiceId", String(p.invoiceId));
  return get<ListResponse<CreditMemo>>(`/api/v1/credit-memos?${params}`, signal);
};
export const createCreditMemo = (body: CreditMemoCreate) =>
  request<CreditMemo>("POST", "/api/v1/credit-memos", body);
export const applyCreditMemo = (id: number, invoiceId: number, amount: number) =>
  request<CreditMemo>("POST", `/api/v1/credit-memos/${id}/apply`, { invoiceId, amount });
export const unapplyCreditMemo = (id: number, applicationId: number) =>
  request<CreditMemo>("DELETE", `/api/v1/credit-memos/${id}/applications/${applicationId}`);
export const voidCreditMemo = (id: number, reason: string) =>
  request<CreditMemo>("POST", `/api/v1/credit-memos/${id}/void`, { reason });

// ---- Projects ----
export const listProjects = (
  p: { q?: string; state?: "active" | "closed" | "all"; companyId?: number },
  signal?: AbortSignal,
) => {
  const params = new URLSearchParams({ limit: "200", state: p.state ?? "active" });
  if (p.q) params.set("q", p.q);
  if (p.companyId) params.set("companyId", String(p.companyId));
  return get<ListResponse<Project>>(`/api/v1/projects?${params}`, signal);
};
export const getProject = (id: number, signal?: AbortSignal) =>
  get<Project>(`/api/v1/projects/${id}`, signal);
export const createProject = (body: ProjectCreate) =>
  request<Project>("POST", "/api/v1/projects", body);
export const updateProject = (id: number, body: ProjectUpdate) =>
  request<Project>("PATCH", `/api/v1/projects/${id}`, body);
export const createPhase = (projectId: number, body: PhaseCreate) =>
  request<Phase>("POST", `/api/v1/projects/${projectId}/phases`, body);
export const updatePhase = (projectId: number, phaseId: number, body: PhaseUpdate) =>
  request<Phase>("PATCH", `/api/v1/projects/${projectId}/phases/${phaseId}`, body);
export const deletePhase = (projectId: number, phaseId: number) =>
  request<void>("DELETE", `/api/v1/projects/${projectId}/phases/${phaseId}`);
export const getProjectBilling = (id: number, signal?: AbortSignal) =>
  get<ProjectBilling>(`/api/v1/projects/${id}/billing`, signal);
export interface ProjectTicketRow {
  id: number;
  summary: string;
  status: string;
  isClosed: boolean;
  phaseId: number | null;
  phase: string | null;
  owner: string | null;
  billingMethod: string;
  hours: string;
}
export const listProjectTickets = (id: number, signal?: AbortSignal) =>
  get<{ items: ProjectTicketRow[] }>(`/api/v1/projects/${id}/tickets`, signal);

// ---- Sales ----
export const listSalesStages = () => get<{ items: SalesStage[] }>("/api/v1/sales/stages");
export const getPipeline = (signal?: AbortSignal) =>
  get<{
    items: Array<{
      stageId: number;
      stage: string;
      count: number;
      amount: string;
      weightedAmount: string;
    }>;
  }>("/api/v1/sales/pipeline", signal);
export const listOpportunities = (
  p: { q?: string; state?: "open" | "won" | "lost" | "all"; stageId?: number; companyId?: number },
  signal?: AbortSignal,
) => {
  const params = new URLSearchParams({ limit: "200", state: p.state ?? "open" });
  if (p.q) params.set("q", p.q);
  if (p.stageId) params.set("stageId", String(p.stageId));
  if (p.companyId) params.set("companyId", String(p.companyId));
  return get<ListResponse<Opportunity>>(`/api/v1/sales/opportunities?${params}`, signal);
};
export const getOpportunity = (id: number, signal?: AbortSignal) =>
  get<Opportunity>(`/api/v1/sales/opportunities/${id}`, signal);
export const createOpportunity = (body: OpportunityCreate) =>
  request<Opportunity>("POST", "/api/v1/sales/opportunities", body);
export const updateOpportunity = (id: number, body: OpportunityUpdate) =>
  request<Opportunity>("PATCH", `/api/v1/sales/opportunities/${id}`, body);
export const listActivities = (id: number, signal?: AbortSignal) =>
  get<{ items: Activity[] }>(`/api/v1/sales/opportunities/${id}/activities`, signal);
export const createActivity = (id: number, body: ActivityCreate) =>
  request<Activity>("POST", `/api/v1/sales/opportunities/${id}/activities`, body);
export const updateActivity = (
  id: number,
  activityId: number,
  body: { completed?: boolean; subject?: string },
) => request<Activity>("PATCH", `/api/v1/sales/opportunities/${id}/activities/${activityId}`, body);
export const deleteActivity = (id: number, activityId: number) =>
  request<void>("DELETE", `/api/v1/sales/opportunities/${id}/activities/${activityId}`);
export const listExternalRefs = (
  entityType: ExternalEntityType,
  entityId: number,
  signal?: AbortSignal,
) =>
  get<{ items: ExternalRef[] }>(
    `/api/v1/sales/external-refs?entityType=${entityType}&entityId=${entityId}`,
    signal,
  );
export const createExternalRef = (
  entityType: ExternalEntityType,
  entityId: number,
  body: ExternalRefCreate,
) =>
  request<ExternalRef>(
    "POST",
    `/api/v1/sales/external-refs?entityType=${entityType}&entityId=${entityId}`,
    body,
  );
export const deleteExternalRef = (id: number) =>
  request<void>("DELETE", `/api/v1/sales/external-refs/${id}`);

// ---- Sales orders and billing milestones ----
export const listOrders = (
  p: { opportunityId?: number; status?: string },
  signal?: AbortSignal,
) => {
  const params = new URLSearchParams({ status: p.status ?? "all" });
  if (p.opportunityId) params.set("opportunityId", String(p.opportunityId));
  return get<{ items: SalesOrder[] }>(`/api/v1/sales/orders?${params}`, signal);
};
export const getOrder = (id: number, signal?: AbortSignal) =>
  get<SalesOrder>(`/api/v1/sales/orders/${id}`, signal);
export const createOrder = (body: SalesOrderCreate) =>
  request<SalesOrder>("POST", "/api/v1/sales/orders", body);
export const updateOrder = (id: number, body: SalesOrderUpdate) =>
  request<SalesOrder>("PATCH", `/api/v1/sales/orders/${id}`, body);
export const convertOrder = (id: number, body: OrderConvert) =>
  request<{ order: SalesOrder; projectId: number }>(
    "POST",
    `/api/v1/sales/orders/${id}/convert`,
    body,
  );
export const listOrderLines = (id: number, signal?: AbortSignal) =>
  get<{ items: SalesOrderLine[] }>(`/api/v1/sales/orders/${id}/lines`, signal);
export const addOrderLine = (id: number, body: OrderLineInput) =>
  request<SalesOrderLine>("POST", `/api/v1/sales/orders/${id}/lines`, body);
export const deleteOrderLine = (id: number, lineId: number) =>
  request<void>("DELETE", `/api/v1/sales/orders/${id}/lines/${lineId}`);
export type MilestoneOwner = { orderId: number } | { projectId: number };
export const listMilestonesFor = (owner: MilestoneOwner, signal?: AbortSignal) =>
  get<{ items: BillingMilestone[] }>(
    "orderId" in owner
      ? `/api/v1/sales/orders/${owner.orderId}/milestones`
      : `/api/v1/projects/${owner.projectId}/milestones`,
    signal,
  );
export const addMilestone = (owner: MilestoneOwner, body: MilestoneInput) =>
  request<BillingMilestone>(
    "POST",
    "orderId" in owner
      ? `/api/v1/sales/orders/${owner.orderId}/milestones`
      : `/api/v1/projects/${owner.projectId}/milestones`,
    body,
  );
export const deleteMilestone = (id: number) =>
  request<void>("DELETE", `/api/v1/sales/milestones/${id}`);

// ---- Dispatch ----
export const getDispatchBoard = (from: string, to: string, signal?: AbortSignal) =>
  get<DispatchBoard>(
    `/api/v1/dispatch/board?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    signal,
  );
export type ScheduleResult = { entry: ScheduleEntry; conflicts: ScheduleEntry[] };
export const createScheduleEntry = (body: ScheduleEntryCreate) =>
  request<ScheduleResult>("POST", "/api/v1/dispatch/entries", body);
export const updateScheduleEntry = (id: number, body: ScheduleEntryUpdate) =>
  request<ScheduleResult>("PATCH", `/api/v1/dispatch/entries/${id}`, body);
export const deleteScheduleEntry = (id: number) =>
  request<void>("DELETE", `/api/v1/dispatch/entries/${id}`);

// ---- Reports ----
export const getRmrReport = (
  p: { asOf?: string; groupBy: RmrGrouping; floorPct: number },
  signal?: AbortSignal,
) => {
  const params = new URLSearchParams({ groupBy: p.groupBy, floorPct: String(p.floorPct) });
  if (p.asOf) params.set("asOf", p.asOf);
  return get<RmrReport>(`/api/v1/reports/rmr?${params}`, signal);
};
export const getAgreementServiceReport = (
  p: { months: number; asOf?: string },
  signal?: AbortSignal,
) => {
  const params = new URLSearchParams({ months: String(p.months) });
  if (p.asOf) params.set("asOf", p.asOf);
  return get<AgreementServiceReport>(`/api/v1/reports/agreement-service?${params}`, signal);
};
export const getProjectMarginReport = (status: "active" | "closed" | "all", signal?: AbortSignal) =>
  get<ProjectMarginReport>(`/api/v1/reports/projects?status=${status}`, signal);
