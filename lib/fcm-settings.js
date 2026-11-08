import { randomUUID, createPrivateKey } from 'node:crypto';
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { privateJson, stateDirectory } from './fcm-store.js';
import { mountFcm, normalizeFcm } from './fcm-service.js';
import { invalidRegistration, fcmFailure } from './fcm-sender.js';

export const FCM_CONTROL = 'notify-me-fcm/control';
export const FCM_EVENTS = ['completed', 'error', 'approval', 'question', 'plan-review', 'goal'];
const fail = (status, message) => Object.assign(new Error(message), { status });
const defaults = () => ({ enabled: false, publicUrl: '', projectId: '', includePreview: true, includeSubagents: false, approvalTtlMs: 600000, events: [...FCM_EVENTS] });

/** Retain only the SDK's fixed Google credential fields, never caller-supplied URLs. */
export function parseFcmCredential(text, projectId) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 16384) throw fail(400, '服务账号 JSON 过大或无效');
  let value; try { value = JSON.parse(text); } catch { throw fail(400, '服务账号 JSON 格式无效'); }
  if (value?.type !== 'service_account' || typeof value.private_key !== 'string' || value.project_id !== projectId || !/^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/.test(value.client_email || '')) throw fail(400, '服务账号类型、项目或邮箱不匹配');
  try {
    const key = createPrivateKey(value.private_key);
    if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength < 2048) throw new Error();
  } catch { throw fail(400, '服务账号 RSA 私钥无效'); }
  return { type: 'service_account', project_id: projectId, client_email: value.client_email, private_key: value.private_key };
}

/** Private, revisioned server settings; no browser localStorage and no secret readback. */
export class FcmSettings {
  constructor(ctx, initial = {}, dependencies = {}) {
    this.ctx = ctx; this.initial = initial; this.file = initial.settingsFile || join(stateDirectory(), 'fcm-settings.json');
    this.mount = dependencies.mount || mountFcm; this.service = null; this.chain = Promise.resolve(); this.closed = false;
    this.state = { version: 1, revision: 0, config: defaults(), credential: null };
  }
  async init() {
    try {
      const saved = await privateJson(this.file);
      if (saved.version !== 1 || !Number.isSafeInteger(saved.revision) || saved.revision < 0 || !saved.config || typeof saved.config !== 'object') throw new Error('Invalid settings');
      this.state = this.validate(saved.config, saved.credential, saved.revision);
    } catch (error) {
      if (error.code !== 'ENOENT') throw fail(500, '服务端 FCM 配置不可读；为保护已有凭据，未覆盖文件');
      const config = { ...defaults() };
      for (const key of Object.keys(config)) if (this.initial[key] !== undefined) config[key] = this.initial[key];
      let credential = null;
      if (this.initial.serviceAccountFile) credential = await privateJson(this.initial.serviceAccountFile);
      this.state = this.validate(config, credential, 0);
    }
    try { await this.activate(this.state); }
    catch { this.startupError = 'FCM 未启动，请检查凭据或插件依赖后重新保存'; }
    return this;
  }
  validate(input, credential, revision) {
    const config = {};
    for (const key of Object.keys(defaults())) config[key] = input[key] ?? defaults()[key];
    for (const key of ['enabled', 'includePreview', 'includeSubagents']) if (typeof config[key] !== 'boolean') throw fail(400, '开关必须是布尔值');
    if (typeof config.publicUrl !== 'string' || typeof config.projectId !== 'string') throw fail(400, '地址和项目 ID 必须是文本');
    config.publicUrl = config.publicUrl.trim(); config.projectId = config.projectId.trim();
    if (config.publicUrl.length > 1000 || config.projectId.length > 63 || !Array.isArray(config.events) || config.events.some(x => !FCM_EVENTS.includes(x))) throw fail(400, 'FCM 字段或事件列表无效');
    config.events = [...new Set(config.events)];
    if (!Number.isSafeInteger(config.approvalTtlMs) || config.approvalTtlMs < 1000 || config.approvalTtlMs > 600000) throw fail(400, '审批有效期必须在 1 秒至 10 分钟内');
    if (config.publicUrl || config.projectId || config.enabled) {
      // Drafts may keep either field empty; enabled settings must be complete.
      if (config.publicUrl && config.projectId) config.publicUrl = normalizeFcm(config).publicUrl;
      else if (config.enabled) throw fail(400, '启用前请填写 HTTPS 地址和 Firebase 项目 ID');
      else {
        if (config.publicUrl) normalizeFcm({ ...config, projectId: 'draft-project' });
        if (config.projectId && !/^[a-z][a-z0-9-]{4,61}$/.test(config.projectId)) throw fail(400, 'Firebase 项目 ID 无效');
      }
    }
    if (credential) credential = parseFcmCredential(JSON.stringify(credential), config.projectId);
    if (config.enabled && !credential) throw fail(400, '启用前请上传 Firebase 服务账号 JSON');
    return { version: 1, revision, config, credential };
  }
  view() {
    return { ...this.state.config, events: [...this.state.config.events], revision: this.state.revision,
      hasCredentials: !!this.state.credential, active: !!this.service, error: this.startupError || '', storage: 'server' };
  }
  async activate(state) {
    this.service = state.config.enabled ? await this.mount(this.ctx, { ...this.initial, ...state.config, serviceAccount: state.credential }) : null;
  }
  async persist(state) {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = this.file + '.' + randomUUID() + '.tmp';
    try { await writeFile(temp, JSON.stringify(state), { mode: 0o600, flag: 'wx' }); await rename(temp, this.file); }
    catch (e) { await unlink(temp).catch(() => {}); throw e; }
  }
  save(input) {
    const task = this.chain.then(async () => {
      if (this.closed) throw fail(503, '插件已停用');
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, '配置对象无效');
      if (input.expectedRevision !== this.state.revision) throw fail(409, '配置已被其他页面修改，请重新载入后再保存');
      const config = { ...this.state.config };
      for (const key of Object.keys(defaults())) if (Object.hasOwn(input, key)) config[key] = input[key];
      let credential = this.state.credential;
      if (input.removeCredentials === true) credential = null;
      if (input.serviceAccountJson) credential = parseFcmCredential(input.serviceAccountJson, config.projectId?.trim());
      const next = this.validate(config, credential, this.state.revision + 1), previous = this.state;
      const old = this.service; this.service = null; await old?.dispose();
      try {
        await this.activate(next);
        await this.persist(next);
        this.state = next; this.startupError = ''; return this.view();
      } catch (error) {
        await this.service?.dispose().catch(() => {}); this.service = null;
        try { await this.activate(previous); } catch { this.startupError = 'FCM 恢复失败，请重新保存配置'; }
        throw error.status ? error : fail(500, '保存或启动失败；未提交新配置，请检查服务器权限与凭据');
      }
    });
    this.chain = task.catch(() => {}); return task;
  }
  requireService() { if (!this.service) throw fail(409, '请先保存并启用 FCM'); return this.service; }
  async control(payload, signal) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Buffer.byteLength(JSON.stringify(payload)) > 32768) throw fail(400, '请求对象无效或过大');
    if (this.closed || signal?.aborted) throw fail(503, '请求已结束');
    if (payload.action === 'get') return this.view();
    if (payload.action === 'save') return this.save(payload.settings);
    const service = this.requireService();
    if (payload.action === 'pairing-code') return service.store.createPairing();
    if (payload.action === 'devices') return { devices: service.store.list() };
    if (payload.action === 'revoke') {
      if (typeof payload.deviceId !== 'string' || payload.deviceId.length > 100) throw fail(400, '设备 ID 无效');
      await service.store.revoke(payload.deviceId); return { devices: service.store.list() };
    }
    if (payload.action === 'validate') {
      try { await service.sender.validate(); }
      catch (error) { const diagnostic = fcmFailure(error); throw Object.assign(fail(502, diagnostic.message), { fcmDiagnostic: diagnostic }); }
      return { validated: true, delivered: false };
    }
    if (payload.action === 'test') {
      const devices = service.store.devices(); if (!devices.length) throw fail(409, '请先生成配对码并在 APK 中配对设备');
      const data = { schema: '1', event: 'question', notificationId: 'fcm-test-' + randomUUID(), sessionId: '', sessionTitle: '通知测试', title: 'DSH · FCM 测试', body: '这是通知通道测试；实际送达请以手机展示为准。', url: this.state.config.publicUrl, requestId: '', expiresAt: String(Date.now() + 300000) };
      const results = await Promise.allSettled(devices.map(async device => {
        try { await service.sender.send(device, data); }
        catch (error) { if (invalidRegistration(error)) await service.store.removeToken(device.token); throw error; }
      }));
      const failures = [];
      for (const result of results) {
        if (result.status !== 'rejected') continue;
        const diagnostic = fcmFailure(result.reason), group = failures.find(value => value.code === diagnostic.code);
        if (group) group.count++;
        else failures.push({ ...diagnostic, count: 1 });
      }
      return { accepted: results.filter(r => r.status === 'fulfilled').length, failed: results.filter(r => r.status === 'rejected').length, delivered: false, ...(failures.length ? { failures } : {}) };
    }
    throw fail(400, '不支持的 FCM 操作');
  }
  async dispose() { this.closed = true; await this.chain; const service = this.service; this.service = null; await service?.dispose(); }
}

/** Connection authenticates transport; this handler independently requires an owner Peer. */
export function fcmControlHandler(manager) {
  return async (_endpoint, payload, signal, peer) => {
    if (peer?.principal?.kind !== 'owner') return { ok: false, error: { code: 'forbidden', message: '仅 DSH 所有者可管理 FCM', details: {} } };
    try { return { ok: true, value: await manager.control(payload, signal) }; }
    catch (error) {
      if (error.fcmDiagnostic) return { ok: false, error: { code: error.fcmDiagnostic.code, message: error.fcmDiagnostic.message, details: { retryable: error.fcmDiagnostic.retryable } } };
      return { ok: false, error: { code: error.status === 409 ? 'conflict' : error.status === 400 ? 'invalid' : 'unavailable', message: error.status ? error.message : 'FCM 操作失败，请检查服务端配置', details: {} } };
    }
  };
}

function rpcResponse(message, result) { return Response.json({ type: 'server-response', rpcId: message?.rpcId, result }, { headers: { 'cache-control': 'private, no-store' } }); }
export async function mountFcmSettings(ctx, initial = {}, dependencies = {}) {
  if (typeof ctx.connection?.fetch?.register !== 'function') throw new Error('FCM settings require authenticated DSH Connection');
  const manager = await new FcmSettings(ctx, initial, dependencies);
  await manager.init();
  const handler = fcmControlHandler(manager);
  const off = ctx.connection.fetch.register({
    path: `/api/${FCM_CONTROL}`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      let message;
      try { message = await request.json(); } catch { return new Response('body is not JSON', { status: 400 }); }
      if (!message || message.type !== 'client-request' || message.method !== FCM_CONTROL || typeof message.rpcId !== 'string') return new Response('invalid client request', { status: 400 });
      const result = await handler(FCM_CONTROL, message.payload, request.signal, ctx.connection.browserPeer);
      return rpcResponse(message, result);
    }
  });
  return { manager, async dispose() { await off?.(); await manager.dispose(); } };
}
