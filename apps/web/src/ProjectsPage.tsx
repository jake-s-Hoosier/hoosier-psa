import type {
  BillingRunPreview,
  Phase,
  Project,
  ProjectBilling,
  ProjectBillingMethod,
  ProjectBillingMode,
  ProjectBillingScope,
  ProjectStatus,
} from "@hoosier/shared";
import { useCallback, useEffect, useState } from "react";
import {
  type Lookups,
  type ProjectTicketRow,
  createBillingRun,
  createPhase,
  createProject,
  createTicket,
  deletePhase,
  getProject,
  getProjectBilling,
  listCompanies,
  listProjectTickets,
  listProjects,
  previewBillingRun,
  updatePhase,
  updateProject,
} from "./api";
import { msg, shortDate, usd } from "./common";
import { Link, navigate } from "./router";

const OPERATING_TZ = "America/Indiana/Indianapolis";
const todayIso = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: OPERATING_TZ }).format(new Date());

const STATUS_LABEL: Record<ProjectStatus, string> = {
  planning: "Planning",
  open: "Open",
  on_hold: "On hold",
  ready_to_invoice: "Ready to invoice",
  closed: "Closed",
  canceled: "Canceled",
};
const METHOD_LABEL: Record<ProjectBillingMethod, string> = {
  actual_rates: "Actual rates (time and materials)",
  fixed_fee: "Fixed fee",
  not_to_exceed: "Not to exceed",
  override_rate: "Override hourly rate",
};
const AMOUNT_LABEL: Record<ProjectBillingMethod, string> = {
  actual_rates: "",
  fixed_fee: "Fixed fee ($)",
  not_to_exceed: "Cap ($)",
  override_rate: "Hourly rate ($)",
};
const methodText = (m: ProjectBillingMethod, amount: string | null) =>
  m === "actual_rates"
    ? "Time and materials"
    : `${METHOD_LABEL[m].split(" (")[0]}${amount ? ` ${usd(amount)}` : ""}${m === "override_rate" ? "/h" : ""}`;

function StatusBadge({ status }: { status: ProjectStatus }) {
  const tone =
    status === "closed" || status === "canceled"
      ? "cancelled"
      : status === "ready_to_invoice"
        ? "pending"
        : "active";
  return <span className={`badge status-${tone}`}>{STATUS_LABEL[status]}</span>;
}

export function ProjectsPage(props: {
  can: (key: string) => boolean;
  lookups: Lookups | null;
  routeId: number | null;
}) {
  return props.routeId === null ? (
    <ProjectList can={props.can} />
  ) : (
    <ProjectDetail key={props.routeId} id={props.routeId} can={props.can} lookups={props.lookups} />
  );
}

// ---- List ----

function ProjectList({ can }: { can: (key: string) => boolean }) {
  const [q, setQ] = useState("");
  const [state, setState] = useState<"active" | "closed" | "all">("active");
  const [items, setItems] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const ctl = new AbortController();
    const t = setTimeout(() => {
      listProjects({ q: q.trim() || undefined, state }, ctl.signal)
        .then((r) => {
          setItems(r.items);
          setError(null);
        })
        .catch((e) => {
          if (!ctl.signal.aborted) setError(msg(e));
        });
    }, 200);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [q, state]);

  return (
    <>
      <div className="page-header">
        <h2>Projects</h2>
        {can("project.write") && (
          <button type="button" className="btn primary" onClick={() => setCreating(true)}>
            New project
          </button>
        )}
      </div>
      <div className="card">
        <div className="toolbar">
          <input
            className="input"
            placeholder="Search by project or company"
            aria-label="Search projects"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select
            className="input"
            aria-label="Show"
            value={state}
            onChange={(e) => setState(e.target.value as typeof state)}
          >
            <option value="active">Active</option>
            <option value="closed">Closed or canceled</option>
            <option value="all">All</option>
          </select>
        </div>
        {error && <div className="state error">{error}</div>}
        {!items && !error && <div className="state">Loading…</div>}
        {items && items.length === 0 && <div className="state">No projects match.</div>}
        {items && items.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Project</th>
                <th>Customer</th>
                <th>Status</th>
                <th>Billing</th>
                <th className="num">Open tickets</th>
                <th className="num">Hours</th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link to={`/projects/${p.id}`}>{p.name}</Link>
                  </td>
                  <td>{p.company}</td>
                  <td>
                    <StatusBadge status={p.status} />
                  </td>
                  <td>{methodText(p.billingMethod, p.billingAmount)}</td>
                  <td className="num">{p.openTicketCount}</td>
                  <td className="num">{Number(p.hoursLogged).toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {creating && (
        <ProjectDialog
          existing={null}
          onClose={() => setCreating(false)}
          onSaved={(p) => navigate(`/projects/${p.id}`)}
        />
      )}
    </>
  );
}

// ---- Detail ----

type Dialog =
  | { kind: "edit" }
  | { kind: "phase"; phase: Phase | null }
  | { kind: "ticket" }
  | { kind: "bill"; scope: ProjectBillingScope };

function ProjectDetail(props: {
  id: number;
  can: (key: string) => boolean;
  lookups: Lookups | null;
}) {
  const [project, setProject] = useState<Project | null>(null);
  const [billing, setBilling] = useState<ProjectBilling | null>(null);
  const [tickets, setTickets] = useState<ProjectTicketRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [reload, setReload] = useState(0);
  const canWrite = props.can("project.write");
  const canBill = props.can("billing.invoice.write");

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload is a manual refetch trigger
  useEffect(() => {
    const ctl = new AbortController();
    Promise.all([
      getProject(props.id, ctl.signal),
      getProjectBilling(props.id, ctl.signal),
      listProjectTickets(props.id, ctl.signal),
    ])
      .then(([p, b, t]) => {
        setProject(p);
        setBilling(b);
        setTickets(t.items);
        setError(null);
      })
      .catch((e) => {
        if (!ctl.signal.aborted) setError(msg(e));
      });
    return () => ctl.abort();
  }, [props.id, reload]);

  const refresh = useCallback(() => {
    setDialog(null);
    setReload((n) => n + 1);
  }, []);

  const setStatus = async (status: ProjectStatus) => {
    try {
      await updateProject(props.id, { status });
      refresh();
    } catch (e) {
      setError(msg(e));
    }
  };

  if (error && !project) return <div className="state error">{error}</div>;
  if (!project) return <div className="state">Loading…</div>;
  const closed = project.status === "closed" || project.status === "canceled";

  return (
    <>
      <div className="page-header">
        <h2>
          <Link to="/projects">Projects</Link> / {project.name}{" "}
          <StatusBadge status={project.status} />
        </h2>
        {canWrite && (
          <div className="field-row">
            {project.status === "open" && (
              <button type="button" className="btn" onClick={() => setStatus("ready_to_invoice")}>
                Mark ready to invoice
              </button>
            )}
            {project.status === "ready_to_invoice" && (
              <button type="button" className="btn" onClick={() => setStatus("closed")}>
                Close project
              </button>
            )}
            {closed && (
              <button type="button" className="btn" onClick={() => setStatus("open")}>
                Reopen
              </button>
            )}
            <button type="button" className="btn" onClick={() => setDialog({ kind: "edit" })}>
              Edit
            </button>
          </div>
        )}
      </div>
      {error && <div className="state error">{error}</div>}

      <div className="card">
        <div className="field-grid">
          <div>
            <div className="muted small">Customer</div>
            <Link to={`/companies/${project.companyId}`}>{project.company}</Link>
            {project.site && <span className="muted"> · {project.site}</span>}
          </div>
          <div>
            <div className="muted small">Billing</div>
            {methodText(project.billingMethod, project.billingAmount)}
          </div>
          <div>
            <div className="muted small">PO</div>
            {project.poNumber ?? "—"}
            {project.poAmount ? ` (${usd(project.poAmount)})` : ""}
          </div>
          <div>
            <div className="muted small">Hours</div>
            {Number(project.hoursLogged).toFixed(1)}
            {project.budgetHours ? ` of ${Number(project.budgetHours).toFixed(0)} budgeted` : ""}
          </div>
          <div>
            <div className="muted small">Schedule</div>
            {project.estimatedStart ? shortDate(project.estimatedStart) : "—"} to{" "}
            {project.estimatedEnd ? shortDate(project.estimatedEnd) : "—"}
          </div>
        </div>
        {project.notes && <p className="muted">{project.notes}</p>}
      </div>

      <div className="card">
        <h3>Billing</h3>
        <table>
          <thead>
            <tr>
              <th>Scope</th>
              <th>Method</th>
              <th className="num">Fee billed</th>
              <th className="num">Left to bill</th>
              <th className="num">Unbilled labor</th>
              <th className="num">Unbilled materials</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {billing?.scopes.map((sc) => (
              <tr key={sc.phaseId ?? "project"}>
                <td>
                  {sc.name}
                  {sc.finalBilled && <span className="badge status-cancelled">closed out</span>}
                  {sc.unapprovedEntries > 0 && (
                    <div className="muted small">
                      {sc.unapprovedEntries} time entries waiting for approval
                    </div>
                  )}
                </td>
                <td>{methodText(sc.billingMethod, sc.billingAmount)}</td>
                <td className="num">
                  {sc.billingMethod === "fixed_fee" ? usd(sc.feeBilled) : "—"}
                </td>
                <td className="num">{sc.feeRemaining === null ? "—" : usd(sc.feeRemaining)}</td>
                <td className="num">
                  {usd(sc.unbilledLabor)}{" "}
                  <span className="muted small">({Number(sc.unbilledHours).toFixed(1)} h)</span>
                </td>
                <td className="num">{usd(sc.unbilledCharges)}</td>
                <td className="num">
                  {canBill && !sc.finalBilled && (
                    <button
                      type="button"
                      className="btn"
                      onClick={() => setDialog({ kind: "bill", scope: sc })}
                    >
                      Bill…
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="page-header">
          <h3>Phases</h3>
          {canWrite && (
            <button
              type="button"
              className="btn"
              onClick={() => setDialog({ kind: "phase", phase: null })}
            >
              Add phase
            </button>
          )}
        </div>
        {project.phases?.length === 0 && (
          <div className="state">No phases. Tickets can still be added to the project.</div>
        )}
        {project.phases && project.phases.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Phase</th>
                <th>Billing</th>
                <th className="num">Tickets</th>
                <th className="num">Hours</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {project.phases.map((h) => (
                <tr key={h.id}>
                  <td>{h.name}</td>
                  <td>
                    {h.billSeparately
                      ? `Billed separately: ${methodText(h.billingMethod ?? "actual_rates", h.billingAmount)}`
                      : "With the project"}
                  </td>
                  <td className="num">{h.ticketCount}</td>
                  <td className="num">
                    {Number(h.hoursLogged).toFixed(1)}
                    {h.budgetHours ? ` / ${Number(h.budgetHours).toFixed(0)}` : ""}
                  </td>
                  <td className="num">
                    {canWrite && (
                      <button
                        type="button"
                        className="btn"
                        onClick={() => setDialog({ kind: "phase", phase: h })}
                      >
                        Edit
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="page-header">
          <h3>Tickets</h3>
          {props.can("service.ticket.write") && !closed && (
            <button type="button" className="btn" onClick={() => setDialog({ kind: "ticket" })}>
              New project ticket
            </button>
          )}
        </div>
        {tickets.length === 0 && <div className="state">No tickets yet.</div>}
        {tickets.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Ticket</th>
                <th>Phase</th>
                <th>Status</th>
                <th>Owner</th>
                <th className="num">Hours</th>
              </tr>
            </thead>
            <tbody>
              {tickets.map((t) => (
                <tr key={t.id}>
                  <td>
                    <Link to={`/tickets/${t.id}`}>
                      #{t.id} {t.summary}
                    </Link>
                  </td>
                  <td>{t.phase ?? "—"}</td>
                  <td>{t.status}</td>
                  <td>{t.owner ?? "—"}</td>
                  <td className="num">{Number(t.hours).toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {dialog?.kind === "edit" && (
        <ProjectDialog existing={project} onClose={() => setDialog(null)} onSaved={refresh} />
      )}
      {dialog?.kind === "phase" && (
        <PhaseDialog
          projectId={project.id}
          phase={dialog.phase}
          onClose={() => setDialog(null)}
          onSaved={refresh}
        />
      )}
      {dialog?.kind === "ticket" && props.lookups && (
        <ProjectTicketDialog
          project={project}
          lookups={props.lookups}
          onClose={() => setDialog(null)}
          onSaved={refresh}
        />
      )}
      {dialog?.kind === "bill" && (
        <BillDialog
          project={project}
          scope={dialog.scope}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            navigate("/billing");
          }}
        />
      )}
    </>
  );
}

// ---- Dialogs ----

function useSave<T>(onSaved: (r: T) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (fn: () => Promise<T>) => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await fn());
    } catch (e) {
      setError(msg(e));
      setBusy(false);
    }
  };
  return { busy, error, save };
}

const num = (s: string) => (s.trim() === "" ? null : Number(s));

function BillingTerms(props: {
  method: ProjectBillingMethod;
  amount: string;
  onMethod: (m: ProjectBillingMethod) => void;
  onAmount: (a: string) => void;
}) {
  return (
    <>
      <label>
        Billing method
        <select
          className="input"
          value={props.method}
          onChange={(e) => props.onMethod(e.target.value as ProjectBillingMethod)}
        >
          {(Object.keys(METHOD_LABEL) as ProjectBillingMethod[]).map((m) => (
            <option key={m} value={m}>
              {METHOD_LABEL[m]}
            </option>
          ))}
        </select>
      </label>
      {props.method !== "actual_rates" && (
        <label>
          {AMOUNT_LABEL[props.method]}
          <input
            className="input"
            inputMode="decimal"
            value={props.amount}
            onChange={(e) => props.onAmount(e.target.value)}
          />
        </label>
      )}
    </>
  );
}

function ProjectDialog(props: {
  existing: Project | null;
  onClose: () => void;
  onSaved: (p: Project) => void;
}) {
  const ex = props.existing;
  const [companyQuery, setCompanyQuery] = useState(ex?.company ?? "");
  const [companyId, setCompanyId] = useState<number | null>(ex?.companyId ?? null);
  const [companies, setCompanies] = useState<Array<{ id: number; name: string }>>([]);
  const [name, setName] = useState(ex?.name ?? "");
  const [type, setType] = useState(ex?.projectType ?? "");
  const [method, setMethod] = useState<ProjectBillingMethod>(ex?.billingMethod ?? "fixed_fee");
  const [amount, setAmount] = useState(ex?.billingAmount ?? "");
  const [po, setPo] = useState(ex?.poNumber ?? "");
  const [budget, setBudget] = useState(ex?.budgetHours ?? "");
  const [start, setStart] = useState(ex?.estimatedStart ?? "");
  const [end, setEnd] = useState(ex?.estimatedEnd ?? "");
  const [notes, setNotes] = useState(ex?.notes ?? "");
  const { busy, error, save } = useSave(props.onSaved);

  useEffect(() => {
    if (ex || companyId !== null || companyQuery.trim().length < 2) {
      setCompanies([]);
      return;
    }
    const ctl = new AbortController();
    const t = setTimeout(() => {
      listCompanies(companyQuery, ctl.signal)
        .then((r) => setCompanies(r.items.slice(0, 8).map((c) => ({ id: c.id, name: c.name }))))
        .catch(() => {});
    }, 200);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [ex, companyId, companyQuery]);

  const needsAmount = method !== "actual_rates";
  const valid =
    name.trim().length > 0 &&
    (ex ? true : companyId !== null) &&
    (!needsAmount || Number(amount) > 0);

  const go = () =>
    save(() =>
      ex
        ? updateProject(ex.id, {
            name: name.trim(),
            projectType: type.trim() || null,
            billingMethod: method,
            billingAmount: needsAmount ? Number(amount) : null,
            poNumber: po.trim() || null,
            budgetHours: num(String(budget)),
            estimatedStart: start || null,
            estimatedEnd: end || null,
            notes: notes.trim() || null,
          })
        : createProject({
            companyId: companyId as number,
            name: name.trim(),
            projectType: type.trim() || undefined,
            billingMethod: method,
            billingAmount: needsAmount ? Number(amount) : undefined,
            poNumber: po.trim() || undefined,
            budgetHours: num(String(budget)) ?? undefined,
            estimatedStart: start || undefined,
            estimatedEnd: end || undefined,
            notes: notes.trim() || undefined,
          }),
    );

  return (
    <dialog open className="dialog wide" aria-label={ex ? "Edit project" : "New project"}>
      <h3>{ex ? "Edit project" : "New project"}</h3>
      {error && <div className="state error">{error}</div>}
      {ex ? (
        <div className="muted">{ex.company}</div>
      ) : (
        <>
          <label>
            Customer
            <input
              className="input"
              placeholder="Type to search"
              value={companyQuery}
              onChange={(e) => {
                setCompanyQuery(e.target.value);
                setCompanyId(null);
              }}
            />
          </label>
          {companyId === null && companies.length > 0 && (
            <ul className="picker">
              {companies.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setCompanyId(c.id);
                      setCompanyQuery(c.name);
                    }}
                  >
                    {c.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <div className="field-grid">
        <label>
          Project name
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Type (optional)
          <input
            className="input"
            placeholder="Installation - CCTV"
            value={type}
            onChange={(e) => setType(e.target.value)}
          />
        </label>
        <BillingTerms
          method={method}
          amount={String(amount)}
          onMethod={setMethod}
          onAmount={setAmount}
        />
        <label>
          Customer PO (optional)
          <input className="input" value={po} onChange={(e) => setPo(e.target.value)} />
        </label>
        <label>
          Budget hours (optional)
          <input
            className="input"
            inputMode="decimal"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
          />
        </label>
        <label>
          Estimated start
          <input
            className="input"
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>
        <label>
          Estimated end
          <input
            className="input"
            type="date"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </label>
      </div>
      <label>
        Notes
        <textarea
          className="input"
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </label>
      <div className="field-row end">
        <button type="button" className="btn" onClick={props.onClose}>
          Cancel
        </button>
        <button type="button" className="btn primary" disabled={busy || !valid} onClick={go}>
          {ex ? "Save" : "Create project"}
        </button>
      </div>
    </dialog>
  );
}

function PhaseDialog(props: {
  projectId: number;
  phase: Phase | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const ph = props.phase;
  const [name, setName] = useState(ph?.name ?? "");
  const [budget, setBudget] = useState(ph?.budgetHours ?? "");
  const [separate, setSeparate] = useState(ph?.billSeparately ?? false);
  const [method, setMethod] = useState<ProjectBillingMethod>(ph?.billingMethod ?? "fixed_fee");
  const [amount, setAmount] = useState(ph?.billingAmount ?? "");
  const { busy, error, save } = useSave(props.onSaved);
  const needsAmount = separate && method !== "actual_rates";
  const valid = name.trim().length > 0 && (!needsAmount || Number(amount) > 0);

  const go = () =>
    save(async () => {
      const common = {
        name: name.trim(),
        billSeparately: separate,
        billingMethod: separate ? method : undefined,
        billingAmount: needsAmount ? Number(amount) : undefined,
      };
      if (ph) {
        await updatePhase(props.projectId, ph.id, {
          name: common.name,
          budgetHours: num(String(budget)),
          billSeparately: separate,
          billingMethod: separate ? method : null,
          billingAmount: needsAmount ? Number(amount) : null,
        });
      } else {
        await createPhase(props.projectId, {
          ...common,
          budgetHours: num(String(budget)) ?? undefined,
        });
      }
    });

  const remove = () =>
    save(async () => {
      if (ph) await deletePhase(props.projectId, ph.id);
    });

  return (
    <dialog open className="dialog" aria-label={ph ? "Edit phase" : "Add phase"}>
      <h3>{ph ? "Edit phase" : "Add phase"}</h3>
      {error && <div className="state error">{error}</div>}
      <label>
        Name
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Budget hours (optional)
        <input
          className="input"
          inputMode="decimal"
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
        />
      </label>
      <label className="check">
        <input type="checkbox" checked={separate} onChange={(e) => setSeparate(e.target.checked)} />{" "}
        Bill this phase separately from the project
      </label>
      {separate && (
        <BillingTerms
          method={method}
          amount={String(amount)}
          onMethod={setMethod}
          onAmount={setAmount}
        />
      )}
      <div className="field-row end">
        {ph && ph.ticketCount === 0 && (
          <button type="button" className="btn" disabled={busy} onClick={remove}>
            Delete phase
          </button>
        )}
        <button type="button" className="btn" onClick={props.onClose}>
          Cancel
        </button>
        <button type="button" className="btn primary" disabled={busy || !valid} onClick={go}>
          Save
        </button>
      </div>
    </dialog>
  );
}

function ProjectTicketDialog(props: {
  project: Project;
  lookups: Lookups;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [summary, setSummary] = useState("");
  const [boardId, setBoardId] = useState(props.lookups.boards[0]?.id ?? 0);
  const [phaseId, setPhaseId] = useState(0);
  const { busy, error, save } = useSave(props.onSaved);
  return (
    <dialog open className="dialog" aria-label="New project ticket">
      <h3>New ticket for {props.project.name}</h3>
      {error && <div className="state error">{error}</div>}
      <label>
        Summary
        <input className="input" value={summary} onChange={(e) => setSummary(e.target.value)} />
      </label>
      <label>
        Board
        <select
          className="input"
          value={boardId}
          onChange={(e) => setBoardId(Number(e.target.value))}
        >
          {props.lookups.boards.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Phase
        <select
          className="input"
          value={phaseId}
          onChange={(e) => setPhaseId(Number(e.target.value))}
        >
          <option value={0}>No phase</option>
          {props.project.phases?.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </select>
      </label>
      <div className="field-row end">
        <button type="button" className="btn" onClick={props.onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={busy || summary.trim().length === 0 || boardId === 0}
          onClick={() =>
            save(async () => {
              await createTicket({
                summary: summary.trim(),
                companyId: props.project.companyId,
                boardId,
                projectId: props.project.id,
                phaseId: phaseId || undefined,
              });
            })
          }
        >
          Create ticket
        </button>
      </div>
    </dialog>
  );
}

/** Bills one scope: time and materials, or a fixed fee as deposit, progress and final. Always a draft first. */
function BillDialog(props: {
  project: Project;
  scope: ProjectBillingScope;
  onClose: () => void;
  onDone: () => void;
}) {
  const sc = props.scope;
  const fixed = sc.billingMethod === "fixed_fee";
  const [mode, setMode] = useState<ProjectBillingMode>(fixed ? "progress" : "time_materials");
  const [by, setBy] = useState<"amount" | "percent">("percent");
  const [value, setValue] = useState("");
  const [description, setDescription] = useState("");
  const [through, setThrough] = useState(todayIso());
  const [invoiceDate, setInvoiceDate] = useState(todayIso());
  const [preview, setPreview] = useState<BillingRunPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const feeMode = mode === "deposit" || mode === "progress";
  const target = () => ({
    kind: "project" as const,
    projectId: props.project.id,
    phaseId: sc.phaseId ?? undefined,
    mode,
    throughDate: mode === "time_materials" ? through : undefined,
    amount: feeMode && by === "amount" ? Number(value) : undefined,
    percent: feeMode && by === "percent" ? Number(value) : undefined,
    description: feeMode && description.trim() ? description.trim() : undefined,
  });
  const ready = !feeMode || Number(value) > 0;

  const run = async (create: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (create) {
        await createBillingRun(target(), invoiceDate);
        props.onDone();
        return;
      }
      setPreview(await previewBillingRun(target(), invoiceDate));
    } catch (e) {
      setPreview(null);
      setError(msg(e));
    }
    setBusy(false);
  };

  return (
    <dialog
      open
      className="dialog wide"
      aria-label="Bill project"
      style={{ width: "min(720px, 92vw)" }}
    >
      <h3>Bill {sc.name}</h3>
      {error && <div className="state error">{error}</div>}
      {fixed && (
        <p className="muted small">
          Fixed fee {usd(sc.billingAmount ?? 0)}: {usd(sc.feeBilled)} billed,{" "}
          {usd(sc.feeRemaining ?? 0)} left.
        </p>
      )}
      <div className="field-grid">
        {fixed ? (
          <label>
            What to bill
            <select
              className="input"
              value={mode}
              onChange={(e) => {
                setMode(e.target.value as ProjectBillingMode);
                setPreview(null);
              }}
            >
              <option value="deposit">Down payment</option>
              <option value="progress">Progress or milestone payment</option>
              <option value="final">Final invoice (rest of the fee and materials)</option>
            </select>
          </label>
        ) : (
          <label>
            Bill time and materials through
            <input
              className="input"
              type="date"
              value={through}
              onChange={(e) => {
                setThrough(e.target.value);
                setPreview(null);
              }}
            />
          </label>
        )}
        <label>
          Invoice date
          <input
            className="input"
            type="date"
            value={invoiceDate}
            onChange={(e) => setInvoiceDate(e.target.value)}
          />
        </label>
        {feeMode && (
          <>
            <label>
              Bill by
              <select
                className="input"
                value={by}
                onChange={(e) => {
                  setBy(e.target.value as "amount" | "percent");
                  setPreview(null);
                }}
              >
                <option value="percent">Percent of the fixed fee</option>
                <option value="amount">Dollar amount</option>
              </select>
            </label>
            <label>
              {by === "percent" ? "Percent" : "Amount ($)"}
              <input
                className="input"
                inputMode="decimal"
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  setPreview(null);
                }}
              />
            </label>
            <label>
              Line wording (optional)
              <input
                className="input"
                placeholder="Milestone 2: rough-in complete"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
          </>
        )}
      </div>
      {mode === "final" && sc.unapprovedEntries > 0 && (
        <div className="state error">
          {sc.unapprovedEntries} time entries are not approved yet; the final invoice needs them
          approved.
        </div>
      )}
      <div className="field-row">
        <button type="button" className="btn" disabled={busy || !ready} onClick={() => run(false)}>
          Preview
        </button>
      </div>
      {preview && (
        <div className="card">
          {preview.invoices.map((inv) => (
            <div key={inv.companyId}>
              <strong>{inv.company}</strong>: subtotal {usd(inv.subtotal)}, tax {usd(inv.taxTotal)},
              total {usd(inv.total)}
              <ul>
                {(inv.lines ?? []).map((l) => (
                  <li key={`${l.lineNo}-${l.description}`}>
                    {l.description} <span className="muted">{usd(l.amount)}</span>
                  </li>
                ))}
              </ul>
              {inv.warnings.map((w) => (
                <div key={w} className="muted small">
                  {w}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      <div className="field-row end">
        <button type="button" className="btn" onClick={props.onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={busy || !ready || !preview || preview.invoices.length === 0}
          onClick={() => run(true)}
        >
          Create draft invoice
        </button>
      </div>
    </dialog>
  );
}
