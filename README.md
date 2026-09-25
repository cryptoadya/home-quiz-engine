# Home Quiz Engine

Private local-network quiz engine for home parties with friends.

This is deliberately **not** a SaaS product. The priority is a reliable, pleasant party experience on one home network, not multi-tenant scale or commercial platform features.

## Runtime roles

- `/admin` — quiz editor
- `/host` — host controller, mobile-first
- `/screen` — TV / presentation screen
- `/play` — player phone UI

## Canonical docs

- `docs/SPEC.md` — product requirements; source of truth for behavior
- `docs/ROADMAP.md` — implementation phases and acceptance gates
- `docs/ARCHITECTURE.md` — technical boundaries and state ownership
- `docs/CODEX_WORKFLOW.md` — how Codex tasks are issued and reviewed
- `AGENTS.md` — short standing instructions for coding agents

## Planned stack

- React + TypeScript
- Node.js + Express + TypeScript
- Socket.IO for live game synchronization
- SQLite
- Local per-quiz media storage

Do not add infrastructure, abstractions, services, authentication systems, cloud dependencies, or framework layers unless a current requirement actually needs them.
