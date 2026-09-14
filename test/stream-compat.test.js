'use strict';

process.env.PORT = String(process.env.TEST_PORT || 5121);
process.env.CONFIG_PATH = '/tmp/opencode/stream-compat-test-config.json';
require('fs').writeFileSync(process.env.CONFIG_PATH, '{}\n');

const assert = require('node:assert/strict');

const PORT = Number(process.env.PORT);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const HOST = 'http://jf.test';

const ID_MKV = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ID_MP4 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ID_HEVC_MP4 = 'cccccccccccccccccccccccccccccccc';
const ID_EP = 'dddddddddddddddddddddddddddddddd';
const ID_STRM = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const STRM_URL = 'https://cdn.example.com/movie.mkv';

function mkSubs() {
  return [
    { Type: 'Subtitle', Codec: 'subrip', Language: 'eng', Index: 2, IsExternal: false },
    { Type: 'Subtitle', Codec: 'pgssub', Language: 'eng', Index: 3, IsExternal: false },
    { Type: 'Subtitle', Codec: 'dvdsub', Language: 'vie', Index: 4, IsExternal: false },
    { Type: 'Subtitle', Codec: 'ass', Language: 'vie', Index: 5, IsExternal: true, Container: 'ass' },
    { Type: 'Subtitle', Codec: 'PGSSUB', Language: 'eng', Index: 6, IsExternal: false },
  ];
}

const ITEMS = {
  [ID_MKV]: {
    Id: ID_MKV, Name: 'Mkv Movie', Type: 'Movie', ProductionYear: 2024,
    MediaSources: [{
      Name: 'mkv-movie.mkv', Container: 'mkv', Size: 1000,
      MediaStreams: [
        { Type: 'Video', Codec: 'h264', Height: 1080 },
        { Type: 'Audio', Codec: 'aac', Language: 'eng', Channels: 2 },
        ...mkSubs(),
      ],
    }],
  },
  [ID_MP4]: {
    Id: ID_MP4, Name: 'Mp4 Movie', Type: 'Movie', ProductionYear: 2024,
    MediaSources: [{
      Name: 'mp4-movie.mp4', Container: 'mp4', Size: 1000,
      MediaStreams: [
        { Type: 'Video', Codec: 'h264', Height: 1080 },
        { Type: 'Audio', Codec: 'aac', Language: 'eng', Channels: 2 },
        ...mkSubs(),
      ],
    }],
  },
  [ID_HEVC_MP4]: {
    Id: ID_HEVC_MP4, Name: 'Hevc Movie', Type: 'Movie', ProductionYear: 2024,
    MediaSources: [{
      Name: 'hevc.mp4', Container: 'mp4', Size: 1000,
      MediaStreams: [
        { Type: 'Video', Codec: 'hevc', Height: 2160 },
        { Type: 'Audio', Codec: 'aac', Language: 'eng', Channels: 2 },
      ],
    }],
  },
  [ID_EP]: {
    Id: ID_EP, Name: 'Ep One', Type: 'Episode', ParentIndexNumber: 1, IndexNumber: 2,
    SeriesName: 'Show', ProductionYear: 2024,
    MediaSources: [{
      Name: 'ep.mkv', Container: 'mkv', Size: 1000,
      MediaStreams: [{ Type: 'Video', Codec: 'h264', Height: 1080 }],
    }],
  },
  [ID_STRM]: {
    Id: ID_STRM, Name: 'Strm Movie', Type: 'Movie', ProductionYear: 2024,
    MediaSources: [{
      Name: 'strm-movie.mkv', Container: 'mkv', Path: STRM_URL, Size: 170,
      MediaStreams: [
        { Type: 'Video', Codec: 'h264', Height: 1080 },
        ...mkSubs(),
      ],
    }],
  },
};

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, statusText: 'OK', headers: { get: () => 'application/json' }, json: async () => body };
}

function jfMock(url) {
  const p = new URL(url).pathname;
  if (p === '/System/Info') return jsonResponse(200, { Version: '10.8.0' });
  if (p === '/Users') return jsonResponse(200, [{ Id: 'user-1' }]);
  const m = p.match(/^\/Users\/[^/]+\/Items\/([^/]+)$/);
  if (m) {
    const item = ITEMS[m[1]];
    return item ? jsonResponse(200, item) : jsonResponse(404, {});
  }
  const list = p.match(/^\/Users\/[^/]+\/Items$/);
  if (list) return jsonResponse(200, { Items: Object.values(ITEMS), TotalRecordCount: 5 });
  return jsonResponse(404, {});
}

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const TOKEN = b64url({ jellyfinUrl: HOST, jellyfinApiKey: 'k' });

async function getJson(path) {
  const res = await fetch(`${ORIGIN}${path}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function waitUntilReady(realFetch) {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await realFetch(`${ORIGIN}/health`);
      if (r.status === 200 || r.status === 503) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

async function run() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith(HOST)) return jfMock(String(url));
    return realFetch(url, init);
  };
  try {
    require('../index.js');
    await waitUntilReady(realFetch);

    const mkv = await getJson(`/${TOKEN}/stream/movie/${ID_MKV}.json`);
    assert.equal(mkv.status, 200);
    assert.equal(mkv.body.streams[0].behaviorHints.notWebReady, true, 'MKV notWebReady');
    assert.ok(mkv.body.streams[0].behaviorHints.filename, 'MKV filename kept');
    assert.equal(mkv.body.streams[0].behaviorHints.videoSize, 1000, 'MKV videoSize kept');
    console.log('PASS: MKV h264 has notWebReady=true with filename/videoSize');

    const mp4 = await getJson(`/${TOKEN}/stream/movie/${ID_MP4}.json`);
    assert.equal(mp4.body.streams[0].behaviorHints.notWebReady, undefined, 'MP4 h264 no flag');
    console.log('PASS: MP4 h264 has no notWebReady flag');

    const hevc = await getJson(`/${TOKEN}/stream/movie/${ID_HEVC_MP4}.json`);
    assert.equal(hevc.body.streams[0].behaviorHints.notWebReady, true, 'MP4 hevc flagged');
    console.log('PASS: MP4 hevc has notWebReady=true');

    const subs = mkv.body.streams[0].subtitles || [];
    assert.ok(subs.length > 0, 'text subs kept');
    assert.ok(!subs.some((x) => /pgssub|pgs|dvdsub/i.test(x.url)), 'no image-sub urls, got: ' + JSON.stringify(subs.map((x) => x.url)));
    assert.ok(!String(mkv.body.streams[0].description || '').match(/PGSSUB/i), 'description has no PGS');
    console.log('PASS: PGS/DVD subs filtered, text subs kept');

    const ep = await getJson(`/${TOKEN}/stream/series/${ID_EP}.json`);
    assert.ok(String(ep.body.streams[0].behaviorHints.bingeGroup || '').startsWith('jellyflow-'), 'episode bingeGroup');
    assert.equal(mkv.body.streams[0].behaviorHints.bingeGroup, undefined, 'movie no bingeGroup');
    console.log('PASS: episode sets bingeGroup, movie does not');

    const strm = await getJson(`/${TOKEN}/stream/movie/${ID_STRM}.json`);
    assert.equal(strm.body.streams[0].url, STRM_URL, 'strm direct url');
    assert.ok(Array.isArray(strm.body.streams[0].subtitles) && strm.body.streams[0].subtitles.length > 0, '.strm has subs');
    assert.ok(!strm.body.streams[0].subtitles.some((x) => /pgssub|pgs|dvdsub/i.test(x.url)), '.strm subs filtered');
    console.log('PASS: .strm branch carries subtitles');
  } finally {
    globalThis.fetch = realFetch;
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('FAIL:', err.message);
    process.exit(1);
  });
