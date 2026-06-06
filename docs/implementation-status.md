# Eco-Travel Advisor — Implementation Status

*Conversational Agent for Sustainable Tourism Planning (Rasa Open Source + NeonDB)*

Living progress record. Last updated: 2026-06-06. It reflects the full Rasa stack, the unified
12-city dataset, the connected **v2 front end**, and the UX + logic stabilisation sprints.

---

## ✅ Completed

### 1. Repository & data scaffold
Clean repo (`eco-travel-advisor/`) on GitHub with the Rasa layout (`config.yml`, `domain.yml`,
`data/`, `actions/`, `frontend/`, `tests/`, `docs/`), seed data, and the portable
`Eco_Travel_Advisor_Setup_and_Demo.ipynb`. Secrets are git-ignored (`.env`, `.venv/`, models).

### 2. Seed data — unified 12-city set
All origins **and** destinations are the same 12 popular European cities (Paris, Berlin, Amsterdam,
Copenhagen, London, Madrid, Rome, Barcelona, Vienna, Munich, Lisbon, Prague). Current counts:
**12 destinations · 12 origins · 36 hotels · 24 experiences · 24 offsets · 522 transport rows**
(every origin→destination pair × flight/train/coach/car). Machine-validated: FKs resolve, tags/modes
exist, `distance × factor` matches stored emissions, origins == destinations.

### 3. NeonDB schema + idempotent seeding
`actions/db.py` (13 ORM tables + association/operational tables), `psycopg2` driver, NullPool for
Neon's serverless connections, ORM/bound params for injection safety. `actions/seed_db.py` loads
idempotently. Stale origin rows from the pre-unification dataset were cleaned in NeonDB.

### 4. Data-access + fallback (`repository.py`) — *unchanged, architecture preserved*
Cascade **NeonDB → local JSON** with `data_source` labels; fuzzy origin/destination resolution
(`madridd → Madrid`), haversine distance, per-mode emissions/duration/price/colour band.

### 5. Carbon estimation (`carbon.py`) — *unchanged*
`estimate_emissions(...)` cascade **Climatiq → stored factor → unavailable** (Climatiq intentionally
left unconfigured; stored-factor path in use). No secrets read/printed.

### 6. Rasa dialogue layer (NLU + Core)
Pipeline: DIET, Regex/LexicalSyntactic featurizers, char n-grams, EntitySynonymMapper,
FallbackClassifier; policies Memoization + Rule + TED. `domain.yml`: intents, entities (+`field_to_edit`),
`trip_planning_form`, data slots (+`budget_amount`), button responses, custom actions. NLU expanded
for greetings, start commands, numeric budgets, city text, corrections.

### 7. Custom actions (`actions.py`) — with card payload-shaping
`validate_trip_planning_form` (+robust slot-specific validation), `action_estimate_carbon`,
`action_recommend_plan`, `action_high_emission_alert`, `action_go_back`, `action_edit_answer`,
`action_reset_trip`, `action_handover`, `action_scoped_fallback`. Result actions now emit typed
`json_message` **custom payloads** (`carbon_estimate`, `transport_comparison`, `card_group`, `alert`,
`handover`) each with a `fallback_text` — so the UI renders cards and degrades gracefully.

### 8. Connected v2 front end (Rasa REST) — `frontend/`
Modern travel-tech shell wired to the live REST channel (`/webhooks/rest/webhook`):
- **Button-first happy path**, free text secondary; 12-city selector with flags + "More cities".
- **Rich card rendering**: transport comparison (pills + inline "≈ N× the train" note), eco-hotels,
  experiences, offsets, carbon-estimate card, high-emission alert. Status = icon + text + colour.
- **Live Trip Summary** driven by the **tracker API** (`GET /conversations/{id}/tracker` → `slots`),
  with local fallback; per-field edit pencils; `x/6` progress.
- **Date-range picker** (start/end/flexible → "Flexible dates"), **numeric budget** ("€65/day · Budget").
- **Human-advisor mode**: context-transfer card, simulated advisor, Return-to-assistant (only in
  advisor mode), conversation preserved.
- **Thinking indicator** + input lock while waiting + retry on failure; de-duped prompts/buttons;
  guarded reset; mobile-first; accessible (focus, aria-live, greyscale-safe, `[hidden]` correct).

### 9. Testing & debugging
Held-out NLU test set + held-out Core stories + 5-fold cross-validation (intent F1 ~0.67→0.80 across
two NLU rounds). Structured conversation-log analyser. **DC-01…DC-09 catalogue fixed and verified**
(automated `rasa test core` + clean REST run). Two UX/logic stabilisation sprints logged with
manual cases **S-01…S-15** in `tests/manual_debug_cases.md`.

---

## 🔧 In progress / awaiting verification

- **Latest stabilisation sprint** (date-numeric reject, calmer high-emission, single disclaimer,
  thinking UX, return-button fix) — code complete + statically validated; **awaiting your retrain +
  S-01…S-15 manual pass** on the connected demo.

---

## ⬜ Remaining (against the assignment brief)

1. **Diagrams** — architecture, conversation flow, UML/sequence, ER. (`docs/diagrams/` is empty.)
2. **User testing** — small task-based session with real users + write-up (third testing layer).
3. **Deployment** — finish `Dockerfile` / `docker-compose.yml` and a HuggingFace Spaces deployment
   (single-port, same-origin so the UI auto-resolves the REST URL — also removes ngrok friction).
4. **README** — local + Colab/HF run instructions and the submission links.
5. **Academic report** — 2500–3000 words, Harvard referencing, critical analysis (the main graded
   deliverable). Material is ready to draw on: design rationale, gap analysis, WCAG/Nielsen framing,
   testing evidence, limitations (simplified carbon factors, prototype scope).
6. *(Optional)* live Climatiq activity IDs — currently a documented stub; not required.

---

## Brief coverage at a glance

| Brief requirement | Status |
|---|---|
| Rasa NLU + Core | ✅ |
| Adaptive multi-turn dialogue (form) | ✅ |
| Collect destination/dates/budget/origin/sustainability | ✅ |
| Eco hotel / transport / experience / offset recommendations | ✅ |
| Carbon footprint estimation | ✅ |
| Custom actions in `actions.py` | ✅ |
| Fallback + clarification | ✅ |
| Human handover with full context | ✅ |
| Prototype screens (quick replies, colour-coded, high-emission, handover) | ✅ (connected v2 UI) |
| Testing: NLU + dialogue | ✅ |
| Testing: user testing | ⬜ |
| Deployment: Docker + HuggingFace | ⬜ |
| 2500–3000 word Harvard report | ⬜ |

**In short:** the conversational agent is built, trained, connected to a modern UI, and stabilised.
What remains is user testing, diagrams, deployment, the README, and the academic report.
