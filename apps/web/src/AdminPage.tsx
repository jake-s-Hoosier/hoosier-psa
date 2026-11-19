import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type AdminMember,
  type AdminRole,
  type PermissionInfo,
  adminCreateRole,
  adminDeleteRole,
  adminMembers,
  adminPermissions,
  adminResetRole,
  adminRoles,
  adminSetMemberActive,
  adminSetMemberRoles,
  adminUpdateRole,
} from "./api";

const msg = (e: unknown) => (e instanceof Error ? e.message : "Request failed");

/** Roles, what each role allows, and who holds which role. The API refuses anything that would lock everyone out. */
export function AdminPage() {
  const [tab, setTab] = useState<"members" | "roles">("members");
  const [roles, setRoles] = useState<AdminRole[] | null>(null);
  const [members, setMembers] = useState<AdminMember[] | null>(null);
  const [permissions, setPermissions] = useState<PermissionInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    Promise.all([adminRoles(), adminMembers(), adminPermissions()])
      .then(([r, m, p]) => {
        setRoles(r.items);
        setMembers(m.items);
        setPermissions(p.items);
        setError(null);
      })
      .catch((e) => setError(msg(e)));
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);

  return (
    <>
      <div className="page-header">
        <h2>Access</h2>
        <div className="tabs" role="tablist">
          {(["members", "roles"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={`btn${tab === t ? " primary" : ""}`}
              onClick={() => setTab(t)}
            >
              {t === "members" ? "Members" : "Roles"}
            </button>
          ))}
        </div>
      </div>
      {error && <div className="state error">{error}</div>}
      {!roles || !members ? (
        !error && <div className="state">Loading…</div>
      ) : tab === "members" ? (
        <MembersTab roles={roles} members={members} onChanged={reload} onError={setError} />
      ) : (
        <RolesTab roles={roles} permissions={permissions} onChanged={reload} onError={setError} />
      )}
    </>
  );
}

function MembersTab(props: {
  roles: AdminRole[];
  members: AdminMember[];
  onChanged: () => void;
  onError: (m: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      props.onChanged();
    } catch (e) {
      props.onError(msg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card">
      <table>
        <thead>
          <tr>
            <th>Member</th>
            <th>Sign-in</th>
            <th>Roles</th>
            <th>Active</th>
          </tr>
        </thead>
        <tbody>
          {props.members.map((m) => (
            <tr key={m.id} className={m.isActive ? undefined : "muted"}>
              <td>
                {m.firstName} {m.lastName}
                <div className="muted">{m.identifier}</div>
              </td>
              <td>
                {m.hasLogin ? (m.mfaEnabled ? "Password + MFA" : "Password only") : "No login"}
              </td>
              <td>
                <div className="chips">
                  {props.roles.map((r) => (
                    <label key={r.id} className="chip">
                      <input
                        type="checkbox"
                        disabled={busy}
                        checked={m.roleIds.includes(r.id)}
                        onChange={(e) =>
                          run(() =>
                            adminSetMemberRoles(
                              m.id,
                              e.target.checked
                                ? [...m.roleIds, r.id]
                                : m.roleIds.filter((x) => x !== r.id),
                            ),
                          )
                        }
                      />
                      {r.name}
                    </label>
                  ))}
                </div>
              </td>
              <td>
                <input
                  type="checkbox"
                  aria-label={`${m.firstName} ${m.lastName} is active`}
                  disabled={busy}
                  checked={m.isActive}
                  onChange={(e) => run(() => adminSetMemberActive(m.id, e.target.checked))}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">
        Logins and temporary passwords are still created with <code>pnpm auth set-password</code>.
        Deactivating a member signs them out everywhere.
      </p>
    </div>
  );
}

function RolesTab(props: {
  roles: AdminRole[];
  permissions: PermissionInfo[];
  onChanged: () => void;
  onError: (m: string | null) => void;
}) {
  const [selectedId, setSelectedId] = useState<number | null>(props.roles[0]?.id ?? null);
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const selected = props.roles.find((r) => r.id === selectedId) ?? null;

  // Reset the editor whenever a different role is chosen or its saved grants change.
  const savedKey = selected ? selected.permissions.join(",") : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: savedKey stands in for selected.permissions
  useEffect(() => {
    setDraft(new Set(selected?.permissions ?? []));
  }, [selectedId, savedKey]);

  const groups = useMemo(() => {
    const by = new Map<string, PermissionInfo[]>();
    for (const p of props.permissions) {
      const module = p.key.split(".")[0] ?? "other";
      by.set(module, [...(by.get(module) ?? []), p]);
    }
    return [...by.entries()];
  }, [props.permissions]);

  const dirty =
    selected !== null &&
    (draft.size !== selected.permissions.length || selected.permissions.some((k) => !draft.has(k)));

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      props.onError(null);
      props.onChanged();
    } catch (e) {
      props.onError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="split">
      <div className="card">
        <ul className="plain-list">
          {props.roles.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                className="link"
                aria-current={r.id === selectedId ? "true" : undefined}
                onClick={() => setSelectedId(r.id)}
              >
                {r.name}
              </button>
              <span className="muted">
                {" "}
                · {r.memberCount} member{r.memberCount === 1 ? "" : "s"}
                {r.isSystem ? (r.customized ? " · customized" : " · built-in") : ""}
              </span>
            </li>
          ))}
        </ul>
        {creating ? (
          <div className="field-row">
            <input
              className="input"
              placeholder="Role name"
              aria-label="New role name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <button
              type="button"
              className="btn primary"
              disabled={busy || newName.trim().length < 2}
              onClick={() =>
                run(async () => {
                  const created = await adminCreateRole({ name: newName.trim(), permissions: [] });
                  setNewName("");
                  setCreating(false);
                  setSelectedId(created.id);
                })
              }
            >
              Create
            </button>
            <button type="button" className="btn" onClick={() => setCreating(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button type="button" className="btn" onClick={() => setCreating(true)}>
            New role
          </button>
        )}
      </div>

      {selected && (
        <aside className="card detail">
          <h3>{selected.name}</h3>
          {selected.description && <p className="muted">{selected.description}</p>}
          {groups.map(([module, items]) => (
            <fieldset key={module} className="perm-group">
              <legend>{module}</legend>
              {items.map((p) => (
                <label key={p.key} className="perm">
                  <input
                    type="checkbox"
                    checked={draft.has(p.key)}
                    disabled={busy}
                    onChange={(e) => {
                      const next = new Set(draft);
                      if (e.target.checked) next.add(p.key);
                      else next.delete(p.key);
                      setDraft(next);
                    }}
                  />
                  <span>
                    {p.description}
                    <span className="muted"> {p.key}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          ))}
          <div className="field-row">
            <button
              type="button"
              className="btn primary"
              disabled={busy || !dirty || (draft.size === 0 && selected.isSystem)}
              onClick={() =>
                run(() => adminUpdateRole(selected.id, { permissions: [...draft].sort() }))
              }
            >
              Save changes
            </button>
            {selected.isSystem && selected.customized && (
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => run(() => adminResetRole(selected.id))}
              >
                Reset to defaults
              </button>
            )}
            {!selected.isSystem && (
              <button
                type="button"
                className="btn"
                disabled={busy || selected.memberCount > 0}
                title={selected.memberCount > 0 ? "Remove it from its members first" : undefined}
                onClick={() =>
                  run(async () => {
                    await adminDeleteRole(selected.id);
                    setSelectedId(null);
                  })
                }
              >
                Delete role
              </button>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}
