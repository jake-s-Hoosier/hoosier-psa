import { withActor } from "@hoosier/db";
import {
  type Phase,
  type Project,
  type ProjectBilling,
  type ProjectBillingScope,
  idSchema,
  phaseCreateSchema,
  phaseUpdateSchema,
  projectCreateSchema,
  projectListQuerySchema,
  projectUpdateSchema,
} from "@hoosier/shared";
import type { FastifyPluginAsync } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { HttpError } from "../errors.js";

type Q = Pick<pg.Pool, "query">;

interface ProjectRow {
  id: string;
  company_id: string;
  company: string;
  site_id: string | null;
  site: string | null;
  name: string;
  project_type: string | null;
  status: Project["status"];
  manager_member_id: string | null;
  billing_method: Project["billingMethod"];
  billing_amount: string | null;
  po_number: string | null;
  po_amount: string | null;
  estimated_start: string | null;
  estimated_end: string | null;
  actual_start: string | null;
  actual_end: string | null;
  budget_hours: string | null;
  notes: string | null;
  closed_at: Date | null;
  ticket_count: string;
  open_ticket_count: string;
  hours_logged: string;
}

const d = (col: string) => `to_char(${col}, 'YYYY-MM-DD')`;

// Hours are time entries on the project's tickets; they never include void entries.
const SELECT_PROJECT = `
  SELECT p.id, p.company_id, c.name AS company, p.site_id, st.name AS site, p.name, p.project_type,
         p.status, p.manager_member_id, p.billing_method, p.billing_amount, p.po_number, p.po_amount,
         ${d("p.estimated_start")} AS estimated_start, ${d("p.estimated_end")} AS estimated_end,
         ${d("p.actual_start")} AS actual_start, ${d("p.actual_end")} AS actual_end,
         p.budget_hours, p.notes, p.closed_at,
         (SELECT count(*) FROM service.ticket t WHERE t.project_id = p.id) AS ticket_count,
         (SELECT count(*) FROM service.ticket t JOIN service.board_status s ON s.id = t.status_id
           WHERE t.project_id = p.id AND NOT s.is_closed) AS open_ticket_count,
         (SELECT COALESCE(sum(e.actual_hours), 0) FROM timekeeping.time_entry e
            JOIN service.ticket t ON t.id = e.ticket_id
           WHERE t.project_id = p.id AND e.status <> 'void') AS hours_logged
    FROM project.project p
    JOIN crm.company c ON c.id = p.company_id
    LEFT JOIN crm.site st ON st.id = p.site_id`;

interface PhaseRow {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  sort_order: number;
  budget_hours: string | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  bill_separately: boolean;
  billing_method: Phase["billingMethod"];
  billing_amount: string | null;
  notes: string | null;
  ticket_count: string;
  hours_logged: string;
}

const SELECT_PHASE = `
  SELECT h.id, h.project_id, h.name::text AS name, h.description, h.sort_order, h.budget_hours,
         ${d("h.scheduled_start")} AS scheduled_start, ${d("h.scheduled_end")} AS scheduled_end,
         h.bill_separately, h.billing_method, h.billing_amount, h.notes,
         (SELECT count(*) FROM service.ticket t WHERE t.phase_id = h.id) AS ticket_count,
         (SELECT COALESCE(sum(e.actual_hours), 0) FROM timekeeping.time_entry e
            JOIN service.ticket t ON t.id = e.ticket_id
           WHERE t.phase_id = h.id AND e.status <> 'void') AS hours_logged
    FROM project.phase h`;

const optNum = (v: string | null) => (v === null ? null : Number(v));
const toProject = (r: ProjectRow): Project => ({
  id: Number(r.id),
  companyId: Number(r.company_id),
  company: r.company,
  siteId: optNum(r.site_id),
  site: r.site,
  name: r.name,
  projectType: r.project_type,
  status: r.status,
  managerMemberId: optNum(r.manager_member_id),
  billingMethod: r.billing_method,
  billingAmount: r.billing_amount,
  poNumber: r.po_number,
  poAmount: r.po_amount,
  estimatedStart: r.estimated_start,
  estimatedEnd: r.estimated_end,
  actualStart: r.actual_start,
  actualEnd: r.actual_end,
  budgetHours: r.budget_hours,
  notes: r.notes,
  closedAt: r.closed_at?.toISOString() ?? null,
  ticketCount: Number(r.ticket_count),
  openTicketCount: Number(r.open_ticket_count),
  hoursLogged: r.hours_logged,
});
const toPhase = (r: PhaseRow): Phase => ({
  id: Number(r.id),
  projectId: Number(r.project_id),
  name: r.name,
  description: r.description,
  sortOrder: r.sort_order,
  budgetHours: r.budget_hours,
  scheduledStart: r.scheduled_start,
  scheduledEnd: r.scheduled_end,
  billSeparately: r.bill_separately,
  billingMethod: r.billing_method,
  billingAmount: r.billing_amount,
  notes: r.notes,
  ticketCount: Number(r.ticket_count),
  hoursLogged: r.hours_logged,
});

const params = z.object({ id: idSchema });
const phaseParams = z.object({ id: idSchema, phaseId: idSchema });

async function loadProject(q: Q, id: number, withPhases = false): Promise<Project> {
  const { rows } = await q.query<ProjectRow>(`${SELECT_PROJECT} WHERE p.id = $1`, [id]);
  if (!rows[0]) throw new HttpError(404, "Not Found", `Project ${id} not found`);
  const project = toProject(rows[0]);
  if (withPhases) {
    const ph = await q.query<PhaseRow>(
      `${SELECT_PHASE} WHERE h.project_id = $1 ORDER BY h.sort_order, h.id`,
      [id],
    );
    project.phases = ph.rows.map(toPhase);
  }
  return project;
}

async function loadPhase(q: Q, projectId: number, phaseId: number): Promise<Phase> {
  const { rows } = await q.query<PhaseRow>(
    `${SELECT_PHASE} WHERE h.id = $1 AND h.project_id = $2`,
    [phaseId, projectId],
  );
  if (!rows[0])
    throw new HttpError(404, "Not Found", `Phase ${phaseId} not found on project ${projectId}`);
  return toPhase(rows[0]);
}

/** Builds "col = $n" pairs from the supplied keys; undefined keys are left alone. */
function setClause(
  body: Record<string, unknown>,
  cols: Record<string, string>,
): { sets: string[]; values: unknown[] } {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, col] of Object.entries(cols)) {
    const v = body[key];
    if (v === undefined) continue;
    values.push(v);
    sets.push(`${col} = $${values.length}`);
  }
  return { sets, values };
}

const PROJECT_COLS = {
  name: "name",
  siteId: "site_id",
  projectType: "project_type",
  status: "status",
  managerMemberId: "manager_member_id",
  billingMethod: "billing_method",
  billingAmount: "billing_amount",
  poNumber: "po_number",
  poAmount: "po_amount",
  estimatedStart: "estimated_start",
  estimatedEnd: "estimated_end",
  actualStart: "actual_start",
  actualEnd: "actual_end",
  budgetHours: "budget_hours",
  notes: "notes",
};
const PHASE_COLS = {
  name: "name",
  description: "description",
  sortOrder: "sort_order",
  budgetHours: "budget_hours",
  scheduledStart: "scheduled_start",
  scheduledEnd: "scheduled_end",
  billSeparately: "bill_separately",
  billingMethod: "billing_method",
  billingAmount: "billing_amount",
  notes: "notes",
};

/** Projects and their phases. Mounted under /api/v1/projects. */
export const projectRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", { config: { perm: "project.read" } }, async (req) => {
    const qs = projectListQuerySchema.parse(req.query);
    const where: string[] = [];
    const values: unknown[] = [];
    if (qs.q) {
      values.push(`%${qs.q}%`);
      where.push(`(p.name ILIKE $${values.length} OR c.name ILIKE $${values.length})`);
    }
    if (qs.companyId) {
      values.push(qs.companyId);
      where.push(`p.company_id = $${values.length}`);
    }
    if (qs.managerMemberId) {
      values.push(qs.managerMemberId);
      where.push(`p.manager_member_id = $${values.length}`);
    }
    if (qs.state === "active") where.push("p.status NOT IN ('closed', 'canceled')");
    else if (qs.state === "closed") where.push("p.status IN ('closed', 'canceled')");
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = await app.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM project.project p JOIN crm.company c ON c.id = p.company_id ${clause}`,
      values,
    );
    values.push(qs.limit, qs.offset);
    const { rows } = await app.pool.query<ProjectRow>(
      `${SELECT_PROJECT} ${clause} ORDER BY p.id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return { items: rows.map(toProject), total: Number(total.rows[0]?.n ?? 0) };
  });

  app.get("/:id", { config: { perm: "project.read" } }, async (req) => {
    const { id } = params.parse(req.params);
    return loadProject(app.pool, id, true);
  });

  app.post("/", { config: { perm: "project.write" } }, async (req, reply) => {
    const body = projectCreateSchema.parse(req.body);
    const created = await withActor(app.pool, req.memberId as number, async (client) => {
      if (body.siteId !== undefined) {
        const ok = await client.query("SELECT 1 FROM crm.site WHERE id = $1 AND company_id = $2", [
          body.siteId,
          body.companyId,
        ]);
        if (!ok.rowCount)
          throw new HttpError(422, "Invalid site", "The site is not at this project's company");
      }
      const c = await client.query("SELECT 1 FROM crm.company WHERE id = $1", [body.companyId]);
      if (!c.rowCount) throw new HttpError(422, "Invalid company", "Company not found");
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO project.project
           (company_id, site_id, name, project_type, status, manager_member_id, billing_method,
            billing_amount, po_number, po_amount, estimated_start, estimated_end, budget_hours, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [
          body.companyId,
          body.siteId ?? null,
          body.name,
          body.projectType ?? null,
          body.status,
          body.managerMemberId ?? null,
          body.billingMethod,
          body.billingMethod === "actual_rates" ? null : (body.billingAmount ?? null),
          body.poNumber ?? null,
          body.poAmount ?? null,
          body.estimatedStart ?? null,
          body.estimatedEnd ?? null,
          body.budgetHours ?? null,
          body.notes ?? null,
        ],
      );
      return loadProject(client, Number(rows[0]?.id), true);
    });
    return reply.status(201).header("location", `/api/v1/projects/${created.id}`).send(created);
  });

  app.patch("/:id", { config: { perm: "project.write" } }, async (req) => {
    const { id } = params.parse(req.params);
    const body = projectUpdateSchema.parse(req.body);
    return withActor(app.pool, req.memberId as number, async (client) => {
      const cur = await loadProject(client, id);
      if (body.siteId) {
        const ok = await client.query("SELECT 1 FROM crm.site WHERE id = $1 AND company_id = $2", [
          body.siteId,
          cur.companyId,
        ]);
        if (!ok.rowCount)
          throw new HttpError(422, "Invalid site", "The site is not at this project's company");
      }
      // The billing method and amount have to agree after the change.
      const method = body.billingMethod ?? cur.billingMethod;
      const amount = body.billingAmount !== undefined ? body.billingAmount : cur.billingAmount;
      if (method !== "actual_rates" && !(Number(amount) > 0))
        throw new HttpError(
          422,
          "Amount needed",
          "Enter the fee, cap or rate for this billing method",
        );
      const patch: Record<string, unknown> = { ...body };
      if (method === "actual_rates") patch.billingAmount = null;
      const { sets, values } = setClause(patch, PROJECT_COLS);
      // Closing stamps closed_at (and the actual end if none); reopening clears it.
      if (body.status !== undefined) {
        const closing = body.status === "closed" || body.status === "canceled";
        const wasClosed = cur.status === "closed" || cur.status === "canceled";
        if (closing && !wasClosed) {
          sets.push("closed_at = now()");
          if (body.actualEnd === undefined && cur.actualEnd === null)
            sets.push("actual_end = current_date");
        } else if (!closing && wasClosed) sets.push("closed_at = NULL");
      }
      if (sets.length > 0) {
        values.push(id);
        await client.query(
          `UPDATE project.project SET ${sets.join(", ")} WHERE id = $${values.length}`,
          values,
        );
      }
      return loadProject(client, id, true);
    });
  });

  app.post("/:id/phases", { config: { perm: "project.write" } }, async (req, reply) => {
    const { id } = params.parse(req.params);
    const body = phaseCreateSchema.parse(req.body);
    const created = await withActor(app.pool, req.memberId as number, async (client) => {
      await loadProject(client, id);
      const next = await client.query<{ n: string }>(
        "SELECT COALESCE(max(sort_order), 0) + 10 AS n FROM project.phase WHERE project_id = $1",
        [id],
      );
      const dup = await client.query(
        "SELECT 1 FROM project.phase WHERE project_id = $1 AND name = $2",
        [id, body.name],
      );
      if (dup.rowCount)
        throw new HttpError(
          409,
          "Duplicate phase",
          "This project already has a phase with that name",
        );
      const method = body.billSeparately ? (body.billingMethod ?? null) : null;
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO project.phase
           (project_id, name, description, sort_order, budget_hours, scheduled_start, scheduled_end,
            bill_separately, billing_method, billing_amount, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [
          id,
          body.name,
          body.description ?? null,
          body.sortOrder ?? Number(next.rows[0]?.n),
          body.budgetHours ?? null,
          body.scheduledStart ?? null,
          body.scheduledEnd ?? null,
          body.billSeparately,
          method,
          method === null || method === "actual_rates" ? null : (body.billingAmount ?? null),
          body.notes ?? null,
        ],
      );
      return loadPhase(client, id, Number(rows[0]?.id));
    });
    return reply.status(201).send(created);
  });

  app.patch("/:id/phases/:phaseId", { config: { perm: "project.write" } }, async (req) => {
    const p = phaseParams.parse(req.params);
    const body = phaseUpdateSchema.parse(req.body);
    return withActor(app.pool, req.memberId as number, async (client) => {
      const cur = await loadPhase(client, p.id, p.phaseId);
      const separate = body.billSeparately ?? cur.billSeparately;
      let method = body.billingMethod !== undefined ? body.billingMethod : cur.billingMethod;
      let amount = body.billingAmount !== undefined ? body.billingAmount : cur.billingAmount;
      // Folding a phase back into its project drops its own billing terms.
      if (!separate) {
        method = null;
        amount = null;
      }
      if (method !== null && method !== "actual_rates" && !(Number(amount) > 0))
        throw new HttpError(
          422,
          "Amount needed",
          "Enter the fee, cap or rate for this billing method",
        );
      if (method === null || method === "actual_rates") amount = null;
      const patch: Record<string, unknown> = {
        ...body,
        billingMethod: method,
        billingAmount: amount,
      };
      const { sets, values } = setClause(patch, PHASE_COLS);
      if (body.name && body.name.toLowerCase() !== cur.name.toLowerCase()) {
        const dup = await client.query(
          "SELECT 1 FROM project.phase WHERE project_id = $1 AND name = $2 AND id <> $3",
          [p.id, body.name, p.phaseId],
        );
        if (dup.rowCount)
          throw new HttpError(
            409,
            "Duplicate phase",
            "This project already has a phase with that name",
          );
      }
      values.push(p.phaseId);
      await client.query(
        `UPDATE project.phase SET ${sets.join(", ")} WHERE id = $${values.length}`,
        values,
      );
      return loadPhase(client, p.id, p.phaseId);
    });
  });

  app.delete("/:id/phases/:phaseId", { config: { perm: "project.write" } }, async (req, reply) => {
    const p = phaseParams.parse(req.params);
    await withActor(app.pool, req.memberId as number, async (client) => {
      const cur = await loadPhase(client, p.id, p.phaseId);
      if (cur.ticketCount > 0)
        throw new HttpError(
          409,
          "Phase in use",
          "Tickets are in this phase; move them to another phase first",
        );
      await client.query("DELETE FROM project.phase WHERE id = $1", [p.phaseId]);
    });
    return reply.status(204).send();
  });

  /** Where each billing scope stands: the project, and every phase that is billed separately. */
  app.get("/:id/billing", { config: { perm: "project.read" } }, async (req) => {
    const { id } = params.parse(req.params);
    const project = await loadProject(app.pool, id, true);
    const scopes: ProjectBillingScope[] = [];
    const scopeList: {
      phaseId: number | null;
      name: string;
      method: Project["billingMethod"];
      amount: string | null;
    }[] = [
      {
        phaseId: null,
        name: project.name,
        method: project.billingMethod,
        amount: project.billingAmount,
      },
      ...(project.phases ?? [])
        .filter((h) => h.billSeparately)
        .map((h) => ({
          phaseId: h.id,
          name: h.name,
          // A separately billed phase with no terms of its own bills time and materials.
          method: h.billingMethod ?? ("actual_rates" as const),
          amount: h.billingMethod ? h.billingAmount : null,
        })),
    ];
    for (const sc of scopeList) {
      const scope = [id, sc.phaseId];
      const tickets = `t.project_id = $1 AND (
        CASE WHEN $2::bigint IS NULL
             THEN (t.phase_id IS NULL OR NOT EXISTS (
                     SELECT 1 FROM project.phase h WHERE h.id = t.phase_id AND h.bill_separately))
             ELSE t.phase_id = $2 END)`;
      const [fees, time, charges, unapproved, open] = await Promise.all([
        app.pool.query<{ fee_billed: string; invoiced: string; final_billed: boolean }>(
          `SELECT COALESCE(sum(l.amount) FILTER (WHERE l.project_fee), 0) AS fee_billed,
                  COALESCE(sum(l.amount), 0) AS invoiced,
                  EXISTS (SELECT 1 FROM billing.invoice i JOIN billing.billing_run r ON r.id = i.run_id
                           WHERE r.project_id = $1 AND r.phase_id IS NOT DISTINCT FROM $2
                             AND r.project_mode = 'final' AND i.status <> 'void') AS final_billed
             FROM billing.invoice_line l
            WHERE l.project_id = $1 AND l.phase_id IS NOT DISTINCT FROM $2 AND NOT l.is_void`,
          scope,
        ),
        app.pool.query<{ hours: string; labor: string }>(
          `SELECT COALESCE(sum(e.actual_hours), 0) AS hours,
                  COALESCE(sum(CASE WHEN e.billable = 'billable' THEN e.billed_hours * e.bill_rate END), 0) AS labor
             FROM timekeeping.time_entry e JOIN service.ticket t ON t.id = e.ticket_id
            WHERE e.status = 'approved' AND e.invoice_id IS NULL AND e.charge_type = 'service_ticket'
              AND ${tickets}`,
          scope,
        ),
        app.pool.query<{ amount: string }>(
          `SELECT COALESCE(sum(round(c.quantity * c.unit_price, 2)), 0) AS amount
             FROM service.ticket_charge c JOIN service.ticket t ON t.id = c.ticket_id
            WHERE c.invoice_id IS NULL AND c.billable = 'billable' AND ${tickets}`,
          scope,
        ),
        app.pool.query<{ n: string }>(
          `SELECT count(*) AS n FROM timekeeping.time_entry e JOIN service.ticket t ON t.id = e.ticket_id
            WHERE e.status IN ('open', 'submitted') AND ${tickets}`,
          scope,
        ),
        app.pool.query<{ n: string }>(
          `SELECT count(*) AS n FROM service.ticket t JOIN service.board_status s ON s.id = t.status_id
            WHERE NOT s.is_closed AND ${tickets}`,
          scope,
        ),
      ]);
      const f = fees.rows[0];
      const fixed = sc.method === "fixed_fee";
      scopes.push({
        phaseId: sc.phaseId,
        name: sc.name,
        billingMethod: sc.method,
        billingAmount: sc.amount,
        feeBilled: Number(f?.fee_billed ?? 0).toFixed(2),
        feeRemaining: fixed
          ? (Number(sc.amount ?? 0) - Number(f?.fee_billed ?? 0)).toFixed(2)
          : null,
        finalBilled: f?.final_billed ?? false,
        invoicedToDate: Number(f?.invoiced ?? 0).toFixed(2),
        unbilledHours: time.rows[0]?.hours ?? "0",
        unbilledLabor: Number(time.rows[0]?.labor ?? 0).toFixed(2),
        unbilledCharges: Number(charges.rows[0]?.amount ?? 0).toFixed(2),
        unapprovedEntries: Number(unapproved.rows[0]?.n ?? 0),
        openTickets: Number(open.rows[0]?.n ?? 0),
      });
    }
    const out: ProjectBilling = { projectId: id, status: project.status, scopes };
    return out;
  });

  /** The project's tickets, phase by phase (open first). */
  app.get("/:id/tickets", { config: { perm: "service.ticket.read" } }, async (req) => {
    const { id } = params.parse(req.params);
    await loadProject(app.pool, id);
    const { rows } = await app.pool.query<{
      id: string;
      summary: string;
      status: string;
      is_closed: boolean;
      phase_id: string | null;
      phase: string | null;
      owner: string | null;
      billing_method: string;
      hours: string;
    }>(
      `SELECT t.id, t.summary, s.name AS status, s.is_closed, t.phase_id, ph.name::text AS phase,
              concat(m.first_name, ' ', m.last_name) AS owner, t.billing_method,
              COALESCE((SELECT sum(e.actual_hours) FROM timekeeping.time_entry e
                         WHERE e.ticket_id = t.id AND e.status <> 'void'), 0) AS hours
         FROM service.ticket t
         JOIN service.board_status s ON s.id = t.status_id
         LEFT JOIN project.phase ph ON ph.id = t.phase_id
         LEFT JOIN iam.member m ON m.id = t.owner_member_id
        WHERE t.project_id = $1
        ORDER BY s.is_closed, ph.sort_order NULLS LAST, t.id`,
      [id],
    );
    return {
      items: rows.map((r) => ({
        id: Number(r.id),
        summary: r.summary,
        status: r.status,
        isClosed: r.is_closed,
        phaseId: optNum(r.phase_id),
        phase: r.phase,
        owner: r.owner,
        billingMethod: r.billing_method,
        hours: r.hours,
      })),
    };
  });
};
