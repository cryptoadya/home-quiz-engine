# Phase 0 — Foundation

**Historical task; implemented.** This is the original scope for the repository
skeleton, not the current development task. Its placeholder and “do not build yet”
instructions apply only to Phase 0. See [current status](../ROADMAP.md),
[current architecture](../ARCHITECTURE.md) and [the documentation map](../README.md).

## Goal
Create the smallest executable TypeScript project that proves the repository layout and developer workflow.

## Build
- React + TypeScript frontend
- Node + Express + TypeScript backend
- SQLite bootstrap
- placeholder routes: `/admin`, `/host`, `/screen`, `/play`
- one development command for web+server if practical
- deterministic test, typecheck and build commands

## Do not build yet
- quiz editor behavior
- Socket.IO game logic
- themes beyond minimal placeholders
- authentication beyond what is needed to keep route structure ready
- media handling

## Acceptance
- fresh install succeeds
- dev server(s) start without manual hacks
- all four routes render
- server health endpoint works
- SQLite database can initialize
- tests/typecheck/build pass
