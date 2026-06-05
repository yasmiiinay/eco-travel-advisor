# Eco-Travel Advisor — UX/UI Redesign: Implementation Plan

Practical plan for applying the *UX/UI & Conversational Experience Redesign Plan*
to the existing project **without** changing the Rasa backend architecture
(Rasa REST, NeonDB, `repository.py`, `carbon.py`, JSON fallback all preserved).
Frontend-first. No code is written until this plan is approved.

## 0. Three reconciliations (spec vs. current code)

The redesign spec drifted from the current build. Resolved in favour of working code:

| Topic | Redesign spec says | Current project | Decision |
|---|---|---|---|
| Supported cities | 8 incl. Istanbul | **12**, no Istanbul (Paris, Berlin, Amsterdam, Copenhagen, London, Madrid, Rome, Barcelona, Vienna, Munich, Lisbon, Prague) | Use the real **12-city** seed set everywhere |
| Front-end stack | React + `MessageRenderer` | Vanilla JS (`frontend/app.js`) | Implement the renderer *pattern* in vanilla JS; **no framework** |
| Rasa names | `select_city`, `origin_city`, 4 recommend actions | `inform`, `origin`/`destination`, one `trip_planning_form`, one `action_recommend_plan` | Keep existing domain names; treat spec Section 21 as illustrative |
| Payload model | Typed `custom` JSON (Section 22) | Actions emit **text + buttons only** | Convert result actions to emit `custom` payloads (payload-shaping, allowed) |

---

## 1. Gap analysis: current UI vs redesigned UX plan

Current state grounded in `frontend/app.js`, `index.html`, `styles.css`, and `actions/actions.py`.

| # | Redesign capability (spec §) | Current state | Gap |
|---|---|---|---|
| G1 | Persistent **Trip Summary panel**, live fill, per-row edit (§8) | Exists only in **mock** mode inline; **absent** in live `rasa` mode | **Large** — new persistent region |
| G2 | **No-typing happy path**: chips/steppers/pickers per slot (§9–13) | Live mode shows backend `buttons` as flat chips only; no stepper/calendar/tier cards | **Medium** — frontend widgets keyed to slot |
| G3 | **Message taxonomy** (prompt / quick-reply / echo / card / pill / alert / banner) (§4) | Live mode = text bubbles + dock chips; one weak `renderCustom` | **Medium** |
| G4 | **Status pills** icon + label + colour, never colour-alone (§14, §20) | Backend bakes `[green]/[amber]/[red]` into text; no pill component in live mode | **Medium** — needs payloads + component |
| G5 | **Transport comparison** table/stacked cards, sortable (§15) | `action_recommend_plan` flattens modes into text lines | **Large** — needs `custom` payload + renderer |
| G6 | **Carbon as estimate + range + disclaimer** (§16) | Single point value in text ("about 142 kg"); disclaimer is a separate utter | **Medium** — add range to payload, persistent disclaimer styling |
| G7 | **Typo / unsupported / out-of-scope / 2-stage fallback** (§17) | Backend handles typo auto-correct + unsupported line + buttons; no "Did you mean?" confirm chip; fallback single-stage | **Small–Medium** — mostly polish + chip rendering |
| G8 | **Edit / Back / guarded Reset** (§18) | Header buttons send `/go_back`,`/edit_answer`,`/reset_trip`; reset clears chat with **no confirm**; no per-field pencil edit | **Small** — add confirm dialog + summary pencils |
| G9 | **Advisor mode** (distinct header/theme, simulated Maya, return) (§5–7) | `action_handover` returns one text block; rich handover notice exists only in **mock** mode; no mode flag in live | **Medium** — mostly **frontend-only** simulation |
| G10 | **Mobile-first** sticky header + summary bar + dock (§19) | Single column, basic; no sticky summary bar/drawer | **Medium** — CSS + layout |
| G11 | **Accessibility** AA: focus, aria-live, keyboard pickers, greyscale-safe (§20) | Minimal; `aria` sparse | **Medium** — cross-cutting |
| G12 | **Welcome/onboarding** screen with expectation-setting (§4.1) | `utter_greet` one line + button | **Small** |

**Net:** the backend already *computes* everything the cards need; the gap is almost entirely **(a) how results are serialized (text → typed `custom`)** and **(b) frontend rendering/layout**. No new data sources required.

---

## 2. Files likely affected

**Frontend (primary effort):**
- `frontend/app.js` — renderer switch on payload `type`; slot widgets; summary panel; mode flag; edit/back/reset/fallback chip handling.
- `frontend/index.html` — new DOM regions: summary panel/bar, mode-aware header, dock.
- `frontend/styles.css` — design tokens, status pills, cards, comparison layout, mobile rules, focus states.
- (new) `frontend/flags.js` or inline map — city → flag/SVG fallback for the 12 cities.

**Backend (only payload shaping, no architecture change):**
- `actions/actions.py` — `action_recommend_plan`, `action_estimate_carbon`, `action_high_emission_alert`, `action_handover` emit `json_message=` typed payloads **in addition to** a text fallback. Slot prompts optionally gain richer `buttons`.
- `domain.yml` — only if we add friendly button payloads or a welcome response; **no new slots** in Phase 1.

**Untouched (hard constraint):** `repository.py`, `carbon.py`, `db.py`, `seed_db.py`, NeonDB schema, JSON fallback, `config.yml`, NLU pipeline, `credentials.yml`, `endpoints.yml`.

---

## 3. Safe implementation order

Phased so each phase ships a working app and is independently testable. Backend stays runnable throughout (text fallback always present).

- **Phase 0 — Visual foundation (frontend-only, zero backend):** design tokens, status-pill component, card styles, mobile-first layout, accessible focus/aria. Render improvements to *existing* text/button responses. Ship.
- **Phase 1 — Trip Summary panel (frontend-only):** parse slot values already echoed in the stream / from a lightweight `trip_summary` payload; live fill; per-row pencil → sends `/edit_answer{...}`. Ship.
- **Phase 2 — Typed result payloads (backend payload-shaping + frontend renderer):** convert recommend/estimate/high-emission to `custom` payloads; build `transport_comparison`, `card_group`, `carbon_estimate`, `alert` renderers. **Highest value.** Ship.
- **Phase 3 — Advisor mode (frontend-only):** client-side `mode` flag, header/theme switch, context-transfer card, simulated Maya replies, return-to-assistant. Ship.
- **Phase 4 — Flow polish:** guarded reset dialog, "Did you mean?" confirm chips, 2-stage fallback rendering, welcome screen. Ship.
- **Phase 5 — Accessibility hardening + QA gates:** keyboard/SR/greyscale/zoom passes.

Rule: never start a phase that needs a backend change before its text fallback is confirmed working.

---

## 4. What can be done frontend-only (no backend/Rasa change)

- Design tokens, pills, cards, mobile layout, focus/aria (Phase 0).
- **Trip Summary panel** driven from the values the user already selected client-side (G1).
- City-chip widget with flags + origin-disable + SVG flag fallback (G2, partial).
- Rendering backend `buttons` as proper quick-reply rows; "More" overflow (G3).
- **Advisor mode** end-to-end as a *simulated* client experience — mode flag, themed header, context-transfer card, scripted Maya replies, return banner (G9). Backend `action_handover` text becomes the trigger only.
- **Guarded Reset** confirm dialog before sending `/reset_trip` (G8).
- Per-field **pencil edit** chips that send existing `/edit_answer{"field_to_edit":"..."}` payloads (backend already supports `field_to_edit`).
- Welcome/onboarding copy and layout (G12).
- Greyscale-safe styling, persistent calm carbon disclaimer line (G6 styling half).

---

## 5. What requires backend / custom-action changes

All are **payload shaping inside existing actions** — no new data sources, no schema change:

- **Transport comparison (G5):** `action_recommend_plan` (and/or `action_estimate_carbon`) emit a `transport_comparison` `custom` payload (mode, duration, price band, `carbon_kg`, `status{level,label,icon}`, `recommended`) built from the `options` list it already has. Keep the text version as fallback.
- **Recommendation cards (G3/G4):** hotels/experiences/offsets emitted as a `card_group` payload from data already fetched.
- **Carbon estimate + range (G6):** add a `range` to the carbon payload. *Minor*: `carbon.py` currently returns a point value — to avoid touching it, the **action** can derive a ±band (e.g., ±15%) and label it "indicative", keeping `carbon.py` unchanged. (If a real range is wanted later, that's a `carbon.py` change — postponed.)
- **High-emission alert (G4):** `action_high_emission_alert` emits an `alert` payload (level/icon/title/body/action) instead of plain text.
- **Handover context card (G9 trigger):** `action_handover` optionally emits a `handover` payload (the checklist trust card); the simulated advisor chat itself stays frontend.

**Explicitly NOT needed for the above:** new intents, new slots, NLU retraining, Duckling, or pipeline edits.

---

## 6. What should be postponed (Phase 2+ / out of scope for the UX sprint)

- **Duckling date parsing & calendar→Rasa date round-trip** (spec §10 free-text dates). Needs pipeline change + retrain. Phase 1 uses **fixed date chips** ("flexible" / preset payloads) only.
- **Budget exact-amount** slot + numeric parsing (spec §12). Keep the 3 existing tiers; defer the sheet.
- **Sustainability add-ons** multi-select (avoid flights / eco-certified-only) (spec §13). Needs a new slot + filtering logic in `repository.py` → **postpone** (touches the constraint set).
- **"Choose this transport" / choose hotel** interactivity that writes a `chosen_*` slot and re-estimates (spec §15). Render comparison **display-only** first.
- **Compare-two-modes pin** toggle (spec §15). Nice-to-have.
- **Real emission-factor range** in `carbon.py` (keep action-derived band for now).
- **Stitch high-fidelity mockups** (spec §24) — these are a *design/report* artefact, run separately; not part of the code sprint.
- Renaming intents/slots to the spec's Section 21 names — unnecessary churn; risks breaking trained model.

---

## 7. Risk list

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Mock-mode (4-city, stale) data and live mode diverge; demo shows wrong cities | Med | Med | Update mock data to the 12 cities **or** disable mock path; single source for flags |
| R2 | Typed payloads break the existing **text fallback**, leaving blank bubbles if a field is missing | Med | High | Every action emits text **and** `custom`; renderer falls back to text on unknown `type` |
| R3 | `custom` payload shape mismatch between action and renderer (the spec warns: probe real shape) | Med | High | Define one contract file; build renderer from a captured real response, not assumptions |
| R4 | Editing `actions.py` reintroduces a DC-01..DC-09 regression before they're verified | Med | High | Freeze the DC fixes first (retrain+verify), branch the UX work, re-run regression after |
| R5 | Scope creep into backend (add-ons, exact budget, Duckling) violates "frontend-first" | High | Med | Hard postpone list (§6); any backend change limited to payload shaping |
| R6 | Accessibility claims in the report not backed by real testing | Med | Med (grades) | Phase 5 runs keyboard/SR/greyscale/zoom and records evidence |
| R7 | Flag emoji render inconsistently (Windows shows letter pairs) | High | Low | SVG flag fallback; always pair flag with city text |
| R8 | ngrok URL churn makes live demo flaky during UX testing | High | Med | Prefer HF Spaces same-origin (already supported by `app.js` resolver) for stable testing |
| R9 | Carbon ±band invented in the action looks like false precision | Low | Med (integrity) | Label "indicative range"; document method honestly; cite a real factor source in report |
| R10 | Large `app.js` refactor destabilises working live mode | Med | High | Phase behind the renderer switch; keep old path until each `type` renderer is verified |

---

## 8. Acceptance criteria

Per phase, "done" means:

- **AC-0 (foundation):** Existing live conversation still completes end-to-end; status text now renders as pills (icon+label+colour); greyscale screenshot still legible; visible focus on every control; 360 px mobile has no horizontal scroll.
- **AC-1 (summary):** Each of the 6 slots appears in the panel the moment it's set; "x of 6" indicator correct; pencil on a row re-asks exactly that slot via `/edit_answer{"field_to_edit":...}`; panel visible (read-only) in advisor mode.
- **AC-2 (results payloads):** Transport renders as a comparison with one row per available mode, sorted greenest-first, each row a pill; flight (if present) shows red ⚠ + the "≈ N× the train" note; hotels/experiences/offsets render as cards; **if the backend `custom` is stripped, the text fallback still shows**; no blank bubbles.
- **AC-3 (advisor):** Tapping handover shows confirm → connecting banner → context-transfer checklist card → themed advisor header; Maya's first message references real slot values; "Return to assistant" restores bot theme and the full transcript is intact.
- **AC-4 (flows):** Reset always asks to confirm; a near-miss typo offers a "Did you mean X?" chip; second fallback shows an action menu, not a dead end.
- **AC-5 (a11y):** Keyboard-only completes the happy path; VoiceOver/NVDA announces new bot messages and mode changes; every green/amber/red also carries text; carbon figures always show a range + disclaimer.
- **Cross-cutting:** Happy path completable with **zero keystrokes**; `repository.py`/`carbon.py`/NeonDB/JSON fallback unchanged (git diff proves it); DC-01..DC-09 regression still green.

---

## 9. Step-by-step implementation backlog

Ordered; each item is small and independently shippable. `[FE]` frontend-only, `[BE]` backend payload-shaping, `[X]` cross-cutting.

**Phase 0 — Foundation**
1. `[FE]` Add design tokens (palette w/ AA pairs, spacing, radius 16px, type scale, status colours+icons) to `styles.css`.
2. `[FE]` Build a single **status-pill** component (icon + label + colour) and a card style; replace `[green]/[amber]/[red]` text parsing with pills in `renderRasaResponses`.
3. `[FE]` Quick-reply row styling + "More" overflow; 44px targets; focus states.
4. `[X]` Mobile-first layout pass (sticky header, single-column cards, dock above keyboard).
5. `[FE]` 12-city flag map + SVG fallback; fix/disable stale mock data (R1).

**Phase 1 — Trip Summary**
6. `[FE]` Add summary region to `index.html` (right rail desktop / sticky bar+drawer mobile).
7. `[FE]` Track selected slot values client-side; live-fill rows + "x of 6"; muted placeholders.
8. `[FE]` Per-row pencil → send `/edit_answer{"field_to_edit":"<slot>"}` (backend already supports it).

**Phase 2 — Typed result payloads (highest value)**
9. `[BE]` Capture one real live response, then define the `custom` contract (`transport_comparison`, `card_group`, `carbon_estimate`, `alert`) in a short `docs/payload-contracts.md` (R3).
10. `[BE]` `action_recommend_plan`: emit `transport_comparison` + `card_group` payloads **plus** existing text fallback.
11. `[BE]` `action_estimate_carbon`: emit `carbon_estimate` with action-derived indicative range (carbon.py untouched).
12. `[BE]` `action_high_emission_alert`: emit `alert` payload.
13. `[FE]` Renderer switch on payload `type`; build comparison renderer (sorted, pills, flight note), card-group renderer, carbon band + persistent disclaimer + "How we estimate" sheet.
14. `[FE]` Unknown-`type` and missing-field fallback to text (R2).

**Phase 3 — Advisor mode (frontend-only)**
15. `[FE]` `mode` flag; themed header + accent; advisor avatar bubbles.
16. `[FE]` Handover sequence: confirm chip → connecting banner → context-transfer checklist card (from slot values).
17. `[FE]` Scripted Maya replies referencing real slots; "Return to assistant" + system banners; transcript preserved.
18. `[BE opt]` `action_handover` emits a `handover` payload to trigger the card (text fallback kept).

**Phase 4 — Flow polish**
19. `[FE]` Guarded Reset confirm dialog before `/reset_trip`.
20. `[FE]` "Did you mean X?" confirm chip rendering for typo path.
21. `[FE]` Two-stage fallback: clarify chips → action menu.
22. `[FE]` Welcome/onboarding screen.

**Phase 5 — Accessibility + QA**
23. `[X]` aria-live conversation log; focus trap in sheets; keyboard calendar/stepper.
24. `[X]` QA gates: keyboard-only, VoiceOver/NVDA, greyscale, 200% zoom, 360px; `prefers-reduced-motion`.
25. `[X]` Verify DC-01..DC-09 regression + `git diff` proves `repository.py`/`carbon.py`/NeonDB/JSON untouched.

---

## Report mapping (how this feeds the dissertation)

- §1 gap analysis + §7 risks + §8 ACs → *Design rationale & evaluation* (frame against Nielsen heuristics, WCAG 1.4.1).
- §2 files + §5 backend payloads → *Implementation* (backend↔frontend contract).
- §3 phasing + §9 backlog → *Methodology* (iterative, testable increments).
- §6 postponed + §7 R9 → *Limitations / ethical considerations* (simplified carbon, prototype scope) — cite a **real, verified** emission-factor source; do not fabricate.

**Prerequisite before any UX code:** verify the DC-01..DC-09 fixes (retrain + regression) so the UX branch starts from a known-good backend (R4).
