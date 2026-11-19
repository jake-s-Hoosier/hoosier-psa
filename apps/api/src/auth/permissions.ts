import {
  DEFAULT_ROLE_GRANTS,
  PERMISSIONS,
  type PermissionKey,
  isPermissionKey,
} from "@hoosier/shared";

interface Queryable {
  query<R = unknown>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

/**
 * What a member may do: the union of their roles' grants.
 *
 * A role's grants come from `iam.role_permission` once an administrator has set any for it. A system
 * role with no stored grants uses the defaults in `packages/shared/src/permissions.ts`, so a fresh
 * database (and the read-only shadow, which is never written) works without a seeding step.
 * Keys no longer defined in code are ignored.
 */
export async function loadPermissions(
  db: Queryable,
  memberId: number,
): Promise<Set<PermissionKey>> {
  const { rows } = await db.query<{
    role_name: string;
    is_system: boolean;
    permission_key: string | null;
  }>(
    `SELECT r.name::text AS role_name, r.is_system, rp.permission_key
       FROM iam.member_role mr
       JOIN iam.role r ON r.id = mr.role_id
       LEFT JOIN iam.role_permission rp ON rp.role_id = r.id
      WHERE mr.member_id = $1`,
    [memberId],
  );
  const stored = new Map<string, Set<string>>();
  const systemRoles = new Set<string>();
  for (const r of rows) {
    const keys = stored.get(r.role_name) ?? new Set<string>();
    if (r.permission_key) keys.add(r.permission_key);
    stored.set(r.role_name, keys);
    if (r.is_system) systemRoles.add(r.role_name);
  }
  const result = new Set<PermissionKey>();
  for (const [role, keys] of stored) {
    const effective =
      keys.size > 0
        ? [...keys]
        : systemRoles.has(role)
          ? [...(DEFAULT_ROLE_GRANTS[role] ?? [])]
          : [];
    for (const k of effective) if (isPermissionKey(k)) result.add(k);
  }
  return result;
}

/** Keeps `iam.permission` in step with the keys defined in code so grants can reference them. */
export async function syncPermissions(db: Queryable): Promise<{ added: number; removed: number }> {
  const keys = Object.keys(PERMISSIONS) as PermissionKey[];
  const added = await db.query<{ key: string }>(
    `INSERT INTO iam.permission (key, description)
     SELECT k, d FROM unnest($1::text[], $2::text[]) AS t(k, d)
     ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description
     RETURNING key`,
    [keys, keys.map((k) => PERMISSIONS[k])],
  );
  const removed = await db.query<{ key: string }>(
    "DELETE FROM iam.permission WHERE key <> ALL($1::text[]) RETURNING key",
    [keys],
  );
  return { added: added.rows.length, removed: removed.rows.length };
}

/**
 * What a route requires, declared in its `config`:
 *  - a permission key, or an array meaning "any of these"
 *  - "authenticated": any fully signed-in member (reference data, own session)
 *  - "signin": the sign-in endpoints, which enforce their own step order
 * A route that declares nothing is refused (deny by default) and fails the route-table test.
 */
export type RoutePermission = PermissionKey | readonly PermissionKey[] | "authenticated" | "signin";

export function satisfies(required: RoutePermission, held: ReadonlySet<string>): boolean {
  if (required === "authenticated" || required === "signin") return true;
  if (typeof required === "string") return held.has(required);
  return required.some((k) => held.has(k));
}
