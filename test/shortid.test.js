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
let hlsMasterApiKey = '';
// Item whose stream the mock starts sending and then drops mid-body — the
// proxy must surface that as a client error instead of crashing the process.
const FLAKY = 'cccc0000000000000000000000000a11';

function startMockJellyfin() {
  const app = express();
  app.use(express.json());
  app.get('/System/Info', (req, res) => res.json({ Version: 'mock-1.0' }));
  app.get('/Users', (req, res) => res.json([{ Id: 'user-x' }]));
  app.get('/Users/:uid/Items', (req, res) => res.json({
    Items: [
      { Id: 'cccc0000000000000000000000000001', Name: 'Proxy Movie', Type: 'Movie', ProductionYear: 2024 },
      { Id: FLAKY, Name: 'Flaky Movie', Type: 'Movie', ProductionYear: 2024 },
    ],
    TotalRecordCount: 2,
  }));
  app.get('/Users/:uid/Items/:id', (req, res) => {
    if (!['cccc0000000000000000000000000001', FLAKY].includes(req.params.id)) return res.status(404).end();
    res.json({
      Id: req.params.id, Name: req.params.id === FLAKY ? 'Flaky Movie' : 'Proxy Movie', Type: 'Movie', ProductionYear: 2024,
      MediaSources: [{ Id: req.params.id, Name: 'src.mkv', Container: 'mkv', Size: 2048, MediaStreams: [{ Type: 'Video', Codec: 'h264', Height: 2160 }] }],
    });
  });
  app.get('/Videos/:id/stream', (req, res) => {
    upstreamHits += 1;
    res.setHeader('Content-Type', 'video/mp4');
    res.status(req.headers.range ? 206 : 200);
    if (req.params.id === FLAKY) {
      res.setHeader('Content-Length', '1024');
      res.write(Buffer.alloc(16, 7));
      setTimeout(() => req.socket.destroy(), 30);
      return;
    }
    res.end(Buffer.alloc(16, 7));
  });
  // HLS endpoints mirror real Jellyfin: playlists use RELATIVE URLs that embed
  // the api_key in their query string, so the proxy relay must strip it before
  // the player ever sees it and re-inject the server's own key upstream. Real
  // Jellyfin even puts the master-variant params in the PATH (`main.m3u8&...`)
  // and leaks a bogus `AudioCodec=m3u8` that makes direct-play segments 500.
  app.get('/Videos/:id/master.m3u8', (req, res) => {
    hlsMasterApiKey = req.query.api_key || '';
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    const staticQ = req.query.Static === 'true';
    const join = staticQ ? '?' : '&';
    res.end(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=8768000,RESOLUTION=1920x801
main.m3u8${join}Static=${req.query.Static || 'false'}&mediaSourceId=${req.params.id}&api_key=${req.query.api_key || 'MISSING'}&AudioCodec=m3u8${staticQ ? '' : '&MaxWidth=1920&VideoBitrate=8000000'}
#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1280x534
main.m3u8${join}Static=${req.query.Static || 'false'}&mediaSourceId=${req.params.id}&api_key=${req.query.api_key || 'MISSING'}&AudioCodec=m3u8${staticQ ? '' : '&MaxWidth=1280&VideoBitrate=4000000'}
`);
  });
  app.get('/Videos/:id/main.m3u8', (req, res) => {
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.end(`#EXTM3U
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:3
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:3.000000, nodesc
hls1/main/0.ts?Static=${req.query.Static || 'false'}&mediaSourceId=${req.params.id}&api_key=${req.query.api_key || 'MISSING'}&AudioCodec=m3u8&runtimeTicks=0
#EXTINF:3.000000, nodesc
hls1/main/1.ts?Static=${req.query.Static || 'false'}&mediaSourceId=${req.params.id}&api_key=${req.query.api_key || 'MISSING'}&AudioCodec=m3u8&runtimeTicks=30000000
#EXT-X-ENDLIST
`);
  });
  // Like real Jellyfin in direct-play mode: AudioCodec=m3u8 (a leaked playlist
  // MIME, not a codec) makes the segment request 500.
  app.get('/Videos/:id/hls1/main/:seg', (req, res) => {
    if (String(req.query.AudioCodec).toLowerCase() === 'm3u8') {
      res.status(500).end('Error processing request.');
      return;
    }
    res.setHeader('Content-Type', 'video/mp2t');
    res.end(Buffer.from('TS' + req.params.seg));
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

  // 2a. Links must honor the proxy scheme: behind Cloudflare the internal
  // connection is http, so X-Forwarded-Proto/Host decide the public URL.
  // Loopback forwarded-host on purpose — non-loopback would poison the global
  // latestPublicBase (media URLs) for the rest of this test run.
  const httpsMint = await (await realFetch(`${ORIGIN}/api/setups`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-Proto': 'https',
      'X-Forwarded-Host': `127.0.0.1:${Number(process.env.PORT)}`,
    },
    body: JSON.stringify({ name: 'Https', jellyfinUrl: jfUrl, jellyfinApiKey: 'key-https' }),
  })).json();
  assert.strictEqual(httpsMint.ok, true, 'https mint ok');
  assert.ok(httpsMint.installUrl.startsWith(`https://127.0.0.1:${Number(process.env.PORT)}/`), `https link: ${httpsMint.installUrl}`);
  assert.ok(!httpsMint.installUrl.startsWith('http://'), 'no http:// hardcoded link');

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
  assert.deepStrictEqual(cat.metas.map((m) => m.name).sort(), ['Flaky Movie', 'Proxy Movie'], 'catalog works via sid');

  // 4. Proxy control: stateless setups follow the global default; stored
  // setups can be toggled individually via the admin API.
  const offStateless = await (await realFetch(`${ORIGIN}/${minted.token}/stream/movie/cccc0000000000000000000000000001.json`)).json();
  assert.ok(offStateless.streams[0] && !offStateless.streams[0].url.includes('/p/'), 'stateless default is direct');
  // Parseable release name + real size must ride on behaviorHints so AIOStreams
  // (which reads those instead of the description) can render the format.
  assert.strictEqual(offStateless.streams[0].behaviorHints.filename, 'Proxy.Movie.2024.4K.BluRay.x264.JellyFlow.mkv', 'behaviorHints.filename is the parseable release name');
  assert.strictEqual(offStateless.streams[0].behaviorHints.videoSize, 2048, 'behaviorHints.videoSize carries the real byte size');

  await realFetch(`${ORIGIN}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: mintLocked.id, proxyStreams: true }),
  });
  const streams = await (await realFetch(`${ORIGIN}/s/${mintLocked.id}/stream/movie/cccc0000000000000000000000000001.json`)).json();
  assert.ok(streams.streams[0].url.includes('/p/'), 'stored setup proxied when toggled on');
  assert.ok(streams.streams[0].behaviorHints && streams.streams[0].behaviorHints.filename.includes('JellyFlow'), 'proxied stream still carries parseable filename');
  const media = await realFetch(streams.streams[0].url);
  const bytes = Buffer.from(await media.arrayBuffer());
  assert.strictEqual(upstreamHits, 1, 'upstream hit exactly once');
  assert.ok(bytes.length > 0, 'media relayed through addon');

  // A mid-stream upstream abort used to surface as an unhandled 'error' event
  // on the piped stream and crash the process. It must now surface to the
  // client as a truncated body while the addon keeps serving.
  const flakyStreams = await (await realFetch(`${ORIGIN}/s/${mintLocked.id}/stream/movie/${FLAKY}.json`)).json();
  assert.ok(flakyStreams.streams[0].url.includes('/p/'), 'flaky stream proxied');
  let flakyError = null;
  try {
    const r = await realFetch(flakyStreams.streams[0].url);
    await r.arrayBuffer();
  } catch (e) {
    flakyError = e;
  }
  assert.ok(flakyError, 'truncated upstream surfaces as a client error');
  const alive = await (await realFetch(`${ORIGIN}/healthz`)).json();
  assert.strictEqual(alive.ok, true, 'process survives mid-stream upstream abort');

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

  // 6. HLS modes (per-host `hls` flag → master.m3u8). Two flavors:
  //    `hls: true`      = transcode ladder (Smooth 1080p)
  //    `hls: 'direct'`  = play the source file as-is (original quality)
  const hlsMint = await (await realFetch(`${ORIGIN}/api/setups`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Hls Setup', jellyfinUrl: jfUrl, jellyfinApiKey: 'key-hls', hls: true, accessPassword: 'hls-secret' }),
  })).json();
  assert.strictEqual(hlsMint.ok, true, 'hls mint ok');
  const hlsId = hlsMint.id;

  // Direct HLS: stream URL points at a master playlist; the redirect lands on
  // Jellyfin with transcode params (key exposed to the player, as direct mode).
  const hlsDirect = await (await realFetch(`${ORIGIN}/s/${hlsId}/stream/movie/cccc0000000000000000000000000001.json`)).json();
  const hlsUrl = hlsDirect.streams[0].url;
  assert.ok(hlsUrl.endsWith('/master.m3u8?mediaSourceId=cccc0000000000000000000000000001'), 'hls stream uses master.m3u8 with mediaSourceId');
  assert.ok(!hlsUrl.includes('/p/'), 'hls direct by default');
  const hlsRedir = await realFetch(hlsUrl, { redirect: 'manual' });
  assert.strictEqual(hlsRedir.status, 302, 'hls direct 302s to jellyfin');
  const hlsTarget = hlsRedir.headers.get('location');
  assert.ok(hlsTarget.includes('/master.m3u8?') && hlsTarget.includes('api_key=key-hls'), 'hls redirect carries transcode url with key');
  assert.ok(hlsTarget.includes('VideoBitrate=') && hlsTarget.includes('VideoCodec=h264'), 'hls redirect caps bitrate to h264');
  const masterDirect = await (await realFetch(hlsTarget)).text();
  assert.ok(masterDirect.includes('main.m3u8&') && masterDirect.includes('api_key='), 'jellyfin master playlist embeds key (direct mode, raw path-params)');

  // Proxy HLS: playlists are re-served from the addon with the api_key and the
  // bogus AudioCodec=m3u8 stripped, and re-injected upstream; segments pipe
  // through so nothing leaks.
  await realFetch(`${ORIGIN}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: hlsId, proxyStreams: true }),
  });
  const hlsProx = await (await realFetch(`${ORIGIN}/s/${hlsId}/stream/movie/cccc0000000000000000000000000001.json`)).json();
  const proxMasterUrl = hlsProx.streams[0].url;
  assert.ok(proxMasterUrl.includes('/p/') && proxMasterUrl.endsWith('/master.m3u8?mediaSourceId=cccc0000000000000000000000000001'), 'hls proxy url shape');
  const proxBase = `/p/${proxMasterUrl.split('/p/')[1].split('/master.m3u8')[0]}`;
  const proxMaster = await (await realFetch(proxMasterUrl)).text();
  assert.ok(!proxMaster.includes('api_key='), 'proxy strips api_key from master playlist');
  assert.ok(!proxMaster.includes('AudioCodec'), 'proxy strips bogus AudioCodec=m3u8 from master playlist');
  assert.ok(!proxMaster.includes('main.m3u8&'), 'proxy normalizes Jellyfin path-params (main.m3u8& -> main.m3u8?)');
  assert.strictEqual(hlsMasterApiKey, 'key-hls', 'proxy injects the stored key upstream');
  const mainLine = proxMaster.match(/^main\.m3u8\?[^\s]+/m);
  assert.ok(mainLine, 'master playlist carries a main.m3u8 variant');
  const proxMain = await (await realFetch(`${ORIGIN}${proxBase}/main.m3u8?${mainLine[0].split('?')[1]}`)).text();
  assert.ok(proxMain.includes('hls1/main/0.ts?') && !proxMain.includes('api_key='), 'proxy strips api_key from media playlist');
  assert.ok(!proxMain.includes('AudioCodec'), 'proxy strips bogus AudioCodec=m3u8 from media playlist');
  const rawMain = await (await realFetch(`${ORIGIN}${proxBase}/main.m3u8&${mainLine[0].split('?')[1]}`)).text();
  assert.ok(rawMain.includes('hls1/main/0.ts?') && !rawMain.includes('api_key='), 'proxy accepts raw Jellyfin path-params form');
  const segLine = proxMain.match(/^hls1\/main\/[^?]+\?[^\s]+/m);
  assert.ok(segLine, 'media playlist carries segment urls');
  const seg = await (await realFetch(`${ORIGIN}${proxBase}/${segLine[0].split('?')[0]}?${segLine[0].split('?')[1]}`)).arrayBuffer();
  assert.strictEqual(Buffer.from(seg).toString(), 'TS0.ts', 'segment relayed through addon');
  // A player that cached the raw playlist still works: the relay drops the
  // leaked AudioCodec=m3u8 (mock 500s on it, like real Jellyfin direct-play).
  const segSticky = await (await realFetch(`${ORIGIN}${proxBase}/hls1/main/0.ts?${segLine[0].split('?')[1]}&AudioCodec=m3u8`)).arrayBuffer();
  assert.strictEqual(Buffer.from(segSticky).toString(), 'TS0.ts', 'relay strips AudioCodec=m3u8 from segment requests');

  // 7. Original-quality HLS (`hls: 'direct'` → Static=true, no transcode).
  const dirMint = await (await realFetch(`${ORIGIN}/api/setups`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Hls Direct', jellyfinUrl: jfUrl, jellyfinApiKey: 'key-direct', hls: 'direct', accessPassword: 'd-secret' }),
  })).json();
  assert.strictEqual(dirMint.ok, true, 'direct hls mint ok');
  const dirId = dirMint.id;
  const skelDir = await (await realFetch(`${ORIGIN}/api/configs/${dirId}`, { headers: { 'x-owner-key': dirMint.manageKey } })).json();
  assert.strictEqual(skelDir.setup.hosts[0].hls, 'direct', 'skeleton preserves direct hls mode');
  const dirStream = await (await realFetch(`${ORIGIN}/s/${dirId}/stream/movie/cccc0000000000000000000000000001.json`)).json();
  const dirUrl = dirStream.streams[0].url;
  assert.ok(dirUrl.endsWith('/master.m3u8?mediaSourceId=cccc0000000000000000000000000001'), 'direct-hls stream uses master.m3u8');
  const dirRedir = await realFetch(dirUrl, { redirect: 'manual' });
  const dirTarget = dirRedir.headers.get('location');
  assert.ok(dirTarget.includes('Static=true'), 'direct-hls redirect uses Static=true (no transcode)');
  assert.ok(!dirTarget.includes('VideoBitrate='), 'direct-hls redirect has no bitrate caps');
  await realFetch(`${ORIGIN}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: dirId, proxyStreams: true }),
  });
  const dirProx = await (await realFetch(`${ORIGIN}/s/${dirId}/stream/movie/cccc0000000000000000000000000001.json`)).json();
  const dirProxBase = `/p/${dirProx.streams[0].url.split('/p/')[1].split('/master.m3u8')[0]}`;
  const dirMaster = await (await realFetch(dirProx.streams[0].url)).text();
  assert.ok(dirMaster.includes('Static=true'), 'direct-hls proxy keeps Static=true');
  assert.ok(!dirMaster.includes('api_key=') && !dirMaster.includes('AudioCodec'), 'direct-hls proxy strips key + AudioCodec');
  const dirMainLine = dirMaster.match(/^main\.m3u8\?[^\s]+/m);
  assert.ok(dirMainLine, 'direct-hls master carries a main.m3u8 variant');
  const dirMain = await (await realFetch(`${ORIGIN}${dirProxBase}/main.m3u8?${dirMainLine[0].split('?')[1]}`)).text();
  assert.ok(dirMain.includes('hls1/main/0.ts?') && !dirMain.includes('api_key=') && !dirMain.includes('AudioCodec'), 'direct-hls media playlist stripped');
  const dirSeg = dirMain.match(/^hls1\/main\/[^?]+\?[^\s]+/m);
  const dirSegRes = await realFetch(`${ORIGIN}${dirProxBase}/${dirSeg[0].split('?')[0]}?${dirSeg[0].split('?')[1]}`);
  assert.strictEqual(Buffer.from(await dirSegRes.arrayBuffer()).toString(), 'TS0.ts', 'direct-hls segment relayed (original file, no transcode)');

  console.log('PASS: legacy migration + short-id lifecycle (/s/<id>)');
  console.log('PASS: PROXY_STREAMS relays media through addon');
  console.log('PASS: HLS smooth-playback (direct redirect + proxy relay, key stripped)');
  console.log('PASS: HLS original-quality direct mode (Static=true, no re-encode)');
  process.exit(0);
}

main().catch((err) => {
  console.error("FAIL:", err.message); 
  process.exit(1);
});
