/* ==========================================================================
   Eco-Travel Advisor — UX preview logic (standalone, browser only)

   This drives the guided conversation with a small state machine and renders
   buttons / chips / cards / dropdown / calendar for each step. It runs on the
   static sample data below, which mirrors the project's seed data, and it
   reproduces the same route maths as actions/repository.py (haversine distance
   + the same emission factors and mode profiles) so the preview is faithful.

   When this is later connected to the Rasa REST channel, the rendering helpers
   stay; only the "decide what comes next" logic is replaced by bot replies.
   ========================================================================== */

"use strict";

/* --------------------------------------------------------------------------
   0. Mode configuration
   MODE = "rasa": send messages to the live Rasa backend over the REST channel
                  and render real bot responses (default).
   MODE = "mock": run the standalone offline preview below (dev / fallback).
   -------------------------------------------------------------------------- */
const MODE = "rasa";
const RASA_REST_URL = "http://localhost:5005/webhooks/rest/webhook";
const SENDER = "demo-user";

/* --------------------------------------------------------------------------
   1. Sample data (mirrors data/seed/*.json) — used only by MODE = "mock"
   -------------------------------------------------------------------------- */

const ORIGINS = {
  London:     { lat: 51.5074, lon: -0.1278 },
  Madrid:     { lat: 40.4168, lon: -3.7038 },
  Rome:       { lat: 41.9028, lon: 12.4964 },
  Istanbul:   { lat: 41.0082, lon: 28.9784 },
  Manchester: { lat: 53.4808, lon: -2.2426 },
  Dublin:     { lat: 53.3498, lon: -6.2603 },
  Brussels:   { lat: 50.8503, lon:  4.3517 },
  Barcelona:  { lat: 41.3874, lon:  2.1686 },
  Munich:     { lat: 48.1351, lon: 11.5820 },
  Vienna:     { lat: 48.2082, lon: 16.3738 },
};

const DESTINATIONS = {
  1: { city: "Paris",      lat: 48.8566, lon:  2.3522, dailyBudget: 120 },
  2: { city: "Berlin",     lat: 52.5200, lon: 13.4050, dailyBudget:  95 },
  3: { city: "Amsterdam",  lat: 52.3676, lon:  4.9041, dailyBudget: 130 },
  4: { city: "Copenhagen", lat: 55.6761, lon: 12.5683, dailyBudget: 150 },
};

// kg CO2e per passenger-km (illustrative; verify before citing).
const FACTORS = { flight: 0.158, train: 0.035, coach: 0.027, car: 0.171 };

// Profiles to derive duration and price from distance.
const MODES = {
  flight: { speed: 700, overhead: 2.5, base: 60, perKm: 0.12, minDist: 300, label: "Flight" },
  train:  { speed: 140, overhead: 0.5, base: 20, perKm: 0.20, minDist: 0,   label: "Train" },
  coach:  { speed: 75,  overhead: 0.3, base: 10, perKm: 0.07, minDist: 0,   label: "Coach" },
  car:    { speed: 95,  overhead: 0.2, base: 0,  perKm: 0.20, minDist: 0,   label: "Car" },
};

const HOTELS = {
  1: [
    { name: "Hôtel Vert Montmartre", cert: "Green Key",   band: "mid",  price: 145, score: 8.2, carbon: "green", tags: ["eco_certified", "renewable_energy", "public_transport_access"] },
    { name: "Le Jardin Éco",         cert: "EU Ecolabel", band: "high", price: 240, score: 9.0, carbon: "green", tags: ["carbon_neutral", "wheelchair_accessible", "low_water_usage"] },
    { name: "Auberge Verte Bastille",cert: "Green Globe",  band: "low",  price: 75,  score: 7.4, carbon: "amber", tags: ["plastic_free", "locally_owned"] },
  ],
  2: [
    { name: "Hotel Grünwald",        cert: "Green Key",    band: "mid",  price: 110, score: 8.0, carbon: "green", tags: ["eco_certified", "renewable_energy", "plastic_free"] },
    { name: "Das Nachhaltig Hotel",  cert: "EU Ecolabel",  band: "high", price: 195, score: 9.1, carbon: "green", tags: ["carbon_neutral", "locally_sourced_food", "wheelchair_accessible"] },
    { name: "EcoStay Kreuzberg",     cert: "Green Tourism",band: "low",  price: 68,  score: 7.6, carbon: "amber", tags: ["locally_owned", "fair_wage"] },
  ],
  3: [
    { name: "Canal Green Hotel",     cert: "Green Key",    band: "mid",  price: 160, score: 8.3, carbon: "green", tags: ["eco_certified", "renewable_energy", "low_water_usage"] },
    { name: "Hotel Duurzaam",        cert: "EU Ecolabel",  band: "high", price: 230, score: 9.2, carbon: "green", tags: ["carbon_neutral", "locally_sourced_food", "wheelchair_accessible"] },
    { name: "EcoBunk Amsterdam",     cert: "Green Key",    band: "low",  price: 62,  score: 7.5, carbon: "amber", tags: ["plastic_free", "locally_owned"] },
  ],
  4: [
    { name: "Hotel Bæredygtig",      cert: "Green Key Gold",     band: "high", price: 255, score: 9.4, carbon: "green", tags: ["carbon_neutral", "renewable_energy", "wheelchair_accessible"] },
    { name: "Nordic Eco Lodge",      cert: "Nordic Swan",        band: "mid",  price: 150, score: 8.6, carbon: "green", tags: ["eco_certified", "locally_sourced_food"] },
    { name: "GreenSleep Copenhagen", cert: "Green Key",          band: "low",  price: 82,  score: 7.8, carbon: "amber", tags: ["plastic_free", "fair_wage"] },
  ],
};

const EXPERIENCES = {
  1: [{ name: "Le Marais Heritage Walking Tour", type: "Cultural", price: 25 }, { name: "Organic Market Cooking Class", type: "Food", price: 55 }],
  2: [{ name: "Street Art & History Bike Tour", type: "Cultural", price: 30 }, { name: "Refugee-led Kitchen Experience", type: "Community", price: 45 }],
  3: [{ name: "Jordaan Canal Heritage Walk", type: "Cultural", price: 22 }, { name: "Repair Café Workshop", type: "Community", price: 12 }],
  4: [{ name: "Nyhavn & Harbour Heritage Walk", type: "Cultural", price: 28 }, { name: "Community Farm-to-Table Dinner", type: "Community", price: 60 }],
};

const OFFSETS = {
  1: { provider: "Île-de-France Reforestation Fund", type: "reforestation", perTonne: 18 },
  2: { provider: "Brandenburg Peatland Restoration", type: "peatland restoration", perTonne: 22 },
  3: { provider: "Dutch Coastal Rewilding Fund", type: "reforestation", perTonne: 19 },
  4: { provider: "Nordic Forest Carbon Project", type: "reforestation", perTonne: 21 },
};

const PREFERENCES = [
  { key: "low_carbon",     label: "Lowest carbon" },
  { key: "eco_certified",  label: "Eco-certified hotels" },
  { key: "local_culture",  label: "Local community support" },
  { key: "balanced",       label: "Balanced" },
];

const BUDGETS = [
  { key: "budget",  label: "Budget (≤ €80/day)" },
  { key: "mid",     label: "Mid (€80–150/day)" },
  { key: "comfort", label: "Comfort (€150+/day)" },
];

// Free-text inputs that are out of scope for a travel planner.
const OUT_OF_SCOPE = ["weather", "joke", "news", "stock", "recipe", "football",
  "movie", "visa", "passport", "covid", "bitcoin", "song", "homework"];

/* --------------------------------------------------------------------------
   2. Engine (mirrors actions/repository.py)
   -------------------------------------------------------------------------- */

function haversine(a, b) {
  const R = 6371, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(h));
}

function carbonLevel(kg) {
  if (kg < 25) return "green";
  if (kg <= 75) return "amber";
  return "red";
}
const LEVEL_TEXT = { green: "Low", amber: "Medium", red: "High" };
const LEVEL_ICON = { green: "●", amber: "▲", red: "■" };

function buildTransportOptions(originName, destId) {
  const origin = ORIGINS[originName], dest = DESTINATIONS[destId];
  if (!origin || !dest) return [];
  const dist = haversine(origin, dest);
  const options = [];
  for (const mode of Object.keys(MODES)) {
    const m = MODES[mode];
    if (dist < m.minDist) continue;
    const emissions = dist * FACTORS[mode];
    options.push({
      mode,
      label: m.label,
      distance: Math.round(dist),
      duration: Math.round((m.overhead + dist / m.speed) * 10) / 10,
      price: Math.round(m.base + m.perKm * dist),
      emissions: Math.round(emissions * 10) / 10,
      level: carbonLevel(emissions),
    });
  }
  return options.sort((a, b) => a.emissions - b.emissions);
}

const CARBON_RANK = { green: 0, amber: 1, red: 2 };
function rankHotels(hotels, pref) {
  const list = hotels.slice();
  if (pref === "budget" || pref === "mid" || pref === "comfort") {
    return list.sort((a, b) => a.price - b.price);
  }
  if (pref === "low_carbon") {
    return list.sort((a, b) => (CARBON_RANK[a.carbon] - CARBON_RANK[b.carbon]) || (b.score - a.score));
  }
  if (pref === "eco_certified") {
    const has = (h) => (h.tags.includes("eco_certified") ? 0 : 1);
    return list.sort((a, b) => (has(a) - has(b)) || (b.score - a.score));
  }
  if (pref === "local_culture") {
    const has = (h) => (h.tags.includes("locally_owned") ? 0 : 1);
    return list.sort((a, b) => (has(a) - has(b)) || (b.score - a.score));
  }
  return list.sort((a, b) => b.score - a.score);
}

/* Simple typo tolerance (Levenshtein-based similarity) for city names. */
function similarity(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1,
                         d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return 1 - d[m][n] / Math.max(m, n);
}
function closestCity(input, names) {
  let best = null, bestScore = 0;
  for (const name of names) {
    const s = similarity(input, name);
    if (s > bestScore) { bestScore = s; best = name; }
  }
  return bestScore >= 0.6 ? best : null;
}

/* Parse natural traveller phrases, e.g. "me and my wife" -> 2. */
function parseTravellers(text) {
  const t = text.toLowerCase();
  if (/\b(\d+)\b/.test(t)) return Math.max(1, parseInt(t.match(/\b(\d+)\b/)[1], 10));
  if (/(just me|solo|alone|myself|on my own)/.test(t)) return 1;
  if (/(wife|husband|partner|girlfriend|boyfriend|me and my|two of us|couple)/.test(t)) return 2;
  if (/family of four|four of us/.test(t)) return 4;
  if (/family|three of us/.test(t)) return 3;
  return null;
}

/* --------------------------------------------------------------------------
   3. State + DOM helpers
   -------------------------------------------------------------------------- */

const STEPS = ["origin", "destination", "travellers", "dates", "budget", "preference", "results"];
const state = { origin: null, destination: null, travellers: null, dates: null, budget: null, preference: null, stepIndex: 0, editing: false };

const chatEl = document.getElementById("chat");
const dockEl = document.getElementById("dock");
const summaryEl = document.getElementById("summary");
const summaryListEl = document.getElementById("summary-list");

function scrollChat() { chatEl.scrollTop = chatEl.scrollHeight; }

function addBot(html) {
  const wrap = document.createElement("div");
  wrap.className = "msg msg--bot";
  wrap.innerHTML = `<div class="msg__bubble">${html}</div>`;
  chatEl.appendChild(wrap); scrollChat();
}
function addBotBlock(html) {           // full-width (cards / notices, no bubble)
  const wrap = document.createElement("div");
  wrap.className = "msg msg--bot";
  wrap.style.maxWidth = "100%";
  wrap.innerHTML = html;
  chatEl.appendChild(wrap); scrollChat();
}
function addUser(text) {
  const wrap = document.createElement("div");
  wrap.className = "msg msg--user";
  wrap.innerHTML = `<div class="msg__bubble"></div>`;
  wrap.querySelector(".msg__bubble").textContent = text;
  chatEl.appendChild(wrap); scrollChat();
}

function setDock(html) { dockEl.innerHTML = html; }
function chip(label, action, value, primary) {
  return `<button type="button" class="chip${primary ? " chip--primary" : ""}" data-action="${action}" data-value="${value}">${label}</button>`;
}

function bandHtml(level, text) {
  return `<span class="band band--${level}">${LEVEL_ICON[level]} ${text || LEVEL_TEXT[level]}</span>`;
}

function updateSummary() {
  const items = [];
  if (state.origin) items.push(`<li><b>From:</b> ${state.origin}</li>`);
  if (state.destination) items.push(`<li><b>To:</b> ${DESTINATIONS[state.destination].city}</li>`);
  if (state.travellers) items.push(`<li><b>Travellers:</b> ${state.travellers}</li>`);
  if (state.dates) items.push(`<li><b>Dates:</b> ${state.dates}</li>`);
  if (state.budget) items.push(`<li><b>Budget:</b> ${BUDGETS.find((b) => b.key === state.budget).label}</li>`);
  if (state.preference) items.push(`<li><b>Priority:</b> ${PREFERENCES.find((p) => p.key === state.preference).label}</li>`);
  summaryListEl.innerHTML = items.join("");
  summaryEl.hidden = items.length === 0;
}

function updateControls() {
  document.getElementById("btn-back").disabled = state.stepIndex === 0;
  document.getElementById("btn-edit").disabled = !(state.origin && state.destination); // editable once there's something
}

/* --------------------------------------------------------------------------
   4. Step flow
   -------------------------------------------------------------------------- */

function goToStep(index) {
  state.stepIndex = index;
  renderStep();
  updateControls();
}
function advance() {
  if (state.editing) { state.editing = false; goToStep(STEPS.indexOf("results")); return; }
  goToStep(state.stepIndex + 1);
}

function renderStep() {
  updateSummary();
  const step = STEPS[state.stepIndex];
  ({ origin: stepOrigin, destination: stepDestination, travellers: stepTravellers,
     dates: stepDates, budget: stepBudget, preference: stepPreference, results: stepResults }[step])();
}

function stepOrigin() {
  addBot("Hi! I'm your <b>Eco-Travel Advisor</b>. I'll help you plan a lower-carbon trip. First, where are you travelling <b>from</b>?");
  const quick = ["London", "Madrid", "Rome", "Istanbul"].map((c) => chip(c, "set-origin", c)).join("");
  const more = Object.keys(ORIGINS).filter((c) => !["London", "Madrid", "Rome", "Istanbul"].includes(c))
    .map((c) => `<option value="${c}">${c}</option>`).join("");
  setDock(`
    <p class="dock__hint">Pick a city, choose from the list, or type one.</p>
    <div class="choices">${quick}</div>
    <div class="field">
      <label for="origin-select">More cities:</label>
      <select class="select" id="origin-select"><option value="">Select…</option>${more}</select>
      <button type="button" class="chip chip--primary" data-action="confirm-origin-select">Use this city</button>
    </div>`);
}

function stepDestination() {
  addBot("Great. Which destination would you like to explore?");
  const chips = Object.entries(DESTINATIONS).map(([id, d]) => chip(d.city, "set-destination", id)).join("");
  setDock(`
    <p class="dock__hint">Tap a destination, or type a city (try a typo like “Pariiis”).</p>
    <div class="choices">${chips}</div>`);
}

function stepTravellers() {
  addBot("How many people are travelling?");
  const nums = [1, 2, 3, 4].map((n) => chip(String(n), "set-travellers", n)).join("");
  setDock(`
    <p class="dock__hint">Choose a number, a quick option, or type a phrase like “me and my wife”.</p>
    <div class="choices">
      ${nums}
      ${chip("Just me", "set-travellers", 1)}
      ${chip("Me + partner", "set-travellers", 2)}
    </div>`);
}

function stepDates() {
  addBot("When are you planning to travel?");
  setDock(`
    <p class="dock__hint">Pick dates from the calendar, or choose “I'm flexible”.</p>
    <div class="field">
      <label for="date-start">From</label>
      <input type="date" id="date-start" class="date" />
      <label for="date-end">To</label>
      <input type="date" id="date-end" class="date" />
      <button type="button" class="chip chip--primary" data-action="confirm-dates">Confirm dates</button>
      ${chip("I'm flexible", "set-dates-flex", "flexible")}
    </div>`);
}

function stepBudget() {
  addBot("What's your rough <b>daily</b> budget per person?");
  setDock(`<div class="choices">${BUDGETS.map((b) => chip(b.label, "set-budget", b.key)).join("")}</div>`);
}

function stepPreference() {
  addBot("Last question — what matters most for this trip?");
  setDock(`<p class="dock__hint">This shapes how I rank your options.</p>
    <div class="choices">${PREFERENCES.map((p) => chip(p.label, "set-preference", p.key)).join("")}</div>`);
}

/* --------------------------------------------------------------------------
   5. Results
   -------------------------------------------------------------------------- */

function stepResults() {
  const destId = state.destination;
  const dest = DESTINATIONS[destId];
  const travellers = state.travellers || 1;
  const options = buildTransportOptions(state.origin, destId);
  const greenest = options[0];
  const flight = options.find((o) => o.mode === "flight");

  addBot(`Here's your sustainable plan for <b>${state.origin} → ${dest.city}</b> (${travellers} traveller${travellers > 1 ? "s" : ""}). Everything below is ranked for your <b>“${PREFERENCES.find((p) => p.key === state.preference)?.label || "balanced"}”</b> priority.`);

  // --- Carbon estimate + disclaimer ---
  const perPerson = greenest.emissions;
  const total = Math.round(perPerson * travellers * 10) / 10;
  addBotBlock(`
    <div class="card">
      <p class="card__title">Estimated carbon footprint</p>
      <p class="card__sub">Greenest option (${greenest.label}): <b>${perPerson} kg CO₂e</b> per person ${bandHtml(greenest.level)}</p>
      <div class="card__meta"><span>Total for ${travellers}: <b>${total} kg CO₂e</b></span></div>
      <p class="disclaimer">Carbon values are estimates based on average emission factors and curated prototype data — verify against an official source (e.g. DEFRA/ICAO) before relying on them.</p>
    </div>`);

  // --- High-emission alert + greener alternative ---
  if (flight && flight.level === "red") {
    const greener = options.find((o) => o.level !== "red");
    const saved = greener ? Math.round((flight.emissions - greener.emissions) * 10) / 10 : 0;
    addBotBlock(`
      <div class="notice notice--warn" role="alert">
        <p class="notice__title">■ High-emission warning</p>
        Flying ${state.origin} → ${dest.city} emits about <b>${flight.emissions} kg CO₂e</b> per person (High).
        ${greener ? `Consider the <b>${greener.label.toLowerCase()}</b> instead — about <b>${greener.emissions} kg</b> (${LEVEL_TEXT[greener.level]}), saving roughly <b>${saved} kg</b> per person.` : ""}
      </div>`);
  }

  // --- Transport comparison cards ---
  addBot("Transport options, lowest emissions first:");
  addBotBlock(`<div class="cards">${options.map((o) => `
    <div class="card">
      <div class="card__top">
        <p class="card__title">${o.label}</p>
        ${bandHtml(o.level, `${LEVEL_TEXT[o.level]} emissions`)}
      </div>
      <div class="card__meta">
        <span>🌍 <b>${o.emissions} kg</b> CO₂e</span>
        <span>⏱ ${o.duration} h</span>
        <span>€ ${o.price}</span>
        <span>↔ ${o.distance} km</span>
      </div>
    </div>`).join("")}</div>`);

  // --- Eco-hotel cards ---
  const hotels = rankHotels(HOTELS[destId], state.preference);
  addBot("Recommended eco-friendly stays:");
  addBotBlock(`<div class="cards">${hotels.map((h) => `
    <div class="card">
      <div class="card__top">
        <div>
          <p class="card__title">${h.name}</p>
          <p class="card__sub">${h.cert} · ${h.band} · €${h.price}/night</p>
        </div>
        ${bandHtml(h.carbon, `${LEVEL_TEXT[h.carbon]} carbon`)}
      </div>
      <div class="card__meta"><span>Sustainability score <b>${h.score}/10</b></span></div>
      <div class="card__tags">${h.tags.map((t) => `<span class="tag">${t.replace(/_/g, " ")}</span>`).join("")}</div>
    </div>`).join("")}</div>`);

  // --- Cultural experiences ---
  const exps = EXPERIENCES[destId];
  addBotBlock(`<div class="cards">${exps.map((e) => `
    <div class="card">
      <p class="card__title">${e.name}</p>
      <p class="card__sub">${e.type} experience · €${e.price}</p>
    </div>`).join("")}</div>`);

  // --- Offset suggestion ---
  const offset = OFFSETS[destId];
  const offsetCost = Math.max(1, Math.round((total / 1000) * offset.perTonne));
  addBotBlock(`
    <div class="notice notice--info">
      <p class="notice__title">▲ Offset what you can't avoid</p>
      Offset your estimated <b>${total} kg CO₂e</b> via <b>${offset.provider}</b> (${offset.type}) for roughly <b>€${offsetCost}</b>.
      <p class="disclaimer">Offset pricing is indicative prototype data.</p>
    </div>`);

  // --- Next actions ---
  setDock(`
    <p class="dock__hint">Want to adjust something or get a human?</p>
    <div class="choices">
      ${chip("Edit an answer", "open-edit", "")}
      ${chip("Start over", "reset", "")}
      ${chip("Talk to a human advisor", "handover", "", true)}
    </div>`);
}

/* --------------------------------------------------------------------------
   6. Handover + edit + out-of-scope
   -------------------------------------------------------------------------- */

function showHandover() {
  const dest = state.destination ? DESTINATIONS[state.destination].city : "—";
  addBotBlock(`
    <div class="notice notice--handover" role="status">
      <p class="notice__title">🤝 Connecting you to a human advisor</p>
      A travel advisor will pick up shortly. Your full conversation context has been packaged and shared so you won't need to repeat anything:
      <ul class="context-list">
        <li>From: ${state.origin || "—"} → ${dest}</li>
        <li>Travellers: ${state.travellers || "—"} · Dates: ${state.dates || "—"}</li>
        <li>Budget: ${state.budget ? BUDGETS.find((b) => b.key === state.budget).label : "—"}</li>
        <li>Priority: ${state.preference ? PREFERENCES.find((p) => p.key === state.preference).label : "—"}</li>
        <li>Conversation transcript + estimated carbon</li>
      </ul>
    </div>`);
}

function openEdit() {
  addBot("Which answer would you like to change?");
  const fields = [];
  if (state.origin) fields.push(chip("Origin", "edit-field", "origin"));
  if (state.destination) fields.push(chip("Destination", "edit-field", "destination"));
  if (state.travellers) fields.push(chip("Travellers", "edit-field", "travellers"));
  if (state.dates) fields.push(chip("Dates", "edit-field", "dates"));
  if (state.budget) fields.push(chip("Budget", "edit-field", "budget"));
  if (state.preference) fields.push(chip("Priority", "edit-field", "preference"));
  setDock(`<div class="choices">${fields.join("")}</div>`);
}

function redirectOutOfScope() {
  addBot("I can only help with planning a <b>sustainable trip</b> — things like destinations, transport, eco-hotels and your carbon footprint. Let's carry on with that. 🌍");
  renderStep(); // re-show the current step's prompt + controls
}

/* --------------------------------------------------------------------------
   7. Event handling
   -------------------------------------------------------------------------- */

dockEl.addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-action]");
  if (!btn) return;
  const { action, value } = btn.dataset;

  switch (action) {
    case "set-origin":
      state.origin = value; addUser(value); advance(); break;
    case "confirm-origin-select": {
      const sel = document.getElementById("origin-select");
      if (sel && sel.value) { state.origin = sel.value; addUser(sel.value); advance(); }
      break;
    }
    case "set-destination":
      state.destination = Number(value); addUser(DESTINATIONS[value].city); advance(); break;
    case "set-travellers":
      state.travellers = Number(value); addUser(`${value} traveller${value > 1 ? "s" : ""}`); advance(); break;
    case "confirm-dates": {
      const s = document.getElementById("date-start").value;
      const e = document.getElementById("date-end").value;
      state.dates = (s && e) ? `${s} → ${e}` : (s || "flexible");
      addUser(state.dates); advance(); break;
    }
    case "set-dates-flex":
      state.dates = "flexible"; addUser("I'm flexible"); advance(); break;
    case "set-budget":
      state.budget = value; addUser(BUDGETS.find((b) => b.key === value).label); advance(); break;
    case "set-preference":
      state.preference = value; addUser(PREFERENCES.find((p) => p.key === value).label); advance(); break;
    case "confirm-typo":
      state.destination = Number(value); addUser(`Yes, ${DESTINATIONS[value].city}`);
      state.stepIndex = STEPS.indexOf("destination"); advance(); break;
    case "reject-typo":
      addUser("No"); renderStep(); break;
    case "open-edit": openEdit(); break;
    case "edit-field":
      state.editing = true; addUser(`Edit ${value}`); goToStep(STEPS.indexOf(value)); break;
    case "handover": showHandover(); break;
    case "reset": resetTrip(); break;
  }
});

// Free-text path (always available)
document.getElementById("composer").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const input = document.getElementById("text-input");
  const text = input.value.trim();
  if (!text) return;
  addUser(text);
  input.value = "";
  if (MODE === "rasa") sendToRasa(text, false);   // user bubble already shown
  else handleFreeText(text);
});

function handleFreeText(text) {
  const lower = text.toLowerCase();
  const step = STEPS[state.stepIndex];

  // 1) Out-of-scope guard
  if (OUT_OF_SCOPE.some((w) => lower.includes(w))) { redirectOutOfScope(); return; }

  // 2) Traveller phrase (any time, but only advances if we're on that step)
  const n = parseTravellers(text);
  if (step === "travellers" && n) {
    state.travellers = n; addBot(`Got it — <b>${n}</b> traveller${n > 1 ? "s" : ""}.`); advance(); return;
  }

  // 3) Origin step: match an origin city (typo tolerant)
  if (step === "origin") {
    const match = closestCity(text, Object.keys(ORIGINS));
    if (match) { state.origin = match; addBot(`Setting your origin to <b>${match}</b>.`); advance(); return; }
  }

  // 4) Destination typo tolerance: "Pariiis" -> "Did you mean Paris?"
  const destNames = Object.values(DESTINATIONS).map((d) => d.city);
  const cityMatch = closestCity(text, destNames);
  if (cityMatch) {
    const exact = destNames.some((c) => c.toLowerCase() === lower);
    const id = Object.keys(DESTINATIONS).find((k) => DESTINATIONS[k].city === cityMatch);
    if (exact) {
      state.destination = Number(id); state.stepIndex = STEPS.indexOf("destination"); advance(); return;
    }
    addBot(`Did you mean <b>${cityMatch}</b>?`);
    setDock(`<div class="choices">
      ${chip(`Yes, ${cityMatch}`, "confirm-typo", id, true)}
      ${chip("No, let me retype", "reject-typo", "")}
    </div>`);
    return;
  }

  // 5) Fallback / clarification
  addBot("Sorry, I didn't quite catch that. Please use the options below, or try a city or number.");
  renderStep();
}

/* --------------------------------------------------------------------------
   8. Trip controls + boot
   -------------------------------------------------------------------------- */

function resetTrip() {
  Object.assign(state, { origin: null, destination: null, travellers: null, dates: null, budget: null, preference: null, stepIndex: 0, editing: false });
  chatEl.innerHTML = "";
  updateSummary();
  goToStep(0);
}

/* --------------------------------------------------------------------------
   9. Rasa REST mode — send messages and render real bot responses
   -------------------------------------------------------------------------- */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function addBotText(text) { addBot(escapeHtml(text).replace(/\n/g, "<br>")); }

// Forward-compatible: render custom card payloads if actions.py sends them
// via dispatcher.utter_message(json_message={...}). Falls back to pretty JSON.
function renderCustom(custom) {
  if (custom && Array.isArray(custom.cards)) {
    const cards = custom.cards.map((c) => `
      <div class="card">
        <div class="card__top">
          <p class="card__title">${escapeHtml(c.title || "")}</p>
          ${c.level ? bandHtml(c.level, c.levelText) : ""}
        </div>
        ${c.subtitle ? `<p class="card__sub">${escapeHtml(c.subtitle)}</p>` : ""}
      </div>`).join("");
    addBotBlock(`<div class="cards">${cards}</div>`);
  } else {
    addBotBlock(`<div class="card"><pre style="white-space:pre-wrap;margin:0">${escapeHtml(JSON.stringify(custom, null, 2))}</pre></div>`);
  }
}

// Render the array Rasa returns: [{text, buttons, custom, image}, ...]
function renderRasaResponses(responses) {
  const buttons = [];
  (responses || []).forEach((msg) => {
    if (msg.text) addBotText(msg.text);
    if (msg.image) addBotBlock(`<img src="${escapeHtml(msg.image)}" alt="" style="max-width:100%;border-radius:10px" />`);
    if (msg.custom) renderCustom(msg.custom);
    if (Array.isArray(msg.buttons)) buttons.push(...msg.buttons);
  });
  if (buttons.length) {
    setDock(`<div class="choices">${buttons.map((b) =>
      `<button type="button" class="chip" data-rasa-payload="${escapeHtml(b.payload)}">${escapeHtml(b.title)}</button>`
    ).join("")}</div>`);
  } else {
    setDock(`<p class="dock__hint">Type your reply below, or use the controls above.</p>`);
  }
}

// Send a message to Rasa. userLabel === false suppresses the user bubble
// (used for the silent /greet trigger and for free text already echoed).
async function sendToRasa(message, userLabel) {
  if (userLabel !== false) addUser(userLabel || message);
  setDock(`<p class="dock__hint">…</p>`);
  try {
    const res = await fetch(RASA_REST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: SENDER, message }),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    renderRasaResponses(await res.json());
  } catch (err) {
    addBot("I couldn't reach the assistant backend. Please make sure the Rasa server is running " +
           "(<code>rasa run --enable-api --cors \"*\"</code>) and the action server is up. " +
           "For an offline demo, set <code>MODE = \"mock\"</code> at the top of app.js.");
    setDock(`<p class="dock__hint">Backend not reachable.</p>`);
  }
}

function bootRasa() {
  document.getElementById("btn-back").disabled = false;
  document.getElementById("btn-edit").disabled = false;
  sendToRasa("/greet", false);   // trigger the greeting with no user bubble
}

// Chips rendered from Rasa buttons carry data-rasa-payload; clicking sends it.
dockEl.addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-rasa-payload]");
  if (!btn) return;
  sendToRasa(btn.dataset.rasaPayload, btn.textContent);
});

/* --------------------------------------------------------------------------
   10. Trip controls + boot (mode-aware)
   -------------------------------------------------------------------------- */

document.getElementById("btn-back").addEventListener("click", () => {
  if (MODE === "rasa") return sendToRasa("/go_back", "Go back");
  if (state.stepIndex > 0) goToStep(state.stepIndex - 1);
});
document.getElementById("btn-edit").addEventListener("click", () => {
  if (MODE === "rasa") return sendToRasa("/edit_answer", "Edit an answer");
  openEdit();
});
document.getElementById("btn-reset").addEventListener("click", () => {
  if (MODE === "rasa") { chatEl.innerHTML = ""; return sendToRasa("/reset_trip", "Reset trip"); }
  resetTrip();
});
document.getElementById("btn-handover").addEventListener("click", () => {
  if (MODE === "rasa") return sendToRasa("/request_human", "Talk to a human");
  showHandover();
});

// Start the conversation
if (MODE === "rasa") bootRasa();
else goToStep(0);
