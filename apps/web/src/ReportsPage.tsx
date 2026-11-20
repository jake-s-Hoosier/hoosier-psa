import type {
  AgreementServiceReport,
  ProjectMarginReport,
  RmrFlagKind,
  RmrGrouping,
  RmrReport,
} from "@hoosier/shared";
import { type ReactNode, useEffect, useState } from "react";
import { getAgreementServiceReport, getProjectMarginReport, getRmrReport } from "./api";
import { msg, usd } from "./common";

type Tab = "rmr" | "service" | "projects";

const pct = (n: number | null) => (n === null ? "—" : `${n.toFixed(1)}%`);
const marginStyle = (n: number | null) => (n !== null && n < 0 ? { color: "#b91c1c" } : undefined);

/** A CSV of the table on screen, so a report can go straight into Excel. */
function downloadCsv(name: string, header: string[], rows: Array<Array<string | number | null>>) {
  const cell = (v: string | number | null) => {
    const t = v === null ? "" : String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const text = [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function ReportsPage() {
  const [tab, setTab] = useState<Tab>("rmr");
  return (
    <>
      <div className="page-header">
        <h2>Reports</h2>
        <div className="field-row">
          {(
            [
              ["rmr", "Recurring revenue and margin"],
              ["service", "Agreement service cost"],
              ["projects", "Project margin"],
            ] as const
          ).map(([id, label]) => (
            <button
              type="button"
              key={id}
              className={tab === id ? "btn primary" : "btn"}
              aria-pressed={tab === id}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {tab === "rmr" && <RmrTab />}
      {tab === "service" && <ServiceTab />}
      {tab === "projects" && <ProjectsTab />}
    </>
  );
}

function Stat(props: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="muted small">{props.label}</div>
      <strong>{props.children}</strong>
    </div>
  );
}

const FLAG_LABEL: Record<RmrFlagKind, string> = {
  negative_margin: "Costs more than it bills",
  no_cost: "No cost recorded",
  below_floor: "Below the margin floor",
  no_active_additions: "Active but bills nothing",
};

function RmrTab() {
  const [groupBy, setGroupBy] = useState<RmrGrouping>("type");
  const [floor, setFloor] = useState("30");
  const [asOf, setAsOf] = useState("");
  const [data, setData] = useState<RmrReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    const f = Number(floor);
    getRmrReport(
      {
        groupBy,
        floorPct: Number.isFinite(f) ? Math.min(100, Math.max(0, f)) : 30,
        asOf: asOf || undefined,
      },
      ctl.signal,
    )
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((e) => {
        if (!ctl.signal.aborted) setError(msg(e));
      });
    return () => ctl.abort();
  }, [groupBy, floor, asOf]);

  const groupLabel = {
    type: "Agreement type",
    vendor: "Vendor",
    customer: "Customer",
    agreement: "Agreement",
  }[groupBy];

  return (
    <>
      <div className="card">
        <div className="field-row">
          <label>
            Group by
            <select
              className="input"
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value as RmrGrouping)}
            >
              <option value="type">Agreement type</option>
              <option value="vendor">Vendor</option>
              <option value="customer">Customer</option>
              <option value="agreement">Agreement</option>
            </select>
          </label>
          <label>
            As of
            <input
              className="input"
              type="date"
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
            />
          </label>
          <label>
            Flag margins below (%)
            <input
              className="input"
              inputMode="decimal"
              value={floor}
              onChange={(e) => setFloor(e.target.value)}
            />
          </label>
          {data && (
            <button
              type="button"
              className="btn"
              onClick={() =>
                downloadCsv(
                  `rmr-by-${groupBy}-${data.asOf}.csv`,
                  [
                    groupLabel,
                    "Agreements",
                    "Lines",
                    "Monthly revenue",
                    "Monthly cost",
                    "Margin",
                    "Margin %",
                  ],
                  data.groups.map((g) => [
                    g.name,
                    g.agreements,
                    g.additions,
                    g.revenue,
                    g.cost,
                    g.margin,
                    g.marginPct,
                  ]),
                )
              }
            >
              Download CSV
            </button>
          )}
        </div>
      </div>
      {error && <div className="state error">{error}</div>}
      {!data && !error && <div className="state">Loading…</div>}
      {data && (
        <>
          <div className="card">
            <div className="field-grid">
              <Stat label={`Recurring revenue per month, as of ${data.asOf}`}>
                {usd(data.totals.revenue)}
              </Stat>
              <Stat label="Monthly cost">{usd(data.totals.cost)}</Stat>
              <Stat label="Margin">
                {usd(data.totals.margin)} ({pct(data.totals.marginPct)})
              </Stat>
              <Stat label="Active agreements">
                {data.totals.agreements} for {data.totals.customers} customers
              </Stat>
            </div>
          </div>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>{groupLabel}</th>
                  <th className="num">Agreements</th>
                  <th className="num">Lines</th>
                  <th className="num">Revenue</th>
                  <th className="num">Cost</th>
                  <th className="num">Margin</th>
                  <th className="num">Margin %</th>
                </tr>
              </thead>
              <tbody>
                {data.groups.map((g) => (
                  <tr key={g.key}>
                    <td>{g.name}</td>
                    <td className="num">{g.agreements}</td>
                    <td className="num">{g.additions}</td>
                    <td className="num">{usd(g.revenue)}</td>
                    <td className="num">{usd(g.cost)}</td>
                    <td className="num" style={marginStyle(g.marginPct)}>
                      {usd(g.margin)}
                    </td>
                    <td className="num" style={marginStyle(g.marginPct)}>
                      {pct(g.marginPct)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.groups.length === 0 && (
              <div className="state">No active recurring lines on that date.</div>
            )}
          </div>
          <div className="card">
            <h3>
              Worth a look ({data.flags.length}
              {data.flagsTruncated ? "+" : ""})
            </h3>
            {data.flags.length === 0 && <div className="state">Nothing flagged.</div>}
            {data.flags.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Why</th>
                    <th>Customer</th>
                    <th>Agreement</th>
                    <th>Line</th>
                    <th>Vendor</th>
                    <th className="num">Revenue</th>
                    <th className="num">Cost</th>
                    <th className="num">Margin %</th>
                  </tr>
                </thead>
                <tbody>
                  {data.flags.map((f) => (
                    <tr key={`${f.kind}-${f.agreementId}-${f.description ?? ""}`}>
                      <td>{FLAG_LABEL[f.kind]}</td>
                      <td>{f.company}</td>
                      <td>
                        <a className="link" href={`#/agreements/${f.agreementId}`}>
                          {f.agreement}
                        </a>
                      </td>
                      <td>{f.description ?? ""}</td>
                      <td>{f.vendor ?? ""}</td>
                      <td className="num">{usd(f.revenue)}</td>
                      <td className="num">{usd(f.cost)}</td>
                      <td className="num" style={marginStyle(f.marginPct)}>
                        {pct(f.marginPct)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </>
  );
}

function ServiceTab() {
  const [months, setMonths] = useState(12);
  const [data, setData] = useState<AgreementServiceReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    getAgreementServiceReport({ months }, ctl.signal)
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((e) => {
        if (!ctl.signal.aborted) setError(msg(e));
      });
    return () => ctl.abort();
  }, [months]);
  return (
    <>
      <div className="card">
        <div className="field-row">
          <label>
            Look back
            <select
              className="input"
              value={months}
              onChange={(e) => setMonths(Number(e.target.value))}
            >
              {[3, 6, 12, 24].map((m) => (
                <option key={m} value={m}>
                  {m} months
                </option>
              ))}
            </select>
          </label>
          {data && (
            <button
              type="button"
              className="btn"
              onClick={() =>
                downloadCsv(
                  `agreement-service-${data.to}.csv`,
                  [
                    "Customer",
                    "Agreement",
                    "Type",
                    "Billed",
                    "Recurring cost",
                    "Hours",
                    "Labor not billed",
                    "Margin",
                    "Margin %",
                  ],
                  data.rows.map((r) => [
                    r.company,
                    r.agreement,
                    r.type,
                    r.billed,
                    r.recurringCost,
                    r.hours,
                    r.absorbedLaborCost,
                    r.margin,
                    r.marginPct,
                  ]),
                )
              }
            >
              Download CSV
            </button>
          )}
        </div>
        <p className="muted small">
          What each agreement earns after the cost of its recurring lines and the labor on its
          tickets that was not billed to the customer. Time still open or waiting for approval
          counts as not billed until it is invoiced. Worst first.
        </p>
      </div>
      {error && <div className="state error">{error}</div>}
      {!data && !error && <div className="state">Loading…</div>}
      {data && (
        <div className="card">
          <div className="muted small">
            {data.from} to {data.to}: billed {usd(data.totals.billed)}, recurring cost{" "}
            {usd(data.totals.recurringCost)}, labor not billed {usd(data.totals.absorbedLaborCost)},
            margin {usd(data.totals.margin)} ({pct(data.totals.marginPct)})
          </div>
          <table>
            <thead>
              <tr>
                <th>Customer</th>
                <th>Agreement</th>
                <th>Type</th>
                <th className="num">Billed</th>
                <th className="num">Recurring cost</th>
                <th className="num">Hours</th>
                <th className="num">Labor not billed</th>
                <th className="num">Margin</th>
                <th className="num">Margin %</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.agreementId}>
                  <td>{r.company}</td>
                  <td>
                    <a className="link" href={`#/agreements/${r.agreementId}`}>
                      {r.agreement}
                    </a>
                  </td>
                  <td>{r.type}</td>
                  <td className="num">{usd(r.billed)}</td>
                  <td className="num">{usd(r.recurringCost)}</td>
                  <td className="num">{Number(r.hours)}</td>
                  <td className="num">{usd(r.absorbedLaborCost)}</td>
                  <td className="num" style={marginStyle(r.marginPct)}>
                    {usd(r.margin)}
                  </td>
                  <td className="num" style={marginStyle(r.marginPct)}>
                    {pct(r.marginPct)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.rows.length === 0 && (
            <div className="state">No billed agreements or agreement time in this period.</div>
          )}
        </div>
      )}
    </>
  );
}

function ProjectsTab() {
  const [status, setStatus] = useState<"active" | "closed" | "all">("active");
  const [data, setData] = useState<ProjectMarginReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    getProjectMarginReport(status, ctl.signal)
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((e) => {
        if (!ctl.signal.aborted) setError(msg(e));
      });
    return () => ctl.abort();
  }, [status]);
  return (
    <>
      <div className="card">
        <div className="field-row">
          <label>
            Projects
            <select
              className="input"
              value={status}
              onChange={(e) => setStatus(e.target.value as typeof status)}
            >
              <option value="active">Open</option>
              <option value="closed">Closed</option>
              <option value="all">All</option>
            </select>
          </label>
          {data && (
            <button
              type="button"
              className="btn"
              onClick={() =>
                downloadCsv(
                  `project-margin-${status}.csv`,
                  [
                    "Project",
                    "Customer",
                    "Status",
                    "Invoiced",
                    "Hours",
                    "Budget hours",
                    "Labor cost",
                    "Material cost",
                    "Margin",
                    "Margin %",
                    "Unbilled",
                  ],
                  data.rows.map((r) => [
                    r.project,
                    r.company,
                    r.status,
                    r.invoiced,
                    r.hours,
                    r.budgetHours,
                    r.laborCost,
                    r.materialCost,
                    r.margin,
                    r.marginPct,
                    r.unbilledValue,
                  ]),
                )
              }
            >
              Download CSV
            </button>
          )}
        </div>
        <p className="muted small">
          Invoiced is posted invoices only. Cost is time at each person's cost rate plus material
          cost on the project's tickets. Unbilled is billable time and materials not yet invoiced.
        </p>
      </div>
      {error && <div className="state error">{error}</div>}
      {!data && !error && <div className="state">Loading…</div>}
      {data && (
        <div className="card">
          <div className="muted small">
            Invoiced {usd(data.totals.invoiced)}, cost {usd(data.totals.cost)}, margin{" "}
            {usd(data.totals.margin)} ({pct(data.totals.marginPct)}), unbilled{" "}
            {usd(data.totals.unbilledValue)}
          </div>
          <table>
            <thead>
              <tr>
                <th>Project</th>
                <th>Customer</th>
                <th>Status</th>
                <th className="num">Invoiced</th>
                <th className="num">Hours / budget</th>
                <th className="num">Cost</th>
                <th className="num">Margin</th>
                <th className="num">Margin %</th>
                <th className="num">Unbilled</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => {
                const over = r.budgetHours !== null && Number(r.hours) > Number(r.budgetHours);
                return (
                  <tr key={r.projectId}>
                    <td>
                      <a className="link" href={`#/projects/${r.projectId}`}>
                        {r.project}
                      </a>
                      {r.feeBilledPct !== null && (
                        <div className="muted small">
                          {r.feeBilledPct}% of the fixed fee invoiced
                        </div>
                      )}
                    </td>
                    <td>{r.company}</td>
                    <td>{r.status.replace(/_/g, " ")}</td>
                    <td className="num">{usd(r.invoiced)}</td>
                    <td className="num" style={over ? { color: "#b91c1c" } : undefined}>
                      {Number(r.hours)}
                      {r.budgetHours !== null ? ` / ${Number(r.budgetHours)}` : ""}
                    </td>
                    <td className="num">{usd(r.cost)}</td>
                    <td className="num" style={marginStyle(r.marginPct)}>
                      {usd(r.margin)}
                    </td>
                    <td className="num" style={marginStyle(r.marginPct)}>
                      {pct(r.marginPct)}
                    </td>
                    <td className="num">{usd(r.unbilledValue)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {data.rows.length === 0 && <div className="state">No projects.</div>}
        </div>
      )}
    </>
  );
}
