import { MAX_ATTACHMENT_BYTES } from "../routes/ticket-files.js";
import { htmlToText } from "./text.js";
import type { MailAttachment, MailMessage, MailSource } from "./types.js";

const GRAPH = "https://graph.microsoft.com/v1.0";

interface GraphMessage {
  id: string;
  internetMessageId?: string;
  subject?: string | null;
  from?: { emailAddress?: { address?: string; name?: string } };
  receivedDateTime: string;
  body?: { contentType?: string; content?: string };
  internetMessageHeaders?: Array<{ name: string; value: string }>;
  hasAttachments?: boolean;
}
interface GraphAttachment {
  "@odata.type"?: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
  contentBytes?: string;
}
interface Page<T> {
  value: T[];
  "@odata.nextLink"?: string;
}

export interface GraphOptions {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** Injectable so tests never touch the network. */
  fetchImpl?: typeof fetch;
}

/**
 * Reads a Microsoft 365 mailbox with application permissions (client credentials).
 * Needs only Mail.Read, and the tenant should restrict the app to the support mailbox with an
 * application access policy (docs/adr/0012-microsoft-365-mail.md). It never changes the mailbox.
 */
export class GraphMailSource implements MailSource {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly http: typeof fetch;

  constructor(private readonly opts: GraphOptions) {
    this.http = opts.fetchImpl ?? fetch;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const res = await this.http(
      `https://login.microsoftonline.com/${encodeURIComponent(this.opts.tenantId)}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.opts.clientId,
          client_secret: this.opts.clientSecret,
          scope: "https://graph.microsoft.com/.default",
          grant_type: "client_credentials",
        }),
      },
    );
    if (!res.ok)
      throw new Error(`Microsoft sign-in failed (${res.status}): ${await errorText(res)}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return json.access_token;
  }

  private async get<T>(url: string): Promise<T> {
    const res = await this.http(url, {
      headers: {
        authorization: `Bearer ${await this.accessToken()}`,
        // Ask for a plain-text body so we rarely need to convert HTML ourselves.
        prefer: 'outlook.body-content-type="text"',
      },
    });
    if (!res.ok) throw new Error(`Microsoft Graph ${res.status}: ${await errorText(res)}`);
    return (await res.json()) as T;
  }

  async fetch(mailbox: string, since: Date): Promise<MailMessage[]> {
    const user = encodeURIComponent(mailbox);
    const select =
      "id,internetMessageId,subject,from,receivedDateTime,body,internetMessageHeaders,hasAttachments";
    let url: string | undefined =
      `${GRAPH}/users/${user}/mailFolders/inbox/messages?$top=25&$select=${select}` +
      `&$filter=${encodeURIComponent(`receivedDateTime ge ${since.toISOString()}`)}` +
      `&$orderby=${encodeURIComponent("receivedDateTime asc")}`;
    const out: MailMessage[] = [];
    while (url) {
      const page: Page<GraphMessage> = await this.get<Page<GraphMessage>>(url);
      for (const m of page.value) out.push(await this.toMessage(user, m));
      url = page["@odata.nextLink"];
    }
    return out;
  }

  private async toMessage(user: string, m: GraphMessage): Promise<MailMessage> {
    const header = (name: string) =>
      m.internetMessageHeaders?.find((h) => h.name.toLowerCase() === name)?.value ?? null;
    const raw = m.body?.content ?? "";
    const bodyText = m.body?.contentType?.toLowerCase() === "html" ? htmlToText(raw) : raw;

    const attachments: MailAttachment[] = [];
    let unavailable = 0;
    if (m.hasAttachments) {
      const list = await this.get<Page<GraphAttachment>>(
        `${GRAPH}/users/${user}/messages/${encodeURIComponent(m.id)}/attachments`,
      );
      for (const a of list.value) {
        const isFile = a["@odata.type"] === "#microsoft.graph.fileAttachment";
        if (!isFile || !a.contentBytes || (a.size ?? 0) > MAX_ATTACHMENT_BYTES) {
          if (!a.isInline) unavailable++;
          continue;
        }
        attachments.push({
          name: a.name ?? "attachment",
          contentType: a.contentType ?? "application/octet-stream",
          bytes: Buffer.from(a.contentBytes, "base64"),
          isInline: a.isInline === true,
        });
      }
    }

    const refs = header("references");
    return {
      internetMessageId: m.internetMessageId ?? "",
      fromAddress: m.from?.emailAddress?.address ?? "",
      fromName: m.from?.emailAddress?.name ?? null,
      subject: m.subject ?? "",
      bodyText,
      receivedAt: new Date(m.receivedDateTime),
      inReplyTo: header("in-reply-to"),
      references: refs ? (refs.match(/<[^>]+>/g) ?? []) : [],
      autoSubmitted: header("auto-submitted"),
      precedence: header("precedence"),
      attachments,
      attachmentsUnavailable: unavailable,
    };
  }
}

/** Graph's error body is {error:{code,message}}; keep that and nothing else (never echo tokens). */
async function errorText(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as {
      error?: string | { code?: string; message?: string };
      error_description?: string;
    };
    if (typeof j.error === "object" && j.error)
      return `${j.error.code ?? "error"}: ${j.error.message ?? ""}`.slice(0, 300);
    return `${j.error ?? "error"}: ${(j.error_description ?? "").split("\r")[0]}`.slice(0, 300);
  } catch {
    return res.statusText;
  }
}
