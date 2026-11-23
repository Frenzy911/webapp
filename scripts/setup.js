'use strict';

// One-time local setup: create .env from .env.example (with a fresh random secret) and load demo data.
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

const config = loadConfig();
const db = openDb(config.dbFile);
seedDatabase(db, config);
db.close();
console.log(`Database ready with demo data: ${path.relative(root, config.dbFile)}`);
console.log('Next: npm start, then open ' + config.baseUrl);
