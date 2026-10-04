# V1 acceptance — Phase 8E

Актуализация 4 октября 2026: Test Game удалён и заменён проверкой экрана/звука без игровой сессии. Упоминания Test Game в датированном отчёте ниже описывают прежнюю реализацию. Новые изменения не подтверждены этим аудитом; физический чек-лист остаётся открытым.

[Карта документации](README.md) · [Этапы и статус](ROADMAP.md) · [Проведение игры](RUNBOOK.md)

## Как читать этот отчёт

Ниже сохранён отчёт локальной приёмки **от 28 сентября 2026 года**.
Числа тестов и результаты браузерной репетиции относятся к этому аудиту;
последующие исправления в Git не были автоматически перепроверены этим отчётом.
Обновление документации не означает новую игровую или аппаратную приёмку.
Проверки на реальных телефонах, Wi-Fi, телевизоре и колонках остаются открытыми;
используйте [физический чек-лист](#remaining-limits-and-physical-device-checklist).

## Audit context

Audit baseline: complete `SPEC.md`, `ARCHITECTURE.md`, roadmap and existing server/
UI acceptance tests were reviewed before changes. This is local V1 acceptance;
physical-device acceptance remains open. No new product scope was added.

## Findings and fixes

- Host Kick was absent. The existing removal marker was inconsistently applied
  to fixed roster/counts. Confirmed Kick now uses that marker everywhere, revokes
  every authenticated tab/token, preserves accepted records, and shares disconnect
  resolution, timer/media and scoring transactions. Manual Pause remains paused;
  kicking its disconnect cause resolves that pause. Completed history is immutable,
  so Kick is rejected after Final Results/Winner/closure.
- Lobby rename, session language switching, Host online/disconnected status and
  timer progress were absent. They now use the existing identity/presence/timer paths.
- Optional bilingual Reveal explanations and round art were missing from V1.
  Migration 26 implements them in authoring, readiness, snapshots, shared rendering,
  duplication and archives. Neither is sent to answering Player. Explanations reach
  Screen only on Reveal; art uses frozen quiz-owned image storage.
- Favicon 404, stale entry pages/README/deferred claims, phone action wrapping,
  empty Host/standings guidance and Admin deletion busy gating were fixed. Long
  question/option text now prompts visual Preview review without truncation.

## Complete V1 audit

| Area | Acceptance evidence / result |
| --- | --- |
| Drafts/autosave/readiness/duplicate/delete | Existing editor, validation, duplication and media suites; readiness rechecked at Start; frozen sessions survive source edits/deletion. |
| Single/Multiple/Yes-No/Matching | Structural Submit checks, immutable retries, exact-set/full-pair scoring, timeout zero, count hint and deterministic shuffle; mixed-type server/UI tests and local browser gameplay. |
| RU/EN | Bilingual authoring/readiness, selected-language Player and bilingual Screen; Lobby rename and live language-switch regression; local RU/EN switch. |
| Room/join/reconnect | Atomic duplicate reservation, name/30-player/code boundaries, roster lock/no late join, room-code release, hashed/scoped reconnect tokens and recovery tests. |
| Privacy | Safe Player/Screen allowlists before Reveal; normal media absent from Player; opaque Matching IDs, own submissions only; new explanation-boundary tests. Trusted organizer APIs remain a LAN boundary, not organizer authentication. |
| Timers/Pause/Resume | Server deadlines, exact-deadline races, completion/restart tests; local pre-timer and answer-phase Pause/Resume, progress display and refresh-triggered pause. |
| Disconnect Wait/Continue/Kick | Last authenticated socket presence, accepted Submit survives loss, Wait after reconnect, question-only exclusion versus permanent removal, realtime revocation; local two-Player rehearsal. |
| Media/pre-timer | All supported extensions/signatures/limits, aspect fitting, frozen copies, byte ranges, one audible source, ordered completion, paused cursor/revision and timer independence; local JPG/GIF/MP3/MP4 decoded. |
| Rounds/final/Winner | Round boundary and optional standings, shared ranks/tied winners, final history freeze and Winner/closure tests; local configured leaderboard and Winner. |
| Themes/fallback | Default/Halloween shared surfaces, contrast/fallback/frozen theme tests; local Halloween phone/Screen layouts. |
| Preview/Test Game | Four modes and Answering/Reveal, isolated Preview, real-session Test marker, seven-day closed-test cleanup and history exclusion; local Preview and Test launch/close. |
| Import/export | Version-1 self-contained ZIP, fresh ID/media remap, schema/path/hash/rollback checks; strengthened art/explanation round-trip and pre-8E archive compatibility; local download/import to a new ready quiz. |
| Minimal history | Only completion time, frozen quiz identity/title, participants and final points; no answers/question detail in history; Test/incomplete exclusion and immutable closure/restart tests. |

## Final automated checks (2026-09-28)

- `npm run test`: **391 passed**, 0 failed/skipped/cancelled — 167 web + 224 server.
- `npm run typecheck`: both workspaces passed (exit 0).
- `npm run build`: web production bundle and server TypeScript build passed (exit 0).
- `git diff --check`: passed (exit 0).
- Compiled Vite preview served `/admin` and the local favicon with HTTP 200 and
  proxied `/api/health` successfully, verifying the documented compiled-run command.

## Local browser rehearsal

Isolated database under `/tmp`, local Chromium, 390×844 Host/Player and 1920×1080
Screen. Admin created/edited the Halloween quiz through the UI; representative
remaining question/media fixtures were populated through the ordinary local API,
then reviewed and played through the UI. JPG, a static GIF fixture, MP3 and MP4
were used. This checks GIF format/rendering, not animation of an animated fixture.

Passed: all four Preview modes and Reveal; Test Game launch/confirmed close; two
separate Player contexts; duplicate name rejection; Lobby rename; RU/EN switch;
pre-timer audio/video completion and manual Pause/Resume; before-Submit refresh
Pause and Wait; accepted-answer refresh; disconnect Wait; Continue confirmation,
zero/excluded current question and return next question; all four Submit types;
Matching incomplete/partial gating; confirmed Kick, removed-player UI and reconnect
401; configured leaderboard, Carol's eight-point final/Winner with Bob absent;
confirmed close; one real completed history record with no Test/incomplete record
and unchanged totals/time on closure; browser ZIP download/import to a new ready
quiz. Round art and Reveal explanations rendered through the existing components.

Host, Screen and both Players had no horizontal overflow at sampled Lobby,
question/Matching and final states. Phone Matching requires normal vertical scroll
to Submit; controls are tappable. Captured phone/Screen layouts were visually
reviewed. Autoplay was unlocked by a trusted click on Screen; no TV audio claim.
The local favicon responds successfully. Expected duplicate-name/revoked-token
requests return errors; development-tool diagnostics are not physical acceptance.

## Remaining limits and physical-device checklist

Existing V1 limits: trusted home LAN APIs; no late join/device bans; browser-owned
codec/autoplay behavior; filesystem/SQLite media operations are not power-failure
atomic; pre-8D completion timestamps cannot be reconstructed. Legacy test-session records remain excluded from history; new Test Games and their automatic cleanup have been removed. A quiz ZIP is not a full backup.

Perform these checks on the actual party equipment before calling hardware
acceptance complete:

1. Current **Safari on iPhone** and **Chrome on Android**, plus Host phone: scan
   both LAN QR links on the real Wi-Fi; duplicate name, rename, RU/EN switch,
   Single/Multiple/Yes-No, image Matching, draft changes, disabled/accepted Submit
   and long text at real phone sizes/orientations.
2. Real Wi-Fi loss, refresh, browser reopen and screen lock: before Submit →
   Pause/Wait/reconnect same question; after accepted Submit → no pause and answer
   retained; Continue → zero this question/return next; Kick → revoked tabs/token.
3. Actual laptop-to-TV HDMI or mirroring: 1920×1080/fullscreen legibility, aspect
   ratios, QR scanning distance, no cropped content; only Screen plays sound through
   the intended TV/speakers and audio/video never overlap.
4. Real party JPG/PNG/WEBP and **animated GIF**, MP3/WAV/OGG, MP4/WEBM codec playback
   on the Screen browser. Test cold-origin autoplay/block recovery, ordered pre-timer
   clips, Pause/Resume, replay without timer reset and Screen reconnect during playback.
5. Run the standalone equipment check on the TV: picture edges/circle, audible tone,
   autoplay recovery and Stop. Then complete a short regular game on these devices:
   round boundaries, leaderboard/ties, Winner, close/released code and minimal history.
   Keep laptop/Screen awake throughout.
6. Play with internet disconnected on the home Wi-Fi. Check router client isolation,
   firewall reachability and representative simultaneous guests (up to 30); avoid
   sleeping the server computer. No real Wi-Fi/load test has been performed here.
7. Stop the app, copy the entire data directory, restore it to another local path
   with `QUIZ_DB_PATH`, and verify quiz/media/history and export/import using the
   actual party files. Confirm the organizer can recover the backup before guests arrive.

No physical phone, TV, speaker or Wi-Fi testing was performed in Phase 8E.
