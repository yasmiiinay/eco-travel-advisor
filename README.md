---
title: Eco-Travel Advisor
emoji: 🌿
colorFrom: green
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
---

# Eco-Travel Advisor — Conversational Agent for Sustainable Tourism Planning

A Rasa Open Source assistant that plans low-carbon trips: it runs an adaptive multi-turn
dialogue to collect the destination, dates, budget, origin and sustainability preferences,
then recommends eco-friendly hotels, transport, cultural experiences and carbon offsets,
estimates the trip's carbon footprint, and hands over to a human advisor with full context.

> The YAML block at the very top of this file is the **Hugging Face Spaces** card metadata
> (`sdk: docker`, `app_port: 7860`). It is ignored by GitHub but tells the Space how to run
> the image. One README serves both.

## Architecture at a glance

- **Frontend** (`frontend/`) — a responsive vanilla-JS UI on the Rasa REST channel: quick-reply
  buttons, colour-coded result cards, a high-emission alert, a live trip summary, trip history
  and an advisor-handover indicator.
- **Rasa NLU + Core** — DIETClassifier pipeline; rules, stories and a slot-filling form for the
  multi-turn flow; a two-stage fallback (clarify → escalate to a human).
- **Custom action server** (`actions/`) — carbon estimation, transport ranking via a weighted
  scoring function, hotel/experience/offset retrieval, and handover packaging.
- **Knowledge base** — NeonDB (serverless PostgreSQL) with a graceful fallback to local JSON
  seed data.
- **External APIs** (all optional, all with fallbacks) — Climatiq, Aviationstack, OpenCage,
  OpenRouteService.

## Quick start (local, without Docker)

Rasa 3.6.x requires **Python 3.10**.

```bash
python3.10 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # optional: add your keys
rasa train
rasa run actions --port 5055 &  # terminal 1: custom actions
rasa run --enable-api --cors "*" --port 5005   # terminal 2: REST API
# then open frontend/index.html in a browser
```

The notebook `Eco_Travel_Advisor_Setup_and_Demo.ipynb` reproduces the full setup, training,
testing and REST demo end to end (Google Colab or local Jupyter).

## Deployment (Docker + Hugging Face Spaces)

The whole stack ships as **one Docker image** (nginx + Rasa server + action server behind port
7860). Run it locally with `docker compose up --build` (then open <http://localhost:7860>), or
deploy it free on Hugging Face Spaces. Because the UI and API share one origin, no CORS setup or
public tunnel is needed in production.

**Full step-by-step — including the Hugging Face Spaces deploy and the secrets list — is in
[`docs/deployment.md`](docs/deployment.md).**

Live demo: `https://<your-username>-eco-travel-advisor.hf.space`
Source: `https://github.com/<your-username>/eco-travel-advisor`

## Carbon API integration (Climatiq) & limitations

The carbon estimate uses one external API — **Climatiq** — on a fallback cascade that keeps the
assistant working in every condition:

```
Climatiq API (live)  →  NeonDB stored factor  →  local JSON factor  →  unavailable
        climatiq               neondb                json_fallback        unavailable
```

- **Optional by design.** The prototype runs fully **without** `CLIMATIQ_API_KEY` — it simply uses
  the stored prototype emission factors. With a valid key it calls Climatiq and the carbon card shows
  the live source.
- **Configuration (environment variable only).** Set `CLIMATIQ_API_KEY` via the Colab **Secrets**
  panel, a `.env` file at the repo root, or a Hugging Face Space secret. The key is read from the
  environment only and is **never printed, logged or committed**.
- **Safety.** Bearer authentication; a short request timeout; any error, timeout, `429` rate-limit,
  invalid response, or missing factor degrades silently to the stored factor.
- **Provenance & disclaimer.** The user-facing disclaimer reflects the source: live Climatiq factors
  vs stored prototype factors.
- **Known limitation (activity IDs).** Climatiq `activity_id`s can drift between data versions, so the
  code uses a best-guess id first and, if rejected, resolves a valid id at run time via the Climatiq
  **Search API** before falling back to the stored factor. Live values should still be sanity-checked
  against an authoritative source (e.g. DEFRA/ICAO) for the report. See
  `docs/api-integration-decision.md` for the full API evaluation.

**Smoke test:** `python actions/carbon.py` (or notebook section 10) — runs the same with or without a
key and prints `data_source` for each mode.

## Flight data API (Aviationstack)

A second, optional external API enriches the **flight** transport option with a real example flight
(flight number + airline) for the route. It is used in place of the Amadeus sandbox (which is being
decommissioned on 2026-07-17); Aviationstack does not offer hotel data, so the curated hotel dataset is
retained (see `docs/api-integration-decision.md`).

- **Optional by design.** Without `AVIATIONSTACK_API_KEY` the flight row simply omits the live-flight line.
- **Configuration:** set `AVIATIONSTACK_API_KEY` (Colab Secrets / `.env` / HF secret). Read from the
  environment only, never printed or committed. Free plan: HTTP endpoint, `access_key` query param,
  ~500 requests/month (results are cached per route to stay within quota).
- **Safety:** short timeout; any error, timeout, `429`, missing IATA mapping, or empty result returns
  nothing and the card renders without the live line (graceful fallback).
- **Weighted ranking.** Transport options are ranked by a **weighted scoring function** that combines
  carbon impact and price, with the weights chosen by the user's sustainability preference
  (e.g. *lowest carbon* weights carbon 0.8 / price 0.2; *balanced* weights 0.5 / 0.5).

**Smoke test:** `python actions/aviation.py` — prints `None` (correct fallback) when no key is set.

## Location & routing (OpenCage GPS + OpenRouteService)

Two further optional APIs cover the brief's location/routing requirement, both with fallbacks:

- **GPS / OpenCage (`actions/geo.py`).** The origin step offers **"📍 Use my location"**: the browser
  shares coordinates, and the backend maps them to the **nearest supported city** (great-circle over
  the seed data — always works, no key needed) and uses OpenCage (`OPENCAGE_API_KEY`) only to add a
  friendly "near Frankfurt" label. The coordinates are sent as `geo:LAT,LON` and resolved in
  `validate_origin`.
- **OpenRouteService (`actions/routing.py`).** For ground transport the carbon estimate uses a real
  **road-routed distance** (`OPENROUTESERVICE_API_KEY`) instead of the great-circle distance, then feeds
  it to Climatiq; the carbon card shows `… km (road-routed (OpenRouteService))`. Flights keep the
  great-circle distance. Any failure falls back to the stored haversine distance.

Both keys are optional (env-only, never printed). Smoke tests: `python actions/geo.py`,
`python actions/routing.py` (print the nearest-city / `None` fallback without keys).
