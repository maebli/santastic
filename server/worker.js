import {
  emailIdentity,
  makeEmail,
  roundEmails,
  validateRound,
} from "./mail.js";
import {
  makeSession,
  normalizeEmail,
  readJson,
  readSession,
  RequestError,
  sign,
  validateId,
  verifySignature,
} from "./security.js";

function sendingEnabled(env) {
  return (
    env.SENDING_ENABLED === "true" &&
    Boolean(
      env.DB &&
      env.RESEND_API_KEY &&
      env.TOKEN_SECRET?.length >= 32 &&
      env.EMAIL_FROM &&
      env.TURNSTILE_SECRET &&
      env.TURNSTILE_SITE_KEY,
    )
  );
}

async function checkTurnstile(env, token, action, ip) {
  if (typeof token !== "string" || !token || token.length > 2048)
    throw new RequestError(403, "Bitte schließe die Sicherheitsprüfung ab.");
  const response = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      body: new URLSearchParams({
        secret: env.TURNSTILE_SECRET,
        response: token,
        remoteip: ip,
      }),
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!response.ok)
    throw new RequestError(
      503,
      "Die Sicherheitsprüfung ist gerade nicht verfügbar.",
    );
  const result = await response.json();
  if (
    result.success !== true ||
    result.hostname !== new URL(env.SITE_URL).hostname ||
    result.action !== action
  )
    throw new RequestError(
      403,
      "Die Sicherheitsprüfung ist abgelaufen. Bitte versuche es erneut.",
    );
}

async function storeJob(env, id, requestHash, kind, organizer, emails) {
  const organizerHash = await emailIdentity(env, organizer);
  const identities = await Promise.all(
    emails.map((email) => emailIdentity(env, email.to[0])),
  );
  const statements = [
    env.DB.prepare(
      "INSERT OR IGNORE INTO jobs (id, request_hash, kind, organizer_hash, payload, email_count) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(
      id,
      requestHash,
      kind,
      organizerHash,
      JSON.stringify(emails),
      emails.length,
    ),
  ];
  for (const identity of identities) {
    statements.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO recipients (job_id, email_hash) SELECT id, ? FROM jobs WHERE id = ? AND request_hash = ?",
      ).bind(identity, id, requestHash),
    );
  }
  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (String(error).includes("sending_limit"))
      throw new RequestError(
        429,
        "Das Versandlimit ist erreicht. Bitte versuche es morgen erneut.",
      );
    if (String(error).includes("recipient_blocked"))
      throw new RequestError(
        409,
        "Der Versand an diese Gruppe ist nicht möglich. Eine Adresse hat weitere E-Mails gesperrt.",
      );
    throw error;
  }
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?")
    .bind(id)
    .first();
  if (!job || job.request_hash !== requestHash)
    throw new RequestError(
      409,
      "Diese Anfrage wurde bereits mit anderen Angaben verwendet.",
    );
  return job;
}

async function dispatchJob(env, job) {
  if (job.state === "sent") return { accepted: job.email_count };
  const now = Math.floor(Date.now() / 1000);
  if (job.expires_at <= now)
    throw new RequestError(
      410,
      "Diese Anfrage ist abgelaufen. Bitte prüfe vor einer neuen Runde, ob E-Mails angekommen sind.",
    );
  const blocked = await env.DB.prepare(
    "SELECT 1 FROM recipients JOIN blocked_recipients USING (email_hash) WHERE job_id = ? LIMIT 1",
  )
    .bind(job.id)
    .first();
  if (blocked)
    throw new RequestError(
      409,
      "Der Versand ist gesperrt, weil eine Adresse keine weiteren E-Mails erhalten möchte.",
    );
  const lock = await env.DB.prepare(
    "UPDATE jobs SET state = 'sending', lease_until = ? WHERE id = ? AND state != 'sent' AND lease_until <= ? RETURNING id",
  )
    .bind(now + 60, job.id, now)
    .first();
  if (!lock)
    throw new RequestError(
      409,
      "Der Versand läuft bereits. Bitte warte eine Minute und prüfe erneut.",
    );
  try {
    const response = await fetch("https://api.resend.com/emails/batch", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `santastic-${job.id}`,
      },
      body: job.payload,
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      console.error(
        JSON.stringify({
          event: "email_provider_error",
          status: response.status,
        }),
      );
      throw new RequestError(
        502,
        "Der E-Mail-Dienst hat den Versand nicht bestätigt. Bitte versuche denselben Versand erneut.",
      );
    }
    const result = await response.json();
    if (
      !Array.isArray(result.data) ||
      result.data.length !== job.email_count ||
      result.data.some((item) => !item.id)
    )
      throw new RequestError(
        502,
        "Der Versandstatus ist unklar. Bitte versuche denselben Versand erneut.",
      );
    await env.DB.prepare(
      "UPDATE jobs SET state = 'sent', payload = '[]', lease_until = 0 WHERE id = ?",
    )
      .bind(job.id)
      .run();
    return { accepted: job.email_count };
  } catch (error) {
    await env.DB.prepare(
      "UPDATE jobs SET lease_until = 0 WHERE id = ? AND state != 'sent'",
    )
      .bind(job.id)
      .run();
    if (error instanceof RequestError) throw error;
    throw new RequestError(
      502,
      "Der Versandstatus ist unklar. Wiederhole denselben Versand, damit keine neuen Lose entstehen.",
    );
  }
}

async function requestVerification(env, body, ip) {
  await checkTurnstile(env, body.turnstileToken, "verify-email", ip);
  const email = normalizeEmail(body.email);
  const id = `verification:${validateId(body.id)}`;
  const requestHash = await sign(env.TOKEN_SECRET, `verification:${email}`);
  const existing = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?")
    .bind(id)
    .first();
  if (existing) {
    if (existing.request_hash !== requestHash)
      throw new RequestError(409, "Bitte starte die Bestätigung erneut.");
    await dispatchJob(env, existing);
    return { accepted: true };
  }
  const token = await makeSession(
    env.TOKEN_SECRET,
    email,
    body.id,
    Date.now() + 3600000,
  );
  const mail = await makeEmail(
    env,
    email,
    "E-Mail-Adresse für Santastic bestätigen",
    [
      "Bestätige deine E-Mail-Adresse, um eine Wichtelrunde zu erstellen. Der Link gilt eine Stunde.",
      "An die Gruppe wird erst nach deiner Bestätigung und dem Absenden der Runde geschrieben. Wenn du diese E-Mail nicht angefordert hast, ignoriere sie oder sperre weitere E-Mails unten.",
    ],
    "E-Mail-Adresse bestätigen",
    `${env.SITE_URL}#verify=${token}`,
  );
  const job = await storeJob(env, id, requestHash, "verification", email, [
    mail,
  ]);
  await dispatchJob(env, job);
  return { accepted: true };
}

async function sendRound(env, body, ip) {
  const session = await readSession(env.TOKEN_SECRET, body.sessionToken);
  await checkTurnstile(env, body.turnstileToken, "send-round", ip);
  const id = `round:${validateId(body.id)}`;
  const input = validateRound(body.round);
  const requestHash = await sign(
    env.TOKEN_SECRET,
    JSON.stringify({ organizer: session.email, input }),
  );
  const existing = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?")
    .bind(id)
    .first();
  if (existing) {
    if (existing.request_hash !== requestHash)
      throw new RequestError(
        409,
        "Die Angaben wurden nach dem ersten Versandversuch geändert.",
      );
    return dispatchJob(env, existing);
  }
  const organizerHash = await emailIdentity(env, session.email);
  if (
    await env.DB.prepare(
      "SELECT 1 FROM blocked_recipients WHERE email_hash = ?",
    )
      .bind(organizerHash)
      .first()
  )
    throw new RequestError(
      403,
      "Für diese Adresse sind weitere E-Mails gesperrt.",
    );
  const emails = await roundEmails(env, input, session.email);
  const job = await storeJob(
    env,
    id,
    requestHash,
    "round",
    session.email,
    emails,
  );
  return dispatchJob(env, job);
}

async function blockRecipient(env, body) {
  if (typeof body.token !== "string" || body.token.length !== 129)
    throw new RequestError(400, "Ungültiger Sperrlink.");
  const [identity, signature] = body.token.split(".");
  if (
    !/^[a-f0-9]{64}$/.test(identity) ||
    !(await verifySignature(env.TOKEN_SECRET, `block:${identity}`, signature))
  )
    throw new RequestError(400, "Ungültiger Sperrlink.");
  await env.DB.prepare("INSERT OR IGNORE INTO blocked_recipients VALUES (?)")
    .bind(identity)
    .run();
  return { blocked: true };
}

export default {
  async fetch(request, env) {
    const origin = new URL(env.SITE_URL).origin;
    const headers = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "no-store",
      Vary: "Origin",
      "X-Content-Type-Options": "nosniff",
    };
    const reply = (data, status = 200) =>
      Response.json(data, { status, headers });
    try {
      const path = new URL(request.url).pathname;
      if (request.method === "OPTIONS")
        return new Response(null, { status: 204, headers });
      if (request.method === "GET" && path === "/config")
        return reply({
          enabled: sendingEnabled(env),
          siteKey: env.TURNSTILE_SITE_KEY,
        });
      if (request.method !== "POST")
        return reply({ error: "Nicht gefunden." }, 404);
      if (request.headers.get("Origin") !== origin)
        return reply({ error: "Zugriff verweigert." }, 403);
      if (
        !env.DB ||
        !env.TOKEN_SECRET ||
        (path !== "/block" && !sendingEnabled(env))
      )
        return reply(
          { error: "Der E-Mail-Versand ist noch nicht eingerichtet." },
          503,
        );
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const rate = await env.REQUEST_LIMITER.limit({
        key: await sign(env.TOKEN_SECRET, `ip:${ip}`),
      });
      if (!rate.success)
        return reply(
          { error: "Zu viele Anfragen. Bitte warte eine Minute." },
          429,
        );
      const body = await readJson(request);
      if (path === "/verification")
        return reply(await requestVerification(env, body, ip));
      if (path === "/session") {
        const session = await readSession(env.TOKEN_SECRET, body.token);
        return reply({ email: session.email, expiresAt: session.expiresAt });
      }
      if (path === "/rounds") return reply(await sendRound(env, body, ip));
      if (path === "/block") return reply(await blockRecipient(env, body));
      return reply({ error: "Nicht gefunden." }, 404);
    } catch (error) {
      if (error instanceof RequestError)
        return reply({ error: error.message }, error.status);
      console.error(JSON.stringify({ event: "request_failed" }));
      return reply(
        {
          error:
            "Die Anfrage konnte nicht abgeschlossen werden. Bitte versuche es erneut.",
        },
        503,
      );
    }
  },
  async scheduled(controller, env) {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE jobs SET payload = '[]' WHERE expires_at < unixepoch() AND payload != '[]'",
      ),
      env.DB.prepare("DELETE FROM jobs WHERE expires_at < unixepoch() - 86400"),
      env.DB.prepare("DELETE FROM quotas WHERE expires_at < unixepoch()"),
    ]);
  },
};
