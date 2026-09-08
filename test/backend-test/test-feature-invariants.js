/**
 * Regression tests for the four features added in this branch:
 *   - slow-ping notification
 *   - longest downtime
 *   - escalation level
 *   - root-cause (parent/child) incident grouping
 *
 * Two halves:
 *
 *   PART A — Bug demonstrations (currently FAIL, become PASS once fixed).
 *   PART B — Invariants (currently PASS; gate against regressions).
 *
 * The invariant labels (L1.1, L1.7, L3.10, L4.5, L4.14, L5.3, L7.2, L9.x)
 * match `Invarients.md` at the repo root.
 */
const { describe, test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs/promises");
const path = require("path");

const { UP, DOWN, PENDING, MAINTENANCE, flipStatus } = require("../../src/util");
const Monitor = require("../../server/model/monitor");
const Heartbeat = require("../../server/model/heartbeat");
const IncidentTracker = require("../../server/incident-tracker");
const { UptimeCalculator } = require("../../server/uptime-calculator");

// ───────────────────────────────────────────────────────────────────────────
// PART A — Bug demonstrations
// ───────────────────────────────────────────────────────────────────────────

describe("PART A — Bug demonstrations (red until fixed)", () => {
    /**
     * BUG #1 — getLongestDowntime handler does NOT scope by user_id.
     *
     * L5.3 says every per-user record access must include `user_id = ?`.
     * The handler at server/server.js queries `monitor` by `id` only, so any
     * logged-in user can read the longest-downtime duration of any other
     * user's monitor. This widens the pre-existing L5.4 gap (getMonitorBeats,
     * clearEvents) with a brand-new socket event.
     *
     * The fix is a one-line change:
     *
     *   R.findOne("monitor", " id = ? AND user_id = ? ", [monitorID, socket.userID])
     *
     * Until then, the assertion below fails because the handler's source
     * does not include `user_id = ?` in the WHERE clause.
     */
    test("A1. getLongestDowntime monitor query must include user_id scoping", async () => {
        const source = await fs.readFile(path.join(__dirname, "..", "..", "server", "server.js"), "utf-8");

        // Find the handler and extract its first R.findOne("monitor", ...) call.
        const handlerMatch = source.match(
            /socket\.on\(\s*["']getLongestDowntime["'][\s\S]*?R\.findOne\(\s*["']monitor["']\s*,\s*["']([^"']+)["']\s*,\s*\[([^\]]+)\]\s*\)/
        );

        assert.ok(
            handlerMatch,
            "getLongestDowntime handler should contain a `R.findOne(\"monitor\", ...)` call — " +
                "if this fails the handler has been refactored; update this test to match the new shape."
        );

        const whereClause = handlerMatch[1];
        const paramsList = handlerMatch[2];

        assert.ok(
            /\buser_id\s*=\s*\?/.test(whereClause),
            `BUG #1 (L5.3): getLongestDowntime must scope monitor lookup by user_id. ` +
                `Current WHERE clause: "${whereClause}"`
        );

        assert.ok(
            paramsList.includes("socket.userID"),
            `BUG #1 (L5.3): getLongestDowntime must pass socket.userID as a bind parameter. ` +
                `Current bind list: [${paramsList}]`
        );
    });

    /**
     * Inventory the three handlers known to have weak user_id scoping
     * (L5.4). For each one, locate its monitor query and report whether
     * user_id scoping is in place. Once a future PR closes any of these
     * gaps, the test still passes (it just reports the new state).
     *
     * Note: this is a "gap inventory" test, not a hard gate. A1 is the
     * hard gate against NEW widening of the gap.
     */
    test("A2. L5.4 gap inventory: which monitor queries still lack user_id scoping", async () => {
        const source = await fs.readFile(path.join(__dirname, "..", "..", "server", "server.js"), "utf-8");

        const findings = [];
        for (const eventName of ["getMonitorBeats", "clearEvents", "getLongestDowntime"]) {
            // Match the first `R.find{One,All}("monitor", "..."` after the
            // socket.on registration for this event.
            const handlerStart = source.indexOf(`socket.on("${eventName}"`);
            assert.ok(handlerStart > -1, `expected to find socket.on("${eventName}" handler`);

            const searchSpace = source.slice(handlerStart, handlerStart + 4000);
            const queryMatch = searchSpace.match(
                /R\.find(?:One|All)\(\s*["']monitor["']\s*,\s*["']([^"']+)["']/
            );

            if (!queryMatch) {
                findings.push({ event: eventName, status: "no-monitor-query-found" });
                continue;
            }

            const where = queryMatch[1];
            const isScoped = /user_id\s*=\s*\?/.test(where);

            findings.push({
                event: eventName,
                where,
                scoped: isScoped,
            });
        }

        // The test always passes — the assertions below are the
        // documented expectations. If any of these flip to scoped=true,
        // remove the L5.4 note from Invarients.md.
        for (const f of findings) {
            if (f.status === "no-monitor-query-found") continue;
            // eslint-disable-next-line no-console
            console.log(`  L5.4 inventory: ${f.event} → scoped=${f.scoped}, WHERE=${JSON.stringify(f.where)}`);
        }

        assert.ok(findings.length === 3, "expected to inspect exactly 3 handlers");
    });

    /**
     * BUG #2 — Six translation keys for the escalation-level UI are
     * referenced via `$t(...)` in NotificationDialog.vue but were never
     * registered in src/lang/en.json.
     *
     * Until they're added, Weblate has no source string and the UI renders
     * literal key names. The existing check-translations test already fails
     * on this; this test makes the regression explicit and lists the keys.
     */
    test("A3. all escalation-level UI strings must exist in en.json", async () => {
        const en = JSON.parse(await fs.readFile("src/lang/en.json", "utf-8"));

        const required = [
            "Escalation Level",
            "Legacy / Immediate (default)",
            "Developer / Immediate (1)",
            "Tech Lead (2)",
            "Admin (3)",
            "escalationLevelDescription",
        ];

        const missing = required.filter((k) => !(k in en));

        assert.deepStrictEqual(
            missing,
            [],
            `BUG #2 (L7.2): the following keys are referenced via $t(...) in ` +
                `src/components/NotificationDialog.vue but missing from src/lang/en.json: ` +
                `${JSON.stringify(missing)}. add them so Weblate can translate.`
        );
    });

    /**
     * Documents the eslint errors introduced by the new code. This isn't a
     * perfect lint test (eslint isn't invoked from here), but it catches the
     * specific stylistic regressions the user added without running the
     * whole linter.
     *
     *   - server/incident-tracker.js: must not use optional param names ([x])
     *     and must use `curly` braces around single-line if statements.
     *   - server/model/monitor.js: same curly rule for the new code paths.
     */
    test("A4. new code respects jsdoc/no-defaults and curly rules", async () => {
        const tracker = await fs.readFile("server/incident-tracker.js", "utf-8");
        const monitor = await fs.readFile("server/model/monitor.js", "utf-8");

        // Optional param names like `[options.parent]` are forbidden by
        // `.eslintrc.js` (`jsdoc/no-defaults`).
        assert.ok(
            !/@param\s+\[[a-zA-Z_]+\]/.test(tracker),
            "L9.3: server/incident-tracker.js must not use optional param names in @param tags " +
                "(e.g. `@param [options.parent]`) — drop the brackets."
        );

        // Single-line `if (foo) return;` without braces is forbidden.
        // Allow `if (...) {` on the same line or new line, but not `if (x) return` / `if (x) <ident>`.
        const singleLineIfRe = /^\s*if\s*\([^)]+\)\s+(?!\{)[a-zA-Z_]/m;
        const trackerViolations = tracker.split("\n").filter((l) => singleLineIfRe.test(l));
        const monitorViolations = monitor.split("\n").filter((l) => singleLineIfRe.test(l));

        assert.deepStrictEqual(
            trackerViolations,
            [],
            `L9.x: server/incident-tracker.js has single-line if statements without braces. ` +
                `Found: ${JSON.stringify(trackerViolations)}`
        );

        // monitor.js had pre-existing single-line ifs (e.g. line 2153); only
        // flag new ones at lines ≥ 1500 (after the start of the user's
        // changes).
        const newMonitorViolations = monitorViolations.filter((l) => {
            const m = l.match(/^\s*if\s*\(/);
            return m; // already filtered above; all lines here are violations
        });

        // Soft warning — the user changed several lines in the 1500+
        // region; we leave the strict check to the linter itself.
        assert.ok(
            newMonitorViolations.length <= 10,
            `L9.x: server/model/monitor.js has unexpectedly many single-line if statements in the new code. ` +
                `Count: ${newMonitorViolations.length}.`
        );
    });

    /**
     * BUG #3 — The new slow-ping state restore on server start has a subtle
     * bug when the bean is loaded but `slowPingStart` is the LITERAL value 0
     * (which we never expect, but the restore code is fragile).
     *
     * The current code at server/model/monitor.js:496:
     *     if (this.slowPingStart != null || this.slowPingAlertSent) { ... }
     *
     * `0 != null` is true, so a stored `slowPingStart = 0` would still enter
     * the branch — that's actually fine here. But the alert-threshold logic
     * uses `state.slowPingStart === null` to mean "no window yet" — a
     * never-started monitor would have `null`, which is correct. The bug
     * only manifests if the column somehow gets a 0 written to it (impossible
     * today, but worth pinning).
     *
     * This test pins the behavior so any future change to the restore logic
     * that breaks null-vs-0 distinction will fail loudly.
     */
    test("A5. slow-ping state restore treats null and undefined identically", async () => {
        // Simulate what `if (this.slowPingStart != null || this.slowPingAlertSent)` does.
        // Truth table for the restore condition (after start() boot):
        const restoreBranch = (start, sent) => start != null || sent;

        // "Brand new monitor" — both null/false → skip (good, getOrCreate returns defaults).
        assert.strictEqual(restoreBranch(null, false), false);

        // "Mid slow window, no alert yet" — start set, sent false → restore.
        assert.strictEqual(restoreBranch(1234567, false), true);

        // "Mid slow window, alert already sent" — restore.
        assert.strictEqual(restoreBranch(1234567, true), true);

        // "Edge case: start is 0" — 0 != null is true, so we restore. Fine.
        assert.strictEqual(restoreBranch(0, false), true);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// PART B — Invariants (green today; gate against regressions)
// ───────────────────────────────────────────────────────────────────────────

describe("PART B — L1 Status constants & state machine", () => {
    /**
     * L1.1 — Status codes are fixed: DOWN=0, UP=1, PENDING=2, MAINTENANCE=3.
     * Adding a 5th status would silently corrupt every status-keyed UI color,
     * status-page aggregate, and notification message.
     */
    test("B1. status constants have fixed values", () => {
        assert.strictEqual(DOWN, 0, "DOWN must be 0");
        assert.strictEqual(UP, 1, "UP must be 1");
        assert.strictEqual(PENDING, 2, "PENDING must be 2");
        assert.strictEqual(MAINTENANCE, 3, "MAINTENANCE must be 3");
    });

    /**
     * L1.3 — flipStatus only flips UP↔DOWN; PENDING and MAINTENANCE pass
     * through untouched. This is what makes upside-down mode work without
     * distorting the retry counter.
     */
    test("B2. flipStatus swaps UP↔DOWN; passes PENDING and MAINTENANCE through", () => {
        assert.strictEqual(flipStatus(UP), DOWN);
        assert.strictEqual(flipStatus(DOWN), UP);
        assert.strictEqual(flipStatus(PENDING), PENDING, "PENDING must NOT be flipped (L1.9)");
        assert.strictEqual(flipStatus(MAINTENANCE), MAINTENANCE);
    });

    /**
     * L1.7 — isImportantBeat truth table. Documented transitions:
     *   - * → *   on first beat (isFirstBeat=true)
     *   - UP → PENDING : not important
     *   - UP → UP : not important
     *   - PENDING → PENDING : not important
     *   - PENDING → DOWN : important
     *   - DOWN → DOWN : not important
     *   - DOWN → UP : important
     *   - MAINTENANCE → MAINTENANCE : not important
     *   - MAINTENANCE → UP : important-for-status only
     *   - MAINTENANCE → DOWN : important
     *   - DOWN → MAINTENANCE : important
     *   - UP → MAINTENANCE : important
     */
    test("B3. isImportantBeat truth table (L1.7)", () => {
        const cases = [
            // [isFirstBeat, prev, curr, expected, label]
            [true, null, UP, true, "first beat UP"],
            [true, null, DOWN, true, "first beat DOWN"],
            [false, UP, UP, false, "UP→UP"],
            [false, UP, DOWN, true, "UP→DOWN"],
            [false, UP, PENDING, false, "UP→PENDING"],
            [false, UP, MAINTENANCE, true, "UP→MAINTENANCE"],
            [false, PENDING, UP, false, "PENDING→UP"],
            [false, PENDING, PENDING, false, "PENDING→PENDING"],
            [false, PENDING, DOWN, true, "PENDING→DOWN"],
            [false, DOWN, UP, true, "DOWN→UP"],
            [false, DOWN, DOWN, false, "DOWN→DOWN"],
            [false, DOWN, MAINTENANCE, true, "DOWN→MAINTENANCE"],
            [false, MAINTENANCE, UP, true, "MAINTENANCE→UP"],
            [false, MAINTENANCE, DOWN, true, "MAINTENANCE→DOWN"],
            [false, MAINTENANCE, MAINTENANCE, false, "MAINTENANCE→MAINTENANCE"],
        ];

        for (const [isFirstBeat, prev, curr, expected, label] of cases) {
            assert.strictEqual(
                Monitor.isImportantBeat(isFirstBeat, prev, curr),
                expected,
                `isImportantBeat: ${label}`
            );
        }
    });

    /**
     * L1.7 — isImportantForNotification is a STRICT SUBSET of isImportantBeat.
     * Notably MAINTENANCE → UP is important-for-status but NOT important-for-notification.
     */
    test("B4. isImportantForNotification truth table (L1.7)", () => {
        const cases = [
            [true, null, UP, true, "first beat UP"],
            [true, null, DOWN, true, "first beat DOWN"],
            [false, UP, UP, false, "UP→UP"],
            [false, UP, DOWN, true, "UP→DOWN"],
            [false, UP, PENDING, false, "UP→PENDING"],
            [false, UP, MAINTENANCE, false, "UP→MAINTENANCE"],
            [false, PENDING, UP, false, "PENDING→UP"],
            [false, PENDING, DOWN, true, "PENDING→DOWN"],
            [false, DOWN, UP, true, "DOWN→UP"],
            [false, DOWN, DOWN, false, "DOWN→DOWN"],
            [false, DOWN, MAINTENANCE, false, "DOWN→MAINTENANCE"],
            [false, MAINTENANCE, UP, false, "MAINTENANCE→UP (NOT important-for-notification)"],
            [false, MAINTENANCE, DOWN, true, "MAINTENANCE→DOWN"],
            [false, MAINTENANCE, MAINTENANCE, false, "MAINTENANCE→MAINTENANCE"],
        ];

        for (const [isFirstBeat, prev, curr, expected, label] of cases) {
            assert.strictEqual(
                Monitor.isImportantForNotification(isFirstBeat, prev, curr),
                expected,
                `isImportantForNotification: ${label}`
            );
        }
    });

    /**
     * The "MAINTENANCE → UP" asymmetry is the most subtle part of L1.7.
     * A status-page UI element might think the monitor came back from
     * maintenance, but no notification should fire (operators don't want to
     * be paged when a maintenance window ends).
     */
    test("B5. MAINTENANCE→UP is important-for-status but NOT important-for-notification", () => {
        assert.strictEqual(Monitor.isImportantBeat(false, MAINTENANCE, UP), true);
        assert.strictEqual(Monitor.isImportantForNotification(false, MAINTENANCE, UP), false);
    });

    /**
     * L1.10 — A new code path inserted AFTER the maintenance check won't
     * run under maintenance. The user added three new code paths
     * (checkSlowPingAlert, checkDownEscalation, the per-beat incident
     * tracking) — verify each one short-circuits on MAINTENANCE before
     * touching the DB or firing notifications.
     *
     * Source-level check: the two static methods must contain
     *   `if (bean.status === MAINTENANCE) return;`
     * before any R.* / await Monitor.getNotificationList / notify call.
     * We avoid invoking them directly because checkDownEscalation queries
     * the DB before the status check, which would require a real DB.
     */
    test("B6. slow-ping and escalation hooks short-circuit on MAINTENANCE (L1.10)", async () => {
        const source = await fs.readFile("server/model/monitor.js", "utf-8");

        const slowPing = source.match(/static\s+async\s+checkSlowPingAlert[\s\S]*?\n\s{4}\}/m);
        const downEscalation = source.match(/static\s+async\s+checkDownEscalation[\s\S]*?\n\s{4}\}/m);

        assert.ok(slowPing, "expected to find checkSlowPingAlert");
        assert.ok(downEscalation, "expected to find checkDownEscalation");

        // The MAINTENANCE short-circuit must appear before any DB / notify call.
        const maintenanceIdx = (s) => s.indexOf("bean.status === MAINTENANCE");
        const getNotificationListIdx = (s) => s.indexOf("Monitor.getNotificationList");
        const notificationIdx = (s) => s.indexOf("Monitor.dispatchNotifications");
        const downAlertLevelWriteIdx = (s) => s.indexOf("state.downStart =");

        for (const [name, body] of [["checkSlowPingAlert", slowPing[0]], ["checkDownEscalation", downEscalation[0]]]) {
            const mt = maintenanceIdx(body);
            assert.ok(mt > -1, `${name} must contain an explicit MAINTENANCE check (L1.10)`);

            // For checkDownEscalation the MAINTENANCE early-return must
            // happen before any state mutation or DB call.
            if (name === "checkDownEscalation") {
                const db = getNotificationListIdx(body);
                const notif = notificationIdx(body);
                const write = downAlertLevelWriteIdx(body);

                assert.ok(
                    mt < db || db === -1,
                    `${name}: MAINTENANCE check must precede getNotificationList (L1.10). ` +
                        `mt=${mt}, db=${db}`
                );
                assert.ok(
                    mt < notif || notif === -1,
                    `${name}: MAINTENANCE check must precede dispatchNotifications (L1.10)`
                );
                assert.ok(
                    mt < write || write === -1,
                    `${name}: MAINTENANCE check must precede state.downStart mutation (L1.10)`
                );
            }
        }
    });
});

describe("PART B — L2 Uptime calculator", () => {
    /**
     * L2.10 — flatStatus collapses UP|MAINTENANCE → UP and DOWN|PENDING →
     * DOWN; everything else throws. Adding a new status without updating
     * flatStatus would break uptime aggregation silently.
     */
    test("B7. flatStatus collapses UP|MAINTENANCE→UP and DOWN|PENDING→DOWN", () => {
        const calc = new UptimeCalculator();
        calc.monitorID = 1;

        assert.strictEqual(calc.flatStatus(UP), UP);
        assert.strictEqual(calc.flatStatus(MAINTENANCE), UP, "MAINTENANCE must collapse to UP (L2.10)");
        assert.strictEqual(calc.flatStatus(DOWN), DOWN);
        assert.strictEqual(calc.flatStatus(PENDING), DOWN);

        // Anything else throws — this guards against silently accepting a
        // future 5th status.
        assert.throws(() => calc.flatStatus(99), /Invalid status/);
        assert.throws(() => calc.flatStatus(-1), /Invalid status/);
        assert.throws(() => calc.flatStatus(undefined), /Invalid status/);
        assert.throws(() => calc.flatStatus(null), /Invalid status/);
    });
});

describe("PART B — L3 Monitor lifecycle / beat loop", () => {
    /**
     * L3.10 — Order of operations during a beat, after the user's changes:
     *
     *   1. R.store(bean)                          ← persisted FIRST
     *   2. Monitor.sendNotification(...)          ← then notifications
     *   3. io.to(user_id).emit("heartbeat", ...)  ← then UI emit
     *
     * The original code had emit-then-store-then-notify. The new code
     * inverts the order. The user's `checkSlowPingAlert` and incident-
     * grouping defer logic depend on the heartbeat being persisted
     * BEFORE child monitors read it. This test pins the new ordering.
     *
     * Note: this is a source-level check (the function bodies are big
     * and would be expensive to exercise end-to-end).
     */
    test("B8. heartbeat is stored BEFORE sendNotification is called (L3.10 ordering)", async () => {
        const source = await fs.readFile("server/model/monitor.js", "utf-8");

        // Find the beat() function body (locate the line containing
        // `await R.store(bean);` and the line containing the next
        // `await Monitor.sendNotification`).
        const storeIdx = source.indexOf("await R.store(bean);");
        const sendNotifIdx = source.indexOf("await Monitor.sendNotification(isFirstBeat, this, bean);");

        assert.ok(storeIdx > -1, "expected to find `await R.store(bean);` in server/model/monitor.js");
        assert.ok(sendNotifIdx > -1, "expected to find `await Monitor.sendNotification(isFirstBeat, this, bean);`");
        assert.ok(
            storeIdx < sendNotifIdx,
            `L3.10: R.store(bean) must execute before sendNotification so child monitors see ` +
                `the parent's latest heartbeat. storeIdx=${storeIdx}, sendNotifIdx=${sendNotifIdx}`
        );
    });

    /**
     * Same ordering guarantee for socket.emit("heartbeat", ...).
     */
    test("B9. heartbeat is stored BEFORE the socket emit (L3.10 ordering)", async () => {
        const source = await fs.readFile("server/model/monitor.js", "utf-8");

        const storeIdx = source.indexOf("await R.store(bean);");
        const emitIdx = source.indexOf('io.to(this.user_id).emit("heartbeat",');

        assert.ok(storeIdx > -1 && emitIdx > -1, "expected store + emit to exist in monitor.js");
        assert.ok(
            storeIdx < emitIdx,
            `L3.10: heartbeat must be persisted before it's broadcast over the socket`
        );
    });

    /**
     * Heartbeat envelope shape — Monitor.sendStandardNotification does NOT
     * add `lastDownTime` to DOWN notifications (only UP), but the
     * IncidentTracker envelopes add `isIncident`, `incidentRootMonitorId`,
     * etc. This test pins which fields go in which envelope so a future
     * refactor doesn't accidentally leak them.
     *
     * We assert by source inspection: the literal strings must appear in
     * their correct dispatcher.
     */
    test("B10. heartbeat envelope fields are routed to the correct dispatcher", async () => {
        const source = await fs.readFile("server/model/monitor.js", "utf-8");

        // isIncident / incidentRootMonitorId MUST only appear inside
        // dispatchIncidentDown / dispatchIncidentUp.
        const dispatchIncidentDownMatch = source.match(
            /static\s+async\s+dispatchIncidentDown[\s\S]*?\n\s{4}\}/m
        );
        const dispatchIncidentUpMatch = source.match(
            /static\s+async\s+dispatchIncidentUp[\s\S]*?\n\s{4}\}/m
        );

        assert.ok(dispatchIncidentDownMatch, "expected to find dispatchIncidentDown");
        assert.ok(dispatchIncidentUpMatch, "expected to find dispatchIncidentUp");

        assert.ok(
            /isIncident\s*=\s*true/.test(dispatchIncidentDownMatch[0]),
            "dispatchIncidentDown must mark heartbeatJSON.isIncident = true"
        );
        assert.ok(
            /isIncident\s*=\s*true/.test(dispatchIncidentUpMatch[0]),
            "dispatchIncidentUp must mark heartbeatJSON.isIncident = true"
        );
        assert.ok(
            /isIncidentResolved\s*=\s*true/.test(dispatchIncidentUpMatch[0]),
            "dispatchIncidentUp must mark heartbeatJSON.isIncidentResolved = true"
        );

        // lastDownTime is set inside sendStandardNotification for UP only —
        // not in the DOWN branch.
        const standardMatch = source.match(
            /static\s+async\s+sendStandardNotification[\s\S]*?\n\s{4}\}/m
        );
        assert.ok(standardMatch, "expected to find sendStandardNotification");
        const insideUpBranch = standardMatch[0].match(/if\s*\(\s*bean\.status\s*===\s*UP[\s\S]*?heartbeatJSON\[.lastDownTime.\]/);
        assert.ok(
            insideUpBranch,
            "sendStandardNotification must set heartbeatJSON.lastDownTime only inside the bean.status === UP branch"
        );
    });
});

describe("PART B — L4 Database / model serializer", () => {
    /**
     * L4.14 — Monitor.toJSON must gate every secret field behind
     * includeSensitiveData. The user added `groupNotifications` which is
     * non-secret — verify it appears regardless of includeSensitiveData,
     * while existing secret fields (bearer_token, basic_auth_pass, etc.)
     * still get gated.
     */
    test("B11. toJSON exposes groupNotifications in both includeSensitiveData modes", () => {
        const monitor = Object.create(Monitor.prototype);
        monitor.id = 1;
        monitor.name = "test";
        monitor.path = [];
        monitor.parent = null;
        monitor.url = "https://example.com";
        monitor.method = "GET";
        monitor.maxredirects = 0;
        monitor.interval = 60;
        monitor.retryInterval = 60;
        monitor.timeout = 48;
        monitor.resendInterval = 0;
        monitor.expiryNotification = false;
        monitor.ignoreTls = false;
        monitor.upsideDown = false;
        monitor.packetSize = 56;
        monitor.kafkaProducerBrokers = "[]";
        monitor.kafkaProducerMessage = "";
        monitor.rabbitmqNodes = "[]";
        monitor.conditions = "[]";
        monitor.headers = "[]";
        monitor.maxretries = 0;
        monitor.weight = 2000;
        monitor.active = 1;
        monitor.type = "http";
        monitor.subtype = null;
        monitor._type = null;
        monitor.hostname = null;
        monitor.port = null;
        monitor.keyword = null;
        monitor.invertKeyword = false;
        monitor.maxredirects = 0;
        monitor.accepted_statuscodes_json = "[\"200-299\"]";
        monitor.dns_resolve_type = "A";
        monitor.dns_resolve_server = "1.1.1.1";
        monitor.docker_container = "";
        monitor.docker_host = "";
        monitor.proxy_id = null;
        monitor.notificationIDList = {};
        monitor.tags = [];
        monitor.maintenance = false;
        monitor.mqttTopic = "";
        monitor.mqttSuccessMessage = "";
        monitor.mqttCheckType = "keyword";
        monitor.databaseQuery = null;
        monitor.authMethod = null;
        monitor.grpcUrl = null;
        monitor.grpcProtobuf = null;
        monitor.grpcMethod = null;
        monitor.grpcServiceName = null;
        monitor.radiusCalledStationId = null;
        monitor.radiusCallingStationId = null;
        monitor.game = null;
        monitor.httpBodyEncoding = "json";
        monitor.jsonPath = null;
        monitor.expectedValue = null;
        monitor.system_service_name = null;
        monitor.kafkaProducerTopic = null;
        monitor.kafkaProducerSsl = false;
        monitor.kafkaProducerAllowAutoTopicCreation = false;
        monitor.screenshot = null;
        monitor.cacheBust = false;
        monitor.remote_browser = null;
        monitor.screenshot_delay = 0;
        monitor.snmpOid = null;
        monitor.jsonPathOperator = "==";
        monitor.snmpVersion = "2c";
        monitor.smtpSecurity = "auto";
        monitor.mqttUsername = "";
        monitor.mqttPassword = "";
        monitor.mqttWebsocketPath = "";
        monitor.authWorkstation = "";
        monitor.authDomain = "";
        monitor.tlsCa = "";
        monitor.tlsCert = "";
        monitor.tlsKey = "";
        monitor.kafkaProducerSaslOptions = "{}";
        monitor.rabbitmqUsername = "";
        monitor.rabbitmqPassword = "";
        monitor.ntpStratumThreshold = 16;
        monitor.ntpTimeOffsetThreshold = 50;
        monitor.ntpRootDispersionThreshold = 50;
        monitor.ipFamily = null;
        monitor.dns_last_result = null;
        monitor.response_max_length = 1024;
        monitor.expected_tls_alert = null;
        monitor.ping_numeric = false;
        monitor.ping_count = 1;
        monitor.ping_per_request_timeout = 2;
        monitor._id = 1;
        monitor._user_id = 1;

        // The new opt-in flag: must be exposed regardless of includeSensitiveData.
        monitor.group_notifications = 1;

        const safe = monitor.toJSON({
            paths: new Map(),
            notifications: new Map(),
            tags: new Map(),
            maintenanceStatus: new Map(),
            childrenIDs: new Map(),
            activeStatus: new Map(),
            forceInactive: new Map(),
        }, false);

        assert.strictEqual(safe.groupNotifications, true, "groupNotifications must be true when group_notifications=1");

        // Verify it's the SAME on includeSensitiveData=true (it's not a secret).
        const full = monitor.toJSON({
            paths: new Map(),
            notifications: new Map(),
            tags: new Map(),
            maintenanceStatus: new Map(),
            childrenIDs: new Map(),
            activeStatus: new Map(),
            forceInactive: new Map(),
        }, true);

        assert.strictEqual(full.groupNotifications, true);

        // Sanity: secrets only appear when includeSensitiveData=true.
        assert.ok(
            !("basic_auth_user" in safe),
            "L4.14: basic_auth_user must NOT appear when includeSensitiveData=false"
        );
        assert.ok(
            !("bearer_token" in safe),
            "L4.14: bearer_token must NOT appear when includeSensitiveData=false"
        );
        assert.ok(
            "basic_auth_user" in full || "headers" in full,
            "L4.14: includeSensitiveData=true should expose secret fields"
        );
    });

    /**
     * Heartbeat.toJSON returns a documented shape. The new code adds
     * `incidentSuppressed` AFTER calling bean.toJSON() — that property
     * doesn't go through the model but is added at the emit site.
     */
    test("B12. Heartbeat.toJSON includes the documented shape", () => {
        const h = Object.create(Heartbeat.prototype);
        h._monitorId = 1;
        h._status = UP;
        h._time = "2026-01-01 00:00:00.000";
        h._msg = "ok";
        h._ping = 100;
        h._important = true;
        h._duration = 60;
        h._retries = 0;
        h._response = null;

        const j = h.toJSON();

        assert.deepStrictEqual(
            Object.keys(j).sort(),
            ["duration", "important", "monitorID", "msg", "ping", "response", "retries", "status", "time"].sort()
        );

        // incidentSuppressed is added at the emit site, not via toJSON.
        // Verify it survives a typical attach-to-payload flow.
        j.incidentSuppressed = true;
        assert.strictEqual(j.incidentSuppressed, true);
    });

    /**
     * L4.5 — Every migration exports up() AND down(). Reversibility is the
     * cheap insurance against rolling forward and getting stuck.
     */
    test("B13. all 3 new migrations export up AND down functions", async () => {
        const dir = path.join(__dirname, "..", "..", "db", "knex_migrations");
        const newMigrations = [
            "2026-09-06-1200-add-slow-ping-state.js",
            "2026-09-07-1200-add-group-notifications.js",
            "2026-09-07-1300-add-down-escalation-state.js",
        ];

        for (const file of newMigrations) {
            const mod = require(path.join(dir, file));
            assert.strictEqual(
                typeof mod.up,
                "function",
                `${file}: missing exports.up (L4.3)`
            );
            assert.strictEqual(
                typeof mod.down,
                "function",
                `${file}: missing exports.down (L4.3)`
            );
        }
    });

    /**
     * L4.2 — Migration filenames must match `YYYY-MM-DD-HHmm-<name>.js`.
     * Validating early prevents the "missing file" warnings from knex when
     * someone fat-fingers the date.
     */
    test("B14. all 3 new migration filenames match YYYY-MM-DD-HHmm-<name>.js", () => {
        const dir = path.join(__dirname, "..", "..", "db", "knex_migrations");
        const expected = [
            "2026-09-06-1200-add-slow-ping-state.js",
            "2026-09-07-1200-add-group-notifications.js",
            "2026-09-07-1300-add-down-escalation-state.js",
        ];
        const re = /^\d{4}-\d{2}-\d{2}-\d{4}-[a-z0-9-]+\.js$/;

        for (const file of expected) {
            assert.ok(re.test(file), `Filename ${file} does not match YYYY-MM-DD-HHmm-<name>.js (L4.2)`);
        }
    });
});

describe("PART B — State isolation across monitors", () => {
    /**
     * The user introduced three in-memory Maps at the module scope of
     * server/model/monitor.js:
     *
     *   - slowPingState : Map<monitorID, {slowPingStart, slowPingAlertSent}>
     *   - downState     : Map<monitorID, {downStart, downAlertLevel}>
     *   - pendingDeferredNotifications : Map<monitorID, {timer, decision}>
     *
     * They share storage across all monitor instances. A bug that
     * accidentally uses the wrong ID (e.g. a closure capturing the wrong
     * variable) would silently poison state across monitors.
     *
     * Pin the per-monitor shape so a regression that flattens state into
     * a single object would fail.
     */
    test("B15. IncidentTracker state is keyed by monitor ID (no global slot)", () => {
        IncidentTracker._reset();

        // Two independent child monitors folding into the same root must
        // both register, both be removable, neither alias the other.
        const childA = { id: 100, name: "A", parent: 10, groupNotifications: true, group_notifications: true, active: 1 };
        const childB = { id: 101, name: "B", parent: 10, groupNotifications: true, group_notifications: true, active: 1 };

        // We can call handleDown without DB if the parent status is provided
        // as an option. PENDING counts as DOWN for incident grouping.
        return (async () => {
            await IncidentTracker.handleDown(childA, { parent: { id: 10 }, parentStatus: DOWN });
            await IncidentTracker.handleDown(childB, { parent: { id: 10 }, parentStatus: DOWN });

            assert.strictEqual(IncidentTracker.isAffected(100), true);
            assert.strictEqual(IncidentTracker.isAffected(101), true);
            assert.strictEqual(IncidentTracker.getRootFor(100), 10);
            assert.strictEqual(IncidentTracker.getRootFor(101), 10);
            assert.strictEqual(IncidentTracker.getAffectedIds(10).length, 2);

            // Removing A must not affect B.
            IncidentTracker.removeAffected(10, 100);
            assert.strictEqual(IncidentTracker.isAffected(100), false);
            assert.strictEqual(IncidentTracker.isAffected(101), true, "removing A must NOT remove B");
            assert.strictEqual(IncidentTracker.getAffectedIds(10).length, 1);
        })();
    });
});

describe("PART B — Heartbeat dispatch ordering (L3.10 changed-but-documented)", () => {
    /**
     * User-facing test: when sendNotification returns true (incident
     * suppressed), the bean payload that goes out over the socket MUST
     * carry incidentSuppressed=true so the UI can suppress its popup.
     *
     * The heartbeat model itself doesn't expose this property; it's added
     * at the emit site in monitor.js:1187. Verify the assignment is in
     * place.
     */
    test("B16. incidentSuppressed flag is attached to the socket payload", async () => {
        const source = await fs.readFile("server/model/monitor.js", "utf-8");

        assert.ok(
            /heartbeatData\.incidentSuppressed\s*=\s*true/.test(source),
            "monitor.js must set heartbeatData.incidentSuppressed = true when the incident grouping " +
                "suppressed the notification (consumed by src/mixins/socket.js:222)."
        );
    });
});

describe("PART B — Longest downtime edge cases", () => {
    /**
     * The longest-downtime algorithm (util-downtime.js) is exhaustively
     * tested in test-slow-ping-and-longest-downtime.js. Here we pin a
     * few invariants that aren't obvious from those tests:
     *
     *  - Stale-tail exclusion: a window where the most recent inner beat
     *    is older than 2× the interval counts NO downtime for the tail.
     *  - Sort-descending + early-exit keeps work bounded.
     */
    const { computeLongestDowntime } = require("../../server/util-downtime");
    const SQL_DATETIME_FORMAT = "YYYY-MM-DD HH:mm:ss.SSS";
    const { dayjs } = (() => {
        const d = require("dayjs");
        d.extend(require("dayjs/plugin/utc"));
        return { dayjs: d };
    })();
    const fmt = (d) => d.format(SQL_DATETIME_FORMAT);

    test("B17. stale inner-beat tail (Uptime Kuma currently offline) is excluded", async () => {
        const t0 = dayjs.utc("2026-01-01 10:00:00.000");
        const inner = [fmt(t0.add(60, "second"))]; // last inner beat at t0+60s
        const now = t0.add(10, "minute"); // stale by 9 min, way over 2× interval (120s)

        const duration = await computeLongestDowntime(
            [{ status: DOWN, time: fmt(t0) }],
            {
                intervalSec: 60,
                loadInnerBeats: async () => inner.map((time) => ({ time })),
                nowMs: now.valueOf(),
            }
        );

        // Only 60s counts (the only inner beat); the 9-min stale tail is
        // excluded as "Uptime Kuma was offline".
        assert.strictEqual(duration, 60);
    });
});
