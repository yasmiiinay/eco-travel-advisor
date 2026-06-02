# Eco-Travel Advisor — Implementation Status Report

*Conversational Agent for Sustainable Tourism Planning (Rasa + NeonDB)*

This report records the state of the implementation at the data-and-fallback-layer checkpoint,
before the conversational (Rasa) layer is built.

## 1. Project structure created

The full repository skeleton exists as real files under a clean repo root (`eco-travel-advisor/`),
version-controlled on GitHub (public). It contains the Rasa project layout (`config.yml`,
`domain.yml`, `data/`, `actions/`, `frontend/`, `tests/`, `docs/`), the seed-data folder, the
Docker/requirements/README placeholders, and the portable `Eco_Travel_Advisor_Setup_and_Demo.ipynb`.
Secrets are protected (`.gitignore` excludes `.env`, `.venv/`, models).

## 2. Seed JSON mock data created

Nine validated seed files in `data/seed/` cover four destinations (Paris, Berlin, Amsterdam,
Copenhagen): `destination`, `hotel` (12), `experience` (12), `transport_option` (14),
`offset_option` (8), `emission_factor` (5), `tags` (12), plus `origin_city` (15) and
`transport_mode` (5) added to support distance-based routing. Cross-consistency is
machine-verified: all foreign keys resolve, every tag exists, every mode has an emission factor,
and `distance x factor` matches the stored emissions.

## 3. NeonDB/PostgreSQL schema created

`actions/db.py` defines 13 SQLAlchemy ORM tables mapping one-to-one to the seed files, plus two
association tables (`hotel_tag`, `experience_tag`) and two operational tables (`trip`,
`handover_log`). The module is import-safe (no connection on import), forces the `psycopg` v3
driver, applies a short connection timeout for Neon cold-starts, and uses ORM/bound parameters for
SQL-injection safety.

## 4. seed_db.py created and data loaded into NeonDB

`actions/seed_db.py` creates the schema and idempotently upserts every seed file, resolving tag
names into the join tables. It was run successfully against the live NeonDB instance — confirmed by
the re-run output showing **172 rows updated, 0 inserted**, which proves both that the data is
loaded and that re-running is safe (idempotent).

## 5. repository.py fallback layer completed

`actions/repository.py` is the single data-access layer for the actions, implementing the cascade
**NeonDB -> local JSON** with `data_source` labels (`"neondb"`, `"json_fallback"`, `"unavailable"`).
It exposes ten functions, includes typo-tolerant destination matching (`Pariiis -> Paris`), the
haversine distance engine (any of 15 origins -> 4 destinations), and computes per-mode emissions,
duration, price and colour band. Errors are caught without leaking connection details.

## 6. Smoke tests passed for NeonDB and JSON fallback

Verified: syntax compiles; every `db.*` reference resolves; typo tolerance correctly resolves
`Pariiis/Berln/Amsterdm/Copenhagn` and rejects garbage input. The notebook's section 9 cell
demonstrates the live cascade — the same query returns `source: neondb` with the database on, then
`source: json_fallback` with it forced off — proving graceful degradation.

## 7. What the current data layer can already support

Even with no Rasa or frontend yet, the backend can already: resolve a (possibly misspelled)
destination; list and rank eco-hotels, experiences and offsets by sustainability preference
(low-carbon, eco-certified, local-culture, budget); compute transport options for any supported
origin with emissions, colour bands, duration and price; surface the right emission-factor
disclaimer; and persist a trip session and a human-handover log to NeonDB. Crucially, all of this
keeps working if the database is unavailable.

## 8. What has not been implemented yet

Not started: **carbon.py** (live Climatiq integration — currently emissions come from
stored/curated factors via the `emissions_provider` hook that is wired but not yet supplied); the
**Rasa dialogue layer** entirely (`config.yml` pipeline, `domain.yml`, `nlu.yml`, forms,
`rules.yml`, `stories.yml`); **actions.py** (the custom actions that call this repository — carbon
estimation, recommendations, disclaimers, edit/back/reset, fallback, handover); the **responsive
frontend**; the **Aviationstack** stub; formal **testing** (`rasa test nlu`/`core`, user testing);
and **deployment** (Dockerfile, HuggingFace Spaces) and the **report** itself.

---

## How this supports the assignment requirements and grading criteria

The work so far front-loads the parts that most assignments get wrong — a resilient, real data
backbone — and does so in a way that generates concrete evidence.

The **mock-first NeonDB strategy with JSON fallback** directly satisfies the brief's
"API -> NeonDB -> JSON" resilience requirement and is unusually strong evidence for the *technical
implementation* and *robustness* marks: the system can be demonstrated surviving a database outage
live, which most submissions cannot show. The **distance engine and emission estimation** lay the
groundwork for the mandated *carbon footprint estimation*, and the curated, tag-driven dataset is
what will power the required *eco-hotel, transport, cultural-experience and offset recommendations*
with colour-coding and high-emission alerts. The **`trip` and `handover_log` tables** pre-build the
*human-advisor handover with full conversation context* requirement.

For the *academic and critical-analysis* marks, several deliberate design decisions are already
documented and defensible: separating `origin_city`/`transport_mode` as normalised lookup tables;
the honest `placeholder_warning` on every emission factor (keeping the work citation-safe and
demonstrating transparency about greenwashing risk); and the explicit prototype-vs-production
scoping. The **db.py data model and the architecture cascade** give ready material for the
*UML / system-architecture / data-model diagrams* the brief requires. The **GitHub repository and
portable Colab notebook** address *reproducibility* and the brief's deployment/reviewability
expectations — the lecturer can read the real code, run the notebook, or (after the deployment
step) open the live HuggingFace Space, giving three independent review paths.

In short, the data and reliability foundation is complete and evidenced; what remains is the
conversational layer (Rasa + carbon.py + actions.py), the UI, testing, deployment and the write-up.
