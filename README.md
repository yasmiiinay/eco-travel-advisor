# Eco-Travel Advisor — Conversational Agent for Sustainable Tourism Planning

> Mock-first Rasa + NeonDB prototype with a connected v2 front end. Full README in progress.

## Carbon API integration (Climatiq) & limitations

The carbon estimate uses one external API — **Climatiq** — on a fallback cascade that keeps the
assistant working in every condition:

```
Climatiq API (live)  →  NeonDB stored factor  →  local JSON factor  →  unavailable
        climatiq               neondb                json_fallback        unavailable
```

- **Optional by design.** The prototype runs fully **without** `CLIMATIQ_API_KEY` — it simply uses
  the stored prototype emission factors. With a valid key it calls Climatiq and the carbon card shows
  `Source: Climatiq API`.
- **Configuration (environment variable only).** Set `CLIMATIQ_API_KEY` via the Colab **Secrets**
  panel, a `.env` file at the repo root, or the secure `getpass` prompt in the notebook
  (section 9b). The key is read from the environment only and is **never printed, logged or committed**.
- **Safety.** Bearer authentication; a short request timeout; any error, timeout, `429` rate-limit,
  invalid response, or missing factor degrades silently to the stored factor.
- **Provenance & disclaimer.** The user-facing disclaimer reflects the source:
  *“calculated using Climatiq API emission factors”* (live) vs *“estimated using stored prototype
  emission factors”* (fallback).
- **Known limitation (activity IDs).** Climatiq `activity_id`s can drift between data versions, so the
  code uses a best-guess id first and, if rejected, resolves a valid id at run time via the Climatiq
  **Search API** before falling back to the stored factor. Live values should still be sanity-checked
  against an authoritative source (e.g. DEFRA/ICAO) for the report. See
  `docs/api-integration-decision.md` for the full API evaluation; other APIs (weather, POIs, routing,
  hotels, offsets) are intentionally left as documented future work.

**Smoke test:** `python actions/carbon.py` (or notebook section 9b) — runs the same with or without a
key and prints `data_source` for each mode.

## Flight data API (Aviationstack)

A second, optional external API enriches the **flight** transport option with a real example flight
(flight number + airline) for the route. It is used in place of the Amadeus sandbox (which is being
decommissioned on 2026-07-17); Aviationstack does not offer hotel data, so the curated hotel dataset is
retained (see `docs/api-integration-decision.md`).

- **Optional by design.** Without `AVIATIONSTACK_API_KEY` the flight row simply omits the live-flight line.
- **Configuration:** set `AVIATIONSTACK_API_KEY` (Colab Secrets / `.env`). Read from the environment only,
  never printed or committed. Free plan: HTTP endpoint, `access_key` query param, ~500 requests/month
  (results are cached per route to stay within quota).
- **Safety:** short timeout; any error, timeout, `429`, missing IATA mapping, or empty result returns
  nothing and the card renders without the live line (graceful fallback).
- **Weighted ranking.** Transport options are ranked by a **weighted scoring function** that combines
  carbon impact and price, with the weights chosen by the user's sustainability preference
  (e.g. *lowest carbon* weights carbon 0.8 / price 0.2; *balanced* weights 0.5 / 0.5).

**Smoke test:** `python actions/aviation.py` — prints `None` (correct fallback) when no key is set.
