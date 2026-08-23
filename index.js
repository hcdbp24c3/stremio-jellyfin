'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Readable } = require('stream');
const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const { JellyfinClient } = require('./src/jellyfin');
const { resolveTmdb, resolveExternalIds, submitRequest, loginRequestApp } = require('./src/requests');
const { createStore } = require('./src/store');

const configPath = process.env.CONFIG_PATH || path.join(__dirname, 'config.json');

function loadConfigFile() {
  try {
    return require(configPath);
  } catch {
    return {};
  }
}

function writeConfigFile(obj) {
  fs.writeFileSync(configPath, JSON.stringify(obj, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Server secret + password encryption (AES-256-GCM).
// Used to encrypt Jellyfin passwords at rest instead of shipping them in the
// install URL. The secret lives in the setup store (sqlite/json), falling
// back to config.json for pre-store installs.
// ---------------------------------------------------------------------------

function encryptPassword(pw, secret) {
  const key = crypto.createHash('sha256').update(String(secret)).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(pw), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, enc, tag]).toString('base64url');
}

function decryptPassword(encPw, secret) {
  const key = crypto.createHash('sha256').update(String(secret)).digest();
  const buf = Buffer.from(String(encPw), 'base64url');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const enc = buf.subarray(12, buf.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

const fileConfig = loadConfigFile();
const PORT = Number(process.env.PORT || fileConfig.port || 7000);
const STREAM_MODE = fileConfig.streamMode || 'direct';
const PAGE_SIZE = Number(fileConfig.pageSize || 20);
const CACHE_TTL = Number(fileConfig.cacheTtl || 300);
const MANAGE_KEY = process.env.MANAGE_KEY || fileConfig.manageKey || '';
const envOverrides = !!process.env.JELLYFIN_URL || !!process.env.JELLYFIN_API_KEY;

const isPlaceholder = (value) => /YOUR|PASTE_/.test(value);

// ---------------------------------------------------------------------------
// Config URLs (Torrentio-style): one random-looking install URL per Jellyfin
// setup. The token is base64url(JSON({jellyfinUrl, jellyfinApiKey})), so each
// config is self-contained in its own URL and needs no server-side per-user
// state. The same token always yields the same addon.
// ---------------------------------------------------------------------------

// Token shapes (4):
//  1. API key:    base64url(JSON({jellyfinUrl, jellyfinApiKey}))          — legacy, unchanged
//  2. User token: base64url(JSON({jellyfinUrl, accessToken, userId,
//                   username[, encPw]}))                                  — new hybrid mode
//  3. Raw JSON pasted directly into the URL — still accepted by decodeToken.
//  4. Merged multi-host: base64url(JSON({hosts: [<shape 1|2 per host>]})) —
//                 several Jellyfin setups packed into one install URL.
function serializeRequest(r) {
  if (!r || !r.type || !r.url) return undefined;
  const o = { type: r.type, url: r.url };
  if (r.username) o.username = r.username;
  if (r.apiKey) o.apiKey = r.apiKey;
  if (r.apiKeyEnc) o.apiKeyEnc = r.apiKeyEnc;
  if (r.authToken) o.authToken = r.authToken;
  if (r.authTokenEnc) o.authTokenEnc = r.authTokenEnc;
  return o;
}

function serializeCatalogs(c) {
  if (!c || typeof c !== 'object') return undefined;
  const out = {
    movies: c.movies !== false,
    series: c.series !== false,
    genre: c.genre !== false,
  };
  return out.movies && out.series && out.genre ? undefined : out;
}

function tokenFor(config) {
  if (Array.isArray(config.hosts)) {
    const hosts = config.hosts.map((h) => {
      let o;
      if (h.accessToken) {
        o = { jellyfinUrl: h.jellyfinUrl, accessToken: h.accessToken, userId: h.userId, username: h.username };
        if (h.encPw) o.encPw = h.encPw;
      } else {
        o = { jellyfinUrl: h.jellyfinUrl, jellyfinApiKey: h.jellyfinApiKey };
      }
      const req = serializeRequest(h.request);
      if (req) o.request = req;
      return o;
    });
    return Buffer.from(JSON.stringify({ hosts })).toString('base64url');
  }
  const cat = serializeCatalogs(config.catalogs);
  if (config.accessToken) {
    const obj = { jellyfinUrl: config.jellyfinUrl, accessToken: config.accessToken, userId: config.userId, username: config.username };
    if (config.encPw) obj.encPw = config.encPw;
    const req = serializeRequest(config.request);
    if (req) obj.request = req;
    if (cat) obj.catalogs = cat;
    return Buffer.from(JSON.stringify(obj)).toString('base64url');
  }
  const obj = { jellyfinUrl: config.jellyfinUrl, jellyfinApiKey: config.jellyfinApiKey };
  const req = serializeRequest(config.request);
  if (req) obj.request = req;
  if (cat) obj.catalogs = cat;
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

// Validate + normalize one host object (either token shape). Returns the
// normalized host or null when the shape is not a valid Jellyfin setup.
function decodeHost(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (typeof obj.jellyfinUrl !== 'string' || !/^https?:\/\//i.test(obj.jellyfinUrl)) return null;
  const jellyfinUrl = obj.jellyfinUrl.replace(/\/+$/, '');
  const request = obj.request && obj.request.type && typeof obj.request.url === 'string'
    ? {
        type: String(obj.request.type),
        url: obj.request.url,
        username: obj.request.username,
        apiKey: obj.request.apiKey,
        apiKeyEnc: obj.request.apiKeyEnc,
        authToken: obj.request.authToken,
        authTokenEnc: obj.request.authTokenEnc,
      }
    : undefined;
  if (obj.jellyfinApiKey) {
    const host = { jellyfinUrl, jellyfinApiKey: obj.jellyfinApiKey };
    if (request) host.request = request;
    return host;
  }
  if (obj.accessToken && obj.userId) {
    const host = { jellyfinUrl, accessToken: obj.accessToken, userId: obj.userId, username: obj.username, encPw: obj.encPw || null };
    if (request) host.request = request;
    return host;
  }
  return null;
}

function decodeToken(token) {
  const attempts = [];
  try {
    attempts.push(JSON.parse(Buffer.from(token, 'base64url').toString('utf8')));
  } catch {}
  try {
    attempts.push(JSON.parse(token));
  } catch {}
  for (const obj of attempts) {
    if (!obj || typeof obj !== 'object') continue;
    const catalogs = obj.catalogs && typeof obj.catalogs === 'object' ? obj.catalogs : undefined;
    if (Array.isArray(obj.hosts)) {
      const hosts = obj.hosts.map(decodeHost).filter(Boolean);
      if (hosts.length) return catalogs ? { hosts, catalogs } : { hosts };
      continue;
    }
    const single = decodeHost(obj);
    if (single) return catalogs ? { ...single, catalogs } : single;
  }
  return null;
}

function isConfigured(c) {
  if (Array.isArray(c.hosts)) return c.hosts.length > 0 && c.hosts.every((h) => isConfigured(h));
  return (
    (c.jellyfinUrl && c.jellyfinApiKey && !isPlaceholder(c.jellyfinUrl + c.jellyfinApiKey)) ||
    (c.jellyfinUrl && c.accessToken && c.userId)
  );
}

// ---------------------------------------------------------------------------
// Persisted configs (a small saved list so the web page can re-show URLs).
// Configs are also fully reconstructible from their token, so this list is
// just a convenience for the manage page.
// ---------------------------------------------------------------------------

function loadConfigs() {
  const out = [];
  const push = (c) => {
    if (!isConfigured(c)) return;
    const token = tokenFor(c);
    if (!out.some((x) => x.token === token)) out.push({ ...c, token });
  };
  if (fileConfig.jellyfinUrl && fileConfig.jellyfinApiKey) {
    push({ name: 'My Jellyfin', jellyfinUrl: fileConfig.jellyfinUrl, jellyfinApiKey: fileConfig.jellyfinApiKey });
  }
  for (const inst of Array.isArray(fileConfig.instances) ? fileConfig.instances : []) {
    push({ name: inst.name, jellyfinUrl: inst.jellyfinUrl, jellyfinApiKey: inst.jellyfinApiKey, legacyId: inst.id });
  }
  for (const s of Array.isArray(fileConfig.savedConfigs) ? fileConfig.savedConfigs : []) {
    if (Array.isArray(s.hosts)) {
      push({ name: s.name, hosts: s.hosts, catalogs: s.catalogs });
    } else if (s.accessToken) {
      push({ name: s.name, jellyfinUrl: s.jellyfinUrl, accessToken: s.accessToken, userId: s.userId, username: s.username, encPw: s.encPw, request: s.request, catalogs: s.catalogs });
    } else {
      push({ name: s.name, jellyfinUrl: s.jellyfinUrl, jellyfinApiKey: s.jellyfinApiKey, legacyId: s.legacyId, request: s.request, catalogs: s.catalogs });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Setup storage (sqlite preferred, config.json fallback) + one-time migration
// ---------------------------------------------------------------------------

const store = createStore(configPath);

function getServerSecret() {
  const existing = store.getSecret() || fileConfig.serverSecret;
  if (existing) return existing;
  if (MANAGE_KEY) {
    return Buffer.from(crypto.createHash('sha256').update(String(MANAGE_KEY)).digest('hex').slice(0, 32)).toString('base64url');
  }
  const secret = crypto.randomBytes(32).toString('base64url');
  try { store.setSecret(secret); } catch {}
  return secret;
}

function persistHostRequest(h) {
  if (!h.request || !h.request.type || !h.request.url) return undefined;
  const apiKeyEnc = h.request.apiKey ? encryptPassword(h.request.apiKey, getServerSecret()) : h.request.apiKeyEnc;
  const authTokenEnc = h.request.authToken ? encryptPassword(h.request.authToken, getServerSecret()) : h.request.authTokenEnc;
  const out = { type: h.request.type, url: h.request.url };
  if (h.request.username) out.username = h.request.username;
  if (apiKeyEnc) out.apiKeyEnc = apiKeyEnc;
  if (authTokenEnc) out.authTokenEnc = authTokenEnc;
  return out;
}

// Secrets are encrypted at rest before touching the database; the in-memory
// config keeps plaintext so JellyfinClient keeps working unchanged.
function hostForStorage(h) {
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined || v === null || k === 'name') continue;
    out[k] = v;
  }
  if (h.jellyfinApiKey && !h.__storedKeyEnc) out.jellyfinApiKeyEnc = encryptPassword(h.jellyfinApiKey, getServerSecret());
  delete out.jellyfinApiKey;
  const request = h.request && persistHostRequest(h);
  delete out.request;
  if (request) out.request = request;
  return out;
}

function normalizeToHosts(cfg) {
  if (Array.isArray(cfg.hosts)) return cfg.hosts.map((h) => ({ ...h }));
  const single = {};
  for (const k of ['jellyfinUrl', 'jellyfinApiKey', 'accessToken', 'userId', 'username', 'encPw']) {
    if (cfg[k] !== undefined) single[k] = cfg[k];
  }
  if (cfg.request) single.request = cfg.request;
  return [single];
}

let configs = [];

function loadSetupsFromStore() {
  configs = [];
  byId.clear();
  for (const row of store.listSetups()) {
    const hosts = row.hosts.map((h) => {
      const copy = { ...h };
      if (!copy.jellyfinApiKey && copy.jellyfinApiKeyEnc) {
        try { copy.jellyfinApiKey = decryptPassword(copy.jellyfinApiKeyEnc, getServerSecret()); } catch {}
      }
      if (!copy.request) delete copy.request;
      return copy;
    });
    const cfg = { name: row.name || undefined, hosts, catalogs: row.catalogs || undefined, token: row.token, id: row.id };
    let entry;
    try {
      entry = ensureConfig(cfg);
    } catch (err) {
      console.error(`[store] failed to build setup ${row.id}:`, err.message);
      continue;
    }
    // The canonical entry token may differ from the stored one (legacy rows
    // migrated from a different token shape), so key on what was built.
    configs.push({ ...cfg, token: entry.token });
    byId.set(row.id, entry.token);
  }
}

function migrateLegacyFileSetups() {
  if (store.count() > 0 || !configs.length) return;
  for (const c of configs) {
    const token = tokenFor(c);
    try {
      store.saveSetup({
        token,
        name: c.name,
        hosts: normalizeToHosts(c).map(hostForStorage),
        catalogs: serializeCatalogs(c.catalogs),
      });
    } catch (err) {
      console.error('[migrate] failed to import a legacy setup:', err.message);
    }
  }
  console.log(`[migrate] imported ${configs.length} legacy setup(s) from ${configPath}`);
  // Strip the imported lists so the next boot cannot double-import.
  const cfg = loadConfigFile();
  if (cfg.savedConfigs || cfg.instances) {
    writeConfigFile({ ...cfg, savedConfigs: undefined, instances: undefined });
  }
}


// ---------------------------------------------------------------------------
// Addon builder
// ---------------------------------------------------------------------------

function mapMeta(item, type, img) {
  const meta = {
    id: item.Id,
    type,
    name: item.Name || item.OriginalTitle || 'Unknown',
    poster: img(item.Id, 'Primary'),
    background:
      item.BackdropImageTags && item.BackdropImageTags.length
        ? img(item.Id, 'Backdrop')
        : img(item.Id, 'Primary'),
    description: item.Overview,
  };
  if (item.Genres && item.Genres.length) meta.genres = item.Genres;
  if (item.ProductionYear) meta.releaseInfo = String(item.ProductionYear);
  if (item.RunTimeTicks) meta.runtime = Math.round(item.RunTimeTicks / 600000000);
  return meta;
}

function codecLabel(codec) {
  const map = {
    h264: 'H.264',
    h265: 'H.265',
    hevc: 'H.265',
    av1: 'AV1',
    vp9: 'VP9',
    mpeg2video: 'MPEG-2',
    mpeg4: 'MPEG-4',
    vc1: 'VC-1',
    aac: 'AAC',
    ac3: 'AC-3',
    eac3: 'E-AC-3',
    dts: 'DTS',
    dca: 'DTS',
    truehd: 'TrueHD',
    mp3: 'MP3',
    opus: 'Opus',
    flac: 'FLAC',
    pcm: 'PCM',
  };
  return (codec && map[String(codec).toLowerCase()]) || (codec ? String(codec).toUpperCase() : '');
}

function resolutionLabel(video) {
  const h = video && video.Height;
  if (!h) return '';
  if (h >= 2160) return '4K';
  if (h >= 1440) return '1440p';
  if (h >= 1080) return '1080p';
  if (h >= 720) return '720p';
  if (h >= 480) return '480p';
  return h + 'p';
}

function sizeLabel(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + ' GB';
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(0) + ' MB';
  return (bytes / 1024).toFixed(0) + ' KB';
}

function bitrateLabel(bps) {
  if (!Number.isFinite(bps) || bps <= 0) return '';
  return (bps / 1000000).toFixed(1) + ' Mbps';
}

function audioLabel(a) {
  const codec = codecLabel(a.Codec);
  const lang = a.Language ? a.Language.toUpperCase() : '';
  const ch = a.Channels ? (a.Channels > 2 ? a.Channels - 1 + '.1' : a.Channels + '.0') : '';
  return [lang, codec, ch].filter(Boolean).join(' ');
}

// Build a human-readable stream card from a Jellyfin MediaSource.
function streamCard(item, source) {
  if (!source || !Array.isArray(source.MediaStreams)) return null;
  const video = source.MediaStreams.find((s) => s.Type === 'Video');
  const audios = source.MediaStreams.filter((s) => s.Type === 'Audio');
  const subs = source.MediaStreams.filter((s) => s.Type === 'Subtitle' && !s.IsExternal);

  const movieName = item && (item.Name || item.OriginalTitle);
  const year = item && item.ProductionYear ? String(item.ProductionYear) : '';
  let name = movieName ? (year ? `${movieName} (${year})` : movieName) : null;

  // Episodes get a S01E01 label too (e.g. "Panchayat S01E01").
  const isEpisode = item && (item.Type === 'Episode' || (item.ParentIndexNumber && item.IndexNumber));
  if (isEpisode && movieName) {
    const season = item.ParentIndexNumber != null ? String(item.ParentIndexNumber).padStart(2, '0') : '';
    const episode = item.IndexNumber != null ? String(item.IndexNumber).padStart(2, '0') : '';
    name = `${movieName} S${season}E${episode}`;
  }

  const base = [
    name,
    resolutionLabel(video),
    codecLabel(video && video.Codec),
    source.Container ? String(source.Container).toUpperCase() : '',
    sizeLabel(source.Size),
  ].filter(Boolean);

  const audioLine = audios.map(audioLabel).filter(Boolean).join(', ');
  const subLine = subs.map((s) => (s.Language || s.Codec || 'sub').toUpperCase()).join(', ');
  const fileLine = source.Name ? 'File: ' + source.Name : '';

  return {
    title: base.join(' • '),
    description: [
      audioLine ? 'Audio: ' + audioLine : '',
      bitrateLabel(source.Bitrate) ? 'Bitrate: ' + bitrateLabel(source.Bitrate) : '',
      subLine ? 'Subtitles: ' + subLine : '',
      fileLine,
    ].filter(Boolean).join('\n'),
  };
}

// Build one addon for one or more Jellyfin instances. Merged configs pass
// `hosts`; single-host configs normalize to a one-element list. `token` is
// the URL-safe id used for images; `stubId` is a stable hash so the manifest
// id never changes for the same credentials.
function buildAddon({ hosts, jellyfinUrl, jellyfinApiKey, accessToken, userId, username, encPw, catalogs, name, token, stubId, legacyId }) {
  const hostConfigs = Array.isArray(hosts) && hosts.length
    ? hosts
    : [{ jellyfinUrl, jellyfinApiKey, accessToken, userId, username, encPw }];
  const clients = hostConfigs.map((cfg) => {
    const c = new JellyfinClient({ baseUrl: cfg.jellyfinUrl, apiKey: cfg.jellyfinApiKey, accessToken: cfg.accessToken, userId: cfg.userId, encPw: cfg.encPw, username: cfg.username, streamMode: STREAM_MODE });
    // Inject the decryptor so the client can auto-renew an expired AccessToken
    // on 401 (see JellyfinClient.get). Keeps the server secret out of src/.
    if (cfg.encPw) c._decrypt = (enc) => decryptPassword(enc, getServerSecret());
    return { cfg, client: c };
  });
  const primary = clients[0].client;
  const requestHosts = hostConfigs.filter((h) => h.request && h.request.type && h.request.url);
  const catalogToggles = {
    movies: !catalogs || catalogs.movies !== false,
    series: !catalogs || catalogs.series !== false,
    genre: !catalogs || catalogs.genre !== false,
  };
  // Poster/backdrop URLs must be ABSOLUTE — several Stremio/Nuvio clients do
  // not resolve relative /img/... paths against the addon origin.
  const img = (itemId, type) => `${publicBase()}/img/${token}/${itemId}/${type}`;

  const manifest = {
    id: `community.nuvio-jellyfin.${stubId}`,
    version: '1.0.0',
    name: name ? `Jellyfin: ${name}` : 'Jellyfin',
    description:
      hostConfigs.length > 1
        ? `Movies and TV shows from ${hostConfigs.length} Jellyfin servers`
        : `Movies and TV shows from ${hostConfigs[0].jellyfinUrl}`,
    resources: ['catalog', 'meta', 'stream'],
    types: ['movie', 'series'],
    catalogs: [
      ...(catalogToggles.movies ? [{ type: 'movie', id: 'jfmovies', name: 'Jellyfin Movies' }] : []),
      ...(catalogToggles.series ? [{ type: 'series', id: 'jfshows', name: 'Jellyfin Shows' }] : []),
      ...(catalogToggles.genre ? [{ type: 'genre', id: 'jfgenres', name: 'Jellyfin Genres' }] : []),
    ],
    config: [
      { key: 'jellyfinUrl', type: 'text', title: 'Jellyfin instance URL' },
      { key: 'jellyfinApiKey', type: 'password', title: 'Jellyfin API key' },
    ],
    behaviorHints: { configurable: true },
  };

  const addon = new addonBuilder(manifest);

  addon.defineCatalogHandler(async (args) => {
    try {
      const extra = args.extra || {};
      if (args.type === 'genre') {
        const perHost = await Promise.all(clients.map(({ client }) => client.genres().catch(() => [])));
        const seen = new Set();
        const metas = [];
        for (const g of perHost.flat()) {
          if (!g || !g.Name || seen.has(g.Name)) continue;
          seen.add(g.Name);
          metas.push({ id: g.Id, type: 'genre', name: g.Name });
        }
        return { metas, cacheMaxAge: 3600 };
      }

      let genre = extra.genre;
      if (!genre) {
        const key = Object.keys(extra).find((k) => !['skip', 'limit', 'search'].includes(k));
        genre = key ? decodeURIComponent(key) : undefined;
      }

      const isSearch = !!extra.search;
      const start = Number(extra.skip) || 0;
      const limit = Number(extra.limit) || PAGE_SIZE;
      // Fetch enough from every host to cover the requested window of the
      // merged list, then slice — keeps pagination stable across pages even
      // when hosts have different library sizes.
      const perHost = await Promise.all(
        clients.map(({ client }) =>
          client
            .getItems({
              type: args.type === 'movie' ? 'Movie' : 'Series',
              startIndex: 0,
              limit: start + limit,
              genre,
              search: extra.search,
            })
            .catch((err) => {
              console.error(`[catalog:${stubId}]`, err.message);
              return [];
            })
        )
      );
      const items = perHost.flat().slice(start, start + limit);
      return {
        metas: items.map((item) => mapMeta(item, args.type, img)),
        cacheMaxAge: isSearch ? 0 : 60,
        staleRevalidate: isSearch ? 0 : 3600,
        staleError: isSearch ? 0 : 60,
      };
    } catch (err) {
      console.error(`[catalog:${stubId}]`, err.message);
      return { metas: [] };
    }
  });

  addon.defineMetaHandler(async (args) => {
    const { id, type } = args;
    for (const { client } of clients) {
      let item;
      try {
        item = await client.resolveItem(id, type);
      } catch (err) {
        console.error(`[meta:${stubId}]`, err.message);
        continue;
      }
      try {
        if (type === 'series' || type === 'episode') {
          const episodes = await client.episodes(item.Id);
          const meta = mapMeta(item, 'series', img);
          meta.videos = episodes
            .filter((ep) => ep.Id !== item.Id)
            .map((ep) => ({
              id: ep.Id,
              title: ep.Name,
              season: ep.ParentIndexNumber || 1,
              episode: ep.IndexNumber || 1,
              overview: ep.Overview,
              released: ep.PremiereDate ? new Date(ep.PremiereDate).toISOString().slice(0, 10) : undefined,
            }));
          return { meta, cacheMaxAge: 3600 };
        }
        return { meta: mapMeta(item, 'movie', img), cacheMaxAge: 3600 };
      } catch (err) {
        console.error(`[meta:${stubId}]`, err.message);
      }
    }
    return { meta: { id, type, name: 'Item not found on Jellyfin' } };
  });

  addon.defineStreamHandler(async (args) => {
    const { id, type } = args;
    let fallback;
    for (const { client } of clients) {
      let item;
      try {
        if ((type === 'series' || type === 'episode') && id.includes(':')) {
          const [seriesRef, season, episode] = id.split(':');
          const series = await client.resolveItem(seriesRef, 'series');
          const episodes = await client.episodes(series.Id, Number(season) || undefined);
          item =
            episodes.filter((ep) => ep.Id !== series.Id).find((ep) => ep.IndexNumber === Number(episode)) ||
            episodes.filter((ep) => ep.Id !== series.Id)[0] ||
            series;
        } else {
          item = await client.resolveItem(id, type);
        }
      } catch (err) {
        console.error(`[stream:${stubId}]`, err.message);
        continue;
      }
      const source = item.MediaSources && item.MediaSources[0];
      if (!source) {
        if (!fallback) fallback = { item, client };
        continue;
      }
      return { streams: [buildStream(item, source, client)], cacheMaxAge: 0 };
    }
    if (fallback) return { streams: [buildStream(fallback.item, null, fallback.client)], cacheMaxAge: 0 };
    // Item exists on no host: offer media-request placeholders (Jellyseerr /
    // Overseerr / Ombi) so playing one fires the request server-side.
    const requestStreams = requestHosts.map((h) => ({
      name: `📥 Request via ${h.request.type}`,
      title: `📥 Request via ${h.request.type}`,
      url: `${publicBase()}/r/${token}/${type}/${encodeURIComponent(id)}`,
      description: 'Plays a short silent placeholder while your request is submitted in the background.',
    }));
    return { streams: requestStreams, cacheMaxAge: 0 };
  });

  function buildStream(item, source, client) {
    const card = streamCard(item, source);
    const stream = {
      name: (card && card.title) || (STREAM_MODE === 'auto' ? 'Jellyfin (auto)' : 'Jellyfin'),
      url: process.env.PROXY_STREAMS === '1'
        ? `${publicBase()}/p/${token}/${item.Id}`
        : client.streamUrl(item.Id),
    };
    if (card) stream.description = card.description;
    return stream;
  }

  return {
    clients,
    client: primary,
    requestHosts,
    router: getRouter(addon.getInterface()),
    token,
    legacyId,
    name,
    jellyfinApiKey: hostConfigs[0].jellyfinApiKey,
  };
}

// Resolve a token (or legacy instance id) to a built addon entry.
const byToken = new Map();
const byLegacy = new Map();
const byId = new Map();

function stubIdFor(token) {
  return crypto.createHash('sha1').update(token).digest('hex').slice(0, 10);
}

function ensureConfig(config, legacyId) {
  const token = tokenFor(config);
  let entry = byToken.get(token);
  if (!entry) {
    entry = buildAddon({ ...config, token, stubId: stubIdFor(token), legacyId });
    byToken.set(token, entry);
  }
  if (legacyId) byLegacy.set(legacyId, entry);
  return entry;
}

function rebuild() {
  byToken.clear();
  byLegacy.clear();
  for (const c of configs) {
    try {
      ensureConfig(c, c.legacyId);
    } catch (err) {
      console.error(`[config] failed to build:`, err.message);
    }
  }
}

function findEntry(value) {
  const mapped = byId.get(value);
  if (mapped) return byToken.get(mapped);
  return byToken.get(value) || byLegacy.get(value) || (() => {
    const cfg = decodeToken(value);
    return cfg ? ensureConfig(cfg) : null;
  })();
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

// Track the most recent public origin so catalog/meta payloads can build
// absolute image URLs without per-request context inside the SDK handlers.
let latestPublicBase = null;
function publicBase() {
  return process.env.ADDON_BASE_URL || latestPublicBase || `http://localhost:${PORT}`;
}

app.use((req, res, next) => {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (host) latestPublicBase = `${proto}://${host}`;
  next();
});

// Request log so we can see exactly what Nuvio/Stremio is asking for.
app.use((req, res, next) => {
  console.log(`[req] ${req.method} ${req.path}`);
  next();
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-cache');
  } else if (CACHE_TTL && !res.getHeader('Cache-Control')) {
    res.setHeader('Cache-Control', `max-age=${CACHE_TTL}, public`);
  }
  next();
});

const baseUrl = (req) => `http://${req.headers.host}`;
const tokenInstallUrl = (req, token) => `${baseUrl(req)}/${token}/manifest.json`;
const legacyInstallUrl = (req, id) => `${baseUrl(req)}/i/${id}/manifest.json`;

async function checkClient(client) {
  try {
    const version = await client.ping();
    return { ok: true, version };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function allStatus(req) {
  const seen = new Set();
  const list = [];
  for (const cfg of configs) {
    if (seen.has(cfg.token)) continue;
    seen.add(cfg.token);
    const entry = ensureConfig(cfg);
    const status = await statusOfToken(req, cfg.token, entry, cfg);
    status.id = cfg.id;
    status.shortInstallUrl = cfg.id ? `${baseUrl(req)}/s/${cfg.id}/manifest.json` : null;
    list.push(status);
  }
  return list;
}

async function statusOfToken(req, token, entry, saved) {
  const clients = (entry && entry.clients) || [];
  const primary = clients[0] ? clients[0].client : null;
  const jellyfin = await checkClient(primary);
  const username = (saved && saved.username) || (primary && primary.username) || null;
  return {
    token,
    name: (saved && saved.name) || (entry && entry.name) || 'Jellyfin',
    url: primary ? primary.baseUrl : null,
    keySet: !!(entry && entry.jellyfinApiKey),
    authMode: username ? 'user' : 'apikey',
    username,
    hostCount: clients.length || undefined,
    hosts: clients.length > 1 ? clients.map(({ client }) => ({ url: client.baseUrl })) : undefined,
    jellyfin,
    installUrl: tokenInstallUrl(req, token),
    legacyInstallUrl: entry && entry.legacyId ? legacyInstallUrl(req, entry.legacyId) : null,
  };
}

// ---------------------------------------------------------------------------
// Manage auth: password login sets an HttpOnly cookie; the key never needs to
// stay in the URL. MANAGE_KEY (env or config.json) is the password.
// ---------------------------------------------------------------------------

const MANAGE_COOKIE = 'nuviojf_manage';
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function keyMatches(given) {
  const a = sha256(given);
  const b = sha256(MANAGE_KEY);
  return a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function manageSessionValid(req) {
  if (!MANAGE_KEY) return true;
  const cookies = String(req.headers.cookie || '').split(';').map((c) => c.trim());
  const hit = cookies.find((c) => c.startsWith(MANAGE_COOKIE + '='));
  if (!hit) return false;
  const supplied = hit.slice(MANAGE_COOKIE.length + 1);
  const expected = sha256(MANAGE_KEY);
  return supplied.length === expected.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

const loginPage = (msg) =>
  '<!DOCTYPE html><html><body style="background:#0f1115;color:#e8eaf0;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh">' +
  '<form id="f" style="background:#171a21;border:1px solid #2a2f3a;border-radius:12px;padding:24px;width:320px" onsubmit="event.preventDefault();fetch(\'/api/login\',{method:\'POST\',headers:{\'Content-Type\':\'application/json\'},body:JSON.stringify({key:document.getElementById(\'k\').value})}).then(r=>r.status===200?(location.href=\'/manage\'):(document.getElementById(\'e\').textContent=\'Wrong key\'))">' +
  '<h2 style="margin:0 0 16px;font-size:18px">Manage page locked</h2>' +
  '<p style="color:#9aa3b2;font-size:13px;margin:0 0 14px">This server protects its setup list. Enter the manage key.</p>' +
  '<input id="k" type="password" placeholder="Manage key" style="width:100%;padding:10px;border-radius:8px;border:1px solid #2a2f3a;background:#1e222b;color:#e8eaf0;box-sizing:border-box" autofocus>' +
  '<button style="margin-top:12px;width:100%;padding:10px;border:none;border-radius:8px;background:linear-gradient(135deg,#00a4dc,#0abf6e);color:#04121a;font-weight:700;cursor:pointer">Unlock</button>' +
  '<p id="e" style="color:#e5484d;font-size:13px;margin:10px 0 0;min-height:16px">' + (msg || '') + '</p>' +
  '</form></body></html>';

function manageGate(req, res, next) {
  if (!MANAGE_KEY) return next();
  if (manageSessionValid(req)) return next();
  if (req.path === '/manage') {
    return res.status(401).send(loginPage());
  }
  return res.status(401).json({ ok: false, error: 'Manage key required' });
}

// POST /api/login { key } -> sets an HttpOnly session cookie on success.
app.post('/api/login', (req, res) => {
  if (!MANAGE_KEY) return res.json({ ok: true });
  if (keyMatches(req.body && req.body.key)) {
    res.setHeader('Set-Cookie', `${MANAGE_COOKIE}=${sha256(MANAGE_KEY)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`);
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: 'Wrong key' });
});

// POST /api/logout -> clears the session cookie.
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${MANAGE_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

// Two auth modes:
//  - { jellyfinUrl, username, password }  -> user mode (AccessToken via AuthenticateByName)
//  - { jellyfinUrl, jellyfinApiKey }      -> API key mode (legacy, unchanged)
function validateCredentials(body) {
  if (Array.isArray(body.hosts)) {
    if (!body.hosts.length) return { error: 'At least one Jellyfin host required' };
    const hosts = [];
    for (const h of body.hosts) {
      const valid = validateCredentials(h || {});
      if (valid.error) return valid;
      hosts.push(valid);
    }
    return { hosts };
  }
  const jellyfinUrl = String(body.jellyfinUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(jellyfinUrl)) return { error: 'Jellyfin URL must start with http:// or https://' };
  if (body.username !== undefined) {
    const username = String(body.username || '').trim();
    if (!username) return { error: 'Username required' };
    if (username.includes(':')) return { error: 'Username cannot contain colon' };
    return { jellyfinUrl, username, password: String(body.password || '') };
  }
  const jellyfinApiKey = String(body.jellyfinApiKey || '').trim();
  if (!jellyfinApiKey) return { error: 'API key or username required' };
  return { jellyfinUrl, jellyfinApiKey };
}

// Test credentials without storing them (used by the public /configure page).
app.post('/api/check', async (req, res) => {
  const valid = validateCredentials(req.body || {});
  if (valid.error) return res.status(400).json({ ok: false, error: valid.error });
  if (valid.hosts) return res.status(400).json({ ok: false, error: 'Merged hosts check not yet supported via API; generate token directly via base64url({hosts:[...]})' });
  try {
    if (valid.username !== undefined) {
      const auth = await JellyfinClient.authenticate(valid.jellyfinUrl, valid.username, valid.password);
      const client = new JellyfinClient({ baseUrl: valid.jellyfinUrl, accessToken: auth.accessToken, userId: auth.userId, streamMode: STREAM_MODE });
      const result = await checkClient(client);
      return res.json({ ok: result.ok, version: result.version, error: result.error, accessToken: auth.accessToken, userId: auth.userId, username: auth.username });
    }
    const client = new JellyfinClient({ baseUrl: valid.jellyfinUrl, apiKey: valid.jellyfinApiKey, streamMode: STREAM_MODE });
    const result = await checkClient(client);
    return res.json({ ok: result.ok, version: result.version, error: result.error });
  } catch (e) {
    return res.json({ ok: false, error: e.message });
  }
});

app.get('/api/status', manageGate, async (req, res) => {
  res.json({ port: PORT, streamMode: STREAM_MODE, envOverrides, configs: await allStatus(req) });
});

// Per-user status: only this token's own details. Used by the per-user page.
app.get('/api/status/:token', async (req, res) => {
  const entry = findEntry(req.params.token);
  if (!entry) return res.status(404).json({ ok: false, error: 'Not found' });
  const saved = configs.find((c) => c.token === entry.token);
  const status = await statusOfToken(req, entry.token, entry, saved);
  status.id = saved ? saved.id : null;
  status.shortInstallUrl = status.id ? `${baseUrl(req)}/s/${status.id}/manifest.json` : null;
  res.json({ config: status });
});

// Shared minting logic for the manage API and the public configure page.
async function mintSetup(req, res, valid, name, { capped }) {
  if (capped && store.count() >= Number(process.env.MAX_PUBLIC_SETUPS || 500)) {
    return res.status(429).json({ ok: false, error: 'This instance has reached its setup limit' });
  }
  const hosts = [];
  for (const v of valid.hosts || [valid]) {
    if (v.username !== undefined) {
      let auth;
      try {
        auth = await JellyfinClient.authenticate(v.jellyfinUrl, v.username, v.password);
      } catch (e) {
        return res.json({ ok: false, error: e.message });
      }
      const host = { jellyfinUrl: v.jellyfinUrl, accessToken: auth.accessToken, userId: auth.userId, username: auth.username };
      if (v.password) host.encPw = encryptPassword(v.password, getServerSecret());
      hosts.push(host);
    } else {
      hosts.push({ jellyfinUrl: v.jellyfinUrl, jellyfinApiKey: v.jellyfinApiKey });
    }
  }
  const catalogs = serializeCatalogs((req.body && req.body.catalogs) || undefined);
  const cfg = { name, hosts, ...(catalogs ? { catalogs } : {}) };
  const token = tokenFor(cfg);
  ensureConfig({ ...cfg, token });

  let saved;
  try {
    saved = store.saveSetup({ token, name, hosts: hosts.map(hostForStorage), catalogs });
  } catch (e) {
    return res.status(500).json({ ok: false, error: `failed to persist setup: ${e.message}` });
  }
  loadSetupsFromStore();

  const entry = findEntry(saved.id);
  const jellyfin = await checkClient(entry.clients[0].client);
  res.json({
    ok: true,
    id: saved.id,
    created: saved.created,
    token,
    name,
    url: entry.clients[0].client.baseUrl,
    jellyfin,
    installUrl: `${baseUrl(req)}/s/${saved.id}/manifest.json`,
    tokenUrl: tokenInstallUrl(req, token),
  });
}

// Public: anyone can mint a setup for their own Jellyfin (rate-limited by cap).
app.post('/api/setups', async (req, res) => {
  const valid = validateCredentials(req.body || {});
  if (valid.error) return res.status(400).json({ ok: false, error: valid.error });
  const name = String((req.body && req.body.name) || '').trim().slice(0, 40) || 'Jellyfin';
  await mintSetup(req, res, valid, name, { capped: true });
});

app.post('/api/configs', manageGate, async (req, res) => {
  const valid = validateCredentials(req.body || {});
  if (valid.error) return res.status(400).json({ ok: false, error: valid.error });
  const name = String((req.body && req.body.name) || '').trim().slice(0, 40) || 'Jellyfin';
  await mintSetup(req, res, valid, name, { capped: false });
});

app.put('/api/configs/:key', manageGate, async (req, res) => {
  const key = req.params.key;
  const idx = configs.findIndex((c) => c.token === key || c.id === key);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Config not found' });

  const valid = validateCredentials(req.body || {});
  if (valid.error) return res.status(400).json({ ok: false, error: valid.error });
  if (valid.hosts) return res.status(400).json({ ok: false, error: 'Merged hosts cannot be edited via PUT; delete and re-add' });
  if (valid.username !== undefined) return res.status(400).json({ ok: false, error: 'Username/password setups cannot be edited here; delete and re-add via POST /api/configs' });

  const old = configs[idx];
  const name = String((req.body.name !== undefined && req.body.name) || old.name || '').trim().slice(0, 40) || 'Jellyfin';
  const cfg = { name, hosts: [{ jellyfinUrl: valid.jellyfinUrl, jellyfinApiKey: valid.jellyfinApiKey }] };
  const token = tokenFor(cfg);
  try {
    store.deleteSetup(old.id);
    store.saveSetup({ token, name, hosts: cfg.hosts.map(hostForStorage), catalogs: serializeCatalogs(old.catalogs) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: `failed to update setup: ${e.message}` });
  }
  loadSetupsFromStore();

  const entry = findEntry(token);
  const jellyfin = await checkClient(entry.clients[0].client);
  res.json({ ok: true, id: store.getByToken(token), token, name, url: entry.clients[0].client.baseUrl, jellyfin, installUrl: `${baseUrl(req)}/s/${store.getByToken(token)}/manifest.json` });
});

app.delete('/api/configs/:key', manageGate, async (req, res) => {
  const key = req.params.key;
  const id = byId.has(key) ? key : store.getByToken(key);
  if (!id || !byId.has(id)) return res.status(404).json({ ok: false, error: 'Config not found' });
  store.deleteSetup(id);
  loadSetupsFromStore();
  res.json({ ok: true });
});

// Legacy single-config alias.
app.post('/api/config', manageGate, (req, res) => {
  res.status(410).json({ ok: false, error: 'Deprecated; use POST /api/configs or POST /api/setups' });
});

// Exchange request-app credentials for a session token without storing the
// password — mirrors the Jellyfin /Users/AuthenticateByName flow.
app.post('/api/check-request', async (req, res) => {
  const body = req.body || {};
  const type = String(body.type || '');
  const url = String(body.url || '').trim().replace(/\/+$/, '');
  const username = String(body.username || '').trim();
  if (!['jellyseerr', 'overseerr', 'ombi'].includes(type)) return res.status(400).json({ ok: false, error: 'Unsupported request service' });
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ ok: false, error: 'Request app URL must start with http:// or https://' });
  if (!username) return res.status(400).json({ ok: false, error: 'Username required' });
  try {
    const auth = await loginRequestApp({ type, url, username, password: String(body.password || '') });
    res.json({ ok: true, authToken: auth.authToken, username: auth.username });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get('/health', async (req, res) => {
  const list = await allStatus(req);
  const allUp = list.length > 0 && list.every((i) => i.jellyfin.ok);
  res.status(allUp ? 200 : 503).json({ ok: allUp, configs: list });
});

// Placeholder "file" played when a user picks a request stream. The GET is the
// side-effect trigger: it submits the request to every configured service, then
// returns one second of silent WAV so players end cleanly instead of erroring.
function silenceWav() {
  const sampleRate = 8000;
  const seconds = 1;
  const data = Buffer.alloc(sampleRate * seconds * 2);
  const buf = Buffer.alloc(44 + data.length);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + data.length, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(data.length, 40);
  data.copy(buf, 44);
  return buf;
}
const PLACEHOLDER_WAV = silenceWav();

async function decryptSecret(value, enc) {
  if (value) return value;
  if (enc) return decryptPassword(enc, getServerSecret());
  return null;
}

app.get('/r/:token/:type/:id', async (req, res) => {
  const entry = findEntry(req.params.token);
  if (!entry || !(entry.requestHosts || []).length) {
    res.setHeader('Content-Type', 'audio/wav');
    return res.status(404).send(PLACEHOLDER_WAV);
  }
  const type = req.params.type === 'series' ? 'series' : 'movie';
  let imdbId = decodeURIComponent(req.params.id);
  if (type === 'series' && imdbId.includes(':')) [imdbId] = imdbId.split(':');
  const results = [];
  for (const host of entry.requestHosts) {
    try {
      const apiKey = await decryptSecret(host.request.apiKey, host.request.apiKeyEnc);
      const authToken = await decryptSecret(host.request.authToken, host.request.authTokenEnc);
      const ext = await resolveExternalIds(imdbId, type);
      const outcome = await submitRequest({ ...host.request, apiKey, authToken }, type, { ...ext, imdbId });
      results.push({ service: host.request.type, user: host.request.username, ok: outcome.ok, duplicate: !!outcome.duplicate, status: outcome.status, error: outcome.error });
    } catch (err) {
      results.push({ service: host.request.type, ok: false, error: err.message });
    }
  }
  console.log(`[request] ${imdbId} (${type}) ->`, JSON.stringify(results));
  res.setHeader('X-Request-Results', Buffer.from(JSON.stringify(results)).toString('base64'));
  res.setHeader('Content-Type', 'audio/wav');
  res.status(200).send(PLACEHOLDER_WAV);
});

// Image proxy. Metas reference /img/<token>/<itemId>/<type>. With merged
// hosts the item may live on any server, so try each client until one has it.
app.get('/img/:token/:itemId/:type', async (req, res) => {
  const entry = findEntry(req.params.token, 'img');
  if (!entry) return res.status(404).end();
  for (const { client } of entry.clients || []) {
    try {
      const upstream = await client.image(req.params.itemId, req.params.type);
      if (!upstream.ok) continue;
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      Readable.fromWeb(upstream.body).pipe(res);
      return;
    } catch {
      // try the next host
    }
  }
  res.status(404).end();
});

// Legacy /i/<id>/... URLs (kept so older installs still work).
app.use('/i/:legacyId', (req, res, next) => {
  const entry = byLegacy.get(req.params.legacyId);
  if (!entry) return next();
  return entry.router(req, res, next);
});

// Short-ID install URLs: /s/<id>/... — the URL carries no credentials at all;
// hosts/tokens live only in the setup store. Registered above /:token so 's'
// is never mistaken for a token segment.
function resolveSid(sid) {
  const token = byId.get(sid);
  return token ? byToken.get(token) : null;
}

app.get(['/s/:sid/configure', '/s/:sid/configure/'], (req, res) => {
  if (!resolveSid(req.params.sid)) return res.redirect('/configure');
  res.redirect(`/configure?sid=${encodeURIComponent(req.params.sid)}`);
});

app.get('/s/:sid', (req, res, next) => {
  if (!resolveSid(req.params.sid)) return next();
  res.sendFile(path.join(__dirname, 'public', 'user.html'));
});

app.use('/s/:sid', (req, res, next) => {
  const entry = resolveSid(req.params.sid);
  if (!entry) return next();
  return entry.router(req, res, next);
});

// Optional full host-hiding: when PROXY_STREAMS=1, stream URLs point back at
// this addon and media bytes are relayed server-side so clients never see the
// Jellyfin origin (at the cost of addon bandwidth).
app.get('/p/:token/:itemId', async (req, res) => {
  const entry = findEntry(req.params.token);
  if (!entry) return res.status(404).end();
  for (const { client } of entry.clients || []) {
    try {
      const upstream = await fetch(client.streamUrl(req.params.itemId), {
        headers: { ...(req.headers.range ? { Range: req.headers.range } : {}) },
      });
      if (!upstream.ok && upstream.status !== 206) continue;
      for (const h of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges']) {
        const v = upstream.headers.get(h);
        if (v) res.setHeader(h, v);
      }
      res.status(upstream.status);
      Readable.fromWeb(upstream.body).pipe(res);
      return;
    } catch {
      // try the next host
    }
  }
  res.status(404).end();
});

// Public configure page: lets each visitor add THEIR OWN Jellyfin server and
// get a private install link. Nothing about the host's setups is exposed here.
app.get('/configure', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'configure.html'));
});

// Manage page (owner only). The list of all setups lives here — every other
// entry point is per-user and shows nothing about the other setups.
app.get('/manage', manageGate, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// /<token>/configure prefills the configure page from an existing install
// link. Must stay above the generic /:token routes so the addon router
// never claims the /configure suffix.
app.get(['/:token/configure', '/:token/configure/'], (req, res) => {
  const entry = findEntry(req.params.token);
  if (!entry) return res.redirect('/configure');
  res.redirect(`/configure?token=${encodeURIComponent(req.params.token)}`);
});

// Per-user front page: /<token> shows ONLY that setup's details.
app.get('/:token', (req, res, next) => {
  const entry = findEntry(req.params.token);
  if (!entry) return next();
  res.sendFile(path.join(__dirname, 'public', 'user.html'));
});

// The Torrentify-style config URLs: /<token>/manifest.json, /<token>/catalog/...
app.use('/:token', (req, res, next) => {
  if (['img', 'i', 'api', 'health', 'manifest', 'configure'].includes(req.params.token)) return next();
  const entry = findEntry(req.params.token);
  if (!entry) return next();
  return entry.router(req, res, next);
});

// Neutral landing: points visitors to the configure flow, leaks nothing.
app.get('/', (req, res) => {
  res.redirect('/configure');
});

configs = loadConfigs();
migrateLegacyFileSetups();
loadSetupsFromStore();
rebuild();
app.listen(PORT, () => {
  console.log(`Addon running: http://localhost:${PORT} — manage page: http://localhost:${PORT}/manage`);
  console.log(`[store] mode=${store.mode} setups=${store.count()}`);
  for (const c of configs) {
    const short = c.id ? `${PORT}/s/${c.id}/manifest.json` : '(no id)';
    console.log(`  "${c.name || 'Jellyfin'}": /s/${c.id}/manifest.json (token: /${c.token.slice(0, 12)}…/manifest.json)`);
  }
  for (const entry of byToken.values()) {
    for (const { client } of entry.clients || []) {
      client.resolveUser().catch(() => {});
    }
  }
});