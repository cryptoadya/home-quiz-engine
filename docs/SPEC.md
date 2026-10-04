# Product specification v1.0 — Home Quiz Engine

[Documentation map](README.md) · [Operating guide](RUNBOOK.md) · [Architecture](ARCHITECTURE.md)

This is the normative V1 behavior specification. Implementation status is tracked
in [ROADMAP.md](ROADMAP.md); dated verification evidence is recorded separately
in [V1_ACCEPTANCE.md](V1_ACCEPTANCE.md). Neither an implementation note nor a
successful local test replaces these requirements.

## Scope statement

This is a private home quiz engine for parties with friends. It is not a market product. Optimize for a reliable local-party experience and an easy authoring workflow; do not add SaaS, multi-tenant, cloud-platform, billing, marketplace, or enterprise features.

## Roles / surfaces

- **Admin / Editor:** create, edit, validate and preview quizzes; check Screen and sound; private to organizer.
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
- Screen automatically adapts to available window width and height; question text, timer, media grid and theme decoration share a bounded presentation area. Playing video gets the main media area. Fonts retain readable lower and upper bounds; excessive text remains accessible and is flagged in the editor preview rather than silently clipped.
- Player and Player preview scroll answer content independently of a stable bottom Submit row; suppress pull-to-refresh where the browser supports it. Unsubmitted drafts survive reload in the same tab for the same player/question; accepted answers remain server-authoritative.
- each audio/video may be flagged **Play before timer**;
- Host initiates question/media flow; required pre-timer media may begin as part of **Start Question** and must complete in defined order before the answer timer starts;
- Host controls non-required audio/video with Play/Pause/Restart; Screen renders/plays according to Host/game commands;
- after timer starts, replaying media must not reset the game phase/timer;
- only one audible source at a time;
- manual Pause pauses both active media and timer.

Suggested configurable per-file limits: image 20 MB, audio 100 MB, video 500 MB.

Media is copied into per-quiz storage. Deleting referenced media makes affected questions invalid until fixed.

## Lobby / room

- Up to 30 active players.
- A 5-character active room code; avoid visually ambiguous O/0 and I/L/1.
- Party setup: start the server on the Mac, note its LAN address (for example `192.168.178.37:5173`), open Lobby in Admin and note its code (for example `H8VXT`). Manually open `http://192.168.178.37:5173/host/H8VXT` on the Host phone and `http://192.168.178.37:5173/screen/H8VXT` on the TV / second computer. Guests scan the single Player QR on Screen, enter a name, choose RU / EN and Join.
- Host Lobby shows quiz title, prominent room code, player count, compact roster, Start Game and secondary Close Room. No organizer QR, long sharing URLs, Copy actions or network setup.
- Admin opens `/host/<CODE>` after Open Lobby. Host and Screen code URLs resolve the current active room internally to its UUID; the browser keeps the human-readable code URL. A reused code intentionally opens its current active room. Direct UUID routes remain compatible; Player reconnect tokens and session identity remain unchanged.
- `/host` and `/screen` offer only room-code entry and Open Host / Open Screen. Lowercase codes normalize to uppercase. Nonexistent or closed codes show a clear error.
- Screen Lobby prominently shows quiz title, room code, player count / names and exactly one language-neutral Player QR targeting `http://<reachable-LAN-origin>/play/<CODE>`. No organizer QR.
- Player QR uses the current reachable web origin, preserving the frontend port. For localhost / unusable origins, use server-discovered private IPv4 (`10/8`, `172.16/12`, `192.168/16`), excluding loopback, `169.254/16` and unspecified / unusable addresses. One unique private address is selected automatically; multiple addresses use a compact Screen selector. If none is available, show a concise instruction to open Screen at the Mac’s LAN address. Vite console output is unchanged.
- `/play` accepts a room code; `/play/<CODE>` loads the name and language join form directly.
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

Mobile-first. Host action labels, phases, connection status, confirmations and errors are in Russian. Each phase includes a short instruction explaining the next action; disconnect Pause explains waiting/resuming or continuing without the player. At minimum:
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

Answer choices are always Player-only during active answering. Screen never displays answer choices or Matching candidates before Reveal. There are no per-question exceptions or correct-count hints on Screen. The server Screen projection excludes options, Matching candidate lists, correctness and correct mappings before Reveal.

Screen Reveal shows only the correct answer(s) or correct Matching pairs, not the full set of wrong alternatives. Single Choice and Yes/No show one bilingual correct answer; Multiple Choice shows only the bilingual correct set; Matching shows only correct pairs.

Screen hides healthy connection status, internal state names, media sequence counters and raw filenames. Actionable connection/playback recovery remains available.

Pause overlays `Пауза / Paused` without revealing answer.

## Reveal / scoring

Screen is the main reveal surface and shows bilingual correct answer plus optional explanation/statistics.

Player shows personal result only: correct + points / incorrect / no answer. Player does not need current rank after every question.

Speed does not affect scoring in V1.

## Leaderboards / final

- Intermediate leaderboard appears only after rounds configured to show it.
- Equal scores share the same rank (`1, 1, 3`).
- Optional reserve rounds are marked `isTiebreak` in the editor and skipped during the main quiz. They are frozen with the session and preserved by export/import.
- At Final Results, if at least two players share first place and reserve questions exist, Host may start a tie-break before Show Winner.
- Only tied first-place players participate; others watch Screen and cannot submit or trigger disconnect Pause during reserve questions.
- After each reserve question, if anyone is correct, only correct players advance. If everyone is wrong or unanswered, all current finalists remain. A single remaining player wins; if reserve questions run out, remaining finalists share the win.
- Main quiz scores and ranks remain unchanged. Tie-break results are recorded separately in game history. Existing timer, explicit Submit, reveal, pause/reconnect and media rules still apply to participating finalists.
- Host advances after each Reveal. No repeated reserve questions and no automatic replay of the main quiz.
- Final flow: Final Leaderboard -> Host `Show Winner` -> themed Winner Screen.
- Winner Screen shows the tie-break winner(s), or all first-place players if no tie-break was played.

## Security / information boundaries

Before Reveal, Player must not receive correct answer / `isCorrect` data in HTML, client state or API/socket payload.

Server is authoritative for accepted submissions, score, timer, roster and game-state transitions.

## Preview / equipment check

Preview: visual inspection modes for RU Player, EN Player, Screen, Host. Screen Preview follows the same answer boundary: no choices or Matching candidates while answering; only correct answers/pairs on Reveal.

Equipment check: Admin opens a standalone `/screen-check/<quizId>` page on the TV browser, without creating a room, players, game session, timer, scores or history. Works for draft quizzes as well as ready quizzes. Admin can show a test picture, play a three-second test tone or stop the check; only the check Screen produces sound. Report connected check Screens and playback/permission failures to Admin. If autoplay is blocked, Screen offers a local sound-permission recovery button. Organizer confirms picture visibility and actual audibility; software does not certify the TV/speaker output. Stop sound on a new command, Screen disconnect/unmount or when the last checking Admin disconnects. Check commands never affect gameplay. Preserve the reachable LAN origin and frontend port when opening the check on another device.

Test Game is removed: no creation endpoint, editor action, runtime marker or stale-test cleanup. Legacy test records remain excluded from normal history.

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

No SaaS, public accounts, multi-owner roles, payments, marketplace, cloud sync, achievements, avatars, teams, chat, global rankings, free-text questions, zero-point questions, manual save, undo/redo, forced reveal, question rollback/restart, answer reset, next-question preview for Host, late join, detailed analytics or enterprise recovery systems.
