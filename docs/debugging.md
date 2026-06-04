# Debugging Workflow — Eco-Travel Advisor

A structured, case-by-case process for finding and fixing dialogue-flow problems,
using the live Rasa tracker as evidence. Nothing here logs secrets or environment
variables; the tracker contains conversation events only, so the output is safe for
report screenshots.

## 1. Capture a conversation

1. Run the backend (notebook Section 16, or locally). The Rasa server must be
   started with `--enable-api` so the tracker endpoint is available.
2. Reproduce the behaviour in the UI (or via `rasa shell`).
3. Pull the tracker (notebook Section 17, or directly):
   ```
   GET http://localhost:5005/conversations/demo-user/tracker  ->  conversation_log.json
   ```
   `demo-user` must match `SENDER` in `frontend/app.js`.

## 2. Analyse the log

```bash
python3 scripts/analyse_conversation_log.py conversation_log.json
```

The analyser reconstructs each user turn and prints, per turn: the user text, the
predicted intent + confidence, extracted entities, the active loop, the requested
slot, the slot values that were set, the bot actions, the bot text, and any
detected **issue categories**. It also prints a summary count per category.

## 3. Issue categories

| Category | Meaning |
|---|---|
| `unexpected_fallback` | `action_default_fallback` fired even though the intent was classified confidently (>= 0.5). |
| `slot_pollution_by_control_intent` | A form slot was filled with a control payload (e.g. `/go_back`, `/affirm`, `change`) instead of a real value. |
| `missing_form_activation` | An `inform` with origin/destination arrived with no active loop, but the form was not started. |
| `failed_typo_confirmation` | A destination typo confirmation (`/affirm`) did not confirm the guess; the slot was polluted instead. |
| `unnormalised_origin` | An origin slot value is not a known city (e.g. `Madridd` not normalised to `Madrid`). |
| `edit_flow_error` | An edit payload's value (e.g. `change`) was written into the target slot. |
| `go_back_flow_error` | A `/go_back` payload was stored as a slot value. |
| `missing_buttons` | The bot asked a question (or fell back) without offering any buttons. |
| `unsupported_location` | The bot reported an unsupported destination. |
| `out_of_scope_recovery` | An out-of-scope message was handled (informational, usually correct). |

## 4. Fix case by case

For each open case in `tests/manual_debug_cases.md`:

1. Confirm the root cause from the analyser output.
2. Make the smallest targeted change in the affected file(s).
3. Re-train (`rasa train`) and restart the action server.
4. Re-run the manual case and re-capture the tracker.
5. Re-run the analyser; the category for that case should disappear.
6. Mark the case **fixed** in `tests/manual_debug_cases.md` and keep the
   before/after analyser output as evidence for the report.

> After any change to `domain.yml`, `data/*.yml`, `config.yml` you must re-train.
> After any change to `actions/*.py` you must restart the action server.
> After any change to `frontend/*` just reload the browser.
