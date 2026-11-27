# CLAUDE.md — auto_transfer Backend Context

> **Backend service** untuk 3 clientapp (brimo + mybca + seabank). Baca file ini di awal setiap sesi — self-contained, zero required cross-read.
>
> **Status (2026-11-27)**: unified backend `v4.5.1` production di okta-prod `:3010`. 2 PM2 process: `unified-backend` (main) + `telegram-bot` (Telegraf remote CRUD). MySQL 8 unified schema serving brimo/mybca/seabank via URL prefix. Governance **independent** per §13 (no sync markers, not target sync-governance.js).

---

## 1. Ringkasan Proyek

**Nama:** `auto_transfer` — Backend service Node.js + Express 5 + Socket.io 4 + MySQL 8 untuk validasi + dispatch job transfer bank.

**Fungsi utama:**
1. REST `/transfer` — terima job transfer dari admin dashboard / Telegram bot / external integration (X-API-KEY protected)
2. Socket.io serial dispatcher per-alias — push `task:new` ke bot clientapp (brimo/mybca/seabank), ACK-based single-slot per alias
3. Validation flow — bot push `/validate-confirmation` → dashboard WAITING → admin PROCEED/ABORT (manual, auto-approve, atau 60s timeout)
4. Final reporting — bot `/update-task` → transactional outbox (status finalize + callback enqueue dalam 1 UPDATE)
5. Callback worker — async HMAC-signed POST ke callback_url dengan exponential backoff + dead-letter + SSRF guard (v4.1.0)
6. **Telegram Bot CRUD remote** (v4.3.x+) — operator/owner multi-RDP account management via Telegraf, round-trip REST IPC → socket emit ke clientapp
7. **Multi-user dashboard** (v4.1.5+) — bcrypt + DB-backed admin auth + session cookies
8. **Headscale integration** (dashboard UI) — pre-auth key register flow + auto-accept toggle

**Deploy target:** VPS `okta-prod` (13.228.167.183), Ubuntu 24.04.2 LTS, MySQL 8.0.44, Node 22.21.1, PM2 6.0.14 (user `robot`).

**Consumer clientapp (3 repos, all at v4.6.0 per 2026-11-27):**
- `brimoclientapp` — BRI Mobile automation
- `mybcaclientapp` — BCA Mobile automation
- `seabankclientapp` — SeaBank automation

**Current baseline:** git tag `v4.5.1` (2026-11-23) — Telegram bot hotfix 1-2 (`rdp:control_register` upsert + `bot:register` backfill `bound_ts_ip`). Package.json `version` stale di `2.0.0` — tag git = canonical per §11 R6.

---

## 2. Aturan Kerja untuk Claude (WAJIB)

1. **Zero asumsi.** Kalau tidak yakin behavior endpoint, socket event, atau shape payload — baca `docs/API-CONTRACT.md` dulu. Kalau spec belum ada, tanya user, jangan tebak.

2. **Bot compatibility di atas segalanya.** Backend ini di-consume oleh 3 clientapp (brimo + mybca + seabank). Setiap perubahan shape response, event socket, atau URL path = potensi bot broken. Setiap breaking change WAJIB approval user + coordinated bot release (lihat §10 MANDATE Cross-Clientapp Awareness).

3. **No production impact tanpa izin.** Guarded files — tidak boleh di-touch tanpa alasan jelas + user aware + options-first per §8 R3: `index.js`, `telegram-bot/handlers/operator.js`, `callback-worker.js`, `callback-security.js`, `telegram-bot-ipc.js`, `ecosystem.config.js`, `schema-unified.sql`, semua file di `migrations/`. Setelah edit, test dulu di dev mode sebelum deploy.

4. **Docs sebagai memory.** Setiap keputusan arsitektur, endpoint change, migration step — WAJIB catat di `docs/`. Jangan biarkan decision hanya hidup di conversation.

5. **Deployment butuh explicit approval.** File `.env` di VPS harus di-review. `pm2 reload` di VPS harus dikonfirmasi user dulu. Full discipline di §11 MANDATE Backend Deploy Discipline.

6. **Blue-green dulu, big-bang belakangan.** Kalau ada migration (schema change, port cutover, protocol upgrade), jalankan parallel dulu, verifikasi, baru matikan yang lama. Lihat §12 MANDATE DB Migration Safety.

7. **Komunikasi chat WAJIB bahasa Indonesia.** Semua respon Claude ke user harus bahasa Indonesia. Code (identifier, komentar inline) boleh bahasa Inggris. Docs internal fleksibel.

8. **Feature test SETIAP KALI selesai implementasi.** Setelah apply code change, Claude WAJIB proactive guide user ke dev-test dengan skenario relevan — jangan tunggu user minta. Backend specific: `npm run dev` + curl endpoint affected, atau smoke test via dashboard. Kalau touch schema → verify migration applies di dev DB dulu.

---

## 3. Struktur Folder

```
auto_transfer/
├── index.js                          # 🔴 Main backend monolithic (3300+ LOC) — Express 5 + Socket.io 4 + MySQL pool, all routes + dashboard HTML + Headscale UI
├── callback-worker.js                # 🔴 v4.1.0 DB-backed queue tick worker, exponential backoff, HMAC signer
├── callback-security.js              # 🔴 SSRF validator + HMAC-SHA256 payload signer + delivery_id UUID + secret validator
├── telegram-bot-ipc.js               # 🔴 v4.3.x REST IPC router (742 LOC) mounted at /api/tg/*, loopback-only + Bearer auth
├── ecosystem.config.js               # 🔴 PM2 config — 2 apps: unified-backend + telegram-bot
├── package.json                      # name=auto_transfer, version=2.0.0 (STALE — tag git v4.5.1 = canonical per §11 R6)
├── env.example                       # Template .env untuk production (sync WAJIB per §11 R1)
├── schema-unified.sql                # Current schema (app_source column, callback cols v4.1.0, full index set)
├── auto_transfer_db.sql              # Legacy schema (pre-unified, 2-table single-app)
├── migrations/
│   ├── 2026-11-01_add_callback_fields.sql   # v4.1.0 — 10 callback cols + idx_callback_pending
│   ├── 2026-11-21_add_dashboard_users.sql   # v4.1.5 — bcrypt multi-user
│   └── 2026-11-22_add_telegram_bot_tables.sql  # v4.3.0 — operators, rdp_registry, tg_audit_log, wizard_sessions
├── telegram-bot/                     # 🔴 Sibling PM2 process (Telegraf, NOT nested in main)
│   ├── index.js                      # Telegraf init + health + launch + setMyCommands publish (152 LOC)
│   ├── middleware.js                 # 3-tier defense (private only, no forward, role resolve) + requireRole guard
│   ├── wizard.js                     # Wizard CRUD atomic CAS (JSON_SET + JSON_MERGE_PATCH) + expected-step gate
│   ├── db.js                         # MySQL pool own (limit 10, separate dari unified-backend pool 50)
│   ├── util.js                       # escapeHtml()
│   ├── audit.js                      # logAudit() fail-open → tg_audit_log
│   ├── shadow.js                     # Owner observability forward + rate-limit cooldown + batched drops
│   ├── backend-client.js             # axios wrapper ke http://127.0.0.1:3010/api/tg/* + Bearer
│   ├── handlers/
│   │   ├── index.js                  # Handler registry — bot.command() + bot.action() wiring
│   │   ├── public.js                 # /start /whoami /help (ALL role)
│   │   ├── operator.js               # 🔴 Monolithic 1582 LOC — /list /status /delete /edit /add /start_bot /stop_bot /list_accounts + inline picker handlers
│   │   ├── owner.js                  # /list_rdp /approve_rdp /revoke_rdp /list_operators /create_operator /revoke_operator /delete_operator /shadow /audit
│   │   └── wizard.js                 # /cancel + routeWizardText() dispatcher
│   └── package.json                  # Sub-package deps — telegraf, mysql2, axios, socket.io-client
├── scripts/
│   └── add-user.js                   # CRUD helper untuk dashboard_users (bcrypt hash + insert)
├── docs/                             # 📖 Primary memory (18 files, 6066 LOC) — gitignored
└── CLAUDE.md                         # File ini
```

**Legacy files (do-not-edit, reference only):**
- `app.js`, `app1.js`, `app2.js`, `server.js` — historical iterations pre-unified, archived at root untuk regression lookup. Tidak di-touch sejak v3.4 unified cutover (2026-09-24).

---

## 4. Peta Docs

Setiap sesi baru, buka `docs/INDEX.md` untuk status terkini. Order rekomendasi baca:

1. `CLAUDE.md` (ini — self-contained)
2. `docs/MEMORY.md` — decision log D-01 to D-15+
3. `docs/ARCHITECTURE.md` — system design + data flow diagrams
4. `docs/API-CONTRACT.md` — endpoint + socket event spec (bot ↔ backend)
5. `docs/DEPLOYMENT.md` — VPS setup + cutover SOP
6. `docs/feature_telegram_bot_sprint2_2026-11-22.md` — Sprint 2a-2g tracking (latest major feature)

**Full docs index (18 files, 6066 LOC):**

| File | LOC | Purpose |
|---|---|---|
| `INDEX.md` | 73 | Peta docs + Status fitur (⚠️ STALE 2026-09-24, cross-check git log) |
| `MEMORY.md` | 197 | Decision log D-01 to D-15+ (rationale historis) |
| `ARCHITECTURE.md` | 239 | System design + data flow diagrams |
| `API-CONTRACT.md` | 374 | Endpoint + socket.io event spec |
| `DASHBOARD-DESIGN.md` | 220 | UI spec admin dashboard |
| `DEPLOYMENT.md` | 335 | VPS setup + cutover SOP |
| `MIGRATION.md` | 312 | Blueprint migrasi :3005+:3006 → :3010 |
| `IMPACT-ASSESSMENT.md` | 131 | Bot-side changes untuk cutover |
| `DECISIONS.md` | 190 | Open questions + resolution log |
| `USER-MANAGEMENT.md` | 197 | v4.1.5 multi-user dashboard spec |
| `feature-callback-2026-11-01.md` | 665 | v4.1.0 callback feature spec + D1-D10 log |
| `feature-impl-2026-10-29.md` | 401 | F1 auto-approve + F2 status endpoint |
| `feature_multi_user_dashboard_2026-11-21.md` | 183 | v4.1.5 spec |
| `feature_telegram_bot_concept_2026-11-21.md` | 904 | Sprint 1 concept |
| `feature_telegram_bot_sprint1_2026-11-22.md` | 281 | Sprint 1 tracking |
| `feature_telegram_bot_sprint2_2026-11-22.md` | 586 | Sprint 2a-2g tracking |
| `postman-transfer-status.md` | 416 | F2 endpoint API reference |
| `sprint1_deploy_guide.md` | 181 | Sprint 1 deploy walkthrough |

**Missing:** `README.md` (CLAUDE.md serves root doc role), `CHANGELOG.md` (release history di git tags + MEMORY.md timeline).

---

## 5. Roadmap Status

**Current baseline:** `v4.5.1` (git tag, 2026-11-23) — Telegram bot hotfix 1-2.

**Release chain (chronological):**

| Version | Date | Highlights |
|---|---|---|
| **v3.4.0** | 2026-09-24 | **Unified backend cutover** — port :3005+:3006 → :3010 single process, app_source URL prefix, schema-unified.sql |
| **v4.0.0** | 2026-10-18 | **ACK-P2 serial dispatcher** — per-alias single-slot, `task:ack` handshake, 60s `DISPATCH_ACK_TIMEOUT` |
| v4.0.1 | - | M2 `PROCESSING_STALE_MS` 5min guard |
| v4.0.2 | 2026-10-31 | W1+W2+W3+W6 regression cycle — V2-F7 dispatcher cross-fix |
| **v4.1.0** | 2026-11-02 | **F1+F2+F3+F4 Callback Feature** — transactional outbox, HMAC-SHA256, exponential backoff, SSRF guard, dead-letter + replay admin endpoints |
| v4.1.2 | - | `PENDING_STALE_MS` 2h guard |
| v4.1.3 | - | 60s grace disconnect cleanup |
| **v4.1.5** | 2026-11-21 | **Multi-user dashboard** — bcrypt + DB-backed `dashboard_users` + session cookie + admin user CRUD |
| **v4.3.0** | 2026-11-22 | **Sprint 1 Telegram Bot foundation** — 3-tier defense, role middleware, audit + shadow, operator+RDP CRUD, owner commands |
| v4.3.1 | 2026-11-22 | `parse_mode` Markdown → HTML (underscore crash fix) |
| v4.3.2 | 2026-11-22 | **Sprint 2a** — wizard infra + F2 shadow rate limit batching |
| v4.3.3 | 2026-11-22 | **Sprint 2b** — `/delete` + REST IPC backend |
| v4.3.4 | - | **Sprint 2c** — `/edit` wizard + **CAS race fix** (atomic `JSON_SET` UPDATE) |
| v4.3.5-v4.3.7 | - | **Sprint 2d** — `/add` wizard 6-step (incl ADB `pair_code`) |
| v4.3.8 | - | **Sprint 2e-1** — backend round-trip plumbing (`rdpControlSockets` + `callClientapp`) |
| v4.3.9 | 2026-11-22 | **Sprint 2e-3** — `/add`+`/edit` field alignment (drop `username`+`api_key`, add `keep_balance`) |
| v4.3.10-v4.3.13 | - | **Sprint 3** — `/start_bot` `/stop_bot`, `setMyCommands` autocomplete, auto-delete sensitive input |
| v4.3.14-v4.3.17 | - | Sprint 3 polish — aggregated `/list_accounts`, `/edit mutasi_enabled` picker |
| v4.3.18 | 2026-11-23 | **Sprint 2g** — dynamic `app_source` resolver |
| **v4.5.1** | 2026-11-23 | **Hotfix 1-2** — `rdp:control_register` upsert pending row + `bot:register` backfill `bound_ts_ip` |

**Package.json drift:** `2.0.0` hasn't bumped since v3.4 unified cutover. Git tag `v4.5.1` = canonical. §11 R6 wajibkan tag git sebagai sumber version.

---

## 5a. Historical Snapshot: F1 Auto-Approve + F2 Transfer Status (2026-10-29)

### F1 — Auto-Approve Global Toggle
Admin dashboard bisa toggle "Auto-Approve" di header. Saat ON, semua `/{app}/validate-confirmation` request dari bot langsung di-approve (status `PROCEED`, `decision_source=AUTO`) tanpa menunggu admin manual review atau 60s timeout.

- **State persistence:** DB table `app_config` (key-value), row `auto_approve_enabled` di-load ke in-memory flag saat boot
- **Endpoints:** `GET/POST /api/auto-approve/status|enable|disable` (`requireAuth` cookie)
- **Socket broadcast:** `auto_approve:state` event untuk sync cross-tab dashboard
- **Audit trail:** column `transfer_validations.decision_source` ENUM(`ADMIN`,`TIMEOUT`,`AUTO`)
- **Default state:** OFF (safe default)

### F2 — Transfer Status Endpoint
External client bisa cek status transfer by task_id.

- **Endpoint:** `GET /{app}/transfer-status/:task_id` (3 instansi per clientapp)
- **Auth:** `X-API-KEY` header
- **Response:** Rich 13-field JSON (status, amount, dest, bank_type, ref_number, message, validation_status, decision_source, bot_alias, timestamps)
- **Derived status enum:** `PENDING`, `PROCESSING`, `AWAITING_VALIDATION`, `SUCCESS`, `FAILED`, `NOT_FOUND`

**Detail implementation + dev-test + rollback plan:** `docs/feature-impl-2026-10-29.md`.

---

## 5b. Historical Snapshot: v4.1.0 Transfer Status Callback (2026-11-02)

API caller boleh ikutkan `callback_url` + `callback_secret` opsional di `POST /{app}/transfer`. Setelah transfer selesai, backend POST payload status + saldo akhir ke callback_url async.

**Komponen baru:**
- **`callback-security.js`** — SSRF validator (private IP, metadata IP, CGNAT 100.64/10, IPv6 lokal, hostname blocklist, DNS lookup) + HMAC-SHA256 signer + delivery_id UUID + secret length validator (16-128 chars). Dipakai 2 titik: create-time + delivery-time (DNS poison guard).
- **`callback-worker.js`** — DB-backed queue + tick worker. Interval 10s default, batch 20, timeout 10s per request. Exponential backoff `[30s, 2m, 10m, 1h]` ±25% jitter. 4xx → DEAD immediate, 5xx/timeout/net → retry up to 5 attempts atau 24h age. Graceful shutdown SIGTERM/SIGINT.
- **DB migration** `migrations/2026-11-01_add_callback_fields.sql` — 10 kolom tambah di `transfer_request` + index `idx_callback_pending`. Blue-green safe additive.
- **`index.js` 6 edits** — require callback modules + `ADMIN_API_KEY` const + `requireAdminKey` middleware + `POST /{app}/transfer` accept callback field + `POST /update-task` accept `balance_after`/`balance_source` + atomic transactional outbox UPDATE + `signalPickup` fire-and-forget + 3 admin endpoints + SIGTERM graceful shutdown.

**Semantics:**
- **At-least-once delivery** dengan task_id dedupe key — receiver WAJIB idempotent
- **Transactional outbox** — status finalize + callback enqueue dalam 1 UPDATE (zero race)
- **Fire-and-forget** `signalPickup()` after `res.json({success:true})` — dispatcher critical section unaffected
- **HMAC-SHA256 header** `X-Autotransfer-Signature: sha256=<hex>` kalau `callback_secret` provided
- **Balance semantics** — `balance_after` + `balance_source` ENUM(`SCRAPED`/`COMPUTED`/`UNAVAILABLE`)

**Admin Endpoints (`X-Admin-Key: $ADMIN_API_KEY`):**
- `GET /api/admin/callbacks/stats?hours=24` — counts PENDING/DELIVERED/DEAD + retry_distribution + latency
- `GET /api/admin/callbacks/dead?limit=50&offset=0` — paginated dead-letter
- `POST /api/admin/callbacks/replay/:task_id` — reset DEAD → PENDING

Tanpa `ADMIN_API_KEY` di env → endpoints balikin 503 `feature not configured`.

**Detail:** `docs/feature-callback-2026-11-01.md` (D1-D10 decision log + release plan 4-repo + testing matrix).

---

## 5c. Historical Snapshot: v4.1.5 Multi-user Dashboard (2026-11-21)

Replace single bootstrap `DASHBOARD_USER/PASS` dengan DB-backed multi-user auth.

**Komponen:**
- Table `dashboard_users` — PK `id`, `username` UNIQUE, bcrypt hash, `role` (admin/user), `is_active`, `created_at`
- Migration `migrations/2026-11-21_add_dashboard_users.sql` — idempotent `IF NOT EXISTS`
- `scripts/add-user.js` — CLI helper bcrypt hash + insert
- Admin endpoints (`X-Admin-Key` auth): `GET/POST /api/admin/users`, `GET/DELETE /api/admin/users/:id` — user CRUD
- Bootstrap: kalau 0 row di `dashboard_users` → fallback ke env `DASHBOARD_USER/PASS` (migration period safety)

**Session:** cookie HTTP-only + `requireAuth` middleware di semua dashboard routes.

**Detail:** `docs/feature_multi_user_dashboard_2026-11-21.md` + `docs/USER-MANAGEMENT.md`.

---

## 5d. Historical Snapshot: Telegram Bot Sprint 1-3 (v4.3.0 - v4.5.1, 2026-11-22+)

Remote account CRUD + runtime control via Telegraf, multi-RDP fan-out.

**Sibling PM2 process `telegram-bot`:** Telegraf long-polling, shared `.env`, own MySQL pool (limit 10, separate dari backend pool 50), REST IPC ke backend `/api/tg/*` loopback-only + Bearer `TG_BOT_API_KEY`.

**Role model:**
- **Owner** — hardcoded `OWNER_CHAT_ID` di `.env` (NOT in DB — prevent DB-based privilege elevation)
- **Operator** — row di `operators` table `status=approved`, `allowed_rdp_hostnames` JSON scope
- **Unknown** — reject + notify owner

**3-tier defense (middleware.js):**
1. Private chat only (reject group/supergroup/channel)
2. No forwarded commands (anti-social-engineering)
3. Role resolution (owner > operator > unknown)

**Commands (21 total — registered di `handlers/index.js`):**

| Role | Commands |
|---|---|
| **Public (3)** | `/start`, `/whoami`, `/help` |
| **Operator (9)** | `/list`, `/status`, `/cancel`, `/delete`, `/edit`, `/add`, `/start_bot`, `/stop_bot`, `/list_accounts` |
| **Owner (9)** | `/list_rdp`, `/approve_rdp`, `/revoke_rdp`, `/list_operators`, `/create_operator`, `/revoke_operator`, `/delete_operator`, `/shadow`, `/audit` |

**Inline callback actions:** `del_ok/del_no` (confirm delete), `edit_field` + `edit_dev` + `edit_mutasi` + `edit_confirm` + `edit_cancel` (edit wizard), `add_rdp` + `add_confirm` + `add_cancel` (add wizard), `pick_rdp` (multi-hit fan-out picker).

**`setMyCommands` publish (v4.3.11):** 12 commands published to Telegram API at startup untuk autocomplete (owner-only commands intentionally omitted dari public autocomplete).

**Wizard state machine (`wizard_sessions` table):**
- `/add` 6-step: RDP picker → alias → password → callback_url → keep_balance → device_ip → pair_code → confirm
- `/edit` field picker: alias | password | callback_url | device_id | keep_balance | mutasi_enabled
- **Atomic CAS via MySQL `JSON_SET` + `JSON_MERGE_PATCH`** + InnoDB row lock + expected-step gate (one-shot destructive confirms) — fix v4.3.4 Sprint 2c
- TTL `TG_WIZARD_TIMEOUT_MIN` default 15min, cascade cleanup on operator revoke/delete

**Field alignment (v4.3.9 Sprint 2e-3 critical hotfix):**
Clientapp DB tidak punya `username`/`api_key` columns (BRImo/BCA/SeaBank login pakai password saja). Edit whitelist aligned: `alias`, `password`, `callback_url`, `device_id`, `keep_balance`, `mutasi_enabled`. Field `remote_ip` DROPPED (auto-derived via CGNAT regex di clientapp). Field `mirror_enabled` DEFERRED (toggle di card langsung di clientapp UI).

**REST IPC round-trip (`telegram-bot-ipc.js`, 742 LOC, mounted `/api/tg/*`):**

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/health` | - | `{ok, ts}` liveness |
| POST | `/account/delete` | `{alias, rdp_hostname?, operator_chat_id}` | `{ok, resolved_rdp}` / 300 multi-hit / 403 scope / 404 not-found |
| POST | `/account/add` | `{alias, rdp_hostname, password, callback_url, keep_balance, device_ip, pair_code, operator_chat_id}` | `{ok}` after clientapp ADB pair + DB insert |
| POST | `/account/edit` | `{alias, rdp_hostname?, field, value, operator_chat_id}` | `{ok, resolved_rdp}` |
| GET | `/account/alias_lookup?alias=X&operator_chat_id=Y` | - | `{ok, alias, scanned, hits[]}` fan-out |
| GET | `/account/devices?rdp_hostname=X` | - | `{ok, devices[]}` live ADB device list |
| GET | `/accounts/list?operator_chat_id=X` | - | `{ok, groups[], totals{}}` aggregated |
| POST | `/bot/start` | `{alias, rdp_hostname?, operator_chat_id}` | `{ok, resolved_rdp, action}` |
| POST | `/bot/stop` | same | same |

**Round-trip pattern:** TG bot command → `backend-client.postJson('/account/...')` → tgAuth (loopback + Bearer) → `validateOperatorScope()` → `callClientapp(rdp, 'tg:xxx', payload)` → `rdpControlSockets.get()` → `socket.emit()` → clientapp handles → `tg:xxx_ack` → `resolveAck()` → Promise resolves → audit INSERT → `res.json` → bot replies to TG user.

**Timeouts:** `TG_ROUNDTRIP_MS=30000` default, 5s fan-out per-RDP (alias_lookup/list_accounts), 20s `/bot/start`+`/bot/stop` (engine lifecycle).

**RDP control plane:**
- `rdpControlSockets` Map keyed `${app_source}:${rdp_hostname}`
- Events backend → clientapp: `tg:account_create/edit/delete`, `tg:alias_lookup`, `tg:devices_query`, `tg:list_accounts`, `tg:bot_control`
- ACK events clientapp → backend: `tg:account_ack`, `tg:devices_ack`, `tg:alias_lookup_ack`, `tg:bot_control_ack`, `tg:list_accounts_ack`
- Payload shape: `{request_id, ok, result?, error_code?, error_message?}` (request_id = UUID set by backend, echoed by clientapp)
- **Dynamic `app_source` resolver** (v4.3.18 Sprint 2g) — scan active app_sources per hostname, 0 → 502 `rdp_offline`, 1 → auto-pick, >1 → pick first + warn
- **`rdp_registry` Model C Auto-Sync** — auto-INSERT pending on first `bot:register` dari new hostname
- **Same-IP Relax** — `bound_ts_ip === current_ts_ip` → auto-approve on reinstall (`approved_by='auto-same-ip-relax'`)

**Security:**
- Loopback-only guard `/api/tg/*` (defense-in-depth kalau :3010 accidentally exposed WAN)
- Sensitive input auto-delete (password + pair_code) via `ctx.deleteMessage()` after wizard consume (v4.3.13 Sprint 3 polish)
- Audit log masking (password/pair_code → `••••••••`, callback_url truncated 60 chars)
- Shadow mode owner-asymmetric observability + rate-limit cooldown batching

**Known issues / tech debt (audit 2026-11-27):**
- **Monolithic `handlers/operator.js` 1582 LOC** — refactor hazard (tight coupling to wizard state + module-scope Maps)
- **`TG_RATE_LIMIT_PER_MIN=10` enforcement MISSING** — env configured tapi no per-chat_id throttle middleware ditemukan. Rogue operator bisa spam destructive commands.
- **Audit retention cleanup cron MISSING** — `TG_AUDIT_RETENTION_DAYS=90` env configured tapi no cron job trigger. `tg_audit_log` grows unbounded.
- **Confirm TTL inconsistency** — env `TG_CONFIRM_TTL_SEC=30` vs hardcoded `PENDING_TTL_MS=60*1000` di operator.js:18. Env tidak actually dibaca untuk pending-delete expiry.
- **Separate DB pool per process** — backend pool limit 50 + telegram-bot pool limit 10 = 60 total connections. MySQL `max_connections` setting must accommodate both.

**Detail:** `docs/feature_telegram_bot_concept_2026-11-21.md` + `docs/feature_telegram_bot_sprint1_2026-11-22.md` + `docs/feature_telegram_bot_sprint2_2026-11-22.md`.

---

## 6. Konteks Runtime

### 6.1 Core Services

- **Node:** ≥18 declared; VPS runs v22.21.1 via nvm (`~/.nvm/versions/node/v22.21.1/bin/*`)
- **DB:** MySQL 8.0.44 (root socket auth via `sudo mysql`), `mysql2/promise` connection pool
- **DB name:** `auto_transfer_db_unified`
- **Server port:** `3010` (unified, serves `/brimo`, `/mybca`, `/seabank` URL prefix)
- **Legacy ports:** `:3005` + `:3006` DEPRECATED post-v3.4 cutover
- **VPS:** `okta-prod` (13.228.167.183), Ubuntu 24.04.2 LTS, user `robot` (sudo), passwordless SSH alias `ssh okta-prod`
- **Deploy path:** `/var/automate/auto_transfer/`
- **Legacy paths (deprecated):** `/var/automate/{brimo,mybca}/auto_transfer/`

### 6.2 PM2 Processes (`ecosystem.config.js` — 2 apps)

**App 1 — `unified-backend`:**
- script: `index.js`, cwd: `__dirname`
- env: `NODE_ENV=production`, `TZ=Asia/Jakarta`, `OBS_VERBOSE=1`
- log_date_format: `YYYY-MM-DD HH:mm:ss Z` (R7 fix WIB display)
- logs: `./logs/err.log` + `./logs/out.log`, `merge_logs: true`
- max_memory_restart: 512M, autorestart: true, watch: false

**App 2 — `telegram-bot`:**
- script: `telegram-bot/index.js`, cwd: `__dirname`
- env: `NODE_ENV=production`, `TZ=Asia/Jakarta`
- max_memory_restart: 256M, min_uptime: 10s, max_restarts: 10 (crash-loop guard)
- Telegraf long-polling resumes on restart (safe crash+restart)

### 6.3 Deploy SOP (inline summary — detail `docs/DEPLOYMENT.md`)

```bash
# SSH VPS
ssh okta-prod
sudo -u robot -i
cd /var/automate/auto_transfer/

# Pull + install
git pull
npm install --production   # kalau deps change

# Migration (idempotent IF NOT EXISTS pattern)
mysql -u $DB_USER -p$DB_PASSWORD auto_transfer_db_unified < migrations/<NEW>.sql

# Reload PM2 (zero-downtime — NOT restart)
pm2 reload ecosystem.config.js --update-env

# Verify
pm2 logs unified-backend --lines 30
pm2 logs telegram-bot --lines 30
curl http://127.0.0.1:3010/brimo/transfer-status/TRX-TEST1234  # expect 404 NOT_FOUND
curl http://127.0.0.1:3010/api/tg/health -H "Authorization: Bearer $TG_BOT_API_KEY"  # expect {ok:true}
```

**Full deploy runbook:** `docs/DEPLOYMENT.md` + memory `[[infrastructure-staging-topology]]`.

**Automation gap:** NO `deploy.sh`, NO CI pipeline, NO automated test suite (`npm test` = noop echo). All deploys manual. Mitigation: strict §11 MANDATE Backend Deploy Discipline.

### 6.4 ENV Variables (ringkasan — detail `env.example`)

| Group | Variables |
|---|---|
| **Core** | `NODE_ENV`, `PORT` (default 3010), `DB_HOST/USER/PASSWORD/NAME` |
| **Auth** | `API_KEY` or `API_KEY_BRIMO`/`API_KEY_MYBCA`, `DASHBOARD_USER`+`DASHBOARD_PASS` (bootstrap, migration period), `ADMIN_API_KEY` (32+ hex, WAJIB prod untuk callback admin + user CRUD endpoints) |
| **Tuning** | `VALIDATION_TIMEOUT_MS=60000`, `PROCESSING_STALE_MS=300000`, `PENDING_STALE_MS=7200000`, `DISPATCH_ACK_TIMEOUT_MS=60000` |
| **Callback** | `CALLBACK_WORKER_INTERVAL_MS=10000`, `CALLBACK_WORKER_BATCH=20`, `CALLBACK_TIMEOUT_MS=10000`, `CALLBACK_MAX_ATTEMPTS=5`, `CALLBACK_MAX_AGE_HOURS=24` |
| **Telegram** | `TELEGRAM_BOT_TOKEN`, `OWNER_CHAT_ID`, `TG_BOT_API_KEY` (shared Bearer), `BACKEND_URL=http://127.0.0.1:3010`, `TG_CONFIRM_TTL_SEC=30`, `TG_RATE_LIMIT_PER_MIN=10` (⚠️ enforcement missing), `TG_WIZARD_TIMEOUT_MIN=15`, `TG_AUDIT_RETENTION_DAYS=90` (⚠️ cleanup cron missing), `TG_SHADOW_ENABLED=true`, `TG_SHADOW_FILTER=all`, `TG_SHADOW_COOLDOWN_MS=2000`, `TG_ROUNDTRIP_MS=30000` |
| **Observability** | `OBS_VERBOSE=1` (prod enables `[OBS-BE]` verbose logs for race investigation) |
| **Feature flags** | `LEGACY_UNPREFIXED_ROUTES=false` (v3.3.x bot transition period, default off) |

### 6.5 Database Schema (8 tables)

| Table | Source | Key columns |
|---|---|---|
| `transfer_request` | schema-unified.sql | PK `id` TRX-XXXXXXXX, `app_source`, `ref_number`, `bot_alias`, `bank_type`, `dest`, `amount`, `pin`, `status` ENUM, `message`, timestamps + **v4.1.0 callback cols** (`balance_after`, `balance_source`, `callback_url/secret/status/attempts/last_error/next_attempt_at/last_attempt_at/delivered_at`) |
| `transfer_validations` | schema-unified.sql | PK `task_id` (FK CASCADE), `app_source`, `device_id`, `account_name`, `target_name_extracted`, `target_rek_extracted`, `bank_name`, `total_amount`, `status` ENUM(WAITING/PROCEED/ABORT), `decision_source` ENUM(ADMIN/TIMEOUT/AUTO) |
| `app_config` | schema-unified.sql | Generic key-value (currently: `auto_approve_enabled`) |
| `dashboard_users` | v4.1.5 migration | Multi-user dashboard auth (bcrypt, admin role) |
| `operators` | v4.3.0 migration | Telegram operator approval (`chat_id` → role, `allowed_rdp_hostnames` JSON) |
| `rdp_registry` | v4.3.0 migration | RDP hostname bind status (Model C Auto-Sync + Same-IP Relax) |
| `tg_audit_log` | v4.3.0 migration | Every TG command logged, 90-day retention (⚠️ cleanup cron MISSING) |
| `wizard_sessions` | v4.3.0 migration | Multi-step wizard state, 15min TTL atomic CAS |

**Indexes:** `idx_app_alias`, `idx_app_status`, `idx_app_created`, `idx_status_updated`, `idx_callback_pending`, per-table convention.

**Migration pattern:** additive via `IF NOT EXISTS` (idempotent), standalone `.sql` files di `migrations/` folder. Lihat §12 MANDATE DB Migration Safety.

### 6.6 Endpoint Inventory

**Per-app bot routes** (via `createBotRouter(app_source)` factory @ index.js:330, mounted 3× for `/brimo`, `/mybca`, `/seabank` + optional unprefixed-brimo via `LEGACY_UNPREFIXED_ROUTES`):

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/{app}/transfer` | X-API-KEY | External submit; validates callback_url (SSRF), inserts transfer_request PENDING, dispatches via serial dispatcher |
| POST | `/{app}/get-task` | — | **410 Gone** (deprecated polling) |
| GET | `/{app}/get-validation-decision/:task_id` | — | **410 Gone** (deprecated polling) |
| POST | `/{app}/update-task` | bot-trust | Bot final report; atomic transactional outbox UPDATE |
| POST | `/{app}/validate-confirmation` | bot-trust | Bot extraction report → WAITING state |
| POST | `/{app}/update-decision` | bot-trust | Bot updates PROCEED/ABORT + ref_number |
| GET | `/{app}/transfer-status/:task_id` | X-API-KEY | v4.1.0 F2 — rich 13-field status response |

**Global routes** (dashboard + admin + Telegram IPC + mirror + Headscale):

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/`, `/dashboard`, `/history` | requireAuth | Unified dashboard HTML |
| GET | `/login`, POST `/api/login`, GET `/logout` | — / cookie | Session management |
| GET | `/api/history`, `/pending-validations`, `/queue`, `/stats`, `/bots` | requireAuth | Dashboard data |
| DELETE | `/api/queue/:task_id` | requireAuth | Admin cancel PENDING |
| GET/POST | `/api/auto-approve/status\|enable\|disable` | requireAuth | F1 global toggle |
| GET/POST | `/tailscale/register`, `/api/tailscale/auto-accept/*` | requireAuth | Headscale integration UI |
| USE | `/api/tg/*` (9 endpoints) | Bearer + 127.0.0.1 only | TG REST IPC (lihat §5d detail) |
| GET/POST | `/api/admin/callbacks/stats\|dead\|replay/:task_id` | X-Admin-Key | Callback worker admin |
| CRUD | `/api/admin/users`, `/:id` | X-Admin-Key | Dashboard user CRUD |
| GET | `/api/mirror/devices` | ⚠️ **no auth** | Mirror device list (intentional — mirror-proxy polls freely dari okta-dev) |

**Socket.io events** (main namespace, `io.on('connection')`):

| Direction | Event | Payload |
|---|---|---|
| bot → backend | `bot:register` | `{bot_id, alias, device_id, app_source, mirror_enabled, passive_mirror}` |
| bot → backend | `bot:unregister`, `task:ack` | `{bot_id}` / `{task_id}` |
| bot → backend | `rdp:control_register` | `{rdp_hostname, app_source, ts_ip}` — Sprint 2e |
| bot → backend | `tg:*_ack` events | `{request_id, ok, result?, error_code?}` |
| backend → bot | `task:new`, `decision` | Transfer flow |
| backend → bot | `tg:account_create/edit/delete`, `tg:alias_lookup`, `tg:devices_query`, `tg:list_accounts`, `tg:bot_control` | Sprint 2e+ remote CRUD |
| backend → dashboard | `new_validation`, `decision_updated`, `task_completed`, `new_task`, `task_ack`, `bot:status`, `auto_approve:state`, `tailscale:*` | Dashboard realtime |

---

## 7. Alur Kerja Rekomendasi per Sesi

1. Baca `CLAUDE.md` (ini — self-contained)
2. Baca `docs/INDEX.md` (⚠️ stale 2026-09-24 — cross-check git log + §5 Roadmap)
3. Baca `docs/MEMORY.md` kalau pernah ada decision relevan
4. Kalau user minta **endpoint change** → baca `docs/API-CONTRACT.md` dulu + cek bot impact per §10 MANDATE
5. Kalau user minta **UI dashboard change** → baca `docs/DASHBOARD-DESIGN.md`
6. Kalau user minta **Telegram bot change** → baca `docs/feature_telegram_bot_sprint2_2026-11-22.md` + §5d historical
7. Kalau user minta **callback change** → baca `docs/feature-callback-2026-11-01.md` + §5b historical
8. Kalau user minta **DB migration** → §12 MANDATE DB Migration Safety wajib dibaca dulu
9. Kalau user minta **deploy** → §11 MANDATE Backend Deploy Discipline + `docs/DEPLOYMENT.md`, minta konfirmasi tiap step
10. Kalau user report bug → cek `docs/MEMORY.md` + git log + log file untuk historical context, lalu §8 MANDATE Bug Fix Discipline

---

## 🔴 8. MANDATE — Bug Fix Discipline (WAJIB)

**Setiap bug fix session WAJIB ikuti flow ini — no shortcuts, no assumptions.** Rules derived dari historical regressions (v4.0.2 W1 → V2-F7 regression cycle).

### Rules

1. **Zero assumption.** Scan actual codebase (code + config + log + fresh test di dev mode) dulu. Jangan speculate root cause tanpa evidence pointing `file:line` / endpoint / SQL query / socket event.

2. **Root cause first, fix second.** Identify failing component SEBELUM propose solution. State root cause explicitly di reply, dengan file+line.

3. **Options before action for guarded files.** Perubahan yang touch guarded files per §2 R3 (`index.js`, `telegram-bot/handlers/operator.js`, `callback-worker.js`, `callback-security.js`, `telegram-bot-ipc.js`, `ecosystem.config.js`, `schema-unified.sql`, semua di `migrations/`) WAJIB: present 2+ options dengan trade-off, wait user decide, baru implement. No autonomous "quick fix" di file ini.

4. **Status tracking untuk multi-issue session.** Fix >1 issue dalam 1 sesi → maintain markdown status table (ID/Issue/Area/Priority/Status/Note).

5. **Kebal-update priority.** Perubahan WAJIB env-agnostic. Hardcoded IP/port/secret path = anti-pattern (kecuali `127.0.0.1` loopback guard yang eksplisit untuk TG IPC + mirror).

6. **No deploy before dev-test.** Follow §2 R8 — never deploy backend code yang touch `index.js`, `callback-worker.js`, `telegram-bot-ipc.js`, atau migration tanpa dev-mode smoke dulu.

7. **Post-implementation verification 2-track (WAJIB).** Setelah apply fix dan sebelum commit/deploy:
   - **Track A — Self-verify by code (Claude side):** minimum (a) `node --check` syntax verify affected file, (b) grep marker patch landed, (c) kalau backend logic: `npm run dev` + curl endpoint affected atau mock bot client untuk socket flow, (d) kalau schema: dry-run migration di dev DB + `DESCRIBE` verify.
   - **Track B — User dev-test (user side):** guide user eksplisit skenario test di dev mode atau staging VPS.
   Kedua track pass dulu baru commit + deploy.

8. **Post-fix mini-scan mandatory (G1).** Setiap apply fix dari vulnerability/audit scan WAJIB diikuti mini-scan secondary (sub-agent fork) yang audit code **POST-fix** (bukan pre-fix) dalam konteks downstream flow — **SEBELUM commit + deploy ke VPS**, bukan setelah user report. Scope minimum: simulate end-to-end 2-3 scenarios (happy-path + reject-path + double-trigger/concurrency kalau applicable). Rationale: fix inisial sering overshoot/undershoot — scan pre-fix audit code lama, fix diterapkan, tapi fix itu sendiri intro regresi yang tidak terlihat sampai scan ulang atau worst-case prod incident. **Historis konkret: v4.0.2 W1 cross-fix unconditionally wipe dispatcher state di happy-path → V2-F7 CRITICAL regression (W1 revision gate `busyWithTaskId === task_id` solve). Mini-scan W5 pada 2026-11-01 prevented W2 regression dari lolos ke prod — proof concept effective.**

---

## 🔴 9. MANDATE — Multi-Project Session Discipline (WAJIB)

Sesi 1-Claude yang handle `auto_transfer` backend + 3 clientapp punya dampak buruk inheren (context quota, blast radius, pattern drift, commit mess, prod backend impact). Rules berikut WAJIB diikuti.

### Rules

1. **Session Scope Declaration (WAJIB di turn pertama).** User state scope sesi dalam 1 kalimat. Contoh: `sesi: auto_transfer-only`, `sesi: backend + 3 clientapp`, `sesi: callback cross-cut`, `sesi: TG bot only`, `sesi: investigasi only, no code`. Kalau user tidak declare → Claude WAJIB tanya sebelum action besar.

2. **Fork-First for Scanning (WAJIB).** Scanning yang baca >2 file di 1 project ATAU cross-project ATAU research/survey question → WAJIB pakai `Agent subagent_type: fork`. Rationale: raw file content tetap di fork, cuma insights balik ke parent, hemat context 10× atau lebih. Inline Read OK hanya kalau baca 1-2 file spesifik di 1 project.

3. **Progressive Apply + Commit-Per-Repo (WAJIB untuk cross-repo).** Fix yang touch backend + clientapp WAJIB di-apply + commit per repo sequential, bukan batch. Flow: apply backend → verify (syntax + dev-mode smoke) → commit backend → baru lanjut clientapp → ulang. Rationale: failure di clientapp tidak polusi backend state yang sudah OK + commit history rapih per repo + release independen per repo tetap bisa.

4. **Pre-Apply Pattern Verification (WAJIB untuk paralel edit).** Sebelum paralel Edit text yang sama ke backend + clientapp, Claude WAJIB Grep atau Read untuk konfirmasi pattern identik. Rationale: backend code pattern sering drift silent vs clientapp (comment, whitespace, formatting) — pre-verify prevent failed Edit partially-applied → broken state di 1 repo sementara lain sudah OK.

---

## 🔴 10. MANDATE — Cross-Clientapp Awareness (WAJIB)

Backend ini serve 3 clientapp (brimo + mybca + seabank). Perubahan di backend sering impact clientapp. Rules untuk prevent silent breakage cross-clientapp.

### Rules

1. **Baca FEATURE-PARITY-MATRIX sebelum breaking API change.** Sebelum apply perubahan yang touch endpoint shape, socket event payload, atau URL path yang di-consume clientapp, Claude WAJIB baca `brimoclientapp/docs/FEATURE-PARITY-MATRIX.md` (master, gitignored, local-only) + cross-check version pointer current clientapp. Prevent "backend fix bikin bot broken" silent pattern.

2. **Coordinated release WAJIB untuk breaking change.** Breaking change (shape response, event removal, URL rename) WAJIB diikuti backend-side blue-green (support old+new concurrently) sampai semua 3 clientapp release, baru hapus support old. Historical precedent: v3.4 unified cutover `LEGACY_UNPREFIXED_ROUTES` flag untuk bot v3.3.x transition period.

3. **Update parity matrix di commit (jika touch cross-clientapp feature).** Feature backend yang tracked cross-clientapp (F* row di matrix) — update matrix row saat release, sama persis dgn clientapp release pattern per §12 R2 clientapp governance.

### Mitigates

| Rule | Captures |
|------|----------|
| 1 Baca matrix dulu | "Backend fix bikin bot broken" silent breakage |
| 2 Blue-green breaking change | Breaking change without transition period |
| 3 Matrix update sync | Cross-clientapp feature drift silent |

---

## 🔴 11. MANDATE — Backend Deploy Discipline (WAJIB)

Backend fully manual deploy (NO deploy.sh, NO CI pipeline, NO automated test suite). Rules ketat untuk prevent production incident yang akan impact 3 clientapp sekaligus.

### Rules

1. **env.example sync WAJIB sebelum release.** Setiap tambah env variable baru (`ADMIN_API_KEY`, `CALLBACK_*`, `TG_*`, dll) WAJIB sync ke `env.example` dengan comment menjelaskan purpose + default value. VPS `.env` production review sebelum deploy — kalau ada env baru di code tapi missing di VPS `.env` → feature DISABLED silent atau startup crash (fail-fast guard di beberapa modules seperti `telegram-bot/backend-client.js` untuk `TG_BOT_API_KEY`).

2. **Migration idempotent WAJIB.** Semua `.sql` di `migrations/` WAJIB pakai `IF NOT EXISTS` / `IF EXISTS` pattern (per existing convention). Rationale: migration bisa jalan 2× tanpa duplicate error, blue-green safe, rerun-friendly saat deploy retry. Detail di §12 MANDATE DB Migration Safety.

3. **`pm2 reload --update-env` bukan restart.** Reload = zero-downtime (new worker spin up, old handles in-flight, swap). Restart = full stop+start → in-flight transfer requests DROP → bot stuck di dispatcher state → user-facing failure. SELALU pakai `pm2 reload ecosystem.config.js --update-env` untuk code change, kecuali explicit crash recovery atau rebuild state (user eksplisit approve).

4. **Dev-mode smoke WAJIB sebelum VPS deploy.** Minimum: `npm run dev` → curl 3 scenarios (happy path transfer, callback delivery post-update-task, TG bot `/health`). Kalau touch migration → dev DB rollback-safe apply dulu per §12 R5. Backend TIDAK PUNYA installed-build concept seperti clientapp — dev-mode = prod runtime, cuma env file + log file beda.

5. **ABORT deploy kalau R1-R4 fail.** Jangan "push now, fix later". Fix root cause di repo, re-verify, deploy ulang. Backend regression impact = all 3 clientapp down simultaneously (dispatcher flow broken impact brimo + mybca + seabank).

6. **Git tag canonical, package.json stale.** `package.json` version `2.0.0` hasn't bumped since v3.4 unified cutover (drift historical). Git tag `v4.5.1` = canonical current. Future releases: bump via git tag + CHANGELOG (TBD — belum ada file), dokumentasi di `docs/MEMORY.md` timeline. Jangan autofix package.json tanpa alignment plan + user approval (version bump ambiguity: 2.0.0 → 4.5.2 atau 4.5.2 langsung?).

### Mitigates

| Rule | Captures |
|------|----------|
| 1 env.example sync | Silent feature disable, startup crash karena missing env var |
| 2 Migration idempotent | Re-deploy error, partial schema state |
| 3 reload vs restart | In-flight transfer request drop, dispatcher state loss |
| 4 Dev-mode smoke | Prod crash pertama kali |
| 5 ABORT gate | Preventif deploy broken ke prod (impact 3 clientapp) |
| 6 Git tag canonical | Version ambiguity, release trace broken |

---

## 🔴 12. MANDATE — DB Migration Safety (WAJIB)

Backend serve 3 clientapp — schema change = potensi downtime cross-clientapp. Rules untuk schema evolution safe.

### Rules

1. **Additive only via `IF NOT EXISTS`.** Pattern wajib di `migrations/*.sql`:
   ```sql
   ALTER TABLE transfer_request ADD COLUMN IF NOT EXISTS balance_after DECIMAL(15,2) DEFAULT NULL;
   CREATE INDEX IF NOT EXISTS idx_callback_pending ON transfer_request (callback_status, next_attempt_at);
   ```
   Idempotent, blue-green safe, rerun-friendly. Precedent: `migrations/2026-11-01_add_callback_fields.sql`, `migrations/2026-11-21_add_dashboard_users.sql`, `migrations/2026-11-22_add_telegram_bot_tables.sql` — semua ikut pattern ini.

2. **Blue-green schema evolution untuk column rename / type change / drop.**
   - Step 1: Deploy backend v+1 yang DUAL-WRITE (old col + new col) — new col `DEFAULT NULL`
   - Step 2: Backfill batch job (`UPDATE ... SET new_col = ...` dalam chunked batch)
   - Step 3: Deploy backend v+2 yang READ dari new col saja (old col unused tapi tetap ada)
   - Step 4: Verify metrics stable 7+ hari
   - Step 5: Deploy backend v+3 yang drop old col reference + migration drop old col
   Zero downtime, rollback friendly tiap step.

3. **Index post-populated.** `CREATE INDEX` di table yang sudah populated = table lock risk. Mitigation: `CREATE INDEX ... USING BTREE` di MySQL 8 (online DDL default kalau tidak block writes), atau split ke maintenance window kalau >100M rows. Dokumentasi di migration comment kalau risky.

4. **Rollback plan dokumentasi.** Setiap migration `.sql` WAJIB disertai comment di top file: rollback SQL (reverse of operations) + pre-migration state snapshot (row count, etc). Example precedent: `migrations/2026-11-01_add_callback_fields.sql`.

5. **Dev DB apply dulu + verify row count + schema shape.** Sebelum VPS apply, migration WAJIB tested di dev DB:
   ```bash
   mysql -u dev -p dev_auto_transfer < migrations/<NEW>.sql
   mysql -u dev -p dev_auto_transfer -e "DESCRIBE transfer_request;"
   mysql -u dev -p dev_auto_transfer -e "SELECT COUNT(*) FROM transfer_request;"
   ```
   Verify kolom baru exist, row count stable (no data loss), index visible.

### Mitigates

| Rule | Captures |
|------|----------|
| 1 IF NOT EXISTS | Re-deploy error, partial schema state |
| 2 Blue-green | Breaking schema change downtime |
| 3 Index strategy | Table lock pada populated tables |
| 4 Rollback doc | No clear undo path kalau regression |
| 5 Dev DB verify | Prod incident pertama kali |

---

## 🔴 13. MANDATE — Governance Sync Protocol (WAJIB)

Backend `auto_transfer` governance **INDEPENDENT** dari 3 clientapp — tidak ikut sync protocol. Lahir dari refactor 2026-11-27 — clientapp pakai self-contained CLAUDE.md + sync markers; backend intentionally standalone.

### Convention

- **Self-contained:** CLAUDE.md ini adalah 1 source of truth untuk backend. Zero required cross-read ke `brimoclientapp/CLAUDE.md`.
- **NO SYNC markers:** backend tidak punya `<!-- SYNC:RULES/MANDATES -->` wrapper. Governance edit backend = manual edit di file ini saja.
- **Not target `sync-governance.js`:** script `brimoclientapp/scripts/sync-governance.js` HANYA target `mybcaclientapp` + `seabankclientapp`. Backend intentionally excluded (per clientapp §16 R5 "Backend repos independent governance").
- **Rationale:** Backend governance scope berbeda — focus DB migration, deploy discipline, cross-clientapp API coordination, bot compatibility. Clientapp governance focus UI capture, OTA deploy, installer verification, port workflow — irrelevant untuk backend.

### Rules

1. **Edit governance langsung di file ini.** Tidak ada "source of truth" external. Perubahan MANDATE backend = edit file ini + commit di repo `auto_transfer` independent.

2. **Reference ke clientapp governance kalau perlu, bukan blind copy.** Kalau MANDATE baru di clientapp berpotensi relevan ke backend (e.g., §15 Port Workflow), Claude WAJIB evaluate adaptasi — bukan blind copy. Dokumentasi decision di `docs/MEMORY.md`.

3. **Backend tidak target `sync-governance.js`.** Script di brimo repo hanya target 2 sibling clientapp. Backend excluded by design — governance evolve independent.

4. **Cross-repo tracking via matrix.** Perubahan backend yang impact clientapp (breaking API, protocol upgrade) tracked di `brimoclientapp/docs/FEATURE-PARITY-MATRIX.md` (gitignored, master di brimo, local-only). Backend tidak maintain own matrix.

5. **CLAUDE.md commit di `auto_transfer` repo.** Governance edit backend = independent commit di repo ini. Zero cross-repo pollution.

### Rollback Strategy

Kalau MANDATE baru di backend ternyata broken:
- Edit langsung di file ini → revert + commit di `auto_transfer` repo
- Zero impact ke clientapp (backend independent)

### Mitigates

| Rule | Captures |
|------|----------|
| 1 Edit langsung | Governance drift via "sync from brimo" confusion |
| 2 Adaptasi, no blind copy | Irrelevant clientapp governance (UI/OTA/installer) polusi backend |
| 3 Excluded dari sync script | Accidental overwrite via sync propagation |
| 4 Cross-repo tracking di matrix | Backend-clientapp impact silent |
| 5 Independent commit | Git log cross-repo pollution |

---

## 14. Kontak & Kepemilikan

- **Owner:** KN (`mknizar10@gmail.com`)
- **Repo:** local git di `C:\Users\KN\Documents\mygit\auto_transfer`
- **Deploy target:** VPS Ubuntu `okta-prod` via SSH (passwordless alias `ssh okta-prod`, user `robot`, sudo-OK)
- **Consumer clientapp:** `../brimoclientapp`, `../mybcaclientapp`, `../seabankclientapp` (3× self-contained CLAUDE.md per clientapp §16 governance, backend not synced per §13 R3)
- **Related repos:** `../licenses-manager` (okta-dev :3001, separate concern — clientapp license activation, no direct auto_transfer dependency)
- **Infrastructure:** okta-prod (SENSITIVE, control plane + backend + Headscale :3999), okta-dev (SAFE, mirror-proxy + license :3001), okta-dev2 (SAFE, OTA feed :443 via `update.knhome.id`). Full topology: memory `[[infrastructure-staging-topology]]`.
