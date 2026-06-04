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
- **Status:** OPEN

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
- **Status:** OPEN
