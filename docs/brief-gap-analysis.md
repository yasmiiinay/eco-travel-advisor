# Eco-Travel Advisor — Assignment Brief Gap Analysis

Mapping the build against the **actual brief** (ACUIDCD Set exercise, Oct 25 / submission 19 Jun 2026).
Status: ✅ done · 🟡 partial · ❌ missing. Last updated 2026-06-06.

## Grading criteria (where the marks are)

| Criterion | Weight | Where we stand |
|---|---|---|
| Project Goals & Requirements Clarity | 15% | 🟡 system built; needs the **report** to state goals/requirements clearly |
| Research & Trend Analysis Depth | 15% | ❌ literature review not written |
| Prototype & Interaction Design Quality | 20% | 🟡 high-fidelity working UI ✅; **conversation-flow diagrams + multi-scenario walkthroughs** missing |
| Technical Implementation & NLP Integration | 20% | ✅ strong — Rasa + **Climatiq live** + **weighted scoring** ✅ + **Aviationstack flight API** ✅ (Amadeus substituted) |
| Testing Robustness | 15% | 🟡 NLU + dialogue testing ✅; **user testing** missing |
| Deployment & Professional Documentation | 15% | 🟡 ngrok works; **Docker verify + HuggingFace Spaces + README** missing |

The **report itself (2500–3000 words, Harvard, BSBI template, single PDF + GitHub link)** is the
vehicle for most of these marks and is **not started**.

---

## Task-by-task status

### Task 1 — In-depth research / literature review ❌
Required: state-of-the-art sustainable-travel chatbots, NLP/LLMs/multimodal, persuasive/behaviour-change
UX, ethics (greenwashing, privacy, accessibility, inclusivity); identify gaps + opportunities + risks.
**Not started.** Pure report content. No Wikipedia/UKEssays allowed; Harvard only.

### Task 2 — Functional & non-functional requirements 🟡
- Functional: trip intake ✅, info retrieval ✅, handover ✅, error recovery ✅.
  - **Location detection (GPS or manual)** — ✅ manual origin selection **and** GPS ("📍 Use my location"
    → nearest supported city via `geo.py`, OpenCage friendly name).
- Non-functional to address in the report: usability ✅ (tooltips/“How we estimate”), reliability ✅
  (fallback cascade), **latency < 3s** 🟡 (Climatiq adds calls — mitigated by cache + thinking indicator;
  measure & report), accessibility ✅ (aria/focus/colour+text), **GDPR/data privacy** 🟡 (we store trip +
  handover rows in NeonDB — needs a privacy note + justification).
- **Deliverable:** the requirements analysis section of the report. Not written.

### Task 3 — Prototype & interaction design 🟡
- High-fidelity, **working** UI ✅ (quick-reply buttons, colour-coded cards, hotel/experience cards =
  “carousels”, high-emission alert, handover indicator, advisor mode). Strong for the 20%.
- ❌ **Conversation-flow diagrams** (Figma/Miro/Lucidchart-style) — none yet (`docs/diagrams/` empty).
- ❌ **Several travel scenarios** illustrated with branching (short city break / eco-tour / carbon-neutral
  business trip) — need scripted walkthroughs + screenshots.

### Task 4 — Programming / AI / NLP 🟡 (strong, with 2 explicit gaps)
Done:
- Rasa Open Source **NLU + Core** ✅; DIETClassifier pipeline ✅ (brief’s recommended default).
- Custom actions ✅; **Climatiq live carbon API** ✅ (real-time per-mode, with fallback) — the brief’s
  headline API requirement.
- Slot persistence (destination/dates/budget/sustainability) ✅; multi-turn form ✅.
- Handover packaging full context ✅.
- Fallback + clarification ✅ (scoped) + colour-coded results ✅.

Status vs the brief’s wording:
- ✅ **Weighted scoring function** — DONE. `_weighted_transport_rank` in `actions.py` ranks transport by a
  composite score = `w_carbon·norm(carbon) + w_price·norm(price)`, with the weights selected by the user’s
  sustainability preference (e.g. lowest-carbon = 0.8/0.2, balanced = 0.5/0.5). Recommended option + card
  order now reflect this.
- ✅ **External flight data API** — DONE via **Aviationstack** (`actions/aviation.py`), substituted for the
  decommissioning Amadeus sandbox. Enriches the flight row with a real example flight (number + airline);
  env key only, timeout, per-route cache, None-returning fallback. Hotels stay curated (no Aviationstack
  hotel data; no free eco-cert API). Justified in `docs/api-integration-decision.md`.
- 🟡 **Two-stage fallback / `action_default_fallback`** — brief names a two-stage clarification flow using
  `action_default_fallback`. We have a single-stage `action_scoped_fallback` (an improvement). Either add a
  genuine two-stage (clarify chips → then escalate) or map/justify ours in the report.

### Task 5 — Testing 🟡
- `rasa test nlu` (confusion matrix, cross-validation) ✅; `rasa test core` (story/edge/fallback) ✅;
  held-out sets ✅; DC + S regression catalogues ✅.
- ❌ **User testing** — small think-aloud + 5-question post-task survey + ≥1 design change. Not done.

### Task 6 — Deployment 🟡
- `Pyngrok` secure tunnel ✅ (working). `.env` + `.gitignore` (keys never committed) ✅.
- 🟡 `Dockerfile` / `docker-compose.yml` exist but **unverified/not built**.
- ❌ **HuggingFace Spaces** deployment (brief’s recommended zero-cost host).
- 🟡 **README** — has a Climatiq section; needs full clone→run→deploy + GitHub link.

---

## Decisions you need to make

1. **Amadeus** — implement a minimal sandbox hotel/flight fetch (OAuth2, with fallback to curated, same
   pattern as Climatiq) to satisfy the explicit Task-4 list and protect the 20% Technical mark? Or keep
   curated and rely on the (now weaker, since it still works until 17 Jul) justification? *Recommendation:
   implement a thin version with fallback — it is explicitly named and markable in the window.*
2. **Weighted scoring function** — add the composite weighted ranking (small, explicitly required). *Recommend: yes.*
3. **GPS/location** — add manual “use my location” via a free geocoder (OpenCage, per the brief’s diagram)
   or justify manual-only? *Recommend: justify manual-only; optional OpenCage as future work.*

---

## Prioritised remaining backlog (by leverage)

**A. Quick technical wins (protect the 20% Technical mark):**
1. Weighted scoring function (carbon + price + preference) — small `repository.py`/`actions.py` change.
2. *(Decision)* minimal Amadeus hotel/flight fetch with fallback.
3. *(Optional)* two-stage fallback to match the brief wording.

**B. Report-supporting artefacts:**
4. Diagrams — architecture, conversation flow (several scenarios), ER, sequence/UML. (`docs/diagrams/`)
5. User testing — 3–5 testers, think-aloud + 5-question survey, record ≥1 design change.

**C. Deployment & docs (15%):**
6. Verify Docker build + docker-compose; deploy to HuggingFace Spaces (stable URL, no ngrok).
7. Full README (clone → .env → run → deploy + GitHub link).

**D. The report (carries most criteria):**
8. 2500–3000 word report, Harvard referencing, BSBI template, with screenshots (UI, Climatiq source,
   training progress, confusion matrix, evaluation), conversation flows, architecture — single PDF + GitHub link.

---

## Future enhancements (for the report's "opportunities for innovation")

- **Budget-aware smart date suggestion.** When the user is *flexible*, ask a rough trip length
  (implemented: Weekend / Short / Long) and then, given the budget, suggest the cheapest date window
  by querying a **date-priced** API (e.g. Amadeus Flight Offers). Not built now because our prices are
  static per route (no date-varying pricing), and inventing a "cheapest date" without real data would
  breach the transparency/anti-greenwashing requirement. A strong design-thinking / innovation point.
- Routed distances (OpenRouteService) and GPS geocoding (OpenCage) are now **implemented**
  (`routing.py` / `geo.py`). Live transit schedules (Transitland/Navitia) remain future work.

## What is genuinely solid already
Rasa NLU+Core, adaptive multi-turn form, 12-city dataset, NeonDB→JSON fallback, nine custom actions,
**live Climatiq integration** with provenance + graceful degradation, modern connected v2 UI
(quick replies, colour-coded cards, high-emission alert, advisor handover), accessibility, NLU + dialogue
testing with cross-validation, and the slot-contamination/UX stabilisation fixes. These map directly to the
*Technical Implementation*, *Prototype Quality*, and *Testing* criteria — the report just needs to evidence them.
