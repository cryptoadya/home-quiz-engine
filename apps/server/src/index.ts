import { createQuizServer } from './realtime.js';
import { initializeDatabase } from './db.js';

const db = initializeDatabase();
const port = Number(process.env.PORT ?? 3001);
const { server, io, deadlines } = createQuizServer(db);
server.listen(port, '0.0.0.0', () => {
  console.log(`Quiz server listening on http://localhost:${port}`);
});

function shutdown() {
  deadlines.stop();
  io.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
