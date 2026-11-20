/**
 * Permission keys are the single source of truth for authorization. They are synchronised into
 * iam.permission at deploy time. Format: <module>.<resource>.<action>.
 * Granting is done through roles in the database; code only ever checks keys.
 */
export const PERMISSIONS = {
  "crm.company.read": "View companies, sites and contacts",
  "crm.company.write": "Create and edit companies, sites and contacts",
  "service.ticket.read": "View service tickets",
  "service.ticket.write": "Create and edit service tickets",
  "service.ticket.delete": "Delete service tickets",
  "service.mailbox.manage": "Set up inbound email mailboxes and review incoming mail",
  "timekeeping.time.read_own": "View own time entries",
  "timekeeping.time.write_own": "Enter and edit own time entries",
  "timekeeping.time.read_all": "View everyone's time entries",
  "timekeeping.time.write_all": "Edit anyone's time entries",
  "timekeeping.time.approve": "Approve time entries",
  "timekeeping.period.lock": "Lock and export pay periods",
  "billing.agreement.read": "View agreements and their recurring lines",
  "billing.agreement.write": "Create and change agreements and their recurring lines",
  "billing.invoice.read": "View billing runs and invoices",
  "billing.invoice.write": "Run billing, and edit or discard draft invoices",
  "billing.invoice.post": "Post draft invoices (assigns numbers) and void posted ones",
  "catalog.manage": "Maintain products, rate cards, tax codes and terms",
  "iam.manage": "Manage members, roles and permissions",
  "system.audit.read": "Read the audit log",
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;

export function isPermissionKey(value: string): value is PermissionKey {
  return Object.hasOwn(PERMISSIONS, value);
}

/** Default grants applied when a fresh database is seeded. Admins get everything. */
export const DEFAULT_ROLE_GRANTS: Record<string, readonly PermissionKey[]> = {
  Administrator: Object.keys(PERMISSIONS) as PermissionKey[],
  Manager: [
    "crm.company.read",
    "crm.company.write",
    "service.ticket.read",
    "service.ticket.write",
    "timekeeping.time.read_own",
    "timekeeping.time.write_own",
    "timekeeping.time.read_all",
    "timekeeping.time.write_all",
    "timekeeping.time.approve",
    "timekeeping.period.lock",
    "catalog.manage",
    "billing.agreement.read",
    "billing.agreement.write",
    "billing.invoice.read",
    "billing.invoice.write",
    "service.mailbox.manage",
    "system.audit.read",
  ],
  Dispatcher: [
    "crm.company.read",
    "service.ticket.read",
    "service.ticket.write",
    "timekeeping.time.read_own",
    "timekeeping.time.write_own",
  ],
  Technician: [
    "crm.company.read",
    "service.ticket.read",
    "service.ticket.write",
    "timekeeping.time.read_own",
    "timekeeping.time.write_own",
  ],
  Sales: ["crm.company.read", "crm.company.write", "service.ticket.read", "billing.agreement.read"],
  Billing: [
    "crm.company.read",
    "service.ticket.read",
    "timekeeping.time.read_all",
    "timekeeping.time.approve",
    "catalog.manage",
    "billing.agreement.read",
    "billing.agreement.write",
    "billing.invoice.read",
    "billing.invoice.write",
    "billing.invoice.post",
  ],
};
