# Home Quiz Engine

Private quiz engine for parties on one home network. Phase 0 provides the local app skeleton; quiz editing and gameplay come in later phases.

## Local setup

Requires Node.js 22.13+ and npm. From the repository root:

```sh
npm install
npm run dev
```

Open `http://localhost:5173/admin`, `/host`, `/screen`, or `/play`. Other devices on the same Wi-Fi can use the host computer's LAN IP with port `5173`. The web dev server forwards `/api` requests to the Express server on port `3001`; check `http://localhost:5173/api/health` for `{ "status": "ok" }`.

The server creates `data/quiz.sqlite` on startup. Set `QUIZ_DB_PATH` to use another database path. Node 22 currently prints an experimental warning for its built-in SQLite module.

## Checks

```sh
npm run test
npm run typecheck
npm run build
```

The frontend build is in `apps/web/dist` and the server build is in `apps/server/dist`. `npm run start -w apps/server` starts the compiled API; the frontend build is static and can be served by a local static-file server when needed.

See `docs/SPEC.md`, `docs/ROADMAP.md`, `docs/ARCHITECTURE.md`, and `docs/phases/00-foundation.md` for the product and phase boundaries.
