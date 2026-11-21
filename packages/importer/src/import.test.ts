import { ensureMarker, migrateUp } from "@hoosier/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prioritySortOrder, runImport } from "./import.js";
import {
  compareWbs,
  cycleMonths,
  isDeadStage,
  mapBillCycle,
  mapProjectStatus,
  opportunityOutcome,
  perMonth,
  sane,
  stageNumber,
  stageProbability,
  stageSortOrder,
  wbsSortKey,
} from "./mappings.js";
import { createSourcePool } from "./source.js";

describe("prioritySortOrder", () => {
  it("sorts numbered priorities first and everything else last", () => {
    expect(prioritySortOrder("Priority 1 - Critical")).toBe(1);
    expect(prioritySortOrder("Priority 4 - Low")).toBe(4);
    expect(prioritySortOrder("Normal")).toBe(9);
  });
});

describe("agreement mappings", () => {
  it("maps CW bill cycles and flags the odd ones", () => {
    expect(mapBillCycle("Monthly")).toEqual({ cycle: "monthly" });
    expect(mapBillCycle("Quarterly")).toEqual({ cycle: "quarterly" });
    expect(mapBillCycle("Semi-Annual")).toEqual({ cycle: "semi_annual" });
    expect(mapBillCycle("Annual")).toEqual({ cycle: "annual" });
    expect(mapBillCycle("zDNU-Yearly").cycle).toBe("annual");
    expect(mapBillCycle("zDNU-Yearly").note).toMatch(/zDNU/);
    expect(mapBillCycle(null).cycle).toBe("monthly");
    expect(mapBillCycle(null).note).toBeDefined();
    expect(mapBillCycle("Fortnightly").note).toMatch(/unrecognised/);
  });
  it("divides cycle prices to monthly prices", () => {
    expect(cycleMonths("annual")).toBe(12);
    expect(perMonth(523.2, "annual")).toBe(43.6);
    expect(perMonth(120, "quarterly")).toBe(40);
    expect(perMonth(99.99, "monthly")).toBe(99.99);
    // Four decimal places keep a cycle's total exact to the cent once multiplied back.
    expect(Math.round(perMonth(180.29, "annual") * 12 * 100) / 100).toBe(180.29);
  });
  it("treats placeholder dates as missing", () => {
    expect(sane("2025-03-01")).toBe("2025-03-01");
    expect(sane("9999-12-31")).toBeNull();
    expect(sane("1900-01-01")).toBeNull();
    expect(sane(null)).toBeNull();
  });
});

describe("mappings", () => {
  it("reads stage numbers, ordering and the Dead stage", () => {
    expect(stageNumber("7. Ready for Proposal")).toBe(7);
    expect(stageNumber("10. Dead")).toBe(10);
    expect(stageNumber("Parked")).toBeNull();
    expect(stageSortOrder("10. Dead")).toBe(100);
    expect(stageSortOrder("Parked")).toBe(500);
    expect(isDeadStage("10. Dead")).toBe(true);
    expect(isDeadStage("9. Parked")).toBe(false);
    expect(stageProbability("5. Demo")).toBe(30);
    expect(stageProbability("Parked")).toBe(0);
  });

  it("classifies opportunity statuses", () => {
    expect(opportunityOutcome("Won").kind).toBe("won");
    expect(opportunityOutcome("Lost - Competitor")).toMatchObject({
      kind: "lost",
      reason: "Lost - Competitor",
    });
    expect(opportunityOutcome("Disqualified - Budget").kind).toBe("lost");
    expect(opportunityOutcome("Open - Existing Customer").kind).toBe("open");
    expect(opportunityOutcome("Parked").kind).toBe("open");
    expect(opportunityOutcome(null)).toMatchObject({ kind: "open", unrecognised: false });
    expect(opportunityOutcome("Something new")).toMatchObject({ kind: "open", unrecognised: true });
  });

  it("maps every CW project status in use", () => {
    const cases: Array<[string, string]> = [
      ["8 - Closed", "closed"],
      ["7 - Closed - Ready for Invoice", "ready_to_invoice"],
      ["9 - Customer Canceled", "canceled"],
      ["1 - Parts Needed", "planning"],
      ["1.25 - Parts Ordered", "planning"],
      ["1.85 Waiting on paperwork", "planning"],
      ["1.95 Waiting on Payment", "planning"],
      ["2 - NEEDS SCHEDULED", "open"],
      ["2.5 - Scheduled", "open"],
      ["3 - In Progress", "open"],
      ["5 - On-Hold", "on_hold"],
    ];
    for (const [cw, ours] of cases)
      expect(mapProjectStatus(cw)).toEqual({ status: ours, unrecognised: false });
    expect(mapProjectStatus("???").unrecognised).toBe(true);
  });

  it("sorts WBS codes as numbers", () => {
    const sorted = ["10", "1.10", "1.9", "2", "1"].sort((a, b) =>
      compareWbs(wbsSortKey(a), wbsSortKey(b)),
    );
    expect(sorted).toEqual(["1", "1.9", "1.10", "2", "10"]);
  });
});

describe("createSourcePool", () => {
  it("refuses a source that is the same database as the target", () => {
    expect(() =>
      createSourcePool(
        "postgres://u@h:5432/cw_datawarehouse",
        "postgres://u@h:5432/cw_datawarehouse",
      ),
    ).toThrow(/same database/);
  });
});

const adminUrl = process.env.TEST_DATABASE_URL;
const suite = adminUrl ? describe : describe.skip;

suite("import (integration)", () => {
  const srcName = `hoosier_imp_src_${process.pid}`;
  const tgtName = `hoosier_imp_tgt_${process.pid}`;
  let admin: pg.Pool;
  let srcAdmin: pg.Pool;
  let source: pg.Pool;
  let target: pg.Pool;
  let targetUrl: string;
  let sourceUrl: string;

  const urlFor = (db: string) => {
    const u = new URL(adminUrl as string);
    u.pathname = `/${db}`;
    return u.toString();
  };

  const run = (over: { appEnv?: "shadow" | "production" | "development"; dryRun?: boolean } = {}) =>
    runImport({
      source,
      target,
      targetUrl,
      appEnv: over.appEnv ?? "shadow",
      dryRun: over.dryRun ?? false,
    });

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
    for (const n of [srcName, tgtName]) {
      await admin.query(`DROP DATABASE IF EXISTS ${n}`);
      await admin.query(`CREATE DATABASE ${n}`);
    }
    sourceUrl = urlFor(srcName);
    targetUrl = urlFor(tgtName);

    // A miniature copy of the warehouse tables the importer reads.
    srcAdmin = new pg.Pool({ connectionString: sourceUrl, max: 1 });
    await srcAdmin.query(`
      CREATE SCHEMA production;
      CREATE TABLE production.members (id int PRIMARY KEY, identifier text, first_name text, last_name text,
        inactive_flag boolean, hourly_cost numeric);
      CREATE TABLE production.companies (id int PRIMARY KEY, name text, identifier text, phone_number text,
        fax_number text, website text, territory_name text, account_number text, date_acquired date,
        annual_revenue numeric, number_of_employees int, status_name text, lead_flag boolean,
        is_vendor_flag boolean, deleted_flag boolean, lead_source text, default_contact_id int,
        billing_contact_id int, site_id int, billing_site_id int);
      CREATE TABLE production.service_tickets (id int PRIMARY KEY, summary text, company_id int, board_id int,
        board_name text, status_id int, status_name text, priority_id int, priority_name text, type_id int,
        type_name text, source_id int, source_name text, assigned_to text, contact_name text, date_entered timestamp,
        date_closed timestamp, closed_flag boolean, budget_hours numeric, billing_method text,
        customer_updated_flag boolean, last_updated timestamp);
      CREATE TABLE production.time_entries (id int PRIMARY KEY, company_id int, charge_to_id int,
        charge_to_type text, member_id int, time_start timestamp, time_end timestamp, hours_billed numeric,
        actual_hours numeric, billable_option text, hourly_rate numeric, notes text, date_entered date);

      CREATE TABLE production.boards (id int PRIMARY KEY, name text);
      CREATE TABLE production.priorities (id int PRIMARY KEY, name text, color text, sort_order int);
      CREATE TABLE production.board_statuses (status_id int PRIMARY KEY, board_id int, status_name text,
        sort_order int, closed_status_flag boolean, inactive_flag boolean);
      CREATE TABLE production.work_roles (id int PRIMARY KEY, name text, hourly_rate numeric, inactive_flag boolean);
      CREATE TABLE production.work_types (id int PRIMARY KEY, name text, bill_time text, rate_type text, rate numeric,
        hours_min numeric, hours_max numeric, round_billing_hours_to numeric, inactive_flag boolean);
      CREATE TABLE production.site_addresses (site_id int PRIMARY KEY, company_id int, site_name text, address text);
      CREATE TABLE production.contacts (id int PRIMARY KEY, first_name text, last_name text, full_name text,
        company_id int, site_id int, title text, department_name text, email text, email2 text, email3 text,
        default_email text, inactive_flag boolean, do_not_solicit_flag boolean, unsubscribe_flag boolean,
        phone_number text, phone_ext text);
      CREATE TABLE production.contact_phones (contact_id int, type text, raw text, phone10 text, default_flag boolean);
      CREATE TABLE production.service_ticket_notes (note_id int PRIMARY KEY, ticket_id int, note_text text,
        detail_description_flag boolean, resolution_flag boolean, internal_analysis_flag boolean,
        internal_flag boolean, member_identifier text, date_created timestamp);

      INSERT INTO production.boards VALUES (1, 'Service Desk');
      INSERT INTO production.priorities VALUES (20, 'Priority 2 - High', '#ea580c', 2), (21, 'Priority 3 - Medium', 'bad', 3);
      INSERT INTO production.board_statuses VALUES (100, 1, 'New', 1, false, false), (101, 1, 'Closed', 9, true, false);
      INSERT INTO production.work_roles VALUES (1, 'Technician', 115, false), (2, 'Senior Tech', 147, false);
      INSERT INTO production.work_types VALUES
        (1, 'Onsite - Service', 'Billable', 'Custom', 147, 1, 0, NULL, false),
        (2, 'Internal', 'DoNotBill', 'Multiplier', 0, 0, 0, NULL, false),
        (3, 'After Hours', 'Billable', 'Multiplier', 1.5, 0, 0, 0.25, false),
        (4, 'Dispatch', 'Billable', 'Custom', 90, 0, 1, NULL, true);
      INSERT INTO production.site_addresses VALUES
        (7, 10, 'Main Office', '8243 Hall Road Suite 102, Utica, MI 48317'),
        (8, 10, 'Main Office', '15195 N Pointe Blvd, Noblesville, IN 46060-1234'),
        (9, 10, 'Annex', 'somewhere with no commas'),
        (10, 999, 'Orphan', '1 Nowhere Rd, X, IN 46000');
      INSERT INTO production.contacts VALUES
        (200, 'Pat', 'Lee', 'Pat Lee', 10, 7, 'Owner', 'Admin', 'pat@acme.test', 'Pat.Alt@acme.test', 'not-an-email', 'pat.alt@acme.test', false, false, true, NULL, NULL),
        (201, 'Sam', 'Roe', 'Sam Roe', 10, NULL, NULL, NULL, NULL, NULL, NULL, NULL, true, false, false, '317-555-0111 x9', NULL),
        (202, 'Sam', 'Roe', 'Sam Roe', 10, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, false, false, NULL, NULL),
        (203, 'No', 'Company', 'No Company', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, false, false, NULL, NULL);
      INSERT INTO production.contact_phones VALUES
        (200, 'Mobile', '(317) 555-0100', '3175550100', true),
        (200, 'Direct', '317.555.0100', '3175550100', false),
        (200, 'Work Landline', '555-01', NULL, false);
      INSERT INTO production.service_ticket_notes VALUES
        (1, 500, 'Door will not latch', true, false, false, false, 'JSmith', '2026-01-05 09:00'),
        (2, 500, 'Replaced strike plate', false, true, false, false, 'JSmith', '2026-01-05 10:30'),
        (3, 500, 'Customer called back', false, false, false, false, 'ghost', '2026-01-05 11:00'),
        (4, 500, 'tech only', false, false, true, false, NULL, '2026-01-05 11:30'),
        (5, 500, '   ', false, false, false, false, 'JSmith', '2026-01-05 12:00'),
        (6, 503, 'on a skipped ticket', false, false, false, false, 'JSmith', '2026-01-09 11:00');

      INSERT INTO production.members VALUES
        (1, 'JSmith', 'Jane', 'Smith', false, 55), (2, 'BJones', 'Bob', 'Jones', true, 40), (3, NULL, 'No', 'Ident', false, 0);
      INSERT INTO production.companies (id, name, identifier, status_name, deleted_flag, phone_number) VALUES
        (10, 'Acme Corp', 'ACME', 'Active', false, '317-555-0100'),
        (11, 'Old Co', 'OLD', 'Former Client', true, NULL),
        (12, 'No Status Inc', 'NOSTAT', NULL, false, NULL),
        (13, 'Dup Co', 'acme', 'Active', false, NULL),
        (14, NULL, 'NONAME', 'Active', false, NULL);
      INSERT INTO production.service_tickets VALUES
        (500, 'Door will not latch', 10, 1, 'Service Desk', 100, 'New', 20, 'Priority 2 - High', 30, 'Repair', 40, 'Phone',
         'JSmith', 'Pat Lee', '2026-01-05 09:00', NULL, false, 2, 'ActualRates', false, '2026-01-05 09:00'),
        (501, 'Camera offline', 10, 1, 'Service Desk', 101, 'Closed', 21, 'Priority 3 - Medium', NULL, NULL, NULL, NULL,
         'ghost', 'Nobody Known', '2026-01-06 10:00', '2026-01-07 10:00', true, NULL, 'FixedFee', false, '2026-01-07 10:00'),
        (502, 'Closed before opened', 10, 1, 'Service Desk', 101, 'Closed', 21, 'Priority 3 - Medium', NULL, NULL, NULL, NULL,
         NULL, NULL, '2026-01-08 10:00', '2026-01-01 10:00', true, NULL, 'OverrideRate', false, '2026-01-08 10:00'),
        (503, 'Orphan company', 999, 1, 'Service Desk', 100, 'New', 20, 'Priority 2 - High', NULL, NULL, NULL, NULL,
         NULL, NULL, '2026-01-09 10:00', NULL, false, NULL, 'ActualRates', false, '2026-01-09 10:00');
      UPDATE production.companies SET default_contact_id = 200, billing_contact_id = 200, site_id = 7, billing_site_id = 8 WHERE id = 10;
      INSERT INTO production.time_entries VALUES
        (900, 10, 500, 'ServiceTicket', 1, '2026-01-05 09:00', '2026-01-05 10:30', 1.5, 1.5, 'Billable', 150, 'Fixed latch', '2026-01-05'),
        (901, 10, 77, 'ProjectTicket', 1, NULL, NULL, 2, 2, 'DoNotBill', 0, NULL, '2026-01-06'),
        (902, 10, NULL, 'ChargeCode', 2, '2026-01-06 08:00', '2026-01-06 07:00', 1, 1, 'NoCharge', 0, 'bad times', '2026-01-06'),
        (903, 10, 503, 'ServiceTicket', 1, NULL, NULL, 1, 1, 'Billable', 100, 'ticket was skipped', '2026-01-09'),
        (904, 999, NULL, NULL, 1, NULL, NULL, 1, 1, 'Billable', 100, 'orphan company', '2026-01-09'),
        (905, 10, 7001, 'ProjectTicket', 1, NULL, NULL, 1, 1, 'Billable', 100, 'project work', '2026-01-10');

      CREATE TABLE production.opportunities (id int PRIMARY KEY, name text, company_id int, stage_id int,
        stage_name text, status_name text, primary_sales_rep_id int, contact_id int, site_id int,
        expected_close_date date, date_became_lead date, closed_date date, last_updated timestamp,
        total_sales numeric, source_name text, source text, notes text);
      CREATE TABLE production.projects (id int PRIMARY KEY, name text, status text, actual_start date,
        actual_end date, estimated_start date, estimated_end date, budget_hours numeric, manager_name text,
        company_id int, last_updated timestamp, project_type text, billing_method text, site_id int);
      CREATE TABLE production.project_phases (phase_id int PRIMARY KEY, project_id int, description text,
        parent_phase_id int, wbs_code text, bill_separately_flag boolean, billing_method text,
        scheduled_start date, scheduled_end date, budget_hours numeric, notes text);
      CREATE TABLE production.agreements (id int PRIMARY KEY, name text, company_id int, company_name text,
        type_id int, type_name text, start_date date, end_date date, cancelled_flag boolean, cancel_reason text,
        bill_cycle_id int, bill_cycle_name text, bill_amount numeric, tax_amount numeric, bill_start_date date,
        bill_to_company_id int, application_unlimited_flag boolean, application_limit numeric,
        last_updated timestamp, synced_at timestamp);
      INSERT INTO production.agreements (id, name, company_id, type_id, type_name, start_date, end_date,
        cancelled_flag, cancel_reason, bill_cycle_name, bill_start_date, bill_to_company_id,
        application_unlimited_flag, application_limit, last_updated) VALUES
        (300, 'Quarterly monitoring', 10, 1, 'Alarm Monitoring - Quarterly', '2025-01-01', NULL, false, NULL, 'Quarterly', '2025-01-01', 10, false, 0, '2025-02-01 10:00'),
        (301, 'Old JFI', 10, 2, 'JFI', '2024-01-01', '2025-06-30', true, 'Moved', 'Monthly', '2024-01-01', NULL, false, 0, '2025-07-01 10:00'),
        (302, 'Nobody home', 999, 2, 'JFI', '2025-01-01', NULL, false, NULL, 'Monthly', '2025-01-01', NULL, false, 0, NULL),
        (303, 'No cycle, no start', 10, 2, 'JFI', NULL, NULL, false, NULL, NULL, '2025-03-01', NULL, true, 0, '2025-03-05 10:00'),
        (304, 'Cancelled, dated by its line', 10, 2, 'JFI', '2025-01-01', NULL, true, NULL, 'Monthly', '2025-01-01', NULL, true, 0, '2026-11-20 03:00'),
        (305, 'Cancelled, no date anywhere', 10, 2, 'JFI', '2025-02-01', NULL, true, NULL, 'Monthly', '2025-02-01', NULL, true, 0, '2026-11-20 03:00');
      CREATE TABLE production.agreement_additions (id int PRIMARY KEY, agreement_id int, product_id int,
        product_identifier text, description text, invoice_description text, quantity numeric, billed_quantity numeric,
        unit_price numeric, unit_cost numeric, bill_customer text, prorate_current_period_flag boolean,
        effective_date timestamp, date_entered timestamp, cancelled_date timestamp, agreement_status text,
        last_updated timestamp, synced_at timestamp);
      INSERT INTO production.agreement_additions (id, agreement_id, product_identifier, description, quantity,
        unit_price, unit_cost, bill_customer, prorate_current_period_flag, effective_date, date_entered,
        cancelled_date, agreement_status, last_updated) VALUES
        (400, 300, 'MONITORING', 'Alarm monitoring', 2, 120, 30, 'Billable', false, '2025-01-01', '2025-01-01', NULL, 'Active', '2025-01-02'),
        (401, 301, 'JFI-M', NULL, 1, 100, 0, 'Billable', true, '2024-01-01', '2024-01-01', NULL, 'Active', '2024-01-02'),
        (402, 300, 'X', 'Free thing', 1, 10, 0, 'DoNotBill', false, '2025-01-01', NULL, NULL, 'Active', NULL),
        (403, 300, 'X', 'Zero quantity', 0, 10, 0, 'Billable', false, '2025-01-01', NULL, NULL, 'Active', NULL),
        (404, 303, 'Y', 'Ended in CW', 1, 25, 5, 'Billable', false, '2025-03-01', NULL, NULL, 'Inactive', '2025-09-09 08:00'),
        (405, 9999, 'Z', 'Orphan', 1, 1, 0, 'Billable', false, '2025-03-01', NULL, NULL, 'Active', NULL),
        (406, 304, 'W', 'Cancelled line', 1, 10, 0, 'Billable', false, '2025-01-01', NULL, '2025-04-15', 'Active', NULL);
      CREATE TABLE production.project_tickets (id int PRIMARY KEY, project_id int, summary text, status text,
        budget_hours numeric, actual_hours numeric, closed_flag boolean, date_entered date,
        last_updated timestamp, synced_at timestamp);
      INSERT INTO production.project_tickets VALUES
        (7001, 100, 'Pull cable to MDF', 'New', 8, 7.5, false, NULL, '2026-01-08 09:00', NULL),
        (7002, 100, 'Mount cameras', '*CLOSED', 4, 4, true, NULL, '2026-01-20 15:30', NULL),
        (7003, 108, 'Under a skipped project', 'New', NULL, NULL, false, NULL, NULL, NULL),
        (7004, 101, '   ', 'New', NULL, NULL, false, NULL, NULL, NULL);
      INSERT INTO production.opportunities VALUES
        (1, 'Open lead', 10, 3, '3. Contact Made', 'Open - New Lead', 1, 200, 7, '2026-03-01', '2026-01-10', NULL, '2026-01-11 12:00', 5000, 'Referral', NULL, 'call back'),
        (2, 'Won job', 10, 8, '7. Ready for Proposal', 'Won', 1, NULL, NULL, NULL, '2025-11-01', '2026-02-01', '2026-02-02 09:00', 12000.50, NULL, 'Web', NULL),
        (3, 'Lost, quiet', 10, 8, '7. Ready for Proposal', 'Lost - No Customer Response', 1, NULL, NULL, NULL, NULL, '2026-02-15', '2026-02-15 09:00', 800, NULL, NULL, NULL),
        (4, 'Dead but open', 10, 14, '10. Dead', 'Open - New Lead', NULL, NULL, NULL, NULL, NULL, NULL, '2026-01-12 09:00', NULL, NULL, NULL, NULL),
        (5, 'Spam entry', 10, 2, '1. New', 'Spam', NULL, NULL, NULL, NULL, NULL, NULL, '2026-01-20 10:00', NULL, NULL, NULL, NULL),
        (6, 'Negative total', 10, 2, '1. New', 'Open - New Lead', NULL, NULL, NULL, NULL, NULL, NULL, NULL, -50, NULL, NULL, NULL),
        (7, 'No company', 14, 2, '1. New', 'Open - New Lead', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1, NULL, NULL, NULL),
        (8, 'Rep not imported', 10, 2, '1. New', 'Open - New Lead', 99, NULL, NULL, NULL, NULL, NULL, NULL, 1, NULL, NULL, NULL),
        (9, 'Odd status', 10, 3, '3. Contact Made', 'Pending Review', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1, NULL, NULL, NULL),
        (10, '   ', 10, 2, '1. New', 'Open - New Lead', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1, NULL, NULL, NULL);
      INSERT INTO production.projects VALUES
        (100, 'Camera install', '3 - In Progress', '2026-01-05', NULL, '2026-01-05', '2026-03-01', 40, 'Jane Smith', 10, NULL, 'Installation - CCTV', 'FixedFee', 7),
        (101, 'Old job', '8 - Closed', '2025-01-01', '2025-02-01', NULL, NULL, 8, 'Accounting Dept', 10, '2025-03-01 08:00', 'Installation - Access Control', 'ActualRates', NULL),
        (102, 'Canceled job', '9 - Customer Canceled', NULL, NULL, NULL, NULL, NULL, NULL, 10, '2025-05-05 09:00', '* MUST CHANGE', NULL, NULL),
        (103, 'Waiting on parts', '1.25 - Parts Ordered', NULL, NULL, NULL, NULL, NULL, NULL, 10, NULL, NULL, 'FixedFee', NULL),
        (104, 'Ready to bill', '7 - Closed - Ready for Invoice', '2026-01-02', '2026-01-20', NULL, NULL, NULL, NULL, 10, NULL, NULL, 'FixedFee', NULL),
        (105, 'On hold', '5 - On-Hold', NULL, NULL, NULL, NULL, NULL, NULL, 10, NULL, NULL, 'OverrideRate', NULL),
        (106, 'Mystery status', 'Whatever', NULL, NULL, NULL, NULL, NULL, NULL, 10, NULL, NULL, 'ActualRates', NULL),
        (107, 'Bad dates', '2 - NEEDS SCHEDULED', NULL, NULL, '2026-05-01', '2026-04-01', NULL, NULL, 10, NULL, NULL, 'NotToExceed', NULL),
        (108, 'Company missing', '2 - NEEDS SCHEDULED', NULL, NULL, NULL, NULL, NULL, NULL, 999, NULL, NULL, 'ActualRates', NULL);
      INSERT INTO production.project_phases VALUES
        (1000, 100, 'Rough-in', NULL, '1', false, 'FixedFee', '2026-01-05', '2026-01-12', 10, 'run cable'),
        (1001, 100, 'Trim', NULL, '2', true, 'FixedFee', NULL, NULL, 5, NULL),
        (1002, 100, 'Rough-in', 1000, '1.1', false, NULL, NULL, NULL, 2, NULL),
        (1003, 100, 'Commissioning', NULL, '10', false, NULL, NULL, NULL, 3, NULL),
        (1004, 108, 'Under a skipped project', NULL, '1', false, NULL, NULL, NULL, NULL, NULL),
        (1005, 101, 'Closed phase', NULL, '1', true, 'ActualRates', '2025-01-05', '2025-01-01', NULL, NULL);
    `);
    source = createSourcePool(sourceUrl, targetUrl);

    target = new pg.Pool({ connectionString: targetUrl, max: 3 });
    await migrateUp(target);
    await ensureMarker(target, "shadow");
  });

  afterAll(async () => {
    await source?.end();
    await srcAdmin?.end();
    await target?.end();
    for (const n of [srcName, tgtName]) await admin?.query(`DROP DATABASE IF EXISTS ${n}`);
    await admin?.end();
  });

  const count = async (sql: string) => Number((await target.query<{ n: string }>(sql)).rows[0]?.n);

  it("a dry run reports what would happen and writes nothing", async () => {
    const result = await run({ dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.report.counts.tickets?.written).toBe(3);
    expect(await count("SELECT count(*) AS n FROM service.ticket")).toBe(0);
    expect(await count("SELECT count(*) AS n FROM iam.member")).toBe(0);
    expect(await count("SELECT count(*) AS n FROM service.board")).toBe(0);
  });

  it("imports with preserved ids, exceptions reported, and reconciliation", async () => {
    const { report, reconciliation } = await run();

    expect(report.counts.members).toMatchObject({ read: 3, written: 2, skipped: 1 });
    expect(report.counts.companies).toMatchObject({ read: 5, written: 4, skipped: 1 });
    expect(report.counts.tickets).toMatchObject({ read: 4, written: 3, skipped: 1 });
    expect(report.counts["time entries"]).toMatchObject({ read: 6, written: 4, skipped: 2 });

    // Ticket numbers are the CW ids.
    const ids = (
      await target.query<{ id: string }>(
        "SELECT id FROM service.ticket WHERE id < 7000 ORDER BY id",
      )
    ).rows.map((r) => Number(r.id));
    expect(ids).toEqual([500, 501, 502]);

    const t500 = (
      await target.query(
        "SELECT t.*, p.name AS prio, p.sort_order FROM service.ticket t JOIN service.priority p ON p.id = t.priority_id WHERE t.id = 500",
      )
    ).rows[0];
    expect(t500.prio).toBe("Priority 2 - High");
    expect(t500.sort_order).toBe(2);
    expect(t500.owner_member_id).not.toBeNull();
    expect(t500.billing_method).toBe("actual_rates");
    // Naive warehouse timestamps are read as Indianapolis local time (EST = UTC-5 in January).
    expect(new Date(t500.entered_at).toISOString()).toBe("2026-01-05T14:00:00.000Z");

    // Billing methods map; ticket closed before entered keeps its other data but drops the close date.
    expect(
      (await target.query("SELECT billing_method, closed_at FROM service.ticket WHERE id = 501"))
        .rows[0].billing_method,
    ).toBe("fixed_fee");
    expect(
      (await target.query("SELECT closed_at FROM service.ticket WHERE id = 502")).rows[0].closed_at,
    ).toBeNull();

    // Closed/default status inference.
    const st = (
      await target.query(
        "SELECT name, is_closed, is_default FROM service.board_status WHERE legacy_cw_status_id IS NOT NULL ORDER BY name",
      )
    ).rows;
    expect(st).toEqual([
      { name: "Closed", is_closed: true, is_default: false },
      { name: "New", is_closed: false, is_default: true },
    ]);

    // Company handling: deleted flag, missing status, duplicate identifier, missing name.
    const deleted = await target.query(
      "SELECT deleted_at FROM crm.company WHERE legacy_cw_company_id = 11",
    );
    expect(deleted.rows[0].deleted_at).not.toBeNull();
    const nostat = await target.query(
      "SELECT s.name FROM crm.company c JOIN crm.company_status s ON s.id = c.status_id WHERE c.legacy_cw_company_id = 12",
    );
    expect(nostat.rows[0].name).toBe("Unknown");
    const dup = await target.query(
      "SELECT identifier FROM crm.company WHERE legacy_cw_company_id = 13",
    );
    expect(dup.rows[0].identifier).toBe("CW-13");

    // Time entries: charge types, bad times dropped, skipped ticket becomes a DB rejection exception.
    const te = (
      await target.query(
        "SELECT id, charge_type, ticket_id, project_ticket_id, started_at, billable, status FROM timekeeping.time_entry ORDER BY id",
      )
    ).rows;
    expect(te.map((r) => [Number(r.id), r.charge_type, r.billable])).toEqual([
      [900, "service_ticket", "billable"],
      [901, "project_ticket", "do_not_bill"],
      [902, "non_ticket", "no_charge"],
      [905, "service_ticket", "billable"],
    ]);
    expect(te[2].started_at).toBeNull();
    expect(te.every((r) => r.status === "approved")).toBe(true);
    const problems = report.exceptions.map((e) => `${e.entity}:${e.sourceId}:${e.problem}`);
    expect(problems.some((p) => p.startsWith("time entries:903:rejected by database"))).toBe(true);

    // Catalog: work roles and types keep rates, minimum/maximum hours and billing flags.
    const wt = (
      await target.query(
        "SELECT name::text, rate_type, rate_multiplier::float, custom_rate::float, bill_time, hours_min::float, hours_max::float, round_billing_hours_to::float, is_active FROM catalog.work_type ORDER BY legacy_cw_work_type_id",
      )
    ).rows.filter((r) =>
      ["Onsite - Service", "Internal", "After Hours", "Dispatch"].includes(r.name),
    );
    expect(wt).toEqual([
      {
        name: "Onsite - Service",
        rate_type: "custom",
        rate_multiplier: 1,
        custom_rate: 147,
        bill_time: "billable",
        hours_min: 1,
        hours_max: 0,
        round_billing_hours_to: null,
        is_active: true,
      },
      {
        name: "Internal",
        rate_type: "multiplier",
        rate_multiplier: 1,
        custom_rate: null,
        bill_time: "do_not_bill",
        hours_min: 0,
        hours_max: 0,
        round_billing_hours_to: null,
        is_active: true,
      },
      {
        name: "After Hours",
        rate_type: "multiplier",
        rate_multiplier: 1.5,
        custom_rate: null,
        bill_time: "billable",
        hours_min: 0,
        hours_max: 0,
        round_billing_hours_to: 0.25,
        is_active: true,
      },
      {
        name: "Dispatch",
        rate_type: "custom",
        rate_multiplier: 1,
        custom_rate: 90,
        bill_time: "billable",
        hours_min: 0,
        hours_max: 1,
        round_billing_hours_to: null,
        is_active: false,
      },
    ]);
    expect(report.counts["work roles"]).toMatchObject({ read: 2, written: 2 });

    // Sites: address parsing, duplicate names disambiguated, orphan skipped, company defaults set.
    const sites = (
      await target.query(
        "SELECT name, address_line1, city, state, postal_code, is_default_service, is_billing FROM crm.site ORDER BY legacy_cw_site_id",
      )
    ).rows;
    expect(sites).toHaveLength(3);
    expect(sites[0]).toMatchObject({
      name: "Main Office",
      address_line1: "8243 Hall Road Suite 102",
      city: "Utica",
      state: "MI",
      postal_code: "48317",
      is_default_service: true,
      is_billing: false,
    });
    expect(sites[1]).toMatchObject({
      name: "Main Office (8)",
      postal_code: "46060",
      is_billing: true,
    });
    expect(sites[2]).toMatchObject({ address_line1: "somewhere with no commas", city: null });
    expect(report.counts.sites).toMatchObject({ read: 4, written: 3, skipped: 1 });

    // Contacts: companyless skipped, channels normalised, one default per kind, opt-out from unsubscribe.
    expect(report.counts.contacts).toMatchObject({ read: 4, written: 3, skipped: 1 });
    const pat = (
      await target.query(
        "SELECT id, is_marketing_opt_out, site_id FROM crm.contact WHERE legacy_cw_contact_id = 200",
      )
    ).rows[0];
    expect(pat.is_marketing_opt_out).toBe(true);
    expect(pat.site_id).not.toBeNull();
    const chans = (
      await target.query(
        "SELECT kind, value_normalized, is_default FROM crm.contact_channel WHERE contact_id = $1 ORDER BY kind, value_normalized",
        [pat.id],
      )
    ).rows;
    expect(chans).toEqual([
      { kind: "direct", value_normalized: "+13175550100", is_default: false },
      { kind: "email", value_normalized: "pat.alt@acme.test", is_default: true },
      { kind: "email", value_normalized: "pat@acme.test", is_default: false },
      { kind: "mobile", value_normalized: "+13175550100", is_default: true },
    ]);
    const sam = (
      await target.query(
        "SELECT value_normalized, extension FROM crm.contact_channel c JOIN crm.contact k ON k.id = c.contact_id WHERE k.legacy_cw_contact_id = 201",
      )
    ).rows;
    expect(sam).toEqual([{ value_normalized: "+13175550111", extension: "9" }]);
    const company = (
      await target.query(
        "SELECT default_contact_id, billing_contact_id FROM crm.company WHERE legacy_cw_company_id = 10",
      )
    ).rows[0];
    expect(company.default_contact_id).toBe(pat.id);

    // Ticket 500 links to its contact by name; the unknown name is tallied rather than guessed.
    expect(
      (await target.query("SELECT contact_id FROM service.ticket WHERE id = 500")).rows[0]
        .contact_id,
    ).toBe(pat.id);
    expect(
      (await target.query("SELECT contact_id FROM service.ticket WHERE id = 501")).rows[0]
        .contact_id,
    ).toBeNull();

    // Notes: kind precedence, empty and skipped-ticket notes dropped, unmatched author left blank.
    const notes = (
      await target.query(
        "SELECT kind, body, author_member_id FROM service.ticket_note ORDER BY legacy_cw_note_id",
      )
    ).rows;
    expect(notes.map((n) => [n.kind, n.body])).toEqual([
      ["description", "Door will not latch"],
      ["resolution", "Replaced strike plate"],
      ["discussion", "Customer called back"],
      ["internal", "tech only"],
    ]);
    expect(notes[0].author_member_id).not.toBeNull();
    expect(notes[2].author_member_id).toBeNull();
    expect(report.counts["ticket notes"]).toMatchObject({ read: 6, written: 4, skipped: 2 });

    // Reconciliation compares the whole source to what landed (skipped rows show as differences).
    expect(reconciliation.tickets).toEqual({ source: 8, target: 5 }); // service + project tickets
    expect(reconciliation.timeEntries).toEqual({ source: 6, target: 4 });

    // New native records continue the CW numbering, past skipped records too.
    const next = await target.query<{ id: string }>(
      `INSERT INTO service.ticket (summary, company_id, board_id, status_id, priority_id)
       SELECT 'native', c.id, b.id, s.id, p.id FROM crm.company c, service.board b, service.board_status s, service.priority p
        WHERE c.legacy_cw_company_id = 10 AND s.board_id = b.id AND s.is_default AND p.legacy_cw_priority_id = 20
        RETURNING id`,
    );
    // Skipped CW tickets keep their numbers reserved, and so do project tickets (CW shares one number space).
    expect(Number(next.rows[0]?.id)).toBe(7005);
  });

  it("imports stages, opportunities, projects and phases with the rules in docs/11", async () => {
    const { report, reconciliation } = await run();
    expect(report.counts.opportunities).toMatchObject({ read: 10, written: 8, skipped: 2 });
    expect(report.counts.projects).toMatchObject({ read: 9, written: 8, skipped: 1 });
    expect(report.counts.phases).toMatchObject({ read: 6, written: 5, skipped: 1 });
    expect(reconciliation.opportunities).toEqual({ source: 10, target: 8 });
    expect(reconciliation.projects).toEqual({ source: 9, target: 8 });
    expect(reconciliation.agreements).toEqual({ source: 6, target: 5 });
    expect(reconciliation.agreementAdditions).toEqual({ source: 7, target: 4 });
    expect(reconciliation.phases).toEqual({ source: 6, target: 5 });

    // CW stages come across by their own names; Dead is an outcome, and the starter stages step aside.
    const stages = (
      await target.query<{ name: string; sort_order: number; probability: number }>(
        "SELECT name, sort_order, probability FROM sales.stage WHERE legacy_cw_stage_id IS NOT NULL ORDER BY sort_order",
      )
    ).rows;
    expect(stages).toEqual([
      { name: "1. New", sort_order: 10, probability: 10 },
      { name: "3. Contact Made", sort_order: 30, probability: 10 },
      { name: "7. Ready for Proposal", sort_order: 70, probability: 50 },
    ]);
    expect(await count("SELECT count(*) AS n FROM sales.stage WHERE name = '10. Dead'")).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM sales.stage WHERE legacy_cw_stage_id IS NULL AND NOT is_won AND NOT is_lost AND is_active",
      ),
    ).toBe(0);

    const opp = async (id: number) =>
      (
        await target.query(
          `SELECT o.*, s.name AS stage, s.is_won, s.is_lost FROM sales.opportunity o
             JOIN sales.stage s ON s.id = o.stage_id WHERE o.id = $1`,
          [id],
        )
      ).rows[0];
    const open = await opp(1);
    expect(open).toMatchObject({
      stage: "3. Contact Made",
      is_won: false,
      is_lost: false,
      source: "Referral",
      notes: "call back",
    });
    expect(open.closed_at).toBeNull();
    expect(Number(open.expected_amount)).toBe(5000);
    expect(open.owner_member_id).not.toBeNull();
    expect(open.contact_id).not.toBeNull();
    expect(open.site_id).not.toBeNull();
    // Created when it became a lead, read as Indianapolis midnight (EST).
    expect(new Date(open.created_at).toISOString()).toBe("2026-01-10T05:00:00.000Z");
    expect(await opp(2)).toMatchObject({ is_won: true, source: "Web" });
    expect(Number((await opp(2)).expected_amount)).toBe(12000.5);
    expect((await opp(2)).closed_at).not.toBeNull();
    expect(await opp(3)).toMatchObject({
      is_lost: true,
      lost_reason: "Lost - No Customer Response",
    });
    expect(await opp(4)).toMatchObject({ is_lost: true, lost_reason: "Dead" });
    expect(await opp(5)).toMatchObject({ is_lost: true, lost_reason: "Spam" });
    expect((await opp(5)).closed_at).not.toBeNull(); // falls back to the last update
    expect((await opp(6)).expected_amount).toBeNull();
    expect((await opp(8)).owner_member_id).toBeNull();
    expect(await opp(9)).toMatchObject({ is_won: false, is_lost: false, stage: "3. Contact Made" });
    expect(await count("SELECT count(*) AS n FROM sales.opportunity WHERE id IN (7, 10)")).toBe(0);

    const project = async (id: number) =>
      (await target.query("SELECT * FROM project.project WHERE id = $1", [id])).rows[0];
    expect(await project(100)).toMatchObject({
      status: "open",
      billing_method: "fixed_fee",
      project_type: "Installation - CCTV",
    });
    expect((await project(100)).billing_amount).toBeNull();
    expect((await project(100)).manager_member_id).not.toBeNull();
    expect((await project(100)).site_id).not.toBeNull();
    expect(Number((await project(100)).budget_hours)).toBe(40);
    expect(await project(101)).toMatchObject({ status: "closed", billing_method: "actual_rates" });
    expect((await project(101)).closed_at).not.toBeNull();
    expect((await project(101)).manager_member_id).toBeNull(); // "Accounting Dept" is not a person
    expect(await project(102)).toMatchObject({
      status: "canceled",
      billing_method: "actual_rates",
      project_type: null,
    });
    expect((await project(103)).status).toBe("planning");
    expect((await project(104)).status).toBe("ready_to_invoice");
    expect((await project(105)).status).toBe("on_hold");
    expect((await project(105)).billing_method).toBe("override_rate");
    expect((await project(106)).status).toBe("open");
    expect((await project(107)).estimated_end).toBeNull(); // end before start is dropped
    expect(await count("SELECT count(*) AS n FROM project.project WHERE id = 108")).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM project.project WHERE po_amount IS NOT NULL OR po_number IS NOT NULL",
      ),
    ).toBe(0);

    // Phases: ids kept, sub-phase flattened, duplicate name made unique, ordered by WBS number (2 before 10).
    const phases = (
      await target.query<{
        id: string;
        name: string;
        sort_order: number;
        bill_separately: boolean;
        billing_method: string | null;
      }>(
        "SELECT id, name, sort_order, bill_separately, billing_method FROM project.phase WHERE project_id = 100 ORDER BY sort_order",
      )
    ).rows;
    expect(phases.map((p) => [Number(p.id), p.name, p.sort_order])).toEqual([
      [1000, "Rough-in", 10],
      [1002, "Rough-in (1.1)", 20],
      [1001, "Trim", 30],
      [1003, "Commissioning", 40],
    ]);
    expect(phases.find((p) => Number(p.id) === 1001)).toMatchObject({
      bill_separately: true,
      billing_method: "fixed_fee",
    });
    expect(phases.find((p) => Number(p.id) === 1000)?.billing_method).toBeNull(); // only separate phases carry a method
    expect(
      (await target.query("SELECT scheduled_end FROM project.phase WHERE id = 1005")).rows[0]
        .scheduled_end,
    ).toBeNull();

    // What a person has to finish by hand is listed, not hidden.
    const problems = report.summary().map((x) => `${x.entity}: ${x.problem}`);
    expect(problems).toContain("opportunities: negative total sales; amount left empty");
    expect(problems).toContain("opportunities: open status in the Dead stage; imported as lost");
    expect(problems).toContain("opportunities: sales rep was not imported; no owner set");
    expect(problems).toContain("projects: no billing method; set to actual rates");
    expect(problems).toContain(
      'projects: project type was the "MUST CHANGE" placeholder; left empty',
    );
    expect(problems).toContain(
      "phases: sub-phase: hierarchy flattened into the project's phase list",
    );
    const exc = report.exceptions.filter(
      (e) => e.entity === "projects" && /fee is not in the warehouse/.test(e.problem),
    );
    expect(exc.map((e) => e.sourceId).sort()).toEqual([100, 103, 104]);

    // Numbering continues past the CW ids.
    const nextProject = await target.query<{ id: string }>(
      `INSERT INTO project.project (company_id, name)
       SELECT id, 'native' FROM crm.company WHERE legacy_cw_company_id = 10 RETURNING id`,
    );
    expect(Number(nextProject.rows[0]?.id)).toBe(109);
  });

  it("imports agreements and additions, pricing per month, ending lines with their agreement", async () => {
    const { report } = await run();
    expect(report.counts["agreements"]).toMatchObject({ read: 6, written: 5, skipped: 1 });
    expect(report.counts["agreement additions"]).toMatchObject({ read: 7, written: 4, skipped: 3 });
    const ag = async (id: number) =>
      (
        await target.query(
          `SELECT a.*, t.name AS type FROM billing.agreement a JOIN billing.agreement_type t ON t.id = a.type_id WHERE a.id = $1`,
          [id],
        )
      ).rows[0];
    const d = (v: unknown) => (v instanceof Date ? v.toLocaleDateString("en-CA") : v);
    const a300 = await ag(300);
    expect(a300).toMatchObject({
      type: "Alarm Monitoring - Quarterly",
      bill_cycle: "quarterly",
      cancelled_date: null,
    });
    expect(String(a300.bill_to_company_id)).toBe(String(a300.company_id));
    const a301 = await ag(301);
    expect(d(a301.cancelled_date)).toBe("2025-06-30");
    expect(a301.cancel_reason).toBe("Moved");
    const a303 = await ag(303);
    expect(a303).toMatchObject({ bill_cycle: "monthly" });
    expect(d(a303.start_date)).toBe("2025-03-01"); // bill start used
    // The sync date is not a cancel date: a line's cancel date, else the start date, stands in.
    expect(d((await ag(304)).cancelled_date)).toBe("2025-04-15");
    expect(d((await ag(305)).cancelled_date)).toBe("2025-02-01");
    expect(await ag(302)).toBeUndefined();
    const ad = async (id: number) =>
      (await target.query("SELECT * FROM billing.agreement_addition WHERE id = $1", [id])).rows[0];
    const a400 = await ad(400);
    expect(Number(a400.unit_price)).toBe(40); // 120 per quarter
    expect(Number(a400.unit_cost)).toBe(10);
    expect(Number(a400.quantity)).toBe(2);
    expect(a400.effective_to).toBeNull();
    const a401 = await ad(401);
    expect(a401.description).toBe("JFI-M");
    expect(a401.prorate).toBe(true);
    expect(d(a401.effective_to)).toBe("2025-06-30"); // ends with its cancelled agreement
    expect(d((await ad(404)).effective_to)).toBe("2025-09-09"); // Inactive: last update
    for (const id of [402, 403, 405]) expect(await ad(id)).toBeUndefined();
    // A changed source price flows through on a re-run (the history guard is lifted for the import only).
    await srcAdmin.query(
      "UPDATE production.agreement_additions SET unit_price = 150 WHERE id = 400",
    );
    await run();
    expect(Number((await ad(400)).unit_price)).toBe(50);
    await expect(
      target.query("UPDATE billing.agreement_addition SET unit_price = 1 WHERE id = 400"),
    ).rejects.toThrow(/not edited in place/);
  });

  it("imports project tickets as tickets on a project board and re-points their time entries", async () => {
    const { report } = await run();
    expect(report.counts["project tickets"]).toMatchObject({ read: 4, written: 2, skipped: 2 });
    const t = async (id: number) =>
      (
        await target.query(
          `SELECT t.*, b.name AS board, s.name AS status, s.is_closed
             FROM service.ticket t JOIN service.board b ON b.id = t.board_id
             JOIN service.board_status s ON s.id = t.status_id WHERE t.id = $1`,
          [id],
        )
      ).rows[0];
    expect(await t(7001)).toMatchObject({
      board: "Project Tickets",
      status: "New",
      is_closed: false,
      project_id: "100",
      phase_id: null,
      summary: "Pull cable to MDF",
    });
    expect(Number((await t(7001)).budget_hours)).toBe(8);
    expect((await t(7001)).closed_at).toBeNull();
    // No entered date in the mirror: last updated (Indianapolis local, EST in January) stands in.
    expect(new Date((await t(7001)).entered_at).toISOString()).toBe("2026-01-08T14:00:00.000Z");
    expect(await t(7002)).toMatchObject({ status: "*CLOSED", is_closed: true });
    expect((await t(7002)).closed_at).not.toBeNull();
    expect(await t(7003)).toBeUndefined(); // project not imported
    expect(await t(7004)).toBeUndefined(); // no summary
    expect(
      await count(
        "SELECT count(*) AS n FROM service.board_status WHERE is_default AND board_id = (SELECT id FROM service.board WHERE name = 'Project Tickets')",
      ),
    ).toBe(1);
    // Time charged to the project ticket now charges the ticket itself.
    const te = (
      await target.query(
        "SELECT charge_type, ticket_id, project_ticket_id FROM timekeeping.time_entry WHERE legacy_cw_time_entry_id = 905",
      )
    ).rows[0];
    expect(te).toMatchObject({ charge_type: "service_ticket", project_ticket_id: null });
    expect(Number(te.ticket_id)).toBe(7001);
  });

  it("sales and project import is idempotent and follows source changes", async () => {
    const snapshot = async () => ({
      opps: await count("SELECT count(*) AS n FROM sales.opportunity"),
      stages: await count("SELECT count(*) AS n FROM sales.stage"),
      projects: await count(
        "SELECT count(*) AS n FROM project.project WHERE legacy_cw_project_id IS NOT NULL",
      ),
      phases: await count("SELECT count(*) AS n FROM project.phase"),
    });
    const before = await snapshot();
    await srcAdmin.query("UPDATE production.opportunities SET status_name = 'Won' WHERE id = 1");
    await srcAdmin.query(
      "UPDATE production.projects SET status = '8 - Closed', actual_end = '2026-02-02' WHERE id = 100",
    );
    await run();
    expect(await snapshot()).toEqual(before);
    const o = (
      await target.query(
        "SELECT s.is_won FROM sales.opportunity o JOIN sales.stage s ON s.id = o.stage_id WHERE o.id = 1",
      )
    ).rows[0];
    expect(o.is_won).toBe(true);
    expect(
      (await target.query("SELECT status FROM project.project WHERE id = 100")).rows[0].status,
    ).toBe("closed");
  });

  it("is idempotent: a second run changes nothing and creates no duplicates", async () => {
    const before = {
      tickets: await count(
        "SELECT count(*) AS n FROM service.ticket WHERE legacy_cw_ticket_id IS NOT NULL",
      ),
      time: await count("SELECT count(*) AS n FROM timekeeping.time_entry"),
      companies: await count("SELECT count(*) AS n FROM crm.company"),
      members: await count("SELECT count(*) AS n FROM iam.member"),
      statuses: await count("SELECT count(*) AS n FROM crm.company_status"),
    };
    await run();
    expect({
      tickets: await count(
        "SELECT count(*) AS n FROM service.ticket WHERE legacy_cw_ticket_id IS NOT NULL",
      ),
      time: await count("SELECT count(*) AS n FROM timekeeping.time_entry"),
      companies: await count("SELECT count(*) AS n FROM crm.company"),
      members: await count("SELECT count(*) AS n FROM iam.member"),
      statuses: await count("SELECT count(*) AS n FROM crm.company_status"),
    }).toEqual(before);
  });

  it("picks up source changes on re-run (nightly refresh)", async () => {
    await srcAdmin.query(
      "UPDATE production.service_tickets SET summary = 'Door latch repaired' WHERE id = 500",
    );
    await run();
    const r = await target.query("SELECT summary FROM service.ticket WHERE id = 500");
    expect(r.rows[0].summary).toBe("Door latch repaired");
  });

  it("never writes to production, and refuses a mismatched environment", async () => {
    await expect(run({ appEnv: "production" })).rejects.toThrow(/never writes to "production"/);
    await expect(run({ appEnv: "development" })).rejects.toThrow(/marked "shadow"/);
  });

  it("opens the source read-only", async () => {
    await expect(source.query("CREATE TABLE production.nope (a int)")).rejects.toMatchObject({
      code: "25006",
    });
    await expect(source.query("DELETE FROM production.members")).rejects.toMatchObject({
      code: "25006",
    });
  });
});
