"""
seed_db.py — create the NeonDB schema and idempotently load the curated seed JSON.

What it does
------------
1. Loads NEON_DATABASE_URL from a local .env (never committed).
2. Creates all tables defined in actions/db.py if they don't exist.
3. Upserts every data/seed/*.json file by primary key, so re-running the script
   never produces duplicate rows (idempotent).
4. Resolves each record's ``sustainability_tags`` (tag *names*) against tags.json
   and fills the hotel_tag / experience_tag association tables.
5. Prints a per-table summary of inserted vs updated rows.

Safety
------
* No credentials are hard-coded or printed. The connection string is read from
  the environment and never echoed to the log.
* All access is via the SQLAlchemy ORM (bound parameters → SQL-injection safe).
* Clear, friendly errors for: missing .env, missing NEON_DATABASE_URL,
  invalid JSON, database connection failure, and foreign-key mismatch.

Run it
------
    cd eco-travel-advisor
    pip install -r requirements.txt          # needs sqlalchemy, psycopg, python-dotenv
    python actions/seed_db.py
"""

from __future__ import annotations

import json
import os
import sys

# Make actions/db.py importable whether run as `python actions/seed_db.py`
# or from another working directory.
THIS_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(THIS_DIR)
SEED_DIR = os.path.join(PROJECT_ROOT, "data", "seed")
ENV_PATH = os.path.join(PROJECT_ROOT, ".env")
sys.path.insert(0, THIS_DIR)

import db  # actions/db.py


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def fail(message: str) -> None:
    """Print a clear error and exit non-zero (without leaking secrets)."""
    print(f"\n[ERROR] {message}\n", file=sys.stderr)
    sys.exit(1)


def load_env() -> None:
    """Load .env if present; tolerate python-dotenv not being installed."""
    try:
        from dotenv import load_dotenv
    except ImportError:
        print("[warn] python-dotenv not installed; relying on shell environment.")
        return
    if os.path.exists(ENV_PATH):
        load_dotenv(ENV_PATH)
        print(f"[ok]   Loaded environment from .env")
    else:
        print("[warn] No .env file found at project root; "
              "relying on shell environment for NEON_DATABASE_URL.")


def read_json(filename: str):
    """Load one seed file with clear errors for missing file / invalid JSON."""
    path = os.path.join(SEED_DIR, filename)
    if not os.path.exists(path):
        fail(f"Seed file not found: data/seed/{filename}")
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except json.JSONDecodeError as exc:
        fail(f"Invalid JSON in data/seed/{filename}: {exc}")


def upsert(session, model, row: dict) -> str:
    """Insert or update one row by primary key. Returns 'inserted' or 'updated'.

    Only keys that correspond to real columns are used, so list fields like
    ``sustainability_tags`` (handled separately) are ignored here.
    """
    pk_cols = [c.name for c in model.__table__.primary_key.columns]
    valid_cols = set(model.__table__.columns.keys())
    data = {k: v for k, v in row.items() if k in valid_cols}

    pk_vals = tuple(data[c] for c in pk_cols)
    lookup = pk_vals if len(pk_vals) > 1 else pk_vals[0]

    obj = session.get(model, lookup)
    if obj is None:
        session.add(model(**data))
        return "inserted"
    for key, value in data.items():
        setattr(obj, key, value)
    return "updated"


# ---------------------------------------------------------------------------
# Seed-file -> model mapping (lookup tables first to satisfy foreign keys)
# ---------------------------------------------------------------------------

LOOKUP_TABLES = [
    (db.Destination,    "destination.json"),
    (db.OriginCity,     "origin_city.json"),
    (db.TransportMode,  "transport_mode.json"),
    (db.EmissionFactor, "emission_factor.json"),
    (db.Tag,            "tags.json"),
]

CONTENT_TABLES = [
    (db.Hotel,           "hotel.json"),
    (db.Experience,      "experience.json"),
    (db.TransportOption, "transport_option.json"),
    (db.OffsetOption,    "offset_option.json"),
]


def validate_foreign_keys(data: dict) -> None:
    """Fail clearly if any content row references a missing destination, mode or tag."""
    valid_dest = {d["destination_id"] for d in data["destination.json"]}
    valid_modes = {m["mode"] for m in data["transport_mode.json"]}
    valid_tags = {t["tag_name"] for t in data["tags.json"]}
    errors = []

    for fn in ("hotel.json", "experience.json", "transport_option.json", "offset_option.json"):
        for row in data[fn]:
            if row.get("destination_id") not in valid_dest:
                errors.append(f"{fn}: destination_id {row.get('destination_id')} not in destination.json")
            for tag in row.get("sustainability_tags", []):
                if tag not in valid_tags:
                    errors.append(f"{fn}: sustainability_tag '{tag}' not in tags.json")

    for row in data["transport_option.json"]:
        if row.get("mode") not in valid_modes:
            errors.append(f"transport_option.json: mode '{row.get('mode')}' not in transport_mode.json")

    if errors:
        fail("Foreign-key mismatch in seed data:\n  - " + "\n  - ".join(errors))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    print("Eco-Travel Advisor — NeonDB seeding\n" + "-" * 40)

    # 1) Environment ------------------------------------------------------
    load_env()
    if not db.is_db_configured():
        fail(
            f"{db.ENV_VAR} is not set.\n"
            f"  Create a local .env at the project root containing:\n"
            f"      {db.ENV_VAR}=postgresql+psycopg://USER:PASSWORD@HOST/DB?sslmode=require\n"
            f"  (Never commit .env — it is already in .gitignore.)"
        )

    # 2) Read + validate all seed files BEFORE touching the database ------
    data = {fn: read_json(fn) for _, fn in LOOKUP_TABLES + CONTENT_TABLES}
    validate_foreign_keys(data)
    print("[ok]   All seed files parsed and foreign keys validated.")

    # 3) Connect + create tables -----------------------------------------
    from sqlalchemy.exc import SQLAlchemyError, OperationalError
    try:
        db.init_db()  # create_all on the lazily-built engine
        print("[ok]   Connected to NeonDB and ensured all tables exist.")
    except OperationalError:
        fail("Could not connect to NeonDB. Check that NEON_DATABASE_URL is correct, "
             "the project is awake, and your network allows the connection. "
             "(Connection details are not shown for security.)")
    except SQLAlchemyError as exc:
        fail(f"Database error while creating tables: {type(exc).__name__}")

    # 4) Upsert rows ------------------------------------------------------
    summary: dict[str, dict[str, int]] = {}
    session = db.get_session()
    try:
        for model, filename in LOOKUP_TABLES + CONTENT_TABLES:
            table = model.__tablename__
            counts = {"inserted": 0, "updated": 0}
            for row in data[filename]:
                counts[upsert(session, model, row)] += 1
            summary[table] = counts

        # 5) Association tables: resolve tag names -> tag_id --------------
        session.flush()  # ensure tags are queryable for id resolution
        tag_id_by_name = {t.tag_name: t.tag_id for t in session.query(db.Tag).all()}

        for model, filename, fk_col, join_model, join_fk in [
            (db.Hotel, "hotel.json", "hotel_id", db.HotelTag, "hotel_id"),
            (db.Experience, "experience.json", "experience_id", db.ExperienceTag, "experience_id"),
        ]:
            counts = {"inserted": 0, "updated": 0}
            for row in data[filename]:
                owner_id = row[fk_col]
                for tag_name in row.get("sustainability_tags", []):
                    tag_id = tag_id_by_name[tag_name]
                    existing = session.get(join_model, (owner_id, tag_id))
                    if existing is None:
                        session.add(join_model(**{join_fk: owner_id, "tag_id": tag_id}))
                        counts["inserted"] += 1
                    else:
                        counts["updated"] += 1
            summary[join_model.__tablename__] = counts

        session.commit()
    except SQLAlchemyError as exc:
        session.rollback()
        fail(f"Database error while seeding (rolled back): {type(exc).__name__}")
    finally:
        session.close()

    # 6) Summary ----------------------------------------------------------
    print("\nSeeding complete — per-table results:")
    print(f"  {'table':<18}{'inserted':>10}{'updated':>10}")
    print(f"  {'-' * 18}{'-' * 10}{'-' * 10}")
    tot_i = tot_u = 0
    for table in sorted(summary):
        i, u = summary[table]["inserted"], summary[table]["updated"]
        tot_i += i
        tot_u += u
        print(f"  {table:<18}{i:>10}{u:>10}")
    print(f"  {'-' * 18}{'-' * 10}{'-' * 10}")
    print(f"  {'TOTAL':<18}{tot_i:>10}{tot_u:>10}")
    print("\n[done] Database is seeded. Re-running is safe (idempotent upsert).")


if __name__ == "__main__":
    main()
