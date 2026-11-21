/** Small pure helpers shared by the importer: value cleaning and ConnectWise-to-PSA vocabulary mappings. */

export const num = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

export const clean = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

/** CW billing methods (as the warehouse spells them) to ours. */
export const BILLING_METHODS: Record<string, string> = {
  ActualRates: "actual_rates",
  FixedFee: "fixed_fee",
  NotToExceed: "not_to_exceed",
  OverrideRate: "override_rate",
};

// ---- Sales stages and opportunities ----

/** "7. Ready for Proposal" is stage 7; a name without a leading number has none. */
export function stageNumber(name: string): number | null {
  const m = /^\s*(\d+)\s*[.)-]/.exec(name);
  return m ? Number(m[1]) : null;
}

export const stageSortOrder = (name: string): number => {
  const n = stageNumber(name);
  return n === null ? 500 : n * 10;
};

/**
 * Win probability each CW stage stands for. CW keeps probability on every opportunity, but ours comes from the stage,
 * so this is configuration chosen to match how the stages were used (read from the pipeline: a stage's open
 * opportunities carried about these values). It can be edited afterwards in the stage list.
 */
const STAGE_PROBABILITY: Record<number, number> = {
  1: 10,
  2: 10,
  3: 10,
  4: 20,
  5: 30,
  6: 40,
  7: 50,
  8: 75,
  9: 0,
};
export const stageProbability = (name: string): number => {
  const n = stageNumber(name);
  return n === null ? 0 : (STAGE_PROBABILITY[n] ?? 0);
};

/** CW's last stage. An opportunity there is dead whatever its status says. */
export const isDeadStage = (name: string): boolean => /^\s*\d+\s*[.)-]\s*dead\b/i.test(name);

export interface OpportunityOutcome {
  kind: "won" | "lost" | "open";
  /** Why it was lost: the CW status, kept word for word. */
  reason: string | null;
  /** True when the status was not one we know and was treated as open. */
  unrecognised: boolean;
}

/** Won and lost live in the CW opportunity status, not in its stage. */
export function opportunityOutcome(status: string | null | undefined): OpportunityOutcome {
  const s = clean(status);
  if (!s) return { kind: "open", reason: null, unrecognised: false };
  const l = s.toLowerCase();
  if (l.startsWith("won")) return { kind: "won", reason: null, unrecognised: false };
  if (l.startsWith("open") || l === "parked")
    return { kind: "open", reason: null, unrecognised: false };
  if (
    l.startsWith("lost") ||
    l.startsWith("disqualified") ||
    l === "spam" ||
    l === "residential lead" ||
    l === "sent to service"
  )
    return { kind: "lost", reason: s, unrecognised: false };
  return { kind: "open", reason: null, unrecognised: true };
}

// ---- Projects and phases ----

export type ProjectStatus =
  | "planning"
  | "open"
  | "on_hold"
  | "ready_to_invoice"
  | "closed"
  | "canceled";

/** CW project status names are numbered ("2.5 - Scheduled"); the number decides, the words are a fallback. */
export function mapProjectStatus(status: string | null | undefined): {
  status: ProjectStatus;
  unrecognised: boolean;
} {
  const s = clean(status)?.toLowerCase() ?? "";
  const rules: Array<[RegExp, ProjectStatus]> = [
    [/cancel/, "canceled"],
    [/ready for invoice/, "ready_to_invoice"],
    [/closed/, "closed"],
    [/hold/, "on_hold"],
    [/parts|waiting on/, "planning"],
    [/needs sched|scheduled|in progress|progress/, "open"],
  ];
  for (const [re, out] of rules) if (re.test(s)) return { status: out, unrecognised: false };
  return { status: "open", unrecognised: true };
}

/** CW leaves an unfinished project type as this marker; we keep the field empty instead. */
export const PLACEHOLDER_PROJECT_TYPE = /^\s*\*\s*must change/i;

/** "1.10.2" sorts after "1.9": compare segment by segment as numbers. */
export function wbsSortKey(wbs: string | null | undefined): number[] {
  const t = clean(wbs);
  if (!t) return [];
  return t.split(/[.\-/]/).map((p) => {
    const n = Number(p);
    return Number.isFinite(n) ? n : 0;
  });
}

export function compareWbs(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

export type BillCycle = "monthly" | "quarterly" | "semi_annual" | "annual";

/**
 * CW bill cycle names. "zDNU-Yearly" is a retired "do not use" yearly cycle that still has agreements on it;
 * it is treated as annual and flagged. A missing cycle is monthly, flagged.
 */
export function mapBillCycle(name: string | null | undefined): { cycle: BillCycle; note?: string } {
  const n = (name ?? "").toLowerCase();
  if (!n.trim()) return { cycle: "monthly", note: "no bill cycle in CW; set to monthly" };
  if (n.includes("zdnu"))
    return { cycle: "annual", note: "retired CW yearly cycle (zDNU-Yearly); set to annual" };
  if (n.includes("semi")) return { cycle: "semi_annual" };
  if (n.includes("quarter")) return { cycle: "quarterly" };
  if (n.includes("annual") || n.includes("year")) return { cycle: "annual" };
  if (n.includes("month")) return { cycle: "monthly" };
  return { cycle: "monthly", note: `unrecognised CW bill cycle "${name}"; set to monthly` };
}

export function cycleMonths(cycle: BillCycle): number {
  return { monthly: 1, quarterly: 3, semi_annual: 6, annual: 12 }[cycle];
}

/** CW additions are priced per bill cycle; the PSA prices them per month (docs/05), so divide by the cycle. */
export function perMonth(amount: number, cycle: BillCycle): number {
  return Math.round((amount / cycleMonths(cycle)) * 1e4) / 1e4;
}

/** Dates before 1990 or after 2100 are placeholders in CW ("never ends"), not real dates. */
export function sane(date: string | null | undefined): string | null {
  if (!date) return null;
  const y = Number(date.slice(0, 4));
  return y >= 1990 && y <= 2100 ? date.slice(0, 10) : null;
}
