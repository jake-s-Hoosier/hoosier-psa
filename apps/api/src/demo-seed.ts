/**
 * Loads made-up demo data (companies, contacts, tickets, time) into a DEVELOPMENT database so the app
 * can be looked at. Refuses anything else: APP_ENV must be development, the database marker must say
 * development, and the database must not already hold companies.
 */
import { assertSafeTarget, readMarker } from "@hoosier/db";
import pg from "pg";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  if (process.env.APP_ENV !== "development")
    throw new Error("Demo data loads only with APP_ENV=development");
  assertSafeTarget(url);
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const marker = await readMarker(pool);
    if (marker?.name !== "development")
      throw new Error("Database marker is not 'development'; refusing");
    const existing = await pool.query("SELECT 1 FROM crm.company LIMIT 1");
    if (existing.rowCount)
      throw new Error("Database already has companies; refusing to add demo data");

    await pool.query("BEGIN"); // one connection, so everything below is a single all-or-nothing load
    const one = async (sql: string, params: unknown[] = []): Promise<number> =>
      Number((await pool.query<{ id: string }>(sql, params)).rows[0]?.id);
    const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);

    // People. Member 1 is the default dev user in the web app, so it is the administrator.
    const members: Record<string, number> = {};
    for (const [ident, first, last, title, tech, cost] of [
      ["jshaffer", "Jake", "Shaffer", "General Manager", false, 70],
      ["tmiller", "Travis", "Miller", "Field Lead", true, 42],
      ["akeene", "Ava", "Keene", "Technician", true, 36],
      ["dpike", "Dana", "Pike", "Operations Manager", false, 48],
    ] as const) {
      members[ident] = await one(
        `INSERT INTO iam.member (identifier, first_name, last_name, email, title, is_field_tech, hourly_cost)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [ident, first, last, `${ident}@demo.example`, title, tech, cost],
      );
    }
    const roleFor: Record<string, string> = {
      jshaffer: "Administrator",
      tmiller: "Technician",
      akeene: "Technician",
      dpike: "Manager",
    };
    for (const [ident, role] of Object.entries(roleFor))
      await q(
        "INSERT INTO iam.member_role (member_id, role_id) SELECT $1, id FROM iam.role WHERE name = $2",
        [members[ident], role],
      );

    // Catalog and service setup.
    const techRole = await one(
      "INSERT INTO catalog.work_role (name, hourly_rate) VALUES ('Technician', 125) RETURNING id",
    );
    await q(
      "INSERT INTO catalog.work_role (name, hourly_rate) VALUES ('Project Lead', 165), ('Admin', 85)",
    );
    const regular = await one(
      "INSERT INTO catalog.work_type (name, rate_multiplier) VALUES ('Regular', 1) RETURNING id",
    );
    await q("INSERT INTO catalog.work_type (name, rate_multiplier) VALUES ('After Hours', 1.5)");
    const board = await one(
      "INSERT INTO service.board (name, description) VALUES ('Service', 'Day-to-day service calls') RETURNING id",
    );
    await q(
      "INSERT INTO service.board (name, description) VALUES ('Projects', 'Installations and upgrades')",
    );
    const statusIds: Record<string, number> = {};
    for (const [i, [name, def, closed]] of [
      ["New", true, false],
      ["Scheduled", false, false],
      ["In Progress", false, false],
      ["Waiting on Customer", false, false],
      ["Completed", false, true],
      ["Closed", false, true],
    ].entries() as IterableIterator<[number, [string, boolean, boolean]]>) {
      statusIds[name] = await one(
        "INSERT INTO service.board_status (board_id, name, is_default, is_closed, sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING id",
        [board, name, def, closed, i + 1],
      ).catch(async () =>
        one(
          "INSERT INTO service.board_status (board_id, name, is_default, is_closed) VALUES ($1,$2,$3,$4) RETURNING id",
          [board, name, def, closed],
        ),
      );
    }
    const types: Record<string, number> = {};
    for (const t of ["Access Control", "CCTV", "Intrusion Alarm", "Network"])
      types[t] = await one(
        "INSERT INTO service.ticket_type (board_id, name) VALUES ($1,$2) RETURNING id",
        [board, t],
      );
    const src: Record<string, number> = {};
    for (const s of ["Phone", "Portal", "Alarm.com"]) {
      const r = await q(
        "INSERT INTO service.ticket_source (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING id",
        [s],
      );
      src[s] = r.rows[0]
        ? Number(r.rows[0].id)
        : await one("SELECT id FROM service.ticket_source WHERE name=$1", [s]);
    }
    const prio = async (name: string) =>
      one("SELECT id FROM service.priority WHERE name = $1", [name]);
    const activeStatus = await one("SELECT id FROM crm.company_status WHERE name = 'Active'");

    // Customers.
    const customers: Array<[string, string, string, string, string, string, string[]]> = [
      [
        "NORTHSIDE",
        "Northside Community Church",
        "Main Campus",
        "4120 N Meridian St",
        "Indianapolis",
        "46208",
        ["Paula Reed|Facilities Director", "Greg Hall|Pastor"],
      ],
      [
        "LAKEVIEW",
        "Lakeview Manufacturing",
        "Plant 1",
        "900 Industrial Pkwy",
        "Carmel",
        "46032",
        ["Sam Ortiz|Plant Manager", "Mia Chen|Safety Coordinator"],
      ],
      [
        "HARBOR",
        "Harbor Dental Group",
        "Downtown Office",
        "55 Monument Cir",
        "Indianapolis",
        "46204",
        ["Dr. Ellen Park|Owner"],
      ],
      [
        "SPEEDWAY",
        "Speedway Public Library",
        "Main Library",
        "5633 W 25th St",
        "Speedway",
        "46224",
        ["Jon Bailey|Director", "Kara Voss|IT Coordinator"],
      ],
      [
        "OAKRIDGE",
        "Oakridge Apartments",
        "Leasing Office",
        "8100 Oakridge Dr",
        "Fishers",
        "46037",
        ["Tina Moss|Property Manager"],
      ],
    ].map(
      (c) =>
        [c[0], c[1], c[2], c[3], c[4], c[5], c[6]] as [
          string,
          string,
          string,
          string,
          string,
          string,
          string[],
        ],
    );
    const co: Record<string, { id: number; site: number; contacts: number[] }> = {};
    for (const [ident, name, siteName, street, city, zip, people] of customers) {
      const id = await one(
        "INSERT INTO crm.company (identifier, name, status_id, phone, website) VALUES ($1,$2,$3,$4,$5) RETURNING id",
        [ident, name, activeStatus, "317-555-0100", `https://${ident.toLowerCase()}.example`],
      );
      const site = await one(
        `INSERT INTO crm.site (company_id, name, address_line1, city, state, postal_code, is_default_service, is_billing)
         VALUES ($1,$2,$3,$4,'IN',$5,true,true) RETURNING id`,
        [id, siteName, street, city, zip],
      );
      const contacts: number[] = [];
      for (const person of people) {
        const [full, title] = person.split("|") as [string, string];
        const [first, ...rest] = full.split(" ");
        const cid = await one(
          "INSERT INTO crm.contact (company_id, site_id, first_name, last_name, title) VALUES ($1,$2,$3,$4,$5) RETURNING id",
          [id, site, first, rest.join(" "), title],
        );
        const email = `${(first ?? "").toLowerCase().replace(/\W/g, "")}@${ident.toLowerCase()}.example`;
        await q(
          "INSERT INTO crm.contact_channel (contact_id, kind, value, value_normalized, is_default) VALUES ($1,'email',$2,$2,true)",
          [cid, email],
        );
        contacts.push(cid);
      }
      co[ident] = { id, site, contacts };
    }

    // Tickets.
    const T: Array<[string, string, string, string, string, string, string, string, string]> = [
      [
        "NORTHSIDE",
        "Sanctuary door reader not unlocking",
        "Access Control",
        "High",
        "In Progress",
        "tmiller",
        "Phone",
        "Reader at the east sanctuary door beeps but will not release the strike.",
        "2",
      ],
      [
        "NORTHSIDE",
        "Add two cameras to the parking lot",
        "CCTV",
        "Normal",
        "New",
        "dpike",
        "Portal",
        "Quote and schedule two additional cameras covering the north lot.",
        "6",
      ],
      [
        "LAKEVIEW",
        "Alarm panel showing AC power trouble",
        "Intrusion Alarm",
        "Emergency",
        "Scheduled",
        "akeene",
        "Phone",
        "Panel in the main office reports AC loss since this morning.",
        "1",
      ],
      [
        "LAKEVIEW",
        "NVR storage nearly full",
        "CCTV",
        "Normal",
        "Waiting on Customer",
        "akeene",
        "Alarm.com",
        "Retention dropped to 9 days. Waiting on approval for additional drives.",
        "4",
      ],
      [
        "HARBOR",
        "Badge fob requests for three new hires",
        "Access Control",
        "Low",
        "New",
        "dpike",
        "Portal",
        "Program three new fobs for the front and staff doors.",
        "3",
      ],
      [
        "SPEEDWAY",
        "Camera 7 offline in the reading room",
        "CCTV",
        "High",
        "In Progress",
        "tmiller",
        "Phone",
        "Camera lost link overnight. Suspect a failed PoE port.",
        "1",
      ],
      [
        "SPEEDWAY",
        "Quarterly access control inspection",
        "Access Control",
        "Normal",
        "Completed",
        "akeene",
        "Portal",
        "Completed the quarterly inspection of all readers and door contacts.",
        "9",
      ],
      [
        "OAKRIDGE",
        "Gate keypad code reset",
        "Access Control",
        "Normal",
        "Closed",
        "tmiller",
        "Phone",
        "Reset the resident gate code after the management change.",
        "14",
      ],
      [
        "OAKRIDGE",
        "Intercom not calling residents",
        "Network",
        "High",
        "New",
        "dpike",
        "Phone",
        "Intercom shows connected but calls to apartments fail.",
        "0",
      ],
    ];
    const ticketIds: number[] = [];
    for (const [ident, summary, type, priority, status, owner, source, desc, ageDays] of T) {
      const c = co[ident];
      if (!c) continue;
      const closed = status === "Completed" || status === "Closed";
      const id = await one(
        `INSERT INTO service.ticket
           (summary, company_id, site_id, contact_id, board_id, status_id, priority_id, type_id, source_id,
            owner_member_id, entered_by_member_id, entered_at, closed_at, resolved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10, now() - ($11 || ' days')::interval,
                 CASE WHEN $12 THEN now() - ($11 || ' days')::interval + interval '3 hours' END,
                 CASE WHEN $12 THEN now() - ($11 || ' days')::interval + interval '3 hours' END)
         RETURNING id`,
        [
          summary,
          c.id,
          c.site,
          c.contacts[0],
          board,
          statusIds[status],
          await prio(priority),
          types[type],
          src[source],
          members[owner],
          ageDays,
          closed,
        ],
      );
      ticketIds.push(id);
      await q(
        "INSERT INTO service.ticket_note (ticket_id, kind, body, author_contact_id) VALUES ($1,'description',$2,$3)",
        [id, desc, c.contacts[0]],
      );
      if (status !== "New")
        await q(
          "INSERT INTO service.ticket_note (ticket_id, kind, body, author_member_id) VALUES ($1,'discussion',$2,$3)",
          [id, "Reviewed the report and contacted the customer to confirm access.", members[owner]],
        );
      await q("INSERT INTO service.ticket_resource (ticket_id, member_id) VALUES ($1,$2)", [
        id,
        members[owner],
      ]).catch(() => undefined);
    }

    // Time for the last week against the tickets.
    let day = 0;
    for (const id of ticketIds.slice(0, 7)) {
      const t = await q("SELECT company_id, owner_member_id FROM service.ticket WHERE id=$1", [id]);
      const row = t.rows[0];
      const hours = [1.5, 2, 0.75, 3, 1.25, 2.5, 1][day % 7] ?? 1;
      await q(
        `INSERT INTO timekeeping.time_entry
           (member_id, company_id, charge_type, ticket_id, work_role_id, work_type_id, work_date,
            actual_hours, billed_hours, bill_rate, cost_rate, notes, status)
         VALUES ($1,$2,'service_ticket',$3,$4,$5,(current_date - $6::int),$7,$7,125,40,'On-site troubleshooting and repair','open')`,
        [row.owner_member_id, row.company_id, id, techRole, regular, day % 5, hours],
      );
      day++;
    }
    await pool.query("COMMIT");
    console.log(
      `Demo data loaded: ${customers.length} companies, ${ticketIds.length} tickets, ${Object.keys(members).length} staff.`,
    );
  } catch (e) {
    await pool.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
