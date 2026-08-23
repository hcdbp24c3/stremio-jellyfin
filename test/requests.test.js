'use strict';

process.env.PORT = String(process.env.TEST_PORT || 5106);
const CONFIG_PATH = `/tmp/opencode/stremio-jf-requests-${Date.now()}.json`;
process.env.CONFIG_PATH = CONFIG_PATH;

const assert = require('assert');
const http = require('http');
const express = require('express');

const realFetch = globalThis.fetch;
const ORIGIN = `http://127.0.0.1:${Number(process.env.PORT)}`;

let jellyseerrCalls = [];

function startMockJellyseerr() {
  const app = express();
  app.use(express.json());
  app.post('/api/v1/request', (req, res) => {
    jellyseerrCalls.push({ headers: req.headers, body: req.body });
    if (req.headers['x-api-key'] !== 'js-key') return res.status(403).json({ message: 'bad key' });
    res.status(201).json({ id: 1, status: 'pending' });
  });
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

function startMockJellyfin(name, items) {
  const app = express();
  app.use(express.json());
  app.get('/System/Info', (req, res) => res.json({ Version: `${name}-1.0` }));
  app.get('/Users', (req, res) => res.json([{ Id: `user-${name}` }]));
  app.get('/Users/:uid/Items', (req, res) => res.json({ Items: items, TotalRecordCount: items.length }));
  app.get('/Users/:uid/Items/:id', (req, res) => {
    const it = items.find((x) => x.Id === req.params.id);
    if (!it) return res.status(404).end();
    res.json({
      ...it,
      MediaSources: [{ Id: it.Id, Name: `${name}-source`, Container: 'mkv', Size: 1024, MediaStreams: [{ Type: 'Video', Codec: 'h264', Height: 1080 }] }],
    });
  });
  app.get('/Genres', (req, res) => res.json({ Items: [{ Id: 'g1', Name: 'Action' }], TotalRecordCount: 1 }));
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${srv.address().port}`));
  });
}

function waitUntilReady() {
  return new Promise((resolve, reject) => {
    const tryOnce = async () => {
      try {
        const res = await realFetch(`${ORIGIN}/configure`);
        await res.arrayBuffer();
        resolve();
      } catch {
        setTimeout(tryOnce, 150);
      }
    };
    setTimeout(() => reject(new Error('server never became ready')), 8000);
    tryOnce();
  });
}

async function getJson(path) {
  const res = await realFetch(`${ORIGIN}${path}`);
  const body = await res.json();
  return { status: res.status, body };
}

async function main() {
  const js = await startMockJellyseerr();
  const hostA = await startMockJellyfin('a', [
    { Id: 'aaaa0000000000000000000000000001', Name: 'Local Movie', Type: 'Movie', ProductionYear: 2020 },
  ]);
  const hostB = await startMockJellyfin('b', []);

  require('../index.js');
  await waitUntilReady();

  // Token: host A without requests, host B wired to the mock Jellyseerr.
  const cfg = {
    hosts: [
      { jellyfinUrl: hostA, jellyfinApiKey: 'key-a' },
      { jellyfinUrl: hostB, accessToken: 'tok-b', userId: 'user-b', username: 'bravo',
        request: { type: 'jellyseerr', url: `http://127.0.0.1:${js.port}`, apiKey: 'js-key' } },
      ],
  };
  const TOKEN = Buffer.from(JSON.stringify(cfg)).toString('base64url');

  // 1. Missing item yields a request placeholder stream.
  const missing = await getJson(`/${TOKEN}/stream/movie/tt01111111.json`);
  assert.strictEqual(missing.status, 200, 'missing stream responds');
  assert.strictEqual(missing.body.streams.length, 1, 'one placeholder stream');
  assert.ok(missing.body.streams[0].name.includes('Request via jellyseerr'), 'placeholder names service');
  assert.ok(missing.body.streams[0].url.includes(`/r/${TOKEN}/movie/`), 'placeholder hits /r route');

  // 2. Existing item still streams normally.
  const present = await getJson(`/${TOKEN}/stream/movie/aaaa0000000000000000000000000001.json`);
  assert.strictEqual(present.status, 200);
  assert.ok(present.body.streams.length >= 1, 'present item has stream');
  assert.ok(!JSON.stringify(present.body.streams).includes('/r/'), 'no placeholder for present item');

  // 3. Playing the placeholder fires the Jellyseerr request with TMDB id resolved via Cinemeta.
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith('https://v3-cinemeta.stremio/meta/movie/tt01111111')) {
      return new Response(JSON.stringify({ meta: { moviedb_id: '603' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(url, opts);
  };
  const playPath = missing.body.streams[0].url.replace(ORIGIN, '');
  const playRes = await realFetch(`${ORIGIN}${playPath}`);
  const wav = Buffer.from(await playRes.arrayBuffer());
  assert.strictEqual(playRes.status, 200, 'placeholder plays');
  assert.strictEqual(playRes.headers.get('content-type'), 'audio/wav', 'placeholder is audio/wav');
  assert.ok(wav.length > 44 && wav.slice(0, 4).toString() === 'RIFF', 'valid WAV bytes');
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(jellyseerrCalls.length, 1, 'exactly one jellyseerr POST');
  assert.strictEqual(jellyseerrCalls[0].headers['x-api-key'], 'js-key', 'service api key forwarded');
  assert.deepStrictEqual(jellyseerrCalls[0].body, { mediaType: 'movie', mediaId: '603' }, 'request body carries tmdb id');

  // 4. Catalog toggles remove entries from the manifest.
  const toggledCfg = { jellyfinUrl: hostA, jellyfinApiKey: 'key-a', catalogs: { movies: true, series: false, genre: false } };
  const TOGGLED = Buffer.from(JSON.stringify(toggledCfg)).toString('base64url');
  const man = await getJson(`/${TOGGLED}/manifest.json`);
  assert.deepStrictEqual(man.body.catalogs.map((c) => c.type), ['movie'], 'toggled manifest keeps only movies');

  const fullMan = await getJson(`/${TOKEN}/manifest.json`);
  assert.strictEqual(fullMan.body.catalogs.length, 3, 'default manifest keeps all three catalogs');

  console.log('PASS: request placeholder flow (jellyseerr) works end-to-end');
  console.log('PASS: catalog toggles filter manifest');
  process.exit(0);
}

main().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
