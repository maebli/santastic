import { decodeReveal } from "./draw.js";
import { loadTurnstile, post, serviceConfig } from "./api.js";
import { formatEuropeanDate, isValidTime, parseEuropeanDate } from "./date.js";

const get = (id) => document.getElementById(id);
const participants = [];
let exclusions = [];
let round = null;
let sessionToken = "";
let service = null;
let verificationWidget;
let roundWidget;
let verificationId = crypto.randomUUID();
let submission = null;
let sending = false;
let uncertainDelivery = false;
let currentStep = 0;

function participantLabel(person) {
  return person.name.trim() || person.email.trim();
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showStatus(message) {
  get("form-status").textContent = message;
}

function showStep(step) {
  currentStep = step;
  ["details-panel", "people-panel", "results-panel"].forEach((id, index) => {
    const panel = get(id);
    panel.hidden = index !== step;
    panel
      .querySelectorAll("input, textarea, select, button")
      .forEach((control) => {
        control.disabled = index !== step;
      });
  });
  document.querySelectorAll(".wizard-progress li").forEach((item, index) => {
    item.classList.toggle("active", index <= step);
    if (index === step) item.setAttribute("aria-current", "step");
    else item.removeAttribute("aria-current");
  });
  showStatus("");
  get(["details-title", "people-title", "results-title"][step]).focus({
    preventScroll: true,
  });
  get("create").scrollIntoView({ behavior: "smooth", block: "start" });
  get("add-person").disabled = step !== 1 || participants.length >= 50;
  if (step === 1 && service && roundWidget === undefined)
    roundWidget = window.turnstile.render("#round-challenge", {
      sitekey: service.siteKey,
      action: "send-round",
      size: "flexible",
      theme: "light",
      language: "de",
    });
}

function refreshExclusions() {
  const selects = [get("exclude-first"), get("exclude-second")];
  selects.forEach((select) => {
    const previousValue = select.value;
    select.replaceChildren(
      ...participants.map((person, index) => {
        const option = element(
          "option",
          "",
          participantLabel(person) || `Person ${index + 1}`,
        );
        option.value = person.id;
        return option;
      }),
    );
    if (participants.some((person) => person.id === previousValue))
      select.value = previousValue;
  });
  if (selects[0].value === selects[1].value && selects[1].options.length > 1)
    selects[1].selectedIndex = 1;
  get("exclusion-list").replaceChildren(
    ...exclusions.map((pair) => {
      const names = pair.map((id) => {
        const index = participants.findIndex((person) => person.id === id);
        return participantLabel(participants[index]) || `Person ${index + 1}`;
      });
      const row = element("li");
      const remove = element("button", "", "×");
      remove.type = "button";
      remove.setAttribute(
        "aria-label",
        `Ausschluss ${names.join(" und ")} entfernen`,
      );
      remove.addEventListener("click", () => {
        exclusions = exclusions.filter((existing) => existing !== pair);
        refreshExclusions();
        get("add-exclusion").focus();
      });
      row.append(element("span", "", names.join(" ↔ ")), remove);
      return row;
    }),
  );
}

function renderParticipants() {
  get("participants").replaceChildren(
    ...participants.map((person, index) => {
      const row = element("div", "person-row");
      const fields = element("div", "person-fields");
      const emailLabel = element("label", "", `E-Mail-Adresse ${index + 1}`);
      const emailInput = element("input");
      emailInput.id = `email-${person.id}`;
      emailInput.name = emailInput.id;
      emailInput.type = "email";
      emailInput.required = true;
      emailInput.maxLength = 254;
      emailInput.autocomplete = "email";
      emailInput.autocapitalize = "none";
      emailInput.spellcheck = false;
      emailInput.placeholder = "name@beispiel.de";
      emailInput.value = person.email;
      emailLabel.htmlFor = emailInput.id;
      emailInput.addEventListener("input", () => {
        person.email = emailInput.value;
        for (const participant of participants)
          get(`email-${participant.id}`).setCustomValidity("");
        refreshExclusions();
      });
      const nameLabel = element("label", "", "Name");
      nameLabel.append(element("span", "", "optional"));
      const nameInput = element("input");
      nameInput.id = `name-${person.id}`;
      nameInput.name = nameInput.id;
      nameInput.maxLength = 60;
      nameInput.autocomplete = "off";
      nameInput.placeholder =
        ["Zum Beispiel: Alex", "Zum Beispiel: Kim", "Zum Beispiel: Sam"][
          index
        ] || "Name";
      nameInput.value = person.name;
      nameLabel.htmlFor = nameInput.id;
      nameInput.addEventListener("input", () => {
        person.name = nameInput.value;
        nameInput.setCustomValidity("");
        refreshExclusions();
      });
      const wishLabel = element("label", "", "Wunschzettel");
      wishLabel.append(element("span", "", "optional"));
      const wishInput = element("textarea");
      wishInput.id = `wish-${person.id}`;
      wishInput.name = wishInput.id;
      wishInput.rows = 1;
      wishInput.maxLength = 300;
      wishInput.value = person.wish;
      wishInput.placeholder = "Zum Beispiel: Kaffee oder ein Buch";
      wishLabel.htmlFor = wishInput.id;
      wishInput.addEventListener("input", () => {
        person.wish = wishInput.value;
      });
      const remove = element("button", "remove-person", "×");
      remove.type = "button";
      remove.setAttribute("aria-label", `Person ${index + 1} entfernen`);
      remove.addEventListener("click", () => {
        participants.splice(index, 1);
        exclusions = exclusions.filter((pair) => !pair.includes(person.id));
        renderParticipants();
        get("add-person").focus();
      });
      fields.append(
        emailLabel,
        emailInput,
        nameLabel,
        nameInput,
        wishLabel,
        wishInput,
      );
      row.append(
        element("span", "person-number", String(index + 1).padStart(2, "0")),
        fields,
        remove,
      );
      return row;
    }),
  );
  get("add-person").disabled = participants.length >= 50;
  refreshExclusions();
}

function addParticipant() {
  if (participants.length >= 50) return;
  participants.push({ id: crypto.randomUUID(), email: "", name: "", wish: "" });
  renderParticipants();
}

function readRound() {
  return {
    round: get("round-name").value.trim(),
    date: parseEuropeanDate(get("round-date").value.trim()),
    time: get("round-time").value.trim(),
    budget: get("budget").value ? String(Number(get("budget").value)) : "",
    currency: get("currency").value,
    message: get("round-message").value.trim(),
  };
}

function lockPeople(locked) {
  get("people-panel")
    .querySelectorAll("input, textarea, select, button")
    .forEach((control) => {
      if (control.id !== "draw-button") control.disabled = locked;
    });
  if (!locked) get("add-person").disabled = participants.length >= 50;
}

async function createDraw() {
  if (sending) return;
  if (participants.length < 3) {
    showStatus("Für eine Wichtelrunde brauchst du mindestens 3 Personen.");
    return;
  }
  const seenEmails = new Set();
  for (const person of participants) {
    const email = person.email.trim().toLowerCase();
    if (seenEmails.has(email)) {
      const input = get(`email-${person.id}`);
      input.setCustomValidity("Diese E-Mail-Adresse ist bereits eingetragen.");
      input.reportValidity();
      return;
    }
    seenEmails.add(email);
  }
  const turnstileToken = window.turnstile.getResponse(roundWidget);
  if (!turnstileToken) {
    showStatus("Bitte schließe die Sicherheitsprüfung ab.");
    return;
  }
  if (!submission)
    submission = {
      id: crypto.randomUUID(),
      round: structuredClone({ ...round, participants, exclusions }),
    };
  sending = true;
  lockPeople(true);
  get("draw-button").disabled = true;
  showStatus("Die Runde wird ausgelost und der Versand wird beauftragt.");
  try {
    const result = await post("/rounds", {
      ...submission,
      sessionToken,
      turnstileToken,
    });
    get("delivery-summary").textContent =
      `${result.accepted} E-Mails wurden vom Versanddienst angenommen.`;
    get("result-list").replaceChildren(
      ...submission.round.participants.map((person) => {
        const row = element("div", "result-row");
        row.append(
          element("strong", "", person.email),
          element("span", "", "Angenommen"),
        );
        return row;
      }),
    );
    showStep(2);
  } catch (error) {
    showStatus(error.message);
    if (!uncertainDelivery && [400, 403, 429].includes(error.status)) {
      submission = null;
      lockPeople(false);
    } else {
      uncertainDelivery = true;
      get("draw-button").textContent = "Versand erneut prüfen";
    }
  } finally {
    sending = false;
    get("draw-button").disabled = currentStep !== 1;
    window.turnstile.reset(roundWidget);
  }
}

async function initializeEmail() {
  const status = get("verification-status");
  const incomingToken = location.hash.startsWith("#verify=")
    ? location.hash.slice(8)
    : "";
  if (incomingToken)
    history.replaceState(null, "", location.pathname + location.search);
  try {
    service = await serviceConfig();
    if (!service.enabled) {
      status.textContent =
        "Der E-Mail-Versand ist noch nicht eingerichtet. Zurzeit können keine neuen Runden erstellt werden.";
      get("verification-form").hidden = true;
      return;
    }
    if (incomingToken) {
      sessionToken = incomingToken;
      const session = await post("/session", { token: sessionToken });
      await loadTurnstile();
      get("verification-panel").hidden = true;
      get("round-builder").hidden = false;
      get("verified-organizer").textContent = `Bestätigt: ${session.email}`;
      showStep(0);
      return;
    }
    await loadTurnstile();
    verificationWidget = window.turnstile.render("#verification-challenge", {
      sitekey: service.siteKey,
      action: "verify-email",
      size: "flexible",
      theme: "light",
      language: "de",
    });
    get("verify-email").disabled = false;
    status.textContent = "";
  } catch (error) {
    status.textContent = error.message;
    if (incomingToken) {
      const restart = element(
        "a",
        "text-button",
        "Neuen Bestätigungslink anfordern",
      );
      restart.href = "./";
      status.append(element("br"), restart);
    }
  }
}

get("verification-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = get("verify-email");
  const status = get("verification-status");
  const turnstileToken = window.turnstile.getResponse(verificationWidget);
  if (!turnstileToken) {
    status.textContent = "Bitte schließe die Sicherheitsprüfung ab.";
    return;
  }
  button.disabled = true;
  get("organizer-email").disabled = true;
  try {
    await post("/verification", {
      id: verificationId,
      email: get("organizer-email").value.trim(),
      turnstileToken,
    });
    get("verification-form").hidden = true;
    status.textContent =
      "Öffne den Bestätigungslink in deiner E-Mail. Prüfe auch den Spamordner. An die Gruppe wurde noch nichts verschickt.";
  } catch (error) {
    status.textContent = error.message;
    button.disabled = false;
    get("organizer-email").disabled = false;
  } finally {
    window.turnstile.reset(verificationWidget);
  }
});
get("organizer-email").addEventListener("input", () => {
  verificationId = crypto.randomUUID();
});

function openBlock() {
  get("organizer").hidden = true;
  get("block-view").hidden = false;
  document.querySelector("nav").hidden = true;
  const token = location.hash.slice(7);
  get("block-email").addEventListener("click", async () => {
    get("block-email").disabled = true;
    try {
      await post("/block", { token });
      get("block-status").textContent =
        "Weitere E-Mails an diese Adresse sind gesperrt. Bereits beauftragte E-Mails können noch ankommen.";
      get("block-email").hidden = true;
    } catch (error) {
      get("block-status").textContent = error.message;
      get("block-email").disabled = false;
    }
  });
}

function addRevealDetail(title, text) {
  if (!text) return;
  const detail = element("div", "reveal-detail");
  detail.append(element("h3", "", title), element("p", "", text));
  get("reveal-details").append(detail);
}

function openReveal() {
  get("organizer").hidden = true;
  get("reveal-view").hidden = false;
  document.querySelector("nav").hidden = true;
  try {
    const data = decodeReveal(location.hash.slice(5));
    get("reveal-greeting").textContent =
      `Hallo ${data.giver}! Dein Los für „${data.round}“ ist bereit.`;
    get("reveal-button").addEventListener(
      "click",
      () => {
        get("reveal-button").hidden = true;
        get("reveal-title").textContent = "Deine Zuordnung";
        get("recipient-name").textContent = data.recipient;
        get("reveal-details").replaceChildren();
        addRevealDetail(
          "Wunschzettel",
          data.wish || "Kein Wunschzettel angegeben.",
        );
        if (data.budget)
          addRevealDetail(
            "Euer Geschenkbudget",
            new Intl.NumberFormat("de-DE", {
              style: "currency",
              currency: data.currency,
            }).format(Number(data.budget)),
          );
        if (data.date) addRevealDetail("Datum", formatEuropeanDate(data.date));
        if (data.time) addRevealDetail("Uhrzeit", `${data.time} Uhr`);
        addRevealDetail("Nachricht an eure Runde", data.message);
        get("revealed-content").hidden = false;
        get("recipient-name").tabIndex = -1;
        get("recipient-name").focus();
      },
      { once: true },
    );
  } catch {
    get("reveal-title").textContent = "Dieses Los können wir nicht öffnen.";
    get("reveal-greeting").textContent =
      "Der Link ist unvollständig oder ungültig. Bitte die Organisation um deinen vollständigen Los-Link.";
    get("reveal-button").hidden = true;
  }
}

get("round-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (currentStep === 0) {
    round = readRound();
    if (round.date === null) {
      get("round-date").setCustomValidity(
        "Bitte gib ein gültiges Datum als TT.MM.JJJJ ein.",
      );
      get("round-date").reportValidity();
      return;
    }
    if (!isValidTime(round.time) || (round.time && !round.date)) {
      get("round-time").setCustomValidity(
        "Bitte gib eine Uhrzeit als HH:MM und ein Datum ein.",
      );
      get("round-time").reportValidity();
      return;
    }
    if (!round.round) {
      get("round-name").setCustomValidity("Bitte gib eurer Runde einen Namen.");
      get("round-name").reportValidity();
      return;
    }
    showStep(1);
  } else if (currentStep === 1) createDraw();
});
get("round-name").addEventListener("input", () =>
  get("round-name").setCustomValidity(""),
);
for (const id of ["round-date", "round-time"]) {
  get(id).addEventListener("input", () => {
    get("round-date").setCustomValidity("");
    get("round-time").setCustomValidity("");
  });
}
get("add-person").addEventListener("click", () => {
  addParticipant();
  get(`email-${participants.at(-1).id}`).focus();
});
get("back-details").addEventListener("click", () => showStep(0));
get("add-exclusion").addEventListener("click", () => {
  const pair = [get("exclude-first").value, get("exclude-second").value];
  if (!pair[0] || pair[0] === pair[1]) {
    showStatus("Wähle zwei unterschiedliche Personen aus.");
    return;
  }
  if (
    exclusions.some((existing) => pair.every((id) => existing.includes(id)))
  ) {
    showStatus("Dieser Ausschluss ist bereits gespeichert.");
    return;
  }
  exclusions.push(pair);
  refreshExclusions();
  showStatus(
    "Ausschluss hinzugefügt. Diese Personen ziehen sich nicht gegenseitig.",
  );
});
get("restart").addEventListener("click", () =>
  get("restart-dialog").showModal(),
);
get("cancel-restart").addEventListener("click", () =>
  get("restart-dialog").close(),
);
get("confirm-restart").addEventListener("click", () => {
  get("restart-dialog").close();
  get("round-form").reset();
  participants.splice(0);
  exclusions = [];
  round = null;
  submission = null;
  uncertainDelivery = false;
  get("draw-button").textContent = "Auslosen und E-Mails senden";
  get("result-list").replaceChildren();
  for (let index = 0; index < 3; index += 1) addParticipant();
  showStep(0);
});

window.addEventListener("hashchange", () => {
  if (/^#(los|verify|block)=/.test(location.hash)) location.reload();
});

if (location.hash.startsWith("#los=")) openReveal();
else if (location.hash.startsWith("#block=")) openBlock();
else {
  for (let index = 0; index < 3; index += 1) addParticipant();
  initializeEmail();
  get("people-panel")
    .querySelectorAll("input, textarea, select, button")
    .forEach((control) => {
      control.disabled = true;
    });
}
