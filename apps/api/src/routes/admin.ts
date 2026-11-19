import { withActor } from "@hoosier/db";
import { DEFAULT_ROLE_GRANTS, PERMISSIONS, idSchema, isPermissionKey } from "@hoosier/shared";
import type { FastifyPluginAsync } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { syncPermissions } from "../auth/permissions.js";
import { HttpError } from "../errors.js";

type Db = pg.Pool | pg.PoolClient;

interface RoleView {
  id: number;
  name: string;
  description: string | null;
  isSystem: boolean;
  /** True when an administrator has saved grants for this role; false means the built-in defaults apply. */
  customized: boolean;
  permissions: string[];
  memberCount: number;
}

/** Every role with its effective grants: saved rows if any, else the system defaults. */
async function loadRoles(db: Db): Promise<RoleView[]> {
  const { rows } = await db.query<{
    id: string;
    name: string;
    description: string | null;
    is_system: boolean;
    keys: string[] | null;
    members: string;
  }>(
    `SELECT r.id, r.name::text AS name, r.description, r.is_system,
            (SELECT array_agg(rp.permission_key ORDER BY rp.permission_key)
               FROM iam.role_permission rp WHERE rp.role_id = r.id) AS keys,
            (SELECT count(*) FROM iam.member_role mr WHERE mr.role_id = r.id) AS members
       FROM iam.role r ORDER BY r.is_system DESC, r.name`,
  );
  return rows.map((r) => {
    const stored = r.keys?.filter(isPermissionKey) ?? [];
    const customized = (r.keys?.length ?? 0) > 0;
    const defaults = r.is_system ? [...(DEFAULT_ROLE_GRANTS[r.name] ?? [])] : [];
    return {
      id: Number(r.id),
      name: r.name,
      description: r.description,
      isSystem: r.is_system,
      customized,
      permissions: (customized ? stored : defaults).sort(),
      memberCount: Number(r.members),
    };
  });
}

/** A change must never leave the system with nobody able to manage roles. */
async function assertSomeoneCanManage(db: Db): Promise<void> {
  const roles = await loadRoles(db);
  const managing = roles.filter((r) => r.permissions.includes("iam.manage")).map((r) => r.id);
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(DISTINCT m.id) AS n
       FROM iam.member m JOIN iam.member_role mr ON mr.member_id = m.id
      WHERE m.is_active AND mr.role_id = ANY($1::bigint[])`,
    [managing],
  );
  if (Number(rows[0]?.n) === 0) {
    throw new HttpError(
      409,
      "Would lock everyone out",
      "At least one active member must keep a role with the iam.manage permission",
    );
  }
}

const permissionList = z
  .array(z.string())
  .max(200)
  .superRefine((keys, ctx) => {
    const bad = keys.filter((k) => !isPermissionKey(k));
    if (bad.length)
      ctx.addIssue({ code: "custom", message: `Unknown permissions: ${bad.join(", ")}` });
  });

const roleName = z.string().trim().min(2).max(60);
const roleCreateSchema = z.object({
  name: roleName,
  description: z.string().trim().max(300).nullish(),
  permissions: permissionList,
});
const roleUpdateSchema = z
  .object({
    name: roleName.optional(),
    description: z.string().trim().max(300).nullable().optional(),
    permissions: permissionList.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" });

/** Roles, grants and member access. Everything here needs iam.manage. */
export const adminRoutes: FastifyPluginAsync = async (app) => {
  app.get("/permissions", { config: { perm: "iam.manage" } }, async () => ({
    items: Object.entries(PERMISSIONS).map(([key, description]) => ({ key, description })),
  }));

  app.get("/roles", { config: { perm: "iam.manage" } }, async () => ({
    items: await loadRoles(app.pool),
  }));

  app.post("/roles", { config: { perm: "iam.manage" } }, async (req, reply) => {
    const body = roleCreateSchema.parse(req.body);
    const created = await withActor(app.pool, req.memberId, async (client) => {
      await syncPermissions(client);
      const dup = await client.query("SELECT 1 FROM iam.role WHERE name = $1", [body.name]);
      if (dup.rowCount)
        throw new HttpError(409, "Duplicate role", `A role named "${body.name}" exists`);
      const { rows } = await client.query<{ id: string }>(
        "INSERT INTO iam.role (name, description, is_system) VALUES ($1,$2,false) RETURNING id",
        [body.name, body.description ?? null],
      );
      const id = Number(rows[0]?.id);
      for (const key of new Set(body.permissions)) {
        await client.query(
          "INSERT INTO iam.role_permission (role_id, permission_key) VALUES ($1,$2)",
          [id, key],
        );
      }
      return (await loadRoles(client)).find((r) => r.id === id);
    });
    return reply.status(201).send(created);
  });

  app.patch("/roles/:id", { config: { perm: "iam.manage" } }, async (req) => {
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = roleUpdateSchema.parse(req.body);
    return withActor(app.pool, req.memberId, async (client) => {
      const role = (await loadRoles(client)).find((r) => r.id === id);
      if (!role) throw new HttpError(404, "Not Found", `Role ${id} not found`);
      if (body.name !== undefined && role.isSystem && body.name !== role.name)
        throw new HttpError(422, "System role", "Built-in roles cannot be renamed");
      if (body.name !== undefined && body.name !== role.name) {
        const dup = await client.query("SELECT 1 FROM iam.role WHERE name = $1 AND id <> $2", [
          body.name,
          id,
        ]);
        if (dup.rowCount)
          throw new HttpError(409, "Duplicate role", `A role named "${body.name}" exists`);
      }
      if (body.permissions !== undefined) {
        const keys = [...new Set(body.permissions)];
        // A built-in role with no saved rows falls back to its defaults, so an empty set would
        // silently restore them. Make the intent explicit instead.
        if (keys.length === 0 && role.isSystem)
          throw new HttpError(
            422,
            "Empty built-in role",
            "A built-in role needs at least one permission; reset it to defaults or use a custom role",
          );
        await syncPermissions(client);
        await client.query("DELETE FROM iam.role_permission WHERE role_id = $1", [id]);
        for (const key of keys) {
          await client.query(
            "INSERT INTO iam.role_permission (role_id, permission_key) VALUES ($1,$2)",
            [id, key],
          );
        }
      }
      if (body.name !== undefined || body.description !== undefined) {
        await client.query(
          "UPDATE iam.role SET name = COALESCE($2, name), description = CASE WHEN $3 THEN $4 ELSE description END WHERE id = $1",
          [id, body.name ?? null, body.description !== undefined, body.description ?? null],
        );
      }
      await assertSomeoneCanManage(client);
      return (await loadRoles(client)).find((r) => r.id === id);
    });
  });

  // Built-in roles only: drop the saved grants so the code defaults apply again.
  app.post("/roles/:id/reset", { config: { perm: "iam.manage" } }, async (req) => {
    const { id } = z.object({ id: idSchema }).parse(req.params);
    return withActor(app.pool, req.memberId, async (client) => {
      const role = (await loadRoles(client)).find((r) => r.id === id);
      if (!role) throw new HttpError(404, "Not Found", `Role ${id} not found`);
      if (!role.isSystem)
        throw new HttpError(422, "Custom role", "Only built-in roles have defaults");
      await client.query("DELETE FROM iam.role_permission WHERE role_id = $1", [id]);
      await assertSomeoneCanManage(client);
      return (await loadRoles(client)).find((r) => r.id === id);
    });
  });

  app.delete("/roles/:id", { config: { perm: "iam.manage" } }, async (req, reply) => {
    const { id } = z.object({ id: idSchema }).parse(req.params);
    await withActor(app.pool, req.memberId, async (client) => {
      const role = (await loadRoles(client)).find((r) => r.id === id);
      if (!role) throw new HttpError(404, "Not Found", `Role ${id} not found`);
      if (role.isSystem)
        throw new HttpError(422, "System role", "Built-in roles cannot be deleted");
      if (role.memberCount > 0)
        throw new HttpError(
          409,
          "Role in use",
          `${role.memberCount} member(s) still hold this role`,
        );
      await client.query("DELETE FROM iam.role WHERE id = $1", [id]);
    });
    return reply.status(204).send();
  });

  app.get("/members", { config: { perm: "iam.manage" } }, async () => {
    const { rows } = await app.pool.query<{
      id: string;
      identifier: string;
      first_name: string;
      last_name: string;
      email: string;
      is_active: boolean;
      has_login: boolean;
      mfa: boolean;
      role_ids: string[] | null;
    }>(
      `SELECT m.id, m.identifier::text AS identifier, m.first_name, m.last_name, m.email::text AS email,
              m.is_active, (c.member_id IS NOT NULL) AS has_login,
              (c.mfa_enabled_at IS NOT NULL) AS mfa,
              (SELECT array_agg(mr.role_id ORDER BY mr.role_id) FROM iam.member_role mr
                WHERE mr.member_id = m.id) AS role_ids
         FROM iam.member m LEFT JOIN iam.member_credential c ON c.member_id = m.id
        ORDER BY m.is_active DESC, m.last_name, m.first_name`,
    );
    return {
      items: rows.map((r) => ({
        id: Number(r.id),
        identifier: r.identifier,
        firstName: r.first_name,
        lastName: r.last_name,
        email: r.email,
        isActive: r.is_active,
        hasLogin: r.has_login,
        mfaEnabled: r.mfa,
        roleIds: (r.role_ids ?? []).map(Number),
      })),
    };
  });

  app.put("/members/:id/roles", { config: { perm: "iam.manage" } }, async (req) => {
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = z.object({ roleIds: z.array(idSchema).max(50) }).parse(req.body);
    const roleIds = [...new Set(body.roleIds)];
    return withActor(app.pool, req.memberId, async (client) => {
      const member = await client.query("SELECT is_active FROM iam.member WHERE id = $1", [id]);
      if (!member.rows[0]) throw new HttpError(404, "Not Found", `Member ${id} not found`);
      if (roleIds.length) {
        const known = await client.query<{ n: string }>(
          "SELECT count(*) AS n FROM iam.role WHERE id = ANY($1::bigint[])",
          [roleIds],
        );
        if (Number(known.rows[0]?.n) !== roleIds.length)
          throw new HttpError(422, "Unknown role", "One or more roles do not exist");
      }
      await client.query(
        "DELETE FROM iam.member_role WHERE member_id = $1 AND role_id <> ALL($2::bigint[])",
        [id, roleIds],
      );
      for (const roleId of roleIds) {
        await client.query(
          "INSERT INTO iam.member_role (member_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
          [id, roleId],
        );
      }
      await assertSomeoneCanManage(client);
      return { memberId: id, roleIds };
    });
  });

  // Deactivating signs the member out everywhere and blocks sign-in; history is untouched.
  app.patch("/members/:id", { config: { perm: "iam.manage" } }, async (req) => {
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = z.object({ isActive: z.boolean() }).parse(req.body);
    return withActor(app.pool, req.memberId, async (client) => {
      const r = await client.query("UPDATE iam.member SET is_active = $2 WHERE id = $1", [
        id,
        body.isActive,
      ]);
      if (!r.rowCount) throw new HttpError(404, "Not Found", `Member ${id} not found`);
      if (!body.isActive) {
        await client.query(
          "UPDATE iam.member_credential SET session_epoch = session_epoch + 1 WHERE member_id = $1",
          [id],
        );
      }
      await assertSomeoneCanManage(client);
      return { id, isActive: body.isActive };
    });
  });
};
