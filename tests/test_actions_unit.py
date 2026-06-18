"""Unit tests for the pure-Python helpers behind the bug-fix sprint.

`rasa test core` only checks predicted action names, so the slot-level behaviour
(rejecting unsupported cities, parsing "from X to Y", mapping numeric budgets)
is covered here instead. These tests need no database — repository.py resolves
against the local JSON seed when NeonDB is not configured.

Run from the project root:
    python -m pytest tests/test_actions_unit.py        # with pytest
    python tests/test_actions_unit.py                  # plain, no pytest needed
"""

import os
import sys

# Make the action modules importable (they live in actions/).
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "actions"))

import actions      # noqa: E402  (path set above)
import repository   # noqa: E402


# --- "from X to Y" parsing --------------------------------------------------

def test_parse_from_to_extracts_both_cities():
    assert actions._parse_from_to(
        "I want to plan a trip from London to Paris") == ("London", "Paris")
    assert actions._parse_from_to(
        "help me plan a trip from Rome to Amsterdam") == ("Rome", "Amsterdam")


def test_parse_from_to_ignores_plain_city():
    assert actions._parse_from_to("London") == (None, None)
    assert actions._parse_from_to("") == (None, None)


def test_from_to_resolves_to_supported_cities():
    o_phrase, d_phrase = actions._parse_from_to(
        "I want to plan a trip from London to Paris")
    assert actions._resolve_supported_origin(o_phrase)["city"] == "London"
    assert actions._resolve_supported_destination(d_phrase)["city"] == "Paris"


# --- HIGH 1: unsupported cities are rejected --------------------------------

def test_unsupported_origin_is_rejected():
    for city in ("adana", "izmir", "konya", "qwerty"):
        assert actions._resolve_supported_origin(city) is None, city


def test_unsupported_destination_is_rejected():
    for city in ("adana", "izmir", "konya", "qwerty"):
        assert actions._resolve_supported_destination(city) is None, city


# --- Supported typos still resolve (consistency with destination) -----------

def test_supported_origin_typos_resolve():
    assert actions._resolve_supported_origin("berln")["city"] == "Berlin"
    assert actions._resolve_supported_origin("madridd")["city"] == "Madrid"
    assert actions._resolve_supported_origin("londra")["city"] == "London"


def test_trailing_words_still_resolve():
    assert actions._resolve_supported_destination("Paris next week")["city"] == "Paris"
    assert actions._resolve_supported_origin("London please")["city"] == "London"


# --- HIGH 2: one consistent numeric-budget rule -----------------------------

def test_budget_tiers_are_consistent():
    cases = {65: "budget", 80: "budget", 81: "mid", 100: "mid",
             150: "mid", 151: "comfort", 180: "comfort"}
    for amount, tier in cases.items():
        assert actions._budget_tier_from_amount(amount) == tier, amount


if __name__ == "__main__":
    # Allow running without pytest: execute every test_* function and report.
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS  {name}")
            except AssertionError as exc:
                failures += 1
                print(f"FAIL  {name}: {exc}")
    print("-" * 40)
    print("ALL PASSED" if not failures else f"{failures} FAILURE(S)")
    sys.exit(1 if failures else 0)
