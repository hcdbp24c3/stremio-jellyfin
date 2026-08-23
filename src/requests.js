'use strict';

const CACHE_TTL = 60 * 60 * 1000;
const tmdbCache = new Map();

async function resolveTmdb(imdbId, type) {
  const key = `${type}:${imdbId}`;
  const hit = tmdbCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.id;
  try {
    const res = await fetch(`https://v3-cinemeta.stremio/meta/${type}/${encodeURIComponent(imdbId)}.json`);
    if (!res.ok) throw new Error(`cinemeta ${res.status}`);
    const body = await res.json();
    const id = body && body.meta && body.meta.moviedb_id ? String(body.meta.moviedb_id) : null;
    tmdbCache.set(key, { id, at: Date.now() });
    return id;
  } catch {
    return null;
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

// All three services are treated per-host; Overseerr and Jellyseerr share the
// same API surface. Duplicate-request statuses count as success so re-playing
// the placeholder never looks broken to the user.
async function submitRequest(request, type, ids) {
  const base = String(request.url || '').replace(/\/+$/, '');
  const mediaType = normalizeMediaType(type);
  if (!base) return { ok: false, error: 'request url missing' };
  if (!ids.tmdbId) return { ok: false, error: 'could not resolve TMDB id from IMDb id' };

  if (request.type === 'jellyseerr' || request.type === 'overseerr') {
    return postJson(`${base}/api/v1/request`, { 'X-Api-Key': request.apiKey }, {
      mediaType,
      mediaId: String(ids.tmdbId),
      seasons: mediaType === 'tv' ? 'all' : undefined,
    });
  }
  if (request.type === 'ombi') {
    const path = mediaType === 'tv' ? '/api/v1/Request/tv' : '/api/v1/Request/movie';
    return postJson(`${base}${path}`, { ApiKey: request.apiKey }, {
      theMovieDbId: Number(ids.tmdbId),
      ...(ids.imdbId ? { imdbId: ids.imdbId } : {}),
    });
  }
  return { ok: false, error: `unsupported request service ${request.type}` };
}

module.exports = { resolveTmdb, submitRequest, normalizeMediaType };
