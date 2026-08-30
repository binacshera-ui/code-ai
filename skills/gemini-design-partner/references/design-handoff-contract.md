# Design handoff contract

## Contents

1. Authority boundaries
2. Context package
3. Canvas decisions
4. Applying a specification
5. Review loop

## 1. Authority boundaries

Gemini decides visual hierarchy, composition, color roles, typography, spacing, shape, motion, responsive presentation, and interaction appearance. Codex decides how to implement those decisions safely in the existing architecture.

When a visual proposal conflicts with behavior, preserve the behavior and request a narrower design revision. Do not silently substitute Codex's own visual direction.

## 2. Context package

Provide:

- The user's exact visual outcome.
- Product, audience, platform, and emotional direction.
- The smallest complete set of relevant source files.
- Current behavior and information that cannot disappear.
- Existing tokens and reusable patterns.
- Current screenshots where implementation state matters.
- Explicit mobile, desktop, RTL/LTR, accessibility, and browser constraints.

Avoid raw repository dumps. They dilute visual reasoning and increase leakage risk.

## 3. Canvas decisions

Choose one scope for every tool call:

- `omit` for token work, abstract direction, or requests unrelated to the drawing.
- `full` for whole-screen hierarchy, page composition, and relationships between distant regions.
- `region` for one card, toolbar, field, dialog, or other bounded component. Coordinates are normalized to the original canvas dimensions.

Explain the decision in `canvas_input.reason` and the desired inspection target in `canvas_input.focus`.

## 4. Applying a specification

Map each `implementation_handoff` item to existing components and tokens. Treat Gemini's bounded `code_snippet` as the primary visual implementation and paste it verbatim when it is technically compatible. Prefer targeted edits and reusable primitives. Keep event handlers, API calls, state transitions, accessibility semantics, and error handling intact.

Do not rewrite compatible Gemini visual code merely to impose a different Codex aesthetic. If a technical conflict requires adaptation, change only the incompatible portion and preserve the rest of Gemini's code exactly. Do not paste a blind full-file replacement; integrate bounded snippets into the authoritative source after checking compilation, behavior, accessibility, browser support, security, and repository conventions.

## 5. Review loop

After implementation:

1. Run the existing test/build suite.
2. Render representative mobile and desktop states.
3. Capture screenshots including edge states.
4. Call `design_review` with the screenshots and changed files.
5. Fix high-priority visual gaps without regressing behavior.
6. Re-run behavioral and visual checks.

Use no more than three total `design_review` calls in this loop, including malformed-output retries and timeouts. Never make a fourth call; after the third failure, rely on the latest valid Gemini artifact and local verification, and report the service failure.
