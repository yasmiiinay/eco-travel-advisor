# Eco-Travel Advisor — Implementation Status Report

*Conversational Agent for Sustainable Tourism Planning (Rasa + NeonDB)*

This report records the state of the implementation now that the full Rasa conversational layer
has been built, trained and tested. It supersedes the earlier data-layer checkpoint.

## Completed

### 1. Project structure
The full repository skeleton exists as real files under a clean repo root (`eco-travel-advisor/`),
version-controlled on GitHub (public). It holds the Rasa project layout (`config.yml`,
`domain.yml`, `data/`, `actions/`, `frontend/`, `tests/`, `docs/`), the seed-data folder, the
Docker/README placeholders, and the portable `Eco_Travel_Advisor_Setup_and_Demo.ipynb`. Secrets are
protected (`.gitignore` excludes `.env`, `.venv/`, models).

### 2. Seed mock data
Ten validated seed files in `data/seed/` cover four destinations (Paris, Berlin, Amsterdam,
Copenhagen): `destination`, `hotel` (12), `experience` (12), `transport_option` (**222** computed
routes across 15 origins), `offset_option` (8), `emission_factor` (5), `tags` (12), `origin_city`
(15) and `transport_mode` (5). Cross-consistency is machine-verified: all foreign keys resolve,
every tag exists, every mode has an emission factor, and `distance x factor` matches the stored
emissions.

### 3. NeonDB/PostgreSQL schema + seeding
`actions/db.py` defines 13 SQLAlchemy ORM tables (one-to-one with the seed files) plus the
`hotel_tag` / `experience_tag` association tables and the operational `trip` / `handover_log`
tables. It is import-safe, uses the `psycopg2` driver and NullPool (suited to Neon's serverless
connections), and uses ORM/bound parameters for SQL-injection safety. `actions/seed_db.py`
idempotently loads every seed file into NeonDB (confirmed by a re-run reporting rows updated,
0 inserted).

### 4. Data-access and fallback layer (`repository.py`)
The single data-access layer implements the cascade **NeonDB -> local JSON** with `data_source`
labels (`neondb` / `json_fallback` / `unavailable`). It exposes the ten functions the actions use,
includes typo-tolerant destination matching (`Pariiis -> Paris`), the haversine distance engine
(any of 15 origins -> 4 destinations), and computes per-mode emissions, duration, price and colour
band. The notebook demonstrates the live cascade (same query returns `neondb`, then
`json_fallback` when the database is forced off).

### 5. Carbon estimation (`carbon.py`)
`estimate_emissions(mode, distance_km, num_travellers)` applies the cascade **Climatiq ->
repository stored factor (neondb -> json) -> unavailable** and returns a structured result
(`estimated_co2_kg`, `carbon_level`, `data_source`, `disclaimer`, `calculation_notes`). Climatiq is
only attempted when a key is present; failures degrade quietly to the stored factors. No secrets
are read or printed. (Climatiq is intentionally left unconfigured for now, so the stored-factor
path is in use.)

### 6. Standalone UX/UI preview (`frontend/`)
A browser-only preview (`index.html` / `styles.css` / `app.js`) shows the full user journey:
button-driven no-type happy path, free-text alternative, typo "Did you mean Paris?", green/amber/red
hotel and transport cards, carbon estimate with disclaimer, high-emission alert, human-handover
state, and edit/back/reset controls. It is mobile-responsive and accessible (colour always paired
with text), and reproduces the same route maths as `repository.py`.

### 7. Rasa dialogue layer (config + domain + NLU + rules + stories)
A CPU-friendly pipeline (`config.yml`) with DIETClassifier, Regex/LexicalSyntactic featurizers,
character n-grams for typo robustness, EntitySynonymMapper and a FallbackClassifier, plus
MemoizationPolicy + RulePolicy + TEDPolicy. `domain.yml` declares 13 intents, 6 entities, the form
and data slots, button responses and 9 custom actions. `data/nlu.yml` has 161 examples with typos,
traveller phrases, lookups and synonyms. `data/rules.yml` (13 rules) and `data/stories.yml`
(1 happy path + 10 edge cases) drive the conversation.

### 8. Custom actions (`actions.py`)
All nine actions are implemented against `repository.py` and `carbon.py`:
`validate_trip_planning_form`, `action_clarify_destination`, `action_estimate_carbon`,
`action_recommend_plan`, `action_high_emission_alert`, `action_go_back`, `action_edit_answer`,
`action_reset_trip`, `action_handover`. They handle typo clarification, natural traveller phrases,
ambiguous input, edit/back/reset, the high-emission alternative, and a human handover that packages
the full trip context into `handover_log`.

### 9. Training and testing
The assistant trains successfully (rule/story contradictions resolved). `rasa test` results stored
in `results/`: intent classification predicted every one of the 161 examples correctly, dialogue
testing scored 11/11 stories (100%), and entity extraction was fully correct. These are in-sample
results (evaluated on the training data), so they are an optimistic upper bound rather than a
held-out generalisation estimate.

## Not yet done

- **Cross-validation / user testing** — for a held-out NLU figure (`rasa test nlu --cross-validation`)
  and small-group user testing, both stronger evidence for the report.
- **UI <-> Rasa REST integration** — the frontend currently runs on its own sample data; wiring it to
  the live Rasa REST channel is a later step.
- **Live Climatiq + Aviationstack** — Climatiq activity IDs need verifying; Aviationstack is a
  documented future stub.
- **Deployment** — Dockerfile and HuggingFace Spaces.
- **README** — local + Colab setup instructions and the three submission links.
- **The academic report** itself, plus the UML / architecture / conversation-flow diagrams.

## How this supports the assignment requirements and grading criteria

The build now covers the brief's core technical requirements end to end: Rasa NLU + Core, custom
actions, adaptive multi-turn dialogue with a slot-filling form, collection of destination, dates,
budget, origin and sustainability preferences, eco-hotel / transport / experience / offset
recommendations, carbon-footprint estimation, fallback and clarification, and human handover with
full context. The **mock-first NeonDB strategy with JSON fallback** is strong evidence for the
*technical implementation* and *robustness* marks — the system can be shown surviving a database
outage live. The trained model plus the `results/` reports give concrete material for the *testing
and evaluation* section, and the honest in-sample caveat (with cross-validation as the next step)
demonstrates the *critical analysis* expected at Level 7.

Several deliberate, defensible design decisions support the *academic* marks: separating
`origin_city` / `transport_mode` as normalised lookup tables; the honest `placeholder_warning` on
every emission factor (citation-safe, and transparent about greenwashing risk); the explicit
prototype-vs-production scoping; and the three independent review paths (read the GitHub code, run
the Colab notebook, or - after deployment - open the live HuggingFace Space).

In short, the conversational agent is built, trained and tested; what remains is stronger testing,
the UI/Rasa wiring, deployment, and the write-up.
