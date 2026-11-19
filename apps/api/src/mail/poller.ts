import type pg from "pg";
import { type Mailbox, processInboundMessage } from "./process.js";
import type { MailSource } from "./types.js";

export interface PollLog {
  info: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

/** Re-read a few minutes before the last message so mail that arrived out of order is not missed. */
const OVERLAP_MS = 5 * 60 * 1000;

interface MailboxRow {
  id: string;
  address: string;
  board_id: string;
  priority_id: string | null;
  fallback_company_id: string;
  reopen_on_reply: boolean;
  poll_from: Date;
  last_received_at: Date | null;
}

export interface PollSummary {
  mailbox: string;
  fetched: number;
  created: number;
  appended: number;
  ignored: number;
  duplicates: number;
  errors: number;
  failed?: string;
}

/** One pass over every active mailbox. Never throws; problems are recorded on the mailbox row. */
export async function pollOnce(
  pool: pg.Pool,
  source: MailSource,
  log: PollLog,
): Promise<PollSummary[]> {
  const all = await pool.query<{ address: string }>("SELECT address::text FROM service.mailbox");
  const own = new Set(all.rows.map((r) => r.address.toLowerCase()));
  const boxes = await pool.query<MailboxRow>(
    `SELECT id, address::text AS address, board_id, priority_id, fallback_company_id,
            reopen_on_reply, poll_from, last_received_at
       FROM service.mailbox WHERE is_active ORDER BY id`,
  );
  const summaries: PollSummary[] = [];

  for (const row of boxes.rows) {
    const mailbox: Mailbox = {
      id: Number(row.id),
      address: row.address,
      boardId: Number(row.board_id),
      priorityId: row.priority_id === null ? null : Number(row.priority_id),
      fallbackCompanyId: Number(row.fallback_company_id),
      reopenOnReply: row.reopen_on_reply,
    };
    const s: PollSummary = {
      mailbox: row.address,
      fetched: 0,
      created: 0,
      appended: 0,
      ignored: 0,
      duplicates: 0,
      errors: 0,
    };
    summaries.push(s);
    const since = row.last_received_at
      ? new Date(row.last_received_at.getTime() - OVERLAP_MS)
      : row.poll_from;
    try {
      const messages = (await source.fetch(row.address, since)).sort(
        (a, b) => a.receivedAt.getTime() - b.receivedAt.getTime(),
      );
      s.fetched = messages.length;
      let newest = row.last_received_at;
      for (const msg of messages) {
        try {
          const r = await processInboundMessage(pool, mailbox, msg, own);
          if (r.outcome === "created" || r.outcome === "created_unmatched") s.created++;
          else if (r.outcome === "appended") s.appended++;
          else if (r.outcome === "ignored") s.ignored++;
          else if (r.outcome === "duplicate") s.duplicates++;
          else s.errors++;
        } catch (err) {
          // The transaction rolled back, so nothing was recorded. Log the failure so it is visible and
          // is not retried forever; staff can see it on the Email screen.
          s.errors++;
          const reason = (err instanceof Error ? err.message : String(err)).slice(0, 500);
          log.error(
            { mailbox: row.address, messageId: msg.internetMessageId, reason },
            "inbound message failed",
          );
          await pool.query(
            `INSERT INTO service.inbound_email
               (mailbox_id, message_id, from_address, subject, received_at, outcome, reason)
             VALUES ($1,$2,$3,$4,$5,'error',$6) ON CONFLICT (mailbox_id, message_id) DO NOTHING`,
            [
              mailbox.id,
              msg.internetMessageId || `no-id-${msg.receivedAt.toISOString()}`,
              msg.fromAddress || "unknown",
              msg.subject.slice(0, 1000),
              msg.receivedAt,
              reason,
            ],
          );
        }
        if (!newest || msg.receivedAt > newest) newest = msg.receivedAt;
      }
      await pool.query(
        "UPDATE service.mailbox SET last_polled_at = now(), last_error = NULL, last_received_at = $2 WHERE id = $1",
        [mailbox.id, newest],
      );
    } catch (err) {
      s.failed = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      log.error({ mailbox: row.address, reason: s.failed }, "mailbox poll failed");
      await pool.query(
        "UPDATE service.mailbox SET last_polled_at = now(), last_error = $2 WHERE id = $1",
        [mailbox.id, s.failed],
      );
    }
    if (s.created || s.appended || s.errors) log.info(s, "mailbox polled");
  }
  return summaries;
}

/** Runs pollOnce on an interval, never overlapping itself. Returns a function that stops it. */
export function startPoller(
  pool: pg.Pool,
  source: MailSource,
  intervalMs: number,
  log: PollLog,
): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await pollOnce(pool, source, log);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  void tick();
  return () => clearInterval(timer);
}
