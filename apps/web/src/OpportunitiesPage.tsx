import type {
  Activity,
  ActivityKind,
  ExternalEntityType,
  ExternalKind,
  ExternalProvider,
  ExternalRef,
  Opportunity,
  SalesStage,
} from "@hoosier/shared";
import { useCallback, useEffect, useState } from "react";
import {
  type Lookups,
  createActivity,
  createExternalRef,
  createOpportunity,
  deleteActivity,
  deleteExternalRef,
  getOpportunity,
  getPipeline,
  listActivities,
  listCompanies,
  listExternalRefs,
  listOpportunities,
  listSalesStages,
  updateActivity,
  updateOpportunity,
} from "./api";
import { msg, shortDate, usd } from "./common";
import { Link, navigate } from "./router";

const ACTIVITY_LABEL: Record<ActivityKind, string> = {
  call: "Call",
  email: "Email",
  meeting: "Meeting",
  site_visit: "Site visit",
  note: "Note",
  task: "Task",
};
const PROVIDER_LABEL: Record<ExternalProvider, string> = {
  smart_pricing_tables: "Smart Pricing Tables",
  sembleai: "SembleAI",
  other: "Other",
};
const KIND_LABEL: Record<ExternalKind, string> = {
  quote: "Quote",
  estimate: "Estimate",
  design: "Design",
  document: "Document",
  other: "Other",
};

export function OpportunitiesPage(props: {
  can: (key: string) => boolean;
  lookups: Lookups | null;
  routeId: number | null;
}) {
  return props.routeId === null ? (
    <OpportunityList can={props.can} />
  ) : (
    <OpportunityDetail
      key={props.routeId}
      id={props.routeId}
      can={props.can}
      lookups={props.lookups}
    />
  );
}

function OpportunityList({ can }: { can: (key: string) => boolean }) {
  const [q, setQ] = useState("");
  const [state, setState] = useState<"open" | "won" | "lost" | "all">("open");
  const [stageId, setStageId] = useState(0);
  const [stages, setStages] = useState<SalesStage[]>([]);
  const [items, setItems] = useState<Opportunity[] | null>(null);
  const [pipeline, setPipeline] = useState<Awaited<ReturnType<typeof getPipeline>>["items"]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    listSalesStages()
      .then((r) => setStages(r.items))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const ctl = new AbortController();
    const t = setTimeout(() => {
      Promise.all([
        listOpportunities(
          { q: q.trim() || undefined, state, stageId: stageId || undefined },
          ctl.signal,
        ),
        getPipeline(ctl.signal),
      ])
        .then(([r, p]) => {
          setItems(r.items);
          setPipeline(p.items);
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
  }, [q, state, stageId]);

  const totalWeighted = pipeline.reduce((a, p) => a + Number(p.weightedAmount), 0);

  return (
    <>
      <div className="page-header">
        <h2>Opportunities</h2>
        {can("sales.opportunity.write") && (
          <button type="button" className="btn primary" onClick={() => setCreating(true)}>
            New opportunity
          </button>
        )}
      </div>
      <div className="card">
        <div className="field-row">
          {pipeline.map((p) => (
            <button
              type="button"
              key={p.stageId}
              className="btn"
              onClick={() => {
                setState("open");
                setStageId(stageId === p.stageId ? 0 : p.stageId);
              }}
              aria-pressed={stageId === p.stageId}
            >
              {p.stage}: {p.count} · {usd(p.amount)}
            </button>
          ))}
        </div>
        <div className="muted small">Weighted open pipeline {usd(totalWeighted)}</div>
      </div>
      <div className="card">
        <div className="toolbar">
          <input
            className="input"
            placeholder="Search by opportunity or company"
            aria-label="Search opportunities"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select
            className="input"
            aria-label="Show"
            value={state}
            onChange={(e) => setState(e.target.value as typeof state)}
          >
            <option value="open">Open</option>
            <option value="won">Won</option>
            <option value="lost">Lost</option>
            <option value="all">All</option>
          </select>
          <select
            className="input"
            aria-label="Stage"
            value={stageId}
            onChange={(e) => setStageId(Number(e.target.value))}
          >
            <option value={0}>All stages</option>
            {stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        {error && <div className="state error">{error}</div>}
        {!items && !error && <div className="state">Loading…</div>}
        {items && items.length === 0 && <div className="state">No opportunities match.</div>}
        {items && items.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Opportunity</th>
                <th>Customer</th>
                <th>Stage</th>
                <th>Owner</th>
                <th>Close</th>
                <th className="num">Amount</th>
                <th className="num">Weighted</th>
              </tr>
            </thead>
            <tbody>
              {items.map((o) => (
                <tr key={o.id}>
                  <td>
                    <Link to={`/opportunities/${o.id}`}>{o.name}</Link>
                    {o.openTasks > 0 && (
                      <span className="badge status-pending">{o.openTasks} tasks</span>
                    )}
                  </td>
                  <td>{o.company}</td>
                  <td>{o.stage}</td>
                  <td>{o.owner ?? "—"}</td>
                  <td>{o.expectedClose ? shortDate(o.expectedClose) : "—"}</td>
                  <td className="num">{o.expectedAmount ? usd(o.expectedAmount) : "—"}</td>
                  <td className="num">{usd(o.weightedAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {creating && (
        <OpportunityDialog
          onClose={() => setCreating(false)}
          onSaved={(o) => navigate(`/opportunities/${o.id}`)}
        />
      )}
    </>
  );
}

function OpportunityDetail(props: {
  id: number;
  can: (key: string) => boolean;
  lookups: Lookups | null;
}) {
  const [opp, setOpp] = useState<Opportunity | null>(null);
  const [stages, setStages] = useState<SalesStage[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [lostFor, setLostFor] = useState<number | null>(null);
  const canWrite = props.can("sales.opportunity.write");
  const refresh = useCallback(() => setReload((n) => n + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload is a manual refetch trigger
  useEffect(() => {
    const ctl = new AbortController();
    Promise.all([
      getOpportunity(props.id, ctl.signal),
      listActivities(props.id, ctl.signal),
      listSalesStages(),
    ])
      .then(([o, a, s]) => {
        setOpp(o);
        setActivities(a.items);
        setStages(s.items);
        setError(null);
      })
      .catch((e) => {
        if (!ctl.signal.aborted) setError(msg(e));
      });
    return () => ctl.abort();
  }, [props.id, reload]);

  const moveTo = async (stageId: number, lostReason?: string) => {
    try {
      await updateOpportunity(props.id, { stageId, ...(lostReason ? { lostReason } : {}) });
      setLostFor(null);
      refresh();
    } catch (e) {
      setError(msg(e));
    }
  };

  if (error && !opp) return <div className="state error">{error}</div>;
  if (!opp) return <div className="state">Loading…</div>;

  return (
    <>
      <div className="page-header">
        <h2>
          <Link to="/opportunities">Opportunities</Link> / {opp.name}
        </h2>
        {canWrite && (
          <select
            className="input"
            aria-label="Stage"
            value={opp.stageId}
            onChange={(e) => {
              const s = stages.find((x) => x.id === Number(e.target.value));
              if (s?.isLost) setLostFor(s.id);
              else void moveTo(Number(e.target.value));
            }}
          >
            {stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {error && <div className="state error">{error}</div>}
      <div className="card">
        <div className="field-grid">
          <div>
            <div className="muted small">Customer</div>
            <Link to={`/companies/${opp.companyId}`}>{opp.company}</Link>
            {opp.site && <span className="muted"> · {opp.site}</span>}
          </div>
          <div>
            <div className="muted small">Contact</div>
            {opp.contact ?? "—"}
          </div>
          <div>
            <div className="muted small">Stage</div>
            {opp.stage} ({opp.probability}%)
          </div>
          <div>
            <div className="muted small">Expected</div>
            {opp.expectedAmount ? usd(opp.expectedAmount) : "—"}
            {opp.expectedClose ? `, closing ${shortDate(opp.expectedClose)}` : ""}
          </div>
          <div>
            <div className="muted small">Owner</div>
            {opp.owner ?? "—"}
          </div>
          {opp.lostReason && (
            <div>
              <div className="muted small">Lost because</div>
              {opp.lostReason}
            </div>
          )}
        </div>
        {opp.notes && <p className="muted">{opp.notes}</p>}
      </div>

      <div className="card">
        <h3>Quotes, estimates and designs</h3>
        <ExternalRefs entityType="opportunity" entityId={opp.id} canWrite={canWrite} />
      </div>

      <div className="card">
        <h3>Activity and tasks</h3>
        <ActivityPanel
          opportunityId={opp.id}
          items={activities}
          canWrite={canWrite}
          onChanged={refresh}
        />
      </div>

      {lostFor !== null && (
        <LostDialog onClose={() => setLostFor(null)} onLost={(reason) => moveTo(lostFor, reason)} />
      )}
    </>
  );
}

function LostDialog(props: { onClose: () => void; onLost: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  return (
    <dialog open className="dialog" aria-label="Mark lost">
      <h3>Why was it lost?</h3>
      <label>
        Reason
        <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <div className="field-row end">
        <button type="button" className="btn" onClick={props.onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={reason.trim().length < 3}
          onClick={() => props.onLost(reason.trim())}
        >
          Mark lost
        </button>
      </div>
    </dialog>
  );
}

function ActivityPanel(props: {
  opportunityId: number;
  items: Activity[];
  canWrite: boolean;
  onChanged: () => void;
}) {
  const [kind, setKind] = useState<ActivityKind>("note");
  const [subject, setSubject] = useState("");
  const [due, setDue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError(null);
      props.onChanged();
    } catch (e) {
      setError(msg(e));
    }
  };
  return (
    <>
      {error && <div className="state error">{error}</div>}
      {props.canWrite && (
        <div className="field-row">
          <select
            className="input"
            aria-label="Kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as ActivityKind)}
          >
            {(Object.keys(ACTIVITY_LABEL) as ActivityKind[]).map((k) => (
              <option key={k} value={k}>
                {ACTIVITY_LABEL[k]}
              </option>
            ))}
          </select>
          <input
            className="input"
            placeholder="What happened, or what needs doing"
            aria-label="Subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
          {kind === "task" && (
            <input
              className="input"
              type="date"
              aria-label="Due"
              value={due}
              onChange={(e) => setDue(e.target.value)}
            />
          )}
          <button
            type="button"
            className="btn"
            disabled={subject.trim().length === 0}
            onClick={() =>
              run(async () => {
                await createActivity(props.opportunityId, {
                  kind,
                  subject: subject.trim(),
                  dueDate: kind === "task" && due ? due : undefined,
                });
                setSubject("");
                setDue("");
              })
            }
          >
            Add
          </button>
        </div>
      )}
      {props.items.length === 0 && <div className="state">Nothing logged yet.</div>}
      {props.items.length > 0 && (
        <table>
          <tbody>
            {props.items.map((a) => (
              <tr key={a.id}>
                <td>
                  {a.kind === "task" && props.canWrite && (
                    <input
                      type="checkbox"
                      aria-label={`Complete ${a.subject}`}
                      checked={a.completedAt !== null}
                      onChange={(e) =>
                        run(() =>
                          updateActivity(props.opportunityId, a.id, {
                            completed: e.target.checked,
                          }),
                        )
                      }
                    />
                  )}
                </td>
                <td>{ACTIVITY_LABEL[a.kind]}</td>
                <td style={a.completedAt ? { textDecoration: "line-through" } : undefined}>
                  {a.subject}
                  {a.dueDate && <span className="muted"> · due {shortDate(a.dueDate)}</span>}
                </td>
                <td className="muted">{a.assignedTo ?? ""}</td>
                <td className="muted">{shortDate(a.createdAt.slice(0, 10))}</td>
                <td className="num">
                  {props.canWrite && (
                    <button
                      type="button"
                      className="btn"
                      onClick={() => run(() => deleteActivity(props.opportunityId, a.id))}
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

/** Links to a quote, estimate or design held in another system. Used on opportunities, orders and projects. */
export function ExternalRefs(props: {
  entityType: ExternalEntityType;
  entityId: number;
  canWrite: boolean;
}) {
  const [items, setItems] = useState<ExternalRef[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [reload, setReload] = useState(0);
  const [provider, setProvider] = useState<ExternalProvider>("smart_pricing_tables");
  const [kind, setKind] = useState<ExternalKind>("quote");
  const [externalId, setExternalId] = useState("");
  const [version, setVersion] = useState("");
  const [amount, setAmount] = useState("");
  const [url, setUrl] = useState("");

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload is a manual refetch trigger
  useEffect(() => {
    const ctl = new AbortController();
    listExternalRefs(props.entityType, props.entityId, ctl.signal)
      .then((r) => setItems(r.items))
      .catch((e) => {
        if (!ctl.signal.aborted) setError(msg(e));
      });
    return () => ctl.abort();
  }, [props.entityType, props.entityId, reload]);

  const add = async () => {
    try {
      await createExternalRef(props.entityType, props.entityId, {
        provider,
        kind,
        externalId: externalId.trim(),
        version: version.trim() || undefined,
        amount: amount ? Number(amount) : undefined,
        url: url.trim() || undefined,
      });
      setAdding(false);
      setExternalId("");
      setVersion("");
      setAmount("");
      setUrl("");
      setError(null);
      setReload((n) => n + 1);
    } catch (e) {
      setError(msg(e));
    }
  };

  return (
    <>
      {error && <div className="state error">{error}</div>}
      {items.length === 0 && !adding && (
        <div className="state">Nothing linked yet. Link a quote or design by its id.</div>
      )}
      {items.length > 0 && (
        <table>
          <tbody>
            {items.map((r) => (
              <tr key={r.id}>
                <td>{KIND_LABEL[r.kind]}</td>
                <td>{PROVIDER_LABEL[r.provider]}</td>
                <td>
                  {r.url ? (
                    <a className="link" href={r.url} target="_blank" rel="noreferrer noopener">
                      {r.title ?? r.externalId}
                    </a>
                  ) : (
                    (r.title ?? r.externalId)
                  )}
                  {r.version && <span className="muted"> v{r.version}</span>}
                </td>
                <td>{r.status ?? ""}</td>
                <td className="num">{r.amount ? usd(r.amount) : ""}</td>
                <td className="num">
                  {props.canWrite && (
                    <button
                      type="button"
                      className="btn"
                      onClick={async () => {
                        await deleteExternalRef(r.id).catch((e) => setError(msg(e)));
                        setReload((n) => n + 1);
                      }}
                    >
                      Unlink
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {props.canWrite && !adding && (
        <button type="button" className="btn" onClick={() => setAdding(true)}>
          Link a record
        </button>
      )}
      {adding && (
        <div className="field-row">
          <select
            className="input"
            aria-label="System"
            value={provider}
            onChange={(e) => setProvider(e.target.value as ExternalProvider)}
          >
            {(Object.keys(PROVIDER_LABEL) as ExternalProvider[]).map((p) => (
              <option key={p} value={p}>
                {PROVIDER_LABEL[p]}
              </option>
            ))}
          </select>
          <select
            className="input"
            aria-label="Type"
            value={kind}
            onChange={(e) => setKind(e.target.value as ExternalKind)}
          >
            {(Object.keys(KIND_LABEL) as ExternalKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
          <input
            className="input"
            placeholder="Id in that system"
            aria-label="External id"
            value={externalId}
            onChange={(e) => setExternalId(e.target.value)}
          />
          <input
            className="input"
            placeholder="Version"
            aria-label="Version"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
          />
          <input
            className="input"
            placeholder="Amount"
            aria-label="Amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <input
            className="input"
            placeholder="Link (https://…)"
            aria-label="Link"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button type="button" className="btn primary" disabled={!externalId.trim()} onClick={add}>
            Link
          </button>
          <button type="button" className="btn" onClick={() => setAdding(false)}>
            Cancel
          </button>
        </div>
      )}
    </>
  );
}

function OpportunityDialog(props: { onClose: () => void; onSaved: (o: Opportunity) => void }) {
  const [companyQuery, setCompanyQuery] = useState("");
  const [companyId, setCompanyId] = useState<number | null>(null);
  const [companies, setCompanies] = useState<Array<{ id: number; name: string }>>([]);
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [close, setClose] = useState("");
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (companyId !== null || companyQuery.trim().length < 2) {
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
  }, [companyId, companyQuery]);

  const go = async () => {
    setBusy(true);
    try {
      props.onSaved(
        await createOpportunity({
          companyId: companyId as number,
          name: name.trim(),
          expectedAmount: amount ? Number(amount) : undefined,
          expectedClose: close || undefined,
          source: source.trim() || undefined,
        }),
      );
    } catch (e) {
      setError(msg(e));
      setBusy(false);
    }
  };

  return (
    <dialog open className="dialog" aria-label="New opportunity">
      <h3>New opportunity</h3>
      {error && <div className="state error">{error}</div>}
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
      <label>
        Name
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="field-grid">
        <label>
          Expected amount ($)
          <input
            className="input"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <label>
          Expected close
          <input
            className="input"
            type="date"
            value={close}
            onChange={(e) => setClose(e.target.value)}
          />
        </label>
        <label>
          Source (optional)
          <input className="input" value={source} onChange={(e) => setSource(e.target.value)} />
        </label>
      </div>
      <div className="field-row end">
        <button type="button" className="btn" onClick={props.onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={busy || companyId === null || name.trim().length === 0}
          onClick={go}
        >
          Create
        </button>
      </div>
    </dialog>
  );
}
