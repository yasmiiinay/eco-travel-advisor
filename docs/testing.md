# Testing Strategy — Eco-Travel Advisor

This project is evaluated at four levels, from optimistic to rigorous. Reporting all four
honestly (rather than only the flattering in-sample figure) is itself part of the Level 7
critical-analysis expectation.

## The four test layers

### 1. In-sample training test (optimistic baseline)
`rasa test nlu` / `rasa test core` run against the **training data** themselves.
This shows the model can reproduce what it was trained on, but it is an **upper bound**, not a
measure of generalisation. Earlier runs gave 161/161 intents and 11/11 stories — report these
explicitly as *in-sample*, and note that they overstate real performance.

### 2. Cross-validation NLU (held-out, rigorous)
`rasa test nlu --cross-validation --folds 5` trains on 4 folds and tests on the held-out fold,
five times. The averaged precision/recall/F1 is an honest estimate of intent/entity performance on
unseen text. This is the headline NLU figure to quote in the report.

### 3. Held-out Core dialogue test
`rasa test core --stories tests/test_stories.yml` runs *new* conversations (unseen wording, not
copies of the training stories) and checks the predicted action sequence. It validates that the
dialogue policies generalise to fresh phrasings of greet, scope-guard, controls, handover and the
recommendation chain.

### 4. Robustness / manual edge-case test
Some behaviours depend on custom-action side-effects (slots set inside the form) that
`rasa test core` does not execute, so they are validated **interactively** with `rasa shell`
(with `rasa run actions` running). Work through the checklist below and record the outcomes.

## Held-out test assets

- `tests/test_nlu_samples.yml` — unseen NLU examples for every intent, plus destination typos
  (`Pariiis`, `Berln`, `Amsterdm`, `Copenhagn`) and natural traveller phrases
  (`me and my wife`, `my partner and I`, `family of four`, `three of us`).
- `tests/test_stories.yml` — held-out end-to-end conversations.

## Commands (Colab, Python 3.10 Rasa venv)

```bash
# data consistency
!MPLBACKEND=Agg /content/rasa-venv/bin/rasa data validate

# 2) cross-validation NLU (retrains folds; takes a few minutes)
!MPLBACKEND=Agg /content/rasa-venv/bin/rasa test nlu --nlu data/nlu.yml --cross-validation --folds 5

# held-out NLU set (evaluates the already-trained model on unseen examples)
!MPLBACKEND=Agg /content/rasa-venv/bin/rasa test nlu --nlu tests/test_nlu_samples.yml

# 3) held-out Core dialogue test
!MPLBACKEND=Agg /content/rasa-venv/bin/rasa test core --stories tests/test_stories.yml
```

`MPLBACKEND=Agg` makes matplotlib render the confusion matrix to a file (no interactive backend).
All reports are written to `results/` (`intent_report.json`, `story_report.json`, confusion-matrix
and histogram PNGs).

## Manual edge-case checklist (run in `rasa shell`)

Record pass/fail and a note for each:

- [ ] Typo destination: "I want to go to Pariiis" -> "Did you mean Paris?" -> Yes -> continues
- [ ] Typo rejected: "Berln" -> "Did you mean Berlin?" -> No -> re-asks destination
- [ ] Traveller phrase: "me and my wife" / "family of four" / "three of us" -> correct count
- [ ] Out-of-scope: "tell me a joke" -> redirected to planning
- [ ] Ambiguous: "not sure" / "maybe" -> asks again instead of guessing
- [ ] Edit answer: change destination after entering it -> slot reset, form resumes
- [ ] Go back: -> previous slot re-opened
- [ ] Reset trip: -> all slots cleared, fresh start
- [ ] Human handover: -> full context message shown
- [ ] Recommendations after the form: "show me the options" -> hotels/transport/offset
- [ ] High-emission path: a long flight route -> red warning + greener alternative

## How to report results honestly

In the report's evaluation section, present the layers in order and interpret them:

1. State the **in-sample** result and explicitly call it optimistic.
2. Give the **cross-validation** F1 as the real NLU performance; discuss any weak intents from the
   confusion matrix (e.g. likely confusion between similar control intents) and why.
3. Give the **held-out Core** accuracy and note it tests fresh phrasings.
4. Summarise the **manual edge-case** checklist as a small results table, with honest notes on any
   failures and what you would improve.

Acknowledge the limitations: a modest dataset (~161 training examples), in-sample headline numbers,
and the fact that deep form/slot behaviour is validated interactively rather than fully automated.
This candour is exactly what distinguishes a Level 7 evaluation from a descriptive one.
