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
    const sid = (req.headers.cookie || '').match(/connect\.sid=([^;]+)/);
    if (!req.headers['x-api-key'] && !sid) return res.status(403).json({ message: 'unauthorized' });
    res.status(201).json({ id: 1, status: 'pending' });
  });
  // Real Overseerr/Jellyseerr authenticate by EMAIL — username is ignored.
  app.post('/api/v1/auth/local', (req, res) => {
    if (req.body.email === 'requser' && req.body.password === 'reqpass') {
      res.setHeader('Set-Cookie', 'connect.sid=s%3Asid123; Path=/; HttpOnly');
      return res.json({ user: { username: 'requser' } });
    }
    res.status(401).json({ message: 'Unauthorized' });
  });
  // Protected endpoint used to verify an admin API key (401 no auth / 403 bad key / 200 good key).
  app.get('/api/v1/user', (req, res) => {
    if (req.headers['x-api-key'] === 'adminkey') return res.status(200).json({ id: 1, displayName: 'admin' });
    if (req.headers['x-api-key']) return res.status(403).json({ message: 'invalid api key' });
    res.status(401).json({ message: 'unauthorized' });
  });
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

function startMockOmbi() {
  const ombiCalls = [];
  const app = express();
  app.use(express.json());
  app.get('/api/v1/Search/tv/:term', (req, res) => {
    ombiCalls.push({ kind: 'search', term: req.params.term, auth: req.headers.authorization || req.headers.apikey });
    res.json([{ id: 77777, theMovieDbId: '1399', title: 'Game of Thrones' }]);
  });
  app.post('/api/v1/Request/tv', (req, res) => {
    ombiCalls.push({ kind: 'request', body: req.body, auth: req.headers.authorization || req.headers.apikey });
    res.status(200).json({ success: true });
  });
  app.get('/api/v1/Status', (req, res) => {
    if (req.headers.apikey === 'ombikey') return res.status(200).json({ result: 'success' });
    res.status(401).json({ error: 'invalid api key' });
  });
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, calls: ombiCalls }));
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
  const ombi = await startMockOmbi();
  const hostA = await startMockJellyfin('a', [
    { Id: 'aaaa0000000000000000000000000001', Name: 'Local Movie', Type: 'Movie', ProductionYear: 2020 },
  ]);
  const hostB = await startMockJellyfin('b', []);

  require('../index.js');
  await waitUntilReady();

  // /api/check-request exchanges user/pass for a session token (no password in link).
  const authRes = await realFetch(`${ORIGIN}/api/check-request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'jellyseerr', url: `http://127.0.0.1:${js.port}`, username: 'requser', password: 'reqpass' }),
  });
  const authBody = await authRes.json();
  assert.strictEqual(authBody.ok, true, 'check-request login works');
  assert.ok(authBody.authToken.includes('sid123'), 'session token minted');

  // API-key mode: /api/check-request verifies an admin key against the service.
  const keyOk = await (await realFetch(`${ORIGIN}/api/check-request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'jellyseerr', url: `http://127.0.0.1:${js.port}`, apiKey: 'adminkey' }),
  })).json();
  assert.strictEqual(keyOk.ok, true, 'admin key accepted');
  assert.strictEqual(keyOk.apiKey, true, 'key mode flagged');
  const keyBad = await (await realFetch(`${ORIGIN}/api/check-request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'jellyseerr', url: `http://127.0.0.1:${js.port}`, apiKey: 'wrong' }),
  })).json();
  assert.strictEqual(keyBad.ok, false, 'bad key rejected');

  // Ombi API key verification uses the ApiKey header + status endpoint.
  const ombiKeyOk = await (await realFetch(`${ORIGIN}/api/check-request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'ombi', url: `http://127.0.0.1:${ombi.port}`, apiKey: 'ombikey' }),
  })).json();
  assert.strictEqual(ombiKeyOk.ok, true, 'ombi key accepted');

  // Token: host A without requests, host B wired to the mock Jellyseerr via USER/PASS session.
  const cfg = {
    hosts: [
      { jellyfinUrl: hostA, jellyfinApiKey: 'key-a' },
      { jellyfinUrl: hostB, accessToken: 'tok-b', userId: 'user-b', username: 'bravo',
        request: { type: 'jellyseerr', url: `http://127.0.0.1:${js.port}`, username: 'requser', authToken: authBody.authToken } },
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

  // 3. Playing the placeholder fires the Jellyseerr request with the session
  //    cookie and TMDB id resolved via Cinemeta.
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
  const cookieHdr = decodeURIComponent(jellyseerrCalls[0].headers.cookie || '');
  assert.ok(cookieHdr.includes('connect.sid=') && cookieHdr.includes('sid123'), 'session cookie forwarded');
  assert.deepStrictEqual(jellyseerrCalls[0].body, { mediaType: 'movie', mediaId: '603' }, 'request body carries tmdb id');

  // 4. Catalog toggles remove entries from the manifest.
  const toggledCfg = { jellyfinUrl: hostA, jellyfinApiKey: 'key-a', catalogs: { movies: true, series: false, genre: false } };
  const TOGGLED = Buffer.from(JSON.stringify(toggledCfg)).toString('base64url');
  const man = await getJson(`/${TOGGLED}/manifest.json`);
  assert.deepStrictEqual(man.body.catalogs.map((c) => c.type), ['movie'], 'toggled manifest keeps only movies');

  const fullMan = await getJson(`/${TOKEN}/manifest.json`);
  assert.strictEqual(fullMan.body.catalogs.length, 2, 'default manifest keeps movie + series rows');
  assert.ok(fullMan.body.catalogs.every((c) => !('genres' in c)), 'genre filter removed from catalog rows');

  // 5. Ombi TV mapping: tvdbId from Cinemeta is used (not TMDB), Bearer auth.
  const ombiCfg = {
    hosts: [
      { jellyfinUrl: hostA, jellyfinApiKey: 'key-a',
        request: { type: 'ombi', url: `http://127.0.0.1:${ombi.port}`, username: 'ombiuser', authToken: 'ombitoken' } },
      ],
  };
  const OMBI_TOKEN = Buffer.from(JSON.stringify(ombiCfg)).toString('base64url');
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith('https://v3-cinemeta.stremio/meta/series/tt0944947')) {
      return new Response(JSON.stringify({ meta: { moviedb_id: '1399', tvdb_id: '121361', name: 'Game of Thrones' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(url, opts);
  };
  const missingSeries = await getJson(`/${OMBI_TOKEN}/stream/series/tt0944947%3A1%3A1.json`);
  assert.strictEqual(missingSeries.status, 200, 'missing series responds');
  assert.ok(missingSeries.body.streams[0].name.includes('Request via ombi'), 'ombi placeholder named');
  const playOmbi = await realFetch(`${ORIGIN}${missingSeries.body.streams[0].url.replace(ORIGIN, '')}`);
  await playOmbi.arrayBuffer();
  await new Promise((r) => setTimeout(r, 100));
  const reqCall = ombi.calls.find((c) => c.kind === 'request');
  assert.ok(reqCall, 'ombi request submitted');
  assert.ok((reqCall.auth || '').startsWith('Bearer ombitoken'), 'bearer auth used');
  assert.strictEqual(reqCall.body.tvdbId, 121361, 'tvdbId mapped from cinemeta');
  assert.ok(!('theMovieDbId' in reqCall.body), 'no tmdb field on tv request');

  console.log('PASS: request placeholder flow (jellyseerr user/pass session) works end-to-end');
  console.log('PASS: request login sends email (real Overseerr/Jellyseerr schema)');
  console.log('PASS: request API key verification (jellyseerr + ombi)');
  console.log('PASS: Ombi TV uses tvdbId + bearer auth');
  console.log('PASS: catalog toggles filter manifest');
  process.exit(0);
}

main().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
