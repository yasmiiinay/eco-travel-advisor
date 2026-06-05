"""
actions.py — custom Rasa actions for the Eco-Travel Advisor.

These actions are the "brain" of the assistant. They read the collected slots,
fetch data through repository.py (NeonDB -> JSON fallback), estimate emissions
through carbon.py (Climatiq -> stored factor fallback), and reply in friendly
conversational language. Action names match domain.yml exactly.

Design notes
------------
* No secrets are read or printed here; all credentials stay inside db.py/carbon.py.
* Every data call has a graceful message if the repository/carbon data is missing.
* Control actions (clarify / go-back / edit) re-engage the form with a
  FollowupAction so the conversation resumes deterministically.
"""

from typing import Any, Dict, List, Optional, Text

from rasa_sdk import Action, FormValidationAction, Tracker
from rasa_sdk.executor import CollectingDispatcher
from rasa_sdk.events import ActiveLoop, AllSlotsReset, EventType, FollowupAction, SlotSet
from rasa_sdk.types import DomainDict

import carbon
import repository

# ---------------------------------------------------------------------------
# Shared labels and helpers
# ---------------------------------------------------------------------------

FORM_NAME = "trip_planning_form"

LEVEL_TEXT = {"green": "Low", "amber": "Medium", "red": "High"}

BUDGET_LABELS = {
    "budget": "Budget (up to 80 EUR/day)",
    "mid": "Mid (80-150 EUR/day)",
    "comfort": "Comfort (150+ EUR/day)",
}
BUDGET_SYNONYMS = {
    "cheap": "budget", "low": "budget", "low budget": "budget", "budget": "budget",
    "mid": "mid", "mid-range": "mid", "midrange": "mid", "moderate": "mid",
    "comfort": "comfort", "comfortable": "comfort", "luxury": "comfort", "high-end": "comfort",
}

PREF_LABELS = {
    "low_carbon": "lowest carbon",
    "eco_certified": "eco-certified hotels",
    "local_culture": "local community support",
    "balanced": "balanced",
}
PREF_SYNONYMS = {
    "lowest_carbon": "low_carbon", "low_carbon": "low_carbon", "greenest": "low_carbon",
    "eco_certified": "eco_certified", "certified": "eco_certified",
    "local_community": "local_culture", "local": "local_culture",
    "community": "local_culture", "local_culture": "local_culture",
    "balanced": "balanced",
}

UNINFORMATIVE = {"not sure", "maybe", "i don't know", "i dont know", "idk",
                 "dunno", "whatever", "no idea", "don't know"}


def _is_uninformative(text: Optional[str]) -> bool:
    """True if the user gave a vague non-answer like 'not sure' or 'maybe'."""
    return bool(text) and str(text).strip().lower() in UNINFORMATIVE


def _parse_travellers(text: Optional[str]) -> Optional[int]:
    """Parse a traveller count from a number or a natural phrase.

    Handles digits ("2"), and phrases like "me and my wife" (2),
    "family of four" (4), "three of us" (3), "just me" (1). The NLU synonyms
    usually normalise these already; this is a robust backup.
    """
    if not text:
        return None
    t = str(text).strip().lower()
    digits = "".join(ch for ch in t if ch.isdigit())
    if digits:
        return int(digits)
    words = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6}
    for word, value in words.items():
        if word in t:
            return value
    if any(p in t for p in ("just me", "solo", "myself", "on my own", "alone")):
        return 1
    if any(p in t for p in ("wife", "husband", "partner", "couple", "two of us", "me and my")):
        return 2
    if "family of four" in t or "four of us" in t:
        return 4
    if "family" in t or "three of us" in t:
        return 3
    return None


def _carbon_band(level: Optional[str]) -> str:
    """Return a text label for a colour band (never rely on colour alone)."""
    return LEVEL_TEXT.get(level, "Unknown")


def _canonical_origin(name: Optional[str]) -> Optional[str]:
    """Return the canonical origin city name (e.g. 'madridd' -> 'Madrid')."""
    if not name:
        return name
    match = repository.resolve_origin(name)
    return match["city"] if match else name


SUPPORTED_LINE = ("I currently support 12 popular European cities: Paris, Berlin, Amsterdam, "
                  "Copenhagen, London, Madrid, Rome, Barcelona, Vienna, Munich, Lisbon and Prague.")
DEST_BUTTONS = [
    {"title": "Paris", "payload": '/inform{"destination": "Paris"}'},
    {"title": "Berlin", "payload": '/inform{"destination": "Berlin"}'},
    {"title": "London", "payload": '/inform{"destination": "London"}'},
    {"title": "Rome", "payload": '/inform{"destination": "Rome"}'},
    {"title": "Barcelona", "payload": '/inform{"destination": "Barcelona"}'},
    {"title": "Amsterdam", "payload": '/inform{"destination": "Amsterdam"}'},
]


# ===========================================================================
# 1. Form validation
# ===========================================================================

class ValidateTripPlanningForm(FormValidationAction):
    """Validate and normalise the six trip-planning slots."""

    def name(self) -> Text:
        return "validate_trip_planning_form"

    def validate_origin(self, slot_value, dispatcher, tracker, domain) -> Dict[Text, Any]:
        if _is_uninformative(slot_value):
            dispatcher.utter_message(text="No problem - which city are you starting from?")
            return {"origin": None}
        if not slot_value or not str(slot_value).strip():
            return {"origin": None}
        # Fuzzy-resolve so typos normalise to a canonical city ("madridd" -> Madrid).
        match = repository.resolve_origin(str(slot_value))
        if match:
            city = match["city"]
            if city.lower() != str(slot_value).strip().lower():
                dispatcher.utter_message(text=f"I understood that as {city}.")
            return {"origin": city}
        # Unknown origin: accept tidied text; the distance engine still fuzzy-matches.
        return {"origin": str(slot_value).strip().title()}

    def validate_destination(self, slot_value, dispatcher, tracker, domain) -> Dict[Text, Any]:
        if _is_uninformative(slot_value):
            dispatcher.utter_message(text="That's okay. " + SUPPORTED_LINE, buttons=DEST_BUTTONS)
            return {"destination": None}
        if not slot_value or not str(slot_value).strip():
            return {"destination": None}

        dest, _ = repository.resolve_destination(str(slot_value))
        if dest is None:
            dispatcher.utter_message(
                text=f"Sorry, I don't support '{slot_value}' yet. " + SUPPORTED_LINE,
                buttons=DEST_BUTTONS,
            )
            return {"destination": None}

        # Auto-correct close typos (e.g. "kopenhg" -> Copenhagen) and continue.
        city = dest["city"]
        if city.lower() != str(slot_value).strip().lower():
            dispatcher.utter_message(text=f"I understood that as {city}.")
        return {"destination": city}

    def validate_travel_date(self, slot_value, dispatcher, tracker, domain) -> Dict[Text, Any]:
        if _is_uninformative(slot_value):
            dispatcher.utter_message(text="No worries - you can give rough dates or just say \"flexible\".")
            return {"travel_date": None}
        if not slot_value or not str(slot_value).strip():
            return {"travel_date": None}
        return {"travel_date": str(slot_value).strip()}

    def validate_num_travellers(self, slot_value, dispatcher, tracker, domain) -> Dict[Text, Any]:
        count = _parse_travellers(slot_value)
        if count is None:
            dispatcher.utter_message(
                text="How many people are travelling? Pick a number, or say e.g. \"me and my wife\"."
            )
            return {"num_travellers": None}
        if count < 1 or count > 12:
            dispatcher.utter_message(text="Please give a traveller count between 1 and 12.")
            return {"num_travellers": None}
        return {"num_travellers": str(count)}

    def validate_budget(self, slot_value, dispatcher, tracker, domain) -> Dict[Text, Any]:
        if _is_uninformative(slot_value):
            dispatcher.utter_message(response="utter_ask_budget")
            return {"budget": None}
        key = BUDGET_SYNONYMS.get(str(slot_value).strip().lower())
        if key:
            return {"budget": key}
        dispatcher.utter_message(response="utter_ask_budget")
        return {"budget": None}

    def validate_sustainability_pref(self, slot_value, dispatcher, tracker, domain) -> Dict[Text, Any]:
        if _is_uninformative(slot_value):
            dispatcher.utter_message(response="utter_ask_sustainability_pref")
            return {"sustainability_pref": None}
        normalised = str(slot_value).strip().lower().replace(" ", "_").replace("-", "_")
        key = PREF_SYNONYMS.get(normalised)
        if key:
            return {"sustainability_pref": key}
        dispatcher.utter_message(response="utter_ask_sustainability_pref")
        return {"sustainability_pref": None}


# ===========================================================================
# 2. Destination typo clarification
# ===========================================================================

class ActionClarifyDestination(Action):
    def name(self) -> Text:
        return "action_clarify_destination"

    def run(self, dispatcher, tracker, domain) -> List[EventType]:
        guess = tracker.get_slot("destination_guess")
        intent = (tracker.latest_message or {}).get("intent", {}).get("name")

        if not guess:
            dispatcher.utter_message(response="utter_ask_destination")
            return []

        if intent == "affirm":
            dispatcher.utter_message(text=f"Great - setting your destination to {guess}.")
            return [SlotSet("destination", guess), SlotSet("destination_guess", None),
                    FollowupAction(FORM_NAME)]

        if intent == "deny":
            dispatcher.utter_message(text="No problem - which destination would you like?")
            return [SlotSet("destination", None), SlotSet("destination_guess", None),
                    FollowupAction(FORM_NAME)]

        # No clear yes/no yet: re-ask the confirmation.
        dispatcher.utter_message(
            text=f"Did you mean {guess}?",
            buttons=[{"title": f"Yes, {guess}", "payload": "/affirm"},
                     {"title": "No", "payload": "/deny"}],
        )
        return []


# ===========================================================================
# 3. Carbon footprint estimate
# ===========================================================================

class ActionEstimateCarbon(Action):
    def name(self) -> Text:
        return "action_estimate_carbon"

    def run(self, dispatcher, tracker, domain) -> List[EventType]:
        origin = _canonical_origin(tracker.get_slot("origin"))
        destination = tracker.get_slot("destination")
        travellers = _parse_travellers(tracker.get_slot("num_travellers")) or 1

        dest, _ = repository.resolve_destination(destination) if destination else (None, None)
        if not origin or not dest:
            dispatcher.utter_message(text="I need both an origin and a destination to estimate the footprint.")
            return []

        options, _ = repository.get_transport_options(
            origin, dest["destination_id"], emissions_provider=carbon.climatiq_provider
        )
        if not options:
            dispatcher.utter_message(
                text="I couldn't work out transport options for that route right now."
            )
            return [SlotSet("data_source", "unavailable")]

        greenest = options[0]
        per_person = greenest["estimated_emissions_kg_per_person"]
        estimate = carbon.estimate_emissions(greenest["mode"], greenest["estimated_distance_km"], travellers)

        total = estimate["estimated_co2_kg"]
        if total is None:
            total = round(per_person * travellers, 1)
        level = estimate["carbon_level"] or greenest["carbon_level"]
        source = estimate["data_source"]

        dispatcher.utter_message(
            text=(
                f"Estimated carbon footprint for {origin} to {dest['city']}:\n"
                f"- Greenest option ({greenest['mode']}): about {per_person} kg CO2e per person "
                f"({_carbon_band(greenest['carbon_level'])} impact)\n"
                f"- Total for {travellers} traveller(s): about {total} kg CO2e"
            )
        )
        return [
            SlotSet("estimated_co2", total),
            SlotSet("carbon_level", level),
            SlotSet("data_source", source),
        ]


# ===========================================================================
# 4. Recommendations (hotels, transport, experiences, offsets)
# ===========================================================================

class ActionRecommendPlan(Action):
    def name(self) -> Text:
        return "action_recommend_plan"

    def run(self, dispatcher, tracker, domain) -> List[EventType]:
        origin = _canonical_origin(tracker.get_slot("origin"))
        destination = tracker.get_slot("destination")
        preference = tracker.get_slot("sustainability_pref")

        dest, _ = repository.resolve_destination(destination) if destination else (None, None)
        if not dest:
            dispatcher.utter_message(text="I couldn't find that destination to build recommendations.")
            return []
        did = dest["destination_id"]
        pref_label = PREF_LABELS.get(preference, "balanced")

        lines: List[str] = [
            f"Here's your sustainable plan for {dest['city']}, ranked for your "
            f"\"{pref_label}\" priority. These are curated prototype recommendations."
        ]

        # Transport comparison
        if origin:
            options, _ = repository.get_transport_options(
                origin, did, emissions_provider=carbon.climatiq_provider
            )
            if options:
                lines.append("\nTransport options (lowest emissions first):")
                for opt in options:
                    lines.append(
                        f"- {opt['mode'].title()}: ~{opt['estimated_emissions_kg_per_person']} kg CO2e "
                        f"[{_carbon_band(opt['carbon_level'])}], {opt['estimated_duration_hours']} h, "
                        f"~EUR {opt['estimated_price']}"
                    )

        # Eco-hotels
        hotels, _ = repository.get_hotels_for_destination(did, preference)
        if hotels:
            lines.append("\nEco-friendly stays:")
            for hotel in hotels[:3]:
                lines.append(
                    f"- {hotel['name']} ({hotel['eco_certification']}, EUR {hotel['nightly_price_estimate']}/night) "
                    f"- carbon: {_carbon_band(hotel.get('carbon_score'))}, "
                    f"sustainability {hotel.get('sustainability_score')}/10"
                )

        # Cultural / local experiences
        experiences, _ = repository.get_experiences_for_destination(did, preference)
        if experiences:
            lines.append("\nLocal experiences:")
            for exp in experiences[:2]:
                lines.append(f"- {exp['name']} ({exp.get('type', 'experience')}, EUR {exp['estimated_price']})")

        # Carbon offsets
        offsets, _ = repository.get_offset_options(did)
        if offsets:
            offset = offsets[0]
            lines.append(
                f"\nOffset option: {offset['provider_name']} ({offset['project_type']}) "
                f"at about EUR {offset['estimated_cost_per_tonne']} per tonne CO2e."
            )

        dispatcher.utter_message(text="\n".join(lines))
        return []


# ===========================================================================
# 5. High-emission warning
# ===========================================================================

class ActionHighEmissionAlert(Action):
    def name(self) -> Text:
        return "action_high_emission_alert"

    def run(self, dispatcher, tracker, domain) -> List[EventType]:
        origin = _canonical_origin(tracker.get_slot("origin"))
        destination = tracker.get_slot("destination")
        dest, _ = repository.resolve_destination(destination) if destination else (None, None)
        if not origin or not dest:
            return []

        options, _ = repository.get_transport_options(
            origin, dest["destination_id"], emissions_provider=carbon.climatiq_provider
        )
        high = next((o for o in options if o["carbon_level"] == "red"), None)
        if not high:
            return []  # nothing high-emission: do not over-warn

        greener = next((o for o in options if o["carbon_level"] != "red"), None)
        message = (
            f"Heads up: travelling by {high['mode']} is high emission "
            f"(about {high['estimated_emissions_kg_per_person']} kg CO2e per person)."
        )
        if greener:
            saved = round(high["estimated_emissions_kg_per_person"]
                          - greener["estimated_emissions_kg_per_person"], 1)
            message += (
                f" A lower-carbon alternative is {greener['mode']} "
                f"(~{greener['estimated_emissions_kg_per_person']} kg, "
                f"{_carbon_band(greener['carbon_level'])} impact), saving about {saved} kg per person."
            )
        dispatcher.utter_message(text=message)
        return []


# ===========================================================================
# 6. Go back to the previous answer
# ===========================================================================

class ActionGoBack(Action):
    def name(self) -> Text:
        return "action_go_back"

    def run(self, dispatcher, tracker, domain) -> List[EventType]:
        # Reset the most recently filled slot, in reverse collection order.
        order = ["sustainability_pref", "budget", "num_travellers",
                 "travel_date", "destination", "origin"]
        labels = {
            "origin": "origin", "destination": "destination", "travel_date": "travel dates",
            "num_travellers": "traveller count", "budget": "budget",
            "sustainability_pref": "sustainability preference",
        }
        for slot in order:
            if tracker.get_slot(slot):
                dispatcher.utter_message(text=f"Sure - let's revisit your {labels[slot]}.")
                return [SlotSet(slot, None), FollowupAction(FORM_NAME)]

        dispatcher.utter_message(text="We're already at the first question.")
        return [FollowupAction(FORM_NAME)]


# ===========================================================================
# 7. Edit a previous answer
# ===========================================================================

class ActionEditAnswer(Action):
    def name(self) -> Text:
        return "action_edit_answer"

    def run(self, dispatcher, tracker, domain) -> List[EventType]:
        labels = {
            "origin": "origin", "destination": "destination", "travel_date": "travel dates",
            "num_travellers": "traveller count", "budget": "budget",
            "sustainability_pref": "sustainability preference",
        }
        # The edit buttons send /edit_answer{"field_to_edit":"<slot>"}; we read that
        # entity to know which slot to reset. It is never written into a slot itself,
        # so the slot is cleared and the form re-asks for a fresh, valid value.
        field = None
        for ent in (tracker.latest_message or {}).get("entities", []):
            if ent.get("entity") == "field_to_edit" and ent.get("value") in labels:
                field = ent["value"]
                break
        if field:
            dispatcher.utter_message(text=f"Okay - let's update your {labels[field]}.")
            return [SlotSet(field, None), FollowupAction(FORM_NAME)]

        dispatcher.utter_message(
            text="Which answer would you like to change?",
            buttons=[
                {"title": "Origin", "payload": '/edit_answer{"field_to_edit": "origin"}'},
                {"title": "Destination", "payload": '/edit_answer{"field_to_edit": "destination"}'},
                {"title": "Travel dates", "payload": '/edit_answer{"field_to_edit": "travel_date"}'},
                {"title": "Travellers", "payload": '/edit_answer{"field_to_edit": "num_travellers"}'},
                {"title": "Budget", "payload": '/edit_answer{"field_to_edit": "budget"}'},
                {"title": "Preference", "payload": '/edit_answer{"field_to_edit": "sustainability_pref"}'},
            ],
        )
        return []


# ===========================================================================
# 8. Reset the trip
# ===========================================================================

class ActionResetTrip(Action):
    def name(self) -> Text:
        return "action_reset_trip"

    def run(self, dispatcher, tracker, domain) -> List[EventType]:
        dispatcher.utter_message(response="utter_trip_reset")
        return [AllSlotsReset(), ActiveLoop(None)]


# ===========================================================================
# 9. Human handover with full context
# ===========================================================================

class ActionHandover(Action):
    def name(self) -> Text:
        return "action_handover"

    def run(self, dispatcher, tracker, domain) -> List[EventType]:
        conversation_id = tracker.sender_id
        origin = tracker.get_slot("origin")
        destination = tracker.get_slot("destination")
        travel_date = tracker.get_slot("travel_date")
        travellers = tracker.get_slot("num_travellers")
        budget = tracker.get_slot("budget")
        preference = tracker.get_slot("sustainability_pref")
        estimated_co2 = tracker.get_slot("estimated_co2")
        carbon_level = tracker.get_slot("carbon_level")
        data_source = tracker.get_slot("data_source")

        context = {
            "origin": origin,
            "destination": destination,
            "travel_date": travel_date,
            "num_travellers": travellers,
            "budget": budget,
            "sustainability_pref": preference,
            "estimated_co2_kg": estimated_co2,
            "carbon_level": carbon_level,
            "data_source": data_source,
        }

        # Persist a trip row and the handover log (silently no-ops if the DB is down).
        trip_payload = {
            "conversation_id": conversation_id,
            "origin": origin,
            "destination": destination,
            "travel_date": travel_date,
            "num_travellers": _parse_travellers(travellers),
            "sustainability_pref": preference,
            "estimated_co2": estimated_co2,
            "emission_level": carbon_level,
            "data_source": data_source,
        }
        repository.save_trip_session(trip_payload)
        repository.save_handover_log(conversation_id, context)

        dispatcher.utter_message(
            text=(
                "I'm connecting you to a human travel advisor. They'll receive your full "
                "trip context, so you won't need to repeat anything:\n"
                f"- From {origin or '-'} to {destination or '-'}\n"
                f"- Dates: {travel_date or '-'}, travellers: {travellers or '-'}\n"
                f"- Budget: {BUDGET_LABELS.get(budget, budget or '-')}\n"
                f"- Priority: {PREF_LABELS.get(preference, preference or '-')}\n"
                f"- Estimated carbon: {estimated_co2 or '-'} kg "
                f"({_carbon_band(carbon_level)} impact), source: {data_source or '-'}"
            )
        )
        return []


# ===========================================================================
# 10. Scoped fallback (DC-08)
# A low-confidence message that *looks like a place name* (e.g. "adana") gets a
# clear, in-scope reply naming the supported cities, instead of the generic
# "I didn't catch that". Anything else keeps the normal rephrase prompt.
# ===========================================================================

class ActionScopedFallback(Action):
    def name(self) -> Text:
        return "action_scoped_fallback"

    def run(self, dispatcher, tracker, domain) -> List[EventType]:
        text = (tracker.latest_message.get("text") or "").strip()
        words = text.split()
        # Heuristic: one or two alphabetic words, 3+ chars -> probably a city the
        # user is asking for, just not one we support.
        looks_like_place = (
            1 <= len(words) <= 2
            and text.replace(" ", "").isalpha()
            and len(text) >= 3
        )

        if looks_like_place:
            dispatcher.utter_message(
                text=f"I don't cover \"{text}\" yet. {SUPPORTED_LINE}",
                buttons=DEST_BUTTONS,
            )
        else:
            # Generic low-confidence recovery (same content as utter_ask_rephrase).
            dispatcher.utter_message(response="utter_ask_rephrase")
        return []
