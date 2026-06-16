"""
geo.py — optional location detection (GPS) for the Eco-Travel Advisor.

The browser sends the user's coordinates; this module turns them into one of the
12 supported origin cities:

  1. nearest supported city  — always available (great-circle over the seed data,
     no API needed); this is the safety net so location detection never fails.
  2. OpenCage reverse-geocode — best-effort *friendly* place name ("near Frankfurt")
     for nicer UX; optional, needs OPENCAGE_API_KEY.

Best-effort and never raises: any failure simply omits the friendly name (the
nearest-city result still stands). The key is read from the environment only and
is never printed or returned.
"""

from __future__ import annotations

import json
import math
import os
from typing import Optional, Tuple

try:
    import requests
except ImportError:  # pragma: no cover
    requests = None

OPENCAGE_ENV = "OPENCAGE_API_KEY"
OPENCAGE_URL = "https://api.opencagedata.com/geocode/v1/json"
OPENCAGE_TIMEOUT_SECONDS = 6

_SEED = os.path.join(os.path.dirname(__file__), "..", "data", "seed")


def is_configured() -> bool:
    return bool(os.environ.get(OPENCAGE_ENV))


def _cities() -> list:
    """The 12 supported cities with coordinates (read-only, from the seed)."""
    try:
        with open(os.path.join(_SEED, "origin_city.json"), encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def _haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return r * 2 * math.asin(math.sqrt(a))


def city_coords(name: str) -> Optional[Tuple[float, float]]:
    """(lat, lon) for a supported city name, or None."""
    if not name:
        return None
    for c in _cities():
        if c["city"].lower() == str(name).strip().lower():
            return (c["latitude"], c["longitude"])
    return None


def nearest_supported_city(lat: float, lon: float) -> Tuple[Optional[str], Optional[int]]:
    """Nearest of the 12 supported cities to (lat, lon). Returns (city, km)."""
    best, best_d = None, None
    for c in _cities():
        d = _haversine(lat, lon, c["latitude"], c["longitude"])
        if best_d is None or d < best_d:
            best, best_d = c["city"], d
    return (best, round(best_d) if best_d is not None else None)


def reverse_geocode(lat: float, lon: float) -> Optional[str]:
    """OpenCage -> a friendly place name (city/town/...), or None on any problem."""
    if requests is None or not is_configured():
        return None
    try:
        resp = requests.get(
            OPENCAGE_URL,
            params={"q": f"{lat},{lon}", "key": os.environ[OPENCAGE_ENV],
                    "limit": 1, "no_annotations": 1},
            timeout=OPENCAGE_TIMEOUT_SECONDS,
        )
        if resp.status_code != 200:
            return None
        results = resp.json().get("results") or []
        if not results:
            return None
        comp = results[0].get("components", {}) or {}
        return (comp.get("city") or comp.get("town") or comp.get("village")
                or comp.get("municipality") or comp.get("state") or comp.get("country"))
    except Exception:
        return None


def resolve_location(lat: float, lon: float) -> Tuple[Optional[str], Optional[str], Optional[int]]:
    """Map coordinates to a supported origin city.

    Returns (supported_city, detected_name, distance_km). ``supported_city`` is the
    nearest of the 12 cities (always available); ``detected_name`` is the OpenCage
    label if a key is set, else None.
    """
    city, dist = nearest_supported_city(lat, lon)
    name = reverse_geocode(lat, lon)
    return city, name, dist


if __name__ == "__main__":
    # Smoke test — works with or without the key; key never printed.
    print("OPENCAGE configured:", is_configured())
    for lat, lon in [(52.52, 13.40), (50.11, 8.68)]:   # Berlin, Frankfurt
        print(f"({lat},{lon}) ->", resolve_location(lat, lon))
