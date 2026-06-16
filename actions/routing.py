"""
routing.py — optional real routed distance via OpenRouteService (ORS).

Replaces the great-circle (haversine) distance with a road-routed distance for
ground transport, giving a more realistic input to the carbon estimate
(distance -> Climatiq / stored factor). Best-effort and **never raises**: if the
key is missing or the API errors / rate-limits / times out, it returns None and
the caller keeps the stored haversine distance (graceful fallback).

The key is read from the environment (OPENROUTESERVICE_API_KEY) and is never
printed or returned. Free tier: ~2,000 requests/day; results are cached per route.
"""

from __future__ import annotations

import os
from typing import Optional

try:
    import requests
except ImportError:  # pragma: no cover
    requests = None

ORS_ENV = "OPENROUTESERVICE_API_KEY"
ORS_URL = "https://api.openrouteservice.org/v2/directions/driving-car"
ORS_TIMEOUT_SECONDS = 6

_DIST_CACHE: dict = {}


def is_configured() -> bool:
    return bool(os.environ.get(ORS_ENV))


def routed_distance_km(o_lat: float, o_lon: float, d_lat: float, d_lon: float) -> Optional[float]:
    """Road distance (km) between two points, or None on any problem.

    None whenever the key is missing, ``requests`` is unavailable, the API errors
    /rate-limits/times out, or no route is returned (e.g. an over-water pair).
    """
    if requests is None or not is_configured():
        return None
    key = (round(o_lat, 3), round(o_lon, 3), round(d_lat, 3), round(d_lon, 3))
    if key in _DIST_CACHE:
        return _DIST_CACHE[key]
    try:
        resp = requests.post(
            ORS_URL,
            headers={"Authorization": os.environ[ORS_ENV],
                     "Content-Type": "application/json"},
            json={"coordinates": [[o_lon, o_lat], [d_lon, d_lat]]},  # ORS wants lon,lat
            timeout=ORS_TIMEOUT_SECONDS,
        )
        if resp.status_code != 200:
            return None
        routes = resp.json().get("routes") or []
        if not routes:
            return None
        metres = (routes[0].get("summary") or {}).get("distance")
        if isinstance(metres, (int, float)) and metres > 0:
            km = round(metres / 1000.0, 1)
            _DIST_CACHE[key] = km           # cache only successes
            return km
    except Exception:
        return None
    return None


if __name__ == "__main__":
    print("OPENROUTESERVICE configured:", is_configured())
    # Paris -> Berlin (driving). None = no key / no route (correct fallback).
    print("Paris->Berlin km:", routed_distance_km(48.8566, 2.3522, 52.52, 13.405))
