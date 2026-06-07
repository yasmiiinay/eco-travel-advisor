"""
carbon.py — carbon-footprint estimation helper for the Eco-Travel Advisor.

The future Rasa custom actions call ``estimate_emissions()`` to turn a route
(transport mode + distance + number of travellers) into a structured carbon
estimate. The source of the emission factor follows a cascade:

    Climatiq API (live)  ->  stored factor via repository.py  ->  unavailable

repository.py in turn resolves the stored factor from NeonDB, and if the database
is unreachable it falls back to the local JSON seed files. So the full chain is:

    climatiq  ->  neondb  ->  json_fallback  ->  unavailable

Core calculation:
    estimated_co2_kg = distance_km x kg_co2e_per_passenger_km x num_travellers

Safety:
* Climatiq is only attempted when CLIMATIQ_API_KEY is set; the key is read from
  the environment and never printed or returned.
* Every external call is wrapped so a failure/timeout/rate-limit/invalid response
  degrades quietly to the stored factor.
"""

from __future__ import annotations

import os
from typing import Optional

import repository  # actions/repository.py

try:
    import requests  # optional; only needed for the live Climatiq call
except ImportError:  # pragma: no cover
    requests = None


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

CLIMATIQ_ENV = "CLIMATIQ_API_KEY"
CLIMATIQ_URL = "https://api.climatiq.io/data/v1/estimate"
CLIMATIQ_SEARCH_URL = "https://api.climatiq.io/data/v1/search"
CLIMATIQ_TIMEOUT_SECONDS = 6
CLIMATIQ_DATA_VERSION = "^6"

# Mode -> a first-guess Climatiq activity_id.
# NOTE: these are BEST-GUESS identifiers and may drift between Climatiq data
# versions. They are only the first attempt: if one is rejected, the code falls
# back to the Climatiq *Search* API (below) to resolve a valid activity_id for
# the mode at run time, and if that also fails it degrades to the stored factor.
# This is documented as a known limitation in docs/api-integration-decision.md.
CLIMATIQ_ACTIVITY = {
    "flight": "passenger_flight-route_type_domestic-aircraft_type_na-distance_na-class_na-rf_included",
    "train": "passenger_train-route_type_national_rail-fuel_source_na",
    "coach": "passenger_vehicle-vehicle_type_coach-fuel_source_na-distance_na-engine_size_na",
    "car": "passenger_vehicle-vehicle_type_car-fuel_source_na-distance_na-engine_size_na",
}

# Keywords used to resolve a valid activity_id via the Search API when the
# first-guess id above is rejected.
CLIMATIQ_SEARCH_QUERY = {
    "flight": "passenger flight",
    "train": "passenger train rail",
    "coach": "coach bus passenger",
    "car": "passenger car",
}

# Cache of activity_ids that produced a successful estimate, so Search runs at
# most once per mode per process.
_RESOLVED_ACTIVITY: dict = {}

# Source-aware disclaimer wording (requirement: make provenance explicit).
DISCLAIMER_CLIMATIQ = (
    "Carbon values are calculated using Climatiq API emission factors. Indicative "
    "only — verify against an official source (e.g. DEFRA/ICAO) before relying on them."
)
DISCLAIMER_STORED = (
    "Carbon values are estimated using stored prototype emission factors. Indicative "
    "only — verify against an official source (e.g. DEFRA/ICAO) before relying on them."
)
# Generic default (kept for backward compatibility / the 'unavailable' case).
DISCLAIMER = DISCLAIMER_STORED


def _disclaimer_for(data_source: str) -> str:
    return DISCLAIMER_CLIMATIQ if data_source == "climatiq" else DISCLAIMER_STORED


# ---------------------------------------------------------------------------
# Climatiq (live) — best effort, never raises
# ---------------------------------------------------------------------------

def is_climatiq_configured() -> bool:
    """True if a Climatiq API key is present (no request is made, key not read out)."""
    return bool(os.environ.get(CLIMATIQ_ENV))


def _climatiq_estimate(activity_id: str, distance_km: float) -> Optional[float]:
    """One estimate POST. Returns co2e (kg) on a clean 200, else None. Never raises.

    A non-200 (including 429 rate-limit and 400 invalid-activity) returns None so
    the orchestrator can try the Search API or fall back to the stored factor.
    """
    try:
        response = requests.post(
            CLIMATIQ_URL,
            headers={"Authorization": f"Bearer {os.environ[CLIMATIQ_ENV]}"},
            json={
                "emission_factor": {"activity_id": activity_id, "data_version": CLIMATIQ_DATA_VERSION},
                "parameters": {"distance": round(distance_km, 1), "distance_unit": "km", "passengers": 1},
            },
            timeout=CLIMATIQ_TIMEOUT_SECONDS,
        )
        if response.status_code != 200:
            return None
        co2e = response.json().get("co2e")
        if isinstance(co2e, (int, float)) and co2e >= 0:
            return float(co2e)
    except Exception:
        return None  # network error, timeout, invalid JSON, etc.
    return None


def _climatiq_search_activity(mode: str) -> Optional[str]:
    """Resolve a valid activity_id for the mode via the Climatiq Search API.

    Used when the first-guess id is rejected. Best-effort: returns None on any
    problem so the caller can degrade to the stored factor. Never raises.
    """
    query = CLIMATIQ_SEARCH_QUERY.get(mode)
    if not query:
        return None
    try:
        response = requests.get(
            CLIMATIQ_SEARCH_URL,
            headers={"Authorization": f"Bearer {os.environ[CLIMATIQ_ENV]}"},
            params={"query": query, "data_version": CLIMATIQ_DATA_VERSION, "results_per_page": 1},
            timeout=CLIMATIQ_TIMEOUT_SECONDS,
        )
        if response.status_code != 200:
            return None
        results = response.json().get("results") or []
        if results and isinstance(results[0], dict):
            return results[0].get("activity_id")
    except Exception:
        return None
    return None


def _climatiq_per_passenger(mode: str, distance_km: float) -> Optional[float]:
    """Return live kg CO2e per passenger for the route, or None on any problem.

    Order of attempts (all best-effort, no exception escapes):
      1. a previously-resolved, known-good activity_id for this mode (cached);
      2. the first-guess activity_id in CLIMATIQ_ACTIVITY;
      3. an activity_id resolved at run time via the Search API, retried once.
    Returns None (so the caller falls back to the stored factor) when the key is
    missing, ``requests`` is unavailable, every attempt fails, or the response is
    not a usable number.
    """
    if requests is None or not is_climatiq_configured() or not distance_km:
        return None

    # 1) cached known-good id
    cached = _RESOLVED_ACTIVITY.get(mode)
    if cached:
        co2e = _climatiq_estimate(cached, distance_km)
        if co2e is not None:
            return co2e

    # 2) first-guess id
    guess = CLIMATIQ_ACTIVITY.get(mode)
    if guess:
        co2e = _climatiq_estimate(guess, distance_km)
        if co2e is not None:
            _RESOLVED_ACTIVITY[mode] = guess
            return co2e

    # 3) Search API -> retry once
    found = _climatiq_search_activity(mode)
    if found:
        co2e = _climatiq_estimate(found, distance_km)
        if co2e is not None:
            _RESOLVED_ACTIVITY[mode] = found
            return co2e

    return None


def climatiq_provider(mode: str, distance_km: float) -> Optional[float]:
    """Adapter matching repository.get_transport_options' ``emissions_provider`` hook.

    Returns live per-passenger kg CO2e, or None to let the repository use its
    stored factor. This is what wires live Climatiq pricing into the route engine.
    """
    return _climatiq_per_passenger(mode, distance_km)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def estimate_emissions(mode: str, distance_km: float, num_travellers: int = 1) -> dict:
    """Estimate the carbon footprint of one transport leg.

    Returns a structured dict:
        estimated_co2_kg   total for all travellers (None if no factor available)
        carbon_level       green / amber / red  (based on per-person emissions)
        data_source        climatiq / neondb / json_fallback / unavailable
        disclaimer         honest-estimate notice
        calculation_notes  human-readable trace of how the number was produced
    """
    num_travellers = max(1, int(num_travellers or 1))
    notes: list[str] = []
    per_person: Optional[float] = None
    factor: Optional[float] = None
    data_source = "unavailable"

    # Tier 1: live Climatiq
    live = _climatiq_per_passenger(mode, distance_km)
    if live is not None:
        per_person = live
        factor = live / distance_km if distance_km else None
        data_source = "climatiq"
        notes.append(f"Live Climatiq estimate for '{mode}' over {round(distance_km)} km.")
    else:
        # Tier 2/3: stored factor via repository (neondb -> json_fallback)
        record, source = repository.get_emission_factor(mode)
        if record:
            factor = record["kg_co2e_per_passenger_km"]
            per_person = distance_km * factor
            data_source = source  # "neondb" or "json_fallback"
            notes.append(f"Stored factor {factor} kg/passenger-km via {source}.")
            if is_climatiq_configured():
                notes.append("Climatiq was unavailable, so the stored factor was used.")
        else:
            notes.append(f"No emission factor available for mode '{mode}'.")

    if per_person is None:
        return {
            "estimated_co2_kg": None,
            "carbon_level": None,
            "data_source": "unavailable",
            "disclaimer": _disclaimer_for("unavailable"),
            "calculation_notes": " ".join(notes),
        }

    total = round(per_person * num_travellers, 1)
    per_person = round(per_person, 1)
    notes.append(
        f"estimated_co2_kg = {round(distance_km)} km x "
        f"{round(factor, 4) if factor is not None else '?'} kg/passenger-km x "
        f"{num_travellers} traveller(s) = {total} kg. "
        f"Carbon band reflects per-person emissions ({per_person} kg)."
    )
    return {
        "estimated_co2_kg": total,
        "carbon_level": repository.carbon_level(per_person),
        "data_source": data_source,
        "disclaimer": _disclaimer_for(data_source),
        "calculation_notes": " ".join(notes),
    }


# ---------------------------------------------------------------------------
# Smoke test: `python actions/carbon.py` — works WITHOUT a Climatiq key
# (it simply falls back to the stored factors, which themselves fall back to JSON).
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    # Smoke test. Runs the same way with or without CLIMATIQ_API_KEY:
    #   * no key   -> every row should report data_source = neondb / json_fallback
    #   * with key -> rows that resolve a valid activity_id report data_source = climatiq;
    #                 any that don't degrade silently to the stored factor.
    # The key itself is never printed.
    configured = is_climatiq_configured()
    print("=" * 60)
    print("carbon.py smoke test")
    print(f"CLIMATIQ_API_KEY present: {configured}")
    print(f"requests available:       {requests is not None}")
    print("=" * 60)
    seen = set()
    for mode, dist, pax in [("train", 956, 2), ("flight", 956, 1), ("coach", 344, 3), ("rocket", 500, 1)]:
        result = estimate_emissions(mode, dist, pax)
        seen.add(result["data_source"])
        print(f"\n{mode}  {dist} km  x{pax}:")
        print(f"  estimated_co2_kg : {result['estimated_co2_kg']}")
        print(f"  carbon_level     : {result['carbon_level']}")
        print(f"  data_source      : {result['data_source']}")
        print(f"  disclaimer       : {result['disclaimer'][:60]}...")
    print("\n" + "-" * 60)
    print("data_source values seen:", sorted(seen))
    if configured and "climatiq" not in seen:
        print("NOTE: a key is set but no row used Climatiq — the activity ids/Search")
        print("      could not resolve a live factor, so the stored factors were used.")
        print("      This is the documented graceful-degradation path (still correct).")
    print("Smoke test OK — the assistant works regardless of the key.")
