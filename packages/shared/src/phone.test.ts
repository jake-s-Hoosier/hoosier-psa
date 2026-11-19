import { describe, expect, it } from "vitest";
import { phoneExtension, toE164 } from "./phone.js";

describe("toE164", () => {
  it("normalises common US formats", () => {
    expect(toE164("317-555-0100")).toBe("+13175550100");
    expect(toE164("(317) 555-0100")).toBe("+13175550100");
    expect(toE164("1.317.555.0100")).toBe("+13175550100");
    expect(toE164("+1 317 555 0100")).toBe("+13175550100");
  });
  it("drops extensions from the base number", () => {
    expect(toE164("317-555-0100 x12")).toBe("+13175550100");
    expect(toE164("317-555-0100 ext. 45")).toBe("+13175550100");
  });
  it("accepts international numbers that carry a plus sign", () => {
    expect(toE164("+44 20 7946 0958")).toBe("+442079460958");
  });
  it("rejects implausible input", () => {
    expect(toE164("555-0100")).toBeNull();
    expect(toE164("call me")).toBeNull();
    expect(toE164("")).toBeNull();
    expect(toE164(null)).toBeNull();
    expect(toE164("117-555-0100")).toBeNull(); // area code cannot start with 1
  });
});

describe("phoneExtension", () => {
  it("extracts trailing extensions", () => {
    expect(phoneExtension("317-555-0100 x12")).toBe("12");
    expect(phoneExtension("317-555-0100 Ext 345")).toBe("345");
    expect(phoneExtension("317-555-0100")).toBeNull();
  });
});
