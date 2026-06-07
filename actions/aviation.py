"""
aviation.py — optional live flight metadata via the Aviationstack API.

Enriches the *flight* transport option with a real example flight (flight number +
airline) for the route. Best-effort and **never raises**: if the key is absent, a
city has no IATA mapping, or the API errors / rate-limits / times out, it returns
``None`` and the assistant simply omits the live-flight line (graceful fallback).

This is the assignment's external "flight data" integration. Aviationstack is used
in place of the Amadeus sandbox (which is being decommissioned on 2026-07-17); see
docs/api-integration-decision.md. Aviationstack hotel data does not exist, so the
curated hotel dataset is retained.

Safety / cost:
* Free plan uses the HTTP endpoint, an ``access_key`` query parameter and ~500
  requests/month; the key is read from the environment (AVIATIONSTACK_API_KEY) and
  is never printed, logged or returned.
* Results are cached per route to keep within the free monthly quota.
"""

from __future__ import annotations

import os
from typing import Optional

try:
    import requests
except ImportError:  # pragma: no cover
    requests = None


AVIATIONSTACK_ENV = "AVIATIONSTACK_API_KEY"
# Free plan is HTTP-only; the call is made server-side from the action server.
AVIATIONSTACK_URL = "http://api.aviationstack.com/v1/flights"
AVIATIONSTACK_TIMEOUT_SECONDS = 6

# The 12 supported cities -> primary IATA airport code.
CITY_IATA = {
    "london": "LHR", "paris": "CDG", "berlin": "BER", "amsterdam": "AMS",
    "copenhagen": "CPH", "madrid": "MAD", "rome": "FCO", "barcelona": "BCN",
    "vienna": "VIE", "munich": "MUC", "lisbon": "LIS", "prague": "PRG",
}

# Cache successful lookups per route (free-tier friendly).
_FLIGHT_CACHE: dict = {}


def is_configured() -> bool:
    """True if an Aviationstack key is present (the key is not read out)."""
    return bool(os.environ.get(AVIATIONSTACK_ENV))


def get_flight_sample(origin_city: str, destination_city: str) -> Optional[str]:
    """Return a short ``"FLIGHTNO · Airline"`` string for the route, or None.

    Returns None whenever the key is missing, ``requests`` is unavailable, a city
    has no IATA mapping, the API errors/rate-limits/times out, or no flight is
    returned. No exception escapes this function.
    """
    if requests is None or not is_configured():
        return None
    dep = CITY_IATA.get(str(origin_city or "").strip().lower())
    arr = CITY_IATA.get(str(destination_city or "").strip().lower())
    if not dep or not arr:
        return None

    cache_key = (dep, arr)
    if cache_key in _FLIGHT_CACHE:
        return _FLIGHT_CACHE[cache_key]

    try:
        resp = requests.get(
            AVIATIONSTACK_URL,
            params={
                "access_key": os.environ[AVIATIONSTACK_ENV],
                "dep_iata": dep,
                "arr_iata": arr,
                "limit": 1,
            },
            timeout=AVIATIONSTACK_TIMEOUT_SECONDS,
        )
        if resp.status_code != 200:
            return None  # includes 429 rate-limit and 4xx/5xx
        data = resp.json().get("data") or []
        if not data:
            return None
        flight = data[0]
        airline = (flight.get("airline") or {}).get("name")
        number = (flight.get("flight") or {}).get("iata") or (flight.get("flight") or {}).get("number")
        parts = [p for p in (number, airline) if p]
        result = " · ".join(parts) if parts else None
        if result:
            _FLIGHT_CACHE[cache_key] = result  # cache only successes
        return result
    except Exception:
        return None  # network error, timeout, invalid JSON, etc.


if __name__ == "__main__":
    # Smoke test — works with or without a key; the key is never printed.
    print("Aviationstack configured:", is_configured())
    for o, d in [("Paris", "Copenhagen"), ("London", "Rome")]:
        print(f"{o} -> {d}: {get_flight_sample(o, d)}")
    print("(None everywhere is the correct fallback when no key / no live flight.)")
