# Home Quiz Engine

Private RU/EN quiz engine for parties on one home LAN. Admin authors quizzes;
Host controls the game, Screen presents it, and guests answer on phones.

## Install and start

Install Node.js **22.13 or newer** and npm. From this repository:

```sh
npm ci
npm run dev
```

Keep that terminal and the host computer awake throughout the party. The web
server listens on port **5173** and the API on **3001**. Allow local network access
in the computer firewall. The web server proxies API and realtime traffic, so
phones use port 5173. All application assets, QR generation, media and themes are
local; internet is needed for dependency installation, not for playing.

For a compiled run, use two terminals after `npm run build`:

```sh
npm run start -w apps/server
npm exec -w apps/web -- vite preview --host 0.0.0.0 --port 5173
```

The preview server uses the same local API/realtime proxy. Do not expose these
organizer APIs to the public internet; this is a trusted home LAN application.

## Run a party

1. Open `http://<computer-LAN-IP>:5173/admin`. Create/edit a quiz, choose Default
   or Halloween, upload media, complete RU/EN text, and wait for **Saved** and
   **Ready to play**. Use question Preview, then Start Test Game to rehearse.
2. Open a real Lobby. Admin navigates to `/host/<roomId>`; its **Open Screen**
   link opens `/screen/<roomId>`. Use the **LAN address on Screen**, even on the
   computer itself: localhost QR links cannot work on guests' phones. Vite prints
   available LAN addresses; pick the address belonging to the party Wi-Fi.
3. Connect the laptop to the TV by HDMI/cable or your existing mirroring setup.
   Screen is a browser presentation, not a native TV app. Keep Screen open and
   test TV sound/fullscreen before admitting guests. Only Screen plays audio/video.
4. Guests join the same Wi-Fi and scan RU/EN QR, or visit
   `http://<computer-LAN-IP>:5173/play` and enter the room code. Direct links are
   `/play/<code>?lang=ru` and `?lang=en`. Up to 30 players; duplicate names are
   rejected. Guests can rename in Lobby and switch language throughout the game.
5. Start Game freezes content and roster. No late joins. Use Start Round and
   Start Question; flagged media completes before answers/timer begin. Guests
   must press Submit. Reveal is automatic on all participating submissions or timeout.
6. Disconnect before Submit pauses automatically. **Wait for Player** becomes
   available after reconnect; **Continue Without Player** confirms a zero for this
   question and lets the player return next question. **Kick** permanently removes
   that identity from roster/standings. It preserves accepted records, revokes all
   its tabs, and cannot be undone by reconnect. A kicked guest could make a new
   Lobby identity before Start; V1 has no device bans. After completion Kick is
   disabled to keep final standings and recorded history consistent.
7. Advance through rounds, Final Results, then Show Winner. Tied winners share
   first place. Close room confirms closure and releases the code. Abandoned
   games are excluded from completed history; Test Games never enter normal history.

Autoplay depends on the browser. Click once on Screen before playing media and
allow autoplay for that local origin if blocked, then retry Play/Restart from
Host. A blocked required pre-timer clip will hold the timer until playback completes.
Keep guests in their original browser (not private mode); reconnect tokens live
in that browser's local storage. Refresh/reopen restores accepted submissions.
If a phone goes offline before Submit, Host must resolve the pause.

## Data and backup

Default database: `data/quiz.sqlite`. Quiz media is in
`data/quizzes/<quizId>/media`; frozen session media is in `data/sessions`.
Stop the app before copying the **whole data directory** for a consistent backup.
`QUIZ_DB_PATH=/absolute/path/quiz.sqlite` relocates the database and adjacent media.
A quiz ZIP is a portable quiz/media export, not a backup of rooms or history.
Completed real-game history stores date, frozen quiz identity/title, participants
and final scores only. Closed Test Games are cleaned at startup after seven days.

## Acceptance

```sh
npm run test
npm run typecheck
npm run build
git diff --check
```

See [V1 acceptance](docs/V1_ACCEPTANCE.md) for audit evidence and the exact pending
physical-device checklist. Local Chromium testing does not establish iPhone Safari,
Android Chrome, real Wi-Fi or TV acceptance. Product behavior is in
[the spec](docs/SPEC.md); service/state boundaries are in
[the architecture](docs/ARCHITECTURE.md).
