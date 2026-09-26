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
- start game/round/question
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

When a real/test game starts, create an immutable in-memory/database snapshot sufficient to prevent editor changes from altering that running session. Do not build version-control semantics around it.

## Lobby foundation (Phase 2A)

Opening a Lobby creates a durable `game_sessions` row referencing the editable quiz;
no content is copied or frozen. The immutable snapshot belongs to the future Start
Game boundary, which must validate the quiz again. Host reloads read the session
from SQLite. Multiple Lobbies may reference one quiz.

Sessions currently have only `LOBBY` state; a nullable `closed_at` records closure
without adding a gameplay state. Closing is idempotent. Five-character codes use
`ABCDEFGHJKMNPQRSTUVWXYZ23456789`, with a partial unique index for active sessions
and bounded collision retries. Closed sessions remain accessible by ID, but not by
code; their codes can be reused. Deleting a quiz cascades to its Lobby sessions.

HTTP endpoints: `POST /api/quizzes/:quizId/rooms`, `GET /api/rooms/:roomId`,
`GET /api/rooms/code/:code`, and `POST /api/rooms/:roomId/close`. Code lookup trims
whitespace and accepts lowercase. Creation returns 409 with readiness validation
problems for a draft, 404 for a missing quiz, or 503 if code allocation is exhausted.
Room responses contain metadata and the current quiz title, never question answers.
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
- Server `lobby:state`: `{ room, players }` for Host/Screen, `{ room }` for Player.
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
address warning. Start Game and gameplay events are outside this slice.
