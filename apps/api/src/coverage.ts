import { agreementStatus, coverageDecision } from "@hoosier/shared";
import type pg from "pg";

export interface CoverageResult {
  /** The agreement on the ticket, if it is in force on the work date. */
  agreementId: number | null;
  covered: boolean;
}

/**
 * Whether labor on a ticket is covered by the ticket's agreement (rules in @hoosier/shared). Reads the
 * ticket's agreement, checks it is in force on the work date, and counts the hours it has already covered
 * so block-hour balances are exact. `excludeEntryId` leaves out the entry being re-decided.
 */
export async function coverageFor(
  client: pg.PoolClient,
  input: {
    ticketId: number | null;
    workTypeId: number;
    workDate: string;
    hours: number;
    excludeEntryId?: number;
  },
): Promise<CoverageResult> {
  if (input.ticketId === null) return { agreementId: null, covered: false };
  const { rows } = await client.query<{
    id: string;
    coverage: "none" | "block_hours" | "unlimited_remote" | "covered";
    block_hours: string | null;
    start_date: string;
    end_date: string | null;
    auto_renew: boolean;
    cancelled_date: string | null;
    counts: boolean;
    used: string;
  }>(
    `SELECT a.id, a.coverage, a.block_hours,
            to_char(a.start_date, 'YYYY-MM-DD') AS start_date, to_char(a.end_date, 'YYYY-MM-DD') AS end_date,
            a.auto_renew, to_char(a.cancelled_date, 'YYYY-MM-DD') AS cancelled_date,
            (SELECT counts_against_agreement FROM catalog.work_type WHERE id = $2) AS counts,
            COALESCE((SELECT sum(actual_hours) FROM timekeeping.time_entry
                       WHERE agreement_id = a.id AND status <> 'void' AND id <> $3), 0) AS used
       FROM service.ticket t JOIN billing.agreement a ON a.id = t.agreement_id
      WHERE t.id = $1`,
    [input.ticketId, input.workTypeId, input.excludeEntryId ?? 0],
  );
  const a = rows[0];
  if (!a) return { agreementId: null, covered: false };
  const inForce =
    agreementStatus(
      {
        startDate: a.start_date,
        endDate: a.end_date,
        autoRenew: a.auto_renew,
        cancelledDate: a.cancelled_date,
      },
      input.workDate,
    ) === "active";
  if (!inForce) return { agreementId: Number(a.id), covered: false };
  const decision = coverageDecision(
    {
      coverage: a.coverage,
      blockHours: a.block_hours === null ? null : Number(a.block_hours),
      usedHours: Number(a.used),
    },
    { hours: input.hours, workTypeCounts: a.counts === true },
  );
  return { agreementId: Number(a.id), covered: decision.covered };
}
