import type { FastifyPluginAsync } from "fastify";

/** Read-only reference data the UI needs to fill forms: boards with statuses, priorities, work roles and types. */
export const lookupRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", { config: { perm: "authenticated" } }, async () => {
    const [
      boards,
      statuses,
      priorities,
      roles,
      types,
      members,
      companyStatuses,
      territories,
      agreementTypes,
    ] = await Promise.all([
      app.pool.query<{ id: string; name: string }>(
        "SELECT id, name::text FROM service.board WHERE is_active ORDER BY name",
      ),
      app.pool.query<{
        id: string;
        board_id: string;
        name: string;
        is_closed: boolean;
        is_default: boolean;
      }>(
        `SELECT id, board_id, name::text, is_closed, is_default FROM service.board_status
          WHERE is_active ORDER BY board_id, sort_order, id`,
      ),
      app.pool.query<{ id: string; name: string; color: string | null }>(
        "SELECT id, name::text, color FROM service.priority ORDER BY sort_order, id",
      ),
      app.pool.query<{ id: string; name: string }>(
        "SELECT id, name::text FROM catalog.work_role WHERE is_active ORDER BY name",
      ),
      app.pool.query<{ id: string; name: string; bill_time: string }>(
        "SELECT id, name::text, bill_time FROM catalog.work_type WHERE is_active ORDER BY name",
      ),
      app.pool.query<{
        id: string;
        identifier: string;
        first_name: string;
        last_name: string;
        is_field_tech: boolean;
      }>(
        `SELECT id, identifier::text, first_name, last_name, is_field_tech FROM iam.member
          WHERE is_active ORDER BY last_name, first_name`,
      ),
      app.pool.query<{ id: string; name: string }>(
        "SELECT id, name::text FROM crm.company_status ORDER BY id",
      ),
      app.pool.query<{ id: string; name: string }>(
        "SELECT id, name::text FROM crm.territory ORDER BY name",
      ),
      app.pool.query<{
        id: string;
        name: string;
        bill_cycle: string;
        coverage: string;
        auto_renew: boolean;
      }>(
        "SELECT id, name::text, bill_cycle, coverage, auto_renew FROM billing.agreement_type WHERE is_active ORDER BY name",
      ),
    ]);
    return {
      boards: boards.rows.map((b) => ({
        id: Number(b.id),
        name: b.name,
        statuses: statuses.rows
          .filter((s) => s.board_id === b.id)
          .map((s) => ({
            id: Number(s.id),
            name: s.name,
            isClosed: s.is_closed,
            isDefault: s.is_default,
          })),
      })),
      priorities: priorities.rows.map((p) => ({ id: Number(p.id), name: p.name, color: p.color })),
      workRoles: roles.rows.map((r) => ({ id: Number(r.id), name: r.name })),
      members: members.rows.map((m) => ({
        id: Number(m.id),
        identifier: m.identifier,
        name: `${m.first_name} ${m.last_name}`,
        isFieldTech: m.is_field_tech,
      })),
      companyStatuses: companyStatuses.rows.map((r) => ({ id: Number(r.id), name: r.name })),
      territories: territories.rows.map((r) => ({ id: Number(r.id), name: r.name })),
      agreementTypes: agreementTypes.rows.map((r) => ({
        id: Number(r.id),
        name: r.name,
        billCycle: r.bill_cycle,
        coverage: r.coverage,
        autoRenew: r.auto_renew,
      })),
      workTypes: types.rows.map((t) => ({ id: Number(t.id), name: t.name, billTime: t.bill_time })),
    };
  });
};
