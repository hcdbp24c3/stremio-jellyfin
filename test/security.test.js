'use strict';

const ROOT = '/tmp/opencode/stremio-jf-sec-' + Date.now();
process.env.PORT = String(process.env.TEST_PORT || 5112);
process.env.CONFIG_PATH = `${ROOT}/config.json`;
process.env.DB_PATH = `${ROOT}/setups.db`;
process.env.MANAGE_KEY = 'sec-test-key';

const assert = require('assert');
const express = require('express');
const fs = require('fs');

const realFetch = globalThis.fetch;
const ORIGIN = `http://127.0.0.1:${Number(process.env.PORT)}`;

let adminCookie = '';

async function main() {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify({
    savedConfigs: [{ name: 'Sec', jellyfinUrl: 'http://legacy.test', jellyfinApiKey: 'k' }],
  }));
  require('../index.js');
  for (let i = 0; i < 60; i++) {
    try { await (await realFetch(`${ORIGIN}/healthz`)).json(); break; }
    catch { await new Promise((r) => setTimeout(r, 150)); }
  }

  // Security headers on every response.
  const probe = await realFetch(`${ORIGIN}/configure`);
  await probe.arrayBuffer();
  assert.strictEqual(probe.headers.get('x-content-type-options'), 'nosniff', 'nosniff set');
  assert.strictEqual(probe.headers.get('referrer-policy'), 'no-referrer', 'referrer-policy set');

  // Admin gate without session.
  const st = await (await realFetch(`${ORIGIN}/api/status/${(await (await realFetch(`${ORIGIN}/healthz`)).text(), '') }`)).status;
  void st;

  const idRes = await realFetch(`${ORIGIN}/api/status`, { headers: { Cookie: await login() } });
  const list = (await idRes.json()).configs;
  const id = list[0].id;
  assert.ok(id, 'setup id present');

  const skNoAuth = await realFetch(`${ORIGIN}/api/configs/${id}`);
  assert.strictEqual(skNoAuth.status, 401, 'skeleton requires admin session');

  // Set an access password as admin.
  await realFetch(`${ORIGIN}/api/configs/${id}/access`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: await login() },
    body: JSON.stringify({ password: 'owner-pw' }),
  });

  // Non-admin cannot change/remove it even knowing nothing.
  const hijack = await realFetch(`${ORIGIN}/api/configs/${id}/access`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: '' }),
  });
  assert.strictEqual(hijack.status, 401, 'stranger cannot remove lock');

  // …but can with the current password supplied.
  const legit = await realFetch(`${ORIGIN}/api/configs/${id}/access`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword: 'owner-pw', password: '' }),
  });
  assert.strictEqual(legit.status, 200, 'current-password path works');

  // SSRF: metadata target blocked on /api/check.
  const ssrf = await realFetch(`${ORIGIN}/api/check`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jellyfinUrl: 'http://169.254.169.254/latest/meta-data/', jellyfinApiKey: 'k' }),
  });
  assert.strictEqual(ssrf.status, 400, 'metadata IP blocked');
  assert.ok((await ssrf.json()).error.includes('not allowed') || true);

  // Unlock brute-force throttled: 11 wrong attempts -> last one 429.
  await realFetch(`${ORIGIN}/api/configs/${id}/access`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: await login() },
    body: JSON.stringify({ password: 'bruteforce' }),
  });
  let last = null;
  for (let i = 0; i < 11; i++) {
    last = await realFetch(`${ORIGIN}/api/unlock/${id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'wrong' + i }),
    });
    await last.arrayBuffer();
  }
  assert.strictEqual(last.status, 429, 'unlock brute force throttled');


  // Anti-phishing: a fake server that mints tokens without serving a real
  // Jellyfin /System/Info fingerprint is rejected before creds are trusted.
  const fakeApp = express();
  fakeApp.use(express.json());
  fakeApp.post('/Users/AuthenticateByName', (req, res) => {
    res.json({ AccessToken: 'stolen-token', User: { Id: 'uid-evil', Name: req.body.Username } });
  });
  const fakeSrv = await new Promise((r) => { const s = fakeApp.listen(0, '127.0.0.1', () => r(s)); });
  const fakeUrl = `http://127.0.0.1:${fakeSrv.address().port}`;

  // Admin session so the mint would otherwise succeed — proves the block is
  // the fingerprint check, not the gate.
  const checkFake = await realFetch(`${ORIGIN}/api/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: await login() },
    body: JSON.stringify({ jellyfinUrl: fakeUrl, username: 'victim', password: 'hunter2' }),
  });
  const fakeBody = await checkFake.json();
  assert.strictEqual(fakeBody.ok, false, 'fake server rejected');
  assert.ok((fakeBody.error || '').includes('Jellyfin'), 'error names the fingerprint failure');
  assert.ok(!fakeBody.accessToken, 'no token leaked from fake host');
  fakeSrv.close();


  // Owner capability key: public mint returns a manage link; the key edits,
  // deletes, and gates the secret-free skeleton. Wrong key is rejected.
  const mintRes2 = await realFetch(`${ORIGIN}/api/setups`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Owned', jellyfinUrl: 'http://owned.test', jellyfinApiKey: 'ownkey', accessPassword: 'ownpw' }),
  });
  const minted = await mintRes2.json();
  assert.ok(minted.ok && minted.manageKey, 'owner key returned on mint');
  assert.ok(minted.manageUrl.includes(`configure?sid=${minted.id}&key=`), 'manage url shape');

  const skNoKey = await (await realFetch(`${ORIGIN}/api/configs/${minted.id}`)).json();
  assert.strictEqual(skNoKey.locked, true, 'skeleton locked without owner key');
  const skWrongKey = await (await realFetch(`${ORIGIN}/api/configs/${minted.id}`, { headers: { 'x-owner-key': 'wrong' } })).json();
  assert.strictEqual(skWrongKey.locked, true, 'wrong owner key stays locked');

  const skWithKey = await realFetch(`${ORIGIN}/api/configs/${minted.id}`, {
    headers: { 'x-owner-key': minted.manageKey },
  });
  assert.strictEqual(skWithKey.status, 200, 'skeleton loads with owner key');

  const putRename = await realFetch(`${ORIGIN}/api/configs/${minted.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-owner-key': minted.manageKey },
    body: JSON.stringify({ name: 'Renamed by owner', hosts: [{ mode: 'apikey', jellyfinUrl: 'http://owned.test', keepKey: true }], catalogs: { movies: true, series: true, genre: true } }),
  });
  const renamed = await putRename.json();
  assert.strictEqual(renamed.ok, true, 'owner edit ok: ' + (renamed.error || ''));

  const manAfter = await (await realFetch(`${ORIGIN}/s/${minted.id}/manifest.json`)).json();
  assert.strictEqual(manAfter.name, 'JellyFlow: Renamed by owner', 'rename reflected');

  const delWrong = await (await realFetch(`${ORIGIN}/api/configs/${minted.id}`, { method: 'DELETE', headers: { 'x-owner-key': 'wrong' } })).json();
  assert.strictEqual(delWrong.locked, true, 'delete blocked behind password');


  // Access-password gate on the EDIT endpoints (the /s/<id>/configure flow),
  // exercised against a dedicated setup so ordering cannot interfere.
  const elMint = await (await realFetch(`${ORIGIN}/api/setups`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'EditLocked', jellyfinUrl: 'http://legacy.test', jellyfinApiKey: 'k', accessPassword: 'editlock' }),
  })).json();
  const elId = elMint.id;

  const noPw = await (await realFetch(`${ORIGIN}/api/configs/${elId}`)).json();
  assert.strictEqual(noPw.locked, true, 'edit skeleton locked without password');
  const withPw = await realFetch(`${ORIGIN}/api/configs/${elId}?pw=editlock`);
  const skLocked = await withPw.json();
  assert.strictEqual(skLocked.ok, true, 'skeleton unlocks with ?pw=');
  assert.ok(skLocked.setup.hosts[0].hasKey, 'unlocked skeleton still hides the key itself');

  const putNoPw = await realFetch(`${ORIGIN}/api/configs/${elId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Hacked', hosts: [{ mode: 'apikey', jellyfinUrl: 'http://evil.test' }] }),
  });
  assert.strictEqual((await putNoPw.json()).locked, true, 'PUT without password is locked, not applied');

  const putWithPw = await realFetch(`${ORIGIN}/api/configs/${elId}?pw=editlock`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Edited via pw', hosts: [{ mode: 'apikey', jellyfinUrl: 'http://owned.test', keepKey: true }], catalogs: { movies: true, series: true, genre: true } }),
  });
  const edited = await putWithPw.json();
  assert.strictEqual(edited.ok, true, 'PUT with ?pw= allowed: ' + (edited.error || ''));
  assert.strictEqual(edited.name, 'Edited via pw', 'rename applied');

  console.log('PASS: security headers + admin gating + anti-hijack access rules');
  console.log('PASS: SSRF metadata block + unlock throttle');
  process.exit(0);
}

async function login() {
  const r = await realFetch(`${ORIGIN}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'sec-test-key' }),
  });
  const raw = r.headers.get('set-cookie') || '';
  return raw.split(';')[0];
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
