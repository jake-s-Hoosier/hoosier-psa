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
  /** How time on the ticket is billed; the amount is the fee, cap or override rate the method needs. */
  billingMethod: z.enum(["actual_rates", "fixed_fee", "not_to_exceed", "override_rate"]),
  billingAmount: z.string().nullable(),
  /** The project (and phase) this ticket is work for; project work is billed by the project, not by ticket runs. */
  projectId: z.number().int().nullable(),
  project: z.string().nullable(),
  phaseId: z.number().int().nullable(),
  phase: z.string().nullable(),
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
  /** Makes this a project ticket. The ticket's customer must be the project's customer. */
  projectId: idSchema.optional(),
  phaseId: idSchema.optional(),
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
    billingMethod: z.enum(["actual_rates", "fixed_fee", "not_to_exceed", "override_rate"]),
    /** The fixed fee, not-to-exceed cap or override hourly rate; null clears it. */
    billingAmount: z.number().min(0).max(100_000_000).nullable(),
    /** Moves the ticket into or out of a project (null). Clears the phase unless one is given. */
    projectId: idSchema.nullable(),
    phaseId: idSchema.nullable(),
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

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

// ---- Ticket charges: materials and expenses billed with a ticket (docs/05) ----

export const chargeKinds = ["product", "expense"] as const;
export const chargeBillable = ["billable", "no_charge", "do_not_bill"] as const;

export interface TicketCharge {
  id: number;
  ticketId: number;
  kind: (typeof chargeKinds)[number];
  productId: number | null;
  product: string | null;
  description: string;
  quantity: string;
  unitPrice: string;
  unitCost: string;
  /** quantity x unit price, rounded to cents */
  amount: string;
  taxable: boolean;
  billable: (typeof chargeBillable)[number];
  incurredOn: string;
  /** Set while the charge is on a draft or posted invoice; it cannot change then. */
  invoiceId: number | null;
  invoiceNumber: number | null;
  addedByMemberId: number | null;
}

export const ticketChargeCreateSchema = z.object({
  kind: z.enum(chargeKinds).default("product"),
  /** The catalog item. Fills description, price, cost and taxable when those are not given. */
  productId: idSchema.optional(),
  description: z.string().trim().min(1).max(500).optional(),
  quantity: z.number().positive().max(1_000_000).default(1),
  unitPrice: z.number().min(0).max(100_000_000).optional(),
  unitCost: z.number().min(0).max(100_000_000).optional(),
  taxable: z.boolean().optional(),
  billable: z.enum(chargeBillable).default("billable"),
  incurredOn: isoDate.optional(),
});
export type TicketChargeCreate = z.infer<typeof ticketChargeCreateSchema>;

export const ticketChargeUpdateSchema = z
  .object({
    description: z.string().trim().min(1).max(500),
    quantity: z.number().positive().max(1_000_000),
    unitPrice: z.number().min(0).max(100_000_000),
    unitCost: z.number().min(0).max(100_000_000),
    taxable: z.boolean(),
    billable: z.enum(chargeBillable),
    incurredOn: isoDate,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field to change");
export type TicketChargeUpdate = z.infer<typeof ticketChargeUpdateSchema>;

export interface ProductChoice {
  id: number;
  identifier: string;
  description: string;
  unitPrice: string;
  unitCost: string;
  taxable: boolean;
}

// ---------------------------------------------------------------------------------------------
// Time entries
// ---------------------------------------------------------------------------------------------

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
  ticketId: number | null;
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

export const projectBillingModes = ["time_materials", "deposit", "progress", "final"] as const;
export type ProjectBillingMode = (typeof projectBillingModes)[number];

export interface BillingRun {
  id: number;
  kind: "agreement" | "ticket" | "project";
  /** Project runs bill one scope: the project, or one phase that is billed separately. */
  projectId: number | null;
  project: string | null;
  phaseId: number | null;
  projectMode: ProjectBillingMode | null;
  /** For a ticket run, the month of throughDate. */
  periodMonth: string;
  /** Ticket runs bill time worked up to and including this date. */
  throughDate: string | null;
  invoiceDate: string;
  status: "draft" | "posted" | "discarded";
  notes: string | null;
  createdAt: string;
  postedAt: string | null;
  invoiceCount: number;
  total: string;
  invoices?: Invoice[];
}

export interface SkippedItem {
  kind: "agreement" | "ticket" | "project";
  id: number;
  /** Agreement name, or "#12 Door stuck" for a ticket. */
  label: string;
  company: string;
  reason: string;
}

export interface BillingRunPreview {
  kind: "agreement" | "ticket" | "project";
  periodMonth: string;
  throughDate: string | null;
  invoiceDate: string;
  invoices: Invoice[];
  skipped: SkippedItem[];
  total: string;
}

const billingMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM");

export const billingRunCreateSchema = z
  .object({
    /** Agreement runs bill every agreement whose cycle starts in this month, in advance. */
    kind: z.enum(["agreement", "ticket", "project"]).default("agreement"),
    month: billingMonth.optional(),
    /** Project runs: the project, and a separately billed phase to bill on its own. */
    projectId: idSchema.optional(),
    phaseId: idSchema.optional(),
    mode: z.enum(projectBillingModes).optional(),
    /** Deposit and progress runs: a dollar amount, or a percentage of the fixed fee. */
    amount: z.number().positive().max(100_000_000).optional(),
    percent: z.number().positive().max(100).optional(),
    /** Deposit and progress runs: the line's wording (a milestone name, say). */
    description: z.string().trim().min(1).max(300).optional(),
    /** Ticket runs bill approved time worked up to and including this date. */
    throughDate: isoDate.optional(),
    invoiceDate: isoDate.optional(),
    notes: z.string().trim().max(2000).optional(),
    /** Work out the invoices without saving anything. */
    preview: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "agreement" && !v.month)
      ctx.addIssue({ code: "custom", path: ["month"], message: "Choose the month to bill" });
    if (v.kind === "ticket" && !v.throughDate)
      ctx.addIssue({
        code: "custom",
        path: ["throughDate"],
        message: "Choose the last day to bill",
      });
    if (v.kind === "project") {
      if (!v.projectId)
        ctx.addIssue({ code: "custom", path: ["projectId"], message: "Choose the project" });
      if (!v.mode) ctx.addIssue({ code: "custom", path: ["mode"], message: "Choose what to bill" });
      if (v.mode === "time_materials" && !v.throughDate)
        ctx.addIssue({
          code: "custom",
          path: ["throughDate"],
          message: "Choose the last day to bill",
        });
      if ((v.mode === "deposit" || v.mode === "progress") && !v.amount && !v.percent)
        ctx.addIssue({
          code: "custom",
          path: ["amount"],
          message: "Enter an amount or a percentage of the fixed fee",
        });
      if (v.amount && v.percent)
        ctx.addIssue({
          code: "custom",
          path: ["percent"],
          message: "Enter an amount or a percentage, not both",
        });
    }
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

// ---- Payments received (docs/10) ----

export const paymentMethods = ["check", "ach", "card", "cash", "wire", "other"] as const;

export interface PaymentApplication {
  id: number;
  invoiceId: number;
  invoiceNumber: number | null;
  amount: string;
}

export interface Payment {
  id: number;
  companyId: number;
  company: string;
  receivedOn: string;
  method: (typeof paymentMethods)[number];
  reference: string | null;
  amount: string;
  feeAmount: string;
  status: "posted" | "void";
  notes: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  /** Amount spread across invoices; the rest is credit on account. */
  appliedAmount: string;
  unappliedAmount: string;
  applications: PaymentApplication[];
}

export const paymentCreateSchema = z
  .object({
    companyId: idSchema,
    receivedOn: isoDate,
    method: z.enum(paymentMethods),
    reference: z.string().trim().min(1).max(100).optional(),
    amount: z.number().positive().max(100_000_000),
    feeAmount: z.number().min(0).max(100_000_000).optional(),
    notes: z.string().trim().min(1).max(2000).optional(),
    /** Invoices to pay now; anything left over stays as credit on account. */
    applications: z
      .array(z.object({ invoiceId: idSchema, amount: z.number().positive().max(100_000_000) }))
      .max(50)
      .default([]),
  })
  .refine((v) => (v.feeAmount ?? 0) < v.amount, "The fee must be less than the amount");

export const paymentApplySchema = z.object({
  invoiceId: idSchema,
  amount: z.number().positive().max(100_000_000),
});

export const paymentUpdateSchema = z
  .object({
    reference: z.string().trim().min(1).max(100).nullable(),
    notes: z.string().trim().min(1).max(2000).nullable(),
    feeAmount: z.number().min(0).max(100_000_000),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field to change");

export const paymentVoidSchema = z.object({ reason: z.string().trim().min(3).max(500) });

export const paymentListQuerySchema = paginationSchema.extend({
  companyId: idSchema.optional(),
  invoiceId: idSchema.optional(),
  /** unapplied = still has credit on account */
  state: z.enum(["posted", "void", "unapplied", "all"]).default("posted"),
});

export type PaymentCreate = z.input<typeof paymentCreateSchema>;

// ---- Credit memos (docs/05) ----

export interface CreditMemoLine {
  id: number;
  lineNo: number;
  sourceLineId: number | null;
  description: string;
  quantity: string;
  unitPrice: string;
  amount: string;
  taxable: boolean;
}

export interface CreditApplication {
  id: number;
  invoiceId: number;
  invoiceNumber: number | null;
  amount: string;
}

export interface CreditMemo {
  id: number;
  companyId: number;
  company: string;
  sourceInvoiceId: number | null;
  sourceInvoiceNumber: number | null;
  memoNumber: number;
  status: "posted" | "void";
  memoDate: string;
  reason: string;
  taxCode: string | null;
  taxRatePct: string;
  taxExempt: boolean;
  subtotal: string;
  taxTotal: string;
  total: string;
  voidedAt: string | null;
  voidReason: string | null;
  /** What has been applied to invoices; zero once the memo is void. */
  appliedAmount: string;
  /** Credit still on account. */
  unappliedAmount: string;
  applications: CreditApplication[];
  lines?: CreditMemoLine[];
}

export const creditMemoLineInputSchema = z.object({
  description: z.string().trim().min(1).max(500),
  quantity: z.number().positive().max(1_000_000),
  unitPrice: z.number().min(0).max(100_000_000),
  taxable: z.boolean().default(false),
  /** The invoice line this credits, for the record. */
  sourceLineId: idSchema.optional(),
});

export const creditMemoCreateSchema = z.object({
  companyId: idSchema,
  /** The invoice being corrected; its tax is copied, and the memo cannot exceed it. */
  sourceInvoiceId: idSchema.optional(),
  memoDate: isoDate,
  reason: z.string().trim().min(3).max(500),
  lines: z.array(creditMemoLineInputSchema).min(1).max(200),
  /** Invoices to credit now; anything left over stays as credit on account. */
  applications: z
    .array(z.object({ invoiceId: idSchema, amount: z.number().positive().max(100_000_000) }))
    .max(50)
    .default([]),
});

export const creditMemoApplySchema = z.object({
  invoiceId: idSchema,
  amount: z.number().positive().max(100_000_000),
});

export const creditMemoVoidSchema = z.object({ reason: z.string().trim().min(3).max(500) });

export const creditMemoListQuerySchema = paginationSchema.extend({
  companyId: idSchema.optional(),
  invoiceId: idSchema.optional(),
  /** unapplied = still has credit on account */
  state: z.enum(["posted", "void", "unapplied", "all"]).default("posted"),
});

export type CreditMemoCreate = z.input<typeof creditMemoCreateSchema>;

// ---------------------------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------------------------

export const projectStatuses = [
  "planning",
  "open",
  "on_hold",
  "ready_to_invoice",
  "closed",
  "canceled",
] as const;
export const projectBillingMethods = [
  "actual_rates",
  "fixed_fee",
  "not_to_exceed",
  "override_rate",
] as const;
export type ProjectStatus = (typeof projectStatuses)[number];
export type ProjectBillingMethod = (typeof projectBillingMethods)[number];

export interface Phase {
  id: number;
  projectId: number;
  name: string;
  description: string | null;
  sortOrder: number;
  budgetHours: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  billSeparately: boolean;
  billingMethod: ProjectBillingMethod | null;
  billingAmount: string | null;
  notes: string | null;
  ticketCount: number;
  hoursLogged: string;
}

export interface Project {
  id: number;
  companyId: number;
  company: string;
  siteId: number | null;
  site: string | null;
  name: string;
  projectType: string | null;
  status: ProjectStatus;
  managerMemberId: number | null;
  billingMethod: ProjectBillingMethod;
  billingAmount: string | null;
  poNumber: string | null;
  poAmount: string | null;
  estimatedStart: string | null;
  estimatedEnd: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  budgetHours: string | null;
  notes: string | null;
  closedAt: string | null;
  ticketCount: number;
  openTicketCount: number;
  hoursLogged: string;
  /** Present on the detail view. */
  phases?: Phase[];
}

const optMoney = z.number().min(0).max(100_000_000);
const optHours = z.number().min(0).max(1_000_000);

const projectBillingRefine = (
  v: { billingMethod?: string; billingAmount?: number | null },
  ctx: z.RefinementCtx,
) => {
  if (v.billingMethod && v.billingMethod !== "actual_rates" && !(Number(v.billingAmount) > 0))
    ctx.addIssue({
      code: "custom",
      path: ["billingAmount"],
      message: "Enter the fee, cap or rate for this billing method",
    });
};

export const projectCreateSchema = z
  .object({
    companyId: idSchema,
    siteId: idSchema.optional(),
    name: z.string().trim().min(1).max(300),
    projectType: z.string().trim().max(100).optional(),
    status: z.enum(projectStatuses).default("open"),
    managerMemberId: idSchema.optional(),
    billingMethod: z.enum(projectBillingMethods).default("fixed_fee"),
    billingAmount: optMoney.nullable().optional(),
    poNumber: z.string().trim().max(100).optional(),
    poAmount: optMoney.optional(),
    estimatedStart: isoDate.optional(),
    estimatedEnd: isoDate.optional(),
    budgetHours: optHours.optional(),
    notes: z.string().trim().max(10000).optional(),
  })
  .superRefine(projectBillingRefine);
export type ProjectCreate = z.input<typeof projectCreateSchema>;

export const projectUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(300),
    siteId: idSchema.nullable(),
    projectType: z.string().trim().max(100).nullable(),
    status: z.enum(projectStatuses),
    managerMemberId: idSchema.nullable(),
    billingMethod: z.enum(projectBillingMethods),
    billingAmount: optMoney.nullable(),
    poNumber: z.string().trim().max(100).nullable(),
    poAmount: optMoney.nullable(),
    estimatedStart: isoDate.nullable(),
    estimatedEnd: isoDate.nullable(),
    actualStart: isoDate.nullable(),
    actualEnd: isoDate.nullable(),
    budgetHours: optHours.nullable(),
    notes: z.string().trim().max(10000).nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field to change");
export type ProjectUpdate = z.infer<typeof projectUpdateSchema>;

export const projectListQuerySchema = paginationSchema.extend({
  q: z.string().trim().min(1).max(100).optional(),
  companyId: idSchema.optional(),
  managerMemberId: idSchema.optional(),
  /** active = planning/open/on hold/ready to invoice (default) */
  state: z.enum(["active", "closed", "all"]).default("active"),
});

export const phaseCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(300),
    description: z.string().trim().max(5000).optional(),
    sortOrder: z.number().int().min(0).max(10000).optional(),
    budgetHours: optHours.optional(),
    scheduledStart: isoDate.optional(),
    scheduledEnd: isoDate.optional(),
    billSeparately: z.boolean().default(false),
    billingMethod: z.enum(projectBillingMethods).optional(),
    billingAmount: optMoney.nullable().optional(),
    notes: z.string().trim().max(5000).optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.billSeparately && (v.billingMethod || v.billingAmount))
      ctx.addIssue({
        code: "custom",
        path: ["billingMethod"],
        message: "A phase has its own billing only when it is billed separately",
      });
    projectBillingRefine(v, ctx);
  });
export type PhaseCreate = z.input<typeof phaseCreateSchema>;

export const phaseUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(300),
    description: z.string().trim().max(5000).nullable(),
    sortOrder: z.number().int().min(0).max(10000),
    budgetHours: optHours.nullable(),
    scheduledStart: isoDate.nullable(),
    scheduledEnd: isoDate.nullable(),
    billSeparately: z.boolean(),
    billingMethod: z.enum(projectBillingMethods).nullable(),
    billingAmount: optMoney.nullable(),
    notes: z.string().trim().max(5000).nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field to change");
export type PhaseUpdate = z.infer<typeof phaseUpdateSchema>;

/** Where one billing scope (the project, or a phase billed separately) stands. */
export interface ProjectBillingScope {
  phaseId: number | null;
  name: string;
  billingMethod: ProjectBillingMethod;
  billingAmount: string | null;
  /** Fixed fee billed so far (deposit, progress and final lines on non-void invoices, drafts included). */
  feeBilled: string;
  feeRemaining: string | null;
  /** The final invoice exists, so the scope is closed out. */
  finalBilled: boolean;
  /** Everything invoiced for the scope so far (fees, labor and materials), drafts included. */
  invoicedToDate: string;
  unbilledHours: string;
  unbilledLabor: string;
  unbilledCharges: string;
  /** Open or submitted time that has to be approved before it can be billed. */
  unapprovedEntries: number;
  openTickets: number;
}

export interface ProjectBilling {
  projectId: number;
  status: ProjectStatus;
  scopes: ProjectBillingScope[];
}
