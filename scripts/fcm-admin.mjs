#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stateDirectory } from '../lib/fcm-store.js';
const [action, ...args] = process.argv.slice(2);
function arg(key, fallback) { const i = args.indexOf(key); return i < 0 ? fallback : args[i + 1]; }
if (!['pairing-code', 'devices', 'revoke', 'test'].includes(action)) {
  console.error('Usage: node scripts/fcm-admin.mjs pairing-code|devices|revoke|test --base https://dsh.example/ [--admin-token-file path] [--device-id id]');
  process.exit(1);
}
const base = new URL(arg('--base', 'http://127.0.0.1:3080/'));
if (base.username || base.password || base.search || base.hash || (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))) throw new Error('Only HTTPS or local loopback HTTP is allowed');
if (!base.pathname.endsWith('/')) base.pathname += '/';
const key = (await readFile(arg('--admin-token-file', join(stateDirectory(), 'fcm-admin-token')), 'utf8')).trim();
const response = await fetch(new URL('__dsh-notify-me/fcm/admin', base), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify({ action, deviceId: arg('--device-id') }) });
const data = await response.json();
if (!response.ok || !data.ok) throw new Error('Admin request failed: ' + response.status);
if (data.pairingCode) console.log('配对码（5 分钟有效，仅使用一次）：\n' + data.pairingCode);
else console.log(JSON.stringify(data, null, 2));
