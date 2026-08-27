'use strict';

// Task 2 verification: buildAddon multi-host aggregation.
//
// Boots the real addon server (index.js) against two mocked Jellyfin
// backends and checks that one merged token aggregates catalog/meta/stream
// across hosts, while single-host tokens keep working unchanged.

process.env.PORT = String(process.env.TEST_PORT || 5103);
process.env.CONFIG_PATH = '/tmp/opencode/merge-hosts-test-config.json';
require('fs').writeFileSync(process.env.CONFIG_PATH, '{}\n');

const assert = require('node:assert');
const PORT = Number(process.env.PORT);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PUBLIC_BASE = ORIGIN;
const HOST_A = 'http://a.test';
const HOST_B = 'http://b.test';

const ID_A1 = 'aaaa0000000000000000000000000001';
const ID_A2 = 'aaaa0000000000000000000000000002';
const ID_B1 = 'bbbb0000000000000000000000000001';
const ID_B2 = 'bbbb0000000000000000000000000002';

const MOVIES_A = [
  { Id: ID_A1, Name: 'Alpha One', Type: 'Movie', ProductionYear: 2001 },
  { Id: ID_A2, Name: 'Alpha Two', Type: 'Movie', ProductionYear: 2002 },
];
const MOVIES_B = [
  {
    Id: ID_B1,
    Name: 'Bravo One',
    Type: 'Movie',
    ProductionYear: 2011,
    MediaSources: [
      {
        Name: 'bravo-one.mkv',
        Container: 'mkv',
        Size: 2_000_000_000,
        MediaStreams: [
          { Type: 'Video', Codec: 'h264', Height: 1080 },
          { Type: 'Audio', Codec: 'aac', Language: 'eng', Channels: 2 },
        ],
      },
    ],
  },
  { Id: ID_B2, Name: 'Bravo Two', Type: 'Movie', ProductionYear: 2012 },
];

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, statusText: status === 404 ? 'Not Found' : 'OK', json: async () => body };
}

function imageResponse(ok) {
  return {
    ok,
    status: ok ? 200 : 404,
    headers: { get: () => 'image/png' },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]));
        controller.close();
      },
    }),
  };
}

// Minimal Jellyfin API surface used by JellyfinClient.
function jellyfinMock(label, { userId, items, hasImages }) {
  return (url) => {
    const p = new URL(url).pathname;
    if (p === '/System/Info') return jsonResponse(200, { Version: `10.8.${label}` });
    if (p === '/Users') return jsonResponse(200, [{ Id: userId }]);
    let m = p.match(/^\/Users\/[^/]+\/Items\/([^/]+)$/);
    if (m) {
      const item = items.find((i) => i.Id === m[1]);
      return item ? jsonResponse(200, item) : jsonResponse(404, {});
    }
    m = p.match(/^\/Users\/[^/]+\/Items$/);
    if (m) return jsonResponse(200, { Items: items, TotalRecordCount: items.length });
    if (/^\/Items\/[^/]+\/Images/.test(p)) return imageResponse(hasImages);
    return jsonResponse(404, {});
  };
}

const mockA = jellyfinMock('A', { userId: 'user-a', items: MOVIES_A, hasImages: false });
const mockB = jellyfinMock('B', { userId: 'user-b', items: MOVIES_B, hasImages: true });

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const MERGED_TOKEN = b64url({
  hosts: [
    { jellyfinUrl: HOST_A, jellyfinApiKey: 'key-a' },
    { jellyfinUrl: HOST_B, accessToken: 'tok-b', userId: 'user-b', username: 'bravo' },
  ],
});
const SINGLE_TOKEN = b64url({ jellyfinUrl: HOST_A, jellyfinApiKey: 'key-a' });

async function getJson(path) {
  const res = await fetch(`${ORIGIN}${path}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function waitUntilReady(realFetch) {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await realFetch(`${ORIGIN}/health`);
      if (res.status === 200 || res.status === 503) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

async function run() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const s = String(url);
    if (s.startsWith(HOST_A)) return mockA(s);
    if (s.startsWith(HOST_B)) return mockB(s);
    return realFetch(url, init);
  };

  try {
    require('../index.js');
    await waitUntilReady(realFetch);

    // 1. Manifest describes the merged setup.
    const man = await getJson(`/${MERGED_TOKEN}/manifest.json`);
    assert.strictEqual(man.status, 200, 'merged manifest loads');
    assert.ok(man.body.description.includes('2 Jellyfin servers'), 'manifest description counts hosts');

    // 2. Catalog merges items from both hosts in order.
    const cat = await getJson(`/${MERGED_TOKEN}/catalog/movie/jfmovies.json`);
    assert.strictEqual(cat.status, 200, 'merged catalog loads');
    assert.deepStrictEqual(
      cat.body.metas.map((x) => x.name),
      ['Alpha One', 'Alpha Two', 'Bravo One', 'Bravo Two'],
      'catalog merges both hosts'
    );
    assert.ok(cat.body.metas.every((x) => x.poster.startsWith(`${PUBLIC_BASE}/img/${MERGED_TOKEN}/`)), 'posters are absolute with merged token');

    // 3. Pagination slices the merged list without duplicates.
    const page2 = await getJson(`/${MERGED_TOKEN}/catalog/movie/jfmovies/skip=2&limit=2.json`);
    assert.deepStrictEqual(
      page2.body.metas.map((x) => x.name),
      ['Bravo One', 'Bravo Two'],
      'skip/limit window spans hosts'
    );

    // 4. Meta falls through host A (404) to host B.
    const meta = await getJson(`/${MERGED_TOKEN}/meta/movie/${ID_B1}.json`);
    assert.strictEqual(meta.body.meta.name, 'Bravo One', 'meta resolves on second host');

    // 6. Stream comes from the owning host via addon redirect/proxy (api_key hidden).
    const stream = await getJson(`/${MERGED_TOKEN}/stream/movie/${ID_B1}.json`);
    assert.strictEqual(stream.body.streams.length, 1, 'one stream returned');
    assert.ok(stream.body.streams[0].url.includes(`/d/${MERGED_TOKEN}/`) || stream.body.streams[0].url.includes(`/p/${MERGED_TOKEN}/`), 'stream via addon redirect/proxy');
    assert.ok(!stream.body.streams[0].url.includes('api_key='), 'stream url hides api_key');
    assert.ok(stream.body.streams[0].name.includes('Bravo One'), 'stream card titled');

    // 7. Status exposes host count + per-host urls (primary first).
    const st = await getJson(`/api/status/${MERGED_TOKEN}`);
    assert.strictEqual(st.body.config.hostCount, 2, 'status reports hostCount');
    assert.deepStrictEqual(
      st.body.config.hosts.map((h) => h.url),
      [HOST_A, HOST_B],
      'status lists every host url'
    );
    assert.strictEqual(st.body.config.url, HOST_A, 'primary url first');

    // 8. Single-host token behaves exactly as before.
    const single = await getJson(`/${SINGLE_TOKEN}/catalog/movie/jfmovies.json`);
    assert.deepStrictEqual(
      single.body.metas.map((x) => x.name),
      ['Alpha One', 'Alpha Two'],
      'single-host catalog unchanged'
    );
    const singleMan = await getJson(`/${SINGLE_TOKEN}/manifest.json`);
    assert.ok(singleMan.body.description.includes(HOST_A), 'single-host description unchanged');
    const singleMeta = await getJson(`/${SINGLE_TOKEN}/meta/movie/${ID_B1}.json`);
    assert.strictEqual(singleMeta.body.meta.name, 'Item not found on Jellyfin', 'single-host cannot see other host items');

    // 9. Image proxy falls through to the host that owns the item.
    const img = await fetch(`${ORIGIN}/img/${MERGED_TOKEN}/${ID_B1}/Primary`);
    assert.strictEqual(img.status, 200, 'image served by owning host');
    assert.strictEqual(img.headers.get('content-type'), 'image/png', 'image content-type forwarded');
    const imgMiss = await fetch(`${ORIGIN}/img/${SINGLE_TOKEN}/${ID_B1}/Primary`);
    assert.strictEqual(imgMiss.status, 404, 'single-host image miss stays 404');

    console.log('PASS: merged token aggregates catalog/meta/stream/images across 2 hosts');
    console.log('PASS: pagination window stable across hosts');
    console.log('PASS: single-host tokens behave unchanged');
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
