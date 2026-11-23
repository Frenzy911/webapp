'use strict';

const { createApp } = require('./app');
const { seedIfEmpty } = require('./db/seed');

async function main() {
  const app = await createApp();
  const { config, db } = app.locals;
  const where = `${config.mysql.user}@${config.mysql.host}:${config.mysql.port}/${config.mysql.database}`;

  if (config.autoSeed && (await seedIfEmpty(db, config))) {
    console.log(`Empty database (${where}): loaded demo data (see README for the staff logins).`);
  }

  const server = app.listen(config.port, () => {
    console.log(`Cebu Events running at ${config.baseUrl}  (port ${config.port}, MySQL ${where})`);
    console.log(`Staff sign-in: ${config.baseUrl}/staff/login`);
  });

  function shutdown() {
    server.close(async () => {
      await app.locals.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(`Could not start: ${err.message}`);
  process.exit(1);
});
