# AGENTS.md

## Project intent
This is a private home quiz engine for parties with friends, not a commercial SaaS product. Prefer the simplest robust implementation that satisfies `docs/SPEC.md`. Avoid speculative abstractions and product/platform features.

## Source of truth
- Use `docs/SPEC.md` for product behavior.
- Use `docs/ARCHITECTURE.md` for service/state boundaries.
- Use the relevant file in `docs/phases/` for the current implementation slice.
- If a task conflicts with `docs/SPEC.md`, stop and report the conflict instead of silently changing product behavior.

## Engineering rules
- TypeScript throughout unless a task explicitly says otherwise.
- Keep server authoritative for game state, timer, accepted submissions, scoring, player/session membership, pause/reveal transitions.
- Never expose correct-answer data to Player before reveal.
- Keep theme code separate from game logic.
- Keep Host mobile-first, Screen presentation-only, Player phone-first.
- Prefer small cohesive modules over generalized framework layers.
- No SaaS/multi-tenant/cloud architecture unless explicitly requested.
- Add or update tests for behavior changed by the task.
- Before finishing a coding task, run the relevant tests, typecheck, and build for the touched area.
- Do not broaden the task without a concrete requirement.
