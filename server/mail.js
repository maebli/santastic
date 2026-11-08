import { decodeReveal, drawRecipients, encodeReveal } from "../public/draw.js";
import {
  normalizeEmail,
  RequestError,
  requireText,
  sign,
  validateId,
} from "./security.js";

function escapeHtml(value) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
}

export async function emailIdentity(env, email) {
  return sign(env.TOKEN_SECRET, `email:${email}`);
}

export async function blockLink(env, email) {
  const identity = await emailIdentity(env, email);
  const signature = await sign(env.TOKEN_SECRET, `block:${identity}`);
  return `${env.SITE_URL}#block=${identity}.${signature}`;
}

export async function makeEmail(env, to, subject, paragraphs, action, link) {
  const block = await blockLink(env, to);
  const footer = "Keine weiteren E-Mails von Santastic erhalten:";
  return {
    from: env.EMAIL_FROM,
    to: [to],
    subject,
    text: [...paragraphs, `${action}:\n${link}`, `${footer}\n${block}`].join(
      "\n\n",
    ),
    html:
      paragraphs.map((text) => `<p>${escapeHtml(text)}</p>`).join("") +
      `<p><a href="${escapeHtml(link)}">${escapeHtml(action)}</a></p>` +
      `<p><a href="${escapeHtml(block)}">${escapeHtml(footer)}</a></p>`,
  };
}

export function validateRound(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new RequestError(400, "Bitte prüfe deine Angaben zur Runde.");
  const round = {
    round: requireText(input.round, 80),
    date: requireText(input.date, 10, true),
    time: requireText(input.time, 5, true),
    budget: requireText(input.budget, 8, true),
    currency: requireText(input.currency, 3),
    message: requireText(input.message, 500, true),
  };
  try {
    decodeReveal(
      encodeReveal({
        version: 1,
        ...round,
        giver: "Person",
        recipient: "Person",
        wish: "",
      }),
    );
    if (round.time && !round.date) throw new Error();
  } catch {
    throw new RequestError(400, "Bitte prüfe Datum, Uhrzeit und Budget.");
  }
  if (
    !Array.isArray(input.participants) ||
    input.participants.length < 3 ||
    input.participants.length > 50
  )
    throw new RequestError(400, "Eine Runde braucht 3 bis 50 Personen.");
  const participants = input.participants.map((person) => ({
    id: validateId(person?.id),
    email: normalizeEmail(person?.email),
    name: requireText(person?.name, 60, true),
    wish: requireText(person?.wish, 300, true),
  }));
  const ids = new Set(participants.map((person) => person.id));
  if (
    ids.size !== participants.length ||
    new Set(participants.map((person) => person.email)).size !==
      participants.length
  )
    throw new RequestError(
      400,
      "Jede Person braucht eine eigene E-Mail-Adresse.",
    );
  if (!Array.isArray(input.exclusions) || input.exclusions.length > 1225)
    throw new RequestError(400, "Ungültige Ausschlüsse.");
  for (const pair of input.exclusions) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      pair[0] === pair[1] ||
      !pair.every((id) => ids.has(id))
    )
      throw new RequestError(400, "Ungültige Ausschlüsse.");
  }
  return { ...round, participants, exclusions: input.exclusions };
}

export async function roundEmails(env, input, organizer) {
  const { participants, exclusions, ...round } = input;
  const assignments = drawRecipients(participants, exclusions);
  if (!assignments)
    throw new RequestError(
      400,
      "Mit diesen Ausschlüssen ist keine Auslosung möglich.",
    );
  return Promise.all(
    participants.map(async (giver) => {
      const recipient = participants.find(
        (person) => person.id === assignments.get(giver.id),
      );
      const payload = {
        version: 1,
        ...round,
        giver: giver.name || giver.email,
        recipient: recipient.name || recipient.email,
        wish: recipient.wish,
      };
      return makeEmail(
        env,
        giver.email,
        "Dein Wichtellos bei Santastic",
        [
          `${organizer} hat dich zu einer Wichtelrunde eingeladen.`,
          "Über deinen persönlichen Link siehst du, wen du beschenkst. Teile diesen Link nicht mit anderen.",
        ],
        "Zuordnung öffnen",
        `${env.SITE_URL}#los=${encodeReveal(payload)}`,
      );
    }),
  );
}
