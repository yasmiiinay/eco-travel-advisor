/* ==========================================================================
   Eco-Travel Advisor — front end v2 (Rasa REST)

   Talks to the Rasa REST channel and renders three kinds of bot output:
     1. text            -> chat bubbles (carbon words become colour pills)
     2. buttons         -> large quick-reply chips in the dock
     3. custom payloads -> rich cards (transport comparison, eco-hotels,
                           carbon estimate, alerts, handover, ...)
   A live Trip Summary panel mirrors the six slots by reading the payloads the
   UI sends, so the user always sees progress. Human-advisor mode is simulated
   client-side on top of the same conversation stream.

   The standalone "mock" preview from v1 has been removed; this build is always
   connected to Rasa over REST.
   ========================================================================== */

"use strict";

/* --------------------------------------------------------------------------
   0. Rasa REST connection (unchanged resolver — keep Colab/ngrok working)
   -------------------------------------------------------------------------- */
const _params = new URLSearchParams(location.search);
const RASA_REST_URL =
  _params.get("rasa") ||
  (["localhost", "127.0.0.1"].includes(location.hostname)
    ? "https://segment-premises-prior.ngrok-free.dev/webhooks/rest/webhook"
    : location.origin + "/webhooks/rest/webhook");

// A fresh conversation id every page load -> reloading always starts clean,
// instead of resuming a stale tracker on the server.
const SENDER = "web-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);

// Base URL for the Rasa HTTP API (the tracker endpoint lives alongside the REST
// webhook). Used to read authoritative slot state after each turn.
const RASA_BASE = RASA_REST_URL.replace(/\/webhooks\/rest\/webhook\/?$/, "");
const TRACKER_URL = `${RASA_BASE}/conversations/${encodeURIComponent(SENDER)}/tracker`;

/* --------------------------------------------------------------------------
   1. DOM references
   -------------------------------------------------------------------------- */
const appEl = document.getElementById("app");
const chatEl = document.getElementById("chat");
const dockEl = document.getElementById("dock");
const textInputEl = document.getElementById("text-input");
const sendBtnEl = document.querySelector(".composer__send");
const summaryListEl = document.getElementById("summary-list");
const summaryCountEl = document.getElementById("summary-count");
const summaryFillEl = document.getElementById("summary-progress-fill");
const summaryBarEl = document.getElementById("summary-bar");
const barRouteEl = document.getElementById("summary-bar-route");
const barCountEl = document.getElementById("summary-bar-count");
const statusTextEl = document.getElementById("app-status-text");
const titleEl = document.getElementById("app-title");
const modeBadgeEl = document.getElementById("mode-badge");

/* --------------------------------------------------------------------------
   2. Reference data
   -------------------------------------------------------------------------- */
const CITY_FLAGS = {
  paris: "🇫🇷", berlin: "🇩🇪", amsterdam: "🇳🇱", copenhagen: "🇩🇰",
  london: "🇬🇧", madrid: "🇪🇸", rome: "🇮🇹", barcelona: "🇪🇸",
  vienna: "🇦🇹", munich: "🇩🇪", lisbon: "🇵🇹", prague: "🇨🇿",
};
const flagFor = (city) => CITY_FLAGS[String(city || "").trim().toLowerCase()] || "";
// The full supported set, ordered for the city selector (must match the seed data).
const CITIES = ["London", "Paris", "Madrid", "Rome", "Berlin", "Barcelona",
                "Amsterdam", "Copenhagen", "Vienna", "Munich", "Lisbon", "Prague"];

const RASA_FIELDS = ["origin", "destination", "travel_date", "num_travellers", "budget", "sustainability_pref"];
const FIELD_LABEL = {
  origin: "From", destination: "To", travel_date: "Dates",
  num_travellers: "Travellers", budget: "Budget", sustainability_pref: "Priority",
};
const FIELD_EDIT_TITLE = {
  origin: "Origin", destination: "Destination", travel_date: "Travel dates",
  num_travellers: "Travellers", budget: "Budget", sustainability_pref: "Preference",
};
const BUDGET_LABEL = { budget: "Budget €", mid: "Comfort €€", comfort: "Premium €€€" };
const PREF_LABEL = {
  low_carbon: "Lowest carbon", eco_certified: "Eco-certified stays",
  local_culture: "Local community", balanced: "Balanced",
};

/* --------------------------------------------------------------------------
   3. Low-level rendering helpers
   -------------------------------------------------------------------------- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function scrollChat() { chatEl.scrollTop = chatEl.scrollHeight; }

function appendMsg(cls, html) {
  const wrap = document.createElement("div");
  wrap.className = "msg " + cls;
  wrap.innerHTML = html;
  chatEl.appendChild(wrap);
  scrollChat();
  return wrap;
}
function addBot(html) { appendMsg("msg--bot", `<div class="bubble">${html}</div>`); }
function addFull(html) { appendMsg("msg--full", html); }            // cards / banners
function addUser(text) {
  lastBotText = null;                 // a user turn resets the de-dupe guard
  const wrap = appendMsg("msg--user", `<div class="bubble"></div>`);
  wrap.querySelector(".bubble").textContent = text;
}
function addAdvisor(html) {
  appendMsg("msg--advisor",
    `<div class="bubble"><span class="who"><span class="who__avatar">M</span>Maya · advisor</span>${html}</div>`);
}
function addBanner(text) { addFull(`<div class="banner">${escapeHtml(text)}</div>`); }

// Colour pill that always carries an icon + word (never colour alone).
const LEVEL_CLASS = { green: "green", amber: "amber", red: "red" };
function pill(status) {
  if (!status) return "";
  const lvl = LEVEL_CLASS[status.level] || "green";
  return `<span class="pill pill--${lvl}"><span class="pill__icon">${escapeHtml(status.icon || "")}</span>${escapeHtml(status.label || "")}</span>`;
}

// Bot text: turn plain carbon labels into pills. De-duplicates a prompt that
// repeats with no user turn in between (the form sometimes re-asks verbatim).
let lastBotText = null;
function addBotText(text) {
  if (text && text === lastBotText) return;
  lastBotText = text;
  let html = escapeHtml(text).replace(/\n/g, "<br>");
  html = html
    .replace(/\[Low\]|\(Low impact\)/g, pill({ level: "green", icon: "✓", label: "Low" }))
    .replace(/\[Medium\]|\(Medium impact\)/g, pill({ level: "amber", icon: "!", label: "Medium" }))
    .replace(/\[High\]|\(High impact\)/g, pill({ level: "red", icon: "⚠", label: "High" }));
  addBot(html);
}

/* --------------------------------------------------------------------------
   4. Trip summary panel — driven by the authoritative Rasa tracker
   -------------------------------------------------------------------------- */
const rasaTrip = {};   // local optimistic mirror; the tracker is the source of truth

function rasaPretty(field, value) {
  if (field === "budget") {
    const tier = BUDGET_LABEL[value] || value;
    return rasaTrip.budget_amount ? `${rasaTrip.budget_amount} · ${tier}` : tier;
  }
  if (field === "sustainability_pref") return PREF_LABEL[value] || value;
  if (field === "travel_date") return value === "flexible" ? "Flexible dates" : value;
  if (field === "origin" || field === "destination") {
    const f = flagFor(value);
    return (f ? f + " " : "") + value;
  }
  return value;
}

// Optimistic, immediate update from an outgoing payload (snappy UI); the tracker
// fetch right after confirms / corrects it.
function trackOutgoing(message) {
  if (!message) return;
  if (message === "/reset_trip") { RASA_FIELDS.forEach((f) => delete rasaTrip[f]); delete rasaTrip.budget_amount; renderSummary(); return; }
  const edit = message.match(/^\/edit_answer\{[^}]*"field_to_edit"\s*:\s*"([^"]+)"/);
  if (edit) { delete rasaTrip[edit[1]]; renderSummary(); return; }
  if (message.startsWith("/inform{")) {
    try {
      const obj = JSON.parse(message.slice(message.indexOf("{")));
      Object.keys(obj).forEach((k) => { if (RASA_FIELDS.includes(k)) rasaTrip[k] = obj[k]; });
      renderSummary();
    } catch (_) { /* free-text answers are not JSON */ }
  }
}

// Authoritative slot state from Rasa (requires `rasa run --enable-api`).
async function refreshFromTracker() {
  try {
    const res = await fetch(TRACKER_URL, {
      headers: { "ngrok-skip-browser-warning": "true" },
    });
    if (!res.ok) return;                         // fall back to the local mirror
    const data = await res.json();
    const slots = data && data.slots ? data.slots : {};
    [...RASA_FIELDS, "budget_amount", "estimated_co2", "carbon_level"].forEach((k) => {
      const v = slots[k];
      if (v === null || v === undefined || v === "") delete rasaTrip[k];
      else rasaTrip[k] = v;
    });
    renderSummary();
  } catch (_) { /* offline / CORS — keep the local mirror */ }
}

function renderSummary() {
  const set = RASA_FIELDS.filter((f) => rasaTrip[f] != null && rasaTrip[f] !== "");
  if (!set.length) {
    summaryListEl.innerHTML = `<li class="summary__empty">Your choices will appear here as we go.</li>`;
  } else {
    summaryListEl.innerHTML = set.map((f) => {
      const val = escapeHtml(String(rasaPretty(f, rasaTrip[f])));
      const payload = escapeHtml(`/edit_answer{"field_to_edit": "${f}"}`);
      return `<li>
        <span class="summary__row-main">
          <span class="summary__row-label">${FIELD_LABEL[f]}</span>
          <span class="summary__row-value">${val}</span>
        </span>
        <button type="button" class="summary__edit" data-rasa-payload="${payload}"
                data-user-label="Edit ${FIELD_LABEL[f].toLowerCase()}" aria-label="Edit ${FIELD_LABEL[f]}" title="Edit">✎</button>
      </li>`;
    }).join("");
  }
  const n = set.length;
  summaryCountEl.textContent = `${n} / 6`;
  summaryFillEl.style.width = `${(n / 6) * 100}%`;
  barCountEl.textContent = `${n}/6`;
  summaryBarEl.hidden = false;
  const route = [rasaTrip.origin, rasaTrip.destination].filter(Boolean)
    .map((c) => `${flagFor(c)} ${c}`.trim()).join(" → ");
  barRouteEl.textContent = route || "New trip";
  // Back/Edit only make sense once there's something to revise.
  const back = document.getElementById("btn-back");
  const edit = document.getElementById("btn-edit");
  if (back) back.disabled = n === 0;
  if (edit) edit.disabled = n === 0;
}

/* --------------------------------------------------------------------------
   5. Custom payload renderers (the rich cards)
   -------------------------------------------------------------------------- */
function renderCustom(c) {
  if (!c || typeof c !== "object") return;
  switch (c.type) {
    case "carbon_estimate": return renderCarbon(c);
    case "transport_comparison": return renderTransport(c);
    case "card_group": return renderCardGroup(c);
    case "alert": return renderAlert(c);
    case "handover": return renderHandover(c);
    case "system_banner": return addBanner(c.text || "");
    case "trip_summary":
      RASA_FIELDS.forEach((f) => { if (c[f] != null) rasaTrip[f] = c[f]; });
      return renderSummary();
    default:
      // Unknown type -> never leave a blank bubble.
      if (c.fallback_text) addBot(escapeHtml(c.fallback_text));
  }
}

function renderCarbon(c) {
  const lvl = (c.status && c.status.level) || "green";
  const cls = lvl === "red" ? " carbon--red" : lvl === "amber" ? " carbon--amber" : "";
  const range = Array.isArray(c.range_kg) ? ` <span class="carbon__sub">(${c.range_kg[0]}–${c.range_kg[1]})</span>` : "";
  // Provenance chip: live Climatiq vs stored factors.
  const live = c.source === "climatiq";
  const srcBadge = c.source_label
    ? `<span class="src-chip ${live ? "src-chip--live" : ""}">${live ? "◆ " : ""}Source: ${escapeHtml(c.source_label)}</span>`
    : "";
  addFull(`
    <div class="card carbon${cls}">
      <div class="card__head">
        <h3 class="card__title">Estimated trip footprint</h3>
        ${pill(c.status)}
      </div>
      <div class="carbon__big">≈ ${escapeHtml(String(c.total_kg))} ${escapeHtml(c.unit || "kg CO₂e")}${range}</div>
      <p class="carbon__sub">${escapeHtml(c.greenest_icon || "")} greenest by ${escapeHtml(c.greenest_mode || "")} ·
        ~${escapeHtml(String(c.per_person_kg))} kg/person · ${escapeHtml(String(c.travellers))} traveller(s) · ${escapeHtml(c.route || "")}</p>
      ${srcBadge}
      <p class="disclaimer">${escapeHtml(c.disclaimer || "")}</p>
      <button type="button" class="method-link" data-method>How we estimate</button>
      <p class="disclaimer" data-method-note hidden>We combine distance (great-circle), mode emission factors and
        average occupancy. Figures are indicative for a prototype and use curated factors — verify against an
        official source (e.g. DEFRA/ICAO) before relying on them.</p>
    </div>`);
}

function renderTransport(c) {
  const rows = (c.options || []).map((o) => {
    const reco = o.recommended
      ? `<span class="reco-ribbon">Recommended</span>` : "";
    const note = o.note
      ? `<div class="t-note">⚠ ${escapeHtml(o.note)}</div>` : "";
    const live = o.live_flight
      ? `<span class="t-live" title="Live flight data (Aviationstack)">✈ ${escapeHtml(o.live_flight)}</span>` : "";
    return `<div class="t-row${o.recommended ? " t-row--reco" : ""}">
      <div class="t-mode"><span class="t-mode__icon">${escapeHtml(o.icon || "•")}</span> ${escapeHtml(o.mode)} ${reco}</div>
      <div class="t-meta">
        <span><b>${escapeHtml(String(o.duration_h))}</b> h</span>
        <span>~€<b>${escapeHtml(String(o.price_eur))}</b></span>
        <span><b>${escapeHtml(String(o.carbon_kg))}</b> kg CO₂e</span>
        ${live}
        ${note}
      </div>
      <div class="t-right">${pill(o.status)}</div>
    </div>`;
  }).join("");
  addFull(`
    <div class="card">
      <div class="card__head">
        <h3 class="card__title">Getting there ✈️🚆</h3>
        <span class="card__sub">Sorted by ${escapeHtml(c.sorted_by || "lowest carbon")}</span>
      </div>
      <p class="card__sub">${escapeHtml(c.route || "")}</p>
      <div class="compare">${rows}</div>
      ${c.disclaimer ? `<p class="disclaimer">${escapeHtml(c.disclaimer)}</p>` : ""}
    </div>`);
}

function renderCardGroup(c) {
  const cards = (c.cards || []).map((card) => {
    const facts = (card.facts || []).map((f) => `<li>${escapeHtml(String(f))}</li>`).join("");
    const badges = (card.badges || []).map((b) =>
      `<span class="badge">${escapeHtml(b.icon || "")} ${escapeHtml(b.label || "")}</span>`).join("");
    return `<div class="subcard">
      <div class="subcard__title"><span>${escapeHtml(card.title)}</span> ${card.status ? pill(card.status) : ""}</div>
      ${facts ? `<ul class="facts">${facts}</ul>` : ""}
      ${badges ? `<div class="badges">${badges}</div>` : ""}
    </div>`;
  }).join("");
  addFull(`
    <div class="card">
      <p class="card__group-title">${escapeHtml(c.title || "")}</p>
      <div class="subcards">${cards}</div>
      ${c.disclaimer ? `<p class="disclaimer">${escapeHtml(c.disclaimer)}</p>` : ""}
    </div>`);
}

function renderAlert(c) {
  const amber = c.level === "amber";
  const action = c.action
    ? `<div class="alert__action"><button type="button" class="chip chip--primary"
         data-rasa-payload="${escapeHtml(c.action.payload)}">${escapeHtml(c.action.label)}</button></div>`
    : "";
  addFull(`
    <div class="alert${amber ? " alert--amber" : ""}" role="alert">
      <div class="alert__icon" aria-hidden="true">${escapeHtml(c.icon || "⚠")}</div>
      <div>
        <p class="alert__title">${escapeHtml(c.title || "Heads up")}</p>
        <p class="alert__body">${escapeHtml(c.body || "")}</p>
        ${action}
      </div>
    </div>`);
}

/* --------------------------------------------------------------------------
   6. Human-advisor mode (simulated, same conversation stream)
   -------------------------------------------------------------------------- */
let advisorMode = false;
let lastHandover = null;

function renderHandover(c) {
  lastHandover = c;
  const s = c.summary || {};
  const checks = (c.transferred || []).map((t) => `<li>${escapeHtml(t)}</li>`).join("");
  addFull(`
    <div class="handover">
      <div class="handover__head">
        <div class="handover__avatar" aria-hidden="true">M</div>
        <div>
          <div class="handover__name">${escapeHtml((c.advisor && c.advisor.name) || "Maya")}</div>
          <div class="handover__role">${escapeHtml((c.advisor && c.advisor.role) || "Human travel advisor")}</div>
        </div>
      </div>
      <ul class="handover__check">${checks}</ul>
      <div class="handover__trip">
        ${escapeHtml(s.route || "")} · ${escapeHtml(String(s.travel_date || "-"))} ·
        ${escapeHtml(String(s.travellers || "-"))} traveller(s) · ${escapeHtml(String(s.preference || "-"))}
      </div>
    </div>`);
  enterAdvisor(s);
}

function enterAdvisor(summary) {
  advisorMode = true;
  appEl.dataset.mode = "advisor";
  titleEl.textContent = "Human Travel Advisor";
  statusTextEl.textContent = "Maya · online";
  modeBadgeEl.textContent = "Advisor";
  document.getElementById("btn-handover").hidden = true;
  document.getElementById("btn-return").hidden = false;
  addBanner("You're now chatting with Maya, a human travel advisor.");

  const route = summary.route || "your trip";
  const date = summary.travel_date && summary.travel_date !== "-" ? ` on ${summary.travel_date}` : "";
  const pref = summary.preference && summary.preference !== "-" ? ` and your “${summary.preference}” preference` : "";
  setDockHint("You're talking to a person now — type your message below.");
  setTimeout(() => addAdvisor(`Hi, I'm Maya 👋 I can see your <b>${escapeHtml(route)}</b> plan${escapeHtml(pref)}.`), 500);
  setTimeout(() => addAdvisor(`Want me to check greener rail availability${escapeHtml(date)} and tailor the eco-hotels for you?`), 1500);
}

const ADVISOR_LINES = [
  "Good question — let me look into that against your trip details.",
  "I can definitely arrange that. I still have your full plan and the recommendations in front of me.",
  "Based on your sustainability preference, I'd lean towards the rail option — want me to hold it?",
  "Noted. I'll factor that into your itinerary and follow up by email with the eco-certified stays.",
];
let advisorTurn = 0;
function advisorReply() {
  const line = ADVISOR_LINES[advisorTurn % ADVISOR_LINES.length];
  advisorTurn++;
  setTimeout(() => addAdvisor(escapeHtml(line)), 500);
}

function returnToAssistant() {
  advisorMode = false;
  appEl.dataset.mode = "bot";
  titleEl.textContent = "Eco-Travel Advisor";
  statusTextEl.textContent = "Assistant · online";
  modeBadgeEl.textContent = "Chatbot";
  document.getElementById("btn-handover").hidden = false;
  document.getElementById("btn-return").hidden = true;
  addBanner("You're back with the Eco-Travel Advisor. Your trip and the advisor's notes are saved.");
  setDockHint("Tap an option or type to continue planning.");
}

/* --------------------------------------------------------------------------
   7. Rasa response rendering + sending
   -------------------------------------------------------------------------- */
function setDock(html) { dockEl.innerHTML = html; }
function setDockHint(text) { setDock(`<p class="dock__hint">${escapeHtml(text)}</p>`); }

function cityChip(name, field, hidden) {
  const payload = escapeHtml(`/inform{"${field}": "${name}"}`);
  return `<button type="button" class="chip chip--city${hidden ? " is-hidden" : ""}" data-rasa-payload="${payload}">` +
         `<span class="chip__flag" aria-hidden="true">${flagFor(name)}</span>${escapeHtml(name)}</button>`;
}

// Full 12-city selector with a "More cities" expander; excludes the chosen origin.
function buildCitySelector(field) {
  const list = CITIES.filter((c) =>
    !(field === "destination" && rasaTrip.origin && c.toLowerCase() === String(rasaTrip.origin).toLowerCase()));
  const FIRST = 6;
  const chips = list.map((c, i) => cityChip(c, field, i >= FIRST)).join("");
  const more = list.length > FIRST
    ? `<button type="button" class="chip chip--more" data-more-cities>More cities ▾</button>` : "";
  return `<p class="dock__hint">Tap a city${field === "destination" ? " to travel to" : ""}, or type one.</p>` +
         `<div class="choices" data-city-grid>${chips}${more}</div>`;
}

// Date range picker (start / end / flexible). Sends travel_date as text.
function buildDatePicker() {
  const today = new Date().toISOString().slice(0, 10);
  return `
    <p class="dock__hint">Pick your dates, or choose flexible.</p>
    <div class="datepick">
      <label class="datepick__field">Start
        <input type="date" id="date-start" min="${today}" class="datepick__input" />
      </label>
      <label class="datepick__field">End
        <input type="date" id="date-end" min="${today}" class="datepick__input" />
      </label>
      <div class="datepick__actions">
        <button type="button" class="chip chip--primary" data-date-confirm>Use these dates</button>
        <button type="button" class="chip" data-rasa-payload='/inform{"travel_date": "flexible"}'
                data-user-label="I'm flexible">I'm flexible</button>
      </div>
      <p class="datepick__out" id="date-out" aria-live="polite"></p>
    </div>`;
}

function fmtDate(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function renderRasaResponses(responses) {
  let buttons = [];
  (responses || []).forEach((msg) => {
    if (msg.text) addBotText(msg.text);
    if (msg.image) addFull(`<img src="${escapeHtml(msg.image)}" alt="" style="max-width:100%;border-radius:14px" />`);
    if (msg.custom) renderCustom(msg.custom);
    if (Array.isArray(msg.buttons)) buttons.push(...msg.buttons);
  });

  // De-dupe identical buttons that arrive in the same batch.
  const seen = new Set();
  buttons = buttons.filter((b) => {
    const key = (b.payload || "") + "|" + (b.title || "");
    if (seen.has(key)) return false; seen.add(key); return true;
  });

  // Detect the current step from the button payloads.
  const isCity = buttons.length && buttons.every((b) => /"(origin|destination)"\s*:/.test(b.payload || ""));
  const isDate = buttons.some((b) => /"travel_date"\s*:\s*"flexible"/.test(b.payload || ""));

  if (isCity) {
    const field = /"origin"/.test(buttons[0].payload) ? "origin" : "destination";
    setDock(buildCitySelector(field));
    return;
  }
  if (isDate) { setDock(buildDatePicker()); return; }

  if (buttons.length) {
    const chips = buttons.map((b) =>
      `<button type="button" class="chip" data-rasa-payload="${escapeHtml(b.payload)}">${escapeHtml(b.title)}</button>`).join("");
    setDock(`<p class="dock__hint">Tap an option, or type your answer below.</p><div class="choices">${chips}</div>`);
  } else {
    setDockHint("Type your reply below, or use the controls above.");
  }
}

// ---- "thinking" indicator + input lock while waiting on Rasa ----
let thinkingEl = null, thinkingTimer = null, lastSent = null;
function showThinking() {
  hideThinking();
  thinkingEl = appendMsg("msg--bot",
    `<div class="bubble typing" aria-label="Eco-Travel Advisor is thinking"><span></span><span></span><span></span></div>`);
  textInputEl.disabled = true;
  sendBtnEl.disabled = true;
  dockEl.classList.add("is-busy");
  thinkingTimer = setTimeout(() => {
    if (thinkingEl) {
      thinkingEl.classList.remove("msg--bot");
      thinkingEl.querySelector(".bubble").outerHTML =
        `<div class="bubble">Still checking your trip options…</div>`;
    }
  }, 8000);
}
function hideThinking() {
  if (thinkingTimer) { clearTimeout(thinkingTimer); thinkingTimer = null; }
  if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
  textInputEl.disabled = false;
  sendBtnEl.disabled = false;
  dockEl.classList.remove("is-busy");
}

async function sendToRasa(message, userLabel) {
  lastSent = { message };
  trackOutgoing(message);
  if (userLabel !== false) addUser(userLabel || message);
  showThinking();
  try {
    const res = await fetch(RASA_REST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "true" },
      body: JSON.stringify({ sender: SENDER, message }),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    hideThinking();
    renderRasaResponses(data);
    refreshFromTracker();             // authoritative slot state for the summary
  } catch (err) {
    hideThinking();
    addBot("I couldn't reach the assistant just now. Please check the connection and try again.");
    setDock(`<div class="choices"><button type="button" class="chip chip--primary" data-retry>↻ Retry</button></div>`);
  }
}

/* --------------------------------------------------------------------------
   8. Events
   -------------------------------------------------------------------------- */
// Any element carrying a Rasa payload (dock chips, inline card actions, summary
// pencils) sends that payload. Suppressed while in advisor mode.
document.addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-rasa-payload]");
  if (!el) return;
  if (advisorMode) return;            // advisor mode pauses the planner
  sendToRasa(el.dataset.rasaPayload, el.dataset.userLabel || el.textContent.trim());
});

// Dock widgets: retry, "More cities" expander, date-range confirm.
dockEl.addEventListener("click", (ev) => {
  const retry = ev.target.closest("[data-retry]");
  if (retry && lastSent) { sendToRasa(lastSent.message, false); return; }
  const more = ev.target.closest("[data-more-cities]");
  if (more) {
    dockEl.querySelectorAll(".chip--city.is-hidden").forEach((c) => c.classList.remove("is-hidden"));
    more.remove();
    return;
  }
  const conf = ev.target.closest("[data-date-confirm]");
  if (conf) {
    const s = (document.getElementById("date-start") || {}).value;
    const e = (document.getElementById("date-end") || {}).value;
    const out = document.getElementById("date-out");
    if (!s) { if (out) out.textContent = "Please choose a start date, or tap “I'm flexible”."; return; }
    let label;
    if (e && e >= s) {
      const nights = Math.round((new Date(e) - new Date(s)) / 86400000);
      label = `${fmtDate(s)} – ${fmtDate(e)} · ${nights} night${nights === 1 ? "" : "s"}`;
    } else {
      label = fmtDate(s);
    }
    sendToRasa(`/inform{"travel_date": "${label}"}`, label);
  }
});

// Live preview of the chosen date range.
dockEl.addEventListener("change", () => {
  const sEl = document.getElementById("date-start");
  const eEl = document.getElementById("date-end");
  const out = document.getElementById("date-out");
  if (!sEl || !out) return;
  if (eEl && sEl.value) eEl.min = sEl.value;
  if (sEl.value && eEl && eEl.value && eEl.value >= sEl.value) {
    const nights = Math.round((new Date(eEl.value) - new Date(sEl.value)) / 86400000);
    out.textContent = `${fmtDate(sEl.value)} – ${fmtDate(eEl.value)} · ${nights} night${nights === 1 ? "" : "s"}`;
  } else if (sEl.value) {
    out.textContent = fmtDate(sEl.value);
  }
});

// "How we estimate" toggle inside carbon cards.
chatEl.addEventListener("click", (ev) => {
  const link = ev.target.closest("[data-method]");
  if (!link) return;
  const note = link.parentElement.querySelector("[data-method-note]");
  if (note) note.hidden = !note.hidden;
});

// Composer: in advisor mode talk to Maya; otherwise send to Rasa.
document.getElementById("composer").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const input = document.getElementById("text-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  if (advisorMode) { addUser(text); advisorReply(); return; }
  addUser(text);
  sendToRasa(text, false);
});

// Header controls
document.getElementById("btn-back").addEventListener("click", () => sendToRasa("/go_back", "Go back"));
document.getElementById("btn-edit").addEventListener("click", openEditMenu);
document.getElementById("btn-handover").addEventListener("click", () => sendToRasa("/request_human", "Talk to a human"));
document.getElementById("btn-return").addEventListener("click", returnToAssistant);
document.getElementById("btn-reset").addEventListener("click", openConfirm);

// Edit chooser (field-specific payloads — never bare /edit_answer)
function openEditMenu() {
  if (advisorMode) return;
  const chips = RASA_FIELDS.map((f) =>
    `<button type="button" class="chip" data-rasa-payload="${escapeHtml(`/edit_answer{"field_to_edit": "${f}"}`)}" ` +
    `data-user-label="Edit ${FIELD_LABEL[f].toLowerCase()}">${FIELD_EDIT_TITLE[f]}</button>`).join("");
  setDock(`<p class="dock__hint">Which answer would you like to change?</p><div class="choices">${chips}</div>`);
}

// Guarded reset
const confirmEl = document.getElementById("confirm");
function openConfirm() { confirmEl.hidden = false; }
function closeConfirm() { confirmEl.hidden = true; }
document.getElementById("confirm-no").addEventListener("click", closeConfirm);
document.getElementById("confirm-yes").addEventListener("click", () => {
  closeConfirm();
  chatEl.innerHTML = "";
  if (advisorMode) returnToAssistant();
  sendToRasa("/reset_trip", "Reset trip");
});

// Mobile summary drawer
const scrimEl = document.getElementById("scrim");
function setDrawer(open) {
  appEl.dataset.summaryOpen = String(open);
  summaryBarEl.setAttribute("aria-expanded", String(open));
  scrimEl.hidden = !open;
}
summaryBarEl.addEventListener("click", () => setDrawer(appEl.dataset.summaryOpen !== "true"));
scrimEl.addEventListener("click", () => setDrawer(false));

/* --------------------------------------------------------------------------
   9. Boot
   -------------------------------------------------------------------------- */
function boot() {
  RASA_FIELDS.forEach((f) => delete rasaTrip[f]);
  renderSummary();
  sendToRasa("/greet", false);   // silent trigger, no user bubble
}
boot();
