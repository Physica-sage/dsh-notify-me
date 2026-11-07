import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://dsh.example/base/' });
globalThis.window = dom.window; globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('    // FCM-SETTINGS-START'), source.indexOf('    // FCM-SETTINGS-END'));
const flush = fn => act(async () => { await fn?.(); await new Promise(resolve => setImmediate(resolve)); });
const initial = () => ({ enabled: false, publicUrl: '', projectId: '', includePreview: true, includeSubagents: false, approvalTtlMs: 600000, events: ['completed', 'error', 'approval', 'question', 'plan-review', 'goal'], revision: 0, hasCredentials: false, active: false, error: '', storage: 'server' });
async function render(t, options = {}) {
  const calls = []; let saved = { ...initial(), ...options.saved };
  const context = vm.createContext({ React, h: React.createElement, AbortController, URL, document: dom.window.document, location: options.location || dom.window.location, window: dom.window,
    lookupService: name => name === 'connection' ? { rpc: { async call(channel, endpoint, payload) {
      calls.push({ channel, endpoint, payload });
      if (options.denied) return { ok: false, error: { message: 'Owner access required' } };
      let value;
      if (payload.action === 'get') value = saved;
      else if (payload.action === 'save') {
        const { expectedRevision, serviceAccountJson, ...fields } = payload.settings;
        saved = { ...saved, ...fields, revision: saved.revision + 1, hasCredentials: !!serviceAccountJson || saved.hasCredentials, active: !!fields.enabled };
        value = saved;
      } else if (payload.action === 'pairing-code') value = { pairingCode: 'unit-pairing-code', expiresAt: Date.now() + 300000 };
      else if (payload.action === 'devices') value = { devices: [{ id: 'd1', name: 'Test phone', enabled: true }] };
      else if (payload.action === 'revoke') value = { devices: [] };
      else if (payload.action === 'validate') value = { validated: true, delivered: false };
      else if (payload.action === 'test') value = { accepted: 1, failed: 0, delivered: false };
      return { ok: true, value: structuredClone(value) };
    } } } : null,
  });
  vm.runInContext(code, context);
  const container = dom.window.document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
  await flush(() => root.render(React.createElement(context.FcmSettingsPanel, { lang: 'zh' })));
  t.after(async () => { await act(() => root.unmount()); container.remove(); });
  const button = name => [...container.querySelectorAll('button')].find(node => node.textContent === name);
  const input = name => container.querySelector('[aria-label="' + name + '"]');
  async function change(name, value) { await flush(() => { const element = input(name); Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(element, value); element.dispatchEvent(new dom.window.Event('input', { bubbles: true })); }); }
  async function click(name) { const node = button(name); assert.ok(node, 'Missing button: ' + name); assert.equal(node.disabled, false); await flush(() => node.click()); }
  return { container, calls, button, input, change, click };
}
test('FCM is a selectable external channel; form initially contains no deployment address', async t => {
  assert.match(source, /aria-label.*External notification channel/);
  assert.match(source, /value: "fcm".*FCM/);
  const ui = await render(t);
  assert.equal(ui.input('FCM public URL').value, ''); assert.equal(ui.input('FCM project ID').value, '');
  assert.ok(ui.button('保存到服务端')); assert.ok(ui.button('生成配对码'));
  assert.equal(ui.button('生成配对码').disabled, true);
  assert.equal(ui.calls[0].channel, '/dsh-notify-fcm'); assert.equal(ui.calls[0].endpoint, 'control');
});
test('form saves credentials only through owner Connection and never writes browser storage', async t => {
  const ui = await render(t); let writes = 0;
  const previous = dom.window.Storage.prototype.setItem; dom.window.Storage.prototype.setItem = () => { writes++; throw new Error('Browser credential persistence forbidden'); };
  t.after(() => { dom.window.Storage.prototype.setItem = previous; });
  await ui.change('FCM public URL', 'https://configured.example/'); await ui.change('FCM project ID', 'test-project');
  const fileInput = ui.input('FCM service account JSON');
  const file = { name: 'sender.json', size: 500, async text() { return '{"private_key":"UI-PRIVATE-SENTINEL"}'; } };
  Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] });
  await flush(() => fileInput.dispatchEvent(new dom.window.Event('change', { bubbles: true })));
  await flush(() => ui.input('启用 FCM 外部通知（服务端）').click());
  await ui.click('保存到服务端');
  const sent = ui.calls.find(call => call.payload.action === 'save').payload.settings;
  assert.equal(sent.publicUrl, 'https://configured.example/'); assert.equal(sent.projectId, 'test-project'); assert.equal(sent.enabled, true);
  assert.equal(sent.expectedRevision, 0); assert.ok(sent.serviceAccountJson.includes('UI-PRIVATE-SENTINEL'));
  assert.equal(writes, 0); assert.ok(!ui.container.textContent.includes('UI-PRIVATE-SENTINEL')); assert.equal(fileInput.value, '');
  await ui.click('生成配对码'); assert.equal(ui.input('FCM pairing code').value, 'unit-pairing-code');
  await ui.click('刷新设备'); assert.ok(ui.container.textContent.includes('Test phone'));
  await ui.click('撤销设备'); assert.ok(!ui.container.textContent.includes('Test phone'));
  await ui.click('发送 FCM 测试通知'); assert.ok(ui.container.textContent.includes('不等于手机已展示'));
});
test('runtime origin is used only after an explicit click, never as a compiled default', async t => {
  const ui = await render(t); assert.equal(ui.input('FCM public URL').value, '');
  await ui.click('使用当前站点地址'); assert.equal(ui.input('FCM public URL').value, 'https://dsh.example/base/');
  assert.equal(ui.calls.filter(call => call.payload.action === 'save').length, 0);
});
test('denied owner access displays refusal without rendering credential controls', async t => {
  const ui = await render(t, { denied: true });
  assert.ok(ui.container.textContent.includes('Owner access required')); assert.equal(ui.input('FCM service account JSON'), null);
});
test('remote plaintext HTTP cannot upload a selected sender credential', async t => {
  const ui = await render(t, { location: { protocol: 'http:', hostname: 'remote.example' } });
  const element = ui.input('FCM service account JSON');
  Object.defineProperty(element, 'files', { configurable: true, value: [{ name: 'sender.json', size: 100, async text() { return '{}'; } }] });
  await flush(() => element.dispatchEvent(new dom.window.Event('change', { bubbles: true })));
  await ui.click('保存到服务端');
  assert.equal(ui.calls.filter(call => call.payload.action === 'save').length, 0);
  assert.ok(ui.container.textContent.includes('远程明文 HTTP'));
});
test('saved server settings are loaded and empty file input does not erase a stored credential', async t => {
  const ui = await render(t, { saved: { enabled: true, publicUrl: 'https://configured.example/', projectId: 'test-project', hasCredentials: true, active: true, revision: 7 } });
  assert.equal(ui.input('FCM public URL').value, 'https://configured.example/');
  await ui.click('保存到服务端');
  const settings = ui.calls.find(call => call.payload.action === 'save').payload.settings;
  assert.equal(settings.expectedRevision, 7); assert.equal(settings.serviceAccountJson, undefined);
  assert.ok(ui.container.textContent.includes('不回显'));
});
