"""
db.py — SQLAlchemy ORM models and connection handling for the Eco-Travel Advisor.

Design notes
------------
* Mock-first / NeonDB-primary prototype. These models mirror the curated seed
  JSON files in ``data/seed/`` one-to-one, so the same data can either be
  loaded into NeonDB (PostgreSQL) or read directly from JSON as a fallback.
* IMPORT-SAFE: importing this module never opens a database connection and
  never raises if ``NEON_DATABASE_URL`` is unset. The engine is created lazily,
  only when ``get_engine()`` / ``get_session()`` are actually called. This lets
  Rasa import the action code (and lets us run a syntax/import check) without
  any real credentials.
* SECURITY: all data access goes through the SQLAlchemy ORM, which uses bound
  parameters under the hood — this gives parameterised queries and SQL-injection
  safety by default (NFR15). No raw string-formatted SQL is used.
* No real credentials live in this file; the connection string is read from the
  environment at runtime.
"""

from __future__ import annotations

import os

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    JSON,
    String,
    Text,
    create_engine,
    func,
)
from sqlalchemy.orm import declarative_base, relationship, sessionmaker

# ---------------------------------------------------------------------------
# Configuration (no credentials hard-coded — read from the environment only)
# ---------------------------------------------------------------------------

# Name of the env var holding the NeonDB/PostgreSQL connection string, e.g.
#   postgresql+psycopg://USER:PASSWORD@HOST/DB?sslmode=require
ENV_VAR = "NEON_DATABASE_URL"

# Short connection timeout so a sleeping Neon free-tier instance fails fast and
# the repository layer can fall back to local JSON instead of hanging.
CONNECT_TIMEOUT_SECONDS = 5

Base = declarative_base()

# Module-level lazy singletons. They stay ``None`` until first use.
_engine = None
_SessionLocal = None


# ---------------------------------------------------------------------------
# Association (join) tables — many-to-many between curated entities and tags
# ---------------------------------------------------------------------------

class HotelTag(Base):
    """Join table linking hotels to sustainability tags."""
    __tablename__ = "hotel_tag"
    hotel_id = Column(Integer, ForeignKey("hotel.hotel_id"), primary_key=True)
    tag_id = Column(Integer, ForeignKey("tag.tag_id"), primary_key=True)


class ExperienceTag(Base):
    """Join table linking experiences to sustainability tags."""
    __tablename__ = "experience_tag"
    experience_id = Column(Integer, ForeignKey("experience.experience_id"), primary_key=True)
    tag_id = Column(Integer, ForeignKey("tag.tag_id"), primary_key=True)


# ---------------------------------------------------------------------------
# Reference / lookup tables
# ---------------------------------------------------------------------------

class Tag(Base):
    """tags.json — controlled vocabulary of sustainability tags."""
    __tablename__ = "tag"
    tag_id = Column(Integer, primary_key=True)
    tag_name = Column(String(64), unique=True, nullable=False)
    category = Column(String(32))
    description = Column(Text)


class Destination(Base):
    """destination.json — the supported destination cities."""
    __tablename__ = "destination"
    destination_id = Column(Integer, primary_key=True)
    city = Column(String(80), nullable=False)
    country = Column(String(80), nullable=False)
    latitude = Column(Float)
    longitude = Column(Float)
    description = Column(Text)
    sustainability_summary = Column(Text)
    average_daily_budget = Column(Integer)
    best_transport_modes = Column(JSON)  # list[str]
    popularity_level = Column(String(20))

    hotels = relationship("Hotel", back_populates="destination")
    experiences = relationship("Experience", back_populates="destination")


class OriginCity(Base):
    """origin_city.json — supported departure cities and their coordinates.

    A separate lookup table (NOT derived from transport_option.json) because
    origins are reference geo-data used to compute haversine distance for *any*
    origin->destination pair dynamically. transport_option.json only contains a
    handful of curated featured routes, so it cannot supply coordinates for the
    full set of supported origins.
    """
    __tablename__ = "origin_city"
    origin_id = Column(Integer, primary_key=True)
    city = Column(String(80), nullable=False)
    country = Column(String(80))
    latitude = Column(Float, nullable=False)
    longitude = Column(Float, nullable=False)


class TransportMode(Base):
    """transport_mode.json — per-mode profile used to compute duration & price.

    A separate lookup table (NOT derived from transport_option.json) because it
    holds the *rules* (speed, overhead, pricing) for computing any route, whereas
    transport_option.json holds pre-computed example rows. Keeping the profile
    normalised avoids duplicating speed/price constants on every route row.
    """
    __tablename__ = "transport_mode"
    mode = Column(String(20), primary_key=True)  # natural key: flight/train/...
    avg_speed_kmh = Column(Integer, nullable=False)
    overhead_hours = Column(Float, nullable=False)
    base_price_eur = Column(Integer, nullable=False)
    price_per_km_eur = Column(Float, nullable=False)
    min_recommended_distance_km = Column(Integer, default=0)
    supports_international = Column(Boolean, default=True)
    notes = Column(Text)


class EmissionFactor(Base):
    """emission_factor.json — kg CO2e per passenger-km, the fallback for Climatiq."""
    __tablename__ = "emission_factor"
    mode = Column(String(20), primary_key=True)  # natural key matches transport_mode.mode
    kg_co2e_per_passenger_km = Column(Float, nullable=False)
    source_note = Column(Text)
    placeholder_warning = Column(Text)


# ---------------------------------------------------------------------------
# Curated content tables
# ---------------------------------------------------------------------------

class Hotel(Base):
    """hotel.json — eco-friendly accommodation recommendations."""
    __tablename__ = "hotel"
    hotel_id = Column(Integer, primary_key=True)
    destination_id = Column(Integer, ForeignKey("destination.destination_id"), nullable=False)
    name = Column(String(160), nullable=False)
    eco_certification = Column(String(80))
    price_band = Column(String(10))  # low / mid / high
    nightly_price_estimate = Column(Integer)
    sustainability_score = Column(Float)  # 0-10
    carbon_score = Column(String(10))     # green / amber / red
    public_transport_access = Column(Text)
    accessibility_features = Column(JSON)  # list[str]
    disclaimer = Column(Text)

    destination = relationship("Destination", back_populates="hotels")
    tags = relationship("Tag", secondary="hotel_tag")


class Experience(Base):
    """experience.json — cultural / local / nature experiences."""
    __tablename__ = "experience"
    experience_id = Column(Integer, primary_key=True)
    destination_id = Column(Integer, ForeignKey("destination.destination_id"), nullable=False)
    name = Column(String(160), nullable=False)
    type = Column(String(40))  # cultural / nature / community / food
    local_community_score = Column(Float)  # 0-10
    estimated_price = Column(Integer)
    accessibility_notes = Column(Text)
    description = Column(Text)

    destination = relationship("Destination", back_populates="experiences")
    tags = relationship("Tag", secondary="experience_tag")


class TransportOption(Base):
    """transport_option.json — curated featured routes + offline fallback rows."""
    __tablename__ = "transport_option"
    option_id = Column(Integer, primary_key=True)
    origin_city = Column(String(80), nullable=False)  # city name (matches origin_city.city)
    destination_id = Column(Integer, ForeignKey("destination.destination_id"), nullable=False)
    mode = Column(String(20), ForeignKey("transport_mode.mode"), nullable=False)
    estimated_distance_km = Column(Integer)
    estimated_duration_hours = Column(Float)
    estimated_price = Column(Integer)
    estimated_emissions_kg_per_person = Column(Float)
    carbon_level = Column(String(10))  # green / amber / red
    data_source = Column(String(20))   # 'curated' for seed rows
    disclaimer = Column(Text)


class OffsetOption(Base):
    """offset_option.json — carbon-offset recommendations."""
    __tablename__ = "offset_option"
    offset_id = Column(Integer, primary_key=True)
    destination_id = Column(Integer, ForeignKey("destination.destination_id"), nullable=False)
    provider_name = Column(String(160))
    project_type = Column(String(60))
    estimated_cost_per_tonne = Column(Integer)
    verification_note = Column(Text)
    disclaimer = Column(Text)


# ---------------------------------------------------------------------------
# Operational tables (no seed file — populated at runtime by the chatbot)
# ---------------------------------------------------------------------------

class Trip(Base):
    """A user's collected trip plan for one conversation (supports handover)."""
    __tablename__ = "trip"
    id = Column(Integer, primary_key=True)
    conversation_id = Column(String(128), unique=True, nullable=False)  # Rasa sender_id
    origin = Column(String(80))
    destination = Column(String(80))
    travel_date = Column(String(40))
    num_travellers = Column(Integer)
    budget_amount = Column(Float)
    currency = Column(String(8))
    sustainability_pref = Column(String(40))
    estimated_co2 = Column(Float)
    emission_level = Column(String(10))
    data_source = Column(String(20))  # api / neondb / json
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class HandoverLog(Base):
    """Record of a human-advisor escalation, with the full conversation context."""
    __tablename__ = "handover_log"
    id = Column(Integer, primary_key=True)
    conversation_id = Column(String(128), ForeignKey("trip.conversation_id"))
    context_payload = Column(JSON, nullable=False)  # slots + summary + transcript ref
    status = Column(String(20), default="pending")
    created_at = Column(DateTime(timezone=True), server_default=func.now())


# ---------------------------------------------------------------------------
# Connection helpers (lazy, import-safe)
# ---------------------------------------------------------------------------

def _normalise_url(url: str) -> str:
    """Normalise the connection URL without touching credentials.

    * Neon sometimes provides a ``postgres://`` URL; SQLAlchemy expects
      ``postgresql://``.
    * When no driver is specified, force the modern ``psycopg`` (v3) driver so
      the URL works with the ``psycopg[binary]`` package, instead of SQLAlchemy
      defaulting to the older ``psycopg2``.
    """
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://"):]
    if url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url[len("postgresql://"):]
    return url


def is_db_configured() -> bool:
    """True if the connection-string env var is present (no connection attempted)."""
    return bool(os.environ.get(ENV_VAR))


def get_engine():
    """Return a lazily-created SQLAlchemy engine.

    Raises a clear RuntimeError only if called while ``NEON_DATABASE_URL`` is
    unset — importing the module never triggers this.
    """
    global _engine
    if _engine is None:
        raw = os.environ.get(ENV_VAR)
        if not raw:
            raise RuntimeError(
                f"{ENV_VAR} is not set. Set it in your local .env (never commit it) "
                f"before connecting to NeonDB. The chatbot can still run on JSON fallback."
            )
        _engine = create_engine(
            _normalise_url(raw),
            pool_pre_ping=True,                     # drop dead connections (Neon sleep)
            connect_args={"connect_timeout": CONNECT_TIMEOUT_SECONDS},
        )
    return _engine


def get_session():
    """Return a new ORM Session bound to the lazily-created engine."""
    global _SessionLocal
    if _SessionLocal is None:
        _SessionLocal = sessionmaker(bind=get_engine(), autoflush=False, expire_on_commit=False)
    return _SessionLocal()


def init_db():
    """Create all tables (used by Step 4 seed_db.py). Requires a configured DB."""
    Base.metadata.create_all(bind=get_engine())


# ---------------------------------------------------------------------------
# Lightweight self-check: `python actions/db.py` lists the mapped tables and
# proves the module imports safely with no DB connection / no credentials.
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print("actions/db.py imported OK — no database connection was opened.")
    print(f"{ENV_VAR} configured: {is_db_configured()}")
    print(f"Mapped tables ({len(Base.metadata.tables)}):")
    for name in sorted(Base.metadata.tables):
        cols = ", ".join(c.name for c in Base.metadata.tables[name].columns)
        print(f"  - {name}: {cols}")
