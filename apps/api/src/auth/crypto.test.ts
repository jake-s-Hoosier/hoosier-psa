import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  hashPassword,
  hashRecoveryCode,
  passwordProblem,
  signSession,
  totpAt,
  verifyPassword,
  verifySession,
  verifyTotp,
} from "./crypto.js";

const SECRET = "x".repeat(40);

describe("passwords", () => {
  it("verifies the right password and rejects others", async () => {
    const h = await hashPassword("correct horse battery staple");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery staple", h)).toBe(true);
    expect(await verifyPassword("correct horse battery stapl", h)).toBe(false);
    expect(await verifyPassword("anything", "garbage")).toBe(false);
  });
  it("salts every hash", async () => {
    expect(await hashPassword("same password here")).not.toBe(
      await hashPassword("same password here"),
    );
  });
  it("applies the policy", () => {
    const ctx = { identifier: "JShaffer", email: "jake@example.com" };
    expect(passwordProblem("short", ctx)).toMatch(/12/);
    expect(passwordProblem("aaaaaaaaaaaaaaaa", ctx)).toMatch(/repetitive/);
    expect(passwordProblem("my-jshaffer-secret-1", ctx)).toMatch(/name or email/);
    expect(passwordProblem("a long unrelated passphrase", ctx)).toBeNull();
  });
});

describe("TOTP", () => {
  // RFC 6238 appendix B, SHA-1, secret "12345678901234567890"; 8-digit vectors truncated to 6.
  const secret = Buffer.from("12345678901234567890");
  it("matches the RFC 6238 test vectors", () => {
    expect(totpAt(secret, Math.floor(59 / 30), 8)).toBe("94287082");
    expect(totpAt(secret, Math.floor(1111111109 / 30), 8)).toBe("07081804");
    expect(totpAt(secret, Math.floor(20000000000 / 30), 8)).toBe("65353130");
  });
  it("accepts one step of drift and refuses replays", () => {
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 1000 / 30);
    const code = totpAt(secret, step);
    expect(verifyTotp(secret, code, 0, now)).toBe(step);
    expect(verifyTotp(secret, totpAt(secret, step - 1), 0, now)).toBe(step - 1);
    expect(verifyTotp(secret, code, step, now)).toBeNull(); // already used
    expect(verifyTotp(secret, totpAt(secret, step + 5), 0, now)).toBeNull();
    expect(verifyTotp(secret, "12ab56", 0, now)).toBeNull();
  });
  it("round-trips base32", () => {
    expect(base32Encode(Buffer.from("12345678901234567890"))).toBe(
      "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
    );
    expect(base32Decode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ").toString()).toBe(
      "12345678901234567890",
    );
  });
});

describe("recovery codes", () => {
  it("are unique, well formed and hash the same regardless of formatting", () => {
    const codes = generateRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
    expect(codes[0]).toMatch(/^[a-z2-7]{5}-[a-z2-7]{5}$/);
    const c = codes[0] as string;
    expect(hashRecoveryCode(c)).toBe(hashRecoveryCode(` ${c.toUpperCase().replace("-", "")} `));
  });
});

describe("secrets and sessions", () => {
  it("encrypts and decrypts, and fails on tampering or a different key", () => {
    const enc = encryptSecret(Buffer.from("totp-secret-bytes"), SECRET);
    expect(decryptSecret(enc, SECRET).toString()).toBe("totp-secret-bytes");
    expect(() => decryptSecret(enc, "y".repeat(40))).toThrow();
    const raw = Buffer.from(enc, "base64url");
    raw[raw.length - 1] = (raw[raw.length - 1] as number) ^ 1;
    expect(() => decryptSecret(raw.toString("base64url"), SECRET)).toThrow();
  });
  it("signs sessions and rejects forgeries", () => {
    const claims = { m: 7, e: 0, iat: 1, exp: 2, seen: 1, mfa: true };
    const token = signSession(claims, SECRET);
    expect(verifySession(token, SECRET)).toEqual(claims);
    expect(verifySession(token, "y".repeat(40))).toBeNull();
    const [body, mac] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...claims, m: 1 })).toString("base64url");
    expect(verifySession(`${forged}.${mac}`, SECRET)).toBeNull();
    expect(verifySession(`${body}.`, SECRET)).toBeNull();
    expect(verifySession("nonsense", SECRET)).toBeNull();
  });
});
