#!/usr/bin/env python3
"""
analyse_conversation_log.py — read a Rasa tracker dump (conversation_log.json)
and print a concise, case-by-case issue report for debugging the Eco-Travel
Advisor's dialogue flow.

The tracker is produced by the notebook's logging cell:
    GET http://localhost:5005/conversations/<id>/tracker  ->  conversation_log.json

Usage:
    python3 scripts/analyse_conversation_log.py [path-to-tracker.json]

Default path: conversation_log.json, then results/conversation_log.json.

The tracker contains conversation events only; no secrets or environment
variables are read or printed.
"""

from __future__ import annotations

import json
import os
import sys
from collections import Counter

# Reference data used only for classification (kept in sync with the seed data).
SUPPORTED_DESTINATIONS = {"paris", "berlin", "amsterdam", "copenhagen"}
KNOWN_ORIGINS = {
    "london", "manchester", "edinburgh", "dublin", "brussels", "madrid",
    "barcelona", "rome", "munich", "vienna", "zurich", "istanbul",
    "paris", "berlin", "amsterdam", "copenhagen",
}
CONTROL_INTENTS = {
    "go_back", "edit_answer", "reset_trip", "request_human", "out_of_scope",
    "affirm", "deny", "greet", "goodbye", "bot_challenge", "plan_trip",
    "request_recommendations",
}
FORM_SLOTS = {"origin", "destination", "travel_date", "num_travellers", "budget", "sustainability_pref"}


def _find_path(arg: str | None) -> str:
    if arg and os.path.exists(arg):
        return arg
    for candidate in ("conversation_log.json", "results/conversation_log.json"):
        if os.path.exists(candidate):
            return candidate
    return arg or "conversation_log.json"


def _looks_like_control_value(value) -> bool:
    """True if a slot value looks like a swallowed control payload."""
    if not isinstance(value, str):
        return False
    s = value.strip()
    return s.startswith("/") or s.lower() in CONTROL_INTENTS or s.lower() == "change"


def analyse(tracker: dict):
    """Reconstruct turns from the tracker events and flag issues per turn."""
    events = tracker.get("events", [])
    slots: dict = {}
    active_loop = None
    requested_slot = None
    turns = []
    cur = None

    def start_turn(ev):
        intent = (ev.get("parse_data", {}).get("intent", {}) or {})
        return {
            "timestamp": ev.get("timestamp"),
            "user": ev.get("text"),
            "intent": intent.get("name"),
            "confidence": intent.get("confidence"),
            "entities": [(e.get("entity"), e.get("value")) for e in ev.get("parse_data", {}).get("entities", [])],
            "active_loop_before": active_loop,
            "requested_slot_before": requested_slot,
            "slots_before": dict(slots),
            "actions": [], "bot_texts": [], "buttons": [], "custom": [], "slot_sets": [],
        }

    for ev in events:
        et = ev.get("event")
        if et == "user":
            if cur:
                cur["slots_after"] = dict(slots)
                turns.append(cur)
            cur = start_turn(ev)
        elif et == "action":
            name = ev.get("name")
            if cur and name and name != "action_listen":
                cur["actions"].append(name)
        elif et == "bot":
            if cur:
                if ev.get("text"):
                    cur["bot_texts"].append(ev["text"])
                data = ev.get("data") or {}
                if data.get("buttons"):
                    cur["buttons"].extend(data["buttons"])
                if data.get("custom"):
                    cur["custom"].append(data["custom"])
        elif et == "slot":
            name, val = ev.get("name"), ev.get("value")
            if name == "requested_slot":
                requested_slot = val
            else:
                slots[name] = val
                if cur:
                    cur["slot_sets"].append((name, val))
        elif et == "active_loop":
            active_loop = ev.get("name")
    if cur:
        cur["slots_after"] = dict(slots)
        turns.append(cur)

    issues = []
    for t in turns:
        cats = set()
        acts, intent = t["actions"], t["intent"]
        conf = t["confidence"] or 0.0

        if "action_default_fallback" in acts and intent and intent != "nlu_fallback" and conf >= 0.5:
            cats.add("unexpected_fallback")

        if (intent == "inform" and not t["active_loop_before"]
                and any(e in ("origin", "destination") for e, _ in t["entities"])
                and "trip_planning_form" not in acts):
            cats.add("missing_form_activation")

        for name, val in t["slot_sets"]:
            if name in FORM_SLOTS and _looks_like_control_value(val):
                cats.add("slot_pollution_by_control_intent")
                sv = val.strip().lower() if isinstance(val, str) else ""
                if sv.startswith("/go_back"):
                    cats.add("go_back_flow_error")
                if sv == "change":
                    cats.add("edit_flow_error")
                if sv.startswith("/affirm") or sv.startswith("/deny"):
                    cats.add("failed_typo_confirmation")
            if name == "origin" and isinstance(val, str) and val and val.strip().lower() not in KNOWN_ORIGINS:
                cats.add("unnormalised_origin")

        if any("?" in b for b in t["bot_texts"]) or "action_default_fallback" in acts:
            if not t["buttons"]:
                cats.add("missing_buttons")

        if any(("don't support" in b.lower()) or ("currently cover" in b.lower()) for b in t["bot_texts"]):
            cats.add("unsupported_location")

        if intent == "out_of_scope":
            cats.add("out_of_scope_recovery")

        t["categories"] = sorted(cats)
        if cats:
            issues.append(t)
    return turns, issues


def main():
    path = _find_path(sys.argv[1] if len(sys.argv) > 1 else None)
    if not os.path.exists(path):
        print(f"File not found: {path}")
        sys.exit(1)

    with open(path, encoding="utf-8") as f:
        tracker = json.load(f)

    turns, issues = analyse(tracker)
    print(f"Analysed {len(turns)} user turn(s) from {path}")
    print(f"Flagged {len(issues)} turn(s) with at least one issue.\n")

    counts = Counter(c for t in issues for c in t["categories"])
    print("Issue summary (category: count):")
    for cat, n in counts.most_common():
        print(f"  {n:3}  {cat}")

    print("\nFlagged turns:")
    for i, t in enumerate(issues, 1):
        print(f"\n[{i}] USER: {t['user']!r}")
        print(f"    intent={t['intent']} ({round(t['confidence'] or 0, 2)})  entities={t['entities']}")
        print(f"    active_loop={t['active_loop_before']}  requested_slot={t['requested_slot_before']}")
        if t["slot_sets"]:
            print(f"    slot_sets={t['slot_sets']}")
        if t["actions"]:
            print(f"    actions={t['actions']}")
        if t["bot_texts"]:
            print(f"    bot={t['bot_texts'][0][:90]!r}")
        print(f"    -> {', '.join(t['categories'])}")


if __name__ == "__main__":
    main()
