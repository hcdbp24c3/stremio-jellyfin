'use strict';

const CACHE_TTL = 60 * 60 * 1000;
const idsCache = new Map();

// Cinemeta exposes moviedb_id for movies/series and tvdb_id for series, which
// is exactly what Ombi's TV endpoint wants (it keys on TheTVDB, not TMDB).
async function resolveExternalIds(imdbId, type) {
  const key = `${type}:${imdbId}`;
  const hit = idsCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.ids;
  try {
    const res = await fetch(`https://v3-cinemeta.stremio/meta/${type}/${encodeURIComponent(imdbId)}.json`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`cinemeta ${res.status}`);
    const body = await res.json();
    const meta = (body && body.meta) || {};
    const ids = {
      tmdbId: meta.moviedb_id ? String(meta.moviedb_id) : null,
      tvdbId: meta.tvdb_id ? String(meta.tvdb_id) : null,
    };
    idsCache.set(key, { ids, at: Date.now() });
    return ids;
  } catch {
    return { tmdbId: null, tvdbId: null };
  }
}

function normalizeMediaType(type) {
  return type === 'series' || type === 'episode' ? 'tv' : 'movie';
}

async function postJson(url, headers, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', accept: 'application/json', ...headers },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
  });
  if (res.ok) return { ok: true, status: res.status };
  if (res.status === 409 || res.status === 422) return { ok: true, status: res.status, duplicate: true };
  let detail = '';
  try {
    const body = await res.json();
    detail = body && (body.message || body.error) ? ` ${body.message || body.error}` : '';
  } catch {}
  return { ok: false, status: res.status, error: `${res.status} ${res.statusText}${detail}` };
}

function serviceHeaders(request) {
  // API key mode (admin key) vs session-token mode minted from user/pass.
  if (request.authToken) {
    if (request.type === 'ombi') return { Authorization: `Bearer ${request.authToken}` };
    return { Cookie: `connect.sid=${request.authToken}` };
  }
  if (request.type === 'ombi') return { ApiKey: request.apiKey };
  return { 'X-Api-Key': request.apiKey };
}

// Exchange username/password for a long-lived session token so no password
// ever needs to live in the install link. Jellyseerr and Overseerr share the
// same auth surface; Ombi issues its own bearer via /api/v1/Token.
async function loginRequestApp(request) {
  const base = String(request.url || '').replace(/\/+$/, '');
  if (!base) throw new Error('request url missing');
  const headers = { 'Content-Type': 'application/json', accept: 'application/json' };

  if (request.type === 'jellyseerr' || request.type === 'overseerr') {
    // Overseerr/Jellyseerr authenticate by EMAIL — the username field is
    // ignored server-side, so send the identifier as both fields.
    let res = await fetch(`${base}/api/v1/auth/local`, {
      method: 'POST', headers, body: JSON.stringify({ email: request.username, username: request.username, password: request.password }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`${request.type} login failed ${res.status} ${res.statusText}`);
    const cookie = res.headers.get('set-cookie') || '';
    const sid = cookie.match(/connect\.sid=([^;]+)/i);
    const body = await res.json().catch(() => ({}));
    const authToken = sid ? sid[1] : body.accessToken;
    if (!authToken) throw new Error('no session token in auth response');
    return { authToken, username: (body.user && body.user.username) || request.username };
  }

  if (request.type === 'ombi') {
    const res = await fetch(`${base}/api/v1/Token`, {
      method: 'POST', headers, body: JSON.stringify({ username: request.username, password: request.password, rememberMe: true }),
    });
    if (!res.ok) throw new Error(`ombi login failed ${res.status} ${res.statusText}`);
    const body = await res.json();
    const authToken = body.access_token || body.accessToken;
    if (!authToken) throw new Error('no access_token in ombi auth response');
    return { authToken, username: request.username };
  }

  throw new Error(`unsupported request service ${request.type}`);
}

// Verify an admin API key without logging in. Overseerr/Jellyseerr expose the
// current user via /api/v1/user (401 without auth, 403 on a bad key, 200 with
// a valid key); Ombi gates its status endpoint on the ApiKey header.
async function verifyRequestKey(request) {
  const base = String(request.url || '').replace(/\/+$/, '');
  if (!base) throw new Error('request url missing');
  const key = String(request.apiKey || '').trim();
  if (!key) throw new Error('request API key missing');
  const headers = request.type === 'ombi' ? { ApiKey: key } : { 'X-Api-Key': key };
  const path = request.type === 'ombi' ? '/api/v1/Status' : '/api/v1/user';
  const res = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(15000) });
  if (res.ok) return { ok: true };
  let detail = '';
  try {
    const body = await res.json();
    detail = body && (body.message || body.error) ? ` — ${body.message || body.error}` : '';
  } catch {}
  return { ok: false, error: `API key rejected (${res.status})${detail}` };
}

// All three services are treated per-host; Overseerr and Jellyseerr share the
// same API surface. Duplicate-request statuses count as success so re-playing
// the placeholder never looks broken to the user.
async function submitRequest(request, type, ids) {
  const base = String(request.url || '').replace(/\/+$/, '');
  const mediaType = normalizeMediaType(type);
  if (!base) return { ok: false, error: 'request url missing' };
  const hasCred = request.apiKey || request.authToken;
  if (!hasCred) return { ok: false, error: 'request credentials missing' };

  const headers = serviceHeaders(request);

  if (request.type === 'jellyseerr' || request.type === 'overseerr') {
    return postJson(`${base}/api/v1/request`, headers, {
      mediaType,
      mediaId: String(ids.tmdbId),
      seasons: mediaType === 'tv' ? 'all' : undefined,
    });
  }
  if (request.type === 'ombi') {
    if (mediaType === 'tv') {
      if (!ids.tvdbId) return { ok: false, error: 'TVDB id unavailable for this series (Ombi TV requests need it)' };
      return postJson(`${base}/api/v1/Request/tv`, headers, { tvdbId: Number(ids.tvdbId), title: ids.title });
    }
    return postJson(`${base}/api/v1/Request/movie`, headers, {
      theMovieDbId: Number(ids.tmdbId),
      ...(ids.imdbId ? { imdbId: ids.imdbId } : {}),
    });
  }
  return { ok: false, error: `unsupported request service ${request.type}` };
}

module.exports = { resolveTmdb: async (...a) => (await resolveExternalIds(...a)).tmdbId, resolveExternalIds, submitRequest, normalizeMediaType, loginRequestApp, verifyRequestKey, serviceHeaders };
