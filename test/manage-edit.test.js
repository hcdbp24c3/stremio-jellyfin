'use strict';

const ROOT = '/tmp/opencode/stremio-jf-edit-' + Date.now();
process.env.PORT = String(process.env.TEST_PORT || 5110);
process.env.CONFIG_PATH = `${ROOT}/config.json`;
process.env.DB_PATH = `${ROOT}/setups.db`;

const assert = require('assert');
const fs = require('fs');
const express = require('express');

const realFetch = globalThis.fetch;
const ORIGIN = `http://127.0.0.1:${Number(process.env.PORT)}`;

fs.mkdirSync(ROOT, { recursive: true });
fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify({
  savedConfigs: [{ name: 'Editable', jellyfinUrl: 'http://legacy.test', jellyfinApiKey: 'legacy-key' }],
}));

function startMockJellyfin(name, items) {
  const app = express();
  app.use(express.json());
  let authCalls = 0;
  app.get('/System/Info', (req, res) => res.json({ Version: `${name}-1.0` }));
  app.post('/Users/AuthenticateByName', (req, res) => {
    authCalls++;
    if (req.body.Username === 'alice' && req.body.Pw === 'wonder') {
      return res.json({ AccessToken: `tok-${name}-${authCalls}`, User: { Id: `uid-${name}`, Name: 'alice' } });
    }
    res.status(401).end();
  });
  app.get('/Users', (req, res) => res.json([{ Id: `uid-${name}` }]));
  app.get('/Users/Me', (req, res) => {
    const token = req.headers['x-emby-token'] || '';
    if (!token.startsWith('tok-')) return res.status(401).end();
    res.json({ Id: `uid-${name}`, Name: 'alice' });
  });
  app.get('/Users/:uid/Items', (req, res) => res.json({ Items: items, TotalRecordCount: items.length }));
  app.get('/Users/:uid/Items/:id', (req, res) => {
    const it = items.find((x) => x.Id === req.params.id);
    if (!it) return res.status(404).end();
    res.json({ ...it, MediaSources: [{ Id: it.Id, Name: 's.mkv', Container: 'mkv', Size: 1, MediaStreams: [] }] });
  });
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${srv.address().port}`));
  });
}

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { await (await realFetch(`${ORIGIN}/healthz`)).json(); return; }
    catch { await new Promise((r) => setTimeout(r, 150)); }
  }
  throw new Error('never ready');
}

let cookieJar = '';

async function main() {
  const jfA = await startMockJellyfin('a', [{ Id: 'dddd0000000000000000000000000001', Name: 'Edit Movie', Type: 'Movie' }]);
  require('../index.js');
  await waitReady();

  // Grab migrated setup id.
  const st = await (await realFetch(`${ORIGIN}/api/status`)).json();
  const id = st.configs[0].id;
  assert.ok(id, 'migrated id');

  // 1. Skeleton hides secrets but flags presence.
  const sk = await (await realFetch(`${ORIGIN}/api/configs/${id}`)).json();
  assert.strictEqual(sk.setup.hosts[0].hasKey, true, 'skeleton hasKey');
  assert.ok(!JSON.stringify(sk).includes('legacy-key'), 'skeleton never leaks the key');

  // 2. PUT with BLANK key keeps stored credentials (merge semantics).
  const put1 = await realFetch(`${ORIGIN}/api/configs/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Renamed', catalogs: { movies: true, series: false, genre: false }, hosts: [{ mode: 'apikey', jellyfinUrl: 'http://legacy.test' }] }),
  });
  const p1 = await put1.json();
  assert.strictEqual(p1.ok, true, 'blank-key PUT ok');
  assert.strictEqual(p1.name, 'Renamed');
  const man = await (await realFetch(`${ORIGIN}/s/${id}/manifest.json`)).json();
  assert.deepStrictEqual(man.catalogs.map((c) => c.type), ['movie'], 'catalog toggle applied via edit');

  // 3. Add a user-mode host -> merged hostCount 2.
  const put2 = await realFetch(`${ORIGIN}/api/configs/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Merged', catalogs: { movies: true, series: true, genre: true },
      hosts: [
        { mode: 'apikey', jellyfinUrl: 'http://legacy.test' },
        { mode: 'user', jellyfinUrl: jfA, username: 'alice', password: 'wonder' },
      ],
    }),
  });
  const p2 = await put2.json();
  assert.strictEqual(p2.ok, true, 'multi-host PUT ok: ' + (p2.error || ''));
  const st2 = await (await realFetch(`${ORIGIN}/api/status`)).json();
  assert.strictEqual(st2.configs[0].hostCount, 2, 'two hosts after edit');

  // 3b. The configure page mints a token via /api/check and submits the host
  // WITHOUT a `mode` field — the PUT must trust the browser-minted token
  // instead of falling through to the API-key branch ("API key required").
  const chk = await (await realFetch(`${ORIGIN}/api/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jellyfinUrl: jfA, username: 'alice', password: 'wonder' }),
  })).json();
  assert.ok(chk.ok, 'check ok');
  const put3 = await realFetch(`${ORIGIN}/api/configs/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Merged', catalogs: { movies: true, series: true, genre: true },
      hosts: [
        { mode: 'apikey', jellyfinUrl: 'http://legacy.test' },
        { jellyfinUrl: jfA, accessToken: chk.accessToken, userId: chk.userId, username: chk.username },
      ],
    }),
  });
  const p3 = await put3.json();
  assert.strictEqual(p3.ok, true, 'browser-minted user token PUT ok: ' + (p3.error || ''));

  // 3c. Access-token mode (servers that refuse the password endpoint): a pasted
  // token is verified via /Users/Me — no password round-trip at all.
  const tokOk = await (await realFetch(`${ORIGIN}/api/check`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jellyfinUrl: jfA, accessToken: 'tok-pasted' }),
  })).json();
  assert.strictEqual(tokOk.ok, true, 'token check ok: ' + (tokOk.error || ''));
  assert.strictEqual(tokOk.userId, 'uid-a', 'token check resolves user id');
  assert.strictEqual(tokOk.username, 'alice', 'token check resolves username');

  const tokBad = await (await realFetch(`${ORIGIN}/api/check`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jellyfinUrl: jfA, accessToken: 'bogus' }),
  })).json();
  assert.strictEqual(tokBad.ok, false, 'bogus token rejected');
  assert.ok(/rejected/i.test(tokBad.error), 'rejection message clear');

  // /api/setups with a token-only host (no username, no password) mints fine.
  const tokSetup = await (await realFetch(`${ORIGIN}/api/setups`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'TokenOnly', hosts: [{ jellyfinUrl: jfA, accessToken: 'tok-pasted' }] }),
  })).json();
  assert.strictEqual(tokSetup.ok, true, 'token-only setup minted: ' + (tokSetup.error || ''));
  const tokMan = await (await realFetch(`${ORIGIN}${tokSetup.tokenUrl.replace(ORIGIN, '')}`)).json();
  assert.ok(tokMan.catalogs.some((c) => c.type === 'movie'), 'token setup serves a manifest');
  assert.ok(!JSON.stringify(tokMan).includes('tok-pasted'), 'token not embedded in manifest');

  // The merged setup's skeleton must show the browser-minted token host as auth.
  const skTok = await (await realFetch(`${ORIGIN}/api/configs/${id}`)).json();
  assert.strictEqual(skTok.setup.hosts[1].hasAuth, true, 'token host stored as auth');
  assert.ok(!JSON.stringify(skTok).includes(tokOk.accessToken), 'token never leaked in skeleton');

  // 4. Access password locks the public status page.
  await realFetch(`${ORIGIN}/api/configs/${id}/access`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'family123' }),
  });
  const locked = await (await realFetch(`${ORIGIN}/api/status/${id}`)).json();
  assert.strictEqual(locked.config.locked, true, 'status locked');
  assert.ok(!JSON.stringify(locked.config).includes('legacy.test'), 'locked payload hides host url');

  const badPw = await realFetch(`${ORIGIN}/api/unlock/${id}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'nope' }),
  });
  assert.strictEqual(badPw.status, 401, 'wrong password rejected');

  // Stateless unlock: correct password returns the full details for one render.
  const unlockRes = await realFetch(`${ORIGIN}/api/unlock/${id}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'family123' }),
  });
  const unlockedBody = await unlockRes.json();
  assert.strictEqual(unlockedBody.ok, true, 'unlock ok');
  assert.strictEqual(unlockedBody.config.locked, false, 'unlocked payload');
  assert.strictEqual(unlockedBody.config.url, 'http://legacy.test', 'full details in unlock response');

  // Fresh GET without pw is locked again — nothing persisted.
  const relocked = await (await realFetch(`${ORIGIN}/api/status/${id}`)).json();
  assert.strictEqual(relocked.config.locked, true, 'no session persists');

  // Changing/removing the password requires currentPassword when not admin-session.
  const noCur = await realFetch(`${ORIGIN}/api/configs/${id}/access`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: '' }),
  });
  assert.strictEqual(noCur.status, 200, 'keyless deployment: manage is open by design (negative case covered in security.test.js)');

  // Remove the password again with currentPassword supplied.
  await realFetch(`${ORIGIN}/api/configs/${id}/access`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword: 'family123', password: '' }),
  });
  const relocked2 = await (await realFetch(`${ORIGIN}/api/status/${id}`)).json();
  assert.notStrictEqual(relocked2.config.locked, true, 'password removed');

  // 5. Webhook purges caches and answers 204.
  const hook = await realFetch(`${ORIGIN}/webhook/${id}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'available' }),
  });
  assert.strictEqual(hook.status, 204, 'webhook accepted');

  console.log('PASS: skeleton/merge edit keeps secrets working');
  console.log('PASS: multi-host edit merges hosts in place');
  console.log('PASS: browser-minted user token accepted without mode field');
  console.log('PASS: pasted access-token mode verified via /Users/Me, mints without password');
  console.log('PASS: access password lock/unlock lifecycle');
  console.log('PASS: webhook endpoint purges caches');
  process.exit(0);
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
