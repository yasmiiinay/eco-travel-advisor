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
- **Status:** OPEN

### DC-03 — origin typo not normalised
- **Steps:** Start the form. When asked origin, type `madridd`.
- **Expected:** Normalised to `Madrid`; later text reads "Madrid to ...".
- **Observed:** Stored as `Madridd`; recommendations say "Madridd to Copenhagen".
- **Category:** `unnormalised_origin`
- **Status:** OPEN

### DC-04 — destination typo confirmation broken
- **Steps:** In the form, when asked destination, type `kopenhg` → bot asks "Did you mean Copenhagen?" → reply `/affirm` (or tap Yes).
- **Expected:** Destination set to Copenhagen; form continues.
- **Observed:** `destination` slot set to `/affirm`; bot says "I don't support '/affirm'".
- **Category:** `failed_typo_confirmation`, `slot_pollution_by_control_intent`, `unsupported_location`
- **Status:** OPEN

### DC-05 — edit answer writes the payload value into the slot
- **Steps:** After a plan is shown, tap **Edit answer** → choose **Travel dates** (sends `/edit_answer{"travel_date":"change"}`).
- **Expected:** travel_date is cleared and the form re-asks for a new date.
- **Observed:** `travel_date` = `change`; the form completes immediately and re-shows the plan.
- **Category:** `edit_flow_error`, `slot_pollution_by_control_intent`
- **Status:** OPEN

### DC-06 — go back stored as a slot value
- **Steps:** During the form, send `/go_back` while a slot is requested.
- **Expected:** The previous slot re-opens; `/go_back` is never a slot value.
- **Observed:** `sustainability_pref` = `/go_back`.
- **Category:** `go_back_flow_error`, `slot_pollution_by_control_intent`
- **Status:** OPEN

### DC-07 — typo/known city outside the form falls back
- **Steps:** Fresh session (no form). Type `berln` (or `berlin`).
- **Expected:** Recognise Berlin → start planning and ask for the missing origin.
- **Observed:** Fallback (no active form).
- **Category:** `missing_form_activation`, `unexpected_fallback`, `missing_buttons`
- **Status:** OPEN

### DC-08 — unsupported location gives no useful message outside the form
- **Steps:** Fresh session. Type `adana` (unsupported city).
- **Expected:** A scoped, helpful message ("I currently cover Paris, Berlin, Amsterdam, Copenhagen") and a way to continue.
- **Observed:** Misclassified as affirm (0.59) → fallback.
- **Category:** `unexpected_fallback`, (intended) `unsupported_location`
- **Status:** OPEN

### DC-09 — buttons missing in fallback/question states
- **Steps:** Any of the fallback turns above.
- **Expected:** Questions and recoverable states always offer buttons (quick replies).
- **Observed:** Plain text only; "there's no button shown".
- **Category:** `missing_buttons`
- **Status:** FIX APPLIED — fallback/question responses now carry buttons; the frontend renders Rasa buttons as chips.

---

## Sprint fix summary (DC-01 .. DC-09)

| Case | Status | Fix applied | File(s) |
|---|---|---|---|
| DC-01 | FIXED (verified) | `inform` activates `trip_planning_form` | data/rules.yml |
| DC-02 | FIX APPLIED | greet → affirm → form story; "let's go"/"start" as plan_trip | data/stories.yml, data/nlu.yml |
| DC-03 | FIX APPLIED | `resolve_origin` fuzzy match; canonical origin in messages | repository.py, actions.py |
| DC-04 | FIX APPLIED | destination typos auto-corrected; no `/affirm` slot pollution | actions.py |
| DC-05 | FIX APPLIED | edit buttons use `field_to_edit`; only the chosen slot is reset | domain.yml, actions.py |
| DC-06 | FIX APPLIED | `not_intent` on from_text + from_entity; control intents never become slot values | domain.yml |
| DC-07 | FIX APPLIED | supported city/typo outside form starts planning; unsupported → scoped message | data/rules.yml, actions.py |
| DC-08 | FIX APPLIED | `utter_default` / `utter_ask_rephrase` + unsupported message carry buttons | domain.yml, actions.py |
| DC-09 | FIX APPLIED | backend responses include buttons; frontend renders them as chips | domain.yml, actions.py, frontend/app.js |

"FIX APPLIED" = change made and statically validated; verify by re-training and running the
regression stories + the manual UI checklist below.
