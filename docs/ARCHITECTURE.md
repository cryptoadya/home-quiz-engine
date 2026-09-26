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
- submit
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
never sends its reconnect token over Socket.IO. Surface selection is a payload
boundary, not authentication, in this trusted LAN application.

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
restores its safe state. Closed-room behavior takes precedence. Phase 3B extends
this foundation with Answering and timers below; scoring, reveal and further
navigation remain reserved for later slices.

## Answer timer (Phase 3B)

Migration 8 adds `ANSWERING`, `answer_started_at` and `answer_deadline_at` (UTC ISO
timestamps). Existing navigation, snapshots and roster survive unchanged with null
timers. SQLite requires both valid, ordered timestamps for Answering and null
timer fields in every other state.

`POST /api/rooms/:roomId/start-question` runs one `BEGIN IMMEDIATE` transaction:
require an open `QUESTION`, resolve the current frozen question and its override
or snapshot default duration, persist server start/deadline, and enter `ANSWERING`.
Only after commit does it broadcast. Repeats return 409 and cannot reset the timer.
`timer.ts` centralizes duration, deadline and expiry calculations with explicit
`now` inputs. Expiry is computed as `now >= deadline`, with remaining milliseconds
clamped to zero. There is no expiry scheduler or DB mutation: state stays
`ANSWERING` at zero until later phases implement completion/reveal.

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
No token travels over Socket.IO. Host/Screen retain the existing trusted-LAN
surface boundary (not organizer authentication); no generic Player content
endpoint is added. Screen options still depend on `showOptionsOnScreen`, and
neither Screen nor Player receives correctness, future content or the snapshot.
Player choices are noninteractive in this phase.
