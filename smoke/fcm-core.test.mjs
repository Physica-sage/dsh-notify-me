import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Context } from '@deepseek-ai/cordis';
import { DeviceStore, loadAdminSecret } from '../lib/fcm-store.js';
import { ApprovalBroker, mountFcm, normalizeFcm, sessionLink, PREFIX } from '../lib/fcm-service.js';
import { FcmSender, invalidRegistration } from '../lib/fcm-sender.js';
const token = 'token-for-unit-tests-only-1234567890';
const cfg = { projectId: 'test-project', publicUrl: 'https://dsh.example/' };
async function temp(t) { const d = await mkdtemp(join(tmpdir(), 'dsh-fcm-')); t.after(() => rm(d, { recursive: true, force: true })); return d; }
const tick = () => new Promise(r => setImmediate(r));

test('private registry pairs once even under concurrent requests', async t => {
  const dir = await temp(t), s = await new DeviceStore(join(dir, 'state.json')).init();
  const { pairingCode } = await s.createPairing();
  const results = await Promise.allSettled([s.pair({ pairingCode, token, name: 'phone' }), s.pair({ pairingCode, token, name: 'other' })]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  const { deviceId, deviceSecret } = results.find(x => x.status === 'fulfilled').value;
  assert.ok(s.authenticate(`${deviceId}.${deviceSecret}`));
  assert.equal(s.authenticate(`${deviceId}.wrong`), null);
  const text = await readFile(s.file, 'utf8'); assert.ok(!text.includes(deviceSecret)); assert.ok(!text.includes(pairingCode));
  if (process.platform !== 'win32') assert.equal((await stat(s.file)).mode & 0o777, 0o600);
  await s.updateToken(deviceId, token + 'new', 2);
  assert.equal(await s.updateToken(deviceId, token + 'old', 1), false);
  assert.equal(s.devices()[0].token, token + 'new');
  await s.revoke(deviceId); assert.equal(s.authenticate(`${deviceId}.${deviceSecret}`), null); assert.equal(s.devices().length, 0);
});
test('expiry, malformed token and corrupt registry fail closed', async t => {
  const dir = await temp(t); let clock = 100;
  const s = await new DeviceStore(join(dir, 'state.json'), () => clock).init();
  const { pairingCode } = await s.createPairing(); clock += 300001;
  await assert.rejects(s.pair({ pairingCode, token }), /expired/);
  await assert.rejects(s.pair({ pairingCode, token: 'bad' }), /token/);
  await writeFile(s.file, '{corrupt', { mode: 0o600 });
  await assert.rejects(new DeviceStore(s.file).init(), /refusing/);
});
test('deep links preserve subpaths and reject unsafe URL/session ids', () => {
  assert.equal(sessionLink('https://dsh.example/base/', 'session-abc'), 'https://dsh.example/base/#dsh-notify-session=session-abc');
  assert.throws(() => normalizeFcm({ ...cfg, publicUrl: 'http://dsh.example/' }));
  assert.throws(() => normalizeFcm({ ...cfg, publicUrl: 'https://user:pass@dsh.example/' }));
  assert.throws(() => sessionLink(cfg.publicUrl, '../bad'));
});
test('phone wins exact live approval, browser late answer cannot change it', async () => {
  const b = new ApprovalBroker(), agent = { session: { id: 'session-1' } };
  let entry, browser;
  const answer = b.capture({ agent, toolName: 'bash' }, () => new Promise(r => { browser = r; }), e => { entry = e; });
  await tick();
  assert.throws(() => b.decide({ requestId: entry.id, sessionId: 'wrong', outcome: 'allowed-once' }));
  assert.throws(() => b.decide({ requestId: entry.id, sessionId: 'session-1', outcome: 'allowed-always' }));
  assert.deepEqual(b.decide({ requestId: entry.id, sessionId: 'session-1', outcome: 'allowed-once' }), { outcome: 'allowed-once' });
  browser('rejected'); assert.equal(await answer, 'allowed-once');
  assert.throws(() => b.decide({ requestId: entry.id, sessionId: 'session-1', outcome: 'allowed-once' }), /settled/);
  b.dispose();
});
test('unavailable web UI still waits for phone; cancellation and timeout fail closed', async () => {
  const b = new ApprovalBroker(20), agent = { session: { id: 'session-2' } }, abort = new AbortController();
  let entry;
  const answer = b.capture({ agent, signal: abort.signal }, async () => 'unavailable', e => { entry = e; });
  await tick(); assert.ok(b.pending.has(entry.id)); abort.abort(); assert.equal(await answer, 'cancelled');
  assert.throws(() => b.decide({ requestId: entry.id, sessionId: 'session-2', outcome: 'allowed-once' }));
  // Keep a referenced timer so an intentionally unref'ed approval timer can fire in Node tests.
  const held = setTimeout(() => {}, 100);
  assert.equal(await b.capture({ agent }, async () => 'unavailable', () => {}), 'unavailable'); clearTimeout(held); b.dispose();
});
test('real Cordis waterfall keeps browser and native approval listeners composed', async () => {
  const ctx = new Context(), broker = new ApprovalBroker(), agent = { session: { id: 'real-session' } };
  let entry;
  ctx.on('approval/request', (req, next) => broker.capture(req, next, e => { entry = e; }), { global: true, prepend: true });
  ctx.on('approval/request', async () => 'unavailable');
  const pending = ctx.waterfall('approval/request', { agent }, async () => 'unavailable');
  await tick(); broker.decide({ requestId: entry.id, sessionId: 'real-session', outcome: 'rejected' });
  assert.equal(await pending, 'rejected'); broker.dispose();
});
test('FCM sender uses data-only high-priority Android payload with no credentials', async () => {
  let sent;
  const sender = new FcmSender(cfg, { messaging: { async send(m) { sent = m; return 'id'; } } });
  await sender.send({ token }, { event: 'approval', body: 'hello' });
  assert.equal(sent.notification, undefined); assert.equal(sent.android.priority, 'high'); assert.equal(sent.data.body, 'hello');
  await assert.rejects(sender.send({ token }, { body: '中'.repeat(2000) }), /oversized/);
  assert.equal(invalidRegistration({ code: 'messaging/registration-token-not-registered' }), true);
  assert.equal(invalidRegistration({ code: 'messaging/mismatched-credential' }), false);
});
test('actual HTTP pairing/device/admin routes enforce credentials and safe notification metadata', async t => {
  const dir = await temp(t), hooks = new Map(), routes = new Map(), deliveries = [];
  let liveAgent;
  const ctx = { logger: { info() {}, warn() {} }, agents: { get() { return liveAgent; } },
    on(name, fn) { hooks.set(name, fn); return () => hooks.delete(name); },
    webServer: { register({ path, handler }) { routes.set(path, handler); return () => routes.delete(path); } } };
  const instance = await mountFcm(ctx, { ...cfg, storeFile: join(dir, 'state.json'), adminTokenFile: join(dir, 'admin') }, { sender: { async send(d, data) { deliveries.push({ d, data }); } } });
  const server = createServer((req, res) => { const fn = routes.get(req.url); if (fn) void fn(req, res); else { res.statusCode = 404; res.end(); } });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { await instance.dispose(); await new Promise(r => server.close(r)); });
  const base = `http://127.0.0.1:${server.address().port}${PREFIX}`;
  const post = async (action, data, bearer, origin) => {
    const r = await fetch(base + '/' + action, { method: 'POST', headers: { 'content-type': 'application/json', ...(bearer ? { authorization: 'Bearer ' + bearer } : {}), ...(origin ? { origin } : {}) }, body: JSON.stringify(data) });
    return { status: r.status, body: await r.json() };
  };
  assert.equal((await post('admin', { action: 'devices' })).status, 401);
  const admin = (await readFile(join(dir, 'admin'), 'utf8')).trim();
  const code = (await post('admin', { action: 'pairing-code' }, admin)).body.pairingCode;
  const paired = await post('pair', { pairingCode: code, token, name: 'test' });
  assert.equal(paired.status, 200);
  const bearer = paired.body.deviceId + '.' + paired.body.deviceSecret;
  assert.equal((await post('device', { token: token + 'new', revision: 1 }, bearer)).status, 200);
  assert.equal((await post('device', { token, revision: 2 }, bearer, 'https://evil.example')).status, 403);
  assert.equal((await post('decision', { requestId: 'made-up', sessionId: 's', outcome: 'allowed-once' }, bearer)).status, 409);
  const session = { id: 'session-1', header: { cwd: '/work/demo' } };
  instance.handleEvent(session, { type: 'session/title', data: { title: '部署测试' } });
  instance.handleEvent(session, { type: 'tool/call', data: { callId: 'q1', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ question: '选哪个？', options: [{ label: 'A' }] }] }) } });
  instance.handleEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  instance.handleEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await Promise.all([...instance.jobs]); await tick();
  assert.equal(deliveries.length, 2); assert.equal(deliveries[0].data.sessionTitle, '部署测试');
  assert.equal(deliveries[0].data.url, 'https://dsh.example/#dsh-notify-session=session-1');
  assert.ok(deliveries[0].data.body.includes('选哪个')); assert.ok(!JSON.stringify(deliveries).includes(paired.body.deviceSecret));
  liveAgent = { session };
  instance.handleEvent(session, { type: 'tool/call', data: { callId: 'bash1', name: 'bash', arguments: JSON.stringify({ command: 'echo fixture-only' }) } });
  const decision = hooks.get('approval/request')({ agent: liveAgent, toolName: 'bash', callId: 'bash1', reason: 'Fixture request' }, async () => 'unavailable');
  await tick(); await Promise.all([...instance.jobs]);
  const approval = deliveries.find(x => x.data.event === 'approval').data;
  assert.ok(approval.body.includes('echo fixture-only'));
  assert.equal((await post('decision', { requestId: approval.requestId, sessionId: 'wrong', outcome: 'allowed-once' }, bearer)).status, 409);
  assert.equal((await post('decision', { requestId: approval.requestId, sessionId: session.id, outcome: 'allowed-once' }, bearer)).status, 200);
  assert.equal(await decision, 'allowed-once');
  assert.equal((await post('decision', { requestId: approval.requestId, sessionId: session.id, outcome: 'allowed-once' }, bearer)).status, 409);
  assert.equal((await post('device', { action: 'unpair' }, bearer)).status, 200);
  assert.equal((await post('device', { token, revision: 3 }, bearer)).status, 401);
});
