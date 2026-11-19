import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { GraphMailSource } from "./graph.js";
import { ignoreReason } from "./process.js";
import { cleanSubject, htmlToText, stripQuotedReply, ticketRefs } from "./text.js";
import type { MailMessage } from "./types.js";

const base: MailMessage = {
  internetMessageId: "<a@x>",
  fromAddress: "pat@customer.com",
  fromName: "Pat",
  subject: "Door stuck",
  bodyText: "help",
  receivedAt: new Date("2026-11-19T15:00:00Z"),
  inReplyTo: null,
  references: [],
  autoSubmitted: null,
  precedence: null,
  attachments: [],
  attachmentsUnavailable: 0,
};

describe("mail text helpers", () => {
  it("finds ticket numbers in subjects", () => {
    expect(ticketRefs("Re: Door stuck [#12345]")).toEqual([12345]);
    expect(ticketRefs("RE: Ticket #77 and ticket # 88 [# 77]")).toEqual([77, 88]);
    expect(ticketRefs("Invoice #5 is wrong")).toEqual([]);
    expect(ticketRefs("[#0]")).toEqual([]);
  });
  it("cleans reply prefixes from subjects", () => {
    expect(cleanSubject("RE: Re: FW:  Door   stuck")).toBe("Door stuck");
    expect(cleanSubject("Re:")).toBe("(no subject)");
    expect(cleanSubject("x".repeat(600))).toHaveLength(500);
  });
  it("cuts quoted history from replies but never everything", () => {
    expect(
      stripQuotedReply(
        "Thanks, fixed.\n\nOn Tue, Nov 18, 2026 at 9:00 AM Support <s@h.com> wrote:\n> old",
      ),
    ).toBe("Thanks, fixed.");
    expect(stripQuotedReply("Yes\n\n-----Original Message-----\nFrom: a\nSent: b")).toBe("Yes");
    expect(stripQuotedReply("Ok\n\nFrom: Bob\nSent: Monday\nTo: me\nstuff")).toBe("Ok");
    expect(stripQuotedReply("From: a\nSent: b\nbody")).toBe("From: a\nSent: b\nbody");
    expect(stripQuotedReply("Just text")).toBe("Just text");
  });
  it("turns HTML into text", () => {
    expect(htmlToText("<p>Hi&nbsp;there &amp; <b>team</b></p><script>x()</script><p>Bye</p>")).toBe(
      "Hi there & team\nBye",
    );
    expect(htmlToText("a<br>b &#65; &#x42;")).toBe("a\nb A B");
  });
});

describe("which mail is ignored", () => {
  const own = new Set(["support@hoosiersecurity.com"]);
  it("lets ordinary customer mail through", () => {
    expect(ignoreReason(base, own)).toBeNull();
    expect(ignoreReason({ ...base, autoSubmitted: "no" }, own)).toBeNull();
  });
  it("drops loops, bots and automatic mail", () => {
    expect(ignoreReason({ ...base, fromAddress: "Support@HoosierSecurity.com" }, own)).toMatch(
      /loop/,
    );
    expect(ignoreReason({ ...base, fromAddress: "no-reply@vendor.com" }, own)).toMatch(/automated/);
    expect(ignoreReason({ ...base, fromAddress: "MAILER-DAEMON@x.com" }, own)).toMatch(/automated/);
    expect(ignoreReason({ ...base, autoSubmitted: "auto-replied" }, own)).toMatch(/auto-submitted/);
    expect(ignoreReason({ ...base, precedence: "bulk" }, own)).toMatch(/bulk/);
    expect(ignoreReason({ ...base, fromAddress: "" }, own)).toMatch(/sender/);
  });
});

function fakeGraph(routes: Record<string, unknown>, calls: string[] = []) {
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes("login.microsoftonline.com"))
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), {
        status: 200,
      });
    for (const [needle, body] of Object.entries(routes)) {
      if (url.includes(needle)) return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { code: "ErrorItemNotFound", message: "nope" } }), {
      status: 404,
    });
  }) as typeof fetch;
  return new GraphMailSource({ tenantId: "t", clientId: "c", clientSecret: "s", fetchImpl });
}

describe("GraphMailSource", () => {
  it("reads messages, headers and file attachments", async () => {
    const calls: string[] = [];
    const src = fakeGraph(
      {
        "/messages/AAA/attachments": {
          value: [
            {
              "@odata.type": "#microsoft.graph.fileAttachment",
              name: "a.pdf",
              contentType: "application/pdf",
              size: 3,
              isInline: false,
              contentBytes: Buffer.from("pdf").toString("base64"),
            },
            {
              "@odata.type": "#microsoft.graph.fileAttachment",
              name: "logo.png",
              size: 3,
              isInline: true,
              contentBytes: "AAAA",
            },
            { "@odata.type": "#microsoft.graph.itemAttachment", name: "fwd.eml", isInline: false },
          ],
        },
        "/mailFolders/inbox/messages": {
          value: [
            {
              id: "AAA",
              internetMessageId: "<m1@x>",
              subject: "Hello",
              from: { emailAddress: { address: "pat@customer.com", name: "Pat" } },
              receivedDateTime: "2026-11-19T15:00:00Z",
              body: { contentType: "html", content: "<p>Hi</p>" },
              hasAttachments: true,
              internetMessageHeaders: [
                { name: "In-Reply-To", value: "<p@x>" },
                { name: "References", value: "<r1@x> <r2@x>" },
                { name: "Auto-Submitted", value: "auto-replied" },
              ],
            },
          ],
        },
      },
      calls,
    );
    const [m] = await src.fetch("support@hoosiersecurity.com", new Date("2026-11-19T00:00:00Z"));
    expect(m).toMatchObject({
      internetMessageId: "<m1@x>",
      fromAddress: "pat@customer.com",
      bodyText: "Hi",
      inReplyTo: "<p@x>",
      references: ["<r1@x>", "<r2@x>"],
      autoSubmitted: "auto-replied",
      attachmentsUnavailable: 1,
    });
    expect(m?.attachments).toHaveLength(2);
    expect(m?.attachments[0]?.bytes.toString()).toBe("pdf");
    expect(m?.attachments[1]?.isInline).toBe(true);
    const list = calls.find((c) => c.includes("/mailFolders/inbox/messages")) ?? "";
    expect(list).toContain("support%40hoosiersecurity.com");
    expect(list).toContain(encodeURIComponent("receivedDateTime ge 2026-11-19T00:00:00.000Z"));
    expect(calls.filter((c) => c.includes("login.microsoftonline.com"))).toHaveLength(1);
  });

  it("follows paging and reports Graph errors without leaking secrets", async () => {
    const page2 = { value: [] as unknown[] };
    const src = fakeGraph({
      "page=2": page2,
      "/mailFolders/inbox/messages": {
        value: [
          {
            id: "B",
            internetMessageId: "<b@x>",
            receivedDateTime: "2026-11-19T16:00:00Z",
            from: { emailAddress: { address: "a@b.com" } },
            body: { contentType: "text", content: "x" },
          },
        ],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/x?page=2",
      },
    });
    expect(await src.fetch("a@b.com", new Date(0))).toHaveLength(1);
    const broken = fakeGraph({});
    await expect(broken.fetch("a@b.com", new Date(0))).rejects.toThrow(/ErrorItemNotFound/);
    await expect(broken.fetch("a@b.com", new Date(0))).rejects.not.toThrow(/tok/);
  });
});

describe("mail polling configuration", () => {
  const env = { DATABASE_URL: "postgres://x@localhost/db", APP_ENV: "uat" };
  const graph = { GRAPH_TENANT_ID: "t", GRAPH_CLIENT_ID: "c", GRAPH_CLIENT_SECRET: "s" };
  it("is off by default", () => {
    expect(loadConfig(env).MAIL_POLL_ENABLED).toBe(false);
  });
  it("needs credentials, a writable database, and not the shadow", () => {
    expect(() =>
      loadConfig({ ...env, MAIL_POLL_ENABLED: "true", DB_WRITE_MODE: "read_write" }),
    ).toThrow(/GRAPH_/);
    expect(() => loadConfig({ ...env, ...graph, MAIL_POLL_ENABLED: "true" })).toThrow(/read_write/);
    expect(() =>
      loadConfig({
        ...env,
        ...graph,
        APP_ENV: "shadow",
        MAIL_POLL_ENABLED: "true",
        DB_WRITE_MODE: "read_write",
      }),
    ).toThrow(/shadow/);
    expect(
      loadConfig({ ...env, ...graph, MAIL_POLL_ENABLED: "true", DB_WRITE_MODE: "read_write" })
        .MAIL_POLL_ENABLED,
    ).toBe(true);
  });
  it("in production also needs integrations switched on", () => {
    const prod = {
      ...env,
      ...graph,
      APP_ENV: "production",
      NODE_ENV: "production",
      AUTH_MODE: "session",
      AUTH_SECRET: "x".repeat(40),
      MAIL_POLL_ENABLED: "true",
      DB_WRITE_MODE: "read_write",
    };
    expect(() => loadConfig(prod)).toThrow(/INTEGRATIONS_ENABLED/);
    expect(loadConfig({ ...prod, INTEGRATIONS_ENABLED: "true" }).MAIL_POLL_ENABLED).toBe(true);
  });
});
