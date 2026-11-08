export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function requireText(value, maximum, optional = false) {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    (!optional && !value.trim())
  )
    throw new RequestError(400, "Bitte prüfe deine Angaben.");
  return value.trim();
}

export function normalizeEmail(value) {
  const email = requireText(value, 254).toLowerCase();
  if (
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(
      email,
    ) ||
    email.split("@")[0].length > 64
  )
    throw new RequestError(400, "Bitte gib eine gültige E-Mail-Adresse ein.");
  return email;
}

export function validateId(value) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  )
    throw new RequestError(400, "Ungültige Anfrage.");
  return value;
}

function hex(bytes) {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function signingKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function sign(secret, value) {
  return hex(
    await crypto.subtle.sign(
      "HMAC",
      await signingKey(secret),
      new TextEncoder().encode(value),
    ),
  );
}

export async function verifySignature(secret, value, signature) {
  if (!/^[a-f0-9]{64}$/.test(signature || "")) return false;
  const bytes = Uint8Array.from(signature.match(/../g), (pair) =>
    parseInt(pair, 16),
  );
  return crypto.subtle.verify(
    "HMAC",
    await signingKey(secret),
    bytes,
    new TextEncoder().encode(value),
  );
}

export async function makeSession(secret, email, id, expiresAt) {
  const payload = btoa(JSON.stringify({ email, id, expiresAt }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return `${payload}.${await sign(secret, `session:${payload}`)}`;
}

export async function readSession(secret, token, now = Date.now()) {
  if (typeof token !== "string" || token.length > 1200)
    throw new RequestError(401, "Bitte bestätige deine E-Mail-Adresse erneut.");
  const [payload, signature, extra] = token.split(".");
  if (
    extra ||
    !(await verifySignature(secret, `session:${payload}`, signature))
  )
    throw new RequestError(401, "Der Bestätigungslink ist ungültig.");
  let data;
  try {
    data = JSON.parse(atob(payload.replaceAll("-", "+").replaceAll("_", "/")));
  } catch {
    throw new RequestError(401, "Der Bestätigungslink ist ungültig.");
  }
  if (!Number.isSafeInteger(data.expiresAt) || data.expiresAt <= now)
    throw new RequestError(
      401,
      "Der Bestätigungslink ist abgelaufen. Bitte fordere einen neuen an.",
    );
  return {
    email: normalizeEmail(data.email),
    id: validateId(data.id),
    expiresAt: data.expiresAt,
  };
}

export async function readJson(request) {
  if (!request.headers.get("Content-Type")?.startsWith("application/json"))
    throw new RequestError(415, "Ungültiges Anfrageformat.");
  if (!request.body) throw new RequestError(400, "Die Anfrage ist leer.");
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 65536) {
      await reader.cancel();
      throw new RequestError(413, "Die Anfrage ist zu groß.");
    }
    chunks.push(value);
  }
  try {
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const data = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new Error();
    return data;
  } catch {
    throw new RequestError(400, "Ungültige Anfrage.");
  }
}
