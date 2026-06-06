# Manual Debug Cases — Eco-Travel Advisor

Reproducible cases derived from the first connected conversation
(`conversation_log.json`). Each case has steps, the expected behaviour, the
observed behaviour, the issue category, and a status to re-check after each fix.

Run each case in the UI (or `rasa shell`), then re-capture the tracker and run
`python3 scripts/analyse_conversation_log.py` to confirm the category is gone.

| Status legend |
|---|
| OPEN = not fixed · FIXED = verified by re-running the analyser |

---

### DC-01 — inform with origin/destination does not start the form
- **Steps:** Fresh session. Type: `I want to plan a trip from London to Paris`
- **Expected:** Trip planning starts; origin=London, destination=Paris pre-filled; bot asks the next missing slot (travel dates).
- **Observed:** `action_default_fallback` → "I'm not sure I understood." (no form, no buttons)
- **Category:** `missing_form_activation`, `unexpected_fallback`, `missing_buttons`
- **Status:** FIXED — added the "Start planning from trip details" rule (`inform` -> `trip_planning_form`). Verified via REST: "I want to plan a trip from London to Paris" now activates the form and asks for travel dates (no fallback).

### DC-02 — affirm after greet does not start the form
- **Steps:** Type `hello` → bot greets. Type `yes ready`.
- **Expected:** Affirming the greeting starts trip planning.
- **Observed:** Fallback.
- **Category:** `unexpected_fallback`, `missing_buttons`
- **Status:** FIXED — verified (clean REST run + core story passes). "hello" → greet, then "yes please" (affirm) starts the form and asks for origin.

### DC-03 — origin typo not normalised
- **Steps:** Start the form. When asked origin, type `madridd`.
- **Expected:** Normalised to `Madrid`; later text reads "Madrid to ...".
- **Observed:** Stored as `Madridd`; recommendations say "Madridd to Copenhagen".
- **Category:** `unnormalised_origin`
- **Status:** FIXED — verified. `madridd` → "I understood that as Madrid"; the slot stores the canonical "Madrid".

### DC-04 — destination typo confirmation broken
- **Steps:** In the form, when asked destination, type `kopenhg` → bot asks "Did you mean Copenhagen?" → reply `/affirm` (or tap Yes).
- **Expected:** Destination set to Copenhagen; form continues.
- **Observed:** `destination` slot set to `/affirm`; bot says "I don't support '/affirm'".
- **Category:** `failed_typo_confirmation`, `slot_pollution_by_control_intent`, `unsupported_location`
- **Status:** FIXED — verified. `kopenhg` → "I understood that as Copenhagen" and the form continues; no `/affirm` slot pollution.

### DC-05 — edit answer writes the payload value into the slot
- **Steps:** After a plan is shown, tap **Edit answer** → choose **Travel dates** (sends `/edit_answer{"travel_date":"change"}`).
- **Expected:** travel_date is cleared and the form re-asks for a new date.
- **Observed:** `travel_date` = `change`; the form completes immediately and re-shows the plan.
- **Category:** `edit_flow_error`, `slot_pollution_by_control_intent`
- **Status:** FIXED — verified. `/edit_answer{"field_to_edit":"travel_date"}` → "Okay - let's update your travel dates" and re-asks the date; travel_date is not set to "change".

### DC-06 — go back stored as a slot value
- **Steps:** During the form, send `/go_back` while a slot is requested.
- **Expected:** The previous slot re-opens; `/go_back` is never a slot value.
- **Observed:** `sustainability_pref` = `/go_back`.
- **Category:** `go_back_flow_error`, `slot_pollution_by_control_intent`
- **Status:** FIXED — verified. `/go_back` → "Sure - let's revisit your origin" and re-opens the previous slot; `/go_back` is never stored as a value.

### DC-07 — typo/known city outside the form falls back
- **Steps:** Fresh session (no form). Type `berln` (or `berlin`).
- **Expected:** Recognise Berlin → start planning and ask for the missing origin.
- **Observed:** Fallback (no active form).
- **Category:** `missing_form_activation`, `unexpected_fallback`, `missing_buttons`
- **Status:** FIXED — verified. `berln` no longer falls back; it activates the planning form (asks for the missing origin). Note: the typo itself is not always echoed as "recognised Berlin" when sent as the very first turn — NLU entity extraction for the raw typo is best-effort, but the key regression (fallback) is resolved.

### DC-08 — unsupported location gives no useful message outside the form
- **Steps:** Fresh session. Type `adana` (unsupported city).
- **Expected:** A scoped, helpful message ("I currently cover Paris, Berlin, Amsterdam, Copenhagen") and a way to continue.
- **Observed:** Misclassified as affirm (0.59) → fallback.
- **Category:** `unexpected_fallback`, (intended) `unsupported_location`
- **Status:** FIX APPLIED — added `action_scoped_fallback` (wired to the `nlu_fallback` rule). A low-confidence input that looks like a place name (e.g. `adana`) now replies "I don't cover \"adana\" yet. I currently support 12 popular European cities: ..." with city buttons; other low-confidence inputs keep the generic rephrase. Re-train and re-run to verify (`tests/test_stories.yml` covers the routing).

### DC-09 — buttons missing in fallback/question states
- **Steps:** Any of the fallback turns above.
- **Expected:** Questions and recoverable states always offer buttons (quick replies).
- **Observed:** Plain text only; "there's no button shown".
- **Category:** `missing_buttons`
- **Status:** FIXED — verified. Every question and fallback turn in the clean REST run carried buttons; the frontend renders Rasa buttons as chips.

---

## Sprint fix summary (DC-01 .. DC-09)

| Case | Status | Fix applied | File(s) |
|---|---|---|---|
| DC-01 | FIXED (verified) | `inform` activates `trip_planning_form` | data/rules.yml |
| DC-02 | FIXED (verified) | greet → affirm → form story; "let's go"/"start" as plan_trip | data/stories.yml, data/nlu.yml |
| DC-03 | FIXED (verified) | `resolve_origin` fuzzy match; canonical origin in messages | repository.py, actions.py |
| DC-04 | FIXED (verified) | destination typos auto-corrected; no `/affirm` slot pollution | actions.py |
| DC-05 | FIXED (verified) | edit buttons use `field_to_edit`; only the chosen slot is reset | domain.yml, actions.py |
| DC-06 | FIXED (verified) | `not_intent` on from_text + from_entity; control intents never become slot values | domain.yml |
| DC-07 | FIXED (verified) | supported city/typo outside form starts planning (no fallback) | data/rules.yml, actions.py |
| DC-08 | FIX APPLIED | `action_scoped_fallback`: place-name input gets a scoped "I support these 12 cities" reply + buttons | data/rules.yml, domain.yml, actions.py, tests/test_stories.yml |
| DC-09 | FIXED (verified) | backend responses include buttons; frontend renders them as chips | domain.yml, actions.py, frontend/app.js |

Verification method: automated `rasa test core --stories tests/test_stories.yml` (all stories passed) +
a clean interactive REST run (unique sender + `/restart` per case) on 2026-06-05. DC-08 is a known,
optional polish item, not a regression.

---

## v2.1 stabilization checks (UX + logic)

Run in the connected UI after `rasa train` + restarting both servers.

| ID | Steps | Expected |
|---|---|---|
| S-01 | At the **travel_date** step, type `65` | Rejected: "That doesn't look like a date. Please choose a date range, or select Flexible dates." Slot NOT set to 65. |
| S-02 | At the **budget** step, type `65` (or `€65`, `65 per day`) | Accepted: "about €65/day, so I'll use the Budget tier." Summary shows `€65/day · Budget`. |
| S-03 | At the **budget** step, type `100` / `around 150 per day` | 100 → Comfort/Mid tier; 150 → Mid; >150 → Premium/Comfort. Summary shows amount · tier. |
| S-04 | Date step → tap **I'm flexible** | Summary shows **Flexible dates** (not "flexible" or a raw value). |
| S-05 | Date step → pick start + end | Summary shows `02 Jul 2026 – 15 Jul 2026 · 13 nights`. |
| S-16 | Origin `roma` (Rome), then destination `londra` (London) — two different cities | Accepted as **Rome → London**; NO false "destination can't be the same as origin". Root cause was `from_entity` filling a slot regardless of the requested step; fixed by adding a `requested_slot` condition to every form slot's `from_entity` mapping (so a stray entity at the wrong step can no longer overwrite another slot). |
| S-06 | Complete a trip with **Lowest carbon**, greenest = train/coach | **No** global "high-emission" banner. The flight row in the transport card shows a red pill + inline "≈ N× the train" note. |
| S-07 | Inspect a full results batch | Carbon disclaimer appears **once** (on the carbon card), not after every message. |
| S-08 | Chatbot mode (no handover yet) | **Return to assistant** button is hidden. It only appears after tapping Talk to a human. |
| S-09 | Send any message | A typing indicator (three dots) shows; send + quick replies are disabled until the reply arrives, then re-enabled. |
| S-10 | Kill the backend, send a message | Friendly error + a **↻ Retry** button that re-sends. |
| S-11 | `hello` / `hi` / `hey` | Welcome message + "Plan a trip" button every time. |
| S-12 | After greeting, `yes ready` / `start planning` / `let's go` | The trip form starts. |
| S-13 | Fresh load (no trip yet) | **Back** and **Edit** are disabled. |
| S-14 | Any step | One prompt + one button group; no duplicated questions or buttons. |
| S-15 | Throughout | "Your trip" summary fills from the **tracker** (GET /conversations/{id}/tracker): From/To/Dates/Travellers/Budget/Priority all reliable, x/6 correct. |
