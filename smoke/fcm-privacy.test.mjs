import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
test('APK first-run URL is empty and identity is a generic application package', async () => {
  const activity = await source('android/app/src/main/java/io/github/dshnotify/client/MainActivity.java');
  assert.match(activity, /prefs\.paired\(\) \? prefs\.base\(\) : ""/);
  assert.doesNotMatch(activity, /https?:\/\/[^\s"']+/);
  const gradle = await source('android/app/build.gradle');
  assert.match(gradle, /applicationId 'io\.github\.dshnotify\.client'/);
});
test('Firebase setup takes an explicit project instead of a developer deployment constant', async () => {
  const setup = await source('scripts/firebase-bootstrap.cjs');
  assert.match(setup, /const project = process\.env\.FIREBASE_PROJECT_ID \|\| process\.argv\[2\]/);
  assert.doesNotMatch(setup, /const project = '[^']+'/);
});
test('FCM browser panel contains no persistence writes or compiled deployment authority', async () => {
  const client = await source('lib/client.js');
  const panel = client.slice(client.indexOf('// FCM-SETTINGS-START'), client.indexOf('// FCM-SETTINGS-END'));
  assert.doesNotMatch(panel, /localStorage\.|sessionStorage\./);
  const hosts = [...panel.matchAll(/https:\/\/([^/"'\s]+)/g)].map(match => match[1]);
  assert.deepEqual(hosts, ['dsh.example']);
  assert.match(panel, /new URL\("\.", document\.baseURI \|\| location\.href\)/);
});
test('deployment examples use reserved example domains only', async () => {
  for (const path of ['docs/FCM.md', 'docs/fcm-config.example.yml']) {
    const text = await source(path);
    const authorities = [...text.matchAll(/https:\/\/([^/`\s]+)/g)].map(match => match[1]);
    for (const authority of authorities) assert.ok(authority.endsWith('.example'), 'Non-example deployment authority in ' + path);
  }
});
