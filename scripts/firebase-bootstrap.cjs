/* Run only in the development workspace after explicit Firebase login.
 * Creates one dedicated FCM-only service account; credentials never print.
 */
const { mkdir, writeFile, stat } = require('node:fs/promises');
const path = require('node:path');
const auth = require('/usr/local/lib/node_modules/firebase-tools/lib/auth.js');
const project = process.env.FIREBASE_PROJECT_ID || process.argv[2];
if (!/^[a-z][a-z0-9-]{4,61}$/.test(project || '')) { console.error('Usage: node scripts/firebase-bootstrap.cjs <YOUR_FIREBASE_PROJECT_ID>'); process.exit(2); }
const output = path.resolve(__dirname, '../.secrets/fcm-service-account.json');
async function main() {
  const account = auth.getGlobalDefaultAccount();
  if (!account) throw new Error('Run firebase login first');
  const token = await auth.getAccessToken(account.tokens.refresh_token, account.tokens.scope.split(' '));
  const access = token.access_token;
  async function api(url, method = 'GET', body) {
    const response = await fetch(url, { method, headers: { Authorization: 'Bearer ' + access, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) throw new Error(`${method} ${new URL(url).host}: ${response.status} ${data.error?.message || 'request failed'}`);
    return data;
  }
  for (const service of ['fcm.googleapis.com', 'iam.googleapis.com', 'firebaseinstallations.googleapis.com']) {
    await api(`https://serviceusage.googleapis.com/v1/projects/${project}/services/${service}:enable`, 'POST', {});
    console.log('Enabled', service);
  }
  const email = `dsh-notify-sender@${project}.iam.gserviceaccount.com`;
  const base = `https://iam.googleapis.com/v1/projects/${project}/serviceAccounts`;
  try { await api(`${base}/${email}`); }
  catch { await api(base, 'POST', { accountId: 'dsh-notify-sender', serviceAccount: { displayName: 'DSH Notify FCM sender' } }); }
  const resource = `https://cloudresourcemanager.googleapis.com/v1/projects/${project}`;
  const policy = await api(`${resource}:getIamPolicy`, 'POST', {});
  policy.bindings ||= [];
  let binding = policy.bindings.find(b => b.role === 'roles/firebasecloudmessaging.admin' && !b.condition);
  if (!binding) { binding = { role: 'roles/firebasecloudmessaging.admin', members: [] }; policy.bindings.push(binding); }
  if (!binding.members.includes('serviceAccount:' + email)) binding.members.push('serviceAccount:' + email);
  await api(`${resource}:setIamPolicy`, 'POST', { policy });
  console.log('Granted dedicated project FCM role to sender');
  try { await stat(output); console.log('Private service account key already exists; not generating another'); return; }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const key = await api(`${base}/${email}/keys`, 'POST', { privateKeyType: 'TYPE_GOOGLE_CREDENTIALS_FILE', keyAlgorithm: 'KEY_ALG_RSA_2048' });
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, Buffer.from(key.privateKeyData, 'base64'), { mode: 0o600, flag: 'wx' });
  console.log('Private sender credential stored outside Git at', output);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
