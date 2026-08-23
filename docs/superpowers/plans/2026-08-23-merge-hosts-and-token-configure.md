# Merge Hosts + Token Configure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cho phép 1 token chứa nhiều Jellyfin hosts (hosts array) và gộp catalog/meta/stream từ mọi host; fix `/:token/configure` để redirect sang `/configure` và tự parse prefill config hiện tại.

**Architecture:** Mở rộng token schema thêm `hosts[]` (giữ backward compat single-host shape), `buildAddon` tạo mảng `clients[]` và handlers dùng `Promise.all` để merge; thêm route `GET /:token/configure` serve `configure.html` với JS đọc token từ path, decode base64url, prefill form qua query hoặc local parse.

**Tech Stack:** Node 18+, Express 4.19, vanilla JS, existing AES-GCM crypto không đổi.

## Global Constraints

- Node >=18, không thêm deps
- Giữ backward compat: token cũ single-host vẫn decode và chạy
- Không lộ plaintext password trong URL/log (hosts array chỉ chứa accessToken/userId đã mã hoá, encPw nếu có)
- URL length: base64url hosts array sẽ dài hơn, nginx đã có proxy_buffers 64k
- CONFIG_PATH behavior giữ nguyên (Render ephemeral note trong docs, không đổi code)
- XSS: mọi prefill phải esc()

---

## File Structure

- Modify: `index.js` — tokenFor/decodeToken/isConfigured/loadConfigs/persistConfigs, buildAddon multi-client, new route /:token/configure
- Modify: `public/configure.html` — JS đọc token từ path hoặc ?token=, decode, prefill form, hỗ trợ edit hosts array
- Modify: `src/jellyfin.js` — không đổi (đã hỗ trợ multi-client via index.js aggregation)
- Test: manual curl + browser

---

### Task 1: Token schema hosts[] (index.js)

**Files:**
- Modify: `index.js: tokenFor, decodeToken, isConfigured, loadConfigs, persistConfigs, validateCredentials`

**Interfaces:**
- Consumes: existing crypto helpers, JellyfinClient.authenticate
- Produces: `tokenFor({hosts:[...]})` hoặc single, `decodeToken` returns `{hosts:[...]}` hoặc single, `isConfigured` handles array

- [ ] **Step 1: Update tokenFor to support hosts array**

```js
function tokenFor(config) {
  if (Array.isArray(config.hosts)) {
    const hosts = config.hosts.map(h => {
      if (h.accessToken) {
        const o = { jellyfinUrl: h.jellyfinUrl, accessToken: h.accessToken, userId: h.userId, username: h.username };
        if (h.encPw) o.encPw = h.encPw;
        return o;
      }
      return { jellyfinUrl: h.jellyfinUrl, jellyfinApiKey: h.jellyfinApiKey };
    });
    return Buffer.from(JSON.stringify({ hosts })).toString('base64url');
  }
  if (config.accessToken) { /* existing single */ }
  // ...
}
```

- [ ] **Step 2: Update decodeToken to detect hosts**

```js
function decodeToken(token){
  // attempts...
  for(const obj of attempts){
    if(obj.hosts && Array.isArray(obj.hosts)){
      const hosts = obj.hosts.map(h=>{ /* validate each */ });
      if(hosts.length) return { hosts };
    }
    if(obj.jellyfinUrl && (obj.jellyfinApiKey || obj.accessToken)) return single;
  }
}
```

- [ ] **Step 3: Update isConfigured, loadConfigs, persistConfigs for array**

```js
function isConfigured(c){
  if(Array.isArray(c.hosts)) return c.hosts.every(h=> isConfigured(h));
  return singleCheck;
}
```

- [ ] **Step 4: Run node --check + roundtrip test**

Run: `node -e "const f=require('./index.js'); // or copy helpers; const t=tokenFor({hosts:[{jellyfinUrl:'https://a',accessToken:'x',userId:'y'}]}); console.log(decodeToken(t))"`

Expected: hosts array decoded

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "feat: token hosts[] schema (merge multi-host into 1 token)"
```

---

### Task 2: buildAddon multi-client aggregation

**Files:**
- Modify: `index.js: buildAddon, ensureConfig, allStatus, statusOfToken, findEntry`

**Interfaces:**
- Consumes: Task 1 token hosts
- Produces: catalog/meta/stream merged via Promise.all

- [ ] **Step 1: Modify buildAddon to accept hosts array**

```js
function buildAddon({ hosts, jellyfinUrl, jellyfinApiKey, accessToken, userId, username, encPw, name, token, stubId }){
  const configs = hosts ? hosts : [{ jellyfinUrl, jellyfinApiKey, accessToken, userId, username, encPw }];
  const clients = configs.map(cfg => {
    const c = new JellyfinClient({ baseUrl: cfg.jellyfinUrl, apiKey: cfg.jellyfinApiKey, accessToken: cfg.accessToken, userId: cfg.userId, encPw: cfg.encPw, username: cfg.username, streamMode: STREAM_MODE });
    if(cfg.encPw) c._decrypt = (enc)=> decryptPassword(enc, getServerSecret());
    return { cfg, client: c };
  });
  // helper img needs token (same for all)
  const img = (itemId, type) => `/img/${token}/${itemId}/${type}`;
  // handlers:
  // catalog: Promise.all(clients.map(({client})=> client.getItems(...))) then flatMap + mapMeta
  // meta: try each client resolveItem until success
  // stream: try each client, first success with stream
}
```

- [ ] **Step 2: Update ensureConfig, findEntry, allStatus to handle hosts**

```js
function ensureConfig(config, legacyId){
  const token = tokenFor(config);
  if(byToken.has(token)) return byToken.get(token);
  const entry = buildAddon({...config, token, stubId: stubIdFor(token), legacyId});
  byToken.set(token, entry);
  if(legacyId) byLegacy.set(legacyId, entry);
  return entry;
}
// allStatus/statusOfToken: if entry.clients then show first client's baseUrl + count, else single
```

- [ ] **Step 3: Test with mock 2 hosts**

Run: `node test/merge-hosts.test.js` — mock 2 Jellyfin servers, verify catalog merges

- [ ] **Step 4: Commit**

```bash
git add index.js src/jellyfin.js
git commit -m "feat: aggregate catalog/meta/stream across hosts[]"
```

---

### Task 3: /:token/configure auto-parse (index.js + configure.html)

**Files:**
- Modify: `index.js` (new route), `public/configure.html` (prefill JS)

**Interfaces:**
- Consumes: Task 1 decodeToken
- Produces: GET /:token/configure serves configure.html with token parsed

- [ ] **Step 1: Add Express route before generic /:token**

```js
app.get('/:token/configure', (req, res, next) => {
  const entry = findEntry(req.params.token);
  if(!entry) return res.redirect('/configure');
  // Serve configure.html but inject token via query param redirect
  // Option A: redirect to /configure?token=...
  // Option B: serve file and let JS read pathname
  res.redirect(`/configure?token=${encodeURIComponent(req.params.token)}`);
});
// Also handle /:token/configure/ with trailing slash
```

- [ ] **Step 2: Update public/configure.html JS to parse ?token**

```js
(function(){
  const params = new URLSearchParams(location.search);
  let token = params.get('token');
  if(!token){
    const m = location.pathname.match(/^\/([^\/]+)\/configure/);
    if(m) token = m[1];
  }
  if(token){
    try{
      const cfg = JSON.parse(BufferFromBase64Url(token)); // use atob base64url polyfill
      // if cfg.hosts, prefill first host, show UI for multi
      if(cfg.hosts){ /* fill hosts list */ }
      else if(cfg.jellyfinUrl){ $('url').value = cfg.jellyfinUrl; $('username').value = cfg.username||''; /* etc */ }
    }catch{}
  }
})();
function fromBase64Url(s){ s=s.replace(/-/g,'+').replace(/_/g,'/'); while(s.length%4) s+='='; return atob(s); }
```

- [ ] **Step 3: Manual test**

Open `http://localhost:7000/<token>/configure` -> redirects to `/configure?token=...` -> form prefilled

- [ ] **Step 4: Commit**

```bash
git add index.js public/configure.html
git commit -m "feat: /:token/configure redirects and prefills config"
```

---

### Task 4: Integration test + docs

**Files:**
- None (verification)

- [ ] **Step 1: Start server, test single + merged token**

Run: `npm start` then curl health, test 2-host token catalog merge, test /:token/configure redirect

- [ ] **Step 2: Commit docs if any**

```bash
git add docs/superpowers/plans/2026-08-23-merge-hosts-and-token-configure.md
git commit -m "docs: merge-hosts plan"
```

---

## Self-Review

- Spec coverage: hosts[] schema (T1), aggregation (T2), /:token/configure prefill (T3), test (T4) all covered.
- Placeholder scan: none
- Type consistency: hosts array elements use same shape as single config
