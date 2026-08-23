# Multi-host UI + Requests + Posters + Catalog toggles Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task.

**Goal:** 1) Fix poster không hiện (absolute URLs), 2) UI Add another server gộp hosts, 3) Request integration Jellyseerr/Overseerr/Ombi với virtual stream khi phim chưa có, 4) Toggle catalogs trong config page.

**Architecture:** Poster absolute qua `publicBase` middleware (env ADDON_BASE_URL override). configure.html render N host cards. Mỗi host optional `request:{type,url,apiKey}`; streamHandler trả virtual stream `${publicBase}/r/<token>/<type>/<id>` khi không tìm thấy phim; GET /r/... resolve IMDb→TMDB via Cinemeta rồi POST sang service, respond mp4 placeholder. Token thêm optional `catalogs:{movies,series,genre}` filter manifest.

**Tech Stack:** Node 18+, Express, vanilla JS, existing crypto helpers cho encReqKey at-rest.

## Global Constraints

- Node >=18, no new deps
- Backward compat toàn bộ token shapes cũ
- Không plaintext apiKey của request service trong config.json (mã hoá encReqKey); trong token URL chấp nhận plaintext (cùng exposure class với accessToken)
- Virtual stream phải trả video hợp lệ (mp4 bytes) để player không lỗi
- esc() mọi prefill; password/apiKey không prefill

---

### Task 1: Fix poster absolute URLs

**Files:** Modify `index.js`
- Middleware capture `req.headers['x-forwarded-proto']||req.protocol` + `req.headers.host` → `latestPublicBase`; env `ADDON_BASE_URL` override.
- `buildAddon`: `const img=(itemId,type)=>`${publicBase()}/img/${token}/${itemId}/${type}```
- publicBase(): `ADDON_BASE_URL || latestPublicBase || http://localhost:PORT`
- Steps: implement → node --check → update merge-hosts.test assert poster starts with http → commit `fix: absolute poster/backdrop URLs`

### Task 2: UI Add another server

**Files:** Modify `public/configure.html`
- Host cards dynamic (template clone): name/url/mode radio/key/user/pass + Remove ×
- "+ Add another server" button; per-host Test button gọi /api/check
- Generate: build hosts[] từ cards (skip empty) → single nếu 1 host → tokenFor shape như backend (hosts wrapper chỉ khi >1)
- Prefill ?token=: parse hosts[] render đủ N cards
- Steps: implement → Playwright smoke → commit `feat: multi-host configure UI`

### Task 3: Request integration + virtual stream

**Files:** Modify `index.js`, `src/jellyfin.js` (không), new `src/requests.js`
- `src/requests.js`: adapters jellyseerr/overseerr (`POST /api/v1/request {mediaType, mediaId}`, header X-Api-Key), ombi (`POST /api/v1/Request/movie {theMovieDbId}` | tv {theMovieDbId}, header ApiKey). resolveTmdb(imdb,type) via Cinemeta meta JSON `.moviedb_id`, cache Map TTL 1h.
- index.js: host schema `request:{type,url,apiKey}`; persist encReqKey = encrypt(apiKey); buildAddon pass through; streamHandler: nếu streams rỗng && hosts có request → push virtual stream url `${publicBase()}/r/${token}/${type}/${encodeURIComponent(id)}` name `📥 Request via <Type>` description 'Plays a short placeholder while submitting your request'.
- Route `GET /r/:token/:type/:id`: findEntry, collect hosts có request, resolve tmdb, POST từng service đến khi 2xx/201 hoặc đã hết; respond mp4 placeholder (base64 ~1KB) Content-Type video/mp4 luôn 200.
- Steps: implement → unit mock test requests.test.js → commit `feat: media request integration with placeholder stream`

### Task 4: Catalog toggles

**Files:** Modify `index.js`, `public/configure.html`
- decodeToken giữ `catalogs`; buildAddon filter manifest.catalogs theo `{movies:true,series:true,genre:true}` default
- configure.html: 3 checkbox Movies/Series/Genres; generate nhúng catalogs vào token (chỉ khi có false)
- Steps: implement → test manifest catalogs count → commit `feat: per-token catalog toggles`

### Task 5: Integration test + push

- Extend merge-hosts.test: poster absolute, catalogs toggle, virtual request flow với mock jellyseerr
- Run all tests, commit docs plan, push fork main+hybrid-auth

## Self-Review
- Coverage: 4 yêu cầu user ↔ T1..T4, test T5 ✓
- No placeholders ✓
- Shapes nhất quán hosts/request/catalogs ✓
