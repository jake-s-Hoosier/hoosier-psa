export interface EntityCount {
  read: number;
  written: number;
  skipped: number;
}

export interface ImportException {
  entity: string;
  sourceId: number | string;
  problem: string;
}

/** Collects counts and exceptions. Exceptions never abort the import; they are reported (docs/11). */
export class ImportReport {
  readonly counts: Record<string, EntityCount> = {};
  readonly exceptions: ImportException[] = [];
  /** Cap stored detail so a systemic problem cannot exhaust memory; the total is still counted. */
  private static readonly MAX_DETAIL = 500;
  totalExceptions = 0;
  /** Counted-only problems for high-volume cases (one line per kind rather than one per row). */
  private readonly tallies = new Map<string, number>();

  tally(entity: string, problem: string, n = 1): void {
    const k = `${entity}\u0000${problem}`;
    this.tallies.set(k, (this.tallies.get(k) ?? 0) + n);
    this.totalExceptions += n;
  }

  count(entity: string): EntityCount {
    let c = this.counts[entity];
    if (!c) {
      c = { read: 0, written: 0, skipped: 0 };
      this.counts[entity] = c;
    }
    return c;
  }

  except(entity: string, sourceId: number | string, problem: string): void {
    this.tally(entity, problem);
    if (this.exceptions.length < ImportReport.MAX_DETAIL) {
      this.exceptions.push({ entity, sourceId, problem });
    }
  }

  /** Exception totals grouped by entity and problem (covers every exception, not just the stored detail). */
  summary(): Array<{ entity: string; problem: string; n: number }> {
    return [...this.tallies].map(([k, n]) => {
      const [entity, problem] = k.split("\u0000");
      return { entity: entity as string, problem: problem as string, n };
    });
  }
}
