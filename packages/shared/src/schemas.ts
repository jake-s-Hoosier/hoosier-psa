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
