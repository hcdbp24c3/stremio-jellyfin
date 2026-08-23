'use strict';

// Regression test: after a 401 auto-renewal in JellyfinClient.get(), the
// renewed access token must propagate to this.apiKey so streamUrl()/imageUrl()
// stop embedding the expired token.

const assert = require('node:assert');
const { JellyfinClient } = require('../src/jellyfin');

const OLD_TOKEN = 'old-access-token';
const NEW_TOKEN = 'new-access-token';
const BASE = 'http://jellyfin.test';

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 401 ? 'Unauthorized' : 'OK',
    json: async () => body,
  };
}

async function run() {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/Users/AuthenticateByName')) {
      assert.strictEqual(init.method, 'POST');
      return jsonResponse(200, {
        AccessToken: NEW_TOKEN,
        User: { Id: 'user-2', Name: 'guest' },
      });
    }
    // First data call uses the expired token -> 401; retry succeeds.
    const sentToken = init.headers['X-Emby-Token'];
    if (sentToken === OLD_TOKEN) return jsonResponse(401, {});
    if (sentToken === NEW_TOKEN) {
      return jsonResponse(200, { Items: [], TotalRecordCount: 0 });
    }
    throw new Error(`Unexpected fetch ${u} with token ${sentToken}`);
  };

  try {
    const client = new JellyfinClient({
      baseUrl: BASE,
      accessToken: OLD_TOKEN,
      userId: 'user-1',
      username: 'guest',
      encPw: 'encrypted-blob',
      streamMode: 'direct',
    });
    client._decrypt = async () => 'plain-password';

    await client.getItems({ type: 'Movie', limit: 1 });

    // Renewal happened exactly once and retry succeeded.
    assert.strictEqual(calls.filter((c) => c.includes('/Users/AuthenticateByName')).length, 1);

    // All token surfaces must reflect the renewed token.
    assert.strictEqual(client.token, NEW_TOKEN, 'this.token updated');
    assert.strictEqual(client.apiKey, NEW_TOKEN, 'this.apiKey must track renewed token');
    assert.strictEqual(client.userId, 'user-2', 'userId refreshed');
    assert.strictEqual(client.headers['X-Emby-Token'], NEW_TOKEN, 'header updated');
    assert.ok(client.streamUrl('item1').includes(`api_key=${NEW_TOKEN}`), 'streamUrl uses renewed token');
    assert.ok(client.imageUrl('item1').includes(encodeURIComponent(NEW_TOKEN)), 'imageUrl uses renewed token');

    console.log('PASS: 401 auto-renew propagates new token to apiKey/streamUrl/imageUrl');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

run().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
