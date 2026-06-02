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
CLIMATIQ_TIMEOUT_SECONDS = 6
CLIMATIQ_DATA_VERSION = "^6"

# Mode -> Climatiq activity_id.
# NOTE: these are PLACEHOLDER identifiers. Verify each one in the Climatiq Data
# Explorer (https://www.climatiq.io/data) and confirm the returned factor matches
# the transport mode before relying on live values in the report.
CLIMATIQ_ACTIVITY = {
    "flight": "passenger_flight-route_type_domestic-aircraft_type_na-distance_na-class_na-rf_included",
    "train": "passenger_train-route_type_national_rail-fuel_source_na",
    "coach": "passenger_vehicle-vehicle_type_coach-fuel_source_na-distance_na-engine_size_na",
    "car": "passenger_vehicle-vehicle_type_car-fuel_source_na-distance_na-engine_size_na",
}

DISCLAIMER = (
    "Carbon values are estimates based on average emission factors and curated "
    "prototype data; verify against an official source (e.g. DEFRA/ICAO) before "
    "relying on them."
)


# ---------------------------------------------------------------------------
# Climatiq (live) — best effort, never raises
# ---------------------------------------------------------------------------

def is_climatiq_configured() -> bool:
    """True if a Climatiq API key is present (no request is made, key not read out)."""
    return bool(os.environ.get(CLIMATIQ_ENV))


def _climatiq_per_passenger(mode: str, distance_km: float) -> Optional[float]:
    """Return live kg CO2e per passenger for the route, or None on any problem.

    Returns None (so the caller falls back) when: the key is missing, requests is
    not installed, the mode has no mapping, the API errors/rate-limits/times out,
    or the response is not a usable number. No exception escapes this function.
    """
    if requests is None or not is_climatiq_configured():
        return None
    activity = CLIMATIQ_ACTIVITY.get(mode)
    if not activity or not distance_km:
        return None
    try:
        response = requests.post(
            CLIMATIQ_URL,
            headers={"Authorization": f"Bearer {os.environ[CLIMATIQ_ENV]}"},
            json={
                "emission_factor": {"activity_id": activity, "data_version": CLIMATIQ_DATA_VERSION},
                "parameters": {"distance": round(distance_km, 1), "distance_unit": "km", "passengers": 1},
            },
            timeout=CLIMATIQ_TIMEOUT_SECONDS,
        )
        if response.status_code != 200:
            return None  # includes 429 rate-limit and 4xx/5xx
        co2e = response.json().get("co2e")
        if isinstance(co2e, (int, float)) and co2e >= 0:
            return float(co2e)
    except Exception:
        return None  # network error, timeout, invalid JSON, etc.
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
            "disclaimer": DISCLAIMER,
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
        "disclaimer": DISCLAIMER,
        "calculation_notes": " ".join(notes),
    }


# ---------------------------------------------------------------------------
# Smoke test: `python actions/carbon.py` — works WITHOUT a Climatiq key
# (it simply falls back to the stored factors, which themselves fall back to JSON).
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print("Climatiq configured:", is_climatiq_configured())
    for mode, dist, pax in [("train", 956, 2), ("flight", 956, 1), ("coach", 344, 3), ("rocket", 500, 1)]:
        result = estimate_emissions(mode, dist, pax)
        print(f"\n{mode}  {dist} km  x{pax} traveller(s):")
        for key, value in result.items():
            print(f"  {key}: {value}")
