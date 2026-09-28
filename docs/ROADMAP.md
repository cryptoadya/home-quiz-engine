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

Status: implementation and automated acceptance complete through Phase 4D.
Recovery regressions cover Host/Screen snapshots across all major states, Player
accepted submissions/exclusions, stale HTTP responses, confirmations, closure and
runtime presence/restart semantics. A local two-Player browser smoke exercised
refresh, disconnect Pause, reconnect, Wait, Continue Without Player and closure.
Physical phone/Wi-Fi acceptance remains pending; no real-device test is claimed.

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

Phase 5A complete: Yes/No editor, persistence, readiness, version-1 snapshots,
shared single-select gameplay/scoring and focused reliability coverage. Automated
checks and local browser mixed-quiz smoke passed.

Phase 5B adds Multiple Choice with independent editor correctness, 2–10 options,
at least two correct options, an always-visible required count, durable submitted
sets and exact-set scoring through the shared lifecycle. Focused regressions cover
mixed games, retries, reconnect/restart, Pause and Continue exclusions. Phase 5C adds Matching authoring with dedicated ordered pairs, bilingual text
sides prepared for image references, CRUD/reorder, deterministic type switching,
readiness and independently validated frozen snapshots.

Phase 5D completes text Matching gameplay: opaque frozen side IDs, complete
one-to-one immutable submissions, tap-to-pair editing, exact all-or-nothing scoring,
safe pre-Reveal projections and correct-pair/personal Reveal. It reuses timers,
Pause, reconnect, Wait/Continue, exclusions and mixed-type navigation. Focused
server/UI regressions cover malformed answers, retries, restart and all four types.
A local two-Player Chrome smoke verified incomplete Submit gating, pairing, accepted
mapping restoration after refresh, correct/incorrect scoring and bilingual Screen
Reveal. Physical phone/Wi-Fi acceptance remains pending.
All non-media Phase 5 scope is complete: Multiple Choice has a per-question
correct-count hint (enabled by default), frozen in version-1 snapshots and omitted
from pre-Reveal Player payloads when disabled. Frozen-game deterministic ordering
honors `shuffleAnswers` for all three option types and independently for Matching
sides, with stable IDs, shared order across Players and reconnect/restart durability.
Disabled shuffle preserves authored order. Focused mixed-quiz server and UI
regressions cover these settings, mapping correctness and scoring.
Matching image elements remain structurally supported but media-dependent image
authoring/rendering is deferred to Phase 6; it is not claimed as implemented.
This completes Phase 5's non-media acceptance; physical phone/Wi-Fi smoke remains
pending. Phase 6A storage foundations are described below.

Scope:
- Yes/No
- Multiple Choice
- configurable correct-count hint
- Matching using tap-left/tap-right UX
- matching image elements — deferred to Phase 6 media
- shuffle

Acceptance: all types obey the same draft-selection -> Submit contract.

## Phase 6 — Media

Phase 6A implements local UUID-addressed per-quiz storage, SQLite metadata,
scoped upload/list/delete/content API and a simple Admin media panel with confirmed
deletion and status/error feedback. Validation covers supported extension/MIME/signature,
file limits, quiz ownership and missing referenced files. Ordered question references
and Matching image IDs persist and freeze with a safe media manifest. Duplication
copies/remaps owned media; started games retain independent session copies after
source edits/deletions and restart. Focused tests cover all supported extensions,
path traversal, isolation, missing files, reference preservation, duplicate/Start
rollback and restart, alongside Phase 5 regressions.

Phase 6B implements question attach/remove/reorder controls and Matching
bilingual text/image selectors with previews. Screen renders ordered normal
image/GIF media; Host has previews and Player receives only interactive Matching
images. Room-scoped content serving validates the frozen manifest and session
files, survives source deletion/restart, and fails safely for missing/broken files.
Responsive images preserve aspect ratio. Focused editor, rendering, projection,
reconnect/restart and ownership/path isolation tests cover this boundary.
Audio/video playback and Host media controls are implemented in Phase 6C below.
Pre-timer execution remains deferred to Phase 6D. A local Chrome smoke decoded frozen JPG/GIF after source deletion
and rendered mixed Matching at 390×844 without horizontal overflow. The GIF fixture
was static; animation and physical device acceptance are not claimed.

Phase 6C adds frozen audio/video streaming with byte ranges, Screen-only playback
in authored media order, and Host Play/Pause/Restart controls by stable media ID.
SQLite playback positions and playing flags are authoritative and broadcast after
commit through room state. Starting another playable item pauses the previous
item. Host/Screen reload, socket reconnect and server restart restore playback;
source deletion does not affect session copies. Player receives no normal media
URLs or controls. Focused server/UI tests cover controls, ordering, isolation,
recovery, timer independence and image/GIF regressions. A local headless Chrome
smoke decoded MP3/MP4, exercised Host controls and audio-to-video exclusivity,
and restored a paused position after Host/Screen reload and source quiz deletion.
Fixtures are short; physical TV speakers and phone/Wi-Fi acceptance remain pending.

Phase 6D implements ordered `playBeforeTimer` audio/video within the existing
QUESTION lifecycle. The durable current-media cursor gates ANSWERING and Submit;
Screen completion reports are room/question/media/revision checked atomically.
Manual/disconnect Pause freeze media alongside the timer; Resume, Wait and
Continue restore the frozen state with existing question exclusions. Replay and
Host media controls cannot extend an ANSWERING deadline. Focused tests cover
mixed ordering, completion races, restart/reload, pause resolution and deadline
precedence. A local Chrome smoke exercised ordered MP3/MP4 completion into
ANSWERING, pre-timer and ANSWERING Pause/Resume, media replay and Screen reload.
An EOF seek issue found with the short MP3 fixture was fixed and rechecked.
Autoplay was enabled for this smoke; physical phone/TV/Wi-Fi acceptance remains
pending. Phase 7A is described below.

Acceptance: image, audio, video and multi-media questions work on the home LAN.

## Phase 7 — Theme system + Halloween

Phase 7A implements the bundled manifest/config boundary, canonical Default theme
and safe fallback for unavailable IDs and missing configuration tokens. Shared
components consume scoped presentation tokens across the Admin quiz editor and
existing media previews, Host, Screen and Player, including all game phases.
Theme selection remains quiz-level; Start freezes the ID, room projections use
that frozen value, and editor changes cannot affect started games. Unknown IDs
remain durable/editable while rendering Default; the selector offers installed
themes only. Legacy snapshots missing a theme ID remain playable as Default.
Focused server/UI regressions cover selection, fallback, frozen projections,
realtime reconnect, source deletion, restart and unchanged scoring. No theme
builder, uploads, sounds or dedicated Preview modes are included.

Phase 7B remains pending: implement Halloween through the same presentation
boundary and verify Default/Halloween behavior parity. Halloween is not installed
or implemented by 7A. Dedicated Preview modes remain Phase 8.

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
