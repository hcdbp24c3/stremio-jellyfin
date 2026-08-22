# Hybrid Auth Design — Username/Password + AccessToken auto-renew (giữ API Key, multi-host)

**Date:** 2026-08-22
**Status:** Draft — awaiting user review
**Scope:** Thêm flow Username/Password (kể cả guest) song song với API Key hiện tại, dùng AccessToken stateless + Hybrid auto-renew qua encPw AES-GCM. Giữ nguyên multi-host (mỗi jellyfinUrl = 1 token riêng).

---

## 1. Context & Goals

**Hiện trạng:** `stremio-jellyfin` chỉ hỗ trợ `jellyfinApiKey` (admin API key). User thường/guest không có API key không dùng được. Token hiện tại: `base64url(JSON({jellyfinUrl, jellyfinApiKey}))`, `JellyfinClient` dùng `X-Emby-Token: apiKey`.

**Mục tiêu:**
- Hỗ trợ mọi Jellyfin user: admin (API key) + regular + guest (password rỗng).
- Ưu tiên AccessToken (Jellyfin `POST /Users/AuthenticateByName` → `AccessToken + User.Id`), không lưu password plaintext trong URL.
- Hybrid auto-renew: khi AccessToken expire/revoke (401), tự re-auth bằng encPw đã lưu (mã hoá), retry 1 lần.
- Giữ tương thích ngược: link cũ API Key vẫn chạy.
- Giữ multi-host: mỗi host là 1 token riêng, `/manage` list tất cả.
- Fix bug `public/configure.html` đang build URL raw JSON thay vì base64url.

**Non-goals:** Không đổi manifest/catalog logic, không thêm DB, không đổi streamMode.

---

## 2. Architecture Overview

```
[Browser] -- username/password or apiKey --> [Express /api/check] --POST /Users/AuthenticateByName--> [Jellyfin]
      |                                              |-> AccessToken + UserId
      |<-- {accessToken, userId} --------------------|
      | build installUrl = origin + /base64url({jellyfinUrl, accessToken, userId, username, encPw})/manifest.json
[Stremio] -- GET /<token>/manifest.json --> [findEntry(token) -> decodeToken -> ensureConfig -> JellyfinClient(accessToken,userId,encPw)]
      |-> catalog/meta/stream -> JellyfinClient.get() --X-Emby-Token: accessToken--> [Jellyfin]
      |-> nếu 401 & encPw tồn tại -> decrypt -> authenticate() -> update token in-memory -> retry once
```

**Key decision:** `encPw` là `AES-256-GCM(password UTF-8, serverSecret)`, base64url. `serverSecret` = `sha256(MANAGE_KEY)` nếu `MANAGE_KEY` tồn tại, ngược lại `randomBytes(32)` sinh 1 lần và persist trong `config.json:serverSecret`. Không có MANAGE_KEY vẫn an toàn (secret ngẫu nhiên, không commit). `encPw` chỉ có khi tạo qua `/api/configs` (manage, có serverSecret) — link public `/configure` tạo qua `/api/check` sẽ là shape B (không có encPw, không auto-renew) vì client không có secret để mã hoá.

---

## 3. Token Schema

### 3.1 Shapes (decodeToken accepts all)

```js
// A) Legacy API Key (existing)
{ jellyfinUrl: string, jellyfinApiKey: string }

// B) AccessToken plain (no renew)
{ jellyfinUrl: string, accessToken: string, userId: string, username?: string }

// C) Hybrid auto-renew (recommended for user/pass with password)
{ jellyfinUrl: string, accessToken: string, userId: string, username: string, encPw: string|null }
// encPw = null khi guest (password === "")
```

### 3.2 Helpers

- `tokenFor(config)` — overload: nếu `config.accessToken` tồn tại → stringify shape B/C, else shape A.
- `decodeToken(token)` — thử `base64url -> JSON` rồi `JSON raw` (giữ fallback), validate `jellyfinUrl` is https? và (`jellyfinApiKey` || `accessToken`).
- `isConfigured(c)` — true nếu A hoặc (B/C) hợp lệ.
- `encryptPassword(pw, secret)` / `decryptPassword(encPw, secret)` — AES-256-GCM, key = `sha256(secret)` 32 bytes, iv 12 bytes random, output `base64url(iv + ciphertext + authTag)` (Node `cipher.getAuthTag()`). Input `pw` là UTF-8 string (có thể rỗng cho guest → không gọi encrypt).
- `serverSecret` — load từ `fileConfig.serverSecret` hoặc `sha256(MANAGE_KEY)` hoặc generate + persist.

### 3.3 Persistence

`config.json`:
```json
{
  "serverSecret": "base64url...",
  "savedConfigs": [
    {"name":"Home", "jellyfinUrl":"https://...", "jellyfinApiKey":"..."},
    {"name":"Mom", "jellyfinUrl":"https://...", "accessToken":"...", "userId":"...", "username":"mom", "encPw":"..."}
  ]
}
```
`persistConfigs()` lưu thêm `accessToken/userId/username/encPw`, `loadConfigs()` đọc cả 3 shape.

---

## 4. Component Changes

### 4.1 `src/jellyfin.js`

```js
class JellyfinClient {
  constructor({ baseUrl, apiKey, accessToken, userId, encPw, username, streamMode }) {
    this.baseUrl = baseUrl.replace(/\/+$/,'');
    this.token = accessToken || apiKey; // unified
    this.userId = userId || null;
    this.encPw = encPw || null;
    this.username = username || null;
    this.streamMode = ...
    this.headers = { 'X-Emby-Token': this.token, ... }
  }
  static async authenticate(baseUrl, username, password) {
    // POST /Users/AuthenticateByName with X-Emby-Authorization
    // Body: { Username, Pw }
    // Return: { AccessToken, User: { Id, Name } }
  }
  async get(path, params, _retry=true) {
    // fetch with this.headers, if 401 && _retry && this.encPw && this.username
    //   -> decrypt, authenticate, update this.token/this.headers, retry once
  }
  // ensureUser() short-circuit if this.userId already set
}
```

- `resolveUser()` chỉ gọi nếu `!this.userId`.
- `indexExternalIds`, `getItems`, `episodes`, `streamUrl`, `imageUrl` giữ nguyên, chỉ dùng `this.token`.

### 4.2 `index.js` — API

- `validateCredentials(body)` mở rộng: chấp nhận `(jellyfinUrl + jellyfinApiKey)` HOẶC `(jellyfinUrl + username)` (password optional). Trả về `{mode:'apikey'|'user', ...}`.
- `POST /api/check`:
  - Nếu `mode==='user'` → `await JellyfinClient.authenticate(url, username, password)` → `checkClient` với token mới → trả `{ok, version, accessToken, userId, username}`.
  - Nếu `mode==='apikey'` → flow cũ.
- `POST /api/configs` (manage):
  - Tương tự, sau authenticate tạo `encPw = password ? encryptPassword(password, serverSecret) : null`
  - `token = tokenFor({jellyfinUrl, accessToken, userId, username, encPw})`
  - `ensureConfig({jellyfinUrl, accessToken, userId, username, encPw}, legacyId)` + persist.
- `PUT /api/configs/:token` — cho phép đổi username/password (re-auth) hoặc đổi sang apiKey.
- `findEntry`, `ensureConfig`, `buildAddon` — truyền thêm `encPw/username` vào `JellyfinClient`.
- `GET /api/status` — thêm `authMode`, `username` vào mỗi entry.
- `GET /api/status/:token` — tương tự.

### 4.3 Frontend

**`public/configure.html`:**
- Radio `API Key` (default) vs `Tài khoản Jellyfin`.
- Khi chọn Tài khoản: hiện `Username *` + `Password` (hint "để trống nếu guest"), ẩn input API key.
- Submit: gửi `fetch('/api/check', {body: JSON.stringify({jellyfinUrl, username, password})})` hoặc `{jellyfinUrl, jellyfinApiKey}`.
- Nhận `{accessToken, userId, username}` → `const cfg = {jellyfinUrl, accessToken, userId, username}` (shape B, không có encPw vì public page không có serverSecret) → `installUrl = location.origin + '/' + base64url(JSON.stringify(cfg)) + '/manifest.json'` (dùng base64url, fix bug cũ).
- Note: Link từ `/configure` sẽ không auto-renew (chấp nhận được, user có thể gen lại). Link từ `/manage` (`/api/configs`) mới có `encPw` và auto-renew.
- Hiển thị copy button như cũ.

**`public/index.html` (manage):**
- Tương tự toggle, thêm table column User/AuthMode, badge `Hybrid ✓` nếu có encPw.
- Form Add/Edit hỗ trợ cả 2 mode.
- `render()` call `/api/status` mới.

**`public/user.html`:**
- Hiện `username` nếu có, subtitle "Tài khoản: mom".

---

## 5. Data Flow & Error Handling

1. **Guest flow:** password="" → authenticate với Pw="" → Jellyfin cho phép nếu guest không có mật khẩu → encPw=null → không renew (guest token thường không expire).
2. **401 handling:** `JellyfinClient.get()` catch 401 → nếu `encPw` tồn tại → decrypt → `authenticate()` → update `this.token` + headers → retry 1 lần → nếu vẫn 401 → throw → `allStatus` hiện `Unreachable`.
3. **Validation:** URL phải `https?://`, username không chứa `:` (tránh clash với series:season:episode parser), password có thể rỗng.
4. **Secret rotation:** Nếu `MANAGE_KEY` đổi → `serverSecret` đổi → `decrypt` fail → fallback: yêu cầu user gen lại link (hiện lỗi "Vui lòng tạo lại install link").
5. **Compat:** Link cũ `jellyfinApiKey` không có `userId` → `ensureUser()` vẫn chạy như cũ.

---

## 6. Security Considerations

- Không lưu password plaintext trong URL/file — chỉ `encPw` AES-GCM.
- `serverSecret` không commit, nằm trong `config.json` volume, backup cùng volume.
- `MANAGE_KEY` vẫn gate `/manage` + `/api/configs`, `/api/check` public nhưng không leak list (chỉ test 1 host).
- Rate limit: không thêm trong spec này (giữ scope nhỏ), có thể thêm `express-rate-limit` sau.

---

## 7. Testing Plan

- **Manual:** 
  - Test API Key cũ vẫn install được.
  - Test user thường có password → gen link → install → catalog/stream ok.
  - Test guest (password rỗng) → ok.
  - Test multi-host: 2 Jellyfin khác nhau → 2 token khác nhau → `/manage` hiện 2.
  - Test auto-renew: revoke AccessToken trong Jellyfin Dashboard → request lại → 401 → renew → success (nếu có encPw).
- **Unit (optional):** `encrypt/decrypt` roundtrip, `decodeToken` 3 shapes.
- **No regression:** `npm start` + check `/health` 200.

---

## 8. Rollout

- Phase 1: Implement `src/jellyfin.js` + `index.js` + frontend (spec này).
- Phase 2: (future) rate-limit, `serverSecret` rotation CLI.

---

## 9. Open Questions (resolved)

- Q: Lưu password để renew? A: Có, nhưng mã hoá AES-GCM, không plaintext.
- Q: Guest? A: password="" → encPw=null, không renew.
- Q: Multi-host chưa có? A: Đã có, giữ nguyên.
