'use strict';

// Tests for hyphenated GUID handling (Fix 1) and external IDs in meta (Fix 2).
//
// Verifies that:
// 1. resolveItem normalizes hyphenated GUIDs (e.g. "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx")
//    to bare 32-char hex before the regex check, so real Jellyfin server responses work.
// 2. mapMeta includes imdbId/tmdbId from ProviderIds when available.

process.env.PORT = String(process.env.TEST_PORT || 5109);
process.env.CONFIG_PATH = '/tmp/opencode/hyphenated-guid-test-config.json';
require('fs').writeFileSync(process.env.CONFIG_PATH, '{}\n');

const assert = require('node:assert');
const PORT = Number(process.env.PORT);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const HOST = 'http://hf.test';

// Hyphenated GUID — real Jellyfin format
const GUID_HYPHEN = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
// Bare 32-char hex — old format
const GUID_BARE = 'a1b2c3d4e5f67890abcdef1234567890';

const ITEM = {
  Id: GUID_HYPHEN,
  Name: 'Hyphen GUID Movie',
  Type: 'Movie',
  ProductionYear: 2024,
  Overview: 'A test movie with a hyphenated GUID.',
  Genres: ['Action', 'Sci-Fi'],
  ProviderIds: { Imdb: 'tt1234567', Tmdb: '99999' },
  MediaSources: [
    {
      Name: 'hyphen-movie.mkv',
      Container: 'mkv',
      Size: 1_500_000_000,
      MediaStreams: [
        { Type: 'Video', Codec: 'h264', Height: 1080 },
        { Type: 'Audio', Codec: 'aac', Language: 'eng', Channels: 2 },
      ],
    },
  ],
};

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, statusText: 'OK', json: async () => body };
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

function jellyfinMock(label, { userId, items }) {
  return (url) => {
    const p = new URL(url).pathname;
    if (p === '/System/Info') return jsonResponse(200, { Version: `10.8.${label}` });
    if (p === '/Users') return jsonResponse(200, [{ Id: userId }]);
    // Match /Users/{userId}/Items/{itemId} — supports both hyphenated and bare GUIDs
    let m = p.match(/^\/Users\/[^/]+\/Items\/([^/]+)$/);
    if (m) {
      const idParam = m[1];
      // Match both hyphenated and bare forms
      const item = items.find((i) => i.Id === idParam || i.Id.replace(/-/g, '') === idParam.replace(/-/g, ''));
      return item ? jsonResponse(200, item) : jsonResponse(404, {});
    }
    m = p.match(/^\/Users\/[^/]+\/Items$/);
    if (m) return jsonResponse(200, { Items: items, TotalRecordCount: items.length });
    if (/^\/Items\/[^/]+\/Images/.test(p)) return imageResponse(true);
    return jsonResponse(404, {});
  };
}

const mock = jellyfinMock('HF', { userId: 'user-hf', items: [ITEM] });

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const TOKEN = b64url({ jellyfinUrl: HOST, jellyfinApiKey: 'key-hf' });

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
    if (s.startsWith(HOST)) return mock(s);
    return realFetch(url, init);
  };

  try {
    require('../index.js');
    await waitUntilReady(realFetch);

    // === Fix 1: Hyphenated GUID meta resolution ===

    // Test that a meta request with a hyphenated GUID resolves correctly.
    const meta1 = await getJson(`/${TOKEN}/meta/movie/${GUID_HYPHEN}.json`);
    assert.strictEqual(meta1.status, 200, 'meta with hyphenated GUID returns 200');
    assert.strictEqual(meta1.body.meta.name, 'Hyphen GUID Movie', 'meta name matches');
    assert.strictEqual(meta1.body.meta.id, GUID_HYPHEN, 'meta id is the hyphenated GUID');

    // Test that a meta request with a bare GUID also works (backwards compat).
    const meta2 = await getJson(`/${TOKEN}/meta/movie/${GUID_BARE}.json`);
    assert.strictEqual(meta2.status, 200, 'meta with bare GUID returns 200');
    assert.strictEqual(meta2.body.meta.name, 'Hyphen GUID Movie', 'bare GUID resolves same item');

    // === Fix 2: External IDs in meta ===

    // The meta response should include imdbId and tmdbId from ProviderIds.
    assert.strictEqual(meta1.body.meta.imdbId, 'tt1234567', 'meta includes imdbId from ProviderIds');
    assert.strictEqual(meta1.body.meta.tmdbId, '99999', 'meta includes tmdbId as string from ProviderIds');

    console.log('PASS: hyphenated GUID meta resolves correctly');
    console.log('PASS: bare GUID meta resolves correctly (backwards compat)');
    console.log('PASS: meta includes imdbId/tmdbId from ProviderIds');
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
