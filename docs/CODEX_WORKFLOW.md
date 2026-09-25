# Codex workflow

## Principle

Codex implements one roadmap slice at a time. Do not prompt it with the entire product and ask for a one-shot implementation.

## Task prompt template

Every implementation prompt should contain:

1. **Goal** — one concrete outcome.
2. **Scope** — files/features allowed to change.
3. **Relevant requirements** — point to the exact SPEC/phase sections, do not paste the whole spec unless necessary.
4. **Non-goals** — what not to build yet.
5. **Acceptance checks** — observable behavior/tests.
6. **Finish condition** — run tests/typecheck/build and summarize changed files + remaining issues.

## Branching

Prefer one branch/PR per roadmap slice or coherent sub-slice, e.g.:

- `feat/foundation`
- `feat/editor-core`
- `feat/lobby`
- `feat/game-loop-single`
- `feat/reconnect`
- `feat/question-types`
- `feat/media`
- `feat/themes`

Do not keep huge long-lived branches.

## Reviews

For meaningful changes:
- implementation pass
- independent review pass (prefer a stronger/different model for high-risk logic)
- fix only confirmed issues
- rerun tests/build

Focus reviews on correctness, state races, player/session identity, timer semantics, and leakage of correct-answer data.

## Model routing (current recommendation, Sep 2026)

Choose per task rather than pinning one model globally.

- **Architecture, state-machine changes, concurrency/race bugs, difficult debugging, final review:** `gpt-6-astra`, usually `medium` or `high`; use `xhigh/max` only when a concrete hard problem remains unresolved.
- **Normal feature implementation with clear acceptance criteria:** `gpt-6-sol` `medium` if available in the Codex environment. Fallback: `gpt-5.6-sol` `medium`.
- **Routine, narrow edits, tests, refactors with obvious behavior:** `gpt-5.6-terra` `low` or `medium`.
- **Tiny mechanical edits:** use the cheapest model that reliably follows the task; do not spend Astra on formatting or renames.

Do not assume higher effort is automatically better. Escalate model/effort only when task complexity or observed failures justify it.
