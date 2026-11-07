import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DeviceStore, stateDirectory, loadAdminSecret, equalSecret } from './fcm-store.js';
import { FcmSender, invalidRegistration, transientDelivery } from './fcm-sender.js';
import { readBody, respond, sessionName } from './page-bridge.js';

export const PREFIX = '/__dsh-notify-me/fcm';
const fail = (status, message) => Object.assign(new Error(message), { status });
const sidOf = s => String(s?.id || s?.header?.id || '');
const plain = (text, bytes = 700) => {
  let out = '';
  for (const c of String(text || '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')) {
    if (Buffer.byteLength(out + c) > bytes) return out + '…';
    out += c;
  }
  return out;
};
export function normalizeFcm(config = {}) {
  const u = new URL(config.publicUrl);
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw new Error('FCM publicUrl requires a credential-free HTTPS URL');
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  if (!/^[a-z][a-z0-9-]{4,61}$/.test(config.projectId || '')) throw new Error('FCM projectId required');
  return { ...config, publicUrl: u.href, storeFile: config.storeFile || join(stateDirectory(), 'fcm-devices.json'),
    adminTokenFile: config.adminTokenFile || join(stateDirectory(), 'fcm-admin-token'),
    approvalTtlMs: Math.max(1000, Math.min(config.approvalTtlMs || 600000, 600000)),
    includePreview: config.includePreview !== false, events: config.events || ['completed', 'error', 'approval', 'question', 'plan-review', 'goal'] };
}
export function sessionLink(base, sid) {
  const u = new URL(base);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(sid)) throw new Error('Invalid session id');
  u.hash = 'dsh-notify-session=' + encodeURIComponent(sid);
  return u.href;
}
/** Both phone and ordinary DSH answerers resolve this same live decision once. */
export class ApprovalBroker {
  constructor(ttl = 600000) { this.ttl = ttl; this.pending = new Map(); this.closed = new Map(); }
  capture(req, next, notify) {
    if (req.signal?.aborted) return Promise.resolve('cancelled');
    if (this.pending.size >= 100) return next();
    const id = randomUUID(), sessionId = sidOf(req.agent?.session);
    return new Promise(resolve => {
      const entry = { id, sessionId, request: req, expiresAt: Date.now() + this.ttl };
      const finish = outcome => {
        if (!this.pending.has(id)) return;
        clearTimeout(entry.timer); req.signal?.removeEventListener('abort', entry.abort);
        this.pending.delete(id); this.closed.set(id, { sessionId, outcome, at: Date.now() });
        while (this.closed.size > 200) this.closed.delete(this.closed.keys().next().value);
        resolve(outcome);
      };
      entry.finish = finish;
      entry.abort = () => finish('cancelled');
      entry.timer = setTimeout(() => finish('unavailable'), this.ttl); entry.timer.unref?.();
      this.pending.set(id, entry);
      req.signal?.addEventListener('abort', entry.abort, { once: true });
      // Invoke downstream immediately: the browser keeps its ordinary approval UI.
      Promise.resolve().then(next).then(value => {
        if (['allowed-once', 'rejected', 'cancelled'].includes(value)) finish(value);
        // "unavailable" means no browser, not permission to abort the phone wait.
      }, () => {});
      try { notify(entry); } catch { finish('unavailable'); }
    });
  }
  decide({ requestId, sessionId, outcome }) {
    if (!['allowed-once', 'rejected'].includes(outcome)) throw fail(400, 'Only allow-once or reject is supported');
    const entry = this.pending.get(requestId);
    if (!entry || entry.sessionId !== sessionId || entry.expiresAt <= Date.now()) throw fail(409, 'Approval expired or already settled');
    if (entry.request.signal?.aborted) { entry.finish('cancelled'); throw fail(409, 'Approval cancelled'); }
    entry.finish(outcome);
    return { outcome };
  }
  dispose() { for (const e of [...this.pending.values()]) e.finish('cancelled'); }
}

export async function mountFcm(ctx, raw, dependencies = {}) {
  const config = normalizeFcm(raw), store = await new DeviceStore(config.storeFile).init();
  const adminKey = await loadAdminSecret(config.adminTokenFile);
  const broker = new ApprovalBroker(config.approvalTtlMs), sender = dependencies.sender || new FcmSender(config);
  try { await sender.init?.(); } catch (error) { await sender.dispose?.(); throw error; }
  const titles = new Map(), replies = new Map(), operations = new Map(), seen = new Set(), offs = [], jobs = new Set();
  let disposed = false, sending = 0;
  const queue = [], retries = new Set(), buckets = new Map();
  const remember = (map, k, v) => { map.set(k, v); if (map.size > 500) map.delete(map.keys().next().value); };
  const title = s => {
    let value = titles.get(sidOf(s));
    try { value = ctx.get?.('sessionTitle')?.get(s)?.title || value; } catch {}
    return sessionName({ title: value, cwd: s?.header?.cwd, id: sidOf(s) });
  };
  const pump = () => {
    while (!disposed && sending < 4 && queue.length) {
      sending++;
      const p = queue.shift()().catch(() => {}).finally(() => { sending--; jobs.delete(p); pump(); });
      jobs.add(p);
    }
  };
  function deliver(device, data, attempt = 0) {
    if (disposed || queue.length >= 200) return;
    queue.push(async () => {
      const current = store.devices().find(d => d.id === device.id);
      if (!current) return;
      try { await sender.send(current, data); }
      catch (error) {
        if (invalidRegistration(error)) await store.removeToken(current.token);
        else if (transientDelivery(error) && attempt < 2 && !disposed) {
          const timer = setTimeout(() => { retries.delete(timer); deliver(current, data, attempt + 1); }, [2000, 6000][attempt]);
          timer.unref?.(); retries.add(timer);
        } else ctx.logger?.warn?.('dsh-notify-me: FCM delivery failed (%s)', error.code || 'sender-error');
      }
    });
    pump();
  }
  function sendNote(s, event, key, body, extra = {}) {
    if (disposed || !config.events.includes(event) || !sidOf(s) || (s?.header?.origin === 'subagent' && !config.includeSubagents)) return;
    const eventKey = `${sidOf(s)}:${event}:${key}`;
    if (seen.has(eventKey)) return;
    seen.add(eventKey); if (seen.size > 1000) seen.delete(seen.values().next().value);
    const labels = { completed: '回复完成', error: '执行失败', approval: '等待审批', question: '等待回答', 'plan-review': '方案待确认', goal: '目标状态' };
    const data = { schema: '1', notificationId: eventKey, event, sessionId: sidOf(s), sessionTitle: plain(title(s), 180),
      title: 'DSH · ' + (labels[event] || event), body: plain(body), url: sessionLink(config.publicUrl, sidOf(s)),
      requestId: '', expiresAt: String(Date.now() + 3600000), ...extra };
    for (const device of store.devices()) deliver({ id: device.id }, data);
  }
  function handleEvent(s, event) {
    const sid = sidOf(s), d = event?.data || {};
    if (!sid) return;
    if (event.type === 'session/title') remember(titles, sid, d.title);
    if (event.type === 'turn/start') replies.delete(sid);
    if (event.type === 'assistant/message') remember(replies, sid, (d.message?.content || []).filter(b => b.type === 'text').map(b => b.text).join(''));
    if (event.type === 'turn/end') {
      const kind = d.reason?.kind;
      if (kind === 'completed') sendNote(s, 'completed', d.turn, config.includePreview ? replies.get(sid) || '回复已完成，点击查看会话。' : '回复已完成，点击查看会话。');
      else if (['error', 'max-tokens'].includes(kind)) sendNote(s, 'error', d.turn, config.includePreview ? d.reason?.error?.message || '执行异常，请查看会话。' : '执行异常，请查看会话。');
    }
    if (event.type === 'tool/call') {
      let args; try { args = typeof d.arguments === 'string' ? JSON.parse(d.arguments) : d.arguments; } catch {}
      const summary = args?.command || args?.file_path || args?.path;
      if (typeof summary === 'string') remember(operations, `${sid}:${d.callId}`, plain(summary, 500));
    }
    if (event.type === 'tool/call' && ['ask_user_question', 'exit_plan_mode'].includes(d.name)) {
      let args = {}; try { args = typeof d.arguments === 'string' ? JSON.parse(d.arguments) : d.arguments || {}; } catch {}
      const q = args.questions?.[0];
      const body = d.name === 'exit_plan_mode' ? '方案正在等待确认，请打开会话。' : config.includePreview ? [q?.question || '有问题等待你回答。', ...(q?.options || []).map(o => o.label)].join('\n') : '有问题等待你回答。';
      sendNote(s, d.name === 'exit_plan_mode' ? 'plan-review' : 'question', d.callId, body);
    }
    if (event.type === 'goal/change' && ['complete', 'blocked'].includes(d.goal?.phase)) sendNote(s, 'goal', `${d.goal?.id}:${d.goal?.revision}:${d.operation}`, '目标状态：' + d.goal.phase);
  }
  offs.push(ctx.on('session/event', (s, e) => { try { handleEvent(s, e); } catch { ctx.logger?.warn?.('dsh-notify-me: FCM event ignored'); } }, { global: true }));
  // prepend is essential: race the existing UI without ever granting broadly.
  offs.push(ctx.on('approval/request', (req, next) => {
    if (!config.events.includes('approval') || !store.devices().length || (req.agent?.session?.header?.origin === 'subagent' && !config.includeSubagents)) return next();
    return broker.capture(req, next, entry => sendNote(req.agent.session, 'approval', entry.id,
      config.includePreview ? [req.toolName || '工具', req.reason || '请求一次性操作授权。', operations.get(`${sidOf(req.agent.session)}:${req.callId}`)].filter(Boolean).join('\n') : '请求一次性操作授权，请查看操作后决定。',
      { requestId: entry.id, expiresAt: String(entry.expiresAt) }));
  }, { global: true, prepend: true }));
  function takeRate(req, action) {
    const key = String(req.socket?.remoteAddress || 'unknown') + ':' + action;
    const old = buckets.get(key), t = Date.now();
    const b = old && old.until > t ? old : { count: 0, until: t + 60000 };
    buckets.set(key, b);
    if (buckets.size > 1000) buckets.delete(buckets.keys().next().value);
    if (++b.count > (action === 'pair' ? 10 : 120)) throw fail(429, 'Rate limit');
  }
  function handler(action) { return async (req, res) => {
    try {
      if (disposed) throw fail(503, 'Unavailable');
      if (req.method !== 'POST') throw fail(405, 'POST required');
      if (req.headers.origin) throw fail(403, 'Native/CLI endpoint; browser origin refused');
      takeRate(req, action);
      if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw fail(415, 'JSON required');
      const rawBody = await readBody(req, 16384);
      if (!rawBody.ok) throw fail(rawBody.reason === 'body-too-large' ? 413 : 400, 'Invalid body');
      let data; try { data = JSON.parse(rawBody.text); } catch { throw fail(400, 'Invalid JSON'); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw fail(400, 'JSON object required');
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
      let answer;
      if (action === 'pair') {
        answer = { ...await store.pair(data), publicUrl: config.publicUrl };
      } else if (action === 'admin') {
        if (!equalSecret(bearer, adminKey)) throw fail(401, 'Unauthorized');
        if (data.action === 'pairing-code') answer = await store.createPairing();
        else if (data.action === 'devices') answer = { devices: store.list() };
        else if (data.action === 'revoke') { await store.revoke(data.deviceId); answer = {}; }
        else if (data.action === 'test') { sendNote({ id: 'test', header: {} }, 'question', randomUUID(), 'FCM 通知通道测试。'); answer = { queued: true }; }
        else throw fail(400, 'Unknown admin action');
      } else {
        const device = store.authenticate(bearer);
        if (!device) throw fail(401, 'Unauthorized');
        if (action === 'device') {
          if (data.action === 'unpair') { await store.revoke(device.id); answer = {}; }
          else answer = { changed: await store.updateToken(device.id, data.token, data.revision) };
        } else {
          const entry = broker.pending.get(data.requestId);
          // Only still-live runtime agents can be granted access.
          if (entry && ctx.agents && ctx.agents.get(entry.sessionId) !== entry.request.agent) throw fail(409, 'Agent unavailable');
          answer = broker.decide(data);
        }
      }
      respond(res, 200, { ok: true, ...answer });
    } catch (error) { respond(res, error.status || 500, { ok: false, error: error.status ? error.message : 'Internal error' }); }
  }; }
  for (const action of ['pair', 'device', 'decision', 'admin']) offs.push(ctx.webServer.register({ kind: 'exact', path: `${PREFIX}/${action}`, handler: handler(action) }));
  ctx.logger?.info?.('dsh-notify-me: native FCM endpoints enabled (project %s)', config.projectId);
  return { config, store, broker, sender, handleEvent, handler, jobs,
    async dispose() { disposed = true; broker.dispose(); for (const t of retries) clearTimeout(t); for (const off of offs) off?.(); await Promise.allSettled([...jobs]); await sender.dispose?.(); await store.chain; } };
}
