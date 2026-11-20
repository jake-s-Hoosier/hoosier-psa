import { withActor } from "@hoosier/db";
import {
  type CompanyNote,
  type CompanyOverview,
  type Contact,
  type ContactChannelInput,
  type Site,
  companyNoteCreateSchema,
  companyUpdateSchema,
  contactInputSchema,
  contactUpdateSchema,
  idSchema,
  siteInputSchema,
  siteUpdateSchema,
} from "@hoosier/shared";
import type { FastifyPluginAsync } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { HttpError } from "../errors.js";

type Db = pg.Pool | pg.PoolClient;

interface SiteRow {
  id: string;
  company_id: string;
  name: string;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  phone: string | null;
  access_notes: string | null;
  is_default_service: boolean;
  is_billing: boolean;
}

const toSite = (r: SiteRow): Site => ({
  id: Number(r.id),
  companyId: Number(r.company_id),
  name: r.name,
  addressLine1: r.address_line1,
  addressLine2: r.address_line2,
  city: r.city,
  state: r.state,
  postalCode: r.postal_code,
  phone: r.phone,
  accessNotes: r.access_notes,
  isDefaultService: r.is_default_service,
  isBilling: r.is_billing,
});

const SELECT_SITE = `SELECT id, company_id, name, address_line1, address_line2, city, state, postal_code,
  phone, access_notes, is_default_service, is_billing FROM crm.site`;

interface ContactRow {
  id: string;
  company_id: string;
  site_id: string | null;
  site: string | null;
  first_name: string;
  last_name: string | null;
  title: string | null;
  department: string | null;
  notes: string | null;
  is_inactive: boolean;
  channels: Array<{
    kind: Contact["channels"][number]["kind"];
    value: string;
    extension: string | null;
  }>;
}

const SELECT_CONTACT = `
  SELECT c.id, c.company_id, c.site_id, s.name AS site, c.first_name, c.last_name, c.title,
         c.department, c.notes, c.is_inactive,
         COALESCE((SELECT json_agg(json_build_object('kind', ch.kind, 'value', ch.value,
                                                      'extension', ch.extension)
                                   ORDER BY ch.is_default DESC, ch.id)
                     FROM crm.contact_channel ch WHERE ch.contact_id = c.id), '[]'::json) AS channels
    FROM crm.contact c
    LEFT JOIN crm.site s ON s.id = c.site_id`;

const toContact = (r: ContactRow): Contact => ({
  id: Number(r.id),
  companyId: Number(r.company_id),
  siteId: r.site_id === null ? null : Number(r.site_id),
  site: r.site,
  firstName: r.first_name,
  lastName: r.last_name,
  title: r.title,
  department: r.department,
  notes: r.notes,
  isInactive: r.is_inactive,
  channels: r.channels,
});

/** Lower-cased email, or digits-only phone with a +1 for ten-digit US numbers. */
function normalizeChannel(c: ContactChannelInput): string {
  if (c.kind === "email") return c.value.toLowerCase();
  const digits = c.value.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits.length > 0 ? `+${digits}` : c.value;
}

async function requireCompany(db: Db, id: number): Promise<void> {
  const { rowCount } = await db.query(
    "SELECT 1 FROM crm.company WHERE id = $1 AND deleted_at IS NULL",
    [id],
  );
  if (!rowCount) throw new HttpError(404, "Not Found", `Company ${id} not found`);
}

async function siteBelongs(db: Db, companyId: number, siteId: number): Promise<void> {
  const { rowCount } = await db.query(
    "SELECT 1 FROM crm.site WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL",
    [siteId, companyId],
  );
  if (!rowCount)
    throw new HttpError(422, "Unprocessable Entity", "That site does not belong to this company");
}

async function replaceChannels(
  db: Db,
  contactId: number,
  channels: ContactChannelInput[],
): Promise<void> {
  await db.query("DELETE FROM crm.contact_channel WHERE contact_id = $1", [contactId]);
  const seen = new Set<string>();
  const firstOfKind = new Set<string>();
  for (const ch of channels) {
    const norm = normalizeChannel(ch);
    const key = `${ch.kind}|${norm}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const isDefault = !firstOfKind.has(ch.kind);
    firstOfKind.add(ch.kind);
    await db.query(
      `INSERT INTO crm.contact_channel (contact_id, kind, value, value_normalized, extension, is_default)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [contactId, ch.kind, ch.value, norm, ch.extension ?? null, isDefault],
    );
  }
}

const companyId = z.object({ id: idSchema });

export const crmRecordRoutes: FastifyPluginAsync = async (app) => {
  const write = { config: { perm: "crm.company.write" as const } };
  const read = { config: { perm: "crm.company.read" as const } };

  // ---- company edit ------------------------------------------------------------------------
  app.patch("/:id", write, async (req) => {
    const { id } = companyId.parse(req.params);
    const body = companyUpdateSchema.parse(req.body);
    const cols: Record<string, string> = {
      name: "name",
      statusId: "status_id",
      territoryId: "territory_id",
      phone: "phone",
      website: "website",
      isLead: "is_lead",
      isVendor: "is_vendor",
    };
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [key, col] of Object.entries(cols)) {
      const v = (body as Record<string, unknown>)[key];
      if (v === undefined) continue;
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    }
    params.push(id);
    await withActor(app.pool, req.memberId, async (c) => {
      await requireCompany(c, id);
      await c.query(
        `UPDATE crm.company SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length}`,
        params,
      );
    });
    const { rows } = await app.pool.query(
      `SELECT c.id, c.identifier, c.name, s.name AS status, t.name AS territory, c.phone, c.website,
              c.is_lead, c.is_vendor, c.created_at, c.updated_at
         FROM crm.company c JOIN crm.company_status s ON s.id = c.status_id
         LEFT JOIN crm.territory t ON t.id = c.territory_id WHERE c.id = $1`,
      [id],
    );
    const r = rows[0];
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
  });

  // ---- overview: the whole customer on one screen ------------------------------------------
  app.get("/:id/overview", read, async (req) => {
    const { id } = companyId.parse(req.params);
    const co = await app.pool.query(
      `SELECT c.id, c.identifier, c.name, s.name AS status, t.name AS territory, c.phone, c.website,
              c.is_lead, c.is_vendor, c.created_at, c.updated_at
         FROM crm.company c JOIN crm.company_status s ON s.id = c.status_id
         LEFT JOIN crm.territory t ON t.id = c.territory_id
        WHERE c.id = $1 AND c.deleted_at IS NULL`,
      [id],
    );
    const r = co.rows[0];
    if (!r) throw new HttpError(404, "Not Found", `Company ${id} not found`);
    const [sites, contacts, alerts, stats] = await Promise.all([
      app.pool.query<SiteRow>(
        `${SELECT_SITE} WHERE company_id = $1 AND deleted_at IS NULL ORDER BY name`,
        [id],
      ),
      app.pool.query<ContactRow>(
        `${SELECT_CONTACT} WHERE c.company_id = $1 AND c.deleted_at IS NULL
          ORDER BY c.is_inactive, c.first_name, c.last_name`,
        [id],
      ),
      listNotes(app.pool, id, true),
      app.pool.query(
        `SELECT
           (SELECT count(*) FROM service.ticket t JOIN service.board_status s ON s.id = t.status_id
             WHERE t.company_id = $1 AND NOT s.is_closed) AS open_tickets,
           (SELECT count(*) FROM service.ticket WHERE company_id = $1
               AND entered_at >= now() - interval '90 days') AS tickets_90,
           (SELECT COALESCE(sum(actual_hours), 0) FROM timekeeping.time_entry
             WHERE company_id = $1 AND status <> 'void' AND work_date >= current_date - 30) AS hours_30,
           (SELECT max(updated_at) FROM service.ticket WHERE company_id = $1) AS last_activity`,
        [id],
      ),
    ]);
    const st = stats.rows[0];
    const overview: CompanyOverview = {
      company: {
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
      },
      sites: sites.rows.map(toSite),
      contacts: contacts.rows.map(toContact),
      alerts,
      stats: {
        openTickets: Number(st.open_tickets),
        ticketsLast90Days: Number(st.tickets_90),
        hoursLast30Days: Number(st.hours_30),
        lastActivityAt: st.last_activity ? st.last_activity.toISOString() : null,
      },
    };
    return overview;
  });

  // ---- sites -------------------------------------------------------------------------------
  const siteCols: Record<string, string> = {
    name: "name",
    addressLine1: "address_line1",
    addressLine2: "address_line2",
    city: "city",
    state: "state",
    postalCode: "postal_code",
    phone: "phone",
    accessNotes: "access_notes",
    isDefaultService: "is_default_service",
    isBilling: "is_billing",
  };

  app.post("/:id/sites", write, async (req, reply) => {
    const { id } = companyId.parse(req.params);
    const body = siteInputSchema.parse(req.body);
    const created = await withActor(app.pool, req.memberId, async (c) => {
      await requireCompany(c, id);
      const keys = Object.keys(siteCols).filter(
        (k) => (body as Record<string, unknown>)[k] !== undefined,
      );
      const params: unknown[] = [id, ...keys.map((k) => (body as Record<string, unknown>)[k])];
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO crm.site (company_id, ${keys.map((k) => siteCols[k]).join(", ")})
         VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(", ")}) RETURNING id`,
        params,
      );
      const full = await c.query<SiteRow>(`${SELECT_SITE} WHERE id = $1`, [rows[0]?.id]);
      return full.rows[0] as SiteRow;
    });
    return reply.status(201).send(toSite(created));
  });

  app.patch("/:id/sites/:siteId", write, async (req) => {
    const { id, siteId } = z.object({ id: idSchema, siteId: idSchema }).parse(req.params);
    const body = siteUpdateSchema.parse(req.body);
    return withActor(app.pool, req.memberId, async (c) => {
      await siteBelongs(c, id, siteId);
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const [k, col] of Object.entries(siteCols)) {
        const v = (body as Record<string, unknown>)[k];
        if (v === undefined) continue;
        params.push(v);
        sets.push(`${col} = $${params.length}`);
      }
      params.push(siteId);
      await c.query(
        `UPDATE crm.site SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length}`,
        params,
      );
      const full = await c.query<SiteRow>(`${SELECT_SITE} WHERE id = $1`, [siteId]);
      return toSite(full.rows[0] as SiteRow);
    });
  });

  app.delete("/:id/sites/:siteId", write, async (req, reply) => {
    const { id, siteId } = z.object({ id: idSchema, siteId: idSchema }).parse(req.params);
    await withActor(app.pool, req.memberId, async (c) => {
      await siteBelongs(c, id, siteId);
      const open = await c.query(
        `SELECT 1 FROM service.ticket t JOIN service.board_status s ON s.id = t.status_id
          WHERE t.site_id = $1 AND NOT s.is_closed LIMIT 1`,
        [siteId],
      );
      if (open.rowCount)
        throw new HttpError(
          409,
          "Conflict",
          "This site has open tickets; move or close them first",
        );
      // People attached to the site stay with the company, just without a site.
      await c.query("UPDATE crm.contact SET site_id = NULL WHERE site_id = $1", [siteId]);
      await c.query("UPDATE crm.site SET deleted_at = now(), updated_at = now() WHERE id = $1", [
        siteId,
      ]);
    });
    return reply.status(204).send();
  });

  // ---- contacts ----------------------------------------------------------------------------
  app.post("/:id/contacts", write, async (req, reply) => {
    const { id } = companyId.parse(req.params);
    const body = contactInputSchema.parse(req.body);
    const created = await withActor(app.pool, req.memberId, async (c) => {
      await requireCompany(c, id);
      if (body.siteId) await siteBelongs(c, id, body.siteId);
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO crm.contact (company_id, site_id, first_name, last_name, title, department, notes, is_inactive)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [
          id,
          body.siteId ?? null,
          body.firstName,
          body.lastName ?? null,
          body.title ?? null,
          body.department ?? null,
          body.notes ?? null,
          body.isInactive ?? false,
        ],
      );
      const contactId = Number(rows[0]?.id);
      if (body.channels) await replaceChannels(c, contactId, body.channels);
      const full = await c.query<ContactRow>(`${SELECT_CONTACT} WHERE c.id = $1`, [contactId]);
      return full.rows[0] as ContactRow;
    });
    return reply.status(201).send(toContact(created));
  });

  app.patch("/:id/contacts/:contactId", write, async (req) => {
    const { id, contactId } = z.object({ id: idSchema, contactId: idSchema }).parse(req.params);
    const body = contactUpdateSchema.parse(req.body);
    return withActor(app.pool, req.memberId, async (c) => {
      const own = await c.query(
        "SELECT 1 FROM crm.contact WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL",
        [contactId, id],
      );
      if (!own.rowCount) throw new HttpError(404, "Not Found", `Contact ${contactId} not found`);
      if (body.siteId) await siteBelongs(c, id, body.siteId);
      const cols: Record<string, string> = {
        firstName: "first_name",
        lastName: "last_name",
        title: "title",
        department: "department",
        siteId: "site_id",
        notes: "notes",
        isInactive: "is_inactive",
      };
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const [k, col] of Object.entries(cols)) {
        const v = (body as Record<string, unknown>)[k];
        if (v === undefined) continue;
        params.push(v);
        sets.push(`${col} = $${params.length}`);
      }
      if (sets.length > 0) {
        params.push(contactId);
        await c.query(
          `UPDATE crm.contact SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length}`,
          params,
        );
      }
      if (body.channels) await replaceChannels(c, contactId, body.channels);
      const full = await c.query<ContactRow>(`${SELECT_CONTACT} WHERE c.id = $1`, [contactId]);
      return toContact(full.rows[0] as ContactRow);
    });
  });

  app.delete("/:id/contacts/:contactId", write, async (req, reply) => {
    const { id, contactId } = z.object({ id: idSchema, contactId: idSchema }).parse(req.params);
    await withActor(app.pool, req.memberId, async (c) => {
      const own = await c.query(
        "SELECT 1 FROM crm.contact WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL",
        [contactId, id],
      );
      if (!own.rowCount) throw new HttpError(404, "Not Found", `Contact ${contactId} not found`);
      const open = await c.query(
        `SELECT 1 FROM service.ticket t JOIN service.board_status s ON s.id = t.status_id
          WHERE t.contact_id = $1 AND NOT s.is_closed LIMIT 1`,
        [contactId],
      );
      if (open.rowCount)
        throw new HttpError(
          409,
          "Conflict",
          "This contact is on open tickets; mark them inactive instead",
        );
      await c.query("UPDATE crm.contact SET deleted_at = now(), updated_at = now() WHERE id = $1", [
        contactId,
      ]);
    });
    return reply.status(204).send();
  });

  // ---- notes -------------------------------------------------------------------------------
  app.get("/:id/notes", read, async (req) => {
    const { id } = companyId.parse(req.params);
    await requireCompany(app.pool, id);
    return { items: await listNotes(app.pool, id, false) };
  });

  app.post("/:id/notes", write, async (req, reply) => {
    const { id } = companyId.parse(req.params);
    const body = companyNoteCreateSchema.parse(req.body);
    const note = await withActor(app.pool, req.memberId, async (c) => {
      await requireCompany(c, id);
      if (body.contactId) {
        const ok = await c.query("SELECT 1 FROM crm.contact WHERE id = $1 AND company_id = $2", [
          body.contactId,
          id,
        ]);
        if (!ok.rowCount)
          throw new HttpError(
            422,
            "Unprocessable Entity",
            "That contact does not belong to this company",
          );
      }
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO crm.company_note (company_id, contact_id, member_id, kind, body, is_alert)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [id, body.contactId ?? null, req.memberId, body.kind, body.body, body.kind === "alert"],
      );
      return (await listNotes(c, id, false, Number(rows[0]?.id)))[0] as CompanyNote;
    });
    return reply.status(201).send(note);
  });
};

async function listNotes(
  db: Db,
  companyId: number,
  alertsOnly: boolean,
  onlyId?: number,
): Promise<CompanyNote[]> {
  const { rows } = await db.query(
    `SELECT n.id, n.kind, n.body, n.is_alert, n.contact_id, n.created_at,
            NULLIF(trim(concat(c.first_name, ' ', c.last_name)), '') AS contact,
            NULLIF(trim(concat(m.first_name, ' ', m.last_name)), '') AS author
       FROM crm.company_note n
       LEFT JOIN crm.contact c ON c.id = n.contact_id
       LEFT JOIN iam.member m ON m.id = n.member_id
      WHERE n.company_id = $1
        AND ($2::boolean = false OR n.is_alert)
        AND ($3::bigint IS NULL OR n.id = $3)
      ORDER BY n.created_at DESC, n.id DESC LIMIT 200`,
    [companyId, alertsOnly, onlyId ?? null],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    kind: r.kind,
    body: r.body,
    isAlert: r.is_alert,
    contactId: r.contact_id === null ? null : Number(r.contact_id),
    contact: r.contact,
    author: r.author,
    createdAt: r.created_at.toISOString(),
  }));
}
