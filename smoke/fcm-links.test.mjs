import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const start = source.indexOf('    function installSessionDeepLinks()');
const end = source.indexOf('    // ─────────────── approval quick-decision bridge', start);
assert.ok(start > 0 && end > start);
const code = source.slice(start, end);
function harness(hash, ready = true) {
  let current = null, service = true, now = 0;
  const opened = [], listeners = new Set(), timers = new Map(), events = new Map(); let next = 0;
  const location = new URL('https://dsh.example/' + hash);
  let snapshot = { phase: ready ? 'ready' : 'loading', byId: ready ? { 'session-1': {} } : {} };
  const context = vm.createContext({ location,
    Date: { now: () => now },
    history: { state: {}, replaceState(s, title, path) { location.href = new URL(path, location).href; } },
    window: { addEventListener: (event, fn) => events.set(event, fn), removeEventListener: event => events.delete(event) },
    setInterval: fn => { timers.set(++next, fn); return next; }, clearInterval: i => timers.delete(i),
    currentSessionId: () => current,
    listStore: { getSnapshot: () => snapshot, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } },
    lookupService: name => name === 'uiWorkspace' && service ? { openSession(id) { opened.push(id); } } : null,
  });
  vm.runInContext(code, context); const stop = context.installSessionDeepLinks();
  return { opened, location, timers, stop,
    ready() { snapshot = { phase: 'ready', byId: { 'session-1': {} } }; listeners.forEach(fn => fn()); },
    service(v) { service = v; }, tick() { [...timers.values()].forEach(fn => fn()); },
    select() { current = 'session-1'; listeners.forEach(fn => fn()); },
    expire() { now = 61000; [...timers.values()].forEach(fn => fn()); },
    hash(value) { location.hash = value; events.get('hashchange')?.(); },
  };
}
test('cold page waits for session list, opens once and strips only its fragment after success', () => {
  const h = harness('#dsh-notify-session=session-1', false); assert.equal(h.opened.length, 0);
  h.service(false); h.ready(); assert.equal(h.opened.length, 0);
  h.service(true); h.tick(); h.tick(); assert.deepEqual(h.opened, ['session-1']);
  h.select(); assert.equal(h.location.hash, ''); assert.equal(h.timers.size, 0); h.stop();
});
test('malformed and missing session links never open arbitrary sessions', () => {
  for (const hash of ['#dsh-notify-session=%XX', '#dsh-notify-session=..%2Fbad', '#dsh-notify-session=missing']) {
    const h = harness(hash); h.expire(); assert.equal(h.opened.length, 0); assert.equal(h.timers.size, 0); h.stop();
  }
});
test('reused page accepts a new notification hash and cleanup stops work', () => {
  const h = harness(''); h.hash('#dsh-notify-session=session-1'); assert.deepEqual(h.opened, ['session-1']); h.stop(); assert.equal(h.timers.size, 0);
});
