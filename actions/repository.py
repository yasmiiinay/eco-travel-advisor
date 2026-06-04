"""
repository.py — the data-access and fallback layer for the Eco-Travel Advisor.

This module is the single place the custom Rasa actions go to for data. It hides
*where* the data comes from behind one cascade:

    NeonDB (PostgreSQL, primary)  ->  local JSON seed files (data/seed/, fallback)

so the chatbot keeps working even if the database is unavailable or times out.
Every read function returns ``(data, data_source)`` where ``data_source`` is one
of:

    "neondb"        -> served live from the database
    "json_fallback" -> the database was unreachable/empty, served from local JSON
    "unavailable"   -> neither source could provide the data

It also contains the distance engine: given any supported origin city it computes
the great-circle (haversine) distance to a destination and derives each transport
mode's emissions, duration, price and colour band from the curated profiles.

Notes
-----
* Import-safe: importing this module never opens a database connection.
* No secrets are read or printed here; the connection string stays inside db.py
  and errors are caught without echoing any connection details.
"""

from __future__ import annotations

import difflib
import json
import math
import os
from typing import Callable, Optional

import db  # actions/db.py

# ---------------------------------------------------------------------------
# Paths and constants
# ---------------------------------------------------------------------------

SEED_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "seed")

# Colour bands for per-person trip emissions (kg CO2e), tuned for the
# short/medium European routes in the prototype dataset.
GREEN_MAX_KG = 25.0
AMBER_MAX_KG = 75.0

# Minimum similarity for typo-tolerant city matching (0..1).
FUZZY_CUTOFF = 0.6

_seed_cache: dict[str, list] = {}


# ---------------------------------------------------------------------------
# Low-level helpers
# ---------------------------------------------------------------------------

def _load_seed(filename: str) -> list:
    """Load and cache one seed JSON file (the JSON fallback tier)."""
    if filename not in _seed_cache:
        with open(os.path.join(SEED_DIR, filename), encoding="utf-8") as fh:
            _seed_cache[filename] = json.load(fh)
    return _seed_cache[filename]


def _to_dict(obj) -> dict:
    """Convert a SQLAlchemy row object into a plain column dict."""
    return {col.name: getattr(obj, col.name) for col in obj.__table__.columns}


def _read_with_fallback(db_fn: Callable[[], object],
                        json_fn: Callable[[], object]) -> tuple:
    """Run the read cascade and return ``(data, data_source)``.

    A tier is a *miss* if it raises or returns an empty/None value, in which case
    the next tier is tried. Database errors are swallowed (no secret leakage) so a
    transient outage degrades gracefully to the JSON files.
    """
    if db.is_db_configured():
        try:
            result = db_fn()
            if result:
                return result, "neondb"
        except Exception:
            pass  # degrade to local JSON
    try:
        result = json_fn()
        if result is not None:
            return result, "json_fallback"
    except Exception:
        pass
    return None, "unavailable"


def carbon_level(emissions_kg: float) -> str:
    """Map per-person emissions to a green / amber / red band."""
    if emissions_kg < GREEN_MAX_KG:
        return "green"
    if emissions_kg <= AMBER_MAX_KG:
        return "amber"
    return "red"


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance between two points in kilometres."""
    radius = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lambda = math.radians(lon2 - lon1)
    a = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    return radius * 2 * math.asin(math.sqrt(a))


def _fuzzy_match(name: str, rows: list, key: str = "city") -> Optional[dict]:
    """Return the row whose ``key`` best matches ``name``, tolerating typos.

    Exact (case-insensitive) matches win first; otherwise the closest name above
    FUZZY_CUTOFF is returned (so "Pariiis" -> Paris, "Berln" -> Berlin).
    """
    name = (name or "").strip().lower()
    if not name:
        return None
    by_lower = {row[key].lower(): row for row in rows}
    if name in by_lower:
        return by_lower[name]
    closest = difflib.get_close_matches(name, list(by_lower), n=1, cutoff=FUZZY_CUTOFF)
    return by_lower[closest[0]] if closest else None


# ---------------------------------------------------------------------------
# 1 & 8. Reference / lookup data
# ---------------------------------------------------------------------------

def get_destinations() -> tuple:
    """All supported destinations. Returns (list, data_source)."""
    return _read_with_fallback(
        db_fn=lambda: [_to_dict(r) for r in db.get_session().query(db.Destination).all()],
        json_fn=lambda: _load_seed("destination.json"),
    )


def get_tags() -> tuple:
    """The sustainability-tag vocabulary. Returns (list, data_source)."""
    return _read_with_fallback(
        db_fn=lambda: [_to_dict(r) for r in db.get_session().query(db.Tag).all()],
        json_fn=lambda: _load_seed("tags.json"),
    )


def _get_origins() -> tuple:
    return _read_with_fallback(
        db_fn=lambda: [_to_dict(r) for r in db.get_session().query(db.OriginCity).all()],
        json_fn=lambda: _load_seed("origin_city.json"),
    )


def _get_transport_modes() -> tuple:
    return _read_with_fallback(
        db_fn=lambda: [_to_dict(r) for r in db.get_session().query(db.TransportMode).all()],
        json_fn=lambda: _load_seed("transport_mode.json"),
    )


# ---------------------------------------------------------------------------
# 2. Typo-tolerant destination resolution
# ---------------------------------------------------------------------------

def resolve_destination(user_input: str) -> tuple:
    """Resolve free-text city input to a destination, tolerating typos.

    Returns ``(destination_dict_or_None, data_source)``. Handles e.g. "Pariiis",
    "Berln", "Amsterdm". The action layer can confirm the match with the user
    when it differs from the raw input.
    """
    destinations, source = get_destinations()
    if not destinations:
        return None, source
    return _fuzzy_match(user_input, destinations, key="city"), source


def resolve_origin(user_input: str) -> Optional[dict]:
    """Resolve free-text origin to a supported origin city, tolerating typos
    (e.g. "madridd" -> Madrid). Returns the origin dict or None."""
    origins, _ = _get_origins()
    if not origins:
        return None
    return _fuzzy_match(user_input, origins, key="city")


def _find_destination_by_id(destination_id: int) -> Optional[dict]:
    destinations, _ = get_destinations()
    for row in destinations or []:
        if row["destination_id"] == destination_id:
            return row
    return None


# ---------------------------------------------------------------------------
# 3 & 4 & 7. Curated recommendations, ranked by preference
# ---------------------------------------------------------------------------

_CARBON_RANK = {"green": 0, "amber": 1, "red": 2}


def _db_with_tags(model, destination_id: int) -> list:
    """Fetch hotels/experiences with their tag names expanded (DB tier)."""
    session = db.get_session()
    try:
        rows = session.query(model).filter(model.destination_id == destination_id).all()
        result = []
        for row in rows:
            data = _to_dict(row)
            data["sustainability_tags"] = [tag.tag_name for tag in row.tags]
            result.append(data)
        return result
    finally:
        session.close()


def _rank_hotels(hotels: list, preference: Optional[str]) -> list:
    if preference == "budget":
        return sorted(hotels, key=lambda h: h.get("nightly_price_estimate", 0))
    if preference == "low_carbon":
        return sorted(hotels, key=lambda h: (_CARBON_RANK.get(h.get("carbon_score"), 3),
                                             -h.get("sustainability_score", 0)))
    if preference == "eco_certified":
        return sorted(hotels, key=lambda h: (0 if "eco_certified" in h.get("sustainability_tags", []) else 1,
                                             -h.get("sustainability_score", 0)))
    if preference == "local_culture":
        return sorted(hotels, key=lambda h: (0 if "locally_owned" in h.get("sustainability_tags", []) else 1,
                                             -h.get("sustainability_score", 0)))
    return sorted(hotels, key=lambda h: -h.get("sustainability_score", 0))


def _rank_experiences(experiences: list, preference: Optional[str]) -> list:
    if preference == "budget":
        return sorted(experiences, key=lambda e: e.get("estimated_price", 0))
    if preference == "local_culture":
        return sorted(experiences, key=lambda e: -e.get("local_community_score", 0))
    return sorted(experiences, key=lambda e: -e.get("sustainability_score", 0))


def get_hotels_for_destination(destination_id: int, preference: Optional[str] = None) -> tuple:
    """Eco-hotels for a destination, ranked by preference. Returns (list, data_source)."""
    hotels, source = _read_with_fallback(
        db_fn=lambda: _db_with_tags(db.Hotel, destination_id),
        json_fn=lambda: [h for h in _load_seed("hotel.json") if h["destination_id"] == destination_id],
    )
    return _rank_hotels(hotels or [], preference), source


def get_experiences_for_destination(destination_id: int, preference: Optional[str] = None) -> tuple:
    """Cultural/local experiences for a destination. Returns (list, data_source)."""
    experiences, source = _read_with_fallback(
        db_fn=lambda: _db_with_tags(db.Experience, destination_id),
        json_fn=lambda: [e for e in _load_seed("experience.json") if e["destination_id"] == destination_id],
    )
    return _rank_experiences(experiences or [], preference), source


def get_offset_options(destination_id: int) -> tuple:
    """Carbon-offset options for a destination, cheapest per tonne first."""
    offsets, source = _read_with_fallback(
        db_fn=lambda: [_to_dict(r) for r in
                       db.get_session().query(db.OffsetOption)
                       .filter(db.OffsetOption.destination_id == destination_id).all()],
        json_fn=lambda: [o for o in _load_seed("offset_option.json") if o["destination_id"] == destination_id],
    )
    return sorted(offsets or [], key=lambda o: o.get("estimated_cost_per_tonne", 0)), source


# ---------------------------------------------------------------------------
# 6. Emission factors
# ---------------------------------------------------------------------------

def get_emission_factor(mode: str) -> tuple:
    """Emission factor record for a transport mode. Returns (record_or_None, data_source).

    The record includes ``kg_co2e_per_passenger_km`` plus the source note and the
    placeholder warning, so the action layer can attach an honest disclaimer.
    """
    record, source = _read_with_fallback(
        db_fn=lambda: [_to_dict(r) for r in
                       db.get_session().query(db.EmissionFactor)
                       .filter(db.EmissionFactor.mode == mode).all()],
        json_fn=lambda: [f for f in _load_seed("emission_factor.json") if f["mode"] == mode],
    )
    if not record:
        return None, source
    return record[0], source


# ---------------------------------------------------------------------------
# 5. Transport options (distance engine)
# ---------------------------------------------------------------------------

def get_transport_options(
    origin_city: str,
    destination_id: int,
    emissions_provider: Optional[Callable[[str, float], Optional[float]]] = None,
) -> tuple:
    """Compute transport options for a route. Returns (options, data_source).

    Options are sorted by emissions (lowest first) so the greenest choice is on
    top. ``emissions_provider`` is an optional hook (supplied later by carbon.py
    for a live Climatiq lookup): it takes ``(mode, distance_km)`` and returns kg
    CO2e, or ``None`` to defer to the stored emission factor.

    If the origin or destination cannot be resolved, returns ``([], "unavailable")``.
    """
    destination = _find_destination_by_id(destination_id)
    origins, origin_source = _get_origins()
    origin = _fuzzy_match(origin_city, origins or [], key="city")
    if destination is None or origin is None:
        return [], "unavailable"

    distance = haversine_km(origin["latitude"], origin["longitude"],
                            destination["latitude"], destination["longitude"])

    modes, mode_source = _get_transport_modes()
    factors, factor_source = _read_with_fallback(
        db_fn=lambda: [_to_dict(r) for r in db.get_session().query(db.EmissionFactor).all()],
        json_fn=lambda: _load_seed("emission_factor.json"),
    )
    factor_by_mode = {f["mode"]: f["kg_co2e_per_passenger_km"] for f in (factors or [])}

    options = []
    for mode in (modes or []):
        name = mode["mode"]
        if name == "ferry":
            continue  # ferry needs real sea routes; not modelled on land corridors
        if distance < mode.get("min_recommended_distance_km", 0):
            continue  # e.g. don't offer flights for very short trips

        emissions = None
        if emissions_provider is not None:
            emissions = emissions_provider(name, distance)
        if emissions is None:
            factor = factor_by_mode.get(name)
            if factor is None:
                continue
            emissions = distance * factor

        options.append({
            "mode": name,
            "estimated_distance_km": round(distance),
            "estimated_duration_hours": round(mode["overhead_hours"] + distance / mode["avg_speed_kmh"], 1),
            "estimated_price": round(mode["base_price_eur"] + mode["price_per_km_eur"] * distance),
            "estimated_emissions_kg_per_person": round(emissions, 1),
            "carbon_level": carbon_level(emissions),
            "disclaimer": "Emissions and prices are estimates, not measured or bookable values.",
        })

    if options:
        options.sort(key=lambda o: o["estimated_emissions_kg_per_person"])
        source = "neondb" if (mode_source == "neondb" and factor_source == "neondb") else "json_fallback"
        return options, source

    # Last resort: the pre-computed curated routes table (covers all 15 origins).
    curated, curated_source = _read_with_fallback(
        db_fn=lambda: [_to_dict(r) for r in db.get_session().query(db.TransportOption)
                       .filter(db.TransportOption.destination_id == destination_id,
                               db.TransportOption.origin_city == origin["city"]).all()],
        json_fn=lambda: [r for r in _load_seed("transport_option.json")
                         if r["destination_id"] == destination_id
                         and r["origin_city"].lower() == origin["city"].lower()],
    )
    if curated:
        curated.sort(key=lambda o: o["estimated_emissions_kg_per_person"])
        return curated, curated_source
    return [], "unavailable"


# ---------------------------------------------------------------------------
# 9 & 10. Write operations (database only; no JSON persistence)
# ---------------------------------------------------------------------------

def save_trip_session(payload: dict) -> str:
    """Upsert a trip session by ``conversation_id``. Returns a data_source label.

    Returns "neondb" on success or "unavailable" if the database is not
    configured or the write fails (the chatbot still functions without it).
    """
    if not db.is_db_configured():
        return "unavailable"
    session = db.get_session()
    try:
        valid = set(db.Trip.__table__.columns.keys())
        data = {k: v for k, v in payload.items() if k in valid}
        conv = data.get("conversation_id")
        existing = session.query(db.Trip).filter_by(conversation_id=conv).one_or_none()
        if existing is None:
            session.add(db.Trip(**data))
        else:
            for key, value in data.items():
                setattr(existing, key, value)
        session.commit()
        return "neondb"
    except Exception:
        session.rollback()
        return "unavailable"
    finally:
        session.close()


def save_handover_log(conversation_id: str, context_payload: dict) -> str:
    """Persist a human-handover record with the full conversation context.

    Returns "neondb" on success or "unavailable" if the database is not
    configured or the write fails.
    """
    if not db.is_db_configured():
        return "unavailable"
    session = db.get_session()
    try:
        # Ensure a parent trip row exists to satisfy the foreign key.
        if session.query(db.Trip).filter_by(conversation_id=conversation_id).one_or_none() is None:
            session.add(db.Trip(conversation_id=conversation_id))
        session.add(db.HandoverLog(
            conversation_id=conversation_id,
            context_payload=context_payload,
            status="pending",
        ))
        session.commit()
        return "neondb"
    except Exception:
        session.rollback()
        return "unavailable"
    finally:
        session.close()
