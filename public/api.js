import { apiUrl } from "./config.js";

export async function serviceConfig() {
  if (!apiUrl) return { enabled: false };
  const response = await fetch(`${apiUrl}/config`, {
    signal: AbortSignal.timeout(10000),
    credentials: "omit",
  });
  if (!response.ok)
    throw new Error("Der E-Mail-Dienst ist gerade nicht erreichbar.");
  return response.json();
}

export async function post(path, data) {
  if (!apiUrl)
    throw new Error("Der E-Mail-Versand ist noch nicht eingerichtet.");
  let response;
  try {
    response = await fetch(`${apiUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
      credentials: "omit",
      signal: AbortSignal.timeout(45000),
    });
  } catch {
    throw new Error(
      "Die Verbindung wurde unterbrochen. Wiederhole denselben Versuch; erstelle keine neue Runde.",
    );
  }
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(
      result.error || "Die Anfrage konnte nicht abgeschlossen werden.",
    );
    error.status = response.status;
    throw error;
  }
  return result;
}

let turnstileLoading;

export function loadTurnstile() {
  if (turnstileLoading) return turnstileLoading;
  turnstileLoading = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src =
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = () => window.turnstile.ready(resolve);
    script.onerror = () =>
      reject(
        new Error(
          "Die Sicherheitsprüfung konnte nicht geladen werden. Bitte lade die Seite neu.",
        ),
      );
    document.head.append(script);
  });
  return turnstileLoading;
}
