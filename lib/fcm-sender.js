import { privateJson } from './fcm-store.js';
import { randomUUID } from 'node:crypto';
/** Lazy Firebase HTTP-v1 sender. No Firebase credential ever reaches a client. */
export class FcmSender {
  constructor(config, dependencies = {}) { this.config = config; this.messaging = dependencies.messaging; this.initializing = null; }
  async init() {
    if (this.messaging) return;
    this.initializing ??= (async () => {
      const { initializeApp, cert, applicationDefault } = await import('firebase-admin/app');
      const { getMessaging } = await import('firebase-admin/messaging');
      let credential = applicationDefault();
      if (this.config.serviceAccount || this.config.serviceAccountFile) {
        const sa = this.config.serviceAccount || await privateJson(this.config.serviceAccountFile);
        if (sa.project_id !== this.config.projectId) throw new Error('Firebase project mismatch');
        credential = cert(sa);
      }
      const name = `dsh-notify-${this.config.projectId}-${randomUUID()}`;
      this.app = initializeApp({ projectId: this.config.projectId, credential }, name);
      this.messaging = getMessaging(this.app);
    })().catch(error => { this.initializing = null; throw error; });
    await this.initializing;
  }
  async validate() {
    await this.init();
    await this.messaging.send({ topic: 'dsh-notify-configuration-check', data: { test: 'validate-only' } }, true);
  }
  async dispose() {
    if (this.app) { const { deleteApp } = await import('firebase-admin/app'); await deleteApp(this.app); this.app = null; }
  }
  async send(device, data) {
    await this.init();
    // FCM's entire payload is limited to 4096 bytes, not 4096 characters.
    if (Object.values(data).some(v => typeof v !== 'string') || Buffer.byteLength(JSON.stringify(data)) > 3500) throw new Error('Invalid or oversized FCM data');
    const result = await this.messaging.send({ token: device.token, data,
      android: { priority: 'high', ttl: data.event === 'approval' ? 600000 : 3600000 } });
    return { accepted: true, messageId: result };
  }
}
export const invalidRegistration = error => ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(error?.code);
export const transientDelivery = error => ['messaging/server-unavailable', 'messaging/internal-error', 'messaging/quota-exceeded', 'app/network-error'].includes(error?.code);
