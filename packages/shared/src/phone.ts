/**
 * Normalises a North American phone number to E.164 ("+13175550100") so inbound calls can be matched
 * to contacts. Returns null when the input is not a plausible number (too short, letters only, etc).
 * Extensions must be stripped by the caller; "317-555-0100 x12" yields the base number only.
 */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const base = raw.split(/\s*(?:x|ext\.?|#)\s*\d+\s*$/i)[0] ?? "";
  const hasPlus = base.trim().startsWith("+");
  const digits = base.replace(/\D/g, "");
  if (hasPlus) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10 && /^[2-9]/.test(digits)) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1") && /^[2-9]/.test(digits.slice(1))) {
    return `+${digits}`;
  }
  return null;
}

/** Splits a trailing extension ("x123", "ext 45") from a phone string. */
export function phoneExtension(raw: string | null | undefined): string | null {
  const m = raw ? /(?:x|ext\.?|#)\s*(\d+)\s*$/i.exec(raw) : null;
  return m?.[1] ?? null;
}
