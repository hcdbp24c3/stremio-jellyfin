'use strict';

const STREAM_MODES = ['direct', 'auto'];

class JellyfinClient {
  constructor({ baseUrl, apiKey, accessToken, userId, encPw, username, streamMode = 'direct' }) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.token = accessToken || apiKey; // unified bearer token (AccessToken or API key)
    this.apiKey = this.token; // keep compat for streamUrl/imageUrl fallbacks
    this.userId = userId || null;
    this.encPw = encPw || null; // AES-GCM encrypted password for 401 auto-renew
    this.username = username || null;
    this.streamMode = STREAM_MODES.includes(streamMode) ? streamMode : 'direct';
    this.externalIdIndex = null;
    this.externalIdIndexAt = 0;
    this.headers = {
      'X-Emby-Token': this.token,
      Authorization:
        'MediaBrowser Client="stremio-jellyfin", Device="stremio", DeviceId="stremio-jellyfin", Version="1.0.0"',
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
        'X-Emby-Authorization':
          'MediaBrowser Client="stremio-jellyfin", Device="stremio", DeviceId="stremio-jellyfin", Version="1.0.0"',
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
      throw new Error(`Auth ${res.status} ${res.statusText}${detail}`);
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
        headers: { 'X-Emby-Token': data.AccessToken, Accept: 'application/json' },
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

  async get(path, params = {}, _retry = true) {
    const qs = new URLSearchParams(params);
    const res = await fetch(`${this.baseUrl}${path}?${qs.toString()}`, { headers: this.headers, signal: AbortSignal.timeout(20000) });
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

  async getItems({ type, startIndex = 0, limit = 20, genre, search }) {
    await this.ensureUser();
    const params = {
      Recursive: 'true',
      SortBy: 'SortName',
      SortOrder: 'Ascending',
      IncludeItemTypes: type,
      EnableImageTypes: 'Primary,Backdrop',
      Fields: 'Overview,Genres,ProductionYear,RuntimeTicks',
      StartIndex: String(startIndex),
      Limit: String(limit),
    };
    if (genre) params.Genres = genre;
    if (search) params.SearchTerm = search;
    const data = await this.get(this.itemsPath(), params);
    return data.Items || [];
  }

  async genres() {
    const data = await this.get('/Genres', { SortBy: 'SortName', Limit: '200' });
    return data.Items || [];
  }

  async getItem(id) {
    await this.ensureUser();
    const path = this.userId ? `/Users/${this.userId}/Items/${id}` : `/Items/${id}`;
    return this.get(path, {
      Fields: 'Overview,Genres,ProductionYear,RuntimeTicks,OfficialRating,MediaSources',
    });
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

  // Build (and cache) an IMDb id -> Jellyfin GUID index for the library.
  // Jellyfin's AnyProviderIdEquals filter is unreliable, so we scan the
  // library directly (paged) and remember the mapping for a few minutes.
  async indexExternalIds(force = false) {
    const MAX_AGE = 10 * 60 * 1000;
    if (!force && this.externalIdIndex && Date.now() - this.externalIdIndexAt < MAX_AGE) return;
    await this.ensureUser();

    const map = new Map();
    const PAGE = 1000;
    let start = 0;
    while (true) {
      const data = await this.get(this.itemsPath(), {
        Recursive: 'true',
        IncludeItemTypes: 'Movie,Series',
        Fields: 'ProviderIds',
        StartIndex: String(start),
        Limit: String(PAGE),
      });
      const items = data.Items || [];
      for (const item of items) {
        const imdb = item.ProviderIds && item.ProviderIds.Imdb;
        if (imdb) map.set(String(imdb).toLowerCase(), item.Id);
      }
      const total = Number(data.TotalRecordCount || 0);
      start += items.length;
      if (items.length < PAGE || start >= total) break;
    }

    this.externalIdIndex = map;
    this.externalIdIndexAt = Date.now();
  }

  async findByExternalId(id, type) {
    const key = String(id).toLowerCase();
    await this.indexExternalIds();
    let guid = this.externalIdIndex.get(key);
    if (!guid) {
      await this.indexExternalIds(true);
      guid = this.externalIdIndex.get(key);
    }
    if (guid) {
      return this.getItem(guid);
    }
    // Fallback: Jellyfin might still resolve an arbitrary id directly.
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
    const params = { Fields: 'Overview,PremiereDate,MediaSources', EnableImageTypes: 'Primary' };
    if (this.userId) params.userId = this.userId;
    if (season) params.Season = String(season);
    const data = await this.get(`/Shows/${seriesId}/Episodes`, params);
    return data.Items || [];
  }

  itemsPath() {
    return this.userId ? `/Users/${this.userId}/Items` : '/Items';
  }

  // Drop derived caches so newly added library items are picked up on the
  // next request (used by the refresh endpoint and the webhook).
  invalidate() {
    this.externalIdIndex = null;
    this.externalIdIndexAt = 0;
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

  imageUrl(itemId, type = 'Primary') {
    return `${this.baseUrl}/Items/${itemId}/Images/${type}?api_key=${encodeURIComponent(this.apiKey)}`;
  }

  image(itemId, type = 'Primary') {
    return fetch(this.imageUrl(itemId, type), { headers: this.headers, signal: AbortSignal.timeout(20000) });
  }
}

module.exports = { JellyfinClient };