# Eco-Travel Advisor — API Integration Research & Decision

*Decision document. No code. Evaluates external APIs that could extend the assistant,
against the project's stability-first, fallback-first architecture.*

Last updated: 2026-06-06. Free-tier / auth details verified via the sources at the end
(prices and tiers change — re-verify before integrating).

## Guiding principles (constraints)

The project already has: NeonDB → JSON fallback, `repository.py`, `carbon.py` (with a
Climatiq → stored-factor → unavailable cascade), nine Rasa custom actions, and a connected
v2 front end. Any API we add must therefore:

1. **Have a fallback path** — if the API is missing a key, rate-limited, or down, the
   assistant must keep working (degrade to NeonDB/JSON/curated data). This is non-negotiable
   and is already the architecture's strength.
2. **Improve the assignment meaningfully** — strengthen the *sustainability* story, not just
   add surface area.
3. **Not destabilise the demo** — no API on the critical path; no OAuth dance that can block
   a live marking session; no provider that is being decommissioned.
4. **Be free / free-tier** and **citation-safe** — real, documented sources, not invented.

A useful lens: the assistant's *core value* is the **carbon estimate**. That is the one place
a real API materially raises credibility. Everything else (hotels, experiences, transit
schedules) is curated prototype content where a real API adds polish but also fragility.

---

## 1. Carbon calculation

### Climatiq  *(already the designed primary in `carbon.py`)*
- **Data:** emission factors + activity-based estimates (travel: flights, rail, road, hotels) via a documented REST API.
- **Free tier:** Free "Starter" plan, no credit card; access to core data sources with usage limits.
- **Auth:** API key as a Bearer token (header).
- **Complexity:** Low — `carbon.py` already has the provider slot and the cascade wired; only a verified activity ID + key are needed.
- **Reliability risk:** Low–medium (network / rate limits). Mitigated by the existing cascade.
- **Fallback:** Already built — Climatiq → NeonDB stored factor → local JSON → `unavailable`.
- **Decision:** **Implement now** (activate the existing stub). Highest thematic payoff, lowest marginal effort.
- **Grading:** Directly evidences *technical implementation* and *robustness* (live API + graceful degradation), and the *critical-analysis* point that a prototype's simplified factors can be upgraded to an authoritative source.

### Carbon Interface  *(backup / alternative)*
- **Data:** carbon estimates incl. a simple **flight** estimate from airport pair + passengers + cabin class.
- **Free tier:** Free plan for a low number of monthly requests.
- **Auth:** API key as Bearer token; `/auth` endpoint to test the key.
- **Complexity:** Low (single POST to `/estimates`).
- **Reliability risk:** Low–medium (request cap on free plan).
- **Fallback:** Same cascade as Climatiq.
- **Decision:** **Mock/optional** — keep as a one-line alternative provider in `carbon.py` to show provider-independence, but don't depend on it.
- **Grading:** Shows abstraction (swappable providers) — a *design quality* point.

---

## 2. Flight / aviation data

### Aviationstack
- **Data:** flight schedules, status, airline/airport metadata.
- **Free tier:** ~500 requests/month.
- **Auth:** API access key (query param).
- **Complexity:** Low, but the data (live schedules/status) is **not** what a carbon-planner needs.
- **Reliability risk:** Medium (tiny free cap; HTTPS restricted on free plan historically).
- **Fallback:** Curated transport rows (already in seed data).
- **Decision:** **IMPLEMENTED** (`actions/aviation.py`) as the assignment's external *flight data* API,
  in place of the decommissioning Amadeus sandbox. It enriches the flight row with a real example
  flight (number + airline); env key only, timeout, per-route cache, and a None-returning fallback so
  the card renders normally without a key. Hotels remain curated (Aviationstack has no hotel data).

### OpenSky Network
- **Data:** live aircraft positions / tracks (research, non-commercial).
- **Free tier:** Free for non-commercial use.
- **Auth:** **OAuth2 client-credentials** (client_id/secret → 30-min token). More setup; token can expire mid-demo.
- **Complexity:** Medium (OAuth2).
- **Reliability risk:** Medium; live-position data is irrelevant to trip planning.
- **Fallback:** Curated transport rows.
- **Decision:** **Future work** (interesting but off-theme).

> Verdict for the category: aviation APIs answer "where is this plane now," not "how green is
> this trip." The carbon APIs (§1) already cover the flight-emissions angle. **Not now.**

---

## 3. Public transport / route data

### OpenRouteService (ORS)
- **Data:** real routing + **distance/duration** for car, cycling, walking/hiking (OpenStreetMap-based); isochrones, matrix.
- **Free tier:** Free personal API token.
- **Auth:** API key (header).
- **Complexity:** Medium — could replace the haversine great-circle distance with road/rail-ish distances for more realistic emissions.
- **Reliability risk:** Medium (rate limits; 6,000 km cap per route — fine for European cities).
- **Fallback:** The existing **haversine engine** in `repository.py` (already the default).
- **Decision:** **IMPLEMENTED** (`actions/routing.py`) — the carbon estimate uses ORS road-routed
  distance for ground modes (fed to Climatiq), with a clean fallback to the stored haversine distance.
- **Grading:** *Design depth* — distinguishing straight-line vs routed distance is a good critical-analysis paragraph.

### Transit schedules (Transitland / Navitia / Google Directions transit)
- **Data:** real public-transport timetables.
- **Free tier:** varies (Navitia free dev key; Transitland free; Google requires billing).
- **Auth:** API key (Google = billing account).
- **Complexity:** High (GTFS concepts, coverage gaps between cities).
- **Reliability risk:** High (coverage/consistency across 12 cities).
- **Fallback:** Curated transport modes.
- **Decision:** **Future work** — high effort, fragile, off the critical sustainability message.

---

## 4. Eco-hotel data

### Amadeus for Developers (Self-Service Hotel Search)
- **Data:** search/compare 150,000+ hotels.
- **Free tier:** Free **test** environment (simulated data, limited).
- **Auth:** OAuth2 (API key+secret → 30-min token).
- **Complexity:** Medium–high (OAuth2 + response mapping).
- **Reliability risk:** **High / disqualifying — the Self-Service portal is being decommissioned on 17 July 2026.** Building on it now is unsafe.
- **Fallback:** Curated `hotel.json` (36 eco-hotels).
- **Decision:** **Future work / do not build on now** (provider sunset).

> There is **no widely-available free API for *eco-certified* hotels** specifically (Green Key /
> Green Globe data isn't offered as an open developer API). Generic hotel APIs (Amadeus,
> Booking, Google Places) don't expose a reliable eco-certification field. This is exactly why
> the curated `hotel.json` (with `eco_certification` + `sustainability_score`) is the right
> prototype choice — and a good *limitations* point for the report.
- **Decision (category):** **Keep curated data; list a real eco-hotel API as future work** (and note none is freely available today).

---

## 5. Cultural / local experiences

### OpenTripMap
- **Data:** 10M+ tourist POIs (attractions, culture, nature) from OpenStreetMap / Wikidata / Wikipedia.
- **Free tier:** Free API key (non-commercial), generous.
- **Auth:** API key (query param).
- **Complexity:** Medium (radius/bbox queries + category filtering to keep it "low-impact").
- **Reliability risk:** Low–medium.
- **Fallback:** Curated `experience.json` (24 experiences).
- **Decision:** **Nice to have** — could enrich the experience cards with real, local POIs near the destination, filtered to low-impact categories; clean fallback to curated data.
- **Grading:** *Feature depth* + a tidy *integration + fallback* demonstration.

*Alternatives:* Foursquare Places (100k calls/mo free), Geoapify, LocationIQ — all viable, but
OpenTripMap fits the "sightseeing/cultural" framing best and is simplest. Listed as alternatives.

---

## 6. Carbon offset data

### Cloverly
- **Data:** offset pricing + (real) offset purchasing via an API-first marketplace.
- **Free tier:** Free **sandbox** API keys for development.
- **Auth:** API key.
- **Complexity:** Medium (and *purchasing* is out of scope for a planning prototype).
- **Reliability risk:** Medium; transactional offset purchase is beyond a non-commercial demo.
- **Fallback:** Curated `offset_option.json` (24 options).
- **Decision:** **Mock / future work** — the sandbox could *price* an offset for realism, but actually buying offsets is out of scope. Keep curated offsets; optionally show one live sandbox price as a stretch.
- **Grading:** Honest scoping (planning vs transacting) is a good *ethics/limitations* point.

*Alternatives:* Patch (enterprise procurement — too heavy), GoClimate (free tier unclear). Future work.

---

## 7. Weather / climate context

### Open-Meteo
- **Data:** forecast + historical weather; seasonal/climate context for a destination.
- **Free tier:** **No API key, no signup**, free for non-commercial use (≈10,000 calls/day).
- **Auth:** **None** — the lowest-friction option available.
- **Complexity:** Low (single GET with lat/lon, which we already store per city).
- **Reliability risk:** Low; and trivially skippable.
- **Fallback:** Simply omit the weather line (it's contextual, not core) — the cleanest possible fallback.
- **Decision:** **Nice to have** — a genuinely easy, no-auth real API: add a "best time to travel / seasonal" or "pack for ~X°C" line using the city coordinates we already have. Zero destabilisation risk.
- **Grading:** A clean, low-risk example of *real API integration with graceful degradation* — easy marks for *technical implementation* without endangering the demo.

*Alternative:* OpenWeatherMap (free 1M calls/mo but needs a key) — Open-Meteo is preferable here precisely because it needs no key.

---

## Recommendation summary

### ✅ Must implement now
- **Climatiq (carbon).** Activate the existing `carbon.py` stub. It is on-theme, already
  architected with a fallback, and is the single API that most raises the credibility of the
  core deliverable. *This is the one to do.*

### 🟡 Nice to have (if time remains, all with clean fallbacks)
- **Open-Meteo (weather/climate context)** — no key, near-zero risk; quickest real-API win.
- **OpenTripMap (cultural experiences)** — enrich experience cards from real POIs, fallback to curated JSON.
- **OpenRouteService (routed distances)** — upgrade haversine → routed distance for more realistic emissions, fallback to haversine.
- *(Carbon Interface as a swappable secondary carbon provider — tiny effort, shows abstraction.)*

### 🔭 Future enhancement only (mock / list in the report)
- **Aviation** (Aviationstack / OpenSky) — off-theme for carbon planning.
- **Transit schedules** (Transitland / Navitia / Google) — high effort, fragile coverage.
- **Hotels** (Amadeus) — **provider being decommissioned 17 Jul 2026**; and no free *eco-certification* API exists → keep curated `hotel.json`.
- **Offset purchasing** (Cloverly / Patch) — out of scope for a planning prototype; keep curated offsets (optionally one sandbox price as a stretch).

### One-line rationale for the report
> "We integrate one authoritative carbon API (Climatiq) on the project's existing
> fallback cascade, and keep curated, citation-safe data for hotels, experiences and offsets —
> because the sustainability message lives in the carbon estimate, and because no free,
> reliable API exists for *eco-certified* accommodation. Weather (Open-Meteo, no key) and POIs
> (OpenTripMap) are low-risk enrichments, each with a graceful fallback."

---

## How this maps to the grading criteria

- **Technical implementation / robustness:** one live API (Climatiq) demonstrated *with* its
  fallback cascade — show it surviving a forced outage. Optional Open-Meteo/OpenTripMap add
  breadth without risk.
- **Critical analysis (Level 7):** the honest scoping (planning vs transacting offsets;
  simplified vs routed distance; no eco-hotel API exists; a major hotel provider sunsetting)
  is exactly the kind of evaluation that earns marks, and is all defensible and sourced.
- **Design quality:** provider-independent carbon layer (Climatiq ↔ Carbon Interface) and a
  consistent "real API → stored data → curated JSON" pattern across every integration.

---

## Sources (verified June 2026)

- Climatiq — pricing/free plan & authentication: https://www.climatiq.io/pricing , https://www.climatiq.io/docs/api-reference/authentication
- Carbon Interface — flights & API docs: https://www.carboninterface.com/flights , https://docs.carboninterface.com/
- Aviationstack & OpenSky comparison (free tier / OAuth2): https://geekflare.com/dev/flight-data-api/ , https://opensky-network.org/data/api
- OpenRouteService — free key, profiles, restrictions: https://openrouteservice.org/ , https://openrouteservice.org/restrictions/
- OpenTripMap — free tier / POI data: https://dev.opentripmap.org/product ; POI API alternatives: https://dev.to/geoapify-maps-api/google-places-api-alternatives-which-poi-api-should-you-use-in-2026-hd4
- Cloverly — sandbox / API: https://cloverly.com/api
- Open-Meteo (no key) vs OpenWeatherMap free tier: https://open-meteo.com/ , https://apiscout.dev/guides/openweathermap-free-tier-limits-2026
- Amadeus Self-Service (free test, OAuth2) **and decommission date (17 Jul 2026)**: https://developers.amadeus.com/self-service , https://developers.amadeus.com/self-service/category/hotels
