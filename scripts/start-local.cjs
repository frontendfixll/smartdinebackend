const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const dotenv = require('dotenv');
const root = path.resolve(__dirname, '..');
const file = path.join(root, '.env.local');
if (!fs.existsSync(file)) {
  console.error('Create backend/.env.local from backend/local.env.example and fill in local secrets.');
  process.exit(1);
}
const settings = dotenv.parse(fs.readFileSync(file));
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\//.test(settings.MONGODB_URI || '')) {
  console.error('dev:local accepts only a loopback MongoDB address. Use the local replica set.');
  process.exit(1);
}
const args = process.argv.includes('--bootstrap') ? ['scripts/bootstrap-local.cjs'] : ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register', 'src/server.ts'];
const child = spawn(process.execPath, args, {
  cwd: root, stdio: 'inherit', env: { ...process.env, ...settings, RESTAURANT_ENV_FILE: file },
});
child.on('exit', code => process.exit(code ?? 1));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
