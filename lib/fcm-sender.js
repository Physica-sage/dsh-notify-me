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

/** Classify provider failures without ever returning provider text, URLs, keys or tokens. */
export function fcmFailure(error) {
  const code = error?.code || error?.errorInfo?.code;
  const text = String(error?.message || '');
  const failure = (code, message, retryable = false) => ({ code, message, retryable });
  if (/SERVICE_DISABLED|accessNotConfigured|API[^\n]*(?:has not been used|is disabled)/i.test(text)) return failure('fcm/api-disabled', '请在目标 Firebase 项目启用 Firebase Cloud Messaging API（fcm.googleapis.com），等待生效后重新验证。');
  if (/cloudmessaging\.messages\.create/i.test(text) && /denied|permission/i.test(text)) return failure('fcm/permission-denied', '当前服务账号缺少 cloudmessaging.messages.create 发送权限。请在目标项目授予 Firebase Cloud Messaging API Admin（roles/firebasecloudmessaging.admin），或上传已授权的专用发送凭据。');
  if (invalidRegistration(error)) return failure('fcm/device-token-invalid', '设备令牌无效或已过期，请在 APK 中重新配对设备。');
  if (code === 'messaging/mismatched-credential' || /SENDER_ID_MISMATCH/i.test(text)) return failure('fcm/project-mismatch', 'FCM 拒绝了项目或发送者身份。请核对服务账号对目标项目的授权，以及 APK、设备令牌和 Firebase 项目是否一致；必要时重新配对。');
  if (['app/invalid-credential', 'messaging/authentication-error', 'messaging/third-party-auth-error'].includes(code) || /invalid_grant|Invalid JWT Signature|UNAUTHENTICATED/i.test(text)) return failure('fcm/invalid-credential', 'Firebase 凭据认证失败。请检查服务账号密钥是否有效、是否已撤销，以及服务器时间；上传有效的发送凭据后重试。');
  const network = [code, error?.cause?.code, text].join(' ');
  if (code === 'app/network-error' || /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|CERT_|certificate|fetch failed|network timeout/i.test(network)) return failure('fcm/network-error', '服务器无法连接 Google OAuth/FCM。请检查服务器出站 HTTPS、DNS、代理及证书；这与网页经 CDN 使用 HTTPS 是不同链路。', true);
  if (transientDelivery(error)) return failure('fcm/temporarily-unavailable', 'FCM 暂时不可用或配额受限，请稍后重试。', true);
  return failure('fcm/unknown', 'Firebase 操作失败，原因暂未识别；为保护凭据，未回显原始服务商错误。');
}
