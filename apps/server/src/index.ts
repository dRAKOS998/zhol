import { loadConfig } from './config.js';
import { createZholServer } from './app.js';

const config = loadConfig();
const server = createZholServer({ config });
const port = await server.listen();
console.log(
  JSON.stringify({
    t: new Date().toISOString(),
    event: 'listening',
    port,
    allowedOrigins: config.allowedOrigins,
    database: config.databasePath,
  }),
);

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    server
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
}
