# Uptime Kuma — Invariants Reference

> Tag format: **L<#>** = law you must not break; **T<#>** = test/CI gate that pins the law. Cite the file:line when you challenge one.

---

## 0. CI gates (run before claiming a feature works)

- **G1** `npm run build` — Vite build (`auto-test.yml:62`).
- **G2** `npm run test-backend` — picks the right runner by Node version: Node ≥ 22 → `test-backend-22`; Node 20 → `test-backend-20`. Drives `test/backend-test/**` including `check-translations.test.js`, `test-notification-provider.js`, `test-migration.js`, `test-uptime-calculator.js`, `test-ping-chart.js`, `test-monitor-response.js`, `test-evaluator.js` etc. (`test/test-backend.mjs`, `package.json:54-61`, `auto-test.yml:64`).
- **G3** `npm run lint:prod` = `lint:js-prod && lint:style` (`auto-test.yml:120`).
- **G4** `npm run validate` — `validate.yml` runs `extra/check-lang-json.js`, `extra/check-knex-filenames.mjs`, `extra/check-package-json.mjs`.
- **G5** Matrix: Node 20 / 24 / 25 across macOS / ubuntu-22.04 / Windows / ubuntu-22.04-arm (`auto-test.yml:42-58`).
- **G6** PR title MUST follow Conventional Commits (`pr-title.yml`).
- **G7** PR description MUST mention `avoid unnecessary back and forth` or it is auto-closed (`pr-description-check.yml`).
- **G8** `prevent-file-change.yml` blocks any change to `src/lang/*.json` other than `src/lang/en.json` from untrusted authors.

---

## 1. Status constants & state machine

- **L1.1** Status codes are fixed: `DOWN=0, UP=1, PENDING=2, MAINTENANCE=3`. — `src/util.js:21-24`. **T: implicit across `test-uptime-calculator.js`, `test-monitor-response.js`, `test-backend-test/check-translations.test.js`.**
- **L1.2** `MIN_INTERVAL_SECOND = 1`; `interval` and `retryInterval` ≥ 1. — `src/util.js:32`, enforced `server/model/monitor.js:1626-1632`.
- **L1.3** `flipStatus` only flips UP↔DOWN; PENDING and MAINTENANCE pass through untouched. — `src/util.js:115-123`. **T: `test-uptime-calculator.js`** treats MAINTENANCE as excluded from uptime but counted in `flatStatus` → UP.
- **L1.4** Fresh `bean.status = DOWN` before any check. — `server/model/monitor.js:456`.
- **L1.5** `MonitorType.check()` must EITHER set `bean.status = UP` and return, OR `throw`. Setting `bean.status = DOWN` without throwing is rejected at `server/model/monitor.js:869-882` unless `allowCustomStatus = true` (used only by `group` and `manual`).
- **L1.6** `allowCustomStatus` is reserved for `group` + `manual`. Any new monitor type using it must justify in code.
- **L1.7** "Important" transitions are whitelisted in `isImportantBeat` (`monitor.js:1385-1411`) and a strict subset in `isImportantForNotification` (`monitor.js:1420-1443`). `UP→PENDING`, `PENDING→PENDING`, `PENDING→UP`, `DOWN→DOWN`, `DOWN→PENDING`, `MAINTENANCE→MAINTENANCE` are NOT important. **`MAINTENANCE→UP` is important-for-status but NOT important-for-notification.**
- **L1.8** PENDING semantics: a thrown error inside check → `retries++` (if `retries < maxretries`), `bean.status = PENDING`. `retries` is persisted on the bean and rehydrated from the latest heartbeat (`monitor.js:444-448, 948-958`).
- **L1.9** Upside-down: default DOWN is pre-flipped to UP; post-check UP→DOWN is achieved via `throw "Flip UP to DOWN"` (re-enters retry/PENDING path with `retries=0`). — `monitor.js:459-461, 905-911`. PENDING is NOT flipped → a new status that survives `flipStatus` bypasses inversion.
- **L1.10** Maintenance overrides check: skipped heartbeat with `status=MAINTENANCE`. Parent maintenance inherits to children (`monitor.js:1596-1618`). — A new code path inserted AFTER line 470 won't run under maintenance.
- **L1.11** First-beat UP never notifies (`monitor.js:1453`); only first-beat DOWN notifies.
- **L1.12** Resend-notification loop only triggers on non-important DOWN beats, when `downCount >= resendInterval`. — `monitor.js:986-1003`; mirrored in `api-router.js:109-122`. **T:** encoded implicitly by `test-monitor-response.js`.
- **L1.13** Every important beat calls `apicache.clear()` (`monitor.js:982-983`) and re-emits `sendMaintenanceListByUserID`.

---

## 2. Uptime calculator / statistics

- **L2.1** `getMinutelyKey(d) = d.startOf("minute").unix()` (multiple of 60). — `uptime-calculator.js:448-466`. **T: `test-uptime-calculator.js:55-69`** (20:46:59/20:46:01/20:46:00 ⇒ 20:46:00).
- **L2.2** `getHourlyKey(d) = d.startOf("hour").unix()` (multiple of 3600). — `uptime-calculator.js:474-492`.
- **L2.3** `getDailyKey(d) = d.utc().startOf("day").unix()` — FORCED UTC. — `uptime-calculator.js:503`. **T: `test-uptime-calculator.js:165-167`** (HK local → UTC day).
- **L2.4** Every bucket seeds `{up:0, down:0, avgPing:0, minPing:0, maxPing:0}`. New counters must init here too. — `uptime-calculator.js:456-462, 482-488, 507-513`.
- **L2.5** `getData`/`getDataArray` walks by fixed-second step (60/3600/86400). — `uptime-calculator.js:587-594, 624-636, 715-722, 751-764`.
- **L2.6** Walk-back is inclusive on both ends ⇒ `get24Hour()` is 1440 minutes, `get7Day()` is 168 hours. — `uptime-calculator.js:593, 600, 806-829`.
- **L2.7** Hard caps in `getData`: ≤ 1440 / 720 / 365. Exceeding throws. — `uptime-calculator.js:564-572, 698-703`.
- **L2.8** `LimitQueue` sizes = 1440 / 720 / 365 (line 34/41/47). Extending retention must raise these too or data drops.
- **L2.9** Cleanup `UPDATE … WHERE monitor_id = ? AND timestamp < cutoff` runs with `createIfMissing = false`. — `uptime-calculator.js:362-370`. **T: `test-uptime-calculator.js:90-142`** pins the regression.
- **L2.10** `flatStatus()` collapses `UP|MAINTENANCE` → UP and `DOWN|PENDING` → DOWN; everything else throws. — `uptime-calculator.js:545-555`. **T: `test-uptime-calculator.js:47-53`**.
- **L2.11** MAINTENANCE bumps bucket `maintenance` only; never `up`, `down`, `avgPing`, `minPing`, `maxPing`. **T: `test-uptime-calculator.js:208-213, 309-313`** ⇒ 100% MAINTENANCE window has `uptime = 0`.
- **L2.12** Only UP beats contribute to ping stats; NaN short-circuits but does NOT clear counters. — `uptime-calculator.js:212-294`.
- **L2.13** `avgPing` is incremental mean over only UP beats in the bucket (lines 244-273).
- **L2.14** First UP in a bucket seeds `minPing=maxPing=avgPing=ping`. An all-DOWN bucket has `minPing=maxPing=0` (NOT filtered out by `test-ping-chart.js:39-43`, which gates on `up > 0`).
- **L2.15** `avgPing=0` is valid; don't conflate with `null`/`undefined`. **T: `test-ping-chart.js:10-19`**.
- **L2.16** Window dispatch: `get24Hour` uses minutes, `get7Day` uses hours, `get30Day`/`get1Year` use DAILY (not 30×24 hourly). **T: `test-uptime-calculator.js:418-420`** asserts 30d = 30 daily buckets even after 365 alternating beats.
- **L2.17** `getData` returns `uptime = up/(up+down)`, or 0 if both 0 (no MAINTENANCE injection).
- **L2.18** `avgPing` returned by `getData` is weighted by per-bucket `up` count. — `uptime-calculator.js:673-686`.
- **L2.19** Fallback when window is empty: latest populated bucket (NOT latest heartbeat). — `uptime-calculator.js:642-671`.
- **L2.20** `UptimeCalculator.currentDate` overridable only via `process.env.TEST_BACKEND`. Code paths that call `dayjs.utc()` directly bypass this seam (e.g. `monitor.js:455`).
- **L2.21** `update(date)` is called exactly once per heartbeat (`monitor.js:1053-1055`, `api-router.js:92-94`); a second call would double-count.
- **L2.22** `bean.end_time` is the return value of `update()` and equals the bucket-key instant.
- **L2.23** All heartbeat/bucket/retention timestamps use UTC. Local-time overrides break alignment. — `uptime-calculator.js:131, 157, 182, 503, 835`; `clear-old-data.js:46-49`.
- **L2.24** `getCurrentDate()` is a non-monotonic `dayjs.utc()` — wall-clock backwards jumps can poison keys. **T: implicit, no protection.**
- **L2.25** `chartSocketHandler` granularity tier switches by requested period size: ≤24 → minutes×60, ≤720 → hours, else days×24. — `chart-socket-handler.js:19-25`.
- **L2.26** `Monitor.sendStats` truncates `avgPing.toFixed(2)` — presentation only. — `monitor.js:1322`.
- **L2.27** Prometheus `update` divides `avgPing/1000` and tolerates `null`. — `prometheus.js:180-188`.
- **L2.28** Badge uptime ⇒ `uptime*100.toPrecision(4)`. — `api-router.js:261`.
- **L2.29** Stat table `UNIQUE (monitor_id, timestamp)` is the upsert key. Concurrent `update()` races on the same key can violate it. — `knex_migrations/2023-08-16-0000-create-uptime.js:19,37`, `2023-12-22-0000-hourly-uptime.js:20`.
- **L2.30** `stat_daily.up|down` are `integer unsigned` (was overflowed by long-uptime monitors — see `2026-07-22-0000-fix-stat-daily-overflow.js`); `stat_minutely|hourly` are still `smallint`.
- **L2.31** `ping|ping_min|ping_max` are `FLOAT(20, 2)` (`2026-01-10-0000-convert-float-precision.js`).
- **L2.32** `stat_minutely` retention 24h, `stat_hourly` 30d, `stat_daily` retention lives in `clear-old-data.js` job (UTC-day-aligned cutoff). — `uptime-calculator.js:362-370`; `clear-old-data.js:13-60`.
- **L2.33** Heartbeat retention deletes `important=0 AND time<now-24h AND id NOT IN top-100-by-time`. — `database.js:983-1010`.
- **L2.34** Stat migration (`migrateAggregateTableState`) refuses to run if `stat_minutely|stat_hourly|stat_daily` non-empty. — `database.js:861-908`. **Bypass: `SET_MIGRATE_AGGREGATE_TABLE_TO_TRUE=1`.**

---

## 3. Monitor lifecycle / beat loop

- **L3.1** Exactly one `heartbeatInterval` timer per monitor. `stop()` clears it, sets `isStop=true`. Next-beat gate is `if (!this.isStop)`. — `monitor.js:1074, 1211-1216`.
- **L3.2** `startMonitor` MUST `await stop()` an existing monitor before installing a new one. Direct `monitor.start(io)` without prior `stop()` leaks duplicate timers. — `server.js:1901-1916`.
- **L3.3** `safeBeat` is the resilience wrapper: emergency reschedule at `interval*1000` if `beat()` throws unexpectedly. Throws OUTSIDE the inline try/catch at line 469-956 leak here. — `monitor.js:1091-1104`.
- **L3.4** Push type is the only one that schedules its next beat INSIDE `beat()` (line 771) to align to external push timestamps. Other types schedule from the tail.
- **L3.5** Push monitor's first schedule delay is `interval*1000`; all other types schedule immediately via `safeBeat()`. — `monitor.js:1108-1112`.
- **L3.6** Demo mode silently raises any interval `<20` to 20. — `monitor.js:433-438`.
- **L3.7** Default `timeout` is `interval*1000*0.8` when unset or non-positive. — `monitor.js:465-467`.
- **L3.8** Real-browser `screenshot_delay` must satisfy `delay < 0.8*timeout AND delay < 0.5*interval`. — `monitor.js:1759-1768`. Mirror for any new delay-like param.
- **L3.9** Bean defaults: `status=DOWN`, `downCount=previousBeat?.downCount||0`, `time=ISO`, `monitor_id=...`. — `monitor.js:455-457`.
- **L3.10** Emission order is `socket.emit("heartbeat", …)` → `R.store(bean)`, NOT vice versa. UI sees state before DB commit. — `monitor.js:1059, 1064`; mirrored in `api-router.js:125-127`. **Latent inconsistency: notification fires at line 970 BEFORE emit AND store — if the DB write fails, the notification went out for a non-persisted heartbeat.**
- **L3.11** `Monitor.isActive(monitorID, active)` requires both `active=1` AND all ancestors `isParentActive(monitorID)`. — `monitor.js:1302-1306, 2030-2039`.
- **L3.12** Children are NOT auto-paused by the beat loop when parent is down — `forceInactive` is set on the JSON for the frontend. Only `group` type filters inactive children. — `monitor.js:145, 1878`, `monitor-types/group.js:27-30`.
- **L3.13** Parent cycle is NOT guarded in `getAllChildrenIDs` — must be prevented at assignment (`monitor.js:1956-1971`).
- **L3.14** `Monitor.sendStats` short-circuits when no clients in the room. — `monitor.js:1341`. New aggregations must preserve this guard.
- **L3.15** `sendMonitorList`/`getMonitorJSONList` rely on `preparePreloadData` to batch-load notifications/tags/children/maintenance. New per-monitor lookups must extend `preparePreloadData` (`monitor.js:1820-1895`) or they will N+1.
- **L3.16** Condition evaluator: empty conditions ⇒ `null` from `ConditionExpressionGroup.fromMonitor`, which is "always pass". `dns.js:32` guards with `(conditions ? evaluateExpressionGroup(conditions, data) : true)`. New types must guard the same way.
- **L3.17** `evaluateExpression` throws if a `conditionVariables` key is missing in `data`. — `evaluator.js:25-27`.
- **L3.18** Down count resendNotification must be wired in BOTH `monitor.js:986-1003` AND `api-router.js:109-122` (push HTTP). **T: behavioural.**
- **L3.19** Push entry re-reads previousBeat on every call (`monitor.js:444`). Push success path (line 771-772) returns without storing — heartbeat is written by `/api/push/:token` (`api-router.js:72-127`).
- **L3.20** Push `determineStatus` separately produces PENDING when `previous.status===UP && status===DOWN && previous.retries<maxretries` (`api-router.js:573-616`). Bypassing it breaks push retry counting.

---

## 4. Database / migration / model

- **L4.1** Shipped migrations are IMMUTABLE — knex tracks by filename; editing/renaming causes "missing file" warnings or re-application that corrupts schema. — `database.js:514-516, 524-528`.
- **L4.2** Filename = `YYYY-MM-DD-HHmm-<name>.js`. Enforced by `extra/check-knex-filenames.mjs` (called in `validate.yml`); only tolerated deviations are listed in its `exceptionList`.
- **L4.3** Every migration exports `up(knex)` AND `down(knex)`. Commented "irreversible" is allowed when the loss is documented.
- **L4.4** All primary keys are `table.increments("id")` (`db/knex_init_db.js:17-401` and every migration adding a table).
- **L4.5** Migrations must run on SQLite + MariaDB + MySQL + embedded-mariadb. Branch with `knex.client.dialect === "sqlite3"` or `"mysql2"` when necessary. — **T: `test-migration.js:8-188`** exercises SQLite + MariaDB 12 + MySQL 8.0 containers.
- **L4.6** Never edit `db/knex_init_db.js` (header warns "DO NOT ADD ANYTHING HERE"). Add new fields via new migrations.
- **L4.7** Database init flow: SQLite → use existing file; MariaDB/MySQL → call `createTables()` once, then `migrate.latest`; SQLite runs `migrate.latest` with `PRAGMA foreign_keys=OFF/ON`. — `database.js:480-534`.
- **L4.8** SQLite default pool `{min:1, max:1}` unless `UPTIME_KUMA_SQLITE_SINGLE_CONNECTION!=="false"`. — `database.js:306-320`.
- **L4.9** Test-mode SQLite uses `journal_mode=MEMORY`, prod uses `WAL`. — `database.js:449-474`.
- **L4.10** Test setup: `test/mock-testdb.js` writes `data-dir` + `db-config.json`, calls `Database.connect(true)` (`testMode`). `test-migration.js` directly drives knex without R.autoloadModels.
- **L4.11** `redbean-node` model contract: filename `server/model/<name>.js` ⇔ table `name` (lowercased singular). `R.autoloadModels("./server/model") + R.freeze(true)` at `database.js:425-429`.
- **L4.12** Column naming: snake_case in DB, camelCase in JSON. The model's `toJSON()` must convert.
- **L4.13** `toJSON()` for socket, `toPublicJSON()` for the public status page. Models without both leak admin data: `proxy.js`, `docker_host.js`, `remote_browser.js` currently rely on `bean.export()` and include raw DB rows (with possible embedded creds) for the admin's own browser. **T: implicit — exercised only through the status-page route suite.**
- **L4.14** Monitor `toJSON` must gate every secret field behind `includeSensitiveData`. Adding a new secret column without this guard leaks it through every monitor list emit. — `monitor.js:221-254`. Notification providers are called with `includeSensitiveData: false` (`monitor.js:1510`).
- **L4.15** Heartbeat `toPublicJSON` must scrub `msg`. `toJSONAsync({decodeResponse:true})` is the only path that decompresses the response body.
- **L4.16** Settings cache: 60s TTL, JSON-stringified values, `Settings.set`/`setSettings` MUST call `Settings.deleteCache(keys)`. Non-JSON values silently change type after round-trip. — `settings.js:19-156`.
- **L4.17** `Database.connect()` must run before any model code. Without it, `R.dispense(...)` throws.
- **L4.18** `Database.patchList` is deprecated and FROZEN — never extend it; old path only for pre-knex migrations. `latestVersion=10`.
- **L4.19** FK on `monitor_id` cascades from monitor DELETE; SQLite needs `PRAGMA foreign_keys=ON` (set in `database.js:463`). Without it, deleting a monitor leaves orphan stat rows that `init()` may resurrect.

---

## 5. Auth, socket events, API surface

- **L5.1** Every authenticated socket handler starts with `checkLogin(socket)` (`util-server.js:644-648`). Forgetting it (or wrapping it in a `try` that swallows the throw) leaves the event callable pre-login.
- **L5.2** Deliberately-unauthenticated socket events: `loginByToken`, `login`, `logout`, `needSetup`, `setup` (guarded by `userCount==0`), `getWebpushVapidPublicKey` (returns public key only).
- **L5.3** Every per-user record access is scoped with `user_id = ?`. Canonical reads: `R.findOne("monitor"," id=? AND user_id=? ",[id,socket.userID])`. Canonical guard: `if (bean.user_id !== socket.userID) throw "Permission denied."` (`server.js:825`). Writes set `bean.user_id = socket.userID`. Every emit uses `io.to(socket.userID)`.
- **L5.4** Known gaps in current scoping (flag in code review):
    - `getMonitorBeats`, `clearEvents` (`server.js:1065-1074, 1664`) — by `monitor_id` only.
    - `disableAPIKey`/`enableAPIKey` (`api-key-socket-handler.js:101,126`) — by `id` only.
    - Tags (`server.js:1217-1304`) — intentionally global (confirm by design).
- **L5.5** Passwords go through `passwordHash.generate/verify` (`password-hash.js`); the only exception is the SHA1 legacy path triggered by hashes prefixed `"sha1"` (for upgrade). All other call sites: `server.js:719` (setup), `auth.js:22-28` (login), `util-server.js:665` (re-check), `user.js:17,28,30` (reset/change), `api-key-socket-handler.js:23` (key hashing), `util-server.js:50` (JWT secret hashing).
- **L5.6** `passwordStrength(...).value === "Too weak"` is rejected on setup, changePassword, and reset CLI.
- **L5.7** Rate limits: `loginRateLimiter` 20/min, `apiRateLimiter` 60/min, `twoFaRateLimiter` 30/min (`rate-limiter.js:61-80`). Used at `server.js:465` (login), `server.js:532` (logout), `server.js:546,591,621` (2FA ops), `auth.js:81,90-94` (basic auth attempts).
- **L5.8** API keys: cleartext returned ONCE on generation, then hashed via bcrypt. Active only when `active=1 AND expiry>now`. List endpoint must use `toPublicJSON` to strip the bcrypt hash. Format `uk<id>_<clear>` — verification splits on the underscore.
- **L5.9** Status page REST routes (`api-router.js`, `status-page-router.js`) are intentionally unauthenticated except `/metrics` which uses `apiAuth`. Adding a new admin REST route outside `apiAuth` is a breach.
- **L5.10** Public status page serializers (`Monitor.toPublicJSON`, `StatusPage.toPublicJSON`, `Heartbeat.toPublicJSON`, `Incident.toPublicJSON`, `Group.toPublicJSON`, `Maintenance.toPublicJSON`, `APIKey.toPublicJSON`) are the ONLY serializers reachable from `/api/status-page/*` and `/status/:slug`. Public cache headers: `apicache("5 minutes")`.
- **L5.11** A monitor is public only when it belongs to at least one group with `public=1 AND status_page_id=?` (`api-router.js:623-633`, `model/status_page.js:331`).
- **L5.12** CORS is `*` only in dev (`uptime-kuma-server.js:139-145`); in prod, `cors` is `undefined`. `allowDevAllOrigin` / `allowAllOrigin` set `Access-Control-Allow-Origin:*` per response (`util-server.js:621-636`).
- **L5.13** WebSocket upgrade `Origin == Host` (or `X-Forwarded-Host` when `trustProxy`), bypass via `UPTIME_KUMA_WS_ORIGIN_CHECK=bypass` (`server.js:62`, `uptime-kuma-server.js:149-197`).
- **L5.14** `X-Frame-Options: SAMEORIGIN` unless `UPTIME_KUMA_DISABLE_FRAME_SAMEORIGIN`; `X-Powered-By` stripped (`server.js:217-220`).
- **L5.15** JWT secret's bcrypt-hash fingerprint is bound into JWT so a password reset invalidates outstanding tokens (`server.js:407, 415-417`; `user.js:42-49`).
- **L5.16** `disableAuth=true` short-circuits `basicAuth`, `apiAuth`, and socket login. Changing the setting from `false` to `true` requires double-confirming the current password; switching `true → false` forcibly disconnects existing sockets (`server.js:1508-1517`).
- **L5.17** `changePassword` calls `server.disconnectAllSocketClients(user.id, socket.id)` (`server.js:1461`).

---

## 6. Notification provider contract

- **L6.1** File lives at `server/notification-providers/<name>.js`, exports the class via `module.exports` (`notification.js:3-110`).
- **L6.2** Class extends `NotificationProvider` (`notification-provider.js:23-25`).
- **L6.3** Declares `name = "<uniqueKey>"` as an instance field, unique across the registry (`notification.js:236-243`). Duplicate = boot crash.
- **L6.4** Must be `require`d and `new X()` added to the `list` array (`notification.js:126-234`).
- **L6.5** Implements `async send(notification, msg, monitorJSON = null, heartbeatJSON = null)` returning `Promise<string>`. Returns the conventional `okMsg = "Sent Successfully."`.
- **L6.6** Throws failures via `try { … } catch (error) { this.throwGeneralAxiosError(error); }` (`notification-provider.js:121-168`). Raw-throw literals are caught by ESLint `no-throw-literal: error` (`.eslintrc.js:49`).
- **L6.7** Honor proxy via `getAxiosConfigWithProxy()`. Honor URL extraction via `extractAddress()`. Honor Liquid templates via `renderTemplate({STATUS,NAME,HOSTNAME_OR_URL,status,name,hostnameOrURL,monitorJSON,heartbeatJSON,msg})`.
- **L6.8** Vue form lives at `src/components/notifications/<KEY>.vue`. Registered in `src/components/notifications/index.js`: an `import` line + an entry in the `NotificationFormList` map. The map key must equal the server-side `name`.
- **L6.9** Added to exactly one category in `NotificationDialog.vue:206-381`: `universal|chatPlatforms|pushServices|smsServices|email|incidentManagement|homeAutomation|other|regional`. Category name appears as the optgroup label and as a key in `notificationFullNameList`.
- **L6.10** Secrets in the Vue form use `<HiddenInput>`. All UI strings use `$t(...)` / `<i18n-t keypath="...">` — never hardcoded. **T: `test-notification-provider.js` + `mock-webhook.js`** for shape; `check-translations.test.js` for key presence.
- **L6.11** Required PR content for a new provider: screenshots for UP / DOWN / Cert-Expiry (`https://expired.badssl.com/`) / Domain-Expiry (`https://google.com/` w/ longer threshold) / Test button. (`CONTRIBUTING.md:144-162`.)

---

## 7. i18n / translation

- **L7.1** Only `src/lang/en.json` is the source of truth. All other langs are managed by Weblate. PRs editing them trigger merge conflicts and `prevent-file-change.yml`.
- **L7.2** Every `$t("…")`, `i18n-t keypath="…"`, and `new TranslatableError("…")` key MUST exist in `en.json`. **T: `check-translations.test.js:62-138`** reports missing keys with file:line:col.
- **L7.3** `en.json` placeholder sets per key MUST match upstream `https://raw.githubusercontent.com/louislam/uptime-kuma/master/src/lang/en.json`. **T: `check-translations.test.js:140-174`** (deleted keys OK; renaming `{x}`→`{y}` in an existing key fails).
- **L7.4** All `src/lang/*.json` files are 4-space pretty-printed (`tabWidth:4`, `trailingComma:"none"`). **T: `extra/check-lang-json.js`** (CI). **G4.**
- **L7.5** Server-side translatable errors use `TranslatableError` (msgi18n=true).

---

## 8. Settings

- **L8.1** All settings live in the `setting` table (`key` UNIQUE, `value` TEXT, `type` VARCHAR(20)). `db/knex_init_db.js:383-388`.
- **L8.2** `Settings.set(key, value, type)` and `Settings.setSettings(dict)` MUST call `Settings.deleteCache(keyList)` (`settings.js:81, 133`). This is the only invalidation.
- **L8.3** Cache TTL is 60s (`settings.js:30-40`). `Settings.stopCacheCleaner()` must be called on shutdown.
- **L8.4** Values are JSON-stringified; non-JSON values (Date, BigInt, fns) silently coerce/throw on round-trip. Use type-aware accessors.

---

## 9. Code style / lint (PR-blocking)

- **L9.1** 4-space indent, no tabs. **T: `lint:prod` → ESLint + Prettier** (`.editorconfig`, `.prettierrc.js:16`).
- **L9.2** Double quotes, semicolons required, `printWidth:120`, `endOfLine:"lf"`, JSON trailing comma `"es5"`, JSON override `"none"`. (`.prettierrc.js`)
- **L9.3** JSDoc required on FunctionDeclaration/MethodDefinition (`.eslintrc.js:78-86`). `jsdoc/no-defaults` forbids `optional` prefix on optional param names.
- **L9.4** `no-throw-literal: error` — must throw `new Error` or `new TranslatableError`.
- **L9.5** `jsdoc/require-returns-check: error` + `jsdoc/require-returns` force async functions to return.
- **L9.6** Several `vue/*` rules are intentionally disabled (`.eslintrc.js:40-45`); do not re-enable.
- **L9.7** Stylelint uses `stylelint-config-standard` + `stylelint-config-prettier`, `alpha-value-notation:"number"`, `color-function-notation:"legacy"`.
- **L9.8** ESLint ignores `test/*.js`, `server/modules/*`, `src/util.js`. (`test/backend-test/**` IS linted.)

---

## 10. Public-vs-private serializer boundary

- **L10.1** Every persisted entity has both `toJSON` (admin, may include secrets) and `toPublicJSON` (public, never secrets). Confirmed pairs:
    - `server/model/monitor.js:84` vs `:116`
    - `server/model/status_page.js:438` vs `:467`
    - `server/model/heartbeat.js:19` (public) vs `:32` (admin; `toJSONAsync` for response body)
    - `server/model/api_key.js:24` vs `:42`
    - `server/model/maintenance.js:15` vs `:101` (intentionally same shape)
    - `server/model/incident.js:21` and `server/model/group.js:13` are public-only by design.
- **L10.2** Entities without a `toPublicJSON` (`proxy.js`, `docker_host.js`, `remote_browser.js`) currently rely on `bean.export()` for the admin's browser. They MUST NOT reach a non-admin path without a `toPublicJSON` first.
- **L10.3** Heartbeat `msg` is redacted on public serialization: `msg: "" // Hide for public` (`heartbeat.js:23`).

---

## 11. How to use this list

1. Pick which categories your feature touches (almost always 1+2+4; add 5/6/7/9/10 as needed).
2. Cross off each `L` in the touched categories — the inverse ("can I keep my feature without violating this?") is the test.
3. Run the entire CI gate in §0 locally:
    - `npm run build && npm run test-backend && npm run lint:prod && npm run validate`
4. For each touched law, run the matching `T` test in isolation. e.g.:
    - Touched L1.* / L3.* → `test/backend-test/test-monitor-response.js`, `test/backend-test/monitor-conditions/*`.
    - Touched L2.* → `test/backend-test/test-uptime-calculator.js`, `test/backend-test/test-ping-chart.js`.
    - Touched L4.* → `test/backend-test/test-migration.js` (it spins SQLite + MariaDB 12 + MySQL 8.0 containers on a fresh DB; the new migration must pass all three).
    - Touched L6.* / L7.* → `test/backend-test/notification-providers/test-notification-provider.js` + `test/backend-test/check-translations.test.js`.
    - Touched L5.* → there is no dedicated suite — pre-existing gaps are documented under L5.4; ensure your new handler does NOT regress.
5. If your feature introduces a new key in `en.json`, also verify the `{placeholder}` invariant (L7.3) holds before pushing.

The laws marked **L5.4** are pre-existing weaknesses, not regressions — flag your new handler to avoid widening them, and call them out in the PR description.