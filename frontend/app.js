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
const historyListEl = document.getElementById("history-list");
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
// One consistent label set, matching the backend tier names (Budget / Mid / Comfort)
// and the budget buttons, so the chat text and the summary never disagree.
const BUDGET_LABEL = { budget: "Budget €", mid: "Mid €€", comfort: "Comfort €€€" };
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
    // "Quick 3 questions" handover: once the critical slots are in, connect.
    if (handoverAfterCritical && !advisorMode && criticalSlotsFilled()) {
      handoverAfterCritical = false;
      connectToAdvisor();
    }
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
   4b. Trip history (left rail) — snapshots each completed plan; click to re-plan
   -------------------------------------------------------------------------- */
let tripHistory = [];
try { tripHistory = JSON.parse(localStorage.getItem("ecoTripHistory") || "[]"); } catch (_) { tripHistory = []; }

function saveHistory() {
  try { localStorage.setItem("ecoTripHistory", JSON.stringify(tripHistory.slice(0, 20))); } catch (_) { /* file:// may block */ }
}

function addTripToHistory(co2) {
  if (!rasaTrip.origin || !rasaTrip.destination) return;
  const t = {
    origin: rasaTrip.origin, destination: rasaTrip.destination,
    travel_date: rasaTrip.travel_date, num_travellers: rasaTrip.num_travellers,
    budget: rasaTrip.budget, sustainability_pref: rasaTrip.sustainability_pref,
    co2: (co2 != null ? co2 : null), ts: Date.now(),
  };
  // One entry per route: drop any existing same-route trip and add the latest on top.
  tripHistory = tripHistory.filter((x) => !(x.origin === t.origin && x.destination === t.destination));
  tripHistory.unshift(t);
  tripHistory = tripHistory.slice(0, 20);
  saveHistory();
  renderHistory();
}

function renderHistory() {
  if (!historyListEl) return;
  if (!tripHistory.length) {
    historyListEl.innerHTML = `<li class="history__empty">Plans you complete will appear here.</li>`;
    return;
  }
  historyListEl.innerHTML = tripHistory.map((t, i) => {
    const route = `${flagFor(t.origin)} ${escapeHtml(t.origin)} → ${flagFor(t.destination)} ${escapeHtml(t.destination)}`;
    const dates = t.travel_date ? escapeHtml(String(rasaPretty("travel_date", t.travel_date))) : "Dates not set";
    const co2 = t.co2 != null ? `≈ ${escapeHtml(String(t.co2))} kg CO₂e` : "";
    return `<li><button type="button" class="history__item" data-trip="${i}" title="Re-plan this trip">
      <span class="history__route">${route}</span>
      <span class="history__meta">${dates} · ${escapeHtml(String(t.num_travellers || "?"))} traveller(s)</span>
      <span class="history__co2">${co2}</span>
    </button></li>`;
  }).join("");
}

// Re-plan a saved trip: reset, start the form, then replay each slot in order so
// every value lands on the step that is being requested. Intermediate prompts are
// suppressed (replaying flag) so only the final plan cards appear.
let replaying = false;
async function replayTrip(t) {
  if (replaying) return;
  replaying = true;
  chatEl.innerHTML = "";
  RASA_FIELDS.forEach((f) => delete rasaTrip[f]);
  renderSummary();
  addUser(`Re-plan ${t.origin} → ${t.destination}`);
  try {
    await sendToRasa("/reset_trip", false);
    await sendToRasa("/plan_trip", false);          // activate the form (asks origin)
    const order = [["origin", t.origin], ["destination", t.destination], ["travel_date", t.travel_date],
                   ["num_travellers", t.num_travellers], ["budget", t.budget], ["sustainability_pref", t.sustainability_pref]];
    for (const [slot, val] of order) {
      if (val == null || val === "") continue;
      await sendToRasa(`/inform{"${slot}": "${String(val).replace(/"/g, '\\"')}"}`, false);
    }
  } finally {
    replaying = false;
  }
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
  // Provenance: a small icon (live Climatiq vs stored factors) with a hover tooltip.
  const live = c.source === "climatiq";
  const srcIcon = c.source_label
    ? `<span class="src-icon${live ? " src-icon--live" : ""}" tabindex="0" role="img"
              data-tip="Source: ${escapeHtml(c.source_label)}" title="Source: ${escapeHtml(c.source_label)}"
              aria-label="Source: ${escapeHtml(c.source_label)}">${live ? "🛰️" : "🗄️"}</span>`
    : "";
  addFull(`
    <div class="card carbon${cls}">
      <div class="card__head">
        <h3 class="card__title">Estimated trip footprint</h3>
        <span class="card__head-right">${pill(c.status)}${srcIcon}</span>
      </div>
      <div class="carbon__big">≈ ${escapeHtml(String(c.total_kg))} ${escapeHtml(c.unit || "kg CO₂e")}${range}</div>
      <p class="carbon__sub">${escapeHtml(c.greenest_icon || "")} greenest by ${escapeHtml(c.greenest_mode || "")} ·
        ~${escapeHtml(String(c.per_person_kg))} kg/person · ${escapeHtml(String(c.travellers))} traveller(s) · ${escapeHtml(c.route || "")}${
        c.distance_km ? ` · ${escapeHtml(String(c.distance_km))} km (${escapeHtml(c.distance_note || "")})` : ""}</p>
      <p class="disclaimer">${escapeHtml(c.disclaimer || "")}</p>
      <button type="button" class="method-link" data-method>How we estimate</button>
      <p class="disclaimer" data-method-note hidden>We combine distance (great-circle), mode emission factors and
        average occupancy. Figures are indicative for a prototype and use curated factors; verify against an
        official source (e.g. DEFRA/ICAO) before relying on them.</p>
    </div>`);
  // A completed estimate marks a completed plan -> snapshot it into trip history.
  addTripToHistory(c.total_kg);
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
let dockBeforeHandover = null;
let handoverAfterCritical = false;   // set when "Quick 3 questions" is collecting first

// The three slots an advisor most needs: where from, where to, and when.
function criticalSlotsFilled() {
  return Boolean(rasaTrip.origin && rasaTrip.destination && rasaTrip.travel_date);
}

// Step 1: ask before connecting (a trust checkpoint, not an instant jump). When the
// critical context is already known we go straight to the confirm; when it is
// missing we offer to gather a few basics first so the advisor starts informed.
function startHandover() {
  if (advisorMode) return;
  dockBeforeHandover = dockEl.innerHTML;        // so "Stay" can restore the step
  if (criticalSlotsFilled()) {
    addBot("Connect you to a human travel advisor? They'll have your full trip context.");
    setDock(`<div class="choices">
      <button type="button" class="chip chip--primary" data-handover-confirm>Yes, connect me</button>
      <button type="button" class="chip" data-handover-cancel>Stay with the assistant</button>
    </div>`);
    return;
  }
  addBot("Happy to connect you. Maya can help faster if she has a few basics first, or you can skip straight through.");
  setDock(`<div class="choices">
    <button type="button" class="chip chip--primary" data-handover-quick>Quick 3 questions</button>
    <button type="button" class="chip" data-handover-skip>Skip &amp; connect now</button>
  </div>`);
}

// Step 2: a short, honest "connecting" moment, then ask Rasa to package context.
function connectToAdvisor() {
  addBanner("Connecting you to a human advisor… usually under a minute.");
  setDockHint("Connecting…");
  setTimeout(() => sendToRasa("/request_human", "Talk to a human"), 1200);
}

// Step 3: the context-transfer card (the trust moment) — read-only trip snapshot.
function renderHandover(c) {
  lastHandover = c;
  const s = c.summary || {};
  // Keep only rows that actually have a value, so a partial or empty handover never
  // shows a column of "-" placeholders (which read like an error).
  const clean = (v) => (v != null && String(v).trim() !== "" && String(v) !== "-"
                        && String(v) !== "- → -");
  const rowDefs = [
    ["Route", s.route],
    ["Dates", s.travel_date],
    ["Travellers", s.travellers],
    ["Budget", s.budget],
    ["Preference", s.preference],
    (s.estimated_co2_kg != null && s.estimated_co2_kg !== "")
      ? ["Est. carbon", `${s.estimated_co2_kg} kg CO₂e`] : null,
  ].filter(Boolean).filter(([, v]) => clean(v));
  const hasContext = rowDefs.length > 0;
  const rows = rowDefs.map(([k, v]) =>
    `<div class="handover__row"><span class="handover__k">${escapeHtml(k)}</span>` +
    `<span class="handover__v">${escapeHtml(String(v))}</span></div>`).join("");
  const checks = hasContext
    ? (c.transferred || []).map((t) => `<li>${escapeHtml(t)}</li>`).join("") : "";
  const note = hasContext
    ? "Your conversation so far has been shared with the advisor."
    : "No trip details captured yet — Maya will start fresh with you.";
  const tripBlock = hasContext
    ? `<ul class="handover__check">${checks}</ul><div class="handover__trip">${rows}</div>` : "";
  addFull(`
    <div class="handover">
      <div class="handover__head">
        <div class="handover__avatar" aria-hidden="true">M</div>
        <div>
          <div class="handover__name">${escapeHtml((c.advisor && c.advisor.name) || "Maya")}</div>
          <div class="handover__role">${escapeHtml((c.advisor && c.advisor.role) || "Human travel advisor")}</div>
        </div>
      </div>
      <p class="handover__note">${escapeHtml(note)}</p>
      ${tripBlock}
    </div>`);
  enterAdvisor(s);
}

// A "Maya is typing…" bubble so advisor replies feel human, not instant.
function addAdvisorTyping() {
  return appendMsg("msg--advisor",
    `<div class="bubble"><span class="who"><span class="who__avatar">M</span>Maya · advisor</span>` +
    `<span class="typing"><span></span><span></span><span></span></span></div>`);
}
function advisorSay(html, delay = 900) {
  const t = addAdvisorTyping();
  setTimeout(() => { if (t) t.remove(); addAdvisor(html); }, delay);
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

  const route = summary.route && summary.route !== "- → -" ? summary.route : "your trip";
  const date = summary.travel_date && summary.travel_date !== "-" ? ` on ${summary.travel_date}` : "";
  const pref = summary.preference && summary.preference !== "-" ? ` and your “${summary.preference}” preference` : "";

  // Free text is primary in advisor mode. The trip is already on the context card
  // above, and the header keeps a persistent "Return to assistant" button, so the
  // dock just needs a hint (no duplicate back button).
  setDock(`<p class="dock__hint">You're talking to a person now. Type below, or use “Return to assistant” at the top to go back.</p>`);

  advisorSay(`Hi, I'm Maya 👋 I can see your <b>${escapeHtml(route)}</b> plan${escapeHtml(pref)}.`, 700);
  advisorSay(`Want me to check greener rail availability${escapeHtml(date)} and tailor the eco-hotels for you?`, 1900);
}

const ADVISOR_LINES = [
  "Good question, let me look into that against your trip details.",
  "I can definitely arrange that. I still have your full plan and the recommendations in front of me.",
  "Based on your sustainability preference, I'd lean towards the rail option. Want me to hold it?",
  "Noted. I'll factor that into your itinerary and follow up by email with the eco-certified stays.",
];
let advisorTurn = 0;
function advisorReply() {
  const line = ADVISOR_LINES[advisorTurn % ADVISOR_LINES.length];
  advisorTurn++;
  advisorSay(escapeHtml(line), 900);
}

function returnToAssistant() {
  if (!advisorMode) return;                       // guard against double-trigger
  advisorMode = false;
  appEl.dataset.mode = "bot";
  titleEl.textContent = "Eco-Travel Advisor";
  statusTextEl.textContent = "Assistant · online";
  modeBadgeEl.textContent = "Chatbot";
  document.getElementById("btn-handover").hidden = false;
  document.getElementById("btn-return").hidden = true;
  addBanner("You're back with the Eco-Travel Advisor. Your trip and the advisor's notes are saved.");
  // Resume the planning flow so the user always has a clear next step instead of an
  // empty dock: Rasa re-asks the next unfilled slot (or re-shows the results if the
  // plan was already complete), and the matching tappable widget is rendered.
  sendToRasa("/plan_trip", false);
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
  // On the origin step, offer GPS detection (browser geolocation -> nearest city).
  const geoChip = (field === "origin" && "geolocation" in navigator)
    ? `<button type="button" class="chip chip--more" data-geo-locate>📍 Use my location</button>` : "";
  return `<p class="dock__hint">Tap a city${field === "destination" ? " to travel to" : ""}, or type one.</p>` +
         `<div class="choices" data-city-grid>${chips}${more}${geoChip}</div>`;
}

// Date range picker (start / end / flexible). Sends travel_date as text.
function buildDatePicker() {
  const today = new Date().toISOString().slice(0, 10);
  // Cap selection ~18 months out so the native picker can't yield a 6-digit year
  // (which produced impossible night counts).
  const maxD = new Date(); maxD.setMonth(maxD.getMonth() + 18);
  const maxDate = maxD.toISOString().slice(0, 10);
  return `
    <p class="dock__hint">Pick your dates, or choose flexible.</p>
    <div class="datepick">
      <label class="datepick__field">Start
        <input type="date" id="date-start" min="${today}" max="${maxDate}" class="datepick__input" />
      </label>
      <label class="datepick__field">End
        <input type="date" id="date-end" min="${today}" max="${maxDate}" class="datepick__input" />
      </label>
      <div class="datepick__actions">
        <button type="button" class="chip chip--primary" data-date-confirm>Use these dates</button>
        <button type="button" class="chip" data-flex-length>I'm flexible</button>
      </div>
      <p class="datepick__out" id="date-out" aria-live="polite"></p>
    </div>`;
}

// Flexible flow: pick a year, then a month, then a length; we then propose a
// concrete random date range inside that month so the trip has real dates to plan
// around. Year and month are chosen separately (cleaner than one long
// "Month Year" list).
let flexMonth = null;   // { y, m } chosen month

// Step 1 of the flexible flow: which year (capped ~18 months out).
function buildFlexYears() {
  const now = new Date();
  const cap = new Date(); cap.setMonth(cap.getMonth() + 18);
  let chips = "";
  for (let y = now.getFullYear(); y <= cap.getFullYear(); y++) {
    chips += `<button type="button" class="chip" data-flex-year="${y}">${y}</button>`;
  }
  return `<p class="dock__hint">Which year would you like to travel?</p><div class="choices">${chips}</div>`;
}

// Step 2: which month within the chosen year. Past months and any month beyond
// the ~18-month cap are shown disabled so the user can only pick a valid range.
function buildFlexMonthsForYear(y) {
  const now = new Date();
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const cap = new Date(); cap.setMonth(cap.getMonth() + 18);
  let chips = "";
  for (let m = 0; m < 12; m++) {
    const first = new Date(y, m, 1);
    const monthEnd = new Date(y, m + 1, 0);
    const disabled = monthEnd < todayMidnight || first > cap;
    const label = first.toLocaleDateString("en-GB", { month: "long" });
    chips += `<button type="button" class="chip" data-flex-month="${y}-${m}"${disabled ? " disabled" : ""}>${escapeHtml(label)}</button>`;
  }
  return `<p class="dock__hint">Which month in ${y}?</p><div class="choices">${chips}</div>`;
}

function buildFlexNights() {
  const opts = [
    { label: "Weekend (3 nights)", n: 3 },
    { label: "Short break (5 nights)", n: 5 },
    { label: "A week (7 nights)", n: 7 },
    { label: "Long (10 nights)", n: 10 },
  ];
  const chips = opts.map((o) =>
    `<button type="button" class="chip" data-flex-nights="${o.n}">${escapeHtml(o.label)}</button>`).join("");
  return `<p class="dock__hint">Roughly how long?</p><div class="choices">${chips}</div>`;
}

function fmtDate(iso) {
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d)) return String(iso || "");      // never render the literal "Invalid Date"
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
function fmtDateObj(d) {
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

// Whole nights between two ISO dates, or null if the pair is invalid, reversed,
// or absurdly far apart. Callers must treat null as "show a validation message".
function safeNights(sIso, eIso) {
  const s = new Date(sIso + "T00:00:00"), e = new Date(eIso + "T00:00:00");
  if (isNaN(s) || isNaN(e)) return null;
  const n = Math.round((e - s) / 86400000);
  if (n < 1 || n > 366) return null;
  return n;
}

// A concrete random date range of `nights` inside the chosen month (no past days).
function randomFlexRange(y, m, nights) {
  const today = new Date();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  let minStart = 1;
  if (y === today.getFullYear() && m === today.getMonth()) minStart = today.getDate() + 1;
  const maxStart = Math.max(minStart, daysInMonth - 1);
  const startDay = minStart + Math.floor(Math.random() * (maxStart - minStart + 1));
  const start = new Date(y, m, startDay);
  const end = new Date(start.getTime() + nights * 86400000);
  return `${fmtDateObj(start)} – ${fmtDateObj(end)} · ${nights} night${nights === 1 ? "" : "s"}`;
}

function renderRasaResponses(responses) {
  // While re-planning from history, show only the final cards (skip the
  // intermediate slot questions and quick-reply rows).
  if (replaying) {
    (responses || []).forEach((msg) => { if (msg.custom) renderCustom(msg.custom); });
    return;
  }
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

  // In advisor mode the dock is owned by enterAdvisor / the advisor actions — the
  // planner's step detection must not overwrite it (this was hiding the advisor
  // "Share trip summary / End chat" chips behind "use the controls above").
  if (advisorMode) return;

  // Detect the current step from the button payloads, then render a purpose-built,
  // tappable control for that step (the happy path needs zero typing).
  const every = (re) => buttons.length && buttons.every((b) => re.test(b.payload || ""));
  const isCity = every(/"(origin|destination)"\s*:/);
  const isDate = buttons.some((b) => /"travel_date"\s*:\s*"flexible"/.test(b.payload || ""));
  const isTravellers = every(/"num_travellers"\s*:/);
  const isBudget = every(/"budget"\s*:/);
  const isPref = every(/"sustainability_pref"\s*:/);
  const isWelcome = buttons.length === 1 && /^\/plan_trip\b/.test(buttons[0].payload || "");

  if (isWelcome) { setDock(buildWelcomeDock()); return; }
  if (isCity) {
    const field = /"origin"/.test(buttons[0].payload) ? "origin" : "destination";
    setDock(buildCitySelector(field));
    return;
  }
  if (isDate) { setDock(buildDatePicker()); return; }
  if (isTravellers) { setDock(buildTravellerStepper()); return; }
  if (isBudget) { setDock(buildBudgetCards()); return; }
  if (isPref) { setDock(buildPrefChips(buttons)); return; }

  if (buttons.length) {
    const chips = buttons.map((b) =>
      `<button type="button" class="chip" data-rasa-payload="${escapeHtml(b.payload)}">${escapeHtml(b.title)}</button>`
    ).join("");
    setDock(`<p class="dock__hint">Tap an option, or type your answer below.</p><div class="choices">${chips}</div>`);
  } else {
    setDockHint("Type your reply below, or use the controls above.");
  }
}

// --- Step widgets (all send the same Rasa payloads as the original buttons) ---

// Welcome: a single, confident primary call-to-action.
function buildWelcomeDock() {
  return `<p class="dock__hint">Plan a lower-carbon trip between European cities.</p>
    <div class="choices">
      <button type="button" class="chip chip--primary chip--cta" data-rasa-payload="/plan_trip" data-user-label="Plan a trip">🌿 Plan a trip</button>
      <button type="button" class="chip" data-handover-start>🧑‍💼 Talk to a human</button>
    </div>
    <p class="dock__foot">Carbon figures are estimates.</p>`;
}

// Traveller stepper: − value + with quick presets and a Continue button.
let travCount = 2;
function buildTravellerStepper() {
  travCount = 2;
  return `<p class="dock__hint">How many are travelling?</p>
    <div class="stepper" role="group" aria-label="Number of travellers">
      <button type="button" class="stepper__btn" data-trav-step="-1" aria-label="One fewer traveller">−</button>
      <span class="stepper__val" id="trav-val" aria-live="polite">2</span>
      <button type="button" class="stepper__btn" data-trav-step="1" aria-label="One more traveller">+</button>
    </div>
    <div class="choices choices--even">
      <button type="button" class="chip" data-trav-set="1">Solo</button>
      <button type="button" class="chip" data-trav-set="2">Couple</button>
      <button type="button" class="chip" data-trav-set="4">Family of 4</button>
    </div>
    <button type="button" class="chip chip--primary chip--block" data-trav-continue>Continue</button>`;
}
function setTrav(n) {
  travCount = Math.min(9, Math.max(1, n));
  const el = document.getElementById("trav-val");
  if (el) el.textContent = String(travCount);
}

// Budget: three tier cards (Budget/Mid/Comfort) + an exact-amount option.
function buildBudgetCards() {
  const tiers = [
    { key: "budget", name: "Budget", sym: "€", desc: "Lowest cost; hostels and rail where it helps." },
    { key: "mid", name: "Mid", sym: "€€", desc: "Balanced mid-range stays and faster options." },
    { key: "comfort", name: "Comfort", sym: "€€€", desc: "Top eco-certified stays, flexible transport." },
  ];
  const cards = tiers.map((t) =>
    `<button type="button" class="tier" data-rasa-payload="${escapeHtml(`/inform{"budget": "${t.key}"}`)}" data-user-label="${t.name} ${t.sym}">
       <span class="tier__head"><span class="tier__name">${t.name}</span><span class="tier__sym">${t.sym}</span></span>
       <span class="tier__desc">${t.desc}</span>
     </button>`).join("");
  return `<p class="dock__hint">Pick a budget per person, or set an exact amount.</p>
    <div class="tiers">${cards}</div>
    <button type="button" class="chip chip--more" data-budget-exact>Set exact amount</button>`;
}
function buildBudgetExact() {
  return `<p class="dock__hint">Roughly how much per person, per day?</p>
    <div class="exact">
      <span class="exact__cur" aria-hidden="true">€</span>
      <input type="number" id="budget-amount" class="exact__input" min="1" inputmode="numeric"
             placeholder="e.g. 120" aria-label="Budget per person per day in euros" />
      <button type="button" class="chip chip--primary" data-budget-confirm>Use this</button>
    </div>
    <button type="button" class="chip chip--more" data-budget-tiers>← Back to tiers</button>`;
}

// Sustainability preference: descriptive chips (one tap each), keeping Rasa payloads.
function buildPrefChips(buttons) {
  const SUB = {
    low_carbon: "Greenest options first",
    eco_certified: "Certified-green stays",
    local_culture: "Support local & culture",
    balanced: "A sensible mix of cost & carbon",
  };
  const chips = buttons.map((b) => {
    const m = /"sustainability_pref"\s*:\s*"([^"]+)"/.exec(b.payload || "");
    const sub = m ? SUB[m[1]] || "" : "";
    return `<button type="button" class="pref" data-rasa-payload="${escapeHtml(b.payload)}" data-user-label="${escapeHtml(b.title)}">
       <span class="pref__name">${escapeHtml(b.title)}</span>
       ${sub ? `<span class="pref__sub">${escapeHtml(sub)}</span>` : ""}
     </button>`;
  }).join("");
  return `<p class="dock__hint">What matters most for keeping this green?</p>
    <div class="prefs">${chips}</div>`;
}

// ---- "thinking" indicator + input lock while waiting on Rasa ----
let thinkingEl = null, thinkingTimer = null, thinkingShownAt = 0, lastSent = null;
const MIN_THINKING_MS = 350;        // keep the indicator visible even on instant replies
function showThinking() {
  if (replaying) return;            // no per-step indicator while re-planning
  hideThinking();
  thinkingShownAt = Date.now();
  thinkingEl = appendMsg("msg--bot",
    `<div class="bubble typing" aria-label="Eco-Travel Advisor is thinking"><span></span><span></span><span></span></div>`);
  textInputEl.disabled = true;
  sendBtnEl.disabled = true;
  dockEl.classList.add("is-busy");   // pointer-events:none dims and locks quick replies
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
  thinkingShownAt = 0;
  textInputEl.disabled = false;
  sendBtnEl.disabled = false;
  dockEl.classList.remove("is-busy");
}
// Remove the indicator, but only after it has been visible for a beat, so a near-
// instant response still shows a clear typing state rather than flickering.
async function finishThinking() {
  const elapsed = thinkingShownAt ? Date.now() - thinkingShownAt : MIN_THINKING_MS;
  if (elapsed < MIN_THINKING_MS) {
    await new Promise((r) => setTimeout(r, MIN_THINKING_MS - elapsed));
  }
  hideThinking();
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
    await finishThinking();
    renderRasaResponses(data);
    refreshFromTracker();             // authoritative slot state for the summary
  } catch (err) {
    await finishThinking();
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
  const payload = el.dataset.rasaPayload;
  // Route any "talk to a human" chip (e.g. the fallback escalation) through the
  // confirm → connect flow instead of jumping straight into advisor mode.
  if (payload === "/request_human") { startHandover(); return; }
  sendToRasa(payload, el.dataset.userLabel || el.textContent.trim());
});

// Dock widgets: retry, "More cities" expander, date-range confirm.
dockEl.addEventListener("click", (ev) => {
  const retry = ev.target.closest("[data-retry]");
  if (retry && lastSent) { sendToRasa(lastSent.message, false); return; }

  // Human-advisor handover: confirm → connect, and the advisor-mode actions.
  if (ev.target.closest("[data-handover-start]")) { startHandover(); return; }
  if (ev.target.closest("[data-handover-confirm]")) { connectToAdvisor(); return; }
  if (ev.target.closest("[data-handover-cancel]")) {
    addBot("No problem, let's keep planning.");
    if (dockBeforeHandover !== null) setDock(dockBeforeHandover);
    return;
  }
  // Quick 3 questions: reuse the real planner widgets to fill the missing critical
  // slots (origin, destination, dates), then connect automatically once they're in.
  if (ev.target.closest("[data-handover-quick]")) {
    handoverAfterCritical = true;
    addUser("Quick 3 questions");
    addBot("Great, just a couple of basics and then I'll connect you.");
    sendToRasa("/plan_trip", false);
    return;
  }
  // Skip: connect immediately; Maya picks up the conversation as it stands.
  if (ev.target.closest("[data-handover-skip]")) {
    addUser("Skip & connect now");
    connectToAdvisor();
    return;
  }

  // Traveller stepper.
  const tStep = ev.target.closest("[data-trav-step]");
  if (tStep) { setTrav(travCount + Number(tStep.dataset.travStep)); return; }
  const tSet = ev.target.closest("[data-trav-set]");
  if (tSet) { setTrav(Number(tSet.dataset.travSet)); return; }
  if (ev.target.closest("[data-trav-continue]")) {
    sendToRasa(`/inform{"num_travellers": "${travCount}"}`, `${travCount} traveller${travCount === 1 ? "" : "s"}`);
    return;
  }

  // Budget: switch between tiers and the exact-amount input.
  if (ev.target.closest("[data-budget-exact]")) { setDock(buildBudgetExact()); return; }
  if (ev.target.closest("[data-budget-tiers]")) { setDock(buildBudgetCards()); return; }
  if (ev.target.closest("[data-budget-confirm]")) {
    const v = Number((document.getElementById("budget-amount") || {}).value);
    if (!v || v <= 0) { const inp = document.getElementById("budget-amount"); if (inp) inp.focus(); return; }
    sendToRasa(`/inform{"budget": "${v}"}`, `€${v}/day`);
    return;
  }

  const flex = ev.target.closest("[data-flex-length]");
  if (flex) {                                          // flexible -> pick a year first
    addUser("I'm flexible");
    addBot("No problem, which year suits you?");
    setDock(buildFlexYears());
    return;
  }
  const fy = ev.target.closest("[data-flex-year]");
  if (fy) {                                            // year chosen -> pick a month
    const y = Number(fy.dataset.flexYear);
    addUser(String(y));
    addBot("And which month?");
    setDock(buildFlexMonthsForYear(y));
    return;
  }
  const fm = ev.target.closest("[data-flex-month]");
  if (fm) {                                            // month chosen -> ask length
    const [y, m] = fm.dataset.flexMonth.split("-").map(Number);
    flexMonth = { y, m };
    addUser(fm.textContent.trim());
    addBot("And roughly how long?");
    setDock(buildFlexNights());
    return;
  }
  const fn = ev.target.closest("[data-flex-nights]");
  if (fn && flexMonth) {                               // length chosen -> propose concrete random dates
    const nights = Number(fn.dataset.flexNights);
    const label = randomFlexRange(flexMonth.y, flexMonth.m, nights);
    flexMonth = null;
    sendToRasa(`/inform{"travel_date": "${label}"}`, label);
    return;
  }
  const geoBtn = ev.target.closest("[data-geo-locate]");
  if (geoBtn) {                                        // GPS -> nearest supported city
    geoBtn.disabled = true; geoBtn.textContent = "📍 Locating…";
    navigator.geolocation.getCurrentPosition(
      (pos) => sendToRasa(`/inform{"origin": "geo:${pos.coords.latitude},${pos.coords.longitude}"}`, "📍 My location"),
      () => { geoBtn.disabled = false; geoBtn.textContent = "📍 Use my location";
              addBot("I couldn't access your location, so please pick or type a city."); }
    );
    return;
  }
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
    if (e) {
      const nights = safeNights(s, e);
      if (nights === null) {
        if (out) out.textContent = "Please choose an end date after the start date (within about a year).";
        return;
      }
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
  if (sEl.value && eEl && eEl.value) {
    const nights = safeNights(sEl.value, eEl.value);
    out.textContent = nights === null
      ? "End date must be after the start date."
      : `${fmtDate(sEl.value)} – ${fmtDate(eEl.value)} · ${nights} night${nights === 1 ? "" : "s"}`;
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
document.getElementById("btn-handover").addEventListener("click", startHandover);
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

// Trip history rail: click an entry to re-plan that trip.
const historyEl = document.getElementById("history");
if (historyEl) historyEl.addEventListener("click", (ev) => {
  const item = ev.target.closest("[data-trip]");
  if (!item || advisorMode) return;
  const t = tripHistory[Number(item.dataset.trip)];
  if (t) replayTrip(t);
});

/* --------------------------------------------------------------------------
   9. Boot
   -------------------------------------------------------------------------- */
function boot() {
  RASA_FIELDS.forEach((f) => delete rasaTrip[f]);
  renderSummary();
  renderHistory();
  sendToRasa("/greet", false);   // silent trigger, no user bubble
}
boot();
