'use strict';

// One-time local setup: create .env from .env.example (with a fresh random secret), then create the
// MySQL database and tables and load demo data. MySQL must be running (XAMPP: Start MySQL).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const envPath = path.join(root, '.env');
const examplePath = path.join(root, '.env.example');

if (fs.existsSync(envPath)) {
  console.log('.env already exists: leaving it as is.');
} else {
  const secret = crypto.randomBytes(32).toString('hex');
  const text = fs.readFileSync(examplePath, 'utf8').replace(/^SESSION_SECRET=.*$/m, `SESSION_SECRET=${secret}`);
  fs.writeFileSync(envPath, text);
  console.log('Created .env with a random SESSION_SECRET.');
}

const { loadConfig } = require('../src/config');
const { openDb } = require('../src/db');
const { seedDatabase } = require('../src/db/seed');

(async () => {
  const config = loadConfig();
  const db = await openDb(config.mysql);
  try {
    await seedDatabase(db, config);
  } finally {
    await db.end();
  }
  console.log(`MySQL database "${config.mysql.database}" on ${config.mysql.host}:${config.mysql.port} is ready with demo data.`);
  console.log('Next: npm start, then open ' + config.baseUrl);
})().catch((err) => {
  console.error(`Setup failed: ${err.message}`);
  process.exit(1);
});
