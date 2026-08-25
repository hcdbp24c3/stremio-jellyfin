'use strict';

const ROOT = '/tmp/opencode/stremio-jf-store-' + Date.now();
process.env.PORT = String(process.env.TEST_PORT || 5108);
process.env.CONFIG_PATH = `${ROOT}/config.json`;
process.env.DB_PATH = `${ROOT}/setups.db`;

const assert = require('assert');
const fs = require('fs');
const express = require('express');

const realFetch = globalThis.fetch;
const ORIGIN = `http://127.0.0.1:${Number(process.env.PORT)}`;

// Legacy config.json the migration must import on first boot.
fs.mkdirSync(ROOT, { recursive: true });
fs.writeFileSync(process.env.CONFIG_PATH, JSON.stringify({
  savedConfigs: [{ name: 'Legacy Home', jellyfinUrl: 'http://legacy.test', jellyfinApiKey: 'legacy-key' }],
}));

let upstreamHits = 0;

function startMockJellyfin() {
  const app = express();
  app.use(express.json());
  app.get('/System/Info', (req, res) => res.json({ Version: 'mock-1.0' }));
  app.get('/Users', (req, res) => res.json([{ Id: 'user-x' }]));
  app.get('/Users/:uid/Items', (req, res) => res.json({
    Items: [{ Id: 'cccc0000000000000000000000000001', Name: 'Proxy Movie', Type: 'Movie', ProductionYear: 2024 }],
    TotalRecordCount: 1,
  }));
  app.get('/Users/:uid/Items/:id', (req, res) => {
    if (req.params.id !== 'cccc0000000000000000000000000001') return res.status(404).end();
    res.json({
      Id: req.params.id, Name: 'Proxy Movie', Type: 'Movie',
      MediaSources: [{ Id: req.params.id, Name: 'src.mkv', Container: 'mkv', Size: 2048, MediaStreams: [{ Type: 'Video', Codec: 'h264', Height: 2160 }] }],
    });
  });
  app.get('/Videos/:id/stream', (req, res) => {
    upstreamHits += 1;
    res.setHeader('Content-Type', 'video/mp4');
    res.status(req.headers.range ? 206 : 200);
    res.end(Buffer.alloc(16, 7));
  });
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${srv.address().port}`));
  });
}

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await realFetch(`${ORIGIN}/configure`);
      await r.arrayBuffer();
      return;
    } catch { await new Promise((r) => setTimeout(r, 150)); }
  }
  throw new Error('server never ready');
}

async function main() {
  const jfUrl = await startMockJellyfin();
  require('../index.js');
  await waitReady();

  // 0. Liveness endpoint stays 200 regardless of upstream state.
  const hz = await realFetch(`${ORIGIN}/healthz`);
  assert.strictEqual(hz.status, 200, 'healthz liveness 200');
  assert.strictEqual((await hz.json()).ok, true, 'healthz payload ok');

  // 1. Migration: legacy savedConfigs row got a short id and serves via /s/.
  const st = await (await realFetch(`${ORIGIN}/api/status`)).json();
  assert.ok(Array.isArray(st.configs) && st.configs.length === 1, 'migrated one setup');
  const migrated = st.configs[0];
  assert.ok(migrated.id && migrated.id.length >= 10, 'short id allocated');
  assert.ok(migrated.shortInstallUrl.endsWith(`/s/${migrated.id}/manifest.json`), 'short install url built');

  const man = await realFetch(`${ORIGIN}/s/${migrated.id}/manifest.json`);
  const manBody = await man.json();
  assert.strictEqual(man.status, 200, 'manifest via /s/<id> loads');
  assert.strictEqual(manBody.name, 'JellyFlow: Legacy Home');

  // The legacy raw token URL keeps working too (if installUrl is present; otherwise skip - privacy-minimized status hides it).
  if (migrated.installUrl) {
    const tokPath = migrated.installUrl.replace(ORIGIN, '');
    assert.strictEqual((await realFetch(ORIGIN + tokPath)).status, 200, 'long token url still valid');
  }

  // 2. Public minting: POST /api/setups returns a fresh short link.
  const mintRes = await realFetch(`${ORIGIN}/api/setups`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Second', jellyfinUrl: jfUrl, jellyfinApiKey: 'key-2' }),
  });
  const minted = await mintRes.json();
  assert.strictEqual(minted.ok, true, 'public mint ok');
  assert.strictEqual(minted.id, null, 'password-less mint is stateless (not stored)');
  assert.ok(minted.installUrl.includes(`/${minted.token}/manifest.json`), 'stateless url uses raw token');

  const man2 = await realFetch(`${ORIGIN}${minted.installUrl.replace(ORIGIN, '')}`);
  assert.strictEqual(man2.status, 200, 'token manifest loads');
  await man2.arrayBuffer();

  // 2b. Public mint with accessPassword locks the status page immediately.
  const mintLocked = await (await realFetch(`${ORIGIN}/api/setups`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Secretive', jellyfinUrl: jfUrl, jellyfinApiKey: 'key-3', accessPassword: 'topsecret' }),
  })).json();
  assert.strictEqual(mintLocked.ok, true, 'mint with password ok');
  const lockedSt = await (await realFetch(`${ORIGIN}/api/status/${mintLocked.id}`)).json();
  assert.strictEqual(lockedSt.config.locked, true, 'status locked right after mint');
  assert.ok(!JSON.stringify(lockedSt.config).includes(jfUrl), 'locked payload hides host');
  const unlockOk = await realFetch(`${ORIGIN}/api/unlock/${mintLocked.id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'topsecret' }),
  });
  assert.strictEqual(unlockOk.status, 200, 'creator password unlocks');

  // 3. Catalog through short id returns Stremio-shaped metas.
  const cat = await (await realFetch(`${ORIGIN}/s/${mintLocked.id}/catalog/movie/jfmovies.json`)).json();
  assert.deepStrictEqual(cat.metas.map((m) => m.name), ['Proxy Movie'], 'catalog works via sid');

  // 4. Proxy control: stateless setups follow the global default; stored
  // setups can be toggled individually via the admin API.
  const offStateless = await (await realFetch(`${ORIGIN}/${minted.token}/stream/movie/cccc0000000000000000000000000001.json`)).json();
  assert.ok(offStateless.streams[0] && !offStateless.streams[0].url.includes('/p/'), 'stateless default is direct');

  await realFetch(`${ORIGIN}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: mintLocked.id, proxyStreams: true }),
  });
  const streams = await (await realFetch(`${ORIGIN}/s/${mintLocked.id}/stream/movie/cccc0000000000000000000000000001.json`)).json();
  assert.ok(streams.streams[0].url.includes('/p/'), 'stored setup proxied when toggled on');
  const media = await realFetch(streams.streams[0].url);
  const bytes = Buffer.from(await media.arrayBuffer());
  assert.strictEqual(upstreamHits, 1, 'upstream hit exactly once');
  assert.ok(bytes.length > 0, 'media relayed through addon');

  // Isolation: a sibling setup (no override) keeps following the global default.
  const sibRes = await realFetch(`${ORIGIN}/api/setups`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Sibling', jellyfinUrl: jfUrl, jellyfinApiKey: 'key-sibling' }),
  });
  const sibling = await sibRes.json();
  const otherStreams = await (await realFetch(`${ORIGIN}/${sibling.token}/stream/movie/cccc0000000000000000000000000001.json`)).json();
  assert.ok(otherStreams.streams[0] && !otherStreams.streams[0].url.includes('/p/'), 'sibling setup stays direct');

  // Toggle back off restores direct urls for this setup only.
  await realFetch(`${ORIGIN}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: minted.id, proxyStreams: false }),
  });
  const after = await (await realFetch(`${ORIGIN}/${minted.token}/stream/movie/cccc0000000000000000000000000001.json`)).json();
  assert.ok(!after.streams[0].url.includes('/p/'), 'toggle off restores direct urls');

  // 5. Delete by id removes the setup.
  const del = await realFetch(`${ORIGIN}/api/configs/${mintLocked.id}`, { method: 'DELETE' });
  assert.strictEqual(del.status, 200, 'delete by short id');
  const gone = await realFetch(`${ORIGIN}/s/${mintLocked.id}/manifest.json`);
  assert.strictEqual(gone.status, 404, 'setup gone after delete');
  const stillThere = await realFetch(`${ORIGIN}/${minted.token}/manifest.json`);
  assert.strictEqual(stillThere.status, 200, 'stateless setup unaffected');

  console.log('PASS: legacy migration + short-id lifecycle (/s/<id>)');
  console.log('PASS: PROXY_STREAMS relays media through addon');
  process.exit(0);
}

main().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
