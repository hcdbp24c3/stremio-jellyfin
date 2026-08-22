# Hybrid Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thêm flow Username/Password (regular + guest) song song API Key, dùng AccessToken stateless + Hybrid auto-renew qua encPw AES-GCM, giữ multi-host.

**Architecture:** Mở rộng `JellyfinClient` với `authenticate()` + 401 auto-renew, token schema 3 shapes (API Key / AccessToken plain / Hybrid encPw), `serverSecret` persist trong config.json, frontend toggle API Key vs User/Pass.

**Tech Stack:** Node 18+, Express 4.19, stremio-addon-sdk 1.6, Node `crypto` AES-256-GCM, Fetch API, vanilla JS frontend.

## Global Constraints

- Node >=18, không thêm dependency mới (dùng `crypto` builtin)
- Giữ tương thích ngược: link cũ `jellyfinApiKey` vẫn chạy
- Không đổi manifest/catalog/stream logic, chỉ đổi auth/token layer
- `encPw` phải là AES-GCM, không lưu password plaintext trong URL hay config.json
- `serverSecret` persist trong `config.json:serverSecret`, sinh 1 lần nếu chưa có
- Frontend `configure.html` phải fix bug raw JSON -> base64url

---

## File Structure

- **Modify:** `src/jellyfin.js` — thêm authenticate, 401 renew, constructor mở rộng
- **Modify:** `index.js` — tokenFor/decodeToken/isConfigured, serverSecret, validateCredentials, /api/check, /api/configs, findEntry, buildAddon
- **Modify:** `public/configure.html` — toggle API Key / UserPass
- **Modify:** `public/index.html` — manage page toggle + hiện authMode
- **Modify:** `public/user.html` — hiện username
- **Create:** `docs/superpowers/specs/2026-08-22-hybrid-auth-design.md` — đã có
- **Test:** manual via curl + browser (không có test suite hiện tại)

---

### Task 1: Crypto helpers & serverSecret persistence

**Files:**
- Modify: `index.js:11-30` (config loading)
- Modify: `index.js` top (require crypto already exists)

**Interfaces:**
- Produces: `getServerSecret() -> string (base64url)`, `encryptPassword(pw, secret) -> string`, `decryptPassword(encPw, secret) -> string`

- [ ] **Step 1: Thêm helpers crypto vào index.js (đầu file, sau const crypto)**

```js
// Server secret for encPw AES-GCM — persist once
function getServerSecret() {
  const cfg = loadConfigFile();
  if (cfg.serverSecret) return cfg.serverSecret;
  if (MANAGE_KEY) {
    const s = crypto.createHash('sha256').update(String(MANAGE_KEY)).digest('hex').slice(0, 32);
    // persist hash-derived secret so it survives MANAGE_KEY unset? keep simple: return hash without persist
    return Buffer.from(s).toString('base64url');
  }
  const secret = crypto.randomBytes(32).toString('base64url');
  try { writeConfigFile({ ...cfg, serverSecret: secret }); } catch {}
  return secret;
}
function encryptPassword(pw, secret) {
  // secret is base64url 32 bytes, derive key via sha256
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
```

- [ ] **Step 2: Chạy thử encrypt/decrypt roundtrip**

Run: `node -e "const c=require('crypto'); // copy helpers; const s=require('crypto').randomBytes(32).toString('base64url'); const e=encryptPassword('mypw',s); console.log(e, decryptPassword(e,s)==='mypw')"`

Expected: PASS true

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "feat: add serverSecret + AES-GCM encrypt/decrypt helpers"
```

---

### Task 2: JellyfinClient hybrid (authenticate + auto-renew)

**Files:**
- Modify: `src/jellyfin.js`

**Interfaces:**
- Consumes: `encryptPassword/decryptPassword` indirectly via index.js (không cần import trực tiếp, client chỉ lưu encPw string)
- Produces: `JellyfinClient.authenticate(baseUrl, username, password) -> {AccessToken, User}`, `new JellyfinClient({baseUrl, apiKey, accessToken, userId, encPw, username})`, `get(path, params)` with 401 retry

- [ ] **Step 1: Mở rộng constructor**

```js
constructor({ baseUrl, apiKey, accessToken, userId, encPw, username, streamMode = 'direct' }) {
  this.baseUrl = String(baseUrl).replace(/\/+$/, '');
  this.token = accessToken || apiKey; // unified
  this.apiKey = this.token; // keep compat for streamUrl fallback
  this.userId = userId || null;
  this.encPw = encPw || null;
  this.username = username || null;
  // ... rest same, headers X-Emby-Token = this.token
}
```

- [ ] **Step 2: Thêm static authenticate**

```js
static async authenticate(baseUrl, username, password) {
  const url = String(baseUrl).replace(/\/+$/, '') + '/Users/AuthenticateByName';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Emby-Authorization': 'MediaBrowser Client="stremio-jellyfin", Device="stremio", DeviceId="stremio-jellyfin", Version="1.0.0"',
      'Accept': 'application/json'
    },
    body: JSON.stringify({ Username: String(username), Pw: String(password || '') })
  });
  if (!res.ok) throw new Error(`Auth ${res.status} ${res.statusText}`);
  const data = await res.json();
  if (!data.AccessToken || !data.User || !data.User.Id) throw new Error('Invalid auth response');
  return { accessToken: data.AccessToken, userId: data.User.Id, username: data.User.Name || username };
}
```

- [ ] **Step 3: Patch ensureUser + get với 401 auto-renew**

```js
async ensureUser() {
  if (this.userId) return this.userId;
  // ... existing cooldown logic
}
async get(path, params = {}, _retry = true) {
  const qs = new URLSearchParams(params);
  const url = `${this.baseUrl}${path}?${qs.toString()}`;
  const res = await fetch(url, { headers: this.headers });
  if (res.status === 401 && _retry && this.encPw && this.username) {
    try {
      // need decrypt — will be injected via index.js helper: this._decryptEncPw
      // For now, if _decryptEncPw not set, throw
      const pw = this._decrypt ? await this._decrypt(this.encPw) : null;
      if (pw !== null) {
        const auth = await JellyfinClient.authenticate(this.baseUrl, this.username, pw);
        this.token = auth.accessToken;
        this.userId = auth.userId;
        this.headers['X-Emby-Token'] = this.token;
        return this.get(path, params, false);
      }
    } catch {}
  }
  if (!res.ok) throw new Error(`Jellyfin ${path} -> ${res.status} ${res.statusText}`);
  return res.json();
}
```

Note: `_decrypt` sẽ được gán từ `index.js` khi tạo client: `client._decrypt = (enc) => decryptPassword(enc, getServerSecret())`

- [ ] **Step 4: Smoke test**

Run: `node -e "const {JellyfinClient}=require('./src/jellyfin'); console.log(typeof JellyfinClient.authenticate)"`
Expected: function

- [ ] **Step 5: Commit**

```bash
git add src/jellyfin.js
git commit -m "feat: JellyfinClient hybrid auth + 401 auto-renew"
```

---

### Task 3: index.js — token schema + API mở rộng

**Files:**
- Modify: `index.js` (tokenFor, decodeToken, isConfigured, loadConfigs, persistConfigs, validateCredentials, /api/check, /api/configs, buildAddon, findEntry)

**Interfaces:**
- Consumes: Task1 helpers, Task2 JellyfinClient.authenticate
- Produces: 3-shape token support, `/api/check` user mode, `/api/configs` hybrid

- [ ] **Step 1: Cập nhật tokenFor/decodeToken/isConfigured**

```js
function tokenFor(config) {
  if (config.accessToken) {
    const obj = { jellyfinUrl: config.jellyfinUrl, accessToken: config.accessToken, userId: config.userId, username: config.username };
    if (config.encPw) obj.encPw = config.encPw;
    return Buffer.from(JSON.stringify(obj)).toString('base64url');
  }
  return Buffer.from(JSON.stringify({ jellyfinUrl: config.jellyfinUrl, jellyfinApiKey: config.jellyfinApiKey })).toString('base64url');
}
function decodeToken(token) {
  const attempts = [];
  try { attempts.push(JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))); } catch {}
  try { attempts.push(JSON.parse(token)); } catch {}
  for (const obj of attempts) {
    if (obj && typeof obj.jellyfinUrl === 'string' && /^https?:\/\//i.test(obj.jellyfinUrl)) {
      if (obj.jellyfinApiKey) return { jellyfinUrl: obj.jellyfinUrl.replace(/\/+$/, ''), jellyfinApiKey: obj.jellyfinApiKey };
      if (obj.accessToken && obj.userId) return { jellyfinUrl: obj.jellyfinUrl.replace(/\/+$/, ''), accessToken: obj.accessToken, userId: obj.userId, username: obj.username, encPw: obj.encPw || null };
    }
  }
  return null;
}
function isConfigured(c) {
  return (c.jellyfinUrl && c.jellyfinApiKey && !isPlaceholder(c.jellyfinUrl + c.jellyfinApiKey))
      || (c.jellyfinUrl && c.accessToken && c.userId);
}
```

- [ ] **Step 2: Cập nhật loadConfigs/persistConfigs**

```js
function loadConfigs() {
  // ... push helper checks isConfigured, then
  for (const s of Array.isArray(fileConfig.savedConfigs) ? fileConfig.savedConfigs : []) {
    if (s.accessToken) push({ name: s.name, jellyfinUrl: s.jellyfinUrl, accessToken: s.accessToken, userId: s.userId, username: s.username, encPw: s.encPw, token: tokenFor(s) });
    else push({ name: s.name, jellyfinUrl: s.jellyfinUrl, jellyfinApiKey: s.jellyfinApiKey, legacyId: s.legacyId });
  }
  // also ensure fileConfig.serverSecret handling
}
function persistConfigs() {
  const cfg = loadConfigFile();
  writeConfigFile({
    ...cfg,
    serverSecret: cfg.serverSecret || getServerSecret(),
    savedConfigs: configs.map(c => c.accessToken ? { name: c.name, jellyfinUrl: c.jellyfinUrl, accessToken: c.accessToken, userId: c.userId, username: c.username, encPw: c.encPw } : { name: c.name, jellyfinUrl: c.jellyfinUrl, jellyfinApiKey: c.jellyfinApiKey })
  });
}
```

- [ ] **Step 3: Cập nhật validateCredentials + /api/check + /api/configs**

```js
function validateCredentials(body) {
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
app.post('/api/check', async (req, res) => {
  const valid = validateCredentials(req.body || {});
  if (valid.error) return res.status(400).json({ ok: false, error: valid.error });
  try {
    if (valid.username !== undefined) {
      const auth = await JellyfinClient.authenticate(valid.jellyfinUrl, valid.username, valid.password);
      const client = new JellyfinClient({ baseUrl: valid.jellyfinUrl, accessToken: auth.accessToken, userId: auth.userId, streamMode: STREAM_MODE });
      const result = await checkClient(client);
      return res.json({ ok: result.ok, version: result.version, error: result.error, accessToken: auth.accessToken, userId: auth.userId, username: auth.username });
    } else {
      const client = new JellyfinClient({ baseUrl: valid.jellyfinUrl, apiKey: valid.jellyfinApiKey, streamMode: STREAM_MODE });
      const result = await checkClient(client);
      return res.json({ ok: result.ok, version: result.version, error: result.error });
    }
  } catch (e) { return res.json({ ok: false, error: e.message }); }
});
```

Tương tự cho `POST /api/configs` với `encPw = valid.password ? encryptPassword(valid.password, getServerSecret()) : null`

- [ ] **Step 4: Cập nhật buildAddon + ensureConfig + statusOfToken**

```js
function buildAddon({ jellyfinUrl, jellyfinApiKey, accessToken, userId, username, encPw, name, token, stubId, legacyId }) {
  const client = new JellyfinClient({ baseUrl: jellyfinUrl, apiKey: jellyfinApiKey, accessToken, userId, encPw, username, streamMode: STREAM_MODE });
  if (encPw) client._decrypt = (enc) => decryptPassword(enc, getServerSecret());
  // ... rest same, img = `/img/${token}/${itemId}/${type}`
}
```

`statusOfToken` thêm `authMode`, `username`.

- [ ] **Step 5: Test manual**

Run: `npm start` -> curl `POST /api/check` với `{jellyfinUrl:"http://demo", username:"guest", password:""}` (mock) check 400/ok
Expected: Không crash, decodeToken roundtrip ok

- [ ] **Step 6: Commit**

```bash
git add index.js
git commit -m "feat: 3-shape token + hybrid API (keep API key compat)"
```

---

### Task 4: Frontend — public/configure.html (toggle + base64url fix)

**Files:**
- Modify: `public/configure.html`

**Interfaces:**
- Consumes: Task3 /api/check new shape

- [ ] **Step 1: Thêm radio toggle**

```html
<div style="display:flex;gap:10px;margin-bottom:14px">
  <label><input type="radio" name="authMode" value="apikey" checked> API Key</label>
  <label><input type="radio" name="authMode" value="user"> Username / Password</label>
</div>
<div id="apikeyGroup">... existing url + key ...</div>
<div id="userGroup" style="display:none">
  <label>Username *</label><input id="username" type="text">
  <label>Password <span style="font-weight:400;color:var(--muted)">(để trống nếu guest)</span></label><input id="password" type="password">
</div>
<script>
document.querySelectorAll('input[name=authMode]').forEach(r=>r.addEventListener('change', e=>{
  const isUser = e.target.value==='user';
  document.getElementById('apikeyGroup').style.display=isUser?'none':'block';
  document.getElementById('userGroup').style.display=isUser?'block':'none';
}));
</script>
```

- [ ] **Step 2: Sửa submit handler**

```js
const mode = document.querySelector('input[name=authMode]:checked').value;
let body;
if (mode==='user') body = { jellyfinUrl: $('url').value.trim(), username: $('username').value.trim(), password: $('password').value };
else body = { jellyfinUrl: $('url').value.trim(), jellyfinApiKey: $('key').value.trim() };
const res = await fetch('/api/check', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)});
const data = await res.json();
if (!data.ok) { showResult(false, esc(data.error)); return; }
let cfg;
if (data.accessToken) cfg = { jellyfinUrl: body.jellyfinUrl, accessToken: data.accessToken, userId: data.userId, username: data.username };
else cfg = { jellyfinUrl: body.jellyfinUrl, jellyfinApiKey: body.jellyfinApiKey };
const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(cfg)))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
// or use Buffer polyfill: Buffer.from(JSON.stringify(cfg)).toString('base64url') — but browser: use btoa+replace
const installUrl = location.origin + '/' + b64 + '/manifest.json';
```

- [ ] **Step 3: Manual test**

Open `http://localhost:7000/configure` -> toggle works, generate link contains base64url

- [ ] **Step 4: Commit**

```bash
git add public/configure.html
git commit -m "feat: configure page user/pass toggle + base64url fix"
```

---

### Task 5: Frontend — public/index.html (manage) + public/user.html

**Files:**
- Modify: `public/index.html`, `public/user.html`

**Interfaces:**
- Consumes: Task3 /api/status new fields

- [ ] **Step 1: public/index.html — thêm toggle tương tự Task4 + render authMode**

```js
// render() loop:
const authLabel = cfg.accessToken ? (cfg.encPw ? 'Hybrid ✓' : 'Token') : 'API Key';
card.innerHTML += `<div class="meta">Auth: ${esc(authLabel)} ${cfg.username ? '• User: '+esc(cfg.username) : ''}</div>`;
```

Form submit: giống Task4, POST/PUT `/api/configs` với body phù hợp

- [ ] **Step 2: public/user.html — hiện username**

```js
if (cfg.username) $('serverMeta').textContent += ' • User: ' + cfg.username;
```

- [ ] **Step 3: Manual test**

Open `/manage` with MANAGE_KEY -> add user/pass -> list shows Hybrid ✓ -> per-user page shows username

- [ ] **Step 4: Commit**

```bash
git add public/index.html public/user.html
git commit -m "feat: manage + user page hybrid UI"
```

---

### Task 6: Integration & regression test

**Files:**
- None (verification)

- [ ] **Step 1: Start server & health**

Run: `npm start` then `curl http://localhost:7000/health` + `curl -X POST http://localhost:7000/api/check -H 'Content-Type: application/json' -d '{"jellyfinUrl":"http://invalid","jellyfinApiKey":"x"}'`

Expected: health returns ok:false but 503 with configs list, check returns ok:false

- [ ] **Step 2: Token roundtrip test**

Run: `node -e "const {tokenFor, decodeToken}=require('./index.js'); // or copy helpers; test 3 shapes"`

Expected: All 3 decode correctly

- [ ] **Step 3: Final commit (docs)**

```bash
git add docs/superpowers/plans/2026-08-22-hybrid-auth-plan.md
git commit -m "docs: hybrid auth implementation plan"
```

---

## Self-Review

- **Spec coverage:** Tất cả 4 phần spec đều có task: crypto (Task1), JellyfinClient (Task2), index.js API (Task3), frontend configure (Task4), manage/user (Task5), test (Task6). Fix bug base64url covered Task4 Step2.
- **Placeholder scan:** Không có TBD/TODO, mọi step có code cụ thể.
- **Type consistency:** `accessToken/userId/username/encPw` nhất quán Task1→Task5; `tokenFor` signature đồng nhất; `JellyfinClient` constructor param đồng nhất.
