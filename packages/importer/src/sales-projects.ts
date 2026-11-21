import type pg from "pg";
import {
  BILLING_METHODS,
  PLACEHOLDER_PROJECT_TYPE,
  clean,
  compareWbs,
  isDeadStage,
  mapProjectStatus,
  num,
  opportunityOutcome,
  stageProbability,
  stageSortOrder,
  wbsSortKey,
} from "./mappings.js";
import type { ImportReport } from "./report.js";

const OPERATING_TZ = "America/Indiana/Indianapolis";
type Id = number;

export interface SalesProjectsContext {
  members: { members: Map<number, Id> };
  companies: Map<number, Id>;
  sites: { byLegacyId: Map<number, Id> };
  contacts: { byLegacyId: Map<number, Id> };
}

/**
 * Sales pipeline and projects, in dependency order: stages, opportunities, projects, phases.
 * Ids are preserved for opportunities, projects and phases (ADR 0003); stages get new ids and are matched on
 * their ConnectWise id. Runs inside the importer's single transaction, so a dry run writes nothing.
 */
export async function importSalesAndProjects(
  src: pg.Pool,
  db: pg.PoolClient,
  report: ImportReport,
  ctx: SalesProjectsContext,
): Promise<{ projectTicketIds: Set<number> }> {
  const stageIds = await importStages(src, db, report);
  await importOpportunities(src, db, report, ctx, stageIds);
  const projects = await importProjects(src, db, report, ctx);
  await importPhases(src, db, report, projects);
  const projectTicketIds = await importProjectTickets(src, db, report, ctx, projects);
  return { projectTicketIds };
}

interface StageIds {
  byLegacyId: Map<number, Id>;
  won: Id | null;
  lost: Id | null;
}

async function importStages(
  src: pg.Pool,
  db: pg.PoolClient,
  report: ImportReport,
): Promise<StageIds> {
  const { rows } = await src.query<{ stage_id: number; stage_name: string }>(
    `SELECT DISTINCT stage_id, stage_name FROM production.opportunities
      WHERE stage_id IS NOT NULL AND stage_name IS NOT NULL ORDER BY stage_id`,
  );
  const c = report.count("sales_stages");
  const byLegacyId = new Map<number, Id>();
  for (const r of rows) {
    c.read += 1;
    const name = clean(r.stage_name);
    if (!name) continue;
    if (isDeadStage(name)) {
      // Dead is an outcome, not a place in the pipeline: those opportunities become Lost.
      c.skipped += 1;
      continue;
    }
    const { rows: out } = await db.query<{ id: string }>(
      `INSERT INTO sales.stage (name, sort_order, probability, legacy_cw_stage_id)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (legacy_cw_stage_id) DO UPDATE
         SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order, probability = EXCLUDED.probability,
             is_active = true
       RETURNING id`,
      [name, stageSortOrder(name), stageProbability(name), r.stage_id],
    );
    byLegacyId.set(r.stage_id, Number(out[0]?.id));
    c.written += 1;
  }
  if (byLegacyId.size > 0) {
    // The built-in starter stages are replaced by the ones the company really uses, unless already in use.
    await db.query(
      `UPDATE sales.stage s SET is_active = false
        WHERE s.legacy_cw_stage_id IS NULL AND NOT s.is_won AND NOT s.is_lost AND s.is_active
          AND NOT EXISTS (SELECT 1 FROM sales.opportunity o WHERE o.stage_id = s.id)`,
    );
  }
  const term = await db.query<{ id: string; is_won: boolean }>(
    `SELECT id, is_won FROM sales.stage WHERE (is_won OR is_lost) AND legacy_cw_stage_id IS NULL
      ORDER BY id`,
  );
  return {
    byLegacyId,
    won: Number(term.rows.find((t) => t.is_won)?.id) || null,
    lost: Number(term.rows.find((t) => !t.is_won)?.id) || null,
  };
}

async function importOpportunities(
  src: pg.Pool,
  db: pg.PoolClient,
  report: ImportReport,
  ctx: SalesProjectsContext,
  stages: StageIds,
): Promise<void> {
  const { rows } = await src.query<{
    id: number;
    name: string | null;
    company_id: number | null;
    stage_id: number | null;
    stage_name: string | null;
    status_name: string | null;
    primary_sales_rep_id: number | null;
    contact_id: number | null;
    site_id: number | null;
    expected_close_date: string | null;
    date_became_lead: string | null;
    closed_date: string | null;
    last_updated: string | null;
    total_sales: string | null;
    source_name: string | null;
    source: string | null;
    notes: string | null;
  }>(
    `SELECT id, name, company_id, stage_id, stage_name, status_name, primary_sales_rep_id, contact_id, site_id,
            expected_close_date::text, date_became_lead::text, closed_date::text, last_updated::text,
            total_sales, source_name, source, notes
       FROM production.opportunities ORDER BY id`,
  );
  const c = report.count("opportunities");
  for (const r of rows) {
    c.read += 1;
    const name = clean(r.name);
    if (!name) {
      c.skipped += 1;
      report.except("opportunities", r.id, "opportunity has no name");
      continue;
    }
    const companyId = r.company_id === null ? undefined : ctx.companies.get(r.company_id);
    if (companyId === undefined) {
      c.skipped += 1;
      report.except("opportunities", r.id, "company was not imported");
      continue;
    }
    const outcome = opportunityOutcome(r.status_name);
    if (outcome.unrecognised)
      report.except("opportunities", r.id, `status "${r.status_name}" not recognised; kept open`);
    let kind = outcome.kind;
    let reason = outcome.reason;
    const stageName = clean(r.stage_name) ?? "";
    if (kind === "open" && isDeadStage(stageName)) {
      kind = "lost";
      reason = "Dead";
      report.tally("opportunities", "open status in the Dead stage; imported as lost");
    }
    const stageId =
      kind === "won"
        ? stages.won
        : kind === "lost"
          ? stages.lost
          : r.stage_id === null
            ? null
            : (stages.byLegacyId.get(r.stage_id) ?? null);
    if (stageId === null) {
      c.skipped += 1;
      report.except("opportunities", r.id, "no stage to put it in");
      continue;
    }
    let amount = num(r.total_sales);
    if (amount !== null && amount < 0) {
      report.tally("opportunities", "negative total sales; amount left empty");
      amount = null;
    }
    let owner: Id | null = null;
    if (r.primary_sales_rep_id !== null) {
      owner = ctx.members.members.get(r.primary_sales_rep_id) ?? null;
      if (owner === null) report.tally("opportunities", "sales rep was not imported; no owner set");
    }
    const contactId =
      r.contact_id === null ? null : (ctx.contacts.byLegacyId.get(r.contact_id) ?? null);
    const siteId = r.site_id === null ? null : (ctx.sites.byLegacyId.get(r.site_id) ?? null);
    const closedFrom = r.closed_date ?? r.last_updated;
    await db.query(
      `INSERT INTO sales.opportunity
         (id, company_id, site_id, contact_id, name, stage_id, owner_member_id, expected_amount, expected_close,
          source, notes, lost_reason, closed_at, created_at, legacy_cw_opportunity_id)
       OVERRIDING SYSTEM VALUE
       VALUES ($1::int,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,$11,$12,
               CASE WHEN $13::text IS NULL THEN NULL
                    ELSE ($13::timestamp AT TIME ZONE '${OPERATING_TZ}') END,
               COALESCE(($14::timestamp AT TIME ZONE '${OPERATING_TZ}'), now()), $1::int)
       ON CONFLICT (id) DO UPDATE
         SET company_id = EXCLUDED.company_id, site_id = EXCLUDED.site_id, contact_id = EXCLUDED.contact_id,
             name = EXCLUDED.name, stage_id = EXCLUDED.stage_id, owner_member_id = EXCLUDED.owner_member_id,
             expected_amount = EXCLUDED.expected_amount, expected_close = EXCLUDED.expected_close,
             source = EXCLUDED.source, notes = EXCLUDED.notes, lost_reason = EXCLUDED.lost_reason,
             closed_at = EXCLUDED.closed_at`,
      [
        r.id,
        companyId,
        siteId,
        contactId,
        name.slice(0, 300),
        stageId,
        owner,
        amount,
        r.expected_close_date,
        clean(r.source_name) ?? clean(r.source),
        clean(r.notes),
        reason,
        kind === "open" ? null : closedFrom,
        r.date_became_lead,
      ],
    );
    c.written += 1;
  }
}

async function importProjects(
  src: pg.Pool,
  db: pg.PoolClient,
  report: ImportReport,
  ctx: SalesProjectsContext,
): Promise<Set<number>> {
  const people = await src.query<{
    id: number;
    first_name: string | null;
    last_name: string | null;
  }>("SELECT id, first_name, last_name FROM production.members");
  const byName = new Map<string, Id>();
  for (const m of people.rows) {
    const target = ctx.members.members.get(m.id);
    const full = `${clean(m.first_name) ?? ""} ${clean(m.last_name) ?? ""}`.trim().toLowerCase();
    if (target !== undefined && full) byName.set(full, target);
  }
  const { rows } = await src.query<{
    id: number;
    name: string | null;
    status: string | null;
    actual_start: string | null;
    actual_end: string | null;
    estimated_start: string | null;
    estimated_end: string | null;
    budget_hours: string | null;
    manager_name: string | null;
    company_id: number | null;
    last_updated: string | null;
    project_type: string | null;
    billing_method: string | null;
    site_id: number | null;
  }>(
    `SELECT id, name, status, actual_start::text, actual_end::text, estimated_start::text, estimated_end::text,
            budget_hours, manager_name, company_id, last_updated::text, project_type, billing_method, site_id
       FROM production.projects ORDER BY id`,
  );
  const c = report.count("projects");
  const imported = new Set<number>();
  for (const r of rows) {
    c.read += 1;
    const name = clean(r.name);
    if (!name) {
      c.skipped += 1;
      report.except("projects", r.id, "project has no name");
      continue;
    }
    const companyId = r.company_id === null ? undefined : ctx.companies.get(r.company_id);
    if (companyId === undefined) {
      c.skipped += 1;
      report.except("projects", r.id, "company was not imported");
      continue;
    }
    const { status, unrecognised } = mapProjectStatus(r.status);
    if (unrecognised)
      report.except("projects", r.id, `status "${r.status ?? ""}" not recognised; kept open`);
    let method = r.billing_method ? BILLING_METHODS[r.billing_method] : undefined;
    if (!method) {
      method = "actual_rates";
      report.tally("projects", "no billing method; set to actual rates");
    }
    const finished = status === "closed" || status === "canceled";
    if (method === "fixed_fee" && !finished)
      report.except(
        "projects",
        r.id,
        "open fixed-fee project: the fee is not in the warehouse; enter it on the project",
      );
    const rawType = clean(r.project_type);
    let projectType = rawType;
    if (rawType && PLACEHOLDER_PROJECT_TYPE.test(rawType)) {
      projectType = null;
      report.tally("projects", 'project type was the "MUST CHANGE" placeholder; left empty');
    }
    const manager = clean(r.manager_name);
    let managerId: Id | null = null;
    if (manager) {
      managerId = byName.get(manager.toLowerCase()) ?? null;
      if (managerId === null)
        report.tally("projects", "project manager is not a staff member; no manager set");
    }
    let estimatedEnd = r.estimated_end;
    if (estimatedEnd && r.estimated_start && estimatedEnd < r.estimated_start) {
      estimatedEnd = null;
      report.tally("projects", "estimated end before start; end left empty");
    }
    let actualEnd = r.actual_end;
    if (actualEnd && r.actual_start && actualEnd < r.actual_start) {
      actualEnd = null;
      report.tally("projects", "actual end before start; end left empty");
    }
    const siteId = r.site_id === null ? null : (ctx.sites.byLegacyId.get(r.site_id) ?? null);
    const closedFrom = finished ? (actualEnd ?? r.last_updated) : null;
    await db.query(
      `INSERT INTO project.project
         (id, company_id, site_id, name, project_type, status, manager_member_id, billing_method,
          estimated_start, estimated_end, actual_start, actual_end, budget_hours, closed_at, legacy_cw_project_id)
       OVERRIDING SYSTEM VALUE
       VALUES ($1::int,$2,$3,$4,$5,$6,$7,$8,$9::date,$10::date,$11::date,$12::date,$13,
               CASE WHEN $14::text IS NULL THEN NULL
                    ELSE ($14::timestamp AT TIME ZONE '${OPERATING_TZ}') END, $1::int)
       ON CONFLICT (id) DO UPDATE
         SET company_id = EXCLUDED.company_id, site_id = EXCLUDED.site_id, name = EXCLUDED.name,
             project_type = EXCLUDED.project_type, status = EXCLUDED.status,
             manager_member_id = EXCLUDED.manager_member_id, billing_method = EXCLUDED.billing_method,
             estimated_start = EXCLUDED.estimated_start, estimated_end = EXCLUDED.estimated_end,
             actual_start = EXCLUDED.actual_start, actual_end = EXCLUDED.actual_end,
             budget_hours = EXCLUDED.budget_hours, closed_at = EXCLUDED.closed_at`,
      [
        r.id,
        companyId,
        siteId,
        name.slice(0, 300),
        projectType,
        status,
        managerId,
        method,
        r.estimated_start,
        estimatedEnd,
        r.actual_start,
        actualEnd,
        num(r.budget_hours),
        closedFrom,
      ],
    );
    imported.add(r.id);
    c.written += 1;
  }
  return imported;
}

async function importPhases(
  src: pg.Pool,
  db: pg.PoolClient,
  report: ImportReport,
  projects: Set<number>,
): Promise<void> {
  const { rows } = await src.query<{
    phase_id: number;
    project_id: number;
    description: string | null;
    parent_phase_id: number | null;
    wbs_code: string | null;
    bill_separately_flag: boolean | null;
    billing_method: string | null;
    scheduled_start: string | null;
    scheduled_end: string | null;
    budget_hours: string | null;
    notes: string | null;
  }>(
    `SELECT phase_id, project_id, description, parent_phase_id, wbs_code, bill_separately_flag, billing_method,
            scheduled_start::text, scheduled_end::text, budget_hours, notes
       FROM production.project_phases ORDER BY project_id, phase_id`,
  );
  const c = report.count("phases");
  const byProject = new Map<number, typeof rows>();
  for (const r of rows) {
    c.read += 1;
    if (!projects.has(r.project_id)) {
      c.skipped += 1;
      report.except("phases", r.phase_id, `project ${r.project_id} was not imported`);
      continue;
    }
    const list = byProject.get(r.project_id) ?? [];
    list.push(r);
    byProject.set(r.project_id, list);
  }
  for (const [, list] of byProject) {
    list.sort(
      (a, b) =>
        compareWbs(wbsSortKey(a.wbs_code), wbsSortKey(b.wbs_code)) || a.phase_id - b.phase_id,
    );
    const used = new Set<string>();
    let order = 0;
    for (const r of list) {
      order += 10;
      let name = (clean(r.description) ?? `Phase ${r.phase_id}`).slice(0, 300);
      if (used.has(name.toLowerCase())) {
        name = `${name.slice(0, 280)} (${clean(r.wbs_code) ?? r.phase_id})`;
        report.tally("phases", "duplicate phase name in a project; code or id added to the name");
      }
      used.add(name.toLowerCase());
      if (r.parent_phase_id !== null)
        report.tally("phases", "sub-phase: hierarchy flattened into the project's phase list");
      const separate = r.bill_separately_flag === true;
      const method =
        separate && r.billing_method ? (BILLING_METHODS[r.billing_method] ?? null) : null;
      if (separate && method === "fixed_fee")
        report.except(
          "phases",
          r.phase_id,
          "separately billed fixed-fee phase: the fee is not in the warehouse",
        );
      let end = r.scheduled_end;
      if (end && r.scheduled_start && end < r.scheduled_start) {
        end = null;
        report.tally("phases", "scheduled end before start; end left empty");
      }
      await db.query(
        `INSERT INTO project.phase
           (id, project_id, name, sort_order, budget_hours, scheduled_start, scheduled_end, bill_separately,
            billing_method, notes, legacy_cw_phase_id)
         OVERRIDING SYSTEM VALUE
         VALUES ($1::int,$2,$3,$4,$5,$6::date,$7::date,$8,$9,$10,$1::int)
         ON CONFLICT (id) DO UPDATE
           SET project_id = EXCLUDED.project_id, name = EXCLUDED.name, sort_order = EXCLUDED.sort_order,
               budget_hours = EXCLUDED.budget_hours, scheduled_start = EXCLUDED.scheduled_start,
               scheduled_end = EXCLUDED.scheduled_end, bill_separately = EXCLUDED.bill_separately,
               billing_method = EXCLUDED.billing_method, notes = EXCLUDED.notes`,
        [
          r.phase_id,
          r.project_id,
          name,
          order,
          num(r.budget_hours),
          r.scheduled_start,
          end,
          separate,
          method,
          clean(r.notes),
        ],
      );
      c.written += 1;
    }
  }
}

/**
 * CW keeps project tickets in their own table (no company, phase or assignee of their own). Here project work
 * is done on ordinary tickets that point at a project, so each becomes a ticket on a "Project Tickets" board
 * with the CW ticket number preserved (CW ticket numbers are shared across both tables). Time entries that
 * charged a project ticket are re-pointed at the ticket by the time-entry step.
 */
async function importProjectTickets(
  src: pg.Pool,
  db: pg.PoolClient,
  report: ImportReport,
  ctx: SalesProjectsContext,
  projects: Set<number>,
): Promise<Set<number>> {
  const imported = new Set<number>();
  const { rows } = await src.query<{
    id: number;
    project_id: number | null;
    company_id: number | null;
    summary: string | null;
    status: string | null;
    budget_hours: string | null;
    closed_flag: boolean | null;
    date_entered: string | null;
    last_updated: Date | null;
  }>(
    `SELECT t.id, t.project_id, p.company_id, t.summary, t.status, t.budget_hours, t.closed_flag,
            t.date_entered::text AS date_entered, t.last_updated
       FROM production.project_tickets t LEFT JOIN production.projects p ON p.id = t.project_id
      ORDER BY t.id`,
  );
  if (rows.length === 0) return imported;

  const board = await db.query<{ id: string }>(
    `INSERT INTO service.board (name, description)
     VALUES ('Project Tickets', 'Tickets imported from ConnectWise project tickets')
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
  );
  const boardId = Number(board.rows[0]?.id);
  const statusIds = new Map<string, Id>();
  const names = new Map<string, boolean>();
  for (const r of rows) {
    const name = clean(r.status) ?? "Unknown";
    names.set(name, (names.get(name) ?? true) && r.closed_flag === true);
  }
  let order = 10;
  for (const [name, closed] of [...names.entries()].sort()) {
    const out = await db.query<{ id: string }>(
      `INSERT INTO service.board_status (board_id, name, sort_order, is_closed)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (board_id, name) DO UPDATE SET is_closed = EXCLUDED.is_closed RETURNING id`,
      [boardId, name, order, closed],
    );
    statusIds.set(name, Number(out.rows[0]?.id));
    order += 10;
  }
  await db.query(
    `UPDATE service.board_status bs SET is_default = true
      WHERE bs.id = (SELECT s.id FROM service.board_status s
                      WHERE s.board_id = $1 AND NOT s.is_closed
                      ORDER BY (s.name ILIKE 'new%') DESC, s.sort_order LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM service.board_status d WHERE d.board_id = $1 AND d.is_default)`,
    [boardId],
  );
  const prio = await db.query<{ id: string }>(
    `SELECT id FROM service.priority
      ORDER BY (name ILIKE '%normal%' OR name ILIKE '%medium%') DESC, sort_order LIMIT 1`,
  );
  const priorityId = prio.rows[0] ? Number(prio.rows[0].id) : null;
  if (priorityId === null) {
    report.except(
      "project tickets",
      "*",
      "no ticket priority exists; project tickets not imported",
    );
    return imported;
  }

  const c = report.count("project tickets");
  for (const r of rows) {
    c.read += 1;
    const companyId = r.company_id === null ? undefined : ctx.companies.get(r.company_id);
    const summary = clean(r.summary);
    if (r.project_id === null || !projects.has(r.project_id) || !companyId || !summary) {
      c.skipped += 1;
      report.except(
        "project tickets",
        r.id,
        "skipped: project or company not imported, or no summary",
      );
      continue;
    }
    const closed = r.closed_flag === true;
    // The mirror has no entered or closed dates for project tickets: last updated stands in for both.
    report.tally("project tickets", "no entered date; last updated used");
    await db.query(
      `INSERT INTO service.ticket
         (id, summary, company_id, board_id, status_id, priority_id, project_id, budget_hours,
          entered_at, closed_at, legacy_cw_ticket_id)
       OVERRIDING SYSTEM VALUE
       VALUES ($1::int,$2,$3,$4,$5,$6,$7,$8,
               COALESCE(($9::timestamp AT TIME ZONE '${OPERATING_TZ}'), now()),
               CASE WHEN $10 THEN COALESCE(($9::timestamp AT TIME ZONE '${OPERATING_TZ}'), now()) END,
               $1::int)
       ON CONFLICT (id) DO UPDATE
         SET summary = EXCLUDED.summary, company_id = EXCLUDED.company_id, board_id = EXCLUDED.board_id,
             status_id = EXCLUDED.status_id, project_id = EXCLUDED.project_id,
             budget_hours = EXCLUDED.budget_hours, entered_at = EXCLUDED.entered_at,
             closed_at = EXCLUDED.closed_at`,
      [
        r.id,
        summary.slice(0, 500),
        companyId,
        boardId,
        statusIds.get(clean(r.status) ?? "Unknown"),
        priorityId,
        r.project_id,
        num(r.budget_hours),
        r.last_updated,
        closed,
      ],
    );
    imported.add(r.id);
    c.written += 1;
  }
  report.except(
    "project tickets",
    "*",
    "phase, assignee and billing scope are not in the mirror; phases must be set by hand",
  );
  return imported;
}
