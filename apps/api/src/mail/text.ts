/** Plain-text helpers for incoming mail. Small and conservative: the raw text is always kept elsewhere. */

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Turns an HTML body into readable text. Only used when a source cannot supply a text body. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e.startsWith("#")) {
        const code =
          e[1]?.toLowerCase() === "x" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
        return Number.isFinite(code) && code > 0 && code < 0x110000
          ? String.fromCodePoint(code)
          : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const QUOTE_START = [
  /^on .{5,200} wrote:\s*$/i,
  /^-{2,}\s*original message\s*-{2,}\s*$/i,
  /^_{5,}\s*$/,
  /^from:\s.+$/i, // an Outlook header block; only treated as a quote when "Sent:" or "Date:" follows
];

/**
 * Drops the quoted earlier conversation from a reply so the ticket note holds only what is new.
 * If cutting would leave nothing, the whole text is returned. The full original is stored separately.
 */
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (let i = 1; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    const isHeaderBlock =
      /^from:\s/i.test(line) && /^(sent|date):\s/i.test((lines[i + 1] ?? "").trim());
    const isOther = QUOTE_START.slice(0, 3).some((re) => re.test(line));
    if (isHeaderBlock || isOther) {
      const kept = lines.slice(0, i).join("\n").trim();
      return kept || text.trim();
    }
  }
  return text.trim();
}

/** Ticket numbers mentioned in a subject, like "[#12345]" or "Ticket #12345". Order of appearance, no duplicates. */
export function ticketRefs(subject: string): number[] {
  const found: number[] = [];
  const add = (s: string | undefined) => {
    const n = Number(s);
    if (Number.isSafeInteger(n) && n > 0 && !found.includes(n)) found.push(n);
  };
  for (const m of subject.matchAll(/\[#\s*(\d{1,9})\s*\]/g)) add(m[1]);
  for (const m of subject.matchAll(/\bticket\s*#\s*(\d{1,9})\b/gi)) add(m[1]);
  return found;
}

/** "Re:", "RE[2]:", "Fwd:" prefixes removed so the ticket summary is the real subject. */
export function cleanSubject(subject: string): string {
  const s = subject
    .replace(/^\s*((re|fw|fwd)(\[\d+\])?\s*:\s*)+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return (s || "(no subject)").slice(0, 500);
}
