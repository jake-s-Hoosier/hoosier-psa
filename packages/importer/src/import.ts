import { type EnvironmentName, assertSafeTarget, checkWriteAccess, readMarker } from "@hoosier/db";
import { phoneExtension, toE164 } from "@hoosier/shared";
import type pg from "pg";
import { BILLING_METHODS, clean, num } from "./mappings.js";
import { ImportReport } from "./report.js";
import { importSalesAndProjects } from "./sales-projects.js";

/** Environments the importer may write to. Production is populated only by the cutover procedure (M6). */
export const IMPORT_TARGETS: readonly EnvironmentName[] = ["development", "test", "uat", "shadow"];

const OPERATING_TZ = "America/Indiana/Indianapolis";

export interface ImportOptions {
  source: pg.Pool;
  target: pg.Pool;
  targetUrl: string;
  appEnv: EnvironmentName;
  /** Run everything, report, then roll back so nothing is written. */
  dryRun: boolean;
}

export interface ImportResult {
  report: ImportReport;
  dryRun: boolean;
  reconciliation: Reconciliation;
}

export interface Reconciliation {
  tickets: { source: number; target: number };
  timeEntries: { source: number; target: number };
  timeActualHours: { source: number; target: number };
  opportunities: { source: number; target: number };
  projects: { source: number; target: number };
  phases: { source: number; target: number };
}

const BILLABLE: Record<string, string> = {
  Billable: "billable",
  DoNotBill: "do_not_bill",
  NoCharge: "no_charge",
};

/** "Priority 2 - High" sorts as 2; anything else sorts after the numbered ones. */
export function prioritySortOrder(name: string): number {
  const m = /priority\s+(\d+)/i.exec(name);
  return m ? Number(m[1]) : 9;
}

export async function runImport(opts: ImportOptions): Promise<ImportResult> {
  const { source, target, targetUrl, appEnv, dryRun } = opts;

  // Safety gate: the same rules as docs/12, plus "never production".
  assertSafeTarget(targetUrl);
  if (!IMPORT_TARGETS.includes(appEnv)) {
    throw new Error(
      `The importer never writes to "${appEnv}". Production is loaded only by the cutover procedure.`,
    );
  }
  const marker = await readMarker(target);
  const decision = checkWriteAccess({ appEnv, marker, actor: "importer" });
  if (!decision.allowed) throw new Error(`Import refused: ${decision.reason}`);

  const report = new ImportReport();
  const client = await target.connect();
  try {
    await client.query("BEGIN");
    // One advisory lock so two imports never interleave.
    const lock = await client.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_xact_lock(7428002) AS ok",
    );
    if (!lock.rows[0]?.ok) throw new Error("Another import is running");
    await client.query("SELECT set_config('app.member_id', '', true)");

    const members = await importMembers(source, client, report);
    const companies = await importCompanies(source, client, report);
    await importWorkCatalog(source, client, report);
    const sites = await importSites(source, client, report, companies);
    const contacts = await importContacts(source, client, report, companies, sites);
    await importCompanyDefaults(source, client, report, companies, sites, contacts);
    const lookups = await importTicketLookups(source, client, report);
    const tickets = await importTickets(source, client, report, {
      members,
      companies,
      lookups,
      contacts,
    });
    await importTicketNotes(source, client, report, { members, tickets });
    await importTimeEntries(source, client, report, { members, companies });
    await importSalesAndProjects(source, client, report, { members, companies, sites, contacts });
    await resetSequences(source, client);
    const reconciliation = await reconcile(source, client);

    await client.query(dryRun ? "ROLLBACK" : "COMMIT");
    return { report, dryRun, reconciliation };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

type Id = number;
interface Maps {
  members: Map<number, Id>;
  membersByIdentifier: Map<string, Id>;
  /** Lower-case "first last"; names shared by two members are left out. CW tickets carry the full name. */
  membersByName: Map<string, Id>;
}

async function importMembers(src: pg.Pool, db: pg.PoolClient, report: ImportReport): Promise<Maps> {
  const { rows } = await src.query<{
    id: number;
    identifier: string | null;
    first_name: string | null;
    last_name: string | null;
    inactive_flag: boolean | null;
    hourly_cost: string | null;
  }>(
    "SELECT id, identifier, first_name, last_name, inactive_flag, hourly_cost FROM production.members ORDER BY id",
  );
  const c = report.count("members");
  const members = new Map<number, Id>();
  const byIdentifier = new Map<string, Id>();
  const byName = new Map<string, Id>();
  const ambiguousNames = new Set<string>();
  for (const r of rows) {
    c.read += 1;
    const identifier = clean(r.identifier);
    if (!identifier) {
      c.skipped += 1;
      report.except("members", r.id, "member has no identifier");
      continue;
    }
    const email = `${identifier.toLowerCase().replace(/[^a-z0-9._-]/g, "")}@import.invalid`;
    const { rows: out } = await db.query<{ id: string }>(
      `INSERT INTO iam.member
         (identifier, first_name, last_name, email, is_active, hourly_cost, legacy_cw_member_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (legacy_cw_member_id) DO UPDATE
         SET identifier = EXCLUDED.identifier, first_name = EXCLUDED.first_name,
             last_name = EXCLUDED.last_name, is_active = EXCLUDED.is_active,
             hourly_cost = EXCLUDED.hourly_cost
       RETURNING id`,
      [
        identifier,
        clean(r.first_name) ?? identifier,
        clean(r.last_name) ?? "(unknown)",
        email,
        r.inactive_flag !== true,
        num(r.hourly_cost),
        r.id,
      ],
    );
    const id = Number(out[0]?.id);
    members.set(r.id, id);
    byIdentifier.set(identifier.toLowerCase(), id);
    const fullName = `${clean(r.first_name) ?? ""} ${clean(r.last_name) ?? ""}`
      .trim()
      .toLowerCase();
    // API/integration members keep the person's whole name in first_name and have no last name;
    // they must not shadow the real person, so only members with a last name are name-matched.
    if (fullName && clean(r.last_name)) {
      if (byName.has(fullName)) ambiguousNames.add(fullName);
      byName.set(fullName, id);
    }
    c.written += 1;
  }
  report.except(
    "members",
    "*",
    "placeholder emails (@import.invalid) assigned; an administrator sets real emails",
  );
  for (const n of ambiguousNames) byName.delete(n);
  return { members, membersByIdentifier: byIdentifier, membersByName: byName };
}

async function importCompanies(
  src: pg.Pool,
  db: pg.PoolClient,
  report: ImportReport,
): Promise<Map<number, Id>> {
  const { rows } = await src.query<{
    id: number;
    name: string | null;
    identifier: string | null;
    phone_number: string | null;
    fax_number: string | null;
    website: string | null;
    territory_name: string | null;
    account_number: string | null;
    date_acquired: string | null;
    annual_revenue: string | null;
    number_of_employees: number | null;
    status_name: string | null;
    lead_flag: boolean | null;
    is_vendor_flag: boolean | null;
    deleted_flag: boolean | null;
    lead_source: string | null;
  }>(
    `SELECT id, name, identifier, phone_number, fax_number, website, territory_name, account_number,
            date_acquired::text AS date_acquired, annual_revenue, number_of_employees, status_name,
            lead_flag, is_vendor_flag, deleted_flag, lead_source
       FROM production.companies ORDER BY id`,
  );
  const c = report.count("companies");
  const map = new Map<number, Id>();
  const statusIds = new Map<string, Id>();
  const territoryIds = new Map<string, Id>();
  const usedIdentifiers = new Set<string>();

  const statusId = async (name: string): Promise<Id> => {
    const cached = statusIds.get(name.toLowerCase());
    if (cached) return cached;
    const { rows: r } = await db.query<{ id: string }>(
      `INSERT INTO crm.company_status (name) VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [name],
    );
    const id = Number(r[0]?.id);
    statusIds.set(name.toLowerCase(), id);
    return id;
  };
  const territoryId = async (name: string): Promise<Id> => {
    const cached = territoryIds.get(name.toLowerCase());
    if (cached) return cached;
    const { rows: r } = await db.query<{ id: string }>(
      `INSERT INTO crm.territory (name) VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [name],
    );
    const id = Number(r[0]?.id);
    territoryIds.set(name.toLowerCase(), id);
    return id;
  };

  for (const r of rows) {
    c.read += 1;
    const name = clean(r.name);
    if (!name) {
      c.skipped += 1;
      report.except("companies", r.id, "company has no name");
      continue;
    }
    let identifier = clean(r.identifier) ?? `CW-${r.id}`;
    if (usedIdentifiers.has(identifier.toLowerCase())) {
      report.except("companies", r.id, `duplicate identifier "${identifier}"; renamed CW-${r.id}`);
      identifier = `CW-${r.id}`;
    }
    usedIdentifiers.add(identifier.toLowerCase());
    let status = clean(r.status_name);
    if (!status) {
      status = "Unknown";
      report.except("companies", r.id, "no status in CW; set to Unknown");
    }
    const territory = clean(r.territory_name);
    const { rows: out } = await db.query<{ id: string }>(
      `INSERT INTO crm.company
         (identifier, name, status_id, territory_id, account_number, phone, fax, website,
          date_acquired, annual_revenue, employee_count, lead_source, is_lead, is_vendor,
          deleted_at, legacy_cw_company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,$11,$12,$13,$14,
               CASE WHEN $15::boolean THEN now() END, $16)
       ON CONFLICT (legacy_cw_company_id) DO UPDATE
         SET identifier = EXCLUDED.identifier, name = EXCLUDED.name, status_id = EXCLUDED.status_id,
             territory_id = EXCLUDED.territory_id, account_number = EXCLUDED.account_number,
             phone = EXCLUDED.phone, fax = EXCLUDED.fax, website = EXCLUDED.website,
             date_acquired = EXCLUDED.date_acquired, annual_revenue = EXCLUDED.annual_revenue,
             employee_count = EXCLUDED.employee_count, lead_source = EXCLUDED.lead_source,
             is_lead = EXCLUDED.is_lead, is_vendor = EXCLUDED.is_vendor,
             deleted_at = CASE WHEN $15::boolean THEN COALESCE(crm.company.deleted_at, now()) END
       RETURNING id`,
      [
        identifier,
        name,
        await statusId(status),
        territory ? await territoryId(territory) : null,
        clean(r.account_number),
        clean(r.phone_number),
        clean(r.fax_number),
        clean(r.website),
        r.date_acquired,
        num(r.annual_revenue),
        r.number_of_employees !== null && r.number_of_employees >= 0 ? r.number_of_employees : null,
        clean(r.lead_source),
        r.lead_flag === true,
        r.is_vendor_flag === true,
        r.deleted_flag === true,
        r.id,
      ],
    );
    map.set(r.id, Number(out[0]?.id));
    c.written += 1;
  }
  return map;
}

interface TicketLookups {
  boards: Map<number, Id>;
  statuses: Map<number, Id>;
  priorities: Map<number, Id>;
  types: Map<number, Id>;
  sources: Map<number, Id>;
}

/** Work roles and work types (rates, minimum/maximum hours, billing flags) from the CW catalog tables. */
async function importWorkCatalog(
  src: pg.Pool,
  db: pg.PoolClient,
  report: ImportReport,
): Promise<void> {
  const roles = await src.query<{
    id: number;
    name: string | null;
    hourly_rate: string | null;
    inactive_flag: boolean | null;
  }>("SELECT id, name, hourly_rate, inactive_flag FROM production.work_roles ORDER BY id");
  const rc = report.count("work roles");
  for (const r of roles.rows) {
    rc.read += 1;
    const name = clean(r.name);
    if (!name) {
      rc.skipped += 1;
      report.except("work roles", r.id, "skipped: no name");
      continue;
    }
    await db.query(
      `INSERT INTO catalog.work_role (name, hourly_rate, is_active, legacy_cw_work_role_id)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (legacy_cw_work_role_id) DO UPDATE
         SET name = EXCLUDED.name, hourly_rate = EXCLUDED.hourly_rate, is_active = EXCLUDED.is_active`,
      [name, Math.max(0, num(r.hourly_rate) ?? 0), !r.inactive_flag, r.id],
    );
    rc.written += 1;
  }

  const types = await src.query<{
    id: number;
    name: string | null;
    bill_time: string | null;
    rate_type: string | null;
    rate: string | null;
    hours_min: string | null;
    hours_max: string | null;
    round_billing_hours_to: string | null;
    inactive_flag: boolean | null;
  }>(
    `SELECT id, name, bill_time, rate_type, rate, hours_min, hours_max, round_billing_hours_to, inactive_flag
       FROM production.work_types ORDER BY id`,
  );
  const tc = report.count("work types");
  for (const t of types.rows) {
    tc.read += 1;
    const name = clean(t.name);
    if (!name) {
      tc.skipped += 1;
      report.except("work types", t.id, "skipped: no name");
      continue;
    }
    const rate = num(t.rate) ?? 0;
    const rateType =
      t.rate_type === "Custom"
        ? "custom"
        : t.rate_type === "AdjAmount"
          ? "adjustment"
          : "multiplier";
    const billTime =
      t.bill_time === "DoNotBill"
        ? "do_not_bill"
        : t.bill_time === "NoCharge"
          ? "no_charge"
          : "billable";
    let multiplier = 1;
    if (rateType === "multiplier") {
      if (rate > 0) multiplier = rate;
      else if (billTime === "billable")
        report.except("work types", t.id, "billable multiplier of 0; treated as 1");
    }
    const min = Math.max(0, num(t.hours_min) ?? 0);
    let max = Math.max(0, num(t.hours_max) ?? 0);
    if (max > 0 && min > max) {
      report.except("work types", t.id, "minimum hours above maximum; maximum dropped");
      max = 0;
    }
    const round = num(t.round_billing_hours_to);
    await db.query(
      `INSERT INTO catalog.work_type
         (name, rate_multiplier, rate_type, custom_rate, rate_adjustment, bill_time,
          hours_min, hours_max, round_billing_hours_to, is_active, legacy_cw_work_type_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (legacy_cw_work_type_id) DO UPDATE
         SET name = EXCLUDED.name, rate_multiplier = EXCLUDED.rate_multiplier, rate_type = EXCLUDED.rate_type,
             custom_rate = EXCLUDED.custom_rate, rate_adjustment = EXCLUDED.rate_adjustment,
             bill_time = EXCLUDED.bill_time, hours_min = EXCLUDED.hours_min, hours_max = EXCLUDED.hours_max,
             round_billing_hours_to = EXCLUDED.round_billing_hours_to, is_active = EXCLUDED.is_active`,
      [
        name,
        multiplier,
        rateType,
        rateType === "custom" ? Math.max(0, rate) : null,
        rateType === "adjustment" ? rate : null,
        billTime,
        min,
        max,
        round !== null && round > 0 ? round : null,
        !t.inactive_flag,
        t.id,
      ],
    );
    tc.written += 1;
  }
}

/** "street, city, ST 46060" -> parts. Anything that does not match keeps the whole text in line 1. */
export function parseAddress(raw: string): {
  line1: string;
  city: string | null;
  state: string | null;
  postal: string | null;
} {
  const text = raw.replace(/\s+/g, " ").trim();
  const m = /^(.*),\s*([^,]+?),\s*([A-Za-z]{2})\s+(\d{5})(?:-\d{4})?$/.exec(text);
  if (!m) return { line1: text, city: null, state: null, postal: null };
  return {
    line1: (m[1] as string).trim(),
    city: (m[2] as string).trim(),
    state: (m[3] as string).toUpperCase(),
    postal: m[4] as string,
  };
}

interface SiteIndex {
  byLegacyId: Map<number, Id>;
}

async function importSites(
  src: pg.Pool,
  db: pg.PoolClient,
  report: ImportReport,
  companies: Map<number, Id>,
): Promise<SiteIndex> {
  const { rows } = await src.query<{
    site_id: number;
    company_id: number | null;
    site_name: string | null;
    address: string | null;
  }>(
    "SELECT site_id, company_id, site_name, address FROM production.site_addresses ORDER BY site_id",
  );
  const c = report.count("sites");
  const index: SiteIndex = { byLegacyId: new Map() };
  const used = new Set<string>();
  for (const r of rows) {
    c.read += 1;
    const companyId = r.company_id === null ? undefined : companies.get(r.company_id);
    if (!companyId) {
      c.skipped += 1;
      report.except("sites", r.site_id, "skipped: company not imported");
      continue;
    }
    let name = clean(r.site_name) ?? `Site ${r.site_id}`;
    if (used.has(`${companyId}|${name.toLowerCase()}`)) {
      report.except("sites", r.site_id, `duplicate site name "${name}" for company; id appended`);
      name = `${name} (${r.site_id})`;
    }
    used.add(`${companyId}|${name.toLowerCase()}`);
    const a = parseAddress(clean(r.address) ?? "");
    if (!a.city && a.line1)
      report.tally("sites", "address not in street, city, ST zip form; kept in line 1");
    const { rows: out } = await db.query<{ id: string }>(
      `INSERT INTO crm.site (company_id, name, address_line1, city, state, postal_code, legacy_cw_site_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (legacy_cw_site_id) DO UPDATE
         SET company_id = EXCLUDED.company_id, name = EXCLUDED.name, address_line1 = EXCLUDED.address_line1,
             city = EXCLUDED.city, state = EXCLUDED.state, postal_code = EXCLUDED.postal_code
       RETURNING id`,
      [companyId, name, a.line1 || null, a.city, a.state, a.postal, r.site_id],
    );
    index.byLegacyId.set(r.site_id, Number(out[0]?.id));
    c.written += 1;
  }
  return index;
}

interface ContactIndex {
  byLegacyId: Map<number, Id>;
  /** key: `${cwCompanyId}|${lower full name}`; "ambiguous" when two contacts share a name. */
  byName: Map<string, Id | "ambiguous">;
}

const PHONE_KINDS: Record<string, string> = {
  Direct: "direct",
  Home: "home",
  Mobile: "mobile",
  "Personal Cellphone": "mobile",
  "Work Cellphone": "mobile",
  "Office Reception": "office",
  "Work Landline": "office",
};

async function importContacts(
  src: pg.Pool,
  db: pg.PoolClient,
  report: ImportReport,
  companies: Map<number, Id>,
  sites: SiteIndex,
): Promise<ContactIndex> {
  const { rows } = await src.query<{
    id: number;
    first_name: string | null;
    last_name: string | null;
    full_name: string | null;
    company_id: number | null;
    site_id: number | null;
    title: string | null;
    department_name: string | null;
    email: string | null;
    email2: string | null;
    email3: string | null;
    default_email: string | null;
    inactive_flag: boolean | null;
    do_not_solicit_flag: boolean | null;
    unsubscribe_flag: boolean | null;
    phone_number: string | null;
    phone_ext: string | null;
  }>(
    `SELECT id, first_name, last_name, full_name, company_id, site_id, title, department_name,
            email, email2, email3, default_email, inactive_flag, do_not_solicit_flag, unsubscribe_flag,
            phone_number, phone_ext
       FROM production.contacts ORDER BY id`,
  );
  const phones = await src.query<{
    contact_id: number;
    type: string | null;
    raw: string | null;
    phone10: string | null;
    default_flag: boolean | null;
  }>(
    "SELECT contact_id, type, raw, phone10, default_flag FROM production.contact_phones ORDER BY contact_id, raw",
  );
  const phonesBy = new Map<number, typeof phones.rows>();
  for (const p of phones.rows) {
    const list = phonesBy.get(p.contact_id) ?? [];
    list.push(p);
    phonesBy.set(p.contact_id, list);
  }

  const c = report.count("contacts");
  const ch = report.count("contact channels");
  const index: ContactIndex = { byLegacyId: new Map(), byName: new Map() };
  for (const r of rows) {
    c.read += 1;
    const companyId = r.company_id === null ? undefined : companies.get(r.company_id);
    if (!companyId) {
      c.skipped += 1;
      report.tally("contacts", "skipped: no company or company not imported");
      continue;
    }
    const fullName =
      clean(r.full_name) ?? [clean(r.first_name), clean(r.last_name)].filter(Boolean).join(" ");
    const first = clean(r.first_name) ?? fullName;
    if (!first) {
      c.skipped += 1;
      report.except("contacts", r.id, "skipped: no name");
      continue;
    }
    const { rows: out } = await db.query<{ id: string }>(
      `INSERT INTO crm.contact
         (company_id, site_id, first_name, last_name, title, department, is_inactive, is_marketing_opt_out,
          legacy_cw_contact_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (legacy_cw_contact_id) DO UPDATE
         SET company_id = EXCLUDED.company_id, site_id = EXCLUDED.site_id, first_name = EXCLUDED.first_name,
             last_name = EXCLUDED.last_name, title = EXCLUDED.title, department = EXCLUDED.department,
             is_inactive = EXCLUDED.is_inactive, is_marketing_opt_out = EXCLUDED.is_marketing_opt_out
       RETURNING id`,
      [
        companyId,
        r.site_id === null ? null : (sites.byLegacyId.get(r.site_id) ?? null),
        first,
        clean(r.last_name),
        clean(r.title),
        clean(r.department_name),
        !!r.inactive_flag,
        !!(r.do_not_solicit_flag || r.unsubscribe_flag),
        r.id,
      ],
    );
    const contactId = Number(out[0]?.id);
    index.byLegacyId.set(r.id, contactId);
    c.written += 1;
    const nameKey = `${r.company_id}|${fullName.toLowerCase()}`;
    index.byName.set(nameKey, index.byName.has(nameKey) ? "ambiguous" : contactId);

    // Channels. Re-runs replace the contact's channels so the import stays idempotent.
    await db.query("DELETE FROM crm.contact_channel WHERE contact_id = $1", [contactId]);
    const seen = new Set<string>();
    let defaultEmailSet = false;
    let defaultPhoneSet = false;
    const add = async (
      kind: string,
      value: string,
      normalized: string,
      ext: string | null,
      isDefault: boolean,
    ) => {
      const key = `${kind}|${normalized}`;
      if (seen.has(key)) return;
      seen.add(key);
      const makeDefault = isDefault && (kind === "email" ? !defaultEmailSet : !defaultPhoneSet);
      if (makeDefault) {
        if (kind === "email") defaultEmailSet = true;
        else defaultPhoneSet = true;
      }
      await db.query(
        `INSERT INTO crm.contact_channel (contact_id, kind, value, value_normalized, extension, is_default)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [contactId, kind, value, normalized, ext, makeDefault],
      );
      ch.written += 1;
    };
    const defaultEmail = clean(r.default_email)?.toLowerCase();
    const emails = [r.email, r.email2, r.email3].map(clean).filter((e): e is string => !!e);
    for (const e of emails) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
        report.tally("contact channels", "invalid email skipped");
        continue;
      }
      ch.read += 1;
      await add(
        "email",
        e,
        e.toLowerCase(),
        null,
        defaultEmail ? e.toLowerCase() === defaultEmail : e === emails[0],
      );
    }
    const plist = phonesBy.get(r.id) ?? [];
    if (plist.length === 0 && clean(r.phone_number)) {
      plist.push({
        contact_id: r.id,
        type: "Direct",
        raw: r.phone_number,
        phone10: null,
        default_flag: true,
      });
    }
    for (const p of plist) {
      ch.read += 1;
      const raw = clean(p.raw) ?? clean(p.phone10);
      const e164 = toE164(p.phone10 ? `+1${p.phone10}` : raw);
      if (!raw || !e164) {
        report.tally("contact channels", "phone not a valid number; skipped");
        continue;
      }
      const kind = PHONE_KINDS[p.type ?? ""] ?? "other";
      await add(kind, raw, e164, phoneExtension(raw) ?? clean(r.phone_ext), !!p.default_flag);
    }
  }
  return index;
}

/** Company default/billing contacts and default service/billing sites, once those exist. */
async function importCompanyDefaults(
  src: pg.Pool,
  db: pg.PoolClient,
  report: ImportReport,
  companies: Map<number, Id>,
  sites: SiteIndex,
  contacts: ContactIndex,
): Promise<void> {
  const { rows } = await src.query<{
    id: number;
    default_contact_id: number | null;
    billing_contact_id: number | null;
    site_id: number | null;
    billing_site_id: number | null;
  }>(
    "SELECT id, default_contact_id, billing_contact_id, site_id, billing_site_id FROM production.companies",
  );
  const c = report.count("company defaults");
  const pick = <T>(map: Map<number, T>, key: number | null): T | null =>
    key === null ? null : (map.get(key) ?? null);
  for (const r of rows) {
    const companyId = companies.get(r.id);
    if (!companyId) continue;
    c.read += 1;
    const def = pick(contacts.byLegacyId, r.default_contact_id);
    const bill = pick(contacts.byLegacyId, r.billing_contact_id);
    const svcSite = pick(sites.byLegacyId, r.site_id);
    const billSite = pick(sites.byLegacyId, r.billing_site_id);
    if (def === null && bill === null && svcSite === null && billSite === null) continue;
    await db.query(
      `UPDATE crm.company SET default_contact_id = COALESCE($2, default_contact_id),
              billing_contact_id = COALESCE($3, billing_contact_id) WHERE id = $1`,
      [companyId, def, bill],
    );
    if (svcSite !== null) {
      await db.query(
        "UPDATE crm.site SET is_default_service = (id = $2) WHERE company_id = $1 AND (is_default_service OR id = $2)",
        [companyId, svcSite],
      );
    }
    if (billSite !== null) {
      await db.query(
        "UPDATE crm.site SET is_billing = (id = $2) WHERE company_id = $1 AND (is_billing OR id = $2)",
        [companyId, billSite],
      );
    }
    c.written += 1;
  }
}

/** Ticket notes. Kind follows CW's flags: description > resolution > internal > discussion. */
async function importTicketNotes(
  src: pg.Pool,
  db: pg.PoolClient,
  report: ImportReport,
  ctx: { members: Maps; tickets: Set<number> },
): Promise<void> {
  const { rows } = await src.query<{
    note_id: number;
    ticket_id: number;
    note_text: string | null;
    detail_description_flag: boolean | null;
    resolution_flag: boolean | null;
    internal_analysis_flag: boolean | null;
    internal_flag: boolean | null;
    member_identifier: string | null;
    date_created: Date | null;
  }>(
    `SELECT note_id, ticket_id, note_text, detail_description_flag, resolution_flag, internal_analysis_flag,
            internal_flag, member_identifier, date_created
       FROM production.service_ticket_notes ORDER BY note_id`,
  );
  const c = report.count("ticket notes");
  for (const r of rows) {
    c.read += 1;
    if (!ctx.tickets.has(r.ticket_id)) {
      c.skipped += 1;
      report.tally("ticket notes", "skipped: ticket not imported");
      continue;
    }
    const body = clean(r.note_text);
    if (!body) {
      c.skipped += 1;
      report.tally("ticket notes", "skipped: empty text");
      continue;
    }
    const kind = r.detail_description_flag
      ? "description"
      : r.resolution_flag
        ? "resolution"
        : r.internal_flag || r.internal_analysis_flag
          ? "internal"
          : "discussion";
    const key = clean(r.member_identifier)?.toLowerCase();
    const author = key ? (ctx.members.membersByIdentifier.get(key) ?? null) : null;
    if (key && author === null)
      report.tally("ticket notes", "author not matched to a member; left blank");
    await db.query(
      `INSERT INTO service.ticket_note (ticket_id, kind, body, author_member_id, created_at, legacy_cw_note_id)
       VALUES ($1,$2,$3,$4,COALESCE(($5::timestamp AT TIME ZONE '${OPERATING_TZ}'), now()),$6)
       ON CONFLICT (legacy_cw_note_id) DO UPDATE
         SET kind = EXCLUDED.kind, body = EXCLUDED.body, author_member_id = EXCLUDED.author_member_id,
             created_at = EXCLUDED.created_at`,
      [r.ticket_id, kind, body, author, r.date_created, r.note_id],
    );
    c.written += 1;
  }
}

/** Boards, statuses, priorities, types and sources are derived from what tickets actually use. */
async function importTicketLookups(
  src: pg.Pool,
  db: pg.PoolClient,
  report: ImportReport,
): Promise<TicketLookups> {
  const l: TicketLookups = {
    boards: new Map(),
    statuses: new Map(),
    priorities: new Map(),
    types: new Map(),
    sources: new Map(),
  };

  // Boards: the board table, plus any board a ticket refers to that is missing from it.
  const boards = await src.query<{ id: number; name: string }>(
    `SELECT id, name FROM production.boards WHERE name IS NOT NULL
     UNION
     SELECT DISTINCT board_id, board_name FROM production.service_tickets
      WHERE board_id IS NOT NULL AND board_name IS NOT NULL
        AND board_id NOT IN (SELECT id FROM production.boards)
     ORDER BY 1`,
  );
  for (const b of boards.rows) {
    report.count("boards").read += 1;
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO service.board (name, legacy_cw_board_id) VALUES ($1,$2)
       ON CONFLICT (legacy_cw_board_id) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [b.name, b.id],
    );
    l.boards.set(b.id, Number(rows[0]?.id));
    report.count("boards").written += 1;
  }

  // Priorities: CW's own table carries colour and order; fall back to ticket usage for the rest.
  const prios = await src.query<{
    id: number;
    name: string;
    color: string | null;
    sort_order: number | null;
  }>(
    `SELECT id, name, color, sort_order FROM production.priorities WHERE name IS NOT NULL
     UNION ALL
     SELECT DISTINCT priority_id, priority_name, NULL::text, NULL::int FROM production.service_tickets
      WHERE priority_id IS NOT NULL AND priority_name IS NOT NULL
        AND priority_id NOT IN (SELECT id FROM production.priorities)
     ORDER BY 1`,
  );
  for (const p of prios.rows) {
    report.count("priorities").read += 1;
    const color = p.color && /^#[0-9a-fA-F]{6}$/.test(p.color) ? p.color : "#6b7280";
    // A starter priority with the same name (seeded by migration 0005) is adopted, not duplicated.
    await db.query(
      `UPDATE service.priority SET legacy_cw_priority_id = $2
        WHERE name = $1 AND legacy_cw_priority_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM service.priority WHERE legacy_cw_priority_id = $2)`,
      [p.name, p.id],
    );
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO service.priority (name, sort_order, color, legacy_cw_priority_id) VALUES ($1,$2,$3,$4)
       ON CONFLICT (legacy_cw_priority_id) DO UPDATE
         SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order, color = EXCLUDED.color
       RETURNING id`,
      [p.name, p.sort_order ?? prioritySortOrder(p.name), color, p.id],
    );
    l.priorities.set(p.id, Number(rows[0]?.id));
    report.count("priorities").written += 1;
  }

  // Statuses: CW's board_statuses table is authoritative (closed flag, order, inactive). A few ticket
  // statuses no longer appear in it; those are derived from ticket usage and reported.
  const statuses = await src.query<{
    id: number;
    name: string;
    board_id: number;
    sort_order: number;
    closed: boolean;
    inactive: boolean;
  }>(
    `SELECT status_id AS id, status_name AS name, board_id, COALESCE(sort_order, status_id) AS sort_order,
            COALESCE(closed_status_flag, false) AS closed, COALESCE(inactive_flag, false) AS inactive
       FROM production.board_statuses WHERE status_name IS NOT NULL
     UNION ALL
     SELECT status_id, min(status_name), min(board_id), status_id,
            bool_and(COALESCE(closed_flag, false)), false
       FROM production.service_tickets
      WHERE status_id IS NOT NULL AND status_name IS NOT NULL AND board_id IS NOT NULL
        AND status_id NOT IN (SELECT status_id FROM production.board_statuses)
      GROUP BY status_id
     ORDER BY 1`,
  );
  const known = new Set(
    (
      await src.query<{ status_id: number }>("SELECT status_id FROM production.board_statuses")
    ).rows.map((r) => r.status_id),
  );
  const usedStatusNames = new Set<string>();
  for (const s of statuses.rows) {
    report.count("board statuses").read += 1;
    const boardId = l.boards.get(s.board_id);
    if (!boardId) {
      report.count("board statuses").skipped += 1;
      report.except("board statuses", s.id, "board not found");
      continue;
    }
    if (!known.has(s.id)) {
      report.except(
        "board statuses",
        s.id,
        "status missing from CW board_statuses; derived from tickets",
      );
    }
    // CW allows two statuses with the same name on a board; ours does not. The later one gets its id appended.
    let statusName = s.name;
    if (usedStatusNames.has(`${boardId}|${statusName.toLowerCase()}`)) {
      statusName = `${s.name} (${s.id})`;
      report.except(
        "board statuses",
        s.id,
        `duplicate name "${s.name}" on its board; renamed "${statusName}"`,
      );
    }
    usedStatusNames.add(`${boardId}|${statusName.toLowerCase()}`);
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO service.board_status (board_id, name, sort_order, is_closed, is_active, legacy_cw_status_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (legacy_cw_status_id) DO UPDATE
         SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order,
             is_closed = EXCLUDED.is_closed, is_active = EXCLUDED.is_active
       RETURNING id`,
      [boardId, statusName, s.sort_order, s.closed, !s.inactive, s.id],
    );
    l.statuses.set(s.id, Number(rows[0]?.id));
    report.count("board statuses").written += 1;
  }
  // CW has no "default status" in the mirror; every board needs one for native ticket creation.
  // Prefer an open status named "New", else the first open one. Reviewed in UAT.
  await db.query(
    `UPDATE service.board_status bs SET is_default = true
      WHERE bs.id = (
        SELECT s.id FROM service.board_status s
         WHERE s.board_id = bs.board_id AND NOT s.is_closed AND s.is_active
         ORDER BY (s.name ILIKE 'new%') DESC, s.sort_order, s.id LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM service.board_status d WHERE d.board_id = bs.board_id AND d.is_default)`,
  );
  report.except(
    "board statuses",
    "*",
    "default status per board was chosen by rule; review in UAT",
  );

  const types = await src.query<{ id: number; name: string; board_id: number }>(
    `SELECT type_id AS id, min(type_name) AS name, min(board_id) AS board_id
       FROM production.service_tickets WHERE type_id IS NOT NULL AND type_name IS NOT NULL AND board_id IS NOT NULL
      GROUP BY type_id ORDER BY 1`,
  );
  const usedTypeNames = new Set<string>();
  for (const t of types.rows) {
    report.count("ticket types").read += 1;
    const boardId = l.boards.get(t.board_id);
    if (!boardId) continue;
    let typeName = t.name;
    if (usedTypeNames.has(`${boardId}|${typeName.toLowerCase()}`)) {
      typeName = `${t.name} (${t.id})`;
      report.except(
        "ticket types",
        t.id,
        `duplicate name "${t.name}" on its board; renamed "${typeName}"`,
      );
    }
    usedTypeNames.add(`${boardId}|${typeName.toLowerCase()}`);
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO service.ticket_type (board_id, name, legacy_cw_type_id) VALUES ($1,$2,$3)
       ON CONFLICT (legacy_cw_type_id) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [boardId, typeName, t.id],
    );
    l.types.set(t.id, Number(rows[0]?.id));
    report.count("ticket types").written += 1;
  }

  const sources = await src.query<{ id: number; name: string }>(
    "SELECT DISTINCT source_id AS id, source_name AS name FROM production.service_tickets WHERE source_id IS NOT NULL AND source_name IS NOT NULL ORDER BY 1",
  );
  for (const s of sources.rows) {
    report.count("ticket sources").read += 1;
    // The starter "Email" source (migration 0011) is adopted when CW has a source of the same name.
    await db.query(
      `UPDATE service.ticket_source SET legacy_cw_source_id = $2
        WHERE name = $1 AND legacy_cw_source_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM service.ticket_source WHERE legacy_cw_source_id = $2)`,
      [s.name, s.id],
    );
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO service.ticket_source (name, legacy_cw_source_id) VALUES ($1,$2)
       ON CONFLICT (legacy_cw_source_id) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [s.name, s.id],
    );
    l.sources.set(s.id, Number(rows[0]?.id));
    report.count("ticket sources").written += 1;
  }
  return l;
}

async function importTickets(
  src: pg.Pool,
  db: pg.PoolClient,
  report: ImportReport,
  ctx: {
    members: Maps;
    companies: Map<number, Id>;
    lookups: TicketLookups;
    contacts: ContactIndex;
  },
): Promise<Set<number>> {
  const { rows } = await src.query<{
    id: number;
    summary: string | null;
    company_id: number | null;
    board_id: number | null;
    status_id: number | null;
    priority_id: number | null;
    type_id: number | null;
    source_id: number | null;
    assigned_to: string | null;
    contact_name: string | null;
    date_entered: Date | null;
    date_closed: Date | null;
    closed_flag: boolean | null;
    budget_hours: string | null;
    billing_method: string | null;
    customer_updated_flag: boolean | null;
    last_updated: Date | null;
  }>(
    `SELECT id, summary, company_id, board_id, status_id, priority_id, type_id, source_id, assigned_to, contact_name,
            date_entered, date_closed, closed_flag, budget_hours, billing_method,
            customer_updated_flag, last_updated
       FROM production.service_tickets ORDER BY id`,
  );
  const c = report.count("tickets");
  const { lookups, companies, members, contacts } = ctx;
  const imported = new Set<number>();
  for (const r of rows) {
    c.read += 1;
    const companyId = r.company_id === null ? undefined : companies.get(r.company_id);
    const boardId = r.board_id === null ? undefined : lookups.boards.get(r.board_id);
    const statusId = r.status_id === null ? undefined : lookups.statuses.get(r.status_id);
    const priorityId = r.priority_id === null ? undefined : lookups.priorities.get(r.priority_id);
    const summary = clean(r.summary);
    const missing = [
      !summary && "summary",
      !companyId && "company",
      !boardId && "board",
      !statusId && "status",
      !priorityId && "priority",
    ].filter(Boolean);
    if (missing.length > 0) {
      c.skipped += 1;
      report.except("tickets", r.id, `skipped: missing ${missing.join(", ")}`);
      continue;
    }

    let entered = r.date_entered;
    if (!entered) {
      entered = r.last_updated;
      report.except("tickets", r.id, "no entered date; used last updated");
    }
    let closed = r.closed_flag ? r.date_closed : null;
    if (closed && entered && closed < entered) {
      report.except("tickets", r.id, "closed before entered; closed date dropped");
      closed = null;
    }
    const assignedKey = clean(r.assigned_to)?.toLowerCase();
    const owner = assignedKey
      ? (members.membersByIdentifier.get(assignedKey) ?? members.membersByName.get(assignedKey))
      : undefined;
    if (assignedKey && !owner)
      report.except("tickets", r.id, `assignee "${r.assigned_to}" not matched to a member`);
    const method = BILLING_METHODS[r.billing_method ?? ""] ?? "actual_rates";
    let contactId: number | null = null;
    const contactName = clean(r.contact_name);
    if (contactName && r.company_id !== null) {
      const hit = contacts.byName.get(`${r.company_id}|${contactName.toLowerCase()}`);
      if (typeof hit === "number") contactId = hit;
      else if (hit === "ambiguous")
        report.tally("tickets", "contact name matches several contacts; not linked");
      else report.tally("tickets", "contact name not found for the company; not linked");
    }

    await db.query(
      `INSERT INTO service.ticket
         (id, summary, company_id, board_id, status_id, priority_id, type_id, source_id,
          owner_member_id, billing_method, budget_hours, entered_at, closed_at, legacy_cw_ticket_id,
          contact_id)
       OVERRIDING SYSTEM VALUE
       VALUES ($1::int,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
               ($12::timestamp AT TIME ZONE '${OPERATING_TZ}'),
               ($13::timestamp AT TIME ZONE '${OPERATING_TZ}'), $1::int, $14)
       ON CONFLICT (id) DO UPDATE
         SET summary = EXCLUDED.summary, company_id = EXCLUDED.company_id, board_id = EXCLUDED.board_id,
             status_id = EXCLUDED.status_id, priority_id = EXCLUDED.priority_id, type_id = EXCLUDED.type_id,
             source_id = EXCLUDED.source_id, owner_member_id = EXCLUDED.owner_member_id,
             billing_method = EXCLUDED.billing_method, budget_hours = EXCLUDED.budget_hours,
             entered_at = EXCLUDED.entered_at, closed_at = EXCLUDED.closed_at,
             contact_id = EXCLUDED.contact_id`,
      [
        r.id,
        (summary as string).slice(0, 500),
        companyId,
        boardId,
        statusId,
        priorityId,
        r.type_id === null ? null : (lookups.types.get(r.type_id) ?? null),
        r.source_id === null ? null : (lookups.sources.get(r.source_id) ?? null),
        owner ?? null,
        method,
        num(r.budget_hours),
        entered,
        closed,
        contactId,
      ],
    );
    imported.add(r.id);
    c.written += 1;
  }
  report.except(
    "tickets",
    "*",
    "per-ticket site and resources are not in the mirror; not imported",
  );
  return imported;
}

async function importTimeEntries(
  src: pg.Pool,
  db: pg.PoolClient,
  report: ImportReport,
  ctx: { members: Maps; companies: Map<number, Id> },
): Promise<void> {
  // The mirror has no work role or work type per entry, but ours requires them: use placeholders.
  const role = await db.query<{ id: string }>(
    `INSERT INTO catalog.work_role (name, hourly_rate) VALUES ('Imported (unknown role)', 0)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
  );
  const type = await db.query<{ id: string }>(
    `INSERT INTO catalog.work_type (name) VALUES ('Imported (unknown type)')
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
  );
  const roleId = Number(role.rows[0]?.id);
  const typeId = Number(type.rows[0]?.id);
  const costByMember = new Map<number, number | null>();
  const mc = await db.query<{ id: string; hourly_cost: string | null }>(
    "SELECT id, hourly_cost FROM iam.member",
  );
  for (const m of mc.rows) costByMember.set(Number(m.id), num(m.hourly_cost));

  const { rows } = await src.query<{
    id: number;
    company_id: number | null;
    charge_to_id: number | null;
    charge_to_type: string | null;
    member_id: number | null;
    time_start: Date | null;
    time_end: Date | null;
    hours_billed: string | null;
    actual_hours: string | null;
    billable_option: string | null;
    hourly_rate: string | null;
    notes: string | null;
    date_entered: string | null;
  }>(
    `SELECT id, company_id, charge_to_id, charge_to_type, member_id, time_start, time_end, hours_billed,
            actual_hours, billable_option, hourly_rate, notes, date_entered::text AS date_entered
       FROM production.time_entries ORDER BY id`,
  );
  const c = report.count("time entries");
  for (const r of rows) {
    c.read += 1;
    const memberId = r.member_id === null ? undefined : ctx.members.members.get(r.member_id);
    const companyId = r.company_id === null ? undefined : ctx.companies.get(r.company_id);
    const workDate =
      r.date_entered ?? (r.time_start ? r.time_start.toISOString().slice(0, 10) : null);
    if (!memberId || !companyId || !workDate || r.actual_hours === null) {
      c.skipped += 1;
      report.except(
        "time entries",
        r.id,
        `skipped: missing ${[!memberId && "member", !companyId && "company", !workDate && "date", r.actual_hours === null && "hours"].filter(Boolean).join(", ")}`,
      );
      continue;
    }

    let chargeType = "non_ticket";
    let ticketId: number | null = null;
    let projectTicketId: number | null = null;
    if (r.charge_to_type === "ServiceTicket" && r.charge_to_id !== null) {
      chargeType = "service_ticket";
      ticketId = r.charge_to_id;
    } else if (r.charge_to_type === "ProjectTicket" && r.charge_to_id !== null) {
      chargeType = "project_ticket";
      projectTicketId = r.charge_to_id;
    }
    let start = r.time_start;
    let end = r.time_end;
    if (start && end && end <= start) {
      report.except("time entries", r.id, "end not after start; times dropped, hours kept");
      start = null;
      end = null;
    }
    const billable = BILLABLE[r.billable_option ?? ""] ?? "billable";

    // A savepoint lets one bad row (e.g. a ticket that was skipped above) become an exception, not a failure.
    await db.query("SAVEPOINT te");
    try {
      await db.query(
        `INSERT INTO timekeeping.time_entry
           (id, member_id, company_id, charge_type, ticket_id, project_ticket_id, work_role_id, work_type_id,
            work_date, started_at, ended_at, actual_hours, billed_hours, billable, bill_rate, cost_rate,
            notes, status, legacy_cw_time_entry_id)
         OVERRIDING SYSTEM VALUE
         VALUES ($1::int,$2,$3,$4,$5,$6,$7,$8,$9::date,
                 ($10::timestamp AT TIME ZONE '${OPERATING_TZ}'), ($11::timestamp AT TIME ZONE '${OPERATING_TZ}'),
                 $12,$13,$14,$15,$16,$17,'approved',$1::int)
         ON CONFLICT (id) DO UPDATE
           SET member_id = EXCLUDED.member_id, company_id = EXCLUDED.company_id,
               charge_type = EXCLUDED.charge_type, ticket_id = EXCLUDED.ticket_id,
               project_ticket_id = EXCLUDED.project_ticket_id, work_date = EXCLUDED.work_date,
               started_at = EXCLUDED.started_at, ended_at = EXCLUDED.ended_at,
               actual_hours = EXCLUDED.actual_hours, billed_hours = EXCLUDED.billed_hours,
               billable = EXCLUDED.billable, bill_rate = EXCLUDED.bill_rate, notes = EXCLUDED.notes`,
        [
          r.id,
          memberId,
          companyId,
          chargeType,
          ticketId,
          projectTicketId,
          roleId,
          typeId,
          workDate,
          start,
          end,
          num(r.actual_hours),
          num(r.hours_billed) ?? 0,
          billable,
          num(r.hourly_rate) ?? 0,
          costByMember.get(memberId) ?? 0,
          clean(r.notes),
        ],
      );
      await db.query("RELEASE SAVEPOINT te");
      c.written += 1;
    } catch (err) {
      await db.query("ROLLBACK TO SAVEPOINT te");
      c.skipped += 1;
      report.except("time entries", r.id, `rejected by database: ${(err as Error).message}`);
    }
  }
  report.except(
    "time entries",
    "*",
    "role/type are placeholders, status is 'approved', cost rate is the member's current cost; the mirror lacks these",
  );
}

/**
 * Advance identity sequences past the highest id in the SOURCE (not just the imported rows), so a
 * skipped CW record's number is never reused by a new native record (ADR 0003).
 */
async function resetSequences(src: pg.Pool, db: pg.PoolClient): Promise<void> {
  const m = await src.query<{
    tickets: string;
    time_entries: string;
    opportunities: string;
    projects: string;
    phases: string;
  }>(
    `SELECT (SELECT COALESCE(max(id), 0) FROM production.service_tickets) AS tickets,
            (SELECT COALESCE(max(id), 0) FROM production.time_entries) AS time_entries,
            (SELECT COALESCE(max(id), 0) FROM production.opportunities) AS opportunities,
            (SELECT COALESCE(max(id), 0) FROM production.projects) AS projects,
            (SELECT COALESCE(max(phase_id), 0) FROM production.project_phases) AS phases`,
  );
  const sourceMax: Record<string, number> = {
    "service.ticket": Number(m.rows[0]?.tickets),
    "timekeeping.time_entry": Number(m.rows[0]?.time_entries),
    "sales.opportunity": Number(m.rows[0]?.opportunities),
    "project.project": Number(m.rows[0]?.projects),
    "project.phase": Number(m.rows[0]?.phases),
  };
  for (const [table, srcMax] of Object.entries(sourceMax)) {
    await db.query(
      `SELECT setval(pg_get_serial_sequence('${table}', 'id'),
                     GREATEST($1::bigint, (SELECT COALESCE(max(id), 0) FROM ${table}), 1),
                     GREATEST($1::bigint, (SELECT COALESCE(max(id), 0) FROM ${table})) > 0)`,
      [srcMax],
    );
  }
}

async function reconcile(src: pg.Pool, db: pg.PoolClient): Promise<Reconciliation> {
  const s = await src.query<{
    tickets: string;
    te: string;
    hours: string;
    opps: string;
    projects: string;
    phases: string;
  }>(
    `SELECT (SELECT count(*) FROM production.opportunities) AS opps,
            (SELECT count(*) FROM production.projects) AS projects,
            (SELECT count(*) FROM production.project_phases) AS phases,
            (SELECT count(*) FROM production.service_tickets) AS tickets,
            (SELECT count(*) FROM production.time_entries) AS te,
            (SELECT COALESCE(sum(actual_hours), 0) FROM production.time_entries) AS hours`,
  );
  const t = await db.query<{
    tickets: string;
    te: string;
    hours: string;
    opps: string;
    projects: string;
    phases: string;
  }>(
    `SELECT (SELECT count(*) FROM sales.opportunity WHERE legacy_cw_opportunity_id IS NOT NULL) AS opps,
            (SELECT count(*) FROM project.project WHERE legacy_cw_project_id IS NOT NULL) AS projects,
            (SELECT count(*) FROM project.phase WHERE legacy_cw_phase_id IS NOT NULL) AS phases,
            (SELECT count(*) FROM service.ticket WHERE legacy_cw_ticket_id IS NOT NULL) AS tickets,
            (SELECT count(*) FROM timekeeping.time_entry WHERE legacy_cw_time_entry_id IS NOT NULL) AS te,
            (SELECT COALESCE(sum(actual_hours), 0) FROM timekeeping.time_entry WHERE legacy_cw_time_entry_id IS NOT NULL) AS hours`,
  );
  const a = s.rows[0];
  const b = t.rows[0];
  return {
    tickets: { source: Number(a?.tickets), target: Number(b?.tickets) },
    timeEntries: { source: Number(a?.te), target: Number(b?.te) },
    timeActualHours: { source: Number(a?.hours), target: Number(b?.hours) },
    opportunities: { source: Number(a?.opps), target: Number(b?.opps) },
    projects: { source: Number(a?.projects), target: Number(b?.projects) },
    phases: { source: Number(a?.phases), target: Number(b?.phases) },
  };
}
