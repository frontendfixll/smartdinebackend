/* Read-only money migration preflight. Never loads backend/.env or external providers. */
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const file = path.join(root, '.env.local');
if (!fs.existsSync(file)) {
  console.error('Create backend/.env.local using the local development instructions first.');
  process.exit(1);
}
const settings = require('dotenv').parse(fs.readFileSync(file));
const uri = settings.MONGODB_URI || '';
if (!/^mongodb:\/\/(localhost|127\.0\.0\.1):\d+\/[a-z\d_-]+(?:\?[^#]*)?$/i.test(uri)) {
  console.error('This audit accepts a named database on loopback MongoDB only.');
  process.exit(1);
}
const mongoose = require('mongoose');
(async () => {
  await mongoose.connect(uri, {
    autoIndex: false,
    autoCreate: false,
    directConnection: true,
    serverSelectionTimeoutMS: 10000,
  });
  const { auditMoneyStorage } = require(path.join(root, 'dist/modules/migrations/moneyPreflight'));
  const report = await auditMoneyStorage(mongoose.connection);
  const out = path.resolve(root, '../verification/money-preflight-local.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`Read-only audit saved: ${out}. Reconciled: ${report.reconciled}. No data changed.`);
  if (!report.reconciled) process.exitCode = 2;
})()
  .catch(() => {
    console.error('The local money audit failed. Check the local database and build the backend.');
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
