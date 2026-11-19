import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";

// ---------------------------------------------------------------------------------------------
// Passwords: scrypt with a per-password salt. Format: scrypt$N$r$p$saltB64$hashB64
// ---------------------------------------------------------------------------------------------

const SCRYPT = { N: 16384, r: 8, p: 1, keyLen: 32 } as const;

function scryptAsync(
  password: string,
  salt: Buffer,
  keyLen: number,
  o: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize("NFKC"),
      salt,
      keyLen,
      { ...o, maxmem: 128 * o.N * o.r * 2 },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT.keyLen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !n || !r || !p || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scryptAsync(password, Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Compared against when the account does not exist so timing does not reveal valid identifiers. */
export const DUMMY_HASH =
  "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const COMMON = new Set([
  "password1234",
  "passwordpassword",
  "123456789012",
  "qwertyuiopas",
  "letmein12345",
  "welcome12345",
  "hoosiersecurity",
  "hoosier123456",
]);

/** Returns a problem description, or null when the password is acceptable. Length over complexity rules. */
export function passwordProblem(
  password: string,
  context: { identifier: string; email: string },
): string | null {
  if (password.length < 12) return "Use at least 12 characters";
  if (password.length > 200) return "Use at most 200 characters";
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return "That password is too common";
  if (new Set(password).size < 5) return "Use a less repetitive password";
  const local = context.email.split("@")[0]?.toLowerCase() ?? "";
  if (
    lower.includes(context.identifier.toLowerCase()) ||
    (local.length >= 4 && lower.includes(local))
  ) {
    return "The password must not contain your name or email";
  }
  return null;
}

export function generateTemporaryPassword(): string {
  // 4 groups of 5 from an unambiguous alphabet: about 100 bits.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const group = () => Array.from(randomBytes(5), (b) => alphabet[b % alphabet.length]).join("");
  return [group(), group(), group(), group()].join("-");
}

// ---------------------------------------------------------------------------------------------
// TOTP (RFC 6238), HMAC-SHA1, 6 digits, 30 second step: what every authenticator app expects.
// ---------------------------------------------------------------------------------------------

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("Invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): Buffer {
  return randomBytes(20);
}

export function totpAt(secret: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secret).update(msg).digest();
  const offset = (mac[mac.length - 1] as number) & 15;
  const bin =
    (((mac[offset] as number) & 127) << 24) |
    (((mac[offset + 1] as number) & 255) << 16) |
    (((mac[offset + 2] as number) & 255) << 8) |
    ((mac[offset + 3] as number) & 255);
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export const TOTP_STEP_SECONDS = 30;

/**
 * Checks a code against the current step and one step either side (clock drift). Returns the matched
 * step, which the caller stores so the same code cannot be used twice, or null.
 */
export function verifyTotp(
  secret: Buffer,
  code: string,
  lastCounter: number,
  nowMs: number = Date.now(),
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
  for (const counter of [current, current - 1, current + 1]) {
    if (counter <= lastCounter) continue;
    const expected = Buffer.from(totpAt(secret, counter));
    if (timingSafeEqual(expected, Buffer.from(code))) return counter;
  }
  return null;
}

export function otpauthUri(secretB32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// ---------------------------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------------------------

export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = base32Encode(randomBytes(7)).slice(0, 10).toLowerCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

export const normaliseRecoveryCode = (code: string) => code.replace(/[\s-]/g, "").toLowerCase();

export const hashRecoveryCode = (code: string) =>
  createHash("sha256").update(normaliseRecoveryCode(code)).digest("hex");

// ---------------------------------------------------------------------------------------------
// Secrets at rest and signed session cookies, both keyed from AUTH_SECRET with separate labels.
// ---------------------------------------------------------------------------------------------

const subKey = (secret: string, label: string) =>
  createHmac("sha256", secret).update(label).digest();

export function encryptSecret(plain: Buffer, authSecret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", subKey(authSecret, "mfa-secret"), iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64url");
}

export function decryptSecret(encoded: string, authSecret: string): Buffer {
  const raw = Buffer.from(encoded, "base64url");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    subKey(authSecret, "mfa-secret"),
    raw.subarray(0, 12),
  );
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
}

export interface SessionClaims {
  /** member id */
  m: number;
  /** member credential session epoch at issue time */
  e: number;
  /** issued at (ms) */
  iat: number;
  /** absolute expiry (ms) */
  exp: number;
  /** last activity (ms), refreshed while the member is active */
  seen: number;
  /** second factor verified in this session */
  mfa: boolean;
}

export function signSession(claims: SessionClaims, authSecret: string): string {
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const mac = createHmac("sha256", subKey(authSecret, "session")).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verifySession(token: string, authSecret: string): SessionClaims | null {
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", subKey(authSecret, "session")).update(body).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const c = JSON.parse(Buffer.from(body, "base64url").toString()) as SessionClaims;
    return typeof c.m === "number" && typeof c.exp === "number" ? c : null;
  } catch {
    return null;
  }
}
