import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { ApprovalService } from '@deepseek-ai/dsh-user-approval';
import { ApprovalBroker } from '../lib/fcm-service.js';

// Exercise the real published DSH 0.2.2-rc.1 request/decide implementation,
// with only its durable projection/log IO replaced by an in-memory fixture.
function service(ctx, policy = 'ask', turnOpen = true) {
  const impl = Object.create(ApprovalService.prototype);
  Object.defineProperty(impl, 'ctx', { value: ctx });
  impl.config = { policy };
  impl.approvalProjectionHandle = { stateOf: () => ({ turnOpen, policy: null }) };
  return impl;
}
test('real DSH approval audit pair records exactly the native one-shot outcome', async () => {
  const ctx = new Context(), broker = new ApprovalBroker(); let entry;
  ctx.on('approval/request', (req, next) => broker.capture(req, next, value => { entry = value; }), { global: true, prepend: true });
  ctx.on('approval/request', async () => 'unavailable', { global: true });
  const audit = [], agent = { session: { id: 'real-dsh-session', append(type, data) { audit.push({ type, data }); } } };
  const operation = service(ctx).request({ agent, toolName: 'bash', callId: 'call-1', reason: 'Fixture only' });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(entry); broker.decide({ requestId: entry.id, sessionId: agent.session.id, outcome: 'allowed-once' });
  assert.equal(await operation, 'allowed-once');
  assert.deepEqual(audit.map(x => x.type), ['approval/asked', 'approval/decided']);
  assert.equal(audit[0].data.id, audit[1].data.id);
  assert.equal(audit[1].data.outcome, 'allowed-once');
  broker.dispose();
});
test('real DSH never policy cannot be overridden by native approval', async () => {
  const ctx = new Context(); let asked = false;
  ctx.on('approval/request', () => { asked = true; return 'allowed-once'; }, { global: true });
  const audit = [], agent = { session: { id: 'never', append(type, data) { audit.push({ type, data }); } } };
  assert.equal(await service(ctx, 'never').request({ agent, toolName: 'bash' }), 'rejected');
  assert.equal(asked, false); assert.equal(audit[1].data.outcome, 'rejected');
});
test('real DSH disallows approvals outside an active turn', async () => {
  const ctx = new Context(), agent = { session: { id: 'idle', append() { throw new Error('must not append'); } } };
  await assert.rejects(service(ctx, 'ask', false).request({ agent, toolName: 'bash' }), /outside an open turn/);
});
