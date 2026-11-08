import { decodeReveal, drawRecipients, encodeReveal } from "./draw.js";

const get = (id) => document.getElementById(id);
const participants = [];
let exclusions = [];
let round = null;
let results = [];
let currentStep = 0;

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
          person.name.trim() || `Person ${index + 1}`,
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
        return participants[index].name.trim() || `Person ${index + 1}`;
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
      const nameLabel = element("label", "", `Person ${index + 1}`);
      const nameInput = element("input");
      nameInput.id = `name-${person.id}`;
      nameInput.name = nameInput.id;
      nameInput.maxLength = 60;
      nameInput.required = true;
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
      fields.append(nameLabel, nameInput, wishLabel, wishInput);
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
  participants.push({ id: crypto.randomUUID(), name: "", wish: "" });
  renderParticipants();
}

function readRound() {
  return {
    round: get("round-name").value.trim(),
    date: get("round-date").value,
    budget: get("budget").value ? String(Number(get("budget").value)) : "",
    currency: get("currency").value,
    message: get("round-message").value.trim(),
  };
}

function showManualCopy(link) {
  let wrapper = get("manual-copy");
  if (!wrapper) {
    wrapper = element("div", "manual-copy");
    wrapper.id = "manual-copy";
    const label = element("label", "", "Diesen Link manuell kopieren:");
    label.htmlFor = "manual-copy-value";
    const input = element("input");
    input.id = "manual-copy-value";
    input.readOnly = true;
    wrapper.append(label, input);
    get("result-list").after(wrapper);
  }
  const input = get("manual-copy-value");
  input.value = link;
  input.focus();
  input.select();
}

async function copyResult(result, button) {
  try {
    await navigator.clipboard.writeText(result.link);
    button.textContent = "Kopiert ✓";
    showStatus(`Los-Link für ${result.name} kopiert.`);
    setTimeout(() => {
      button.textContent = "Link kopieren ↗";
    }, 2500);
  } catch {
    showManualCopy(result.link);
    showStatus(
      "Automatisches Kopieren ist hier nicht verfügbar. Kopiere den markierten Link.",
    );
  }
}

function renderResults() {
  get("result-list").replaceChildren(
    ...results.map((result) => {
      const row = element("div", "result-row");
      const copy = element("button", "button secondary", "Link kopieren ↗");
      copy.type = "button";
      copy.setAttribute("aria-label", `Los-Link für ${result.name} kopieren`);
      copy.addEventListener("click", () => copyResult(result, copy));
      row.append(element("strong", "", result.name), copy);
      return row;
    }),
  );
}

function createDraw() {
  if (participants.length < 3) {
    showStatus("Für eine Wichtelrunde brauchst du mindestens 3 Menschen.");
    return;
  }
  const seenNames = new Set();
  for (const person of participants) {
    const name = person.name.trim().normalize("NFC").toLocaleLowerCase("de");
    if (!name || seenNames.has(name)) {
      const input = get(`name-${person.id}`);
      input.setCustomValidity(
        name
          ? "Bitte verwende unterschiedliche Namen, zum Beispiel Alex M. und Alex S."
          : "Bitte gib einen Namen ein.",
      );
      input.reportValidity();
      return;
    }
    seenNames.add(name);
  }
  const assignments = drawRecipients(participants, exclusions);
  if (!assignments) {
    showStatus(
      "Mit diesen Ausschlüssen ist keine Auslosung möglich. Entferne einen Ausschluss oder füge weitere Personen hinzu.",
    );
    return;
  }
  const baseUrl = new URL("./", location.href);
  results = participants.map((giver) => {
    const recipient = participants.find(
      (person) => person.id === assignments.get(giver.id),
    );
    const payload = {
      version: 1,
      ...round,
      giver: giver.name.trim(),
      recipient: recipient.name.trim(),
      wish: recipient.wish.trim(),
    };
    const link = new URL(baseUrl);
    link.hash = `los=${encodeReveal(payload)}`;
    return { name: giver.name.trim(), link: link.href };
  });
  renderResults();
  showStep(2);
}

function downloadLinks() {
  const text = [
    round.round,
    "",
    "Teile jeden Los-Link nur mit der zugehörigen Person. Wer den Link hat, kann das Los sehen.",
    "",
    ...results.flatMap((result) => [result.name, result.link, ""]),
  ].join("\n");
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/plain;charset=utf-8" }),
  );
  const link = element("a");
  link.href = url;
  link.download = "santastic-los-links.txt";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showStatus(
    "Die Link-Datei wurde zum Download bereitgestellt. Bewahre sie für eure Runde auf.",
  );
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
        if (data.date)
          addRevealDetail(
            "Datum",
            new Intl.DateTimeFormat("de-DE", { dateStyle: "long" }).format(
              new Date(`${data.date}T12:00:00`),
            ),
          );
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
get("add-person").addEventListener("click", () => {
  addParticipant();
  get(`name-${participants.at(-1).id}`).focus();
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
get("download-links").addEventListener("click", downloadLinks);
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
  results = [];
  get("result-list").replaceChildren();
  get("manual-copy")?.remove();
  for (let index = 0; index < 3; index += 1) addParticipant();
  showStep(0);
});

window.addEventListener("hashchange", () => {
  if (location.hash.startsWith("#los=")) location.reload();
});

if (location.hash.startsWith("#los=")) openReveal();
else {
  for (let index = 0; index < 3; index += 1) addParticipant();
  get("people-panel")
    .querySelectorAll("input, textarea, select, button")
    .forEach((control) => {
      control.disabled = true;
    });
}
