import { withActor } from "@hoosier/db";
import {
  type Company,
  companyCreateSchema,
  companyListQuerySchema,
  idSchema,
} from "@hoosier/shared";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { HttpError } from "../errors.js";

interface CompanyRow {
  id: string;
  identifier: string;
  name: string;
  status: string;
  territory: string | null;
  phone: string | null;
  website: string | null;
  is_lead: boolean;
  is_vendor: boolean;
  created_at: Date;
  updated_at: Date;
}

const SELECT_COMPANY = `
  SELECT c.id, c.identifier, c.name, s.name AS status, t.name AS territory,
         c.phone, c.website, c.is_lead, c.is_vendor, c.created_at, c.updated_at
    FROM crm.company c
    JOIN crm.company_status s ON s.id = c.status_id
    LEFT JOIN crm.territory t ON t.id = c.territory_id`;

function toCompany(r: CompanyRow): Company {
  return {
    id: Number(r.id),
    identifier: r.identifier,
    name: r.name,
    status: r.status,
    territory: r.territory,
    phone: r.phone,
    website: r.website,
    isLead: r.is_lead,
    isVendor: r.is_vendor,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export const companyRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", async (req) => {
    const q = companyListQuerySchema.parse(req.query);
    const where: string[] = ["c.deleted_at IS NULL"];
    const params: unknown[] = [];
    if (q.q) {
      params.push(`%${q.q}%`);
      where.push(`(c.name ILIKE $${params.length} OR c.identifier ILIKE $${params.length})`);
    }
    if (q.statusId) {
      params.push(q.statusId);
      where.push(`c.status_id = $${params.length}`);
    }
    const whereSql = `WHERE ${where.join(" AND ")}`;

    const total = await app.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM crm.company c ${whereSql}`,
      params,
    );
    const rows = await app.pool.query<CompanyRow>(
      `${SELECT_COMPANY} ${whereSql} ORDER BY c.name LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, q.limit, q.offset],
    );
    return {
      items: rows.rows.map(toCompany),
      total: Number(total.rows[0]?.n ?? 0),
      limit: q.limit,
      offset: q.offset,
    };
  });

  app.get("/:id", async (req) => {
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const { rows } = await app.pool.query<CompanyRow>(
      `${SELECT_COMPANY} WHERE c.id = $1 AND c.deleted_at IS NULL`,
      [id],
    );
    const row = rows[0];
    if (!row) throw new HttpError(404, "Not Found", `Company ${id} not found`);
    return toCompany(row);
  });

  app.post("/", async (req, reply) => {
    const body = companyCreateSchema.parse(req.body);
    const created = await withActor(app.pool, req.memberId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO crm.company
           (identifier, name, status_id, territory_id, phone, website, is_lead, is_vendor)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [
          body.identifier,
          body.name,
          body.statusId,
          body.territoryId ?? null,
          body.phone ?? null,
          body.website ?? null,
          body.isLead,
          body.isVendor,
        ],
      );
      const { rows: full } = await client.query<CompanyRow>(`${SELECT_COMPANY} WHERE c.id = $1`, [
        rows[0]?.id,
      ]);
      return full[0] as CompanyRow;
    });
    return reply
      .status(201)
      .header("location", `/api/v1/companies/${created.id}`)
      .send(toCompany(created));
  });
};
