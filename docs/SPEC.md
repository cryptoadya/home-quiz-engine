# Product specification v1.0 — Home Quiz Engine

[Documentation map](README.md) · [Operating guide](RUNBOOK.md) · [Architecture](ARCHITECTURE.md)

This is the normative V1 behavior specification. Implementation status is tracked
in [ROADMAP.md](ROADMAP.md); dated verification evidence is recorded separately
in [V1_ACCEPTANCE.md](V1_ACCEPTANCE.md). Neither an implementation note nor a
successful local test replaces these requirements.

## Scope statement

This is a private home quiz engine for parties with friends. It is not a market product. Optimize for a reliable local-party experience and an easy authoring workflow; do not add SaaS, multi-tenant, cloud-platform, billing, marketplace, or enterprise features.

## Roles / surfaces

- **Admin / Editor:** create, edit, validate, preview and test quizzes; private to organizer.
- **Host:** mobile-first control surface used by the host during the party.
- **Screen:** presentation-only TV surface, normally browser on laptop connected to TV by cable.
- **Player:** smartphone answer surface.

## Quiz lifecycle

- Quizzes persist as editable drafts until manually deleted.
- Autosave; show saving/saved status.
- Start Game uses a fixed session snapshot so edits cannot alter the running game.
- Ready-to-play is derived from validation, not manually set.
- New question default score = 1 positive integer point; per-question override allowed.

## Languages

- RU and EN supported.
- Any user-facing quiz text present on Screen/Player must have both RU and EN versions.
- Player sees selected language only; Screen shows both languages.
- Lobby exposes one language-neutral Player QR. Players enter their name and choose RU / EN before joining, then play without a permanent language selector. Language remains switchable through compact Settings; Lobby rename is available there too.

## Themes

- Theme is presentation-only (`themeId`) and must not alter game behavior.
- V1 includes Default and Halloween.
- Shared components consume theme configuration; no per-theme forks of game components.
- Theme manifest includes id/name/version/author/resources/features.
- Missing theme parts/resources fall back safely to Default.

## Rounds

Each round has bilingual title/optional description, optional art/background, order, and `showLeaderboardAfterRound`.

Flow: Round Intro -> questions -> Round End -> optional Leaderboard -> next round.

## Question types

### Single Choice
- 2–10 options
- exactly 1 correct

### Multiple Choice
- 2–10 options
- at least 2 correct
- full score only for exact correct set
- optional author setting to reveal the number of selections required

### Yes / No
- exactly 2 options
- exactly 1 correct

### Matching
- at least 2 complete pairs
- left and right items may each be text or image
- Player UX is tap left then tap right; no drag/drop
- pairs remain editable until Submit
- full score only for fully correct matching

## Answer contract

For every type:
- Player may change the draft selection while the question is active.
- Final answer is accepted only when Player presses **Submit**.
- Submit is disabled until a structurally valid answer is formed.
- Once server accepts Submit, answer is immutable.
- If time expires before accepted Submit, score = 0 and status = no answer.
- Server acknowledgement determines whether a Submit made immediately before disconnect counts.

## Question content and explanation

- Question may be text-based or media-only.
- If text exists, RU+EN are required.
- Optional post-reveal explanation; if used, both RU+EN required.
- Suggested UI limits: quiz title 100, round title 100, question 5000, answer option 500, explanation 5000 chars.
- Preview/validation should warn when text is likely to render poorly; do not silently truncate.

## Media

Supported:
- images: JPG/JPEG/PNG/WEBP/GIF
- video: MP4/WEBM
- audio: MP3/WAV/OGG

Rules:
- normal question media is presented on Screen/TV only;
- Player receives media only when the media itself is an interactive answer element (e.g. Matching image);
- multiple media files allowed and reorderable;
- GIF animates;
- preserve aspect ratio and fit within layout;
- each audio/video may be flagged **Play before timer**;
- flagged audio/video plays in defined order before answer timer starts;
- after timer starts, replaying media must not reset the game phase/timer;
- only one audible source at a time;
- manual Pause pauses both active media and timer.

Suggested configurable per-file limits: image 20 MB, audio 100 MB, video 500 MB.

Media is copied into per-quiz storage. Deleting referenced media makes affected questions invalid until fixed.

## Lobby / room

- Up to 30 active players.
- Short 4–6 character room code; avoid visually ambiguous O/0 and I/L/1.
- Host Lobby is the organizer setup hub: room code, separate Host and Screen QR/link/copy controls, and one Player QR with room-code fallback. Screen Lobby also shows the same Player QR.
- Share links use the current reachable web origin or local private IPv4 candidates supplied by the server, preserving the frontend port. Multiple candidates require organizer choice; manual network-address entry is available. Never publish loopback share links.
- Host and Screen convenience entry accepts the current active room code and navigates to the existing UUID route. Generated links include a session marker and must reject reuse by another session; code-only entry deliberately resolves the current active room. UUID identity and lifecycle stay unchanged.
- Copy uses the Clipboard API with success feedback or selectable link text when unavailable.
- Player name max 20 chars; letters, space, hyphen, apostrophe; escape all input.
- Duplicate name reservation is atomic; first successful reservation wins.
- Before Start Game player may rename.
- Start Game freezes roster.
- No late join in V1; only reconnect of existing players after start.
- room code released after room closes.

## Player identity / reconnect

Each joined player has `playerId`, `sessionToken`, `displayName`, language and session membership.

Refresh/temporary Wi-Fi loss/browser reopen should restore the player via sessionToken with name, language, score and accepted submissions intact.

## Disconnect semantics

If a player disconnects **before accepted Submit** during an active question:
- auto-pause timer;
- Host is notified;
- Screen shows `Пауза / Paused` over current screen;
- Host chooses **Wait for Player** or **Continue Without Player**.

Wait:
- remain paused;
- after reconnect Host resumes and player continues same question.

Continue Without Player:
- require confirmation;
- player scores 0 for this question;
- player is excluded from completion condition for this question;
- if player reconnects later, they resume from the next question.

If player disconnects after server accepted Submit, do not auto-pause because of that player; accepted answer remains valid.

Host disconnect does not destroy session; Host reconnect restores control. Screen disconnect does not pause game; Screen resyncs current state after reconnect.

## Timer / completion

- Server owns timer.
- Quiz has default answer duration; question may override.
- Timer starts immediately unless pre-timer media must finish first.
- Reveal occurs when all players participating in the current question have accepted Submit, or timer reaches zero.

## Host behavior

Mobile-first. At minimum:
- Start Game / Start Round
- Pause / Resume
- Play / Pause / Restart current media
- Next Question / Next Round
- Wait for Player / Continue Without Player
- Kick Player
- End Game
- Show Winner

Host sees timer + progress bar, answered/not-answered counts, online/disconnected status and correct answer. Before reveal Host does **not** see each player's selected option.

Dangerous actions such as Delete Quiz, End Game, Kick Player and Continue Without Player require confirmation. Next Question does not.

## Screen behavior

Presentation only; no game controls. When media playback fails or needs local replay, Screen may show a local playback recovery button.

Before Host presses **Start Question**, `QUESTION` is a Host preparation state: Screen shows only a neutral bilingual ready message and question progress, without question text, media, choices, Matching content, explanation or answers. Host retains the prepared question and controls; Players keep waiting.

After **Start Question**, Screen shows the bilingual question and media, including while required pre-timer media keeps the state in `QUESTION`. The timer and `Answered n / total` appear during answering. Do not show names of players still thinking.

Answer choices are normally Player-only, but `showOptionsOnScreen` may display them on Screen after public start. When false, choices and Matching content stay hidden until Reveal.

Pause overlays `Пауза / Paused` without revealing answer.

## Reveal / scoring

Screen is the main reveal surface and shows bilingual correct answer plus optional explanation/statistics.

Player shows personal result only: correct + points / incorrect / no answer. Player does not need current rank after every question.

Speed does not affect scoring in V1.

## Leaderboards / final

- Intermediate leaderboard appears only after rounds configured to show it.
- Equal scores share the same rank (`1, 1, 3`).
- No tie-break mode in V1.
- Final flow: Final Leaderboard -> Host `Show Winner` -> themed Winner Screen.
- Winner Screen may show multiple first-place players. If there is one physical prize, Host resolves that outside the system.

## Security / information boundaries

Before Reveal, Player must not receive correct answer / `isCorrect` data in HTML, client state or API/socket payload.

Server is authoritative for accepted submissions, score, timer, roster and game-state transitions.

## Preview / Test Game

Preview: visual inspection modes for RU Player, EN Player, Screen, Host.

Test Game: real temporary session used with actual phones/Wi-Fi to verify QR, browsers, realtime, reconnect/disconnect, media, scoring, leaderboard, theme and final flow. Mark `isTest=true`; exclude from normal history and clean stale tests automatically.

## History

For completed real games store only:
- date/time
- quiz id/title
- participants
- final scores

Do not store per-question answer history in V1.

## Import / Export

Self-contained ZIP export with schema version, quiz JSON and all quiz media. No absolute paths.

Import validates schema and restores media as a new local quiz. Missing theme must not break import: warn and use Default until theme exists.

`schemaVersion: 1`

## Browser / network target

- local Wi-Fi, no internet required during play
- current Safari on iPhone
- current Chrome on Android
- Host mobile-first
- Player smartphone-first
- Admin desktop/tablet-first
- Screen TV/large-display-first

## Explicit non-goals for V1

No SaaS, public accounts, multi-owner roles, payments, marketplace, cloud sync, achievements, avatars, teams, chat, global rankings, free-text questions, zero-point questions, tie-break engine, manual save, undo/redo, forced reveal, question rollback/restart, answer reset, next-question preview for Host, late join, detailed analytics or enterprise recovery systems.
