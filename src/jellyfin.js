'use strict';

const STREAM_MODES = ['direct', 'auto'];

class JellyfinClient {
  constructor({ baseUrl, apiKey, streamMode = 'direct' }) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.streamMode = STREAM_MODES.includes(streamMode) ? streamMode : 'direct';
    this.userId = null;
    this.externalIdIndex = null;
    this.externalIdIndexAt = 0;
    this.headers = {
      'X-Emby-Token': apiKey,
      Authorization:
        'MediaBrowser Client="stremio-jellyfin", Device="stremio", DeviceId="stremio-jellyfin", Version="1.0.0"',
      Accept: 'application/json',
    };
  }

  async get(path, params = {}) {
    const qs = new URLSearchParams(params);
    const res = await fetch(`${this.baseUrl}${path}?${qs.toString()}`, { headers: this.headers });
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
    return fetch(this.imageUrl(itemId, type), { headers: this.headers });
  }
}

module.exports = { JellyfinClient };