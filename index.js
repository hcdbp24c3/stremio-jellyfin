'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Readable } = require('stream');
const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const { JellyfinClient } = require('./src/jellyfin');

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
// install URL. The secret is generated once and persisted in config.json.
// ---------------------------------------------------------------------------

// Server secret for AES-GCM password encryption — generated once, persisted
// in config.json so encrypted values survive restarts.
function getServerSecret() {
  const cfg = loadConfigFile();
  if (cfg.serverSecret) return cfg.serverSecret;
  if (MANAGE_KEY) {
    // Deliberately not persisted: derived from MANAGE_KEY each boot so the
    // secret never lands on disk when a manage key is configured.
    const s = crypto.createHash('sha256').update(String(MANAGE_KEY)).digest('hex').slice(0, 32);
    return Buffer.from(s).toString('base64url');
  }
  const secret = crypto.randomBytes(32).toString('base64url');
  try { writeConfigFile({ ...cfg, serverSecret: secret }); } catch {}
  return secret;
}

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
function tokenFor(config) {
  if (Array.isArray(config.hosts)) {
    const hosts = config.hosts.map((h) => {
      if (h.accessToken) {
        const o = { jellyfinUrl: h.jellyfinUrl, accessToken: h.accessToken, userId: h.userId, username: h.username };
        if (h.encPw) o.encPw = h.encPw;
        return o;
      }
      return { jellyfinUrl: h.jellyfinUrl, jellyfinApiKey: h.jellyfinApiKey };
    });
    return Buffer.from(JSON.stringify({ hosts })).toString('base64url');
  }
  if (config.accessToken) {
    const obj = { jellyfinUrl: config.jellyfinUrl, accessToken: config.accessToken, userId: config.userId, username: config.username };
    if (config.encPw) obj.encPw = config.encPw;
    return Buffer.from(JSON.stringify(obj)).toString('base64url');
  }
  return Buffer.from(JSON.stringify({ jellyfinUrl: config.jellyfinUrl, jellyfinApiKey: config.jellyfinApiKey })).toString('base64url');
}

// Validate + normalize one host object (either token shape). Returns the
// normalized host or null when the shape is not a valid Jellyfin setup.
function decodeHost(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (typeof obj.jellyfinUrl !== 'string' || !/^https?:\/\//i.test(obj.jellyfinUrl)) return null;
  const jellyfinUrl = obj.jellyfinUrl.replace(/\/+$/, '');
  if (obj.jellyfinApiKey) return { jellyfinUrl, jellyfinApiKey: obj.jellyfinApiKey };
  if (obj.accessToken && obj.userId) {
    return { jellyfinUrl, accessToken: obj.accessToken, userId: obj.userId, username: obj.username, encPw: obj.encPw || null };
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
    if (Array.isArray(obj.hosts)) {
      const hosts = obj.hosts.map(decodeHost).filter(Boolean);
      if (hosts.length) return { hosts };
      continue;
    }
    const single = decodeHost(obj);
    if (single) return single;
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
      push({ name: s.name, hosts: s.hosts });
    } else if (s.accessToken) {
      push({ name: s.name, jellyfinUrl: s.jellyfinUrl, accessToken: s.accessToken, userId: s.userId, username: s.username, encPw: s.encPw });
    } else {
      push({ name: s.name, jellyfinUrl: s.jellyfinUrl, jellyfinApiKey: s.jellyfinApiKey, legacyId: s.legacyId });
    }
  }
  return out;
}

let configs = loadConfigs();

function persistConfigs() {
  const cfg = loadConfigFile();
  const next = {
    ...cfg,
    port: PORT,
    streamMode: STREAM_MODE,
    pageSize: PAGE_SIZE,
    cacheTtl: CACHE_TTL,
    instances: configs.filter((c) => c.legacyId).map((c) => ({ id: c.legacyId, name: c.name, jellyfinUrl: c.jellyfinUrl, jellyfinApiKey: c.jellyfinApiKey })),
    savedConfigs: configs.map((c) => {
      if (Array.isArray(c.hosts)) {
        return {
          name: c.name,
          hosts: c.hosts.map((h) =>
            h.accessToken
              ? { jellyfinUrl: h.jellyfinUrl, accessToken: h.accessToken, userId: h.userId, username: h.username, ...(h.encPw ? { encPw: h.encPw } : {}) }
              : { jellyfinUrl: h.jellyfinUrl, jellyfinApiKey: h.jellyfinApiKey }
          ),
        };
      }
      return c.accessToken
        ? { name: c.name, jellyfinUrl: c.jellyfinUrl, accessToken: c.accessToken, userId: c.userId, username: c.username, encPw: c.encPw }
        : { name: c.name, jellyfinUrl: c.jellyfinUrl, jellyfinApiKey: c.jellyfinApiKey };
    }),
  };
  // Persisting user credentials requires a stable secret so encPw stays
  // decryptable across restarts. With MANAGE_KEY set the secret is derived
  // per boot and deliberately kept off disk (see getServerSecret).
  if (!next.serverSecret && !MANAGE_KEY) next.serverSecret = getServerSecret();
  writeConfigFile(next);
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

// Build one addon for one Jellyfin instance. `token` is the URL-safe id used
// for images; `stubId` is a stable hash so the manifest id never changes for
// the same credentials.
function buildAddon({ jellyfinUrl, jellyfinApiKey, accessToken, userId, username, encPw, name, token, stubId, legacyId }) {
  const client = new JellyfinClient({ baseUrl: jellyfinUrl, apiKey: jellyfinApiKey, accessToken, userId, encPw, username, streamMode: STREAM_MODE });
  // Inject the decryptor so the client can auto-renew an expired AccessToken
  // on 401 (see JellyfinClient.get). Keeps the server secret out of src/.
  if (encPw) client._decrypt = (enc) => decryptPassword(enc, getServerSecret());
  const img = (itemId, type) => `/img/${token}/${itemId}/${type}`;

  const manifest = {
    id: `community.nuvio-jellyfin.${stubId}`,
    version: '1.0.0',
    name: name ? `Jellyfin: ${name}` : 'Jellyfin',
    description: `Movies and TV shows from ${jellyfinUrl}`,
    resources: ['catalog', 'meta', 'stream'],
    types: ['movie', 'series'],
    catalogs: [
      { type: 'movie', id: 'jfmovies', name: 'Jellyfin Movies' },
      { type: 'series', id: 'jfshows', name: 'Jellyfin Shows' },
      { type: 'genre', id: 'jfgenres', name: 'Jellyfin Genres' },
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
        const genres = await client.genres();
        return { metas: genres.map((g) => ({ id: g.Id, type: 'genre', name: g.Name })), cacheMaxAge: 3600 };
      }

      let genre = extra.genre;
      if (!genre) {
        const key = Object.keys(extra).find((k) => !['skip', 'limit', 'search'].includes(k));
        genre = key ? decodeURIComponent(key) : undefined;
      }

      const isSearch = !!extra.search;
      const items = await client.getItems({
        type: args.type === 'movie' ? 'Movie' : 'Series',
        startIndex: Number(extra.skip) || 0,
        limit: Number(extra.limit) || PAGE_SIZE,
        genre,
        search: extra.search,
      });
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
    try {
      const item = await client.resolveItem(id, type);
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
      return { meta: { id, type, name: 'Item not found on Jellyfin' } };
    }
  });

  addon.defineStreamHandler(async (args) => {
    const { id, type } = args;
    try {
      let item;
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
      const source = item.MediaSources && item.MediaSources[0];
      const card = streamCard(item, source);
      const stream = {
        name: (card && card.title) || (STREAM_MODE === 'auto' ? 'Jellyfin (auto)' : 'Jellyfin'),
        url: client.streamUrl(item.Id),
      };
      if (card) stream.description = card.description;
      return {
        streams: [stream],
        cacheMaxAge: 0,
      };
    } catch (err) {
      console.error(`[stream:${stubId}]`, err.message);
      return { streams: [], cacheMaxAge: 0 };
    }
  });

  return { client, router: getRouter(addon.getInterface()), token, legacyId, name, jellyfinApiKey };
}

// Resolve a token (or legacy instance id) to a built addon entry.
const byToken = new Map();
const byLegacy = new Map();

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
  for (const entry of byToken.values()) {
    const token = entry.token;
    if (seen.has(token)) continue;
    seen.add(token);
    const saved = configs.find((c) => c.token === token);
    list.push(await statusOfToken(req, token, entry, saved));
  }
  return list;
}

async function statusOfToken(req, token, entry, saved) {
  const jellyfin = await checkClient(entry ? entry.client : null);
  const username = (saved && saved.username) || (entry && entry.client && entry.client.username) || null;
  return {
    token,
    name: (saved && saved.name) || (entry && entry.name) || 'Jellyfin',
    url: entry ? entry.client.baseUrl : null,
    keySet: !!(entry && entry.jellyfinApiKey),
    authMode: username ? 'user' : 'apikey',
    username,
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
  res.json({ config: await statusOfToken(req, entry.token, entry, saved) });
});

app.post('/api/configs', manageGate, async (req, res) => {
  const valid = validateCredentials(req.body || {});
  if (valid.error) return res.status(400).json({ ok: false, error: valid.error });

  const name = String((req.body && req.body.name) || '').trim().slice(0, 40) || 'Jellyfin';
  let config;
  if (valid.username !== undefined) {
    let auth;
    try {
      auth = await JellyfinClient.authenticate(valid.jellyfinUrl, valid.username, valid.password);
    } catch (e) {
      return res.json({ ok: false, error: e.message });
    }
    config = {
      name,
      jellyfinUrl: valid.jellyfinUrl,
      accessToken: auth.accessToken,
      userId: auth.userId,
      username: auth.username,
      encPw: valid.password ? encryptPassword(valid.password, getServerSecret()) : null,
    };
  } else {
    config = { name, jellyfinUrl: valid.jellyfinUrl, jellyfinApiKey: valid.jellyfinApiKey };
  }
  const token = tokenFor(config);
  const existing = configs.find((c) => c.token === token);
  const entry = existing ? byToken.get(token) || ensureConfig(existing, existing.legacyId) : ensureConfig(config);
  if (!existing) configs.push({ ...config, token });
  persistConfigs();

  const jellyfin = await checkClient(entry.client);
  res.json({
    ok: true,
    token,
    name,
    url: entry.client.baseUrl,
    jellyfin,
    installUrl: tokenInstallUrl(req, token),
  });
});

app.put('/api/configs/:token', manageGate, async (req, res) => {
  const idx = configs.findIndex((c) => c.token === req.params.token);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Config not found' });

  const valid = validateCredentials(req.body || {});
  if (valid.error) return res.status(400).json({ ok: false, error: valid.error });
  if (valid.username !== undefined) return res.status(400).json({ ok: false, error: 'Username/password setups cannot be edited here; delete and re-add via POST /api/configs' });

  const old = configs[idx];
  const config = { name: String((req.body.name !== undefined && req.body.name) || old.name || '').trim().slice(0, 40) || 'Jellyfin', jellyfinUrl: valid.jellyfinUrl, jellyfinApiKey: valid.jellyfinApiKey };
  configs[idx] = { ...config, token: tokenFor(config), legacyId: old.legacyId };
  rebuild();

  const entry = byToken.get(configs[idx].token);
  const jellyfin = await checkClient(entry.client);
  res.json({ ok: true, token: configs[idx].token, name: config.name, url: entry.client.baseUrl, jellyfin, installUrl: tokenInstallUrl(req, configs[idx].token), legacyInstallUrl: old.legacyId ? legacyInstallUrl(req, old.legacyId) : null });
});

app.delete('/api/configs/:token', manageGate, async (req, res) => {
  const idx = configs.findIndex((c) => c.token === req.params.token);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Config not found' });
  configs.splice(idx, 1);
  persistConfigs();
  rebuild();
  res.json({ ok: true });
});

// Legacy single-config alias.
app.post('/api/config', manageGate, async (req, res) => {
  const guard = (valid) => valid.username !== undefined && 'Username/password setups must use POST /api/configs';
  if (!configs.length) {
    const valid = validateCredentials(req.body || {});
    if (valid.error) return res.status(400).json({ ok: false, error: valid.error });
    const guarded = guard(valid);
    if (guarded) return res.status(400).json({ ok: false, error: guarded });
    const config = { name: 'My Jellyfin', jellyfinUrl: valid.jellyfinUrl, jellyfinApiKey: valid.jellyfinApiKey };
    configs.push({ ...config, token: tokenFor(config) });
    persistConfigs();
    rebuild();
    const entry = byToken.get(config.token);
    return res.json({ ok: true, instance: { name: config.name, jellyfin: await checkClient(entry.client), installUrl: tokenInstallUrl(req, config.token) } });
  }
  const target = configs.find((c) => c.token === req.body.token) || configs[0];
  const valid = validateCredentials(req.body || {});
  if (valid.error) return res.status(400).json({ ok: false, error: valid.error });
  const guarded = guard(valid);
  if (guarded) return res.status(400).json({ ok: false, error: guarded });
  const config = { name: target.name, jellyfinUrl: valid.jellyfinUrl, jellyfinApiKey: valid.jellyfinApiKey };
  Object.assign(target, config, { token: tokenFor(config) });
  rebuild();
  const entry = byToken.get(target.token);
  res.json({ ok: true, instance: { name: target.name, jellyfin: await checkClient(entry.client), installUrl: tokenInstallUrl(req, target.token) } });
});

app.get('/health', async (req, res) => {
  const list = await allStatus(req);
  const allUp = list.length > 0 && list.every((i) => i.jellyfin.ok);
  res.status(allUp ? 200 : 503).json({ ok: allUp, configs: list });
});

// Image proxy. Metas reference /img/<token>/<itemId>/<type>.
app.get('/img/:token/:itemId/:type', async (req, res) => {
  const entry = findEntry(req.params.token, 'img');
  if (!entry) return res.status(404).end();
  try {
    const upstream = await entry.client.image(req.params.itemId, req.params.type);
    if (!upstream.ok) {
      return res.status(404).end();
    }
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    res.status(502).end();
  }
});

// Legacy /i/<id>/... URLs (kept so older installs still work).
app.use('/i/:legacyId', (req, res, next) => {
  const entry = byLegacy.get(req.params.legacyId);
  if (!entry) return next();
  return entry.router(req, res, next);
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

rebuild();
app.listen(PORT, () => {
  console.log(`Addon running: http://localhost:${PORT} — manage page: http://localhost:${PORT}/manage`);
  for (const c of configs) {
    console.log(`  "${c.name}": http://localhost:${PORT}/${c.token}/manifest.json`);
  }
  for (const entry of byToken.values()) {
    entry.client.resolveUser().catch(() => {});
  }
});