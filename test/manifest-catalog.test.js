'use strict';

process.env.PORT = String(process.env.TEST_PORT || 5107);
const CONFIG_PATH = `/tmp/opencode/stremio-jf-manifest-${Date.now()}.json`;
process.env.CONFIG_PATH = CONFIG_PATH;

const assert = require('assert');
const express = require('express');

const realFetch = globalThis.fetch;
const ORIGIN = `http://127.0.0.1:${Number(process.env.PORT)}`;

function startMockJellyfin() {
  const app = express();
  app.use(express.json());
  app.get('/System/Info', (req, res) => res.json({ Version: 'mock-1.0' }));
  app.get('/Users', (req, res) => res.json([{ Id: 'user-x' }]));
  app.get('/Users/:uid/Items', (req, res) => res.json({ Items: [], TotalRecordCount: 0 }));
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

  const cfg = { jellyfinUrl: jfUrl, jellyfinApiKey: 'key-1' };
  const TOKEN = Buffer.from(JSON.stringify(cfg)).toString('base64url');

  const res = await realFetch(`${ORIGIN}/${TOKEN}/manifest.json`);
  assert.strictEqual(res.status, 200, 'manifest loads');
  const man = await res.json();

  assert.ok(Array.isArray(man.catalogs) && man.catalogs.length === 2, 'two catalogs by default');
  const movies = man.catalogs.find((c) => c.id === 'jfmovies');
  const shows = man.catalogs.find((c) => c.id === 'jfshows');
  assert.ok(movies, 'jfmovies catalog kept');
  assert.ok(shows, 'jfshows catalog kept');
  assert.strictEqual(movies.type, 'movie', 'jfmovies type kept');
  assert.strictEqual(movies.name, 'Jellyfin Movies', 'jfmovies name kept');
  assert.strictEqual(shows.type, 'series', 'jfshows type kept');
  assert.strictEqual(shows.name, 'Jellyfin Shows', 'jfshows name kept');

  for (const c of [movies, shows]) {
    assert.ok(Array.isArray(c.extra), `catalog ${c.id} declares extra`);
    const names = c.extra.map((e) => e.name);
    assert.ok(names.includes('search'), `catalog ${c.id} supports search`);
    assert.ok(names.includes('skip'), `catalog ${c.id} supports skip`);
    for (const e of c.extra) {
      assert.strictEqual(e.isRequired, false, `extra ${e.name} is optional`);
    }
  }

  assert.deepStrictEqual(man.resources, ['catalog', 'meta', 'stream'], 'resources unchanged');
  assert.ok(!('idPrefixes' in man), 'no idPrefixes gate (accept GUID + tt)');
  assert.strictEqual(man.behaviorHints && man.behaviorHints.configurable, true, 'behaviorHints.configurable kept');
  assert.strictEqual(man.version, '1.0.0', 'version unchanged');

  const toggledCfg = { jellyfinUrl: jfUrl, jellyfinApiKey: 'key-1', catalogs: { movies: true, series: false } };
  const TOGGLED = Buffer.from(JSON.stringify(toggledCfg)).toString('base64url');
  const tman = await (await realFetch(`${ORIGIN}/${TOGGLED}/manifest.json`)).json();
  assert.deepStrictEqual(tman.catalogs.map((c) => c.id), ['jfmovies'], 'toggles still filter catalogs');
  assert.ok(tman.catalogs[0].extra.map((e) => e.name).includes('search'), 'toggled catalog keeps search extra');

  console.log('PASS: manifest catalogs expose search+skip extras');
  console.log('PASS: resources/idPrefixes/behaviorHints unchanged');
  process.exit(0);
}

main().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
