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

  // Feed an item's ProviderIds (Imdb, Tmdb, Kitsu, MyAnimeList, ...) into the
  // external-id → GUID map. Cheap and incremental — called from every
  // catalog/search/meta/episode response so common lookups resolve in O(1).
  rememberExternal(item) {
    if (!item || !item.ProviderIds) return;
    if (!this.externalIdIndex) this.externalIdIndex = new Map();
    const map = this.externalIdIndex;
    for (const [provider, value] of Object.entries(item.ProviderIds)) {
      if (!value) continue;
      map.set(`${provider.toLowerCase()}:${String(value).toLowerCase()}`, item.Id);
    }
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

  // Map an incoming Stremio id to a Jellyfin provider + value. Cinemeta-style
  // catalogs send bare IMDb ids ("tt0848228"); other catalogs prefix the
  // provider ("tmdb:12345", "kitsu:42", "mal:1535", ...). A bare number is
  // almost always a TMDB id.
  static parseExternalId(id) {
    const s = String(id).trim();
    const patterns = [
      [/^tt\d+$/i, 'Imdb'],
      [/^tmdb:?(\d+)$/i, 'Tmdb'],
      [/^tvdb:?(\d+)$/i, 'Tvdb'],
      [/^(?:kitsu|kitsu_id):?(\d+)$/i, 'Kitsu'],
      [/^(?:mal|myanimelist|mal_id):?(\d+)$/i, 'MyAnimeList'],
      [/^(?:anilist|ani_list|anilist_id):?(\d+)$/i, 'AniList'],
      [/^(\d+)$/, 'Tmdb'],
    ];
    for (const [re, provider] of patterns) {
      const m = s.match(re);
      if (m) return { provider, value: m[1] || s };
    }
    return { provider: 'Imdb', value: s };
  }

  // Resolve an external id with one targeted title search instead of a
  // library scan. Each provider maps the id to a title via a free API (the
  // same source the originating catalog uses); Jellyfin's normal SearchTerm
  // finds the item and ProviderIds.<provider> confirms the match. The result
  // is cached in the incremental map, so repeats are O(1).
  async resolveExternalByTitle(provider, value, type) {
    const expected = String(value).toLowerCase();
    let title;
    try {
      if (provider === 'Imdb') {
        const metaType = type === 'episode' ? 'series' : type;
        const res = await fetch(`https://v3-cinemeta.strem.io/meta/${metaType}/${value}.json`, { signal: AbortSignal.timeout(10000) });
        if (res.ok) {
          const data = await res.json();
          title = data && data.meta && data.meta.name;
        }
      } else if (provider === 'Kitsu') {
        const res = await fetch(`https://kitsu.app/api/edge/anime/${value}`, { signal: AbortSignal.timeout(10000) });
        if (res.ok) {
          const data = await res.json();
          const attrs = data && data.data && data.data.attributes;
          title = attrs && (attrs.canonicalTitle || (attrs.titles && (attrs.titles.en_jp || attrs.titles.en || attrs.titles.ja_jp)));
        }
      } else if (provider === 'MyAnimeList') {
        const res = await fetch(`https://api.jikan.moe/v4/anime/${value}`, { signal: AbortSignal.timeout(10000) });
        if (res.ok) {
          const data = await res.json();
          const d = data && data.data;
          title = d && (d.title_english || d.title);
        }
      } else if (provider === 'AniList') {
        const res = await fetch('https://graphql.anilist.co', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ query: 'query ($id: Int) { Media(id: $id) { title { romaji english } } }', variables: { id: Number(value) } }),
          signal: AbortSignal.timeout(10000),
        });
        if (res.ok) {
          const data = await res.json();
          const t = data && data.data && data.data.Media && data.data.Media.title;
          title = t && (t.english || t.romaji);
        }
      }
      // Tmdb/Tvdb have no keyless title API — the AnyProviderIdEquals probe is
      // their only path (works on servers that honor the filter).
    } catch {
      return null;
    }
    if (!title) return null;
    try {
      await this.ensureUser();
      const data = await this.get(this.itemsPath(), {
        Recursive: 'true',
        IncludeItemTypes: 'Movie,Series',
        SearchTerm: title,
        Fields: 'ProviderIds',
        Limit: '20',
      });
      const found = (data.Items || []).find(
        (i) => i.ProviderIds && String(i.ProviderIds[provider] || '').toLowerCase() === expected
      );
      if (found) {
        this.rememberExternal(found);
        return found.Id;
      }
    } catch {
      // search failed — treat as not found
    }
    return null;
  }

  async findByExternalId(id, type) {
    const { provider, value } = JellyfinClient.parseExternalId(id);
    const key = `${provider}:${value}`.toLowerCase();

    // Map lookup — fed incrementally by every catalog/search/meta/episode
    // response, so titles the user has browsed resolve in O(1).
    const hit = this.externalIdIndex && this.externalIdIndex.get(key);
    if (hit) {
      return this.getItem(hit);
    }

    // Fast path: try Jellyfin's AnyProviderIdEquals server-side filter.
    // A single query resolves the item on servers that honor it. Servers that
    // ignore it (return items whose ProviderIds don't match) get flagged so
    // later lookups skip the useless probe.
    if (!this.anyProviderBroken) {
      try {
        await this.ensureUser();
        const data = await this.get(this.itemsPath(), {
          Recursive: 'true',
          IncludeItemTypes: 'Movie,Series',
          AnyProviderIdEquals: `${provider}.${value}`,
          Fields: 'ProviderIds',
          Limit: '1',
        });
        const first = data.Items && data.Items[0];
        if (first && first.ProviderIds && String(first.ProviderIds[provider] || '').toLowerCase() === key.slice(provider.length + 1)) {
          this.rememberExternal(first);
          return this.getItem(first.Id);
        }
        if (data.Items && data.Items.length) this.anyProviderBroken = true;
      } catch {
        // Filter not supported or failed — fall through.
      }
    }

    // Targeted fallback for titles never seen in a catalog: provider API gives
    // the title, a normal Jellyfin search finds the item. No library scan.
    const guid = await this.resolveExternalByTitle(provider, value, type);
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