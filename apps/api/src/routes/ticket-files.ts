import { createHash } from "node:crypto";
import { withActor } from "@hoosier/db";
import { idSchema } from "@hoosier/shared";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { HttpError } from "../errors.js";

/** Largest file accepted. Files are stored in PostgreSQL, so keep this modest (docs/06). */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const idParams = z.object({ id: idSchema });

/** Last path segment only, no control characters, at most 255 characters. */
export function cleanFileName(raw: string): string {
  const last = raw.split(/[\\/]/).pop() ?? "";
  // Drop control characters and double quotes (they would break the download header).
  const kept = [...last].filter((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code > 0x1f && code !== 0x7f && ch !== '"';
  });
  return kept.join("").trim().slice(0, 255);
}

/** Only a plain type/subtype is kept; anything else is stored as generic binary. */
export function cleanContentType(raw: string | undefined): string {
  const t = (raw ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9][\w.+-]*\/[a-z0-9][\w.+-]*$/.test(t) && t.length <= 100
    ? t
    : "application/octet-stream";
}

interface AttachmentRow {
  id: string;
  ticket_id: string;
  file_name: string;
  content_type: string;
  size_bytes: string;
  uploaded_by_member_id: string | null;
  created_at: Date;
}
const toAttachment = (r: AttachmentRow) => ({
  id: Number(r.id),
  ticketId: Number(r.ticket_id),
  fileName: r.file_name,
  contentType: r.content_type,
  sizeBytes: Number(r.size_bytes),
  uploadedByMemberId: r.uploaded_by_member_id === null ? null : Number(r.uploaded_by_member_id),
  createdAt: r.created_at.toISOString(),
});

/** Ticket resources (who works the ticket) and file attachments. Mounted under /api/v1/tickets. */
export const ticketFileRoutes: FastifyPluginAsync = async (app) => {
  const ensureTicket = async (db: { query: typeof app.pool.query }, id: number) => {
    const { rowCount } = await db.query("SELECT 1 FROM service.ticket WHERE id = $1", [id]);
    if (!rowCount) throw new HttpError(404, "Not Found", `Ticket ${id} not found`);
  };

  // ---- resources ----
  const listResources = async (db: typeof app.pool, ticketId: number) => {
    const { rows } = await db.query<{
      member_id: string;
      identifier: string;
      first_name: string;
      last_name: string;
      added_at: Date;
    }>(
      `SELECT r.member_id, m.identifier::text AS identifier, m.first_name, m.last_name, r.added_at
         FROM service.ticket_resource r JOIN iam.member m ON m.id = r.member_id
        WHERE r.ticket_id = $1 ORDER BY m.last_name, m.first_name`,
      [ticketId],
    );
    return rows.map((r) => ({
      memberId: Number(r.member_id),
      identifier: r.identifier,
      name: `${r.first_name} ${r.last_name}`,
      addedAt: r.added_at.toISOString(),
    }));
  };

  app.get("/:id/resources", { config: { perm: "service.ticket.read" } }, async (req) => {
    const { id } = idParams.parse(req.params);
    await ensureTicket(app.pool, id);
    return { items: await listResources(app.pool, id) };
  });

  app.post("/:id/resources", { config: { perm: "service.ticket.write" } }, async (req) => {
    const { id } = idParams.parse(req.params);
    const { memberId } = z.object({ memberId: idSchema }).parse(req.body);
    await withActor(app.pool, req.memberId, async (client) => {
      await ensureTicket(client, id);
      const m = await client.query<{ is_active: boolean }>(
        "SELECT is_active FROM iam.member WHERE id = $1",
        [memberId],
      );
      if (!m.rows[0]) throw new HttpError(422, "Unknown member", "That member does not exist");
      if (!m.rows[0].is_active)
        throw new HttpError(422, "Inactive member", "That member is inactive");
      await client.query(
        "INSERT INTO service.ticket_resource (ticket_id, member_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [id, memberId],
      );
    });
    return { items: await listResources(app.pool, id) };
  });

  app.delete(
    "/:id/resources/:memberId",
    { config: { perm: "service.ticket.write" } },
    async (req) => {
      const { id, memberId } = z.object({ id: idSchema, memberId: idSchema }).parse(req.params);
      await withActor(app.pool, req.memberId, async (client) => {
        await ensureTicket(client, id);
        await client.query(
          "DELETE FROM service.ticket_resource WHERE ticket_id = $1 AND member_id = $2",
          [id, memberId],
        );
      });
      return { items: await listResources(app.pool, id) };
    },
  );

  // ---- attachments ----
  app.get("/:id/attachments", { config: { perm: "service.ticket.read" } }, async (req) => {
    const { id } = idParams.parse(req.params);
    await ensureTicket(app.pool, id);
    const { rows } = await app.pool.query<AttachmentRow>(
      `SELECT id, ticket_id, file_name, content_type, size_bytes, uploaded_by_member_id, created_at
         FROM service.ticket_attachment WHERE ticket_id = $1 AND deleted_at IS NULL
        ORDER BY created_at DESC, id DESC`,
      [id],
    );
    return { items: rows.map(toAttachment) };
  });

  app.get(
    "/:id/attachments/:attachmentId/download",
    { config: { perm: "service.ticket.read" } },
    async (req, reply) => {
      const { id, attachmentId } = z
        .object({ id: idSchema, attachmentId: idSchema })
        .parse(req.params);
      const { rows } = await app.pool.query<{
        file_name: string;
        content_type: string;
        data: Buffer;
      }>(
        `SELECT a.file_name, a.content_type, b.data
           FROM service.ticket_attachment a
           JOIN service.ticket_attachment_blob b ON b.attachment_id = a.id
          WHERE a.id = $1 AND a.ticket_id = $2 AND a.deleted_at IS NULL`,
        [attachmentId, id],
      );
      const row = rows[0];
      if (!row) throw new HttpError(404, "Not Found", "Attachment not found");
      // Always a download, never rendered in our origin: uploaded HTML or SVG must not run as a page.
      return reply
        .header("content-type", row.content_type)
        .header(
          "content-disposition",
          `attachment; filename="${row.file_name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(row.file_name)}`,
        )
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", "sandbox; default-src 'none'")
        .header("cache-control", "private, no-store")
        .send(row.data);
    },
  );

  app.delete(
    "/:id/attachments/:attachmentId",
    { config: { perm: "service.ticket.write" } },
    async (req, reply) => {
      const { id, attachmentId } = z
        .object({ id: idSchema, attachmentId: idSchema })
        .parse(req.params);
      await withActor(app.pool, req.memberId, async (client) => {
        const { rows } = await client.query<{ uploaded_by_member_id: string | null }>(
          "SELECT uploaded_by_member_id FROM service.ticket_attachment WHERE id = $1 AND ticket_id = $2 AND deleted_at IS NULL",
          [attachmentId, id],
        );
        const row = rows[0];
        if (!row) throw new HttpError(404, "Not Found", "Attachment not found");
        // Your own uploads can be removed by you; anyone else's needs service.ticket.delete.
        if (
          Number(row.uploaded_by_member_id) !== req.memberId &&
          !req.permissions.has("service.ticket.delete")
        ) {
          throw new HttpError(403, "Forbidden", "You can only remove attachments you uploaded");
        }
        await client.query(
          "UPDATE service.ticket_attachment SET deleted_at = now(), deleted_by_member_id = $2 WHERE id = $1",
          [attachmentId, req.memberId],
        );
      });
      return reply.status(204).send();
    },
  );

  // Upload is the raw file as the request body: POST ...?filename=report.pdf with its content type.
  // (No multipart dependency; browsers send a File straight through fetch.) Own scope so the
  // catch-all body parser applies to this route only.
  await app.register(async (upload) => {
    // Every content type, JSON included, is just file bytes here.
    upload.removeAllContentTypeParsers();
    upload.addContentTypeParser(
      "*",
      { parseAs: "buffer", bodyLimit: MAX_ATTACHMENT_BYTES },
      (_req, body, done) => done(null, body),
    );
    upload.post(
      "/:id/attachments",
      { bodyLimit: MAX_ATTACHMENT_BYTES, config: { perm: "service.ticket.write" } },
      async (req, reply) => {
        const { id } = idParams.parse(req.params);
        const { filename } = z.object({ filename: z.string().min(1).max(500) }).parse(req.query);
        const fileName = cleanFileName(filename);
        if (!fileName) throw new HttpError(422, "Invalid file name", "Give the file a name");
        const data = req.body;
        if (!Buffer.isBuffer(data) || data.length === 0)
          throw new HttpError(422, "Empty file", "Send the file as the request body");
        const sha = createHash("sha256").update(data).digest("hex");
        const row = await withActor(app.pool, req.memberId, async (client) => {
          await ensureTicket(client, id);
          const { rows } = await client.query<AttachmentRow>(
            `INSERT INTO service.ticket_attachment
               (ticket_id, file_name, content_type, size_bytes, sha256, uploaded_by_member_id)
             VALUES ($1,$2,$3,$4,$5,$6)
             RETURNING id, ticket_id, file_name, content_type, size_bytes, uploaded_by_member_id, created_at`,
            [
              id,
              fileName,
              cleanContentType(req.headers["content-type"]),
              data.length,
              sha,
              req.memberId,
            ],
          );
          const created = rows[0] as AttachmentRow;
          await client.query(
            "INSERT INTO service.ticket_attachment_blob (attachment_id, data) VALUES ($1,$2)",
            [created.id, data],
          );
          return created;
        });
        return reply
          .status(201)
          .header("location", `/api/v1/tickets/${id}/attachments/${row.id}/download`)
          .send(toAttachment(row));
      },
    );
  });
};
