import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { FcmSettings, fcmControlHandler, mountFcmSettings, parseFcmCredential, FCM_CONTROL } from '../lib/fcm-settings.js';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const account = { type: 'service_account', project_id: 'test-project', client_email: 'sender@test-project.iam.gserviceaccount.com', private_key: privateKey };
const config = { enabled: true, publicUrl: 'https://dsh.example/', projectId: 'test-project', serviceAccountJson: JSON.stringify(account), expectedRevision: 0 };
const owner = { principal: { kind: 'owner' } };
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fcm-settings-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const mounted = [], initial = { settingsFile: join(directory, 'settings.json') };
  const deps = { async mount(ctx, value) {
    const state = { value, disposed: false, store: { devices: () => [{ id: 'device-1', token: 'test-token' }], list: () => [{ id: 'device-1', name: 'Phone', enabled: true }], createPairing: async () => ({ pairingCode: 'one-use', expiresAt: 123 }), revoke: async () => {}, removeToken: async () => {} }, sender: { async send() {}, async validate() {} }, async dispose() { state.disposed = true; } };
    mounted.push(state); return state;
  } };
  const manager = await new FcmSettings({}, initial, deps).init(); t.after(() => manager.dispose());
  return { directory, initial, deps, manager, mounted };
}
test('server-owned configuration persists across fresh instances and never returns credentials', async t => {
  const f = await fixture(t), initial = f.manager.view();
  assert.equal(initial.enabled, false); assert.equal(initial.publicUrl, '');
  const saved = await f.manager.save(config);
  assert.equal(saved.revision, 1); assert.equal(saved.hasCredentials, true); assert.equal(saved.storage, 'server');
  assert.ok(!JSON.stringify(saved).includes(privateKey)); assert.ok(!JSON.stringify(saved).includes('private_key')); assert.ok(!JSON.stringify(saved).includes('client_email'));
  if (process.platform !== 'win32') assert.equal((await stat(f.initial.settingsFile)).mode & 0o777, 0o600);
  await f.manager.dispose();
  const fresh = await new FcmSettings({}, f.initial, f.deps).init(); t.after(() => fresh.dispose());
  assert.equal(fresh.view().publicUrl, 'https://dsh.example/'); assert.equal(fresh.view().active, true);
  const next = await fresh.save({ expectedRevision: 1, includePreview: false });
  assert.equal(next.hasCredentials, true); assert.equal(next.includePreview, false);
  const third = await fresh.save({ expectedRevision: 2, enabled: false, removeCredentials: true });
  assert.equal(third.hasCredentials, false); assert.equal(third.active, false);
  assert.ok(!JSON.stringify(await readFile(f.initial.settingsFile, 'utf8')).includes('PRIVATE KEY'));
});
test('stale concurrent edits and invalid settings never replace the saved configuration', async t => {
  const { manager } = await fixture(t); await manager.save(config);
  const edits = await Promise.allSettled([manager.save({ expectedRevision: 1, includePreview: false }), manager.save({ expectedRevision: 1, includeSubagents: true })]);
  assert.equal(edits.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(manager.view().revision, 2);
  for (const patch of [{ publicUrl: 'http://dsh.example/' }, { events: ['bogus'] }, { enabled: 'true' }, { serviceAccountJson: '{broken' }, { serviceAccountJson: JSON.stringify({ ...account, project_id: 'other-project' }) }]) {
    await assert.rejects(manager.save({ expectedRevision: 2, ...patch })); assert.equal(manager.view().revision, 2);
  }
});
test('owner RPC gate rejects guests and missing principals before looking at sensitive payload', async t => {
  const { manager } = await fixture(t), handler = fcmControlHandler(manager);
  const payload = { action: 'save', settings: config };
  for (const peer of [undefined, {}, { principal: { kind: 'agent' } }, { principal: { kind: 'api' } }]) {
    const answer = await handler(FCM_CONTROL, payload, undefined, peer); assert.equal(answer.ok, false); assert.equal(answer.error.code, 'forbidden');
  }
  assert.equal(manager.view().revision, 0);
  assert.equal((await handler(FCM_CONTROL, payload, undefined, owner)).ok, true);
  const described = await handler(FCM_CONTROL, { action: 'get' }, undefined, owner);
  assert.equal(described.value.hasCredentials, true); assert.ok(!JSON.stringify(described).includes(privateKey));
});
test('registration uses the authenticated shared Connection, not an unauthenticated web route', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fcm-settings-rpc-')); t.after(() => rm(directory, { recursive: true, force: true }));
  let registered, disposed = false;
  const ctx = { connection: { browserPeer: owner, fetch: { register(route) { registered = route; return async () => { disposed = true; }; } } } };
  const scope = await mountFcmSettings(ctx, { settingsFile: join(directory, 'settings.json') });
  assert.equal(registered.path, '/api/' + FCM_CONTROL); assert.deepEqual(registered.methods, ['POST']);
  assert.equal((await registered.fetch(new Request('http://dsh.example/api/' + FCM_CONTROL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'fixture', method: FCM_CONTROL, payload: { action: 'get' } }) }))).status, 200);
  await scope.dispose(); assert.equal(disposed, true);
});
test('credential parser discards all attacker-selected OAuth URLs and reports no private data', () => {
  const cleaned = parseFcmCredential(JSON.stringify({ ...account, token_uri: 'https://attacker.example/token', universe_domain: 'attacker.example' }), 'test-project');
  assert.equal(cleaned.token_uri, undefined); assert.equal(cleaned.universe_domain, undefined);
  assert.throws(() => parseFcmCredential(JSON.stringify({ ...account, private_key: 'not a key' }), 'test-project'), e => !e.message.includes('not a key'));
});
test('startup failure and failed activation roll back state without committing a new file', async t => {
  const f = await fixture(t); await f.manager.save(config);
  const original = await readFile(f.initial.settingsFile, 'utf8');
  const mount = f.manager.mount; f.manager.mount = async (ctx, value) => { if (!value.includePreview) throw new Error(privateKey); return mount(ctx, value); };
  await assert.rejects(f.manager.save({ expectedRevision: 1, includePreview: false }), e => !e.message.includes(privateKey));
  assert.equal(f.manager.view().revision, 1); assert.equal(f.manager.view().active, true);
  assert.equal(await readFile(f.initial.settingsFile, 'utf8'), original);
});
test('corrupt saved settings fail closed and remain untouched', async t => {
  const f = await fixture(t); await writeFile(f.initial.settingsFile, '{broken', { mode: 0o600 });
  await assert.rejects(new FcmSettings({}, f.initial, f.deps).init());
  assert.equal(await readFile(f.initial.settingsFile, 'utf8'), '{broken');
});
test('pairing, device management, validation and send test keep acceptance distinct from delivery', async t => {
  const { manager, mounted } = await fixture(t); await manager.save(config);
  assert.equal((await manager.control({ action: 'pairing-code' })).pairingCode, 'one-use');
  assert.equal((await manager.control({ action: 'devices' })).devices[0].name, 'Phone');
  assert.equal((await manager.control({ action: 'revoke', deviceId: 'device-1' })).devices.length, 1);
  assert.deepEqual(await manager.control({ action: 'validate' }), { validated: true, delivered: false });
  assert.deepEqual(await manager.control({ action: 'test' }), { accepted: 1, failed: 0, delivered: false });
  mounted[0].sender.validate = async () => { throw Object.assign(new Error("Permission 'cloudmessaging.messages.create' denied; https://provider.example?private_key=DO-NOT-RETURN"), { code: 'messaging/mismatched-credential' }); };
  const denied = await fcmControlHandler(manager)(FCM_CONTROL, { action: 'validate' }, undefined, owner);
  assert.equal(denied.error.code, 'fcm/permission-denied'); assert.match(denied.error.message, /cloudmessaging\.messages\.create/);
  assert.ok(!JSON.stringify(denied).includes('private_key')); assert.ok(!JSON.stringify(denied).includes('DO-NOT-RETURN')); assert.ok(!JSON.stringify(denied).includes('provider.example'));
  mounted[0].sender.send = async () => { throw Object.assign(new Error('network failure'), { code: 'app/network-error' }); };
  const test = await manager.control({ action: 'test' });
  assert.equal(test.failed, 1); assert.equal(test.delivered, false); assert.equal(test.failures[0].code, 'fcm/network-error');
});
