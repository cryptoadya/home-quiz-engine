# Architecture v0

This document defines the local service and state boundaries. Historical phase notes record how those boundaries evolved; Phase 8E below records current V1 acceptance.

## One local application

Run one local service on the host computer. Guests connect over the same Wi-Fi network.

Logical pieces:

- `apps/web` — React UI for Admin, Host, Screen, Player
- `apps/server` — Express API + Socket.IO + SQLite access + local media serving
- `apps/web/src/themes` — bundled presentation manifests/configuration
- `data/quizzes` — local per-quiz media/data area at runtime (gitignored)

No microservices.

## State ownership

Server is authoritative for:

- active game session and phase
- fixed player roster after Start Game
- online/disconnected state
- timer deadlines / remaining time
- accepted Submit events
- scores
- pause/resume
- reveal and navigation state
- room code ownership

Clients render server state and send intents.

## HTTP vs realtime

Use HTTP for slow CRUD:

- quiz editor CRUD
- round/question edits
- media upload/delete
- import/export
- history reads

Use Socket.IO for active-session events:

- player join/reconnect/disconnect
- room/session state broadcasts (including Start Game)
- Start Round state broadcast (HTTP action persists first)
- media control
- timer/pause/resume
- submit updates (HTTP accepts the final answer)
- answered count
- reveal
- next question/round
- leaderboard/final/winner

## Database

SQLite is enough. Start with a small schema; do not normalize for hypothetical scale.

Expected entities:

- quizzes
- rounds
- questions
- answer_options / matching_pairs
- media
- game_sessions
- session_players
- session_answers (active-session durability only; detailed historical analytics are not a requirement)

## Quiz snapshot

Lobby references the editable quiz. `POST /api/rooms/:roomId/start` runs one SQLite
`BEGIN IMMEDIATE` transaction: require an existing active Lobby, revalidate the
persisted quiz, require at least one active player, create the snapshot, mark the
Start-time roster, and transition to `ROUND_INTRO`. Failure rolls everything back;
repeat Start returns 409. Start initializes the first frozen round.

`game_sessions.snapshot_json` stores a version-1 typed quiz tree, with ordered
rounds, questions and options (including correctness), quiz settings and original
IDs, but no editor timestamps or content foreign keys. The internal
`getGameSnapshot(db, sessionId)` parses/validates this durable JSON and reads no
editor tables. Future gameplay must use this boundary exclusively. Public room
metadata uses the frozen title after Start and never exposes the snapshot or
correctness through room, reconnect, or realtime payloads.

`roster_locked_at` records Start; `session_players.in_roster` marks only players
active in that transaction. These existing rows retain their reconnect tokens.
New joins fail after Start; roster members can reconnect and receive the current
state. Closure still uses `closed_at` and is allowed after Start.

Migration 6 changes the source `quiz_id` FK to nullable `ON DELETE SET NULL`.
Deleting an editor quiz deletes its Lobby sessions (the previous behavior), via a
trigger, but preserves started sessions, frozen content and player identities.
The parent-table rebuild temporarily disables FK enforcement outside the migration
transaction, checks all foreign keys before commit, then restores enforcement.

## Lobby foundation (Phase 2A)

Opening a Lobby creates a durable `game_sessions` row referencing the editable quiz;
no content is copied or frozen until the Start Game boundary revalidates it. Host reloads read the session
from SQLite. Multiple Lobbies may reference one quiz.

Sessions begin in `LOBBY`; a nullable `closed_at` records closure
without adding a gameplay state. Closing is idempotent. Five-character codes use
`ABCDEFGHJKMNPQRSTUVWXYZ23456789`, with a partial unique index for active sessions
and bounded collision retries. Closed sessions remain accessible by ID, but not by
code; their codes can be reused. Deleting a quiz removes its Lobby sessions; started games survive.

HTTP endpoints: `POST /api/quizzes/:quizId/rooms`, `GET /api/rooms/:roomId`,
`GET /api/rooms/code/:code`, and `POST /api/rooms/:roomId/close`. Code lookup trims
whitespace and accepts lowercase. Creation returns 409 with readiness validation
problems for a draft, 404 for a missing quiz, or 503 if code allocation is exhausted.
Room responses contain metadata and the current Lobby or frozen game title, never question answers.
Admin opens `/host/:roomId`; `/host` remains the general Host entry route.

## Media

Each quiz owns its own copied media. No cross-quiz dedup/reference counting in V1.

## Themes

Phase 7A adds a small bundled manifest/config boundary in `apps/web/src/themes`.
The manifest records id/name/version/author/resources/features; Default has no
external resources or optional features and uses the existing system font, palette
and layouts. Configuration supplies semantic CSS tokens, independently of game
logic. `resolveTheme` selects an installed theme and fills missing/empty tokens from
Default. Unknown, empty or missing IDs resolve to Default without changing the
requested ID. Phase 7B installs `halloween` alongside `default` in the same registry.
Halloween's version-1.0.0 manifest identifies Home Quiz Engine as author and has
empty resources/features lists. Its partial token configuration uses warm cream
backgrounds, aubergine text/borders and burnt-orange controls. Font and correctness
colors inherit Default through the resolver; no image/font/network resource is
required for rendering. Missing optional configuration retains Default behavior.
Normal text, muted text, controls and correctness text have at least 4.5:1 contrast.
No uploads, theme builder, sound system or dynamic resource loader is introduced.

`ThemeSurface` scopes configuration to the existing Admin quiz editor (including
its question/Matching media previews), Host, Screen and Player roots. The existing
Round/Question/Reveal/Leaderboard/Winner, media and answer components inherit the
same tokens; there are no gameplay component forks. Admin's theme selector lists
installed manifests. An unavailable saved ID remains visible with a Default
fallback notice, survives unrelated edits, and can be replaced with Default.
Quiz-list names also use the resolver. The selector offers Default and Halloween,
with no per-surface selection. Both palettes use the same spacing, sizing, phone/TV
breakpoints, focus/selection states, media fit rules and Matching layouts. There
are no theme conditions in game, answer, timer or media components or server logic.
Dedicated Preview modes are described in Phase 8A below.

Quiz settings accept bounded nonempty string IDs independently of installed
presentation code, so unavailable IDs remain editable and durable. Room metadata
adds only `themeId`: Lobby reads the current editable quiz; every started state,
HTTP reload, authenticated Player reconnect and realtime subscription reads the
frozen snapshot ID, even after source edits/deletion or server restart. Start
continues freezing the ID inside its existing transaction. Legacy version-1
snapshots with missing/null theme IDs are interpreted as Default without rewriting
durable JSON; unknown strings are retained. Theme fallback does not relax other
snapshot validation or alter timers, membership, answers, scoring or information
boundaries.

## Realtime Lobby (Phase 2C)

Express and Socket.IO share one HTTP server. HTTP join/close mutations persist
first, then publish current SQLite state. `GET /api/rooms/:roomId/lobby` returns
`{ room, players }` for initial Host/Screen reads, including closed rooms. Existing
room, player roster, join and identity restoration endpoints remain available.

Socket protocol:
- Client `lobby:subscribe`: `{ roomId, audience: 'host' | 'screen' | 'player' }`.
  Player additionally supplies `token`, validated by the same room-scoped identity
  and locked-roster rules as HTTP reconnect. Failed authentication joins no channel.
  Validates the ID and room existence; replaces the socket's previous subscription.
- Server `lobby:state`: `{ room, players, game }` for Host/Screen, `{ room }` for Player.
  Host and Screen use separate audience channels; `game` is an audience-specific projection.
  `room.closedAt` communicates closure. Player entries use the public HTTP roster
  fields only: `id`, `name`, `language`, `joinedAt`.
- Server `lobby:error`: `{ error }` for invalid or nonexistent subscriptions.

Each subscribe/reconnect reads a fresh SQLite snapshot and joins a room-ID-scoped
channel in one synchronous turn using the local Socket.IO adapter. This avoids a
snapshot/subscription gap; clients never replay event history as durable state.
Host/Screen also load an HTTP snapshot, discarding it if a newer socket snapshot
arrives first. Player subscribes only after HTTP join/identity restoration, and
sends its reconnect token only in the Player subscription payload. It is never
broadcast, logged or used as a channel name. Host/Screen surface selection remains
a payload boundary, not organizer authentication, in this trusted LAN application.

Player clears a previous question/reveal projection when realtime metadata changes
phase or closes the room. Authenticated HTTP refreshes are discarded when a newer
realtime invalidation or identity request supersedes them; same-phase refreshes
preserve accepted-answer controls while the current projection is fetched.

Screen QR codes are generated locally and use the browser origin with the same
room code and `?lang=ru` / `?lang=en`. Opening Screen on loopback displays a LAN
address warning. Start Game publishes the new state through the same `lobby:state`
channel after commit. Host confirms the content/roster lock and shows Round Intro;
Screen removes the Lobby QR/join UI; Player replaces waiting text with a localized
round-starting message. Refresh and socket reconnect load current durable state.

## Gameplay foundation (Phase 3A)

Migration 7 adds zero-based `current_round_index` and `current_question_index`
to `game_sessions`, addressing the frozen snapshot. Lobby has both null; `ROUND_INTRO` has a round index
and null question index; `QUESTION` has both indexes. Existing started sessions
migrate to round 0 with no current question; snapshot JSON and roster remain intact.

`POST /api/rooms/:roomId/start-round` atomically transitions an open `ROUND_INTRO`
to `QUESTION`, question index 0, after validating the snapshot/current round.
Invalid state, closed rooms, or invalid content return conflict. No timer starts.

`game.ts` centralizes navigation and allowlisted projections, reading gameplay
content only via `getGameSnapshot`. Host receives current round/question content,
points, effective answer duration and correctness. Screen receives bilingual
current content and ordered option text only when enabled; Player receives only
safe room state. Neither Screen nor Player receives correctness, full snapshots,
or future questions. This retains the trusted-LAN surface-selection boundary;
it does not introduce organizer authentication.

`GET /api/rooms/:roomId/game/host` and `/game/screen` restore each surface from
SQLite. The existing `lobby:state` protocol broadcasts projections after commit
and resends them on subscription/reconnect. Player's authenticated HTTP reconnect
restores its safe state. Closed-room behavior takes precedence. Phases 3B–3D extend this foundation with Answering, timers, submissions and
Reveal and post-Reveal navigation below.

## Answer timer (Phase 3B)

Migration 8 adds `ANSWERING`, `answer_started_at` and `answer_deadline_at` (UTC ISO
timestamps). Existing navigation, snapshots and roster survive unchanged with null
timers. SQLite requires valid, ordered timestamps for Answering; migration 10
also retains these timestamps in Reveal. Other states require null timers.

`POST /api/rooms/:roomId/start-question` runs one `BEGIN IMMEDIATE` transaction:
require an open `QUESTION`, resolve the current frozen question and its override
or snapshot default duration, persist server start/deadline, and enter `ANSWERING`.
Only after commit does it broadcast. Repeats return 409 and cannot reset the timer.
`timer.ts` centralizes duration, deadline and expiry calculations with explicit
`now` inputs. Expiry is computed as `now >= deadline`, with remaining milliseconds
clamped to zero. Phase 3B only calculated expiry; Phase 3D adds authoritative completion and
scheduled wakeups below.

Host/Screen projections carry `serverNow`, `deadlineAt`, `durationSeconds`,
`remainingMs` and `expired`. Clients anchor server time to a monotonic browser
clock, refresh the display every 250ms, and resync on new server projections.
This display cannot authorize future submissions. Reload/reconnect reads the same
SQLite deadline; it never starts or extends it. Closed state takes precedence.

Player sockets still carry only safe room metadata. On Answering updates or
socket reconnect, Player refetches the existing HTTP `POST /reconnect` using its
stored token; initial reload uses that endpoint too. The server validates the
room-scoped token and locked roster before returning `game`: only current frozen
question ID, selected-language text, ordered option IDs/text and timer metadata.
Phase 4B also authenticates Player socket subscriptions using this same token. Host/Screen retain the existing trusted-LAN
surface boundary (not organizer authentication); no generic Player content
endpoint is added. Screen options still depend on `showOptionsOnScreen`, and
neither Screen nor Player receives correctness, future content or the snapshot.
Phase 3B initially renders noninteractive choices; Phase 3C adds selection and Submit below.

## Final Single Choice submission (Phase 3C)

Migration 9 adds `player_answers`, keyed by `(session_id, question_id, player_id)`.
It stores only frozen question/option IDs and the server submission timestamp;
there are no draft choices, correctness, scores or synthetic timeout rows. These
active-session records belong to the durable player identity, not a connection.
Existing sessions, snapshots, roster and deadlines are untouched.

`POST /api/rooms/:roomId/answers` accepts `{ token, questionId, optionId }` over
HTTP. One `BEGIN IMMEDIATE` transaction verifies the open Answering session,
room-scoped token, locked roster, current frozen question and option membership.
After obtaining the write lock and validating, it samples server time immediately
before insertion and requires `now < answer_deadline_at`. Commit precedes any
broadcast. A valid retry returns the original accepted option even with a different
valid option or after the deadline; it never updates the row or increments counts.
Malformed, unauthorized, noncurrent-question or invalid-option retries still fail.

`answers.ts` centralizes submission lookup and counts. Host/Screen receive only
`answers: { answered, expected }`, where expected is the locked roster size.
Player sockets still carry only room metadata; token-authenticated reconnect adds
only that player's `submission: { submitted, optionId? }`. Player keeps its draft
selection locally, locks after acknowledgement/restoration, and disables Submit
when its displayed countdown reaches zero. The server remains authoritative.
Existing Host correctness display is unchanged; Player/Screen receive no
correctness or individual answer mappings.

Every new acceptance broadcasts updated state after commit. Phase 3D adds
completion and scoring to this transaction; later slices add navigation and
authenticated disconnect handling below.


## Automatic Reveal and scoring (Phase 3D)

Completion is `answered === expected OR serverNow >= answer_deadline_at`, with
expected responders equal to `session_players.in_roster = 1`. A new accepted
submission checks completion inside its existing `BEGIN IMMEDIATE` transaction.
The deadline manager checks in its own write transaction. Both require the same
open `ANSWERING` question; subsequent attempts are no-ops. Accepted retries still
return the original selection in Reveal. New submissions require server time
strictly before the deadline after acquiring the write lock. Thus a pre-deadline
acceptance counts, an exact-deadline submission fails, and scores cannot commit
without the Reveal transition (or vice versa).

Migration 10 adds `ANSWER_REVEAL` and `question_scores`, uniquely keyed by
`(session_id, question_id, player_id)`. Completion inserts one result for every
locked-roster player: `correct`, `wrong`, or `unanswered`, plus integer
`awarded_points`. Correct answers earn the frozen question's points; all others
receive zero. No synthetic answer rows are inserted. Correctness comes only from
the frozen option ID, never editor data or client claims. These active-session
rows support later `SUM(awarded_points)` totals; they are not detailed game history.
Reveal leaves both navigation indexes and the original start/deadline timestamps
unchanged. The UI stops showing the countdown; retained timestamps are context,
not an active timer. Phase 3E clears these timestamps on the next navigation transition.

`deadlines.ts` owns cancellable in-process timeouts scheduled from persisted
deadlines. A wakeup re-reads SQLite and checks question identity, closure, state
and current server time; early wakes reschedule. SQLite remains authoritative.
`createQuizServer` recovers open Answering sessions before serving requests,
completes overdue/all-answered sessions immediately and schedules the rest.
Mutations resync the affected timer; Reveal/closure cancel it, stale callbacks
are ignored, and shutdown clears timers. Clock/scheduling dependencies allow
deterministic recovery tests without waiting real durations.

Broadcasts occur after commit. Host sees bilingual content, correct option,
question points and aggregate answered/correct/wrong/unanswered counts. Screen
receives correctness only in Reveal and then shows all options even when
`showOptionsOnScreen` is false; neither surface receives per-player selections.
Player sockets still carry only safe room metadata. A Reveal event invalidates
the authenticated HTTP reconnect projection, which returns only that token's
selected option, correct option ID, localized content and durable personal result
with earned points. RU/EN result UI has no rank or answer controls. Refresh and
reconnect restore the same persisted result; closed-room display takes precedence.
The existing trusted-LAN Host/Screen surface boundary is unchanged.


## Post-Reveal navigation (Phase 3E)

Migration 11 adds `ROUND_END`, `LEADERBOARD`, `FINAL_RESULTS` and `WINNER_SCREEN`
without changing snapshots, roster, submissions or scores. Each completed-round
boundary retains the final question index; `ROUND_INTRO` has a null question index.
All non-answer states have null timer fields.

Explicit HTTP commands `next`, `show-leaderboard`, `next-round`, `final-results`
and `show-winner` validate the open session and frozen indexes/configuration in
`BEGIN IMMEDIATE`, persist atomically, then broadcast through `lobby:state`.
After Reveal, `next` enters the following `QUESTION` without starting its timer,
or `ROUND_END` on the last question. Round End presents the completed round title;
it enters Leaderboard only when the frozen `showLeaderboardAfter` is enabled.
Next Round increments the frozen round index and enters Round Intro. The final
boundary deliberately enters Final Results; only Show Winner enters Winner Screen.
There is no automatic return or reset.

`getLeaderboard` sums durable `question_scores.awarded_points` for fixed-roster,
non-removed players, including zero-score players. It sorts by total descending,
then joined timestamp/player ID for deterministic rendering; equal totals share
competition rank (`1, 1, 3`) without a tie-break. Final Results uses all score rows;
Winner Screen shows every rank-1 player. No mutable running total is stored.
Host receives the valid next command; Screen presents standings/winners. Player
receives simple localized boundary messages, with no personal per-question rank.
HTTP reload and socket subscription rebuild each state from SQLite, snapshot and
scores. Closed rooms override all views and reject every navigation command.

## Durable manual Pause / Resume (Phase 4A)

Migration 12 adds `PAUSED`, `paused_from_state`, `paused_at` and
`paused_remaining_ms`. Manual Pause is allowed from `ROUND_INTRO`, `QUESTION`,
`ANSWERING`, `ANSWER_REVEAL`, `ROUND_END`, `LEADERBOARD` and `FINAL_RESULTS`;
Lobby, Winner Screen and closed rooms cannot pause. SQLite requires pause metadata
only in PAUSED, positive integer remainder only for paused Answering, and indexes
consistent with the underlying state. Snapshot, roster, answers and scores are
unchanged. Reveal timer timestamps remain completed-question context even while
paused; pausing Answering clears both active timer timestamps.

Explicit HTTP `pause` and `resume` commands acquire `BEGIN IMMEDIATE` and
broadcast only after commit. Pause samples server time after reading the persisted
deadline. Existing completion wins at `now >= deadline` (or all answers accepted):
the shared completion helper commits Reveal/scoring, the Pause request returns
409, and the committed Reveal is broadcast. Otherwise Pause stores the positive
remaining milliseconds. Non-timed Pause simply preserves the previous state.
Resume restores that state and clears pause metadata; for Answering it sets start
time to resume time and deadline to resume time plus the frozen remainder.
Projected timer duration therefore describes the resumed segment, including
fractional seconds, rather than the original configured duration.

The existing deadline manager resyncs after each committed command: PAUSED cancels
the old wakeup, stale callbacks cannot complete it, and Resume arms the new persisted
deadline. Startup only recovers open ANSWERING sessions, so paused wall-clock time
is never consumed. Reload/reconnect reads PAUSED directly from SQLite. Host shows
Resume in place of progression controls; Screen shows `Пауза / Paused`; Player
shows localized pause without answer controls. Player content is fetched again on
resuming Answering. All Submit requests during Pause (including retries) return
conflict; accepted answers remain stored and reconnect restores them after Resume.
Normal navigation rejects PAUSED. Close remains available, overrides presentation,
and prevents Resume. Phase 4B extends this model with automatic disconnect Pause below.


## Authenticated Player presence / disconnect Pause (Phase 4B)

Each server runtime tracks authenticated socket IDs in sets keyed by room/player.
Multiple tabs count as one present Player: only removal of the last socket invokes
`autoPauseForDisconnectedPlayer`. Disconnect and subscription replacement share
cleanup; repeated subscription to the same identity preserves presence. Host and
Screen sockets never count as Player presence. Reconnect authenticates again.
Presence starts empty on restart; startup absence never synthesizes disconnects.
Socket IDs remain ephemeral and never enter SQLite or broadcast payloads.

The helper acquires `BEGIN IMMEDIATE`, requires an open ANSWERING session and
fixed-roster membership, and checks the current frozen question's accepted answer.
An unanswered Player's pre-deadline disconnect reuses the manual Pause transaction
and freezes the remaining time. Other states and existing pauses are unchanged.
Shared completion/scoring wins at or after the deadline. Submit-first leaves the
accepted answer durable and does not pause; Pause-first rejects a later Submit.
SQLite write-transaction ordering decides these races. A changed state resyncs the
deadline manager and broadcasts only after commit; stale callbacks cannot Reveal
PAUSED. No change means no broadcast.

Migration 13 adds `pause_reason` (`manual` or `player_disconnect`) and nullable
`paused_player_id`, with CHECK constraints requiring coherent metadata only in
PAUSED. Existing manual pauses migrate to `manual` with no player ID. The helper
verifies player/session roster membership within the same transaction. Resume
clears both fields. Host alone receives reason and disconnected player ID/name
alongside paused-from state and frozen time; Screen remains generic Paused and
Player receives safe room metadata, rendering its localized Pause without answers.
Durable metadata survives refresh/restart. Reconnect never resumes the game;
Phase 4C adds Host resolution controls below; Phase 8E implements Kick through the same membership and pause boundaries.


## Host disconnect-pause resolution (Phase 4C)

Migration 14 adds `question_exclusions`, keyed by `(session_id, question_id,
player_id)`, as active-session reliability state. Expected responders are the
fixed roster minus exclusions for the current frozen question; answered counts
include accepted submissions from those responders only. Exclusions survive
restart and never change `in_roster` or reconnect tokens. The next question has
a different ID, so normal participation returns without deleting exclusions.
Excluded Players receive `excluded: true`, no answering options, localized waiting
UI, and a server-side Submit conflict. Their disconnect cannot auto-pause that
question. Reveal still scores every roster member; excluded Players get
`unanswered` / zero points without a synthetic answer row.

Explicit `wait-for-player` and `continue-without-player` HTTP commands each acquire
`BEGIN IMMEDIATE`, validate the open disconnect Pause, frozen question, roster,
positive remainder and absence of an accepted submission/exclusion, and clear all
pause metadata on success. Generic `resume` accepts manual Pause only. Wait checks
an injected room/player presence function, backed by the realtime runtime's
socket sets; the default for direct `createApp` usage is absent. Reconnection
alone never resumes. Wait restores Answering with `now + frozen remainder` and
leaves expected responders unchanged.

Continue requires Host confirmation and inserts only the current-question
exclusion. If remaining expected responders have all submitted, shared scoring
transitions directly from PAUSED to ANSWER_REVEAL in the same transaction, without
creating a deadline. Migration 14 permits null timer context for this direct
Reveal (including a subsequent manual Pause of it); ordinary Reveal retains its
existing timestamps. Otherwise Continue restores Answering with the frozen
remainder. After commit, both actions broadcast and resync the deadline manager;
direct Reveal cancels scheduling. Closure overrides all controls.

The runtime supplies the same presence checker to HTTP and Host projections.
Host's disconnect-Pause projection includes `disconnectedPlayer.present`.
First authenticated socket arrival and last socket departure refresh the Host
projection while paused, without changing SQLite. Multiple tabs remain present
until the last socket leaves. Screen/Player receive no presence details. Host
shows only Wait for Player and Continue Without Player for disconnect Pause, and
only Resume for manual Pause.

## Yes / No questions (Phase 5A)

Persisted question types are `single_choice` and `yes_no`. Yes / No uses the existing
`answer_options` table with exactly two options and one correct answer; readiness
and the schema-version-1 snapshot parser independently enforce that shape.
Both types share the single-select submission, deadline, disconnect recovery,
Reveal and full-points scoring pipeline. Type conversion keeps the first two
option IDs/texts, fills blank labels with Да/Нет and Yes/No, preserves a retained
correct option (otherwise selects the first), and removes extra options atomically.
Converting back to Single Choice preserves both rows.

## Multiple Choice questions (Phase 5B)

Migration 16 adds `multiple_choice` to persisted question types. Readiness and
version-1 frozen snapshots require 2–10 options and at least two correct options.
The editor toggles correctness independently; conversion preserves options,
with the existing Yes / No normalization still applied when converting to it.
The required correct-option count was always shown in Phase 5B; the Phase 5 completion setting below makes it optional.

Migration 17 replaces `player_answers.option_id` with `option_ids_json`, copying
legacy answers into one-element arrays without changing identity, timestamps or
answer keys. New submissions store sorted, distinct frozen option IDs. The HTTP
contract retains `optionId` for Single Choice / Yes-No and uses `optionIds` for
Multiple Choice; authenticated reconnect restores the corresponding accepted
shape. Empty, duplicate, foreign or malformed sets fail even on retries. Valid
retries return the original immutable set, including after Reveal/deadline.

Player uses editable checkboxes and enables Submit with any nonempty selection.
Before Reveal its projection includes only safe localized options, required count,
its own submission and the existing timer. Reveal adds `correctOptionIds` and the
personal result. Scoring compares the complete submitted set to the frozen correct
set: exact equality earns full points; every other set earns zero. Existing answer
row counts, timers, Pause, Wait/Continue, exclusions and navigation are reused;
excluded/unanswered roster members still receive zero. Gameplay never reads the
editable source, including after source deletion.

## Matching authoring (Phase 5C)

Migration 18 adds canonical `matching` questions and dedicated `matching_pairs`
rows with stable IDs, durable position, cascading question ownership and JSON
left/right sides. Each side is a discriminated `{ kind: 'text', textRu, textEn }`
or `{ kind: 'image', mediaId }` value. Image references reserve the Phase 6 media
boundary; this phase only authors and accepts bilingual text.

Admin offers autosaved RU/EN side fields and pair add/delete/reorder via scoped
`/api/quizzes/:quizId/rounds/:roundId/questions/:questionId/pairs` CRUD and `/order`.
New Matching questions have two blank pairs. Crossing between Matching and an
option type atomically deletes both old answer structures; entering Matching
creates two blank pairs, entering Single/Multiple Choice starts with no options,
and entering Yes/No creates its usual labeled options. Option-to-option conversion
keeps the existing Phase 5A/5B rules. Inactive answer mutations are rejected.
Quiz duplication copies pairs with new IDs.

Readiness requires at least two complete pairs and RU/EN text of 1–500 characters
per side. Version-1 snapshots add ordered `pairs` for Matching and keep an empty
`options` array. Parsing independently validates side shape, bilingual completeness,
pair count, unique IDs and order, rejecting mixed active structures. Old option
snapshots without `pairs` remain valid. Start freezes values with no content foreign
keys, and later edits/deletion cannot affect them. Player/Screen receive no correct
pair mapping before Reveal; Phase 5D adds playable projections below.


## Matching gameplay (Phase 5D)

Migration 19 generalizes `player_answers` to tagged `answer_json`: option answers
store `{ kind: 'options', optionIds }`, Matching stores `{ kind: 'matching', mapping }`.
Legacy arrays migrate without changing keys, timestamps or accepted choices.
The HTTP option contracts remain unchanged; Matching accepts
`{ token, questionId, mapping: [{ leftId, rightId }] }`. Complete one-to-one
coverage of both frozen sides is mandatory. Malformed, duplicate, foreign or mixed
answer structures are rejected, including on retries. Valid retries restore the
original immutable mapping, canonicalized by left ID, even after Reveal/deadline.

Side IDs are domain-separated SHA-256 identities derived from room, frozen
question/pair ID and side. The pair ID itself is never projected to Player/Screen.
Phase 5D independently ordered each side list by opaque ID. Phase 5 completion
replaces that unconditional ordering with the frozen quiz shuffle setting below.
No pair IDs, shared positions or correct mapping are projected before Reveal. Snapshot side discriminants and
media references remain intact for Phase 6; only text renders in this phase.
Player receives localized sides; Host/Screen receive bilingual content. Host sees
the correct mapping; Screen and Player receive it only at Reveal.

Player taps left then right, may replace either pairing until Submit, and can
submit only after completing every pair. Reassigning an occupied right side
removes its previous pairing. Acknowledgement/reconnect locks and restores the
accepted mapping. Reveal displays the correct pairs and personal outcome/points.
Every mapping must exactly match the frozen correct pairs to earn full points;
partial/wrong, excluded and unanswered submissions earn zero.

Matching uses the existing completion counts, persisted deadlines, automatic and
manual Pause, Wait/Continue, per-question exclusions, restart recovery and
navigation without separate lifecycle machinery. No answer drafts are persisted.


## Phase 5 completion: count hints and answer ordering

Migration 20 adds `questions.show_correct_count`, defaulting to true to preserve
existing Multiple Choice behavior. The editor autosaves `showCorrectCount` per
question; duplication preserves it. Version-1 snapshots explicitly freeze the
boolean. Legacy version-1 snapshots without it retain the enabled behavior, and
invalid non-boolean values are rejected. Older question update requests that omit
the field preserve its current value. Only Multiple Choice uses this setting.
When disabled, Player receives no `requiredCorrectCount` property and renders no
count hint; when enabled, the projection includes the correct-set size as before.
The hint does not constrain Submit: any nonempty set is structurally valid, and
only exact correct-set equality earns points.

`answer-order.ts` computes deterministic presentation order from room ID, frozen
question ID, stable item ID and an ordering-version/domain tag using SHA-256.
It permutes copies of the frozen items without changing the source editor order,
snapshot positions, answer IDs or scoring. The persisted room identity and snapshot
are the complete ordering inputs: every Player receives the same order, including
on refresh, reconnect and server restart. Host/Screen use the same option ordering.
There is no client randomization or dependence on Player identity/language.

The frozen quiz `shuffleAnswers` flag applies to Single Choice, Yes/No and Multiple
Choice options. Matching independently permutes its left and right lists using
separate domains, retaining the opaque side identities and ID-based correct
mapping. When disabled, option lists and both Matching side lists retain authored
snapshot order. For Matching this intentionally retains authored pair alignment;
the correct mapping itself is still withheld before Reveal. Shuffle-enabled lists
are independent permutations and can coincidentally retain some authored positions.

All non-media Phase 5 behavior is implemented. Matching image discriminants/media
references reserve the media boundary. Phase 6A below adds storage and reference
validation; Phase 6B implements image editor controls and rendering.
Cross-type regressions cover hint boundaries, both ordering
modes, frozen settings, two Players, reconnect/restart, exact scoring and Matching
mapping identity; UI regressions cover hint autosave/reload and hidden-hint drafts.


## Media storage and Admin management (Phase 6A)

Migration 21 adds `media` rows with globally unique UUID `id`, exactly one cascading
`quiz_id`, sanitized display `name`, `kind` (image/audio/video), canonical `mime_type`,
`size_bytes` and `created_at`. There are no client-provided paths. Public metadata
uses camelCase and contains only these fields. GIF uses image kind and image/gif MIME.

Storage is relative to the SQLite database directory (normally `data/`):

- `quizzes/<quizId>/media/<mediaId>`: copied quiz-owned originals, extensionless UUID filenames;
- `uploads/<generatedId>`: bounded multipart disk staging, removed on success/failure;
- `sessions/<sessionId>/media/<mediaId>`: independent copies of referenced files frozen at Start.

`QUIZ_DB_PATH` therefore also relocates media storage. Back up the database and its
adjacent quiz/session directories together. Media requires a file-backed database;
non-media tests can continue using in-memory SQLite. These directories are not
public static mounts. Files are addressed only through scoped IDs and checked
metadata, never through uploaded names/paths.

Admin HTTP endpoints:

- `GET /api/quizzes/:quizId/media`: list safe metadata;
- `POST /api/quizzes/:quizId/media`: multipart upload, exactly one `file`, no extra fields;
- `DELETE /api/quizzes/:quizId/media/:mediaId`: delete metadata/file, preserving references;
- `GET /api/quizzes/:quizId/media/:mediaId/content`: quiz-scoped content with canonical MIME and nosniff.

The existing trusted organizer/LAN API boundary applies; this phase adds no public
Player media projection. Upload accepts JPG/JPEG/PNG/WEBP/GIF, MP3/WAV/OGG,
MP4/WEBM, checking extension, declared MIME and detected binary signature. Known
WAV/MP3 MIME aliases normalize to canonical values. OGG audio includes Vorbis/Opus;
video OGG is rejected. Paths, control characters, unsupported types, empty files,
mismatched signatures and oversized files are rejected. Limits are 20 MiB images,
100 MiB audio and 500 MiB video; multipart streams to disk with a 500 MiB hard cap,
then enforces the detected kind's lower limit before persistence. Detection verifies
format signatures, not complete codec decoding or browser playback compatibility.

Questions now persist ordered `media` references in `media_json`, each
`{ mediaId, playBeforeTimer }`; order is array order, IDs are distinct, and the flag
is allowed only for audio/video. An omitted field in existing question updates
preserves references. Matching sides retain `{ kind: 'image', mediaId }`; the scoped
pair API validates that the ID belongs to this quiz and is an image. These shapes
are foundations for future editor selectors, Screen rendering and media controls;
this phase adds no media rendering, playback or pre-timer execution.

Readiness validates ownership, reference shape and physical file presence/size,
including Matching image sides. Media-only question text may be empty in both
languages; any present text still needs both languages. Deleting referenced media
is allowed by SPEC and leaves question/pair references untouched. Affected questions
are invalid and both Lobby creation and Start's fresh validation block until fixed.
Deleting already-missing files still removes their metadata. Quiz deletion removes
its media directory and cascading metadata, preserving started session copies.

Duplication copies all existing quiz media to new IDs and remaps question and
Matching references to the new quiz's copies. Already-unresolved references remain
unresolved; duplication does not repair or remove them. Missing physical files with
existing metadata fail duplication. SQL rollback removes newly copied files.

Version-1 snapshots add optional ordered question references and a safe media
manifest; legacy snapshots without them still parse. The independent parser
validates shapes, kind/MIME/limits and references against the frozen manifest.
Start copies only referenced files into session storage before committing its
snapshot/roster/state transaction, and removes those copies on failure. Repeated
Start cannot delete existing frozen files. Gameplay continues to read only snapshots;
source edits, media deletion, quiz deletion and restart cannot change frozen files
or reference metadata. Session copies are retained with durable started sessions.
Filesystem and SQLite changes are coordinated for ordinary failures, but do not
constitute a single crash-atomic transaction; a process/power failure between file
creation and SQL commit can leave an unreferenced local file.

Admin's per-quiz Media panel opens on demand, lists type/name/MIME/size, uploads one
file at a time and confirms deletion with the invalid-reference consequence. It
shows busy, success and error feedback and refreshes readiness after mutations.
Phase 6B implements question/Matching image selection and rendering; Phases 6C/6D implement playback and timer integration.

## Image authoring and frozen rendering (Phase 6B)

Admin loads/refreshes quiz-owned uploaded media in the question editor, attaches,
removes and reorders stable-ID references without deleting files. Existing ordered
references survive all edits. Only audio/video expose the stored Play before timer
flag; Phases 6C/6D implement playback and execution. Matching sides switch between
bilingual text and quiz-owned image IDs, with source previews in the editor.

Host/Screen projections include ordered image/GIF descriptors for the current
question. Normal question media never enters Player projections. Matching image
sides include a room-scoped content URL alongside their stable media ID on all
three gameplay surfaces, including accepted mappings and Reveal. URLs are delivery
addresses, never answer identities. Browser img elements preserve aspect ratio and
animate GIFs; responsive sizes fit phone Matching, Host previews and TV media.

`GET /api/rooms/:roomId/media/:mediaId/content` parses the durable snapshot and
requires image metadata in its frozen manifest. It reads only session copies,
checks regular-file status and frozen size, rejects symlink paths and uses a
no-follow file descriptor. Invalid manifests, foreign IDs, damaged/missing copies
and filesystem failures return generic 404 JSON without paths. Canonical MIME,
nosniff and no-store headers apply. This uses the existing trusted LAN boundary;
it does not introduce organizer authentication. UI image failures show a bilingual
unavailable placeholder. Source deletion, reconnect and restart retain frozen
URLs/content. Audio/video serving/playback, Host media controls and media-driven
timer transitions remain outside Phase 6B.


## Audio/video and Host playback controls (Phase 6C)

The room content endpoint now streams every supported frozen media kind from the
same verified no-follow descriptor, with single byte-range requests (206/416),
canonical MIME, nosniff and no-store. It never falls back to editable source files.
Images/GIF and Matching image projections/rendering retain their Phase 6B behavior.

Migration 22 adds `media_playback`, keyed by session, frozen question ID and stable
media ID, storing playing flag, position in seconds, server update time and revision.
Playing positions advance from the durable server timestamp, including across
server restart; paused positions stay fixed. No answer or lifecycle columns change.
`POST /api/rooms/:roomId/media/:mediaId/:action` accepts Play/Pause/Restart intents
with the current `questionId`, rejects stale questions/images/foreign IDs and closed
or non-question rooms, and commits before publishing the existing `lobby:state`.
Play resumes position, Pause freezes position, Restart seeks to zero and plays.
Starting an item atomically pauses all previously playing items in that room.
The existing trusted organizer/LAN boundary applies to these commands.

Host/Screen current-question projections carry all ordered frozen references;
playable descriptors include kind, frozen `playBeforeTimer`, URL and current server
playback projection. Host has per-item controls and status but no audio/video
player. Screen alone renders audio/video without local playback controls, seeks
from authoritative state on reload/reconnect/metadata load, and pauses peers before
playing an item. Unmount stops local playback. Video preserves aspect ratio and
fits the layout. Player projections remain unchanged: no normal media or controls.
Browser autoplay restrictions are surfaced on Screen; allow autoplay for the Screen
origin and retry Host Play if the browser blocks it. Codec support is browser-owned.
At natural file end the browser stops; Restart explicitly begins another playback.
The server timeline remains authoritative without a browser-driven end transition.

Phase 6D owns pre-timer execution and game Pause/Resume media integration. Phase 6C
keeps `playBeforeTimer` as metadata and leaves all game/timer transitions unchanged.

## Pre-timer playback and game Pause (Phase 6D)

Migration 23 extends the existing lifecycle with `pre_timer_media_id` on
`game_sessions` and a resume marker on `media_playback`; no parallel game engine
or new top-level phase is introduced. Start Question either starts ANSWERING
immediately or remains in QUESTION with an active pre-timer cursor. The cursor
walks only flagged audio/video in frozen authored array order, skipping images
and unflagged items. Repeated Start cannot bypass it. Host/Screen expose the
current ID, ordinal/total and playback state; Player has no answer projection or
Submit access until ANSWERING. Host media controls are restricted to the current
item during pre-timer playback.

Screen sends Socket.IO `media:ended` with `{ roomId, questionId, mediaId,
revision, duration }`. Only a socket currently subscribed as Screen for that room
can report it (the existing trusted LAN surface boundary, not authentication).
One write transaction validates the open room, current frozen question, playing
media, active cursor, exact playback revision and finite positive duration. It
stops that playback and starts the next required item, or creates the answer
deadline after the last item. Duplicate, stale, paused and foreign reports cannot
advance the cursor. The optional acknowledgement is `{ accepted }`; committed
changes broadcast and reschedule the existing deadline manager. Normal media
completion also stops its persisted playback without extending an answer timer.
An overdue ANSWERING deadline takes precedence through shared Reveal/scoring.

Manual and disconnect Pause freeze the server playback position and remember
which media was playing in the same transaction as the game state/timer. Revision
changes invalidate in-flight completion reports. Resume and Wait restore only
that previously playing media and use the existing frozen timer remainder;
media paused by Host stays paused. Disconnect handling now also covers active
pre-timer QUESTION. Continue retains current-question exclusion semantics and
continues required playback; if everyone is excluded, finishing playback resolves
directly to Reveal through the normal completion helper. Paused media questions
remain visible on Host/Screen with frozen playback and disabled Host controls.

SQLite preserves the cursor, position, revision and resume marker across reload,
reconnect and restart. As in 6C, a playing server timeline includes elapsed time;
a paused timeline never does. Screen seeks to that position and reports completion
when an elapsed restored item has reached its browser-decoded duration, recovering
a lost end report. Finished audio stays stopped without seeking EOF (which can
fail in browser MP3 demuxers); its persisted completed position is unchanged.
It does not advance merely because server time passed: a Screen
completion report is required. Playback failures/autoplay blocks remain visible;
Host can retry/restart the current item. Only Screen plays audio/video, and starting
another item pauses its peers. Host Play/Pause/Restart in ANSWERING never changes
the deadline; game Pause/Resume is the only operation that freezes/restores it.


## Admin visual previews (Phase 8A)

The selected question editor opens an inline Preview panel with RU Player,
EN Player, Screen and Host modes and separate Answering/Reveal states. Quiz title,
theme, effective answer duration, question text, options, Matching sides and ordered
media come directly from current React editor state, including unsaved edits.
Drafts need not pass readiness validation to preview. Selecting another question
resets preview interaction; preview state never changes persisted question fields.

`QuizPreview` builds small editor-only projections for existing presentation
components. `QuestionContent` supplies bilingual Screen and Host content;
`PlayerAnswerContent` supplies localized option selection and tap-to-pair UX;
`PlayerRevealContent` supplies localized correct-answer/pair presentation. The live
`PlayerAnswer` wrapper retains HTTP submission and its server-anchored countdown;
the extracted content receives seconds and a submission callback. Preview uses a
frozen `CountdownDisplay` and a local callback only. Shared `ThemeSurface`,
`MediaImage`, `MatchingItemContent` and `PlayableMedia` retain normal themes,
aspect fitting and unavailable-media fallbacks. Screen preview offers local browser
audio/video controls, pausing audible peers on Play; Host playback commands remain
disabled. Playback has no server state, pre-timer execution or completion reports.
Media URLs use editable quiz storage, never session copies.

The organizer editor necessarily owns answer keys, but the answering Player
component receives only localized question/options/sides and the explicitly enabled
Multiple Choice count hint: no correctness flags, correct option IDs, pair mapping,
normal question media or score data. Matching side IDs are independent random
identities with no editor pair IDs; authored ordering is retained. Reveal adds keys
only to the separate Reveal projection and uses an explicitly labeled unanswered
sample personal result (zero points), without evaluating or persisting a score.

Preview has no room/session hook, realtime subscription, authoritative timer,
identity storage, session snapshot or gameplay mutation endpoint. Opening, changing
mode/state, selecting answers, local Submit, playing media and closing cannot create
rooms, players, submissions, scores or history. Existing editor autosave remains the
only content mutation path. Test Game is implemented in Phase 8B below; portable quiz archives are implemented
in Phase 8C. Phase 8D implements minimal history.


## Real Test Game sessions (Phase 8B)

Migration 24 adds `game_sessions.is_test INTEGER NOT NULL DEFAULT 0`, constrained
to 0/1. Existing and normally created rooms remain real games. Public room
projections expose a boolean `isTest`, including HTTP, code lookup, authenticated
Player reconnect and realtime snapshots. It is session metadata, independent of
editable quiz content and the frozen quiz snapshot, and has no update endpoint.

Admin's **Start Test Game** calls `POST /api/quizzes/:quizId/test-games`, which
creates an ordinary Lobby through `createRoom` with `isTest=true`. Readiness and
saved-settings gating match Open lobby; the server independently validates the
persisted quiz. Admin explains the phone/Host flow and history exclusion. Host
and bilingual Screen label the Test Game throughout the session, including closure.
Phones use the same room codes, QR links, join limits and reconnect tokens.

Host Start requires players, revalidates readiness and freezes content, theme,
roster and referenced session media through the existing transaction. Test Game
has no alternate gameplay path or relaxed rules: timers, pre-timer media, answer
privacy, submissions, disconnect Pause/Wait/Continue, scoring, navigation and
restart recovery all use the real-game engine. Source edits/deletion after Start
cannot change the running session or its independent media copies.

Phase 8B introduced no completed-game history query or UI. Phase 8D below filters
normal completed-game history with `is_test = 0`, in addition to its completion
marker; closure alone is not proof of completion. Test sessions never enter that
default query.

Retention is deterministic: delete only `is_test = 1` sessions with non-null
`closed_at` at least **seven days** before cleanup's UTC clock, inclusive at the
cutoff. Age starts at closure, not creation; open sessions in any phase (including
Lobby, Answering, Paused and Winner) and all real sessions are retained indefinitely
by this cleanup. It runs opportunistically in `createQuizServer` at startup before
presence/deadline recovery. No worker, background service or automatic closure is
added. Recently closed tests remain available until a later eligible startup.

`cleanupTestGames` selects eligible rows under `BEGIN IMMEDIATE`, removes only
their frozen session media directories, then deletes session rows. Existing foreign
keys cascade players, answers, scores, exclusions and playback. Source quiz media
is untouched. Files are removed before rows so filesystem failures roll SQL back
and leave closed rows eligible for retry on a later startup; startup logs a failure
and continues serving. Filesystem and SQLite are not crash-atomic: interrupted
cleanup can leave a closed test with partially removed media until retry. Cleanup
never affects an open Test Game or a real game.


## Portable quiz ZIP archives (Phase 8C)

`GET /api/quizzes/:quizId/export` downloads `quiz.zip` from the current persisted
editable tree. `readEditableQuizTree` explicitly selects content fields; Start
continues independently validating that tree through `createGameSnapshot`. Export
never reads played snapshots, rooms, players, submissions, scores, history, Test
Game metadata or frozen session media. All quiz-owned media, including unused
library items, are copied into private staging before asynchronous validation and
hashing, so later source changes cannot mix revisions in the archive.

The version-1 ZIP has exactly `manifest.json` and `media/<originalMediaId>` files,
without directory entries. The manifest is `{ schemaVersion: 1, quiz, media }`.
Quiz contains its portable ID, title, theme ID, default timer, shuffle setting and
ordered rounds/questions/options/Matching pairs. Questions include count hint,
Screen options, points, timer override and ordered media references with
`playBeforeTimer`. Media metadata includes portable ID, display name, kind,
canonical MIME, size, creation timestamp and SHA-256. Display names are metadata,
never filesystem paths. Media files are extensionless; extensions in display names
are checked by the existing upload validation boundary. This is an editor archive,
not a gameplay snapshot or backup of the database.

`POST /api/quizzes/import` accepts one multipart `file`. Only schema version 1 and
exact known manifest fields are supported. V1 question type/count/correctness,
bilingual content, settings, strict authored ordering, globally unique UUIDs,
Matching sides, media ownership/references and playable flags are validated before
SQL writes. Empty quizzes/rounds remain editable drafts; populated questions must
meet V1 content rules. Export reports invalid content/missing media instead of
producing an archive that cannot be imported.

ZIP decoding uses lazy entries and disk staging. The allowlist rejects absolute,
traversal/backslash, unexpected, directory, duplicate/conflicting, encrypted and
non-regular entries; conflicting local/central filenames, flags or compression
and overlapping entry ranges are rejected. Archive-controlled
paths are never extracted: each file receives a generated staging filename.
CRC, actual decompressed size, declared size, SHA-256 and the existing extension/
MIME/binary-signature validator check files, including unused media. This checks
format signatures, not complete codec decoding. Limits: 1 GiB uploaded/expanded
archive, 8 MiB manifest, 500 media files, 100 rounds, 2,000 questions, 100 pairs per
question, 10 options, and the existing 20/100/500 MiB image/audio/video limits.
Missing referenced media is always an error.

After full validation, one synchronous `BEGIN IMMEDIATE` transaction generates
fresh quiz/round/question/option/pair/media UUIDs and remaps every parent and media
relationship. Imported media moves to its new quiz-owned UUID directory. Only
editor tables are written; readiness stays derived, with no gameplay/history
records or status copied. Any ordinary failure rolls SQL back and removes the
entire new quiz directory and private staging. As with existing media operations,
process/power loss across filesystem and SQLite is not a single crash-atomic
transaction and can leave unreferenced files, but never a committed partial quiz.

Admin offers Export on the list and saved quiz settings, and Import Quiz on the
list. Success exposes an immediate **Open imported quiz** link; failures remain
visible and can be retried. Missing bundled themes preserve the authored ID and
show a clear warning; the existing resolver uses Default until that theme exists.
Archives include no theme package or gameplay history; Phase 8D provides the separate history query/UI.

## Minimal completed-game history (Phase 8D)

Migration 25 adds `game_history`, keyed by session ID with a cascading session FK.
Start records the original quiz ID (a plain value, without an editor FK) and frozen
title in its existing snapshot/roster transaction. The history table contains only
that identity, nullable `completed_at` and nullable final `players_json`. Identity
survives source rename/deletion, including deletion before completion.

The first successful `final-results` command sets the UTC ISO completion timestamp
and final participants/totals in the same `BEGIN IMMEDIATE` transaction as entering
`FINAL_RESULTS`. The update requires `completed_at IS NULL`; one row per session
and no other completion writer make Winner, Pause/Resume, reconnect, repeat Close
and restart unable to move the timestamp or duplicate a completion. Incomplete
closure and final Round End/Leaderboard do not create completed history.

Participants come directly from `getLeaderboard`: Start roster members with
`removed_at IS NULL`, including zero totals, sorted by the existing competition
standings order. Only player ID, display name and total points are copied; no
history rank model is added. Answers, correctness, question score rows, played
snapshot, media, tokens, language and other player metadata are not copied into
history or returned by its API. Existing gameplay durability remains unchanged.

`GET /api/history` uses explicit selected fields and `s.is_test = 0 AND
h.completed_at IS NOT NULL`, newest first with stable session-ID ordering for
equal timestamps, limited to 100 entries. It reads frozen final totals only and
never reads editable quizzes, snapshots or active-session answer/score/player
tables. The existing trusted organizer/LAN boundary applies. Admin `/admin/history`
is linked from the quiz list and shows title, local completion date/time, original
quiz/game IDs and final player scores, with loading, error and clear empty states.
There are no charts, filters or pagination framework.

SQLite stores the complete minimal record across restart. Tests use the same
completion path but are excluded explicitly; their history rows cascade through
the unchanged seven-day closed-Test-Game cleanup. Migration preserves available
identity for already-started sessions but never invents historical completion
times. Games already in Final/Winner before migration therefore stay outside
history. An older session whose source was deleted before migration has an
unrecoverable original quiz ID, represented as null if it later completes; all
games started with Phase 8D retain that ID independently of source deletion.

## Final V1 gaps and acceptance (Phase 8E)

Kick uses the existing `session_players.removed_at` boundary, never a second
membership table or a permanent question exclusion. A confirmed Host command
runs under `BEGIN IMMEDIATE`, marks only an active room-scoped player removed,
retains Start membership and all accepted answer/score rows, and recalculates
completion from unremoved roster members. HTTP roster, Reveal statistics, scores
and standings consistently exclude removed players. Reconnect, Submit and identity
updates reject their tokens. After commit the realtime runtime emits a private
`player:removed` event to every authenticated tab of that identity, disconnects
those sockets, reschedules the existing deadline manager and publishes Host/Screen
state. Player hides controls and invalidates pending HTTP reads.

Kicking the player responsible for disconnect Pause uses the shared Continue
resolution transaction without inserting an exclusion: it restores the frozen
remainder/media or commits Reveal if the remaining responders are done. Kicking
another player leaves that disconnect Pause unresolved. Manual Pause remains
paused; Resume checks completion against the remaining roster. Pre-timer playback
still gates answers. Kick after Final Results (including paused Final Results),
Winner or closure returns conflict, preserving immutable completed history.
Lobby removal releases the name/capacity reservation; V1 revokes identities and
does not implement device bans. After Start a new identity cannot join.

Token-authenticated identity updates atomically reserve a new name only in Lobby
and allow RU/EN changes throughout an open game. They do not change accepted
answers, side/option IDs or scores. Host presence comes from the existing socket
registry and is refreshed on first/last connection. Screen/Player payloads gain
no presence details or private answers.

Migration 26 adds optional bilingual question explanations and quiz-owned round
image art. Readiness validates bilingual completeness and available owned image
references. Start freezes explanation text and copies round art through the same
media manifest/storage boundary. Host can inspect explanations; Screen receives
them only at Reveal; Player answering projections never receive them. Shared
Round Intro and question Preview/Reveal render these additions. Duplicate and
version-1 ZIP import/export preserve/remap them; older version-1 snapshots/archives
without these optional fields remain valid.

The application has a local favicon, a timer progress bar, explicit empty Host/
standings states, long-text Preview guidance, working entry-route guidance and
phone wrapping for existing controls. These do not change gameplay or themes.
Operator commands, URLs, backups and autoplay are documented in `README.md`.

Automated and isolated local Chromium acceptance are recorded in
`docs/V1_ACCEPTANCE.md`. This establishes local V1 acceptance, not real-hardware
acceptance. Current Safari on iPhone, Chrome on Android, actual home Wi-Fi, TV
picture/audio/mirroring and sustained physical media/autoplay checks remain the
explicit checklist there. No real phone/TV/Wi-Fi test is claimed.
