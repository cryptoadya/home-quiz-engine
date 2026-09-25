# Development roadmap

Each phase should end in a working, testable state. Do not implement later phases opportunistically.

## Phase 0 — Repository and executable skeleton

Goal: one command starts web + server; routes exist; tests/build/typecheck work.

Acceptance:
- React/TS frontend boots
- Express/TS server boots
- SQLite initialization exists
- routes `/admin`, `/host`, `/screen`, `/play` render placeholders
- lint/typecheck/test/build scripts are deterministic

## Phase 1 — Quiz data model + basic editor

Goal: create and persist a draft quiz without media.

Scope:
- quiz list/create/delete/duplicate
- rounds CRUD + reorder
- questions CRUD + reorder
- RU/EN fields
- single choice first
- points default 1
- autosave + saved state
- validation basics

Acceptance: create a small bilingual quiz, restart app, edit it again.

## Phase 2 — Lobby and player identity

Goal: phones can join a room before game start.

Scope:
- room code
- LAN-aware RU/EN QR links
- player name reservation
- language selection
- lobby roster live updates
- max 30 players
- Start Game fixes roster

Acceptance: multiple real phones join over Wi-Fi; duplicate names are rejected atomically.

## Phase 3 — End-to-end single-choice game loop

Goal: first genuinely playable party quiz.

Scope:
- Round Intro
- Question / Answering
- server timer
- Player selection + Submit
- early reveal when all submitted
- Reveal
- Host Next
- scoring
- Round End
- configured leaderboard points
- Final Leaderboard + Winner Screen

Acceptance: full multi-round single-choice quiz playable from phones + TV + host phone.

## Phase 4 — Reliability for the actual party

Goal: refresh/disconnect does not ruin the game.

Scope:
- player reconnect token
- Host reconnect
- Screen state resync
- disconnect-before-submit auto-pause
- Wait / Continue Without Player
- manual pause/resume
- dangerous action confirmations

Acceptance: test the defined disconnect scenarios on real devices.

## Phase 5 — Remaining question types

Scope:
- Yes/No
- Multiple Choice
- configurable correct-count hint
- Matching using tap-left/tap-right UX
- matching image elements
- shuffle

Acceptance: all types obey the same draft-selection -> Submit contract.

## Phase 6 — Media

Scope:
- images/GIF/video/audio upload
- per-quiz storage
- Screen-only normal question media
- media ordering
- `playBeforeTimer` behavior
- Host media controls
- responsive TV layout
- validation when referenced media is removed

Acceptance: image, audio, video and multi-media questions work on the home LAN.

## Phase 7 — Theme system + Halloween

Scope:
- Default theme
- theme manifest
- fallback behavior
- Halloween theme
- themeable Lobby/Round/Question/Reveal/Leaderboard/Winner/Player surfaces

Acceptance: same quiz can switch Default <-> Halloween without behavior changes.

## Phase 8 — Preview, Test Game, import/export and polish

Scope:
- Preview modes
- Test Game marker/cleanup
- self-contained ZIP export/import
- minimal real-game history
- layout warnings / limits
- final browser/device pass on current Safari iPhone + Chrome Android

Acceptance: party rehearsal from clean start succeeds without developer intervention.
