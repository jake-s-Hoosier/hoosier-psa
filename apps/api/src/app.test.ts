import type { Pool } from "@hoosier/db";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

// A stub pool that records every query: these tests cover routing, auth, validation and the
// read-only guard, none of which may reach the database for a rejected request.
function stub() {
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  return { pool, queries };
}

const writable = {
  AUTH_MODE: "dev",
  LOG_LEVEL: "silent",
  APP_ENV: "development",
  DB_WRITE_MODE: "read_write",
} as const;
const readOnly = { ...writable, DB_WRITE_MODE: "read_only" } as const;

describe("api", () => {
  const app = buildApp({ pool: stub().pool, config: writable });

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

describe("read-only mode", () => {
  it("rejects every mutating method before any handler or query runs", async () => {
    const { pool, queries } = stub();
    const app = buildApp({ pool, config: readOnly });
    const headers = { "x-dev-member-id": "1" };
    const valid = { identifier: "ACME", name: "Acme", statusId: 1 };

    for (const [method, url] of [
      ["POST", "/api/v1/companies"],
      ["PUT", "/api/v1/companies/1"],
      ["PATCH", "/api/v1/companies/1"],
      ["DELETE", "/api/v1/companies/1"],
    ] as const) {
      const res = await app.inject({ method, url, headers, payload: valid });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().title).toBe("Read-only mode");
    }
    expect(queries).toEqual([]);
  });

  it("still serves reads and reports the environment", async () => {
    const app = buildApp({ pool: stub().pool, config: readOnly });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/system/status",
      headers: { "x-dev-member-id": "1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ environment: "development", writeMode: "read_only" });
  });
});

describe("config", () => {
  const base = { DATABASE_URL: "postgres://u:p@localhost:5432/db" };

  it("applies safe defaults: development, read-only, integrations off", () => {
    const c = loadConfig(base);
    expect(c.API_PORT).toBe(4000);
    expect(c.APP_ENV).toBe("development");
    expect(c.DB_WRITE_MODE).toBe("read_only");
    expect(c.INTEGRATIONS_ENABLED).toBe(false);
  });

  it("refuses dev auth in production", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "production" })).toThrow(
      /not allowed in production/,
    );
    expect(() => loadConfig({ ...base, APP_ENV: "production" })).toThrow(
      /not allowed in production/,
    );
  });

  it("never lets the API write in shadow", () => {
    expect(() => loadConfig({ ...base, APP_ENV: "shadow", DB_WRITE_MODE: "read_write" })).toThrow(
      /shadow/,
    );
    expect(loadConfig({ ...base, APP_ENV: "shadow" }).DB_WRITE_MODE).toBe("read_only");
  });

  it("allows external integrations only in production", () => {
    for (const env of ["development", "test", "uat", "shadow"]) {
      expect(() => loadConfig({ ...base, APP_ENV: env, INTEGRATIONS_ENABLED: "true" })).toThrow(
        /only allowed when APP_ENV=production/,
      );
    }
  });

  it("reports invalid values clearly", () => {
    expect(() => loadConfig({ ...base, API_PORT: "99999" })).toThrow(/API_PORT/);
    expect(() => loadConfig({ ...base, APP_ENV: "staging" })).toThrow(/APP_ENV/);
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });
});
