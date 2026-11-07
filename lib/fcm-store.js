import { readFile, mkdir, rename, writeFile, unlink, chmod, stat } from 'node:fs/promises';
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const digest = value => createHash('sha256').update(String(value)).digest('hex');
export const newSecret = () => randomBytes(32).toString('base64url');
export const equalSecret = (a, b) => typeof a === 'string' && typeof b === 'string' && timingSafeEqual(Buffer.from(digest(a), 'hex'), Buffer.from(digest(b), 'hex'));
export const stateDirectory = () => join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-notify-me');
const fail = (status, message) => Object.assign(new Error(message), { status });
export function validToken(token) { return typeof token === 'string' && token.length >= 20 && token.length <= 4096 && !/[\s\x00-\x1f]/.test(token); }
export async function privateJson(file) {
  const info = await stat(file);
  if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077))) throw new Error('Credential file must be private (chmod 600)');
  return JSON.parse(await readFile(file, 'utf8'));
}
export async function loadAdminSecret(file) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  try { await writeFile(file, newSecret() + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = await stat(file);
  if (process.platform !== 'win32' && (info.mode & 0o077)) throw new Error('Admin token file must be private (chmod 600)');
  const key = (await readFile(file, 'utf8')).trim();
  if (key.length < 32) throw new Error('Invalid admin token file');
  return key;
}
/** One host process owns this store; all mutations and pairing consumption serialize. */
export class DeviceStore {
  constructor(file, clock = Date.now) { this.file = file; this.clock = clock; this.chain = Promise.resolve(); this.data = null; }
  async init() {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    try { this.data = await privateJson(this.file); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Device registry cannot be read; refusing to overwrite it', { cause: error });
      this.data = { version: 1, devices: [], pairings: [] };
      await this.save();
    }
    if (this.data?.version !== 1 || !Array.isArray(this.data.devices) || !Array.isArray(this.data.pairings)) throw new Error('Invalid device registry');
    return this;
  }
  async save() {
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try { await writeFile(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 }); await rename(temp, this.file); }
    finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  mutate(fn) {
    const run = this.chain.then(async () => {
      const previous = structuredClone(this.data);
      try { const value = await fn(); await this.save(); return value; }
      catch (error) { this.data = previous; throw error; }
    });
    this.chain = run.catch(() => {});
    return run;
  }
  createPairing() { return this.mutate(() => {
    this.data.pairings = this.data.pairings.filter(p => p.expiresAt > this.clock());
    if (this.data.pairings.length >= 5) throw fail(429, 'Too many active pairing codes');
    const code = newSecret(), expiresAt = this.clock() + 300000;
    this.data.pairings.push({ hash: digest(code), expiresAt });
    return { pairingCode: code, expiresAt };
  }); }
  pair({ pairingCode, token, name }) { return this.mutate(() => {
    if (!validToken(token)) throw fail(400, 'Invalid FCM token');
    const index = this.data.pairings.findIndex(p => p.expiresAt > this.clock() && equalSecret(p.hash, digest(pairingCode || '')));
    if (index < 0) throw fail(403, 'Invalid or expired pairing code');
    if (this.data.devices.filter(d => d.enabled).length >= 20) throw fail(409, 'Device limit reached');
    this.data.pairings.splice(index, 1);
    // One active registration per FCM token, even if an app was paired twice.
    for (const d of this.data.devices) if (d.token === token) { d.enabled = false; d.token = ''; }
    const deviceId = randomUUID(), deviceSecret = newSecret();
    this.data.devices.push({ id: deviceId, secretHash: digest(deviceSecret), token, name: String(name || 'Android').replace(/[\x00-\x1f]/g, '').slice(0, 80), enabled: true, revision: 0, createdAt: this.clock() });
    return { deviceId, deviceSecret };
  }); }
  authenticate(bearer) {
    if (typeof bearer !== 'string' || bearer.length > 200) return null;
    const dot = bearer.indexOf('.');
    if (dot < 0) return null;
    const device = this.data.devices.find(d => d.id === bearer.slice(0, dot) && d.enabled);
    return device && equalSecret(device.secretHash, digest(bearer.slice(dot + 1))) ? device : null;
  }
  updateToken(id, token, revision) { return this.mutate(() => {
    if (!validToken(token) || !Number.isSafeInteger(revision) || revision < 1) throw fail(400, 'Invalid token update');
    const device = this.data.devices.find(d => d.id === id && d.enabled);
    if (!device) throw fail(401, 'Device revoked');
    if (revision <= device.revision) return false;
    device.token = token; device.revision = revision;
    return true;
  }); }
  revoke(id) { return this.mutate(() => { const d = this.data.devices.find(d => d.id === id); if (d) { d.enabled = false; d.token = ''; } }); }
  removeToken(token) { return this.mutate(() => { for (const d of this.data.devices) if (d.token === token) d.token = ''; }); }
  devices() { return this.data.devices.filter(d => d.enabled && validToken(d.token)); }
  list() { return this.data.devices.map(({ id, name, enabled, createdAt }) => ({ id, name, enabled, createdAt })); }
}
