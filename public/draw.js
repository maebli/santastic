import { isValidTime } from "./date.js";

function randomIndex(length) {
  const range = 2 ** 32;
  const limit = range - (range % length);
  const value = new Uint32Array(1);
  do {
    crypto.getRandomValues(value);
  } while (value[0] >= limit);
  return value[0] % length;
}

function shuffle(values) {
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const other = randomIndex(index + 1);
    [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
  }
  return shuffled;
}

export function drawRecipients(participants, exclusions) {
  const candidates = new Map(
    participants.map((giver) => [
      giver.id,
      shuffle(
        participants
          .filter(
            (recipient) =>
              giver.id !== recipient.id &&
              !exclusions.some(
                (pair) =>
                  pair.includes(giver.id) && pair.includes(recipient.id),
              ),
          )
          .map((recipient) => recipient.id),
      ),
    ]),
  );
  const recipientOwners = new Map();

  function assign(giverId, visitedRecipients) {
    for (const recipientId of candidates.get(giverId)) {
      if (visitedRecipients.has(recipientId)) continue;
      visitedRecipients.add(recipientId);
      const previousGiver = recipientOwners.get(recipientId);
      if (
        previousGiver === undefined ||
        assign(previousGiver, visitedRecipients)
      ) {
        recipientOwners.set(recipientId, giverId);
        return true;
      }
    }
    return false;
  }

  for (const giver of shuffle(participants)) {
    if (!assign(giver.id, new Set())) return null;
  }
  return new Map(
    [...recipientOwners].map(([recipient, giver]) => [giver, recipient]),
  );
}

export function encodeReveal(data) {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function decodeReveal(value) {
  if (!/^[A-Za-z0-9_-]{1,16000}$/.test(value))
    throw new Error("Ungültiger Link");
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  const data = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    ),
  );
  const fields = {
    giver: 254,
    recipient: 254,
    wish: 300,
    round: 80,
    date: 10,
    budget: 8,
    currency: 3,
    message: 500,
  };
  if (!data || data.version !== 1) throw new Error("Ungültiger Link");
  if (
    data.time !== undefined &&
    (typeof data.time !== "string" || !isValidTime(data.time))
  )
    throw new Error("Ungültige Uhrzeit");
  for (const [field, maxLength] of Object.entries(fields)) {
    if (typeof data[field] !== "string" || data[field].length > maxLength)
      throw new Error("Ungültiger Link");
  }
  if (!data.giver.trim() || !data.recipient.trim() || !data.round.trim())
    throw new Error("Ungültiger Link");
  if (!/^(EUR|CHF|USD)$/.test(data.currency))
    throw new Error("Ungültige Währung");
  if (
    data.budget &&
    (!/^\d{1,5}(\.\d{1,2})?$/.test(data.budget) || Number(data.budget) > 10000)
  )
    throw new Error("Ungültiges Budget");
  if (data.date) {
    const date = new Date(`${data.date}T12:00:00Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(data.date) ||
      !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== data.date
    )
      throw new Error("Ungültiges Datum");
  }
  return data;
}
