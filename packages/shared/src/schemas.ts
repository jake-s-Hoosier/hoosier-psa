import { z } from "zod";

/** Request/response contracts shared by the API and the web app. */

export const idSchema = z.coerce.number().int().positive();

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const companySchema = z.object({
  id: z.number().int(),
  identifier: z.string(),
  name: z.string(),
  status: z.string(),
  territory: z.string().nullable(),
  phone: z.string().nullable(),
  website: z.string().nullable(),
  isLead: z.boolean(),
  isVendor: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Company = z.infer<typeof companySchema>;

export const companyListQuerySchema = paginationSchema.extend({
  q: z.string().trim().min(1).max(100).optional(),
  statusId: idSchema.optional(),
});
export type CompanyListQuery = z.infer<typeof companyListQuerySchema>;

export const companyCreateSchema = z.object({
  identifier: z
    .string()
    .trim()
    .min(1)
    .max(50)
    .regex(/^[A-Za-z0-9 ._&'-]+$/, "Letters, numbers and . _ & ' - only"),
  name: z.string().trim().min(1).max(255),
  statusId: idSchema,
  territoryId: idSchema.optional(),
  phone: z.string().trim().max(50).optional(),
  website: z.string().trim().max(255).optional(),
  isLead: z.boolean().default(false),
  isVendor: z.boolean().default(false),
});
export type CompanyCreate = z.infer<typeof companyCreateSchema>;

// ---------------------------------------------------------------------------------------------
// CRM: company edits, sites, contacts, notes
// ---------------------------------------------------------------------------------------------

const optText = (max: number) => z.string().trim().max(max).nullable().optional();

export const companyUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    statusId: idSchema,
    territoryId: idSchema.nullable(),
    phone: z.string().trim().max(50).nullable(),
    website: z.string().trim().max(255).nullable(),
    isLead: z.boolean(),
    isVendor: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field to change");
export type CompanyUpdate = z.infer<typeof companyUpdateSchema>;

export const siteInputSchema = z.object({
  name: z.string().trim().min(1).max(255),
  addressLine1: optText(255),
  addressLine2: optText(255),
  city: optText(100),
  state: optText(50),
  postalCode: optText(20),
  phone: optText(50),
  accessNotes: optText(2000),
  isDefaultService: z.boolean().optional(),
  isBilling: z.boolean().optional(),
});
export type SiteInput = z.infer<typeof siteInputSchema>;
export const siteUpdateSchema = siteInputSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field to change");

export const siteSchema = z.object({
  id: z.number().int(),
  companyId: z.number().int(),
  name: z.string(),
  addressLine1: z.string().nullable(),
  addressLine2: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  postalCode: z.string().nullable(),
  phone: z.string().nullable(),
  accessNotes: z.string().nullable(),
  isDefaultService: z.boolean(),
  isBilling: z.boolean(),
});
export type Site = z.infer<typeof siteSchema>;

export const contactChannelKinds = [
  "email",
  "direct",
  "mobile",
  "office",
  "home",
  "fax",
  "other",
] as const;
export const contactChannelInputSchema = z.object({
  kind: z.enum(contactChannelKinds),
  value: z.string().trim().min(1).max(255),
  extension: z.string().trim().max(20).nullable().optional(),
});
export type ContactChannelInput = z.infer<typeof contactChannelInputSchema>;

export const contactInputSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: optText(100),
  title: optText(100),
  department: optText(100),
  siteId: idSchema.nullable().optional(),
  notes: optText(2000),
  isInactive: z.boolean().optional(),
  /** When given, replaces the contact's phone numbers and email addresses. */
  channels: z.array(contactChannelInputSchema).max(20).optional(),
});
export type ContactInput = z.infer<typeof contactInputSchema>;
export const contactUpdateSchema = contactInputSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field to change");

export const contactSchema = z.object({
  id: z.number().int(),
  companyId: z.number().int(),
  siteId: z.number().int().nullable(),
  site: z.string().nullable(),
  firstName: z.string(),
  lastName: z.string().nullable(),
  title: z.string().nullable(),
  department: z.string().nullable(),
  notes: z.string().nullable(),
  isInactive: z.boolean(),
  channels: z.array(
    z.object({
      kind: z.enum(contactChannelKinds),
      value: z.string(),
      extension: z.string().nullable(),
    }),
  ),
});
export type Contact = z.infer<typeof contactSchema>;

export const companyNoteKinds = ["note", "call", "meeting", "alert"] as const;
export const companyNoteCreateSchema = z.object({
  kind: z.enum(companyNoteKinds).default("note"),
  body: z.string().trim().min(1).max(10000),
  contactId: idSchema.optional(),
});
export type CompanyNoteCreate = z.infer<typeof companyNoteCreateSchema>;

export const companyNoteSchema = z.object({
  id: z.number().int(),
  kind: z.enum(companyNoteKinds),
  body: z.string(),
  isAlert: z.boolean(),
  contactId: z.number().int().nullable(),
  contact: z.string().nullable(),
  author: z.string().nullable(),
  createdAt: z.string(),
});
export type CompanyNote = z.infer<typeof companyNoteSchema>;

/** Everything on one screen: the company, its people and places, and how busy the relationship is. */
export const companyOverviewSchema = z.object({
  company: companySchema,
  sites: z.array(siteSchema),
  contacts: z.array(contactSchema),
  alerts: z.array(companyNoteSchema),
  stats: z.object({
    openTickets: z.number().int(),
    ticketsLast90Days: z.number().int(),
    hoursLast30Days: z.number(),
    lastActivityAt: z.string().nullable(),
  }),
});
export type CompanyOverview = z.infer<typeof companyOverviewSchema>;

export const listResponse = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    total: z.number().int(),
    limit: z.number().int(),
    offset: z.number().int(),
  });

export const problemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type Problem = z.infer<typeof problemSchema>;

// ---------------------------------------------------------------------------------------------
// Service tickets
// ---------------------------------------------------------------------------------------------

export const ticketSchema = z.object({
  id: z.number().int(),
  summary: z.string(),
  companyId: z.number().int(),
  company: z.string(),
  siteId: z.number().int().nullable(),
  site: z.string().nullable(),
  contactId: z.number().int().nullable(),
  contact: z.string().nullable(),
  boardId: z.number().int(),
  board: z.string(),
  statusId: z.number().int(),
  status: z.string(),
  isClosed: z.boolean(),
  priorityId: z.number().int(),
  priority: z.string(),
  ownerMemberId: z.number().int().nullable(),
  agreementId: z.number().int().nullable(),
  agreement: z.string().nullable(),
  enteredAt: z.string(),
  closedAt: z.string().nullable(),
  updatedAt: z.string(),
});
export type Ticket = z.infer<typeof ticketSchema>;

export const ticketListQuerySchema = paginationSchema.extend({
  q: z.string().trim().min(1).max(100).optional(),
  companyId: idSchema.optional(),
  siteId: idSchema.optional(),
  contactId: idSchema.optional(),
  boardId: idSchema.optional(),
  statusId: idSchema.optional(),
  ownerMemberId: idSchema.optional(),
  /** open = not closed (default), closed, all */
  state: z.enum(["open", "closed", "all"]).default("open"),
});
export type TicketListQuery = z.infer<typeof ticketListQuerySchema>;

export const ticketCreateSchema = z.object({
  summary: z.string().trim().min(1).max(500),
  companyId: idSchema,
  siteId: idSchema.optional(),
  contactId: idSchema.optional(),
  boardId: idSchema,
  /** Defaults to the board's default status. */
  statusId: idSchema.optional(),
  /** Defaults to the board's default priority, else Normal. */
  priorityId: idSchema.optional(),
  ownerMemberId: idSchema.optional(),
  description: z.string().trim().max(20000).optional(),
});
export type TicketCreate = z.infer<typeof ticketCreateSchema>;

export const ticketUpdateSchema = z
  .object({
    summary: z.string().trim().min(1).max(500),
    /** Moves the ticket to another company; its site and contact are cleared unless given too. */
    companyId: idSchema,
    statusId: idSchema,
    priorityId: idSchema,
    ownerMemberId: idSchema.nullable(),
    siteId: idSchema.nullable(),
    contactId: idSchema.nullable(),
    /** The agreement that covers this work, or null to clear it. */
    agreementId: idSchema.nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field to change");
export type TicketUpdate = z.infer<typeof ticketUpdateSchema>;

export const ticketNoteKinds = ["discussion", "internal", "resolution"] as const;
export const ticketNoteCreateSchema = z.object({
  kind: z.enum(ticketNoteKinds).default("discussion"),
  body: z.string().trim().min(1).max(20000),
});
export type TicketNoteCreate = z.infer<typeof ticketNoteCreateSchema>;

export const ticketNoteSchema = z.object({
  id: z.number().int(),
  ticketId: z.number().int(),
  kind: z.string(),
  body: z.string(),
  authorMemberId: z.number().int().nullable(),
  createdAt: z.string(),
});
export type TicketNote = z.infer<typeof ticketNoteSchema>;

// ---------------------------------------------------------------------------------------------
// Time entries
// ---------------------------------------------------------------------------------------------

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const timeEntrySchema = z.object({
  id: z.number().int(),
  memberId: z.number().int(),
  companyId: z.number().int(),
  company: z.string(),
  ticketId: z.number().int().nullable(),
  ticketSummary: z.string().nullable(),
  /** Set when an agreement covered this labor (billed at no charge). */
  agreementId: z.number().int().nullable(),
  workRoleId: z.number().int(),
  workTypeId: z.number().int(),
  workDate: z.string(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  isTimer: z.boolean(),
  actualHours: z.number(),
  billedHours: z.number(),
  billable: z.string(),
  billRate: z.number(),
  status: z.string(),
  notes: z.string().nullable(),
});
export type TimeEntry = z.infer<typeof timeEntrySchema>;

export const timerStartSchema = z.object({
  ticketId: idSchema,
  workRoleId: idSchema,
  workTypeId: idSchema,
  notes: z.string().trim().max(5000).optional(),
});
export type TimerStart = z.infer<typeof timerStartSchema>;

export const timerStopSchema = z.object({
  notes: z.string().trim().max(5000).optional(),
});

export const timeEntryCreateSchema = z
  .object({
    /** Time on a ticket. Leave out for non-ticket time (shop, training, admin) and give companyId. */
    ticketId: idSchema.optional(),
    companyId: idSchema.optional(),
    workRoleId: idSchema,
    workTypeId: idSchema,
    workDate: isoDate,
    /** Either give hours, or startedAt and endedAt. */
    hours: z.number().positive().max(24).optional(),
    startedAt: z.string().datetime({ offset: true }).optional(),
    endedAt: z.string().datetime({ offset: true }).optional(),
    /** Defaults to the work type's billing setting. */
    billable: z.enum(["billable", "do_not_bill", "no_charge"]).optional(),
    notes: z.string().trim().max(5000).optional(),
    internalNotes: z.string().trim().max(5000).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.ticketId === undefined && v.companyId === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["ticketId"],
        message: "Choose a ticket, or a company for non-ticket time",
      });
    }
    const hasRange = v.startedAt !== undefined || v.endedAt !== undefined;
    if (v.hours === undefined && !hasRange) {
      ctx.addIssue({
        code: "custom",
        path: ["hours"],
        message: "Give hours, or startedAt and endedAt",
      });
    }
    if (v.hours !== undefined && hasRange) {
      ctx.addIssue({
        code: "custom",
        path: ["hours"],
        message: "Give hours or a time range, not both",
      });
    }
    if (hasRange) {
      if (!v.startedAt || !v.endedAt) {
        ctx.addIssue({
          code: "custom",
          path: ["endedAt"],
          message: "startedAt and endedAt go together",
        });
      } else if (Date.parse(v.endedAt) <= Date.parse(v.startedAt)) {
        ctx.addIssue({
          code: "custom",
          path: ["endedAt"],
          message: "endedAt must be after startedAt",
        });
      }
    }
  });
export type TimeEntryCreate = z.infer<typeof timeEntryCreateSchema>;

/** Changes to an open entry; submitted time must be recalled first. */
export const timeEntryUpdateSchema = z
  .object({
    workDate: isoDate,
    hours: z.number().positive().max(24),
    workRoleId: idSchema,
    workTypeId: idSchema,
    billable: z.enum(["billable", "do_not_bill", "no_charge"]),
    notes: z.string().trim().max(5000).nullable(),
    internalNotes: z.string().trim().max(5000).nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field to change");
export type TimeEntryUpdate = z.infer<typeof timeEntryUpdateSchema>;

export const timeEntryListQuerySchema = paginationSchema.extend({
  memberId: idSchema.optional(),
  ticketId: idSchema.optional(),
  companyId: idSchema.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type TimeEntryListQuery = z.infer<typeof timeEntryListQuerySchema>;

// ---------------------------------------------------------------------------------------------
// Timesheets and pay periods
// ---------------------------------------------------------------------------------------------

export const dateRangeSchema = z
  .object({ from: isoDate, to: isoDate })
  .refine((v) => v.to >= v.from, { path: ["to"], message: "to must not precede from" });
export type DateRangeInput = z.infer<typeof dateRangeSchema>;

export const timesheetApproveSchema = z
  .object({ memberId: idSchema, from: isoDate, to: isoDate })
  .refine((v) => v.to >= v.from, { path: ["to"], message: "to must not precede from" });

export const payPeriodGenerateSchema = z.object({
  year: z.number().int().min(2000).max(2100),
  month: z.number().int().min(1).max(12),
});

export const payPeriodSchema = z.object({
  id: z.number().int(),
  startDate: z.string(),
  endDate: z.string(),
  payDate: z.string().nullable(),
  status: z.enum(["open", "locked", "exported"]),
  lockedAt: z.string().nullable(),
  exportedAt: z.string().nullable(),
});
export type PayPeriod = z.infer<typeof payPeriodSchema>;

// ---------------------------------------------------------------------------------------------
// Agreements (docs/05)
// ---------------------------------------------------------------------------------------------

const billCycleEnum = z.enum(["monthly", "quarterly", "semi_annual", "annual"]);
const coverageEnum = z.enum(["none", "block_hours", "unlimited_remote", "covered"]);
const money4 = z.number().min(0).max(9_999_999);

export const agreementTypeSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  billCycle: billCycleEnum,
  coverage: coverageEnum,
  autoRenew: z.boolean(),
  isActive: z.boolean(),
});
export type AgreementType = z.infer<typeof agreementTypeSchema>;

export const agreementTypeInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    billCycle: billCycleEnum,
    coverage: coverageEnum,
    autoRenew: z.boolean(),
    isActive: z.boolean(),
  })
  .partial();

export const agreementAdditionSchema = z.object({
  id: z.number().int(),
  agreementId: z.number().int(),
  productId: z.number().int().nullable(),
  description: z.string(),
  quantity: z.number(),
  unitPrice: z.number(),
  unitCost: z.number(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
  prorate: z.boolean(),
  vendorCompanyId: z.number().int().nullable(),
  vendor: z.string().nullable(),
});
export type AgreementAddition = z.infer<typeof agreementAdditionSchema>;

export const agreementSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  companyId: z.number().int(),
  company: z.string(),
  billToCompanyId: z.number().int(),
  billToCompany: z.string(),
  typeId: z.number().int(),
  type: z.string(),
  status: z.enum(["pending", "active", "expired", "cancelled"]),
  startDate: z.string(),
  endDate: z.string().nullable(),
  autoRenew: z.boolean(),
  renewalNoticeDays: z.number().int(),
  cancelledDate: z.string().nullable(),
  cancelReason: z.string().nullable(),
  billCycle: billCycleEnum,
  billStartDate: z.string(),
  coverage: coverageEnum,
  blockHours: z.number().nullable(),
  poNumber: z.string().nullable(),
  notes: z.string().nullable(),
  /** Monthly recurring revenue and cost of the lines in effect today. */
  rmr: z.string(),
  monthlyCost: z.string(),
});
export type Agreement = z.infer<typeof agreementSchema>;

export interface AgreementDetail extends Agreement {
  additions: AgreementAddition[];
  /** Labor and cost logged on tickets covered by this agreement: its real service expense. */
  serviceHours: number;
  serviceCost: number;
  ticketCount: number;
  /** Hours of labor this agreement has covered (billed at no charge). */
  coveredHours: number;
}

export const agreementListQuerySchema = paginationSchema.extend({
  q: z.string().trim().min(1).max(100).optional(),
  companyId: idSchema.optional(),
  typeId: idSchema.optional(),
  status: z.enum(["active", "pending", "expired", "cancelled", "all"]).default("active"),
});

export const agreementCreateSchema = z
  .object({
    companyId: idSchema,
    billToCompanyId: idSchema.optional(),
    typeId: idSchema,
    name: z.string().trim().min(1).max(200),
    startDate: isoDate,
    endDate: isoDate.nullable().optional(),
    autoRenew: z.boolean().optional(),
    renewalNoticeDays: z.number().int().min(0).max(730).optional(),
    billCycle: billCycleEnum.optional(),
    billStartDate: isoDate.optional(),
    coverage: coverageEnum.optional(),
    blockHours: z.number().min(0).max(100000).nullable().optional(),
    poNumber: z.string().trim().max(100).nullable().optional(),
    notes: z.string().trim().max(5000).nullable().optional(),
  })
  .refine((v) => v.endDate == null || v.endDate >= v.startDate, {
    path: ["endDate"],
    message: "The end date cannot be before the start date",
  });
export type AgreementCreate = z.infer<typeof agreementCreateSchema>;

export const agreementUpdateSchema = z
  .object({
    billToCompanyId: idSchema,
    typeId: idSchema,
    name: z.string().trim().min(1).max(200),
    startDate: isoDate,
    endDate: isoDate.nullable(),
    autoRenew: z.boolean(),
    renewalNoticeDays: z.number().int().min(0).max(730),
    billCycle: billCycleEnum,
    billStartDate: isoDate,
    coverage: coverageEnum,
    blockHours: z.number().min(0).max(100000).nullable(),
    poNumber: z.string().trim().max(100).nullable(),
    notes: z.string().trim().max(5000).nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field to change");
export type AgreementUpdate = z.infer<typeof agreementUpdateSchema>;

export const agreementCancelSchema = z.object({
  date: isoDate,
  reason: z.string().trim().min(1).max(500),
});

export const additionCreateSchema = z
  .object({
    productId: idSchema.optional(),
    description: z.string().trim().min(1).max(500),
    quantity: z.number().positive().max(1_000_000),
    unitPrice: money4,
    unitCost: money4.default(0),
    effectiveFrom: isoDate,
    effectiveTo: isoDate.nullable().optional(),
    prorate: z.boolean().default(true),
    vendorCompanyId: idSchema.optional(),
  })
  .refine((v) => v.effectiveTo == null || v.effectiveTo >= v.effectiveFrom, {
    path: ["effectiveTo"],
    message: "The end date cannot be before the start date",
  });
export type AdditionCreate = z.infer<typeof additionCreateSchema>;

/** A change to price or quantity: closes the current line the day before and opens a new one. */
export const additionChangeSchema = z
  .object({
    effectiveFrom: isoDate,
    quantity: z.number().positive().max(1_000_000).optional(),
    unitPrice: money4.optional(),
    unitCost: money4.optional(),
  })
  .refine(
    (v) => v.quantity !== undefined || v.unitPrice !== undefined || v.unitCost !== undefined,
    {
      message: "Change at least one of quantity, unit price or unit cost",
    },
  );

export const additionEndSchema = z.object({ date: isoDate });

export const additionEditSchema = z
  .object({
    description: z.string().trim().min(1).max(500),
    prorate: z.boolean(),
    vendorCompanyId: idSchema.nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field to change");

// ---- Billing runs and invoices (docs/05) ----

export const invoiceStatusEnum = z.enum(["draft", "posted", "partially_paid", "paid", "void"]);
export type InvoiceStatus = z.infer<typeof invoiceStatusEnum>;

export interface InvoiceLine {
  id: number;
  lineNo: number;
  kind: "agreement" | "time" | "product" | "expense" | "fee" | "adjustment";
  agreementId: number | null;
  agreement: string | null;
  description: string;
  periodStart: string | null;
  periodEnd: string | null;
  quantity: string;
  unitPrice: string;
  amount: string;
  costAmount: string;
  taxable: boolean;
}

export interface Invoice {
  id: number;
  runId: number | null;
  companyId: number;
  company: string;
  invoiceNumber: number | null;
  status: InvoiceStatus;
  invoiceDate: string;
  dueDate: string;
  terms: string | null;
  poNumber: string | null;
  notes: string | null;
  taxCode: string | null;
  taxRatePct: string;
  taxExempt: boolean;
  subtotal: string;
  taxTotal: string;
  total: string;
  amountPaid: string;
  postedAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  lineCount: number;
  /** Things a reviewer should look at before posting a draft (no tax code, no terms ...). */
  warnings: string[];
  lines?: InvoiceLine[];
}

export interface BillingRun {
  id: number;
  kind: "agreement";
  periodMonth: string;
  invoiceDate: string;
  status: "draft" | "posted" | "discarded";
  notes: string | null;
  createdAt: string;
  postedAt: string | null;
  invoiceCount: number;
  total: string;
  invoices?: Invoice[];
}

export interface SkippedAgreement {
  agreementId: number;
  agreement: string;
  company: string;
  reason: string;
}

export interface BillingRunPreview {
  periodMonth: string;
  invoiceDate: string;
  invoices: Invoice[];
  skipped: SkippedAgreement[];
  total: string;
}

const billingMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM");

export const billingRunCreateSchema = z.object({
  /** Bills every agreement whose cycle starts in this month, in advance. */
  month: billingMonth,
  invoiceDate: isoDate.optional(),
  notes: z.string().trim().max(2000).optional(),
  /** Work out the invoices without saving anything. */
  preview: z.boolean().optional(),
});
export type BillingRunCreate = z.infer<typeof billingRunCreateSchema>;

export const invoiceListQuerySchema = paginationSchema.extend({
  q: z.string().trim().min(1).max(100).optional(),
  companyId: idSchema.optional(),
  runId: idSchema.optional(),
  status: z
    .enum(["draft", "posted", "partially_paid", "paid", "void", "open", "all"])
    .default("all"),
});

export const invoiceUpdateSchema = z
  .object({
    invoiceDate: isoDate,
    dueDate: isoDate,
    poNumber: z.string().trim().max(100).nullable(),
    notes: z.string().trim().max(5000).nullable(),
  })
  .partial();
export type InvoiceUpdate = z.infer<typeof invoiceUpdateSchema>;

export const invoiceLineUpdateSchema = z
  .object({
    description: z.string().trim().min(1).max(500),
    quantity: z.number().positive().max(1_000_000),
    unitPrice: z.number().min(0).max(100_000_000),
    taxable: z.boolean(),
  })
  .partial();
export type InvoiceLineUpdate = z.infer<typeof invoiceLineUpdateSchema>;

export const invoiceVoidSchema = z.object({ reason: z.string().trim().min(3).max(500) });
