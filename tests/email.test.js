import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import worker from "../server/worker.js";
import { blockLink, emailIdentity } from "../server/mail.js";
import { makeSession, readSession } from "../server/security.js";
import { decodeReveal } from "../public/draw.js";
import {
  formatEuropeanDate,
  isValidTime,
  parseEuropeanDate,
} from "../public/date.js";

class LocalDatabase {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    this.sqlite.exec(
      readFileSync(
        new URL("../server/migrations/0001_email.sql", import.meta.url),
        "utf8",
      ),
    );
  }

  prepare(sql) {
    const statement = this.sqlite.prepare(sql);
    let values = [];
    const query = {
      bind: (...parameters) => {
        values = parameters;
        return query;
      },
      first: async () => statement.get(...values) || null,
      run: async () => statement.run(...values),
    };
    return query;
  }

  async batch(statements) {
    this.sqlite.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

function setup(context) {
  const env = {
    SENDING_ENABLED: "true",
    SITE_URL: "https://maebli.github.io/santastic/",
    EMAIL_FROM: "Santastic <santa@example.com>",
    TOKEN_SECRET: "test-only-signing-secret-not-for-deployment",
    RESEND_API_KEY: "test-only-email-key",
    TURNSTILE_SECRET: "test-only-turnstile-secret",
    TURNSTILE_SITE_KEY: "test-only-site-key",
    DB: new LocalDatabase(),
    REQUEST_LIMITER: { limit: async () => ({ success: true }) },
  };
  const deliveries = [];
  const providerRequests = [];
  const accepted = new Map();
  const state = { loseNextResponse: false, hostname: "maebli.github.io" };
  context.after(() => env.DB.sqlite.close());
  context.mock.method(globalThis, "fetch", async (url, options) => {
    if (url === "https://challenges.cloudflare.com/turnstile/v0/siteverify") {
      return Response.json({
        success: true,
        action: options.body.get("response"),
        hostname: state.hostname,
      });
    }
    assert.equal(url, "https://api.resend.com/emails/batch");
    const key = options.headers["Idempotency-Key"];
    providerRequests.push({ key, payload: options.body });
    let previous = accepted.get(key);
    if (previous) assert.equal(options.body, previous.payload);
    else {
      const emails = JSON.parse(options.body);
      deliveries.push(...emails);
      previous = {
        payload: options.body,
        data: emails.map(() => ({ id: crypto.randomUUID() })),
      };
      accepted.set(key, previous);
    }
    if (state.loseNextResponse) {
      state.loseNextResponse = false;
      throw new Error("Connection lost after provider accepted the emails");
    }
    return Response.json({ data: previous.data });
  });

  async function request(path, body, origin = "https://maebli.github.io") {
    const response = await worker.fetch(
      new Request(`https://api.example.com${path}`, {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          "CF-Connecting-IP": "192.0.2.1",
        },
        body: JSON.stringify(body),
      }),
      env,
    );
    return { status: response.status, data: await response.json() };
  }

  async function verify(email = "organizer@example.com") {
    const response = await request("/verification", {
      id: crypto.randomUUID(),
      email,
      turnstileToken: "verify-email",
    });
    assert.equal(response.status, 200);
    return deliveries.at(-1).text.match(/#verify=([^\s]+)/)[1];
  }

  return { env, deliveries, providerRequests, state, request, verify };
}

function makeRound(count = 3) {
  return {
    round: "Wichteln",
    date: "2026-12-24",
    time: "18:30",
    budget: "25",
    currency: "CHF",
    message: "Treffen zum Abendessen.",
    participants: Array.from({ length: count }, (_, index) => ({
      id: crypto.randomUUID(),
      email: `person${index}@example.com`,
      name: "",
      wish: "Ein Buch",
    })),
    exclusions: [],
  };
}

function roundRequest(sessionToken, round = makeRound()) {
  return {
    id: crypto.randomUUID(),
    sessionToken,
    round,
    turnstileToken: "send-round",
  };
}

test("sending stays disabled without production configuration", async (context) => {
  const app = setup(context);
  app.env.SENDING_ENABLED = "false";
  assert.equal((await app.request("/verification", {})).status, 503);
  assert.equal(app.deliveries.length, 0);
});

test("rejects foreign origins, forged sessions and invalid bot challenges", async (context) => {
  const app = setup(context);
  assert.equal(
    (await app.request("/verification", {}, "https://attacker.example")).status,
    403,
  );
  assert.equal(
    (await app.request("/rounds", roundRequest("forged"))).status,
    401,
  );
  assert.equal(
    (
      await app.request("/verification", {
        id: crypto.randomUUID(),
        email: "a@example.com",
        turnstileToken: "wrong-action",
      })
    ).status,
    403,
  );
  app.state.hostname = "attacker.example";
  assert.equal(
    (
      await app.request("/verification", {
        id: crypto.randomUUID(),
        email: "a@example.com",
        turnstileToken: "verify-email",
      })
    ).status,
    403,
  );
  assert.equal(app.deliveries.length, 0);
});

test("confirmation expires and signature changes invalidate it", async () => {
  const token = await makeSession(
    "test-secret",
    "a@example.com",
    crypto.randomUUID(),
    1000,
  );
  await assert.rejects(readSession("test-secret", token, 1000), /abgelaufen/);
  const [payload, signature] = token.split(".");
  const changed = `${payload}.${signature[0] === "0" ? "1" : "0"}${signature.slice(1)}`;
  await assert.rejects(readSession("test-secret", changed, 0), /ungültig/);
});

test("verification sends only to the organiser; opening the link sends nothing to participants", async (context) => {
  const app = setup(context);
  const token = await app.verify();
  assert.equal(app.deliveries.length, 1);
  assert.deepEqual(app.deliveries[0].to, ["organizer@example.com"]);
  assert.equal((await app.request("/session", { token })).status, 200);
  assert.equal(app.deliveries.length, 1);
});

test("sends one private assignment per participant and preserves the draw on retries", async (context) => {
  const app = setup(context);
  const token = await app.verify();
  const body = roundRequest(token);
  assert.deepEqual(await app.request("/rounds", body), {
    status: 200,
    data: { accepted: 3 },
  });
  const emails = app.deliveries.slice(1);
  const recipients = new Set();
  for (const email of emails) {
    assert.equal(email.to.length, 1);
    assert.equal(email.cc, undefined);
    assert.equal(email.bcc, undefined);
    const reveal = decodeReveal(email.text.match(/#los=([^\s]+)/)[1]);
    assert.equal(reveal.giver, email.to[0]);
    assert.notEqual(reveal.giver, reveal.recipient);
    assert.equal(reveal.date, "2026-12-24");
    assert.equal(reveal.time, "18:30");
    recipients.add(reveal.recipient);
  }
  assert.equal(recipients.size, 3);
  assert.equal((await app.request("/rounds", body)).status, 200);
  assert.equal(app.deliveries.length, 4);
  assert.equal(app.providerRequests.length, 2);
  body.round.message = "Changed after sending";
  assert.equal((await app.request("/rounds", body)).status, 409);
  assert.equal(app.deliveries.length, 4);
  assert.equal(
    app.env.DB.sqlite
      .prepare("SELECT count(*) AS n FROM jobs WHERE payload != '[]'")
      .get().n,
    0,
  );
});

test("a lost provider response retries the same batch without sending it twice", async (context) => {
  const app = setup(context);
  const body = roundRequest(await app.verify());
  app.state.loseNextResponse = true;
  assert.equal((await app.request("/rounds", body)).status, 502);
  assert.equal((await app.request("/rounds", body)).status, 200);
  assert.equal(app.deliveries.length, 4);
  const attempts = app.providerRequests.slice(1);
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0], attempts[1]);
});

test("an active send lease prevents concurrent sends", async (context) => {
  const app = setup(context);
  const body = roundRequest(await app.verify());
  app.state.loseNextResponse = true;
  await app.request("/rounds", body);
  app.env.DB.sqlite
    .prepare(
      "UPDATE jobs SET lease_until = unixepoch() + 60 WHERE kind = 'round'",
    )
    .run();
  const before = app.providerRequests.length;
  assert.equal((await app.request("/rounds", body)).status, 409);
  assert.equal(app.providerRequests.length, before);
});

test("rejects sends after the retry window instead of reusing an expired provider key", async (context) => {
  const app = setup(context);
  const body = roundRequest(await app.verify());
  app.state.loseNextResponse = true;
  await app.request("/rounds", body);
  app.env.DB.sqlite
    .prepare(
      "UPDATE jobs SET expires_at = unixepoch() - 1 WHERE kind = 'round'",
    )
    .run();
  const before = app.providerRequests.length;
  assert.equal((await app.request("/rounds", body)).status, 410);
  assert.equal(app.providerRequests.length, before);
});

test("organiser quota rejects the third round and rolls back its reservations", async (context) => {
  const app = setup(context);
  const token = await app.verify();
  assert.equal((await app.request("/rounds", roundRequest(token))).status, 200);
  assert.equal((await app.request("/rounds", roundRequest(token))).status, 200);
  assert.equal((await app.request("/rounds", roundRequest(token))).status, 429);
  assert.equal(app.deliveries.length, 7);
  assert.equal(
    app.env.DB.sqlite
      .prepare("SELECT count(*) AS n FROM jobs WHERE kind = 'round'")
      .get().n,
    2,
  );
  assert.equal(
    app.env.DB.sqlite
      .prepare("SELECT used FROM quotas WHERE bucket = 'daily:' || date('now')")
      .get().used,
    7,
  );
});

test("daily budget counts confirmation emails and refuses an oversized batch atomically", async (context) => {
  const app = setup(context);
  const token = await app.verify();
  assert.equal(
    (await app.request("/rounds", roundRequest(token, makeRound(50)))).status,
    200,
  );
  assert.equal(
    (await app.request("/rounds", roundRequest(token, makeRound(50)))).status,
    429,
  );
  assert.equal(app.deliveries.length, 51);
  assert.equal(
    app.env.DB.sqlite
      .prepare("SELECT used FROM quotas WHERE bucket = 'daily:' || date('now')")
      .get().used,
    51,
  );
});

test("monthly budget is enforced across daily resets", async (context) => {
  const app = setup(context);
  app.env.DB.sqlite
    .prepare(
      "INSERT INTO quotas VALUES ('monthly:' || strftime('%Y-%m', 'now'), 2999, 3000, unixepoch() + 86400)",
    )
    .run();
  await app.verify();
  assert.equal(
    (
      await app.request("/verification", {
        id: crypto.randomUUID(),
        email: "other@example.com",
        turnstileToken: "verify-email",
      })
    ).status,
    429,
  );
  assert.equal(app.deliveries.length, 1);
});

test("recipient limits apply across different organisers", async (context) => {
  const app = setup(context);
  for (let index = 0; index < 3; index++) {
    const token = await app.verify(`organizer${index}@example.com`);
    assert.equal(
      (await app.request("/rounds", roundRequest(token))).status,
      200,
    );
  }
  const token = await app.verify("organizer4@example.com");
  const before = app.deliveries.length;
  assert.equal((await app.request("/rounds", roundRequest(token))).status, 429);
  assert.equal(app.deliveries.length, before);
});

test("signed block links stop future emails without exposing other recipients", async (context) => {
  const app = setup(context);
  const session = await app.verify();
  const link = await blockLink(app.env, "person0@example.com");
  const token = link.split("#block=")[1];
  assert.equal((await app.request("/block", { token })).status, 200);
  assert.equal(
    (await app.request("/rounds", roundRequest(session))).status,
    409,
  );
  assert.equal(app.deliveries.length, 1);
  assert.equal(
    app.env.DB.sqlite.prepare("SELECT count(*) AS n FROM jobs").get().n,
    1,
  );
  assert.equal(
    (await app.request("/block", { token: `${token.slice(0, -1)}x` })).status,
    400,
  );
  const identity = await emailIdentity(app.env, "person0@example.com");
  assert.equal(
    app.env.DB.sqlite.prepare("SELECT email_hash FROM blocked_recipients").get()
      .email_hash,
    identity,
  );
});

test("blocked addresses cannot be sent verification emails", async (context) => {
  const app = setup(context);
  const token = (await blockLink(app.env, "organizer@example.com")).split(
    "#block=",
  )[1];
  await app.request("/block", { token });
  assert.equal(
    (
      await app.request("/verification", {
        id: crypto.randomUUID(),
        email: "organizer@example.com",
        turnstileToken: "verify-email",
      })
    ).status,
    409,
  );
  assert.equal(app.deliveries.length, 0);
});

test("European dates and 24-hour times reject invalid calendar values", () => {
  assert.equal(parseEuropeanDate("24.12.2026"), "2026-12-24");
  assert.equal(formatEuropeanDate("2026-12-24"), "24.12.2026");
  assert.equal(parseEuropeanDate("31.02.2026"), null);
  assert.equal(parseEuropeanDate("29.02.2028"), "2028-02-29");
  assert.equal(parseEuropeanDate("12/24/2026"), null);
  assert.equal(isValidTime("23:59"), true);
  assert.equal(isValidTime("24:00"), false);
  assert.equal(isValidTime("6:30 PM"), false);
});

test("invalid round data and oversized requests cannot send emails", async (context) => {
  const app = setup(context);
  const session = await app.verify();
  const missing = roundRequest(session);
  delete missing.round;
  assert.equal((await app.request("/rounds", missing)).status, 400);
  const duplicate = roundRequest(session);
  duplicate.round.participants[1].email = duplicate.round.participants[0].email;
  assert.equal((await app.request("/rounds", duplicate)).status, 400);
  const oversized = roundRequest(session);
  oversized.round.message = "a".repeat(70000);
  assert.equal((await app.request("/rounds", oversized)).status, 413);
  assert.equal(app.deliveries.length, 1);
});

test("user text stays out of email HTML and subjects", async (context) => {
  const app = setup(context);
  const body = roundRequest(await app.verify());
  body.round.round = '<img src="x" onerror="alert(1)">';
  body.round.message = '<a href="https://attacker.example">Click</a>';
  assert.equal((await app.request("/rounds", body)).status, 200);
  for (const email of app.deliveries.slice(1)) {
    assert.equal(email.subject, "Dein Wichtellos bei Santastic");
    assert.ok(!email.html.includes("<img"));
    assert.ok(!email.html.includes("https://attacker.example"));
  }
});

test("cleanup removes expired message data and retains recipient blocks", async (context) => {
  const app = setup(context);
  const body = roundRequest(await app.verify());
  app.state.loseNextResponse = true;
  await app.request("/rounds", body);
  const token = (await blockLink(app.env, "blocked@example.com")).split(
    "#block=",
  )[1];
  await app.request("/block", { token });
  app.env.DB.sqlite
    .prepare("UPDATE jobs SET expires_at = unixepoch() - 1")
    .run();
  await worker.scheduled({}, app.env);
  assert.equal(
    app.env.DB.sqlite
      .prepare("SELECT count(*) AS n FROM jobs WHERE payload != '[]'")
      .get().n,
    0,
  );
  app.env.DB.sqlite
    .prepare("UPDATE jobs SET expires_at = unixepoch() - 90000")
    .run();
  await worker.scheduled({}, app.env);
  assert.equal(
    app.env.DB.sqlite.prepare("SELECT count(*) AS n FROM jobs").get().n,
    0,
  );
  assert.equal(
    app.env.DB.sqlite.prepare("SELECT count(*) AS n FROM recipients").get().n,
    0,
  );
  assert.equal(
    app.env.DB.sqlite
      .prepare("SELECT count(*) AS n FROM blocked_recipients")
      .get().n,
    1,
  );
});
