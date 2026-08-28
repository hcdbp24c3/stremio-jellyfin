'use strict';

const STREAM_MODES = ['direct', 'auto'];

class JellyfinClient {
  // Some servers (custom builds) ignore the legacy X-Emby-Authorization /
  // X-Emby-Token headers entirely and only honor the token carried inside the
  // standard `Authorization` header (Token="..."), exactly like Jellyfin Web
  // sends it. We send BOTH forms so standard and custom servers both work.
  static authHeader({ token } = {}) {
    const parts = [
      'MediaBrowser Client="stremio-jellyfin"',
      'Device="stremio"',
      'DeviceId="stremio-jellyfin"',
      'Version="1.0.0"',
    ];
    if (token) parts.push(`Token="${token}"`);
    return parts.join(', ');
  }

  constructor({ baseUrl, apiKey, accessToken, userId, encPw, username, streamMode = 'direct', hls = false, hlsBitrate = 8000000, needsHeaderAuth = false }) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.token = accessToken || apiKey; // unified bearer token (AccessToken or API key)
    this.apiKey = this.token; // keep compat for streamUrl/imageUrl fallbacks
    this.userId = userId || null;
    this.encPw = encPw || null; // AES-GCM encrypted password for 401 auto-renew
    this.username = username || null;
    this.streamMode = STREAM_MODES.includes(streamMode) ? streamMode : 'direct';
    // hls: true/'transcode' = adaptive transcode ladder; 'direct' = play the
    // source file as-is over HLS (original bitrate/quality, no re-encode).
    this.hls = hls === 'direct' ? 'direct' : !!hls;
    this.hlsBitrate = Number.isFinite(Number(hlsBitrate)) && Number(hlsBitrate) > 0 ? Number(hlsBitrate) : 8000000;
    // Header-only auth servers reject api_key query auth, so direct 302 links
    // (which the player fetches without headers) can never play — streams must
    // relay through the addon instead. Set by the setup-time probe.
    this.needsHeaderAuth = !!needsHeaderAuth;
    this.externalIdIndex = null;
    this.externalIdIndexAt = 0;
    this.headers = {
      'X-Emby-Token': this.token,
      'X-Emby-Authorization': JellyfinClient.authHeader(),
      Authorization: JellyfinClient.authHeader({ token: this.token }),
      Accept: 'application/json',
    };
  }

  static async authenticate(baseUrl, username, password) {
    const url = String(baseUrl).replace(/\/+$/, '') + '/Users/AuthenticateByName';
    const res = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: {
        'Content-Type': 'application/json',
        'X-Emby-Authorization': JellyfinClient.authHeader(),
        Authorization: JellyfinClient.authHeader(),
        Accept: 'application/json',
      },
      body: JSON.stringify({ Username: String(username), Pw: String(password || '') }),
    });
    if (!res.ok) {
      // Surface Jellyfin's own reason when it provides one (invalid creds,
      // disabled account, sign-in locked out...) instead of a bare 401.
      let detail = '';
      try {
        const body = await res.json();
        const msgs = [];
        if (body && Array.isArray(body.errors)) msgs.push(...body.errors);
        if (body && body.errors && typeof body.errors === 'object' && !Array.isArray(body.errors)) {
          Object.values(body.errors).forEach((v) => Array.isArray(v) ? msgs.push(...v) : msgs.push(String(v)));
        }
        if (body && typeof body.message === 'string') msgs.push(body.message);
        detail = msgs.length ? ` — ${msgs.join('; ')}` : '';
      } catch {}
      // A bare 400 on AuthenticateByName means the server refused the request
      // before checking credentials (sign-in disabled/broken server-side) —
      // Jellyfin answers 401 for actually-wrong passwords. Point the user at
      // the API-key path instead of leaving them chasing the password.
      const hint = res.status === 400 ? ' — this server refused the login request (password sign-in may be disabled); use an API key for this host instead' : '';
      throw new Error(`Auth ${res.status} ${res.statusText}${detail}${hint}`);
    }
    const data = await res.json();
    if (!data.AccessToken || !data.User || !data.User.Id) throw new Error('Invalid auth response');
    // Anti-phishing fingerprint: a credential harvester can mimic the auth
    // endpoint, so verify the token actually reads a Jellyfin /System/Info
    // before trusting this host with the user's password. Fail closed: any
    // mismatch/refusal counts as "not Jellyfin".
    let looksJellyfin = false;
    try {
      const infoRes = await fetch(`${String(baseUrl).replace(/\/+$/, '')}/System/Info`, {
        headers: { 'X-Emby-Token': data.AccessToken, Authorization: JellyfinClient.authHeader({ token: data.AccessToken }), Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      if (infoRes.ok) {
        const info = await infoRes.json();
        looksJellyfin = !!info.Version && (!info.ProductName || /jellyfin|emby/i.test(String(info.ProductName)));
      }
    } catch {}
    if (!looksJellyfin) {
      const err = new Error('Target did not identify itself as a Jellyfin server — check the URL');
      err.code = 'NOT_JELLYFIN';
      throw err;
    }
    return { accessToken: data.AccessToken, userId: data.User.Id, username: data.User.Name || username };
  }

  async get(path, params = {}, _retry = true, timeout = 20000) {
    const qs = new URLSearchParams(params);
    const res = await fetch(`${this.baseUrl}${path}?${qs.toString()}`, { headers: this.headers, signal: AbortSignal.timeout(timeout) });
    // Token expired: renew once via the stored encrypted password, then retry.
    // `_decrypt` is injected externally by index.js (decryptPassword + serverSecret).
    if (res.status === 401 && _retry && this.encPw && this.username) {
      try {
        const pw = this._decrypt ? await this._decrypt(this.encPw) : null;
        if (pw !== null) {
          const auth = await JellyfinClient.authenticate(this.baseUrl, this.username, pw);
          this.token = auth.accessToken;
          this.apiKey = this.token; // streamUrl/imageUrl embed api_key
          this.userId = auth.userId;
          this.headers['X-Emby-Token'] = this.token;
          this.headers.Authorization = JellyfinClient.authHeader({ token: this.token });
          return this.get(path, params, false);
        }
      } catch {
        // renewal failed -> surface the original 401 as a normal error below
      }
    }
    if (!res.ok) {
      throw new Error(`Jellyfin ${path} -> ${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  async ping() {
    const info = await this.get('/System/Info');
    return info.Version;
  }

  // Resolve the first user so we can use /Users/{id}/Items paths, which
  // are the most reliably authorized across Jellyfin versions. Called lazily
  // (on demand) so entries created at request time work too, and retried
  // after a short cooldown if it fails.
  async resolveUser() {
    // User-mode clients already know their userId from authentication;
    // never clobber it when the /Users listing fails.
    if (this.userId) return this.userId;
    try {
      const users = await this.get('/Users');
      if (Array.isArray(users) && users.length > 0) {
        this.userId = users[0].Id;
      }
    } catch {
      this.userId = null;
    }
    return this.userId;
  }

  async ensureUser() {
    if (this.userId) return this.userId;
    const now = Date.now();
    if (this.userIdFailedAt && now - this.userIdFailedAt < 60000) return null;
    await this.resolveUser();
    if (!this.userId) this.userIdFailedAt = now;
    return this.userId;
  }

  async getItems({ type, startIndex = 0, limit = 20, search }) {
    await this.ensureUser();
    const params = {
      Recursive: 'true',
      SortBy: 'SortName',
      SortOrder: 'Ascending',
      IncludeItemTypes: type,
      EnableImageTypes: 'Primary,Backdrop',
      Fields: 'Overview,Genres,ProductionYear,RuntimeTicks,ProviderIds',
      StartIndex: String(startIndex),
      Limit: String(limit),
    };
    if (search) params.SearchTerm = search;
    const data = await this.get(this.itemsPath(), params);
    const items = data.Items || [];
    // Every catalog/search response feeds the IMDb→GUID map, so a movie the
    // user just searched resolves instantly without waiting for a full scan.
    for (const item of items) this.rememberExternal(item);
    return items;
  }

  async getItem(id) {
    await this.ensureUser();
    const path = this.userId ? `/Users/${this.userId}/Items/${id}` : `/Items/${id}`;
    const item = await this.get(path, {
      Fields: 'Overview,Genres,ProductionYear,RuntimeTicks,OfficialRating,MediaSources,ProviderIds',
    });
    this.rememberExternal(item);
    return item;
  }

  // Feed an item's ProviderIds into the IMDb→GUID map. Cheap and incremental —
  // called from catalog/search/episode responses so common lookups never need
  // the full library scan. Does NOT touch scan freshness (the full scan stays
  // authoritative for expiry).
  rememberExternal(item) {
    const imdb = item && item.ProviderIds && item.ProviderIds.Imdb;
    if (!imdb) return;
    if (!this.externalIdIndex) this.externalIdIndex = new Map();
    this.externalIdIndex.set(String(imdb).toLowerCase(), item.Id);
  }

  // Resolve a Stremio id to a Jellyfin item. Stremio ids may be Jellyfin
  // GUIDs (from our catalogs) or IMDb ids (from Cinemeta-style catalogs,
  // e.g. "tt0848228" or "tt0903747:1:1" for episodes).
  async resolveItem(id, type) {
    if (/^[0-9a-f]{32}$/i.test(id)) {
      return this.getItem(id);
    }
    return this.findByExternalId(id, type);
  }

  // Build (and cache) an IMDb id → Jellyfin GUID index for the library.
  // Used when AnyProviderIdEquals is unavailable (some custom builds ignore
  // the filter and return the whole library). Pages are fetched in parallel
  // but at low concurrency so a background warm-up never saturates the media
  // server and slows down interactive search/stream requests.
  async ensureIndex(force = false) {
    const MAX_AGE = 60 * 60 * 1000;
    if (!force && this.externalIdScanned && this.externalIdIndex && Date.now() - this.externalIdIndexAt < MAX_AGE) return;
    if (this.externalIdBuilding) {
      await this.externalIdBuilding;
      return;
    }
    const p = this.buildIndex();
    this.externalIdBuilding = p;
    try {
      await p;
    } finally {
      if (this.externalIdBuilding === p) this.externalIdBuilding = null;
    }
  }

  async buildIndex() {
    await this.ensureUser();

    const map = new Map();
    const PAGE = 5000;
    const CONCURRENCY = 4;
    let start = 0;
    while (true) {
      const batch = [];
      for (let i = 0; i < CONCURRENCY; i++) {
        batch.push(
          this.get(
            this.itemsPath(),
            {
              Recursive: 'true',
              IncludeItemTypes: 'Movie,Series',
              Fields: 'ProviderIds',
              EnableImageTypes: '',
              EnableUserData: 'false',
              StartIndex: String(start + i * PAGE),
              Limit: String(PAGE),
            },
            true,
            60000
          )
        );
      }
      const pages = await Promise.all(batch);
      let got = 0;
      for (const data of pages) {
        const items = data.Items || [];
        got += items.length;
        for (const item of items) {
          const imdb = item.ProviderIds && item.ProviderIds.Imdb;
          if (imdb) map.set(String(imdb).toLowerCase(), item.Id);
        }
      }
      start += got;
      if (got < CONCURRENCY * PAGE) break;
    }

    this.externalIdIndex = map;
    this.externalIdScanned = true;
    this.externalIdIndexAt = Date.now();
  }

  async findByExternalId(id, type) {
    const key = String(id).toLowerCase();

    // Map lookup — the map is fed incrementally by every catalog/search/meta
    // response AND by the full background scan, so common titles resolve here
    // in O(1) without probing the server or waiting on a scan.
    const hit = this.externalIdIndex && this.externalIdIndex.get(key);
    if (hit) {
      return this.getItem(hit);
    }

    // Fast path: try Jellyfin's AnyProviderIdEquals server-side filter.
    // A single query resolves the item on servers that honor it. Servers that
    // ignore it (return items whose ProviderIds don't match) get flagged so
    // later lookups skip the useless probe and go straight to the index.
    if (!this.anyProviderBroken) {
      try {
        await this.ensureUser();
        const params = {
          Recursive: 'true',
          IncludeItemTypes: 'Movie,Series',
          AnyProviderIdEquals: `Imdb.${id}`,
          Fields: 'ProviderIds',
          Limit: '1',
        };
        const data = await this.get(this.itemsPath(), params);
        const first = data.Items && data.Items[0];
        if (first && first.ProviderIds && String(first.ProviderIds.Imdb).toLowerCase() === key) {
          return this.getItem(first.Id);
        }
        if (data.Items && data.Items.length) this.anyProviderBroken = true;
      } catch {
        // Filter not supported or failed — fall through to index scan.
      }
    }

    // Full-scan lookup: the safety net for titles never seen in a catalog.
    // A completed scan is reused for an hour; a running scan is shared so
    // concurrent lookups don't each rebuild it.
    await this.ensureIndex();
    const guid = this.externalIdIndex && this.externalIdIndex.get(key);
    if (guid) {
      return this.getItem(guid);
    }

    // Last resort: Jellyfin might resolve an arbitrary id directly.
    try {
      const item = await this.getItem(id);
      if (item && item.Id) return item;
    } catch {
      // fall through
    }
    throw new Error(`No Jellyfin item for external id ${id}`);
  }

  async episodes(seriesId, season) {
    await this.ensureUser();
    const params = { Fields: 'Overview,PremiereDate,MediaSources,ProviderIds', EnableImageTypes: 'Primary' };
    if (this.userId) params.userId = this.userId;
    if (season) params.Season = String(season);
    const data = await this.get(`/Shows/${seriesId}/Episodes`, params);
    const items = data.Items || [];
    for (const item of items) this.rememberExternal(item);
    return items;
  }

  itemsPath() {
    return this.userId ? `/Users/${this.userId}/Items` : '/Items';
  }

  // Drop derived caches so newly added library items are picked up on the
  // next request (used by the refresh endpoint and the webhook).
  invalidate() {
    this.externalIdIndex = null;
    this.externalIdIndexAt = 0;
    this.externalIdScanned = false;
    this.anyProviderBroken = false;
  }

  streamUrl(itemId) {
    const qs = new URLSearchParams({ api_key: this.apiKey });
    if (this.streamMode === 'auto') {
      qs.set('Static', 'false');
      qs.set('TranscodeReasons', 'ContainerNotSupported,VideoCodecNotSupported,AudioCodecNotSupported');
    } else {
      qs.set('Static', 'true');
    }
    return `${this.baseUrl}/Videos/${itemId}/stream?${qs.toString()}`;
  }

  // HLS master playlist. `hls === 'direct'` plays the source file as-is
  // (Static=true — original bitrate/quality, no re-encode; needs bandwidth to
  // match the source). Otherwise Jellyfin transcodes to an H.264 ladder capped
  // at `hlsBitrate` so playback stays smooth on constrained links while
  // segment-based seeking keeps working. Progressive /stream transcodes ignore
  // Range requests, so HLS is the only transcode path that seeks correctly.
  hlsUrl(itemId, mediaSourceId) {
    const qs = new URLSearchParams({
      api_key: this.apiKey,
      Static: this.hls === 'direct' ? 'true' : 'false',
      mediaSourceId: mediaSourceId || itemId,
    });
    if (this.hls !== 'direct') {
      qs.set('MaxWidth', '1920');
      qs.set('MaxHeight', '1080');
      qs.set('VideoBitrate', String(this.hlsBitrate));
      qs.set('AudioBitrate', '192000');
      qs.set('TranscodeReasons', 'ContainerNotSupported,VideoCodecNotSupported,AudioCodecNotSupported');
      qs.set('VideoCodec', 'h264');
      qs.set('AllowVideoStreamCopy', 'false');
    }
    return `${this.baseUrl}/Videos/${encodeURIComponent(itemId)}/master.m3u8?${qs.toString()}`;
  }

  imageUrl(itemId, type = 'Primary') {
    return `${this.baseUrl}/Items/${itemId}/Images/${type}?api_key=${encodeURIComponent(this.apiKey)}`;
  }

  image(itemId, type = 'Primary') {
    return fetch(this.imageUrl(itemId, type), { headers: this.headers, signal: AbortSignal.timeout(20000) });
  }
}

module.exports = { JellyfinClient };