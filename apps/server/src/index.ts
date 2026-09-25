import { createApp } from './app.js';
import { initializeDatabase } from './db.js';

const db = initializeDatabase();
const port = Number(process.env.PORT ?? 3001);
const server = createApp(db).listen(port, '0.0.0.0', () => {
  console.log(`Quiz server listening on http://localhost:${port}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
