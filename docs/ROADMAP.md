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
Matching image authoring/rendering is implemented in Phase 6B.
This completes Phase 5's non-media acceptance; physical phone/Wi-Fi smoke remains
pending. Phase 6A storage foundations are described below.

Scope:
- Yes/No
- Multiple Choice
- configurable correct-count hint
- Matching using tap-left/tap-right UX
- matching image elements — implemented in Phase 6B
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
Phase 6D implements pre-timer execution. A local Chrome smoke decoded frozen JPG/GIF after source deletion
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

Phase 7B adds bundled `halloween` through the existing manifest and partial token
configuration only: cream backgrounds, aubergine text and burnt-orange controls,
with Default font/correctness fallbacks and no external assets or sounds. Admin
offers both installed themes. Existing shared surfaces cover Lobby, Round Intro,
Question/Answering, Pause, Reveal, Round End, Leaderboard, Final/Winner and Player;
responsive and image/video/Matching layout rules remain unchanged. Focused coverage
checks installed resolution, selector switching, every major surface in both themes,
unknown/missing IDs, optional configuration inheritance and text/control contrast.
Server parity checks retain frozen Halloween after source edits/deletion and
reconnect/restart, scoring, frozen video serving and media controls without deadline
changes. All 348 automated tests, typecheck, build and diff checks passed.
A local Chrome smoke at 390×844 (Host/Player) and 1920×1080 (Screen) exercised
Lobby, Round Intro, image/video question decoding, Answering, Reveal/reload,
Matching images and submission, Pause/Resume, Leaderboard, Final and Winner.
The two correct submissions scored 3 + 2 points. No horizontal overflow was found;
images retained contain fitting. Source selection changed to Default after Start,
while all three room surfaces retained Halloween after Player reload. The existing
missing favicon produced a 404; physical phone/TV/Wi-Fi acceptance remains pending.
Dedicated Preview modes and the remaining Phase 8 features are implemented below.

Scope:
- Default theme
- theme manifest
- fallback behavior
- Halloween theme
- themeable Lobby/Round/Question/Reveal/Leaderboard/Winner/Player surfaces

Acceptance: same quiz can switch Default <-> Halloween without behavior changes.

## Phase 8 — Preview, Test Game, import/export and polish

Phase 8A adds Admin visual previews for the selected editable question: RU Player,
EN Player, bilingual Screen and Host, each with Answering and separate Reveal.
Shared question, Player answer/Reveal, media, countdown display and theme components
render live editor state, including unsaved edits, option text, Matching text/images
and ordered question media. Default/Halloween and normal unavailable-theme/media
fallbacks apply. Player answering projections omit correctness and normal question
media; Reveal shows current correct options/pairs with a labeled unanswered sample
result. Timers stay frozen, Submit remains local, Screen audio/video has local browser
controls and Host media commands are disabled. Preview creates no room, session,
player, submission, score or history and requires no realtime connection.
Focused regressions cover all modes/states, both languages/themes, fallback,
Matching/media, projection boundaries, timer/transport isolation and immediate edits.
A local Chrome smoke exercised RU/EN answering, local Submit, Screen/Host correctness,
Matching text/image content, bilingual Reveal, Default/Halloween switching and live
source edits. PNG, MP4 and MP3 decoded through editable-media URLs. The isolated
smoke database retained zero gameplay records. Physical phone/TV/Wi-Fi acceptance
remains pending.

Phase 8B implements Admin Start Test Game using the ordinary real Lobby/Host/
Screen/Player flow. Migration 24 persists a boolean session marker (`is_test`,
projected as `isTest`); existing and normal rooms default to false. Host and Screen
clearly label tests. Readiness, Start-time frozen content/media/roster, phones,
timers, media, reconnect, disconnect handling and scoring reuse the real engine.
Phase 8D implements the default completed-game history query with `is_test = 0`; import/export is implemented in 8C. Startup opportunistically
cleans only tests closed for at least seven days (inclusive, measured from UTC
closure), including frozen media and dependent gameplay rows. Open tests and all
real sessions are retained. Focused regressions cover creation/readiness, durable
marker, real/test parity, source deletion, frozen media, reconnect/restart/scoring,
retention cutoff, open games and source/real-session isolation. All 361 automated
tests, typecheck, build and diff checks passed. A local Chrome smoke used a
390×844 Player with Host and Screen: Admin launch, normal join, timer, refresh
and disconnect Pause/Wait, accepted Submit (+3), Reveal/reload, final results,
Winner and confirmed closure. Frozen JPG decoded after source quiz deletion;
Host/Screen retained the Test Game label. No Player horizontal overflow was found.
The existing missing favicon produced a 404. Physical phone/TV/Wi-Fi acceptance
remains pending.

Phase 8C implements portable editable quiz export/import. Version-1 ZIP archives
contain a strict JSON manifest and all quiz-owned image/GIF/audio/video files,
with checksums and no gameplay/history or frozen session data. Import validates
bounded ZIP structure, paths, duplicate/conflicting entries, manifest/V1 content,
media signatures/sizes/hashes and every reference before publishing a new Draft.
Fresh UUIDs remap all content and media relationships; ordinary failures roll back
SQL and remove new media/staging trees. Unknown theme IDs survive and use the
existing Default fallback with an Admin warning. Admin list/editor Export and list
Import provide feedback and a direct edit link. Focused tests cover all four types,
bilingual settings, ordering, Matching images, media flags, IDs, malicious archives,
rollback, theme fallback and gameplay isolation. Source-independent HTTP smoke
exports after source edits, deletes the source, imports, edits and starts a fresh
game. All 369 tests, typecheck, build and diff checks passed. An isolated Chrome
Admin smoke downloaded ZIP, deleted the source quiz/media, imported with a missing
theme warning, opened the new Draft, saved edits and opened its Host lobby. The
existing favicon 404 was the only browser console error. Physical phone/TV/Wi-Fi
acceptance remains pending. Completed-game history/UI follows in Phase 8D below.

Phase 8D implements minimal completed-game history. Migration 25 preserves original
quiz identity and frozen title at Start independently of the editable source.
The first Final Results transition atomically records an immutable UTC completion
timestamp and final roster IDs/names/total points from existing competition scores;
removed/non-roster players are excluded. Winner, Close, reconnect and restart do
not rewrite completion. Closed/abandoned incomplete games stay outside history.
`GET /api/history` explicitly requires `is_test = 0` and a completion marker,
orders newest first and returns at most 100 minimal records. No answers,
correctness, per-question scores, snapshots, media, tokens or language enter the
history record/API. Admin History shows quiz title/date and final scores with a
clear empty state. Source rename/deletion and restart preserve recorded history;
seven-day Test Game cleanup is unchanged. Pre-8D completion dates cannot be
reconstructed, and deleted pre-8D source IDs remain unavailable rather than guessed.
Focused tests cover completion uniqueness, timestamp stability, participant/score
boundaries, Test Game exclusion/cleanup, incomplete closure, deletion/restart,
transaction rollback, migration and UI empty/populated/error states. All 377 tests,
typecheck, build and diff checks passed. An isolated Chrome Admin smoke verified
empty/populated states, Test Game exclusion, source deletion, final scores (3/0)
and unchanged date/identity/scores after server restart. Phase 8E completes local acceptance and polish below; physical phone/TV/Wi-Fi acceptance remains pending.

Scope:
- Preview modes
- Test Game marker/cleanup
- self-contained ZIP export/import
- minimal real-game history
- layout warnings / limits
- final browser/device pass on current Safari iPhone + Chrome Android

Acceptance: party rehearsal from clean start succeeds without developer intervention.

### Phase 8E — final local V1 acceptance

Implemented confirmed Host Kick using the existing removal marker, including
fixed-roster/completion/leaderboard filtering, immutable accepted records, shared
disconnect resolution, pre-timer recovery and realtime token/tab revocation.
Kick is unavailable after completion so final standings match immutable history.
The full spec audit also closed missing Lobby rename, live RU/EN switching, Host
presence/timer progress, bilingual Reveal explanations and optional round art.
Content additions reuse existing readiness, snapshots, media and archive boundaries.
Local favicon, empty/disabled states, phone wrapping, Preview guidance and stale
operator/implementation wording are polished without redesign.

Automated/local Chromium V1 acceptance is complete. The full required tests,
typecheck, build and diff checks are recorded in `docs/V1_ACCEPTANCE.md`; its local
rehearsal covers all question types, two Player contexts, reliability/removal,
media, Preview/Test Game, final/history and browser ZIP round-trip. `README.md`
contains install/start, LAN URLs, TV/audio/autoplay and backup operating instructions.

Real-hardware acceptance remains **pending**: current Safari iPhone/Chrome Android,
actual Wi-Fi loss/load, real TV picture/sound/mirroring, actual media codecs and
animated GIF/autoplay, offline party rehearsal and backup restore. Use the exact
seven-item checklist in `docs/V1_ACCEPTANCE.md`. No physical test is claimed.
