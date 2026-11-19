# 0011. Ticket attachments are stored in PostgreSQL

Status: Accepted
Date: 2026-11-19

## Context
Tickets need file attachments (photos, PDFs, quotes, site drawings). The parity matrix first assumed an
object store. Nothing in the stack provides one yet, there is a single host (HSIN-UT01) and one database,
and the attachment volume for a company this size is small. Files must be backed up, restored and kept
consistent with the ticket they belong to, and must never end up in the audit log.

## Decision
- Metadata lives in `service.ticket_attachment` (name, media type, size, SHA-256, uploader, timestamps),
  audited like any other record. The bytes live in `service.ticket_attachment_blob` (`bytea`), which has
  **no audit trigger** so file contents are never copied into `sys.audit_log`.
- Maximum 25 MB per file, enforced by the API. The file is the raw request body
  (`POST /api/v1/tickets/:id/attachments?filename=...`), so there is no multipart dependency.
- Downloads are always `Content-Disposition: attachment` with `X-Content-Type-Options: nosniff` and a
  sandboxing Content-Security-Policy, so an uploaded HTML or SVG file can never run as a page in our origin.
  The stored media type is whatever the browser sent, reduced to a plain `type/subtype`.
- Removing an attachment sets `deleted_at` and hides it; the bytes are kept until an explicit purge job
  (not built yet). Uploaders remove their own files; removing anyone else's needs `service.ticket.delete`.
- The blob table is separate from the metadata so listing never reads file bytes, and so the bytes can be
  moved to an object store later by copying rows out and swapping the read and write paths in one module.

## Consequences
- One backup and one restore cover tickets and their files, and a database restore into UAT carries files too.
- Database size grows with attachments. Revisit if total attachment size passes a few GB, or when
  project documents and inbound email attachments arrive (milestone 3), and move the blob table to object storage then.
- Files are held in memory while uploading and downloading (25 MB cap keeps this safe). Streaming is not needed yet.
- There is no malware scanning. Add scanning before files become visible to customers in the portal (milestone 5).
- ConnectWise attachments are not imported yet (`legacy_cw_document_id` reserves the link). They come through
  the CW API, not the warehouse mirror, so they need a separate import step.

## Alternatives considered
- **Object storage (S3 or Cloudflare R2).** Better at scale, but adds a second system to secure, back up
  and keep consistent, and a new network dependency for a workload that does not need it yet.
- **Files on the host disk.** Simple, but backups, restores and environment copies could drift from the database.
- **PostgreSQL large objects.** Awkward to back up selectively, to permission and to audit around; `bytea` is simpler at this size.
