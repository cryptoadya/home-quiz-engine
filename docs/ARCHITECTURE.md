# Architecture v0

This document is intentionally small. It defines boundaries, not implementation ceremony.

## One local application

Run one local service on the host computer. Guests connect over the same Wi-Fi network.

Logical pieces:

- `apps/web` — React UI for Admin, Host, Screen, Player
- `apps/server` — Express API + Socket.IO + SQLite access + local media serving
- `themes` — theme manifests/assets/styles
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

Game components are shared. Theme configuration/assets modify presentation only. Missing theme parts fall back to Default.

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
Phase 4C adds Host resolution controls below; Kick remains out of scope.


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
The required correct-option count is always shown to Player in this phase.

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
