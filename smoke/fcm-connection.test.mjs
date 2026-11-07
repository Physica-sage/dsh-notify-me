import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection';
import { mountFcmSettings, FCM_CHANNEL, FCM_CONTROL } from '../lib/fcm-settings.js';

// Keep the actual DSH 0.2.2 Connection register/admission/bridge methods.
// Replace only persistent browser-cookie IO and its owning service container.
test('real DSH authenticated RPC serves FCM without taking the shared /api interceptor', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fcm-connection-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const routes = new Map();
  const web = { host: '127.0.0.1', protocol: 'http:', register(route) { assert.ok(!routes.has(route.path)); routes.set(route.path, route); return () => routes.delete(route.path); } };
  const owner = { webServer: web, get(name) { return name === 'webServer' ? web : undefined; }, effect(fn) { return fn(); } };
  const connection = Object.create(HostConnectionService.prototype);
  Object.defineProperty(connection, 'ctx', { value: owner });
  Object.assign(connection, { owner, trustedHosts: [], disposed: false, interceptors: new Map(), fetchRoutes: new Map(),
    browserPeer: { id: 'owner', principal: { kind: 'owner' } },
    peers: new Map([['guest', { peer: { id: 'guest', principal: { kind: 'guest' } } }]]),
    browserAuth: { isAuthenticated(request) { return request.headers.cookie === 'fixture=owner'; }, authenticateApi(request) { return request.headers.authorization === 'Bearer guest' ? 'guest' : undefined; } },
  });
  const releaseGateway = connection.rpc.intercept('/api', () => true, async () => ({ ok: true, value: 'existing-gateway' }));
  const ctx = { connection };
  const scope = await mountFcmSettings(ctx, { settingsFile: join(directory, 'settings.json') });
  assert.equal(connection.interceptors.size, 1); assert.ok(routes.has(FCM_CHANNEL));
  const server = createServer((req, res) => {
    const route = [...routes.values()].find(route => req.url === route.path || req.url.startsWith(route.path + '/'));
    if (!route) { res.statusCode = 404; res.end(); return; }
    route.handler(req, res).catch(() => { res.statusCode = 500; res.end('fixture failure'); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await scope.dispose(); releaseGateway(); await new Promise(resolve => server.close(resolve)); });
  const base = 'http://127.0.0.1:' + server.address().port + FCM_CHANNEL;
  async function post(payload, headers = {}, endpoint = FCM_CONTROL) {
    return fetch(base + '/' + endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint, payload }) });
  }
  assert.equal((await post({ action: 'get' })).status, 401);
  assert.equal((await post({ action: 'get' }, { cookie: 'fixture=owner', origin: 'https://evil.example' })).status, 403);
  const denied = await (await post({ action: 'get' }, { authorization: 'Bearer guest' })).json();
  assert.equal(denied.result.ok, false); assert.equal(denied.result.error.code, 'forbidden');
  const allowed = await (await post({ action: 'get' }, { cookie: 'fixture=owner' })).json();
  assert.equal(allowed.type, 'server-response'); assert.equal(allowed.result.ok, true);
  assert.equal(allowed.result.value.publicUrl, ''); assert.equal(allowed.result.value.storage, 'server');
  const saved = await (await post({ action: 'save', settings: { expectedRevision: 0, publicUrl: 'https://configured.example/' } }, { cookie: 'fixture=owner' })).json();
  assert.equal(saved.result.ok, true); assert.equal(saved.result.value.revision, 1);
  const again = await (await post({ action: 'get' }, { cookie: 'fixture=owner' })).json();
  assert.equal(again.result.value.publicUrl, 'https://configured.example/');
  const unknown = await (await post({ action: 'get' }, { cookie: 'fixture=owner' }, 'other')).json(); assert.equal(unknown.result.error.code, 'not-found');
});
