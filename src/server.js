'use strict';

const { createApp } = require('./app');
const { seedIfEmpty } = require('./db/seed');

const app = createApp();
const { config, db } = app.locals;

if (config.autoSeed && seedIfEmpty(db, config)) {
  console.log('Empty database: loaded demo data (see README for the staff logins).');
}

const server = app.listen(config.port, () => {
  console.log(`Cebu Events running at ${config.baseUrl}  (port ${config.port})`);
  console.log(`Staff sign-in: ${config.baseUrl}/staff/login`);
});

function shutdown() {
  server.close(() => {
    app.locals.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
