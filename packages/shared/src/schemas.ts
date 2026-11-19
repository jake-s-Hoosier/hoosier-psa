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
  contactId: z.number().int().nullable(),
  boardId: z.number().int(),
  board: z.string(),
  statusId: z.number().int(),
  status: z.string(),
  isClosed: z.boolean(),
  priorityId: z.number().int(),
  priority: z.string(),
  ownerMemberId: z.number().int().nullable(),
  enteredAt: z.string(),
  closedAt: z.string().nullable(),
  updatedAt: z.string(),
});
export type Ticket = z.infer<typeof ticketSchema>;

export const ticketListQuerySchema = paginationSchema.extend({
  q: z.string().trim().min(1).max(100).optional(),
  companyId: idSchema.optional(),
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
    statusId: idSchema,
    priorityId: idSchema,
    ownerMemberId: idSchema.nullable(),
    siteId: idSchema.nullable(),
    contactId: idSchema.nullable(),
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
  ticketId: z.number().int().nullable(),
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
    ticketId: idSchema,
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

export const timeEntryListQuerySchema = paginationSchema.extend({
  memberId: idSchema.optional(),
  ticketId: idSchema.optional(),
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
