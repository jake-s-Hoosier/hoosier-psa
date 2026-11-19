import type { Pool } from "@hoosier/db";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

// A stub pool: these tests cover routing, auth and validation, which never reach the database.
const stubPool = {
  query: async () => ({ rows: [], rowCount: 0 }),
} as unknown as Pool;

const app = buildApp({ pool: stubPool, config: { AUTH_MODE: "dev", LOG_LEVEL: "silent" } });

describe("api", () => {
  it("serves liveness without credentials", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("rejects unauthenticated API calls with problem+json", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/companies" });
    expect(res.statusCode).toBe(401);
    expect(res.headers["content-type"]).toContain("application/problem+json");
  });

  it("validates input and reports field errors", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/companies",
      headers: { "x-dev-member-id": "1" },
      payload: { identifier: "", name: "X", statusId: "abc" },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.title).toBe("Validation failed");
    expect(body.errors.map((e: { path: string }) => e.path).sort()).toEqual([
      "identifier",
      "statusId",
    ]);
  });

  it("returns 404 problem for unknown routes", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/nope",
      headers: { "x-dev-member-id": "1" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("config", () => {
  const base = { DATABASE_URL: "postgres://u:p@localhost:5432/db" };

  it("applies defaults", () => {
    expect(loadConfig(base).API_PORT).toBe(4000);
  });

  it("refuses dev auth in production", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "production" })).toThrow(
      /not allowed in production/,
    );
  });

  it("reports invalid values clearly", () => {
    expect(() => loadConfig({ ...base, API_PORT: "99999" })).toThrow(/API_PORT/);
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });
});
