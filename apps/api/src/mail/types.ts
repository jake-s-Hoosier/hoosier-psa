/** One email, in the shape the processor needs. Graph and test fixtures are both converted to this. */
export interface MailAttachment {
  name: string;
  contentType: string;
  bytes: Buffer;
  /** Inline images (signature logos and the like) are not kept as attachments. */
  isInline: boolean;
}

export interface MailMessage {
  /** RFC 5322 Message-ID, including angle brackets as received. */
  internetMessageId: string;
  fromAddress: string;
  fromName: string | null;
  subject: string;
  bodyText: string;
  receivedAt: Date;
  inReplyTo: string | null;
  references: string[];
  /** Header values we use to spot automatic mail; names are lower case. */
  autoSubmitted: string | null;
  precedence: string | null;
  attachments: MailAttachment[];
  /** Attachments the source could not supply (too large, or not a file). Counted, not stored. */
  attachmentsUnavailable: number;
}

/** Where messages come from. Graph in production; fixtures in tests and UAT. */
export interface MailSource {
  /** Messages received at or after `since`, oldest first. */
  fetch(mailbox: string, since: Date): Promise<MailMessage[]>;
}
