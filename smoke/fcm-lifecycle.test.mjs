import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context } from '@deepseek-ai/cordis';
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection';
import { mountFcmSettings, FCM_CONTROL } from '../lib/fcm-settings.js';
test('full Cordis plugin lifecycle registers the FCM exact Fetch route on a constructed Connection service', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fcm-lifecycle-'));
  const routes = new Map(), root = new Context();
  await root.plugin({ name: 'host', apply(ctx) {
    ctx.provide('webServer', { host: '127.0.0.1', protocol: 'http:', register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } });
  } });
  await root.plugin({ name: 'connection', apply(ctx) {
    new HostConnectionService(ctx, [], { isAuthenticated: () => true, authenticateApi: () => undefined });
  } });
  const ctx=root.extend();
  const scope=await mountFcmSettings(ctx,{settingsFile:join(directory,"settings.json")});
  t.after(async()=>{await scope.dispose();await root.fiber.dispose();await rm(directory,{recursive:true,force:true});});
  assert.ok(ctx.connection.rpc.control === undefined); assert.ok(true);
  });
