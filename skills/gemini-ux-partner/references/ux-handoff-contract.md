# UX handoff contract

## Authority

Gemini supplies bounded product and UX judgment. Codex owns the product decision, code, behavior, data, implementation, validation and final response. Gemini must not receive secrets, customer-private data or unrelated repository content.

## Required final schema

Every independent assessment starts with a private Codex thesis that is persisted locally but omitted from Gemini's first prompt. The first Gemini response is a blind baseline, not a debate turn. `ux_debate_turn` may then reveal Codex's counterargument to Gemini, one exchange at a time, for up to ten Codex-counterargument → Gemini-response exchanges per debate.

`ux_product_synthesis` returns a JSON object with these core fields:

```json
{
  "version": "1.0",
  "consultation_type": "ux_product_synthesis",
  "product_thesis": "one decisive product direction",
  "debate_resolution": {
    "agreements": ["shared conclusion"],
    "remaining_disagreements": ["honest unresolved tension"],
    "decision_rule": "why this product decision wins despite uncertainty"
  },
  "evidence_status": { "known": [], "inferred": [], "needs_validation": [] },
  "customer_stage_plan": [
    {
      "stage": "discover | evaluate | onboard | activate | core_value | retain | recover | advocate",
      "customer_goal": "what success means to the customer",
      "moment_and_context": "when and why this happens",
      "customer_action": "observable action",
      "emotion_and_mental_model": "state and expectation",
      "friction_and_trust_risk": ["risk"],
      "behavioral_rationale": ["ethical principle"],
      "psychology_and_accessibility": ["consideration"],
      "visual_and_content_guidance": ["guidance"],
      "product_decision": "clear decision",
      "implementation_sequence": ["small safe step"],
      "success_signals": ["customer and business measure"],
      "harm_guardrails": ["what must not happen"],
      "validation_or_experiment": "how to reduce uncertainty"
    }
  ],
  "prioritized_backlog": [{ "priority": "now | next | later", "item": "decision", "why": "impact and confidence" }],
  "measurement_plan": [{ "metric": "name", "type": "leading | lagging | guardrail", "interpretation": "what movement means" }],
  "open_questions": []
}
```

## Evidence and ethics

- Separate observed evidence from hypotheses.
- Treat behavioral economics and psychology as lenses, not proof.
- Never recommend dark patterns, deception, false scarcity, coercive defaults, hidden costs or deliberate dependency.
- Preserve consent, reversibility, privacy, accessibility and the customer’s ability to leave or recover.

## Handoff quality

Every recommendation must be specific enough for Codex to map it to an existing flow, component or product decision, but must not be a full-file replacement, shell command, or unsafely broad rewrite.
