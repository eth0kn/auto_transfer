# CLAUDE.md — Jangkar Konteks untuk Claude

> File ini di-load Claude di awal setiap sesi. Baca ini dulu sebelum eksekusi apapun.

---

## 1. Ringkasan Proyek

**Nama:** `auto_transfer` — Backend service (Node.js + Express 5 + Socket.io + MySQL) untuk validasi + dispatch job transfer bank.

**Fungsi utama:**
1. Terima job transfer via REST `/transfer` dari admin/external (X-API-KEY protected).
2. Dispatch job ke bot client (brimoclientapp / mybcaclientapp) via WebSocket.
3. Terima laporan konfirmasi extraction dari bot (`/validate-confirmation`) → tampilkan di dashboard admin.
4. Admin decide PROCEED/ABORT via dashboard → server push decision ke bot via socket.
5. Terima final status (`/update-task`) → catat SUCCESS/FAILED + ref number.

**Deploy target:** VPS `okta-prod` (13.228.167.183), Ubuntu, MySQL 8, PM2 process manager (user `robot`).

**Status (2026-10-29):** Unified backend `:3010` production-ready, serving 3 bot client (brimo + mybca + seabank) via URL prefix. Legacy `:3005` + `:3006` deprecated. Latest features: **F1 Auto-Approve toggle** (global, DB-backed) + **F2 Transfer Status endpoint** — detail di `docs/feature-impl-2026-10-29.md`.

---

## 2. Aturan Kerja untuk Claude (WAJIB)

1. **Zero asumsi.** Kalau tidak yakin behavior endpoint, socket event, atau shape payload — baca `docs/API-CONTRACT.md` dulu. Kalau spec belum ada, tanya user, jangan tebak.
2. **Bot compatibility di atas segalanya.** Backend ini di-consume oleh brimoclientapp + mybcaclientapp (repo terpisah). Setiap perubahan shape response, event socket, atau URL path = potensi bot broken. Setiap breaking change WAJIB approval user + coordinated bot release.
3. **No production impact tanpa izin.** File `index.js` (backend main) tidak boleh di-touch tanpa alasan jelas + user aware. Setelah edit, test dulu di dev mode sebelum deploy.
4. **Docs sebagai memory.** Setiap keputusan arsitektur, endpoint change, migration step — WAJIB catat di `docs/`. Jangan biarkan decision hanya hidup di conversation.
5. **Deployment butuh explicit approval.** File `.env` di VPS harus di-review. `pm2 restart` di VPS harus dikonfirmasi user dulu.
6. **Blue-green dulu, big-bang belakangan.** Kalau ada migration (misal port 3005 → 3010), jalankan parallel dulu, verifikasi, baru matikan yang lama.
7. **Post-fix mini-scan mandatory (G1).** Setiap apply fix dari vulnerability/audit scan WAJIB diikuti mini-scan secondary (sub-agent fork) yang audit code **POST-fix** (bukan pre-fix) dalam konteks downstream flow — **SEBELUM commit + deploy ke VPS**, bukan setelah user report. Scope minimum: simulate end-to-end 2-3 scenarios (happy-path + reject-path + double-trigger/concurrency kalau applicable). Rationale: fix inisial sering overshoot/undershoot — scan pre-fix audit code lama, fix diterapkan, tapi fix itu sendiri intro regresi yang tidak terlihat sampai scan ulang atau worst-case prod incident. Historis konkret: v4.0.2 W1 cross-fix unconditionally wipe dispatcher state di happy-path → V2-F7 CRITICAL regression (W1 revision gate `busyWithTaskId === task_id` solve). Mini-scan W5 pada 2026-11-01 prevented W2 regression dari lolos ke prod — proof concept effective.

---

## 3. Struktur Folder

```
auto_transfer/
├── index.js                # Main backend (Express + Socket.io + MySQL)
├── package.json
├── env.example             # Template — jangan commit .env aktual
├── auto_transfer_db.sql    # Schema legacy (2 tabel, single-app)
├── schema-unified.sql      # 🆕 Schema unified (app_source column)
├── app.js / app1.js / app2.js / server.js  # ⚠️ Historical iterations — DO NOT edit, referensi only
├── docs/                   # 📖 Memory + spec (di-gitignore)
│   ├── INDEX.md            # Peta docs
│   ├── MEMORY.md           # Keputusan + rationale historis
│   ├── ARCHITECTURE.md     # System design
│   ├── API-CONTRACT.md     # Endpoint + socket event spec (bot ↔ backend)
│   ├── DASHBOARD-DESIGN.md # UI spec dashboard admin
│   ├── DEPLOYMENT.md       # VPS setup, PM2, env, cutover
│   ├── MIGRATION.md        # Blueprint migrasi :3005+:3006 → :3010
│   ├── IMPACT-ASSESSMENT.md # Perubahan yang diperlukan di brimo/mybca bot
│   └── DECISIONS.md        # Open questions + user decisions log
└── CLAUDE.md               # File ini
```

---

## 4. Peta Docs

Setiap sesi baru, buka `docs/INDEX.md` untuk status terkini. Order rekomendasi baca:

1. `CLAUDE.md` (ini)
2. `docs/MEMORY.md` — sudah pernah diputuskan apa?
3. `docs/ARCHITECTURE.md` — bagaimana sistemnya jalan?
4. `docs/API-CONTRACT.md` — kalau mau utak-atik endpoint / socket
5. `docs/DEPLOYMENT.md` — kalau mau touching VPS
6. `docs/MIGRATION.md` — status migrasi 3005/3006 → 3010

---

## 5. Konteks Runtime

- **Node:** ≥18 (Express 5 + socket.io 4.x)
- **DB:** MySQL 8, connection pool via `mysql2/promise`
- **Server API port (unified target):** `3010`
- **Server API port (legacy brimo):** `3005` — will be deprecated post-cutover
- **Server API port (legacy mybca):** `3006` — will be deprecated post-cutover
- **VPS:** `okta-prod` (13.228.167.183), user `robot`, PM2 God Daemon
- **VPS layout:**
  - Legacy: `/var/automate/brimo/auto_transfer/` + `/var/automate/mybca/auto_transfer/`
  - Unified: `/var/automate/auto_transfer/` (per user decision Q-07, 2026-09-24)
- **Bots yang consume:**
  - `brimoclientapp` (repo `C:\Users\KN\Documents\mygit\brimoclientapp`), current v3.7.0
  - `mybcaclientapp` (repo `C:\Users\KN\Documents\mygit\mybcaclientapp`), current v3.6.0
  - `seabankclientapp` (repo `C:\Users\KN\Documents\mygit\seabankclientapp`), current v1.0.0
  - Bot connect ke `SERVER_API_URL` yang di-hardcode di `main.js`, format: `http://13.228.167.183:3010/{app_source}`

---

## 🆕 5a. Fitur Baru 2026-10-29 (F1 + F2)

### F1 — Auto-Approve Global Toggle

Admin dashboard bisa toggle "Auto-Approve" di header. Saat ON, semua `/{app}/validate-confirmation` request dari bot (brimo/mybca/seabank) langsung di-approve immediate (status PROCEED, decision_source=AUTO) tanpa menunggu admin manual review atau 60s timeout.

- **State persistence:** DB table `app_config` (key-value). Row `auto_approve_enabled` di-load ke in-memory flag saat boot.
- **Endpoints:** `GET/POST /api/auto-approve/status|enable|disable` (semua `requireAuth` cookie).
- **Socket broadcast:** `auto_approve:state` event untuk sync cross-tab dashboard.
- **Audit trail:** column `transfer_validations.decision_source` ENUM(`ADMIN`,`TIMEOUT`,`AUTO`) tracks who approved.
- **Default state:** OFF (safe default — admin eksplisit enable).

### F2 — Transfer Status Endpoint

External client (bot or external integration) bisa cek status transfer by task_id.

- **Endpoint:** `GET /{app}/transfer-status/:task_id` (3 instansi: /brimo, /mybca, /seabank)
- **Auth:** `X-API-KEY` header (mirror `/transfer`)
- **Response:** Rich 13-field JSON (status, amount, dest, bank_type, ref_number, message, validation_status, decision_source, bot_alias, timestamps)
- **Derived status enum:** `PENDING`, `PROCESSING`, `AWAITING_VALIDATION`, `SUCCESS`, `FAILED`, `NOT_FOUND`
- **Error:** 400 invalid format, 401 bad key, 404 not found, 500 DB error

**Detail implementation + dev-test + rollback plan:** `docs/feature-impl-2026-10-29.md`.

---

## 🆕 5b. Fitur Baru 2026-11-02 (v4.1.0 — Transfer Status Callback)

### Konsep

API caller boleh ikutkan `callback_url` + `callback_secret` opsional di `POST /{app}/transfer`. Setelah transfer selesai (SUCCESS/FAILED/CANCELLED), backend POST **payload status + saldo akhir** ke `callback_url` lewat worker queue async — di luar critical path dispatcher.

### Komponen Baru

- **`callback-security.js`** — SSRF validator (private IP, metadata IP, CGNAT 100.64/10, IPv6 lokal, hostname blocklist, DNS lookup) + HMAC-SHA256 payload signer + delivery_id UUID generator + secret length validator (16-128 chars). Dipakai 2 titik: create-time (`POST /transfer`) + delivery-time (worker DNS poison guard).
- **`callback-worker.js`** — DB-backed queue + tick worker. Interval 10s default (`CALLBACK_WORKER_INTERVAL_MS`), batch 20 (`CALLBACK_WORKER_BATCH`), timeout 10s per request (`CALLBACK_TIMEOUT_MS`). Exponential backoff `[30s, 2m, 10m, 1h]` ±25% jitter. 4xx → DEAD immediate, 5xx/timeout/net → retry up to 5 attempts atau 24h age. Graceful shutdown SIGTERM/SIGINT. Admin helpers: `getStats`, `listDead`, `replayTask`.
- **DB migration** `migrations/2026-11-01_add_callback_fields.sql` — 10 kolom tambah di `transfer_request` (balance_after, balance_source, callback_url/secret/status/attempts/last_error/next_attempt_at/last_attempt_at/delivered_at) + index `idx_callback_pending`. Blue-green safe additive.
- **`index.js` 6 edits** — require callback modules + ADMIN_API_KEY const + requireAdminKey middleware + POST /{app}/transfer accept + validate callback field + POST /update-task accept balance_after/balance_source + atomic transactional outbox UPDATE (status+callback_status NONE→PENDING satu statement) + signalPickup fire-and-forget AFTER res.json + 3 admin endpoints + SIGTERM graceful shutdown + worker start on server.listen.

### Semantics

- **At-least-once delivery** dengan task_id sebagai dedupe key — receiver WAJIB idempotent per task_id (karena HTTP semantic: 2xx = DELIVERED, 4xx = DEAD, 5xx + timeout + net error = retry → receiver mungkin terima dupe).
- **Transactional outbox** — status finalize + callback enqueue di 1 UPDATE statement, zero race.
- **Fire-and-forget** — `signalPickup()` setelah `res.json({success:true})`, dispatcher critical section unaffected oleh callback latency.
- **HMAC-SHA256 header** `X-Callback-Signature: sha256=<hex>` kalau `callback_secret` di-provide → receiver verify auth of payload.
- **Balance semantics** — `balance_after` + `balance_source` (SCRAPED/COMPUTED/UNAVAILABLE). Clientapp F1 primary re-scrape post-transfer, F3 fallback compute `balance_before - amount - admin_fee`. See doc §6k.

### Admin Endpoints (require `X-Admin-Key: $ADMIN_API_KEY`)

- `GET /api/admin/callbacks/stats?hours=24` — counts PENDING/DELIVERED/DEAD, retry_distribution, delivery_latency
- `GET /api/admin/callbacks/dead?limit=50&offset=0` — paginated dead-letter list
- `POST /api/admin/callbacks/replay/:task_id` — reset DEAD → PENDING, next_attempt_at=NOW, attempts=0

Tanpa `ADMIN_API_KEY` di env → endpoints balikin 503 `feature not configured`.

### ENV Baru (lihat `env.example`)

- `ADMIN_API_KEY` (WAJIB prod, kalau mau pakai admin endpoints)
- `CALLBACK_WORKER_INTERVAL_MS` (default 10000)
- `CALLBACK_WORKER_BATCH` (default 20)
- `CALLBACK_TIMEOUT_MS` (default 10000)
- `CALLBACK_MAX_ATTEMPTS` (default 5)
- `CALLBACK_MAX_AGE_HOURS` (default 24)

### Status

- **M3 Backend v4.1.0 code done 2026-11-02** — Track A node --check + require smoke + SSRF 10-URL test + HMAC verify PASS. Siap commit, belum deploy VPS.
- **M4 Clientapp 3-app** — pending (brimo first per release plan).

**Detail spec + decision log D1-D10 + release plan 4-repo + testing matrix:** `docs/feature-callback-2026-11-01.md`.

---

## 6. Alur Kerja Rekomendasi per Sesi

1. Baca `CLAUDE.md` (ini)
2. Baca `docs/INDEX.md`
3. Kalau user minta ubah endpoint / socket event → baca `docs/API-CONTRACT.md` dulu, cek impact ke bot
4. Kalau user minta ubah UI dashboard → baca `docs/DASHBOARD-DESIGN.md`
5. Kalau user minta deploy → ikuti `docs/DEPLOYMENT.md`, minta konfirmasi tiap step
6. Kalau user report bug → cek `docs/MEMORY.md` — mungkin bug pernah dibahas

---

## 7. Kontak & Kepemilikan

- **Owner:** KN (`mknizar10@gmail.com`)
- **Repo:** local git di `C:\Users\KN\Documents\mygit\auto_transfer`
- **Deploy target:** VPS Ubuntu `okta-prod` via SSH
