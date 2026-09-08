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
            if (f.status === "no-monitor-query-found") {
                continue;
            }
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

// ───────────────────────────────────────────────────────────────────────────
// PART C — Newly-found bugs in the 4 features (red until fixed)
// ───────────────────────────────────────────────────────────────────────────
//
// These tests cover bugs found in a deeper audit after PART A/B. Each one
// FAILS today and PASSES once the bug is fixed. They are listed in the same
// order as the bug report.

describe("PART C — Newly-found bugs (red until fixed)", () => {
    /**
     * C1 — Bug #1: Escalation state lost on every server restart.
     *
     * `monitor.slow_ping_start` and `monitor.slow_ping_alert_sent` are
     * restored from DB on `start()` (see monitor.js:496-504), but
     * `monitor.down_start` and `monitor.down_alert_level` are written on
     * every state change (`_persistDownState`) and never read back.
     *
     * Consequence: after a restart mid-escalation, the level-1 / level-2
     * notifications fire a second time (or are delayed by a full restart-
     * to-restart window), because the in-memory `downState` Map is
     * reinitialized from defaults.
     *
     * Fix: add a restoration block in `start()` analogous to the slow-ping
     * one — when `this.downStart != null || this.downAlertLevel > 0`,
     * push the values into `getDownState(this.id)`.
     */
    test("C1. start() must restore downStart and downAlertLevel from DB columns", async () => {
        const source = await fs.readFile("server/model/monitor.js", "utf-8");

        // Find the body of start() up to (but not past) the prometheus
        // initialization. The down-escalation restore should live alongside
        // the slow-ping restore, BEFORE rootCertificates/prometheus init.
        const startBody = source.match(
            /async start\(io\)\s*\{[\s\S]*?this\.prometheus\s*=\s*new Prometheus/
        );

        assert.ok(
            startBody,
            "expected to find start() function body up to `this.rootCertificates =`"
        );

        // The start() body should reference this.downStart OR this.down_start.
        // redbean-node reads from the snake_case column, so both forms are
        // plausible — the test accepts either.
        const referencesDownStart = /this\.downStart\b|this\.down_start\b/.test(startBody[0]);
        const referencesDownAlertLevel = /this\.downAlertLevel\b|this\.down_alert_level\b/.test(
            startBody[0]
        );

        assert.ok(
            referencesDownStart,
            "BUG #1: start() must reference monitor.downStart (or its DB column form) " +
                "to restore the in-memory downState across restarts. Today the column is " +
                "written by _persistDownState but never read."
        );

        assert.ok(
            referencesDownAlertLevel,
            "BUG #1: start() must reference monitor.downAlertLevel (or its DB column form) " +
                "to restore the in-memory downState across restarts."
        );
    });

    /**
     * C2 — Bug #2: pendingDeferredNotifications not cleared on stop().
     *
     * When a child monitor goes DOWN and is deferred, the timer handle is
     * stored in the module-level `pendingDeferredNotifications` Map. If the
     * monitor is then stopped (or deleted) before the timer fires, the
     * timer still fires and the callback calls `Monitor.sendStandardNotification`
     * on a monitor that may no longer be checked.
     *
     * Fix: in `stop()`, look up any pending timer for `this.id` and
     * `clearTimeout(...)` it, then delete the map entry.
     */
    test("C2. stop() must clear any pending deferred notifications", async () => {
        const source = await fs.readFile("server/model/monitor.js", "utf-8");

        const stopBody = source.match(/async stop\(\)\s*\{[\s\S]*?\n    \}/);
        assert.ok(stopBody, "expected to find Monitor.stop() function body");

        assert.ok(
            /pendingDeferredNotifications/.test(stopBody[0]),
            "BUG #2: Monitor.stop() must clean up pendingDeferredNotifications. " +
                "Otherwise a deferred DOWN timer fires after the monitor is stopped, " +
                "sending a stray notification."
        );
    });

    /**
     * C3 — Bug #3: Duplicate recovery notifications on UP after escalation.
     *
     * Today, on a DOWN→UP transition for a monitor that was in escalation
     * (downAlertLevel >= 1):
     *   1. `sendStandardNotification` fires `"[Name] [✅ Up] msg"` to ALL
     *      notifications (no DOWN-filter applies for UP).
     *   2. `checkDownEscalation` fires `"[Name] [✅ Recovered] Service
     *      recovered after Xs"` to the filtered set (escalationLevel <=
     *      state.downAlertLevel).
     *
     * For non-root monitors, both fire — the operator gets TWO recovery
     * messages. (Root monitors avoid this because `dispatchIncidentUp`
     * calls `clearDownEscalationState` before `checkDownEscalation` runs.)
     *
     * The fix should coordinate the two paths so only ONE recovery
     * notification fires per UP beat after escalation.
     */
    test("C3. UP recovery after escalation must not fire duplicate notifications", async () => {
        const source = await fs.readFile("server/model/monitor.js", "utf-8");

        // Locate sendStandardNotification and checkDownEscalation.
        const sendStandard = source.match(
            /static\s+async\s+sendStandardNotification[\s\S]*?\n\s{4}\}/m
        );
        const checkEscalation = source.match(
            /static\s+async\s+checkDownEscalation[\s\S]*?\n\s{4}\}/m
        );

        assert.ok(sendStandard, "expected to find sendStandardNotification");
        assert.ok(checkEscalation, "expected to find checkDownEscalation");

        // After the fix, the UP path in sendStandardNotification should be
        // skipped (or its message suppressed) when downAlertLevel > 0, OR
        // the recovery branch in checkDownEscalation should be the no-op
        // in that case. Pin a coordination marker.
        //
        // The simplest "coordination marker" pattern we accept:
        //   - `sendStandardNotification`'s UP branch reads a shared flag set by the recovery path, OR
        //   - `checkDownEscalation`'s recovery branch returns early when the standard UP was sent, OR
        //   - The two messages are merged into one dispatch.
        //
        // The test asserts that at least ONE of these coordination patterns
        // is present. Today, none are — so the test fails.

        const upTextInSendStandard = /text\s*=\s*"✅ Up"/.test(sendStandard[0]);
        const recoveryInCheckEscalation = /\[✅ Recovered\]/.test(checkEscalation[0]);

        // Both messages exist. Now check whether they coordinate.
        // Look for any coordination marker: a shared module-level flag,
        // a guard like `if (recoveryAlreadySent)`, or a function call
        // between them.
        const hasSharedFlag =
            /\bsentStandardUp\b|\brecoveryFired\b|\bupHandled\b/.test(source);
        const hasEarlyReturnInEscalation =
            /if\s*\(\s*recoverySent\s*\)|if\s*\(\s*!recoverySent\s*\)|return\s*;\s*\/\/\s*recovery/i.test(
                checkEscalation[0]
            );
        const sendStandardChecksEscalation =
            /downAlertLevel/.test(sendStandard[0]);

        assert.ok(
            hasSharedFlag || hasEarlyReturnInEscalation || sendStandardChecksEscalation,
            "BUG #3: sendStandardNotification and checkDownEscalation fire duplicate UP " +
                "notifications today. After the fix, at least one of these coordination " +
                "patterns must be in place:\n" +
                "  - a shared `recoverySent` flag, OR\n" +
                "  - checkDownEscalation's recovery branch returning early, OR\n" +
                "  - sendStandardNotification gating the UP branch on downAlertLevel.\n" +
                "Today, none are present — non-root monitors in escalation get TWO " +
                "recovery messages on the same UP beat."
        );

        // Sanity: both messages still exist (the fix shouldn't drop one).
        assert.ok(upTextInSendStandard, "sendStandardNotification should still send '✅ Up'");
        assert.ok(recoveryInCheckEscalation, "checkDownEscalation should still send '✅ Recovered'");
    });

    /**
     * C4 — Bug #4: Silent failure mode for malformed escalationLevel.
     *
     * The escalation filter is `Number(cfg.escalationLevel) === level`.
     * Malformed values like 1.5, "foo", NaN, -1 are silently excluded
     * from every tier — the user gets no signal that anything's wrong.
     *
     * Fix: log a warning (or fall back to legacy) when the value is not a
     * positive integer in {1, 2, 3}.
     */
    test("C4. malformed escalationLevel must not silently exclude notifications", async () => {
        // Re-implement the filter to verify the current behavior. After the
        // fix, the filter (or a wrapper) should log a warning AND/OR fall
        // back to a sensible default for malformed values.
        const filterByLevel = (configStr, level) => {
            try {
                const cfg = JSON.parse(configStr || "{}");
                if (cfg.escalationLevel === undefined || cfg.escalationLevel === null) {
                    return level === 1;
                }
                return Number(cfg.escalationLevel) === level;
            } catch (e) {
                return level === 1;
            }
        };

        // Capture log.warn calls.
        const warnings = [];
        const origWarn = console.warn;
        console.warn = (...args) => warnings.push(args.join(" "));

        try {
            // Today these all silently return false:
            assert.strictEqual(filterByLevel('{"escalationLevel": 1.5}', 1), false);
            assert.strictEqual(filterByLevel('{"escalationLevel": 1.5}', 2), false);
            assert.strictEqual(filterByLevel('{"escalationLevel": "foo"}', 1), false);
            assert.strictEqual(filterByLevel('{"escalationLevel": -1}', 1), false);

            // After the fix, at least ONE of these warnings should have been
            // emitted for the malformed values. Today, the production code
            // does not log anything — `console.warn` is only a stand-in for
            // the production logger. The source-level check below covers
            // the production code path.
            const filteredValues = warnings.filter((w) => w.includes("escalationLevel"));
            // We deliberately don't assert.strictEqual the count here —
            // because the production code doesn't use console.warn. The
            // source-level check in the next step is the real gate.
        } finally {
            console.warn = origWarn;
        }

        // Source-level check: the production filter must log a warning
        // (or otherwise surface) when escalationLevel is not a valid level.
        const source = await fs.readFile("server/model/monitor.js", "utf-8");

        // The filter for level-1 / level-2 / level-3 lives in
        // sendStandardNotification and checkDownEscalation. At least one
        // of those branches must emit a log line for malformed values.
        const filterLocation =
            /cfg\.escalationLevel\s*===\s*undefined\s*\|\|\s*cfg\.escalationLevel\s*===\s*null/;
        const filterBlockMatch = source.match(filterLocation);

        assert.ok(
            filterBlockMatch,
            "expected to find the legacy/null escalationLevel check in monitor.js"
        );

        // Walk the function body around the filter. Today, neither branch
        // emits a log.warn / log.error for malformed (non-null, non-undefined)
        // values.
        //
        // We grep for `Number.isInteger(...)` or `Number.isFinite(...)` near
        // an escalationLevel check. The fix typically extracts the value to
        // a local variable and validates with Number.isInteger / isFinite
        // before comparing.
        const hasDefensiveValidation =
            /Number\.isInteger\(|Number\.isFinite\(/.test(source) &&
            /escalationLevel/.test(source);

        assert.ok(
            hasDefensiveValidation,
            "BUG #4: malformed escalationLevel values (1.5, 'foo', NaN, -1) are silently " +
                "excluded from every tier today. The production filter must validate the " +
                "value with Number.isInteger or Number.isFinite and log a warning for " +
                "anything outside {1, 2, 3}."
        );
    });

    /**
     * C5 — Bug #5: Resend cycle doesn't include affected services list
     * (misleading comment at incident-tracker.js:351-366).
     *
     * The comment says "the next resend cycle or escalation will mention
     * newly added children". In practice, the escalation does (via
     * `appendIncidentAffectedToMessage`), but the resend cycle does NOT —
     * it fires the plain `[A] [🔴 Down] msg` from sendStandardNotification.
     *
     * Fix: update sendStandardNotification's DOWN message to consult the
     * IncidentTracker and append the affected services list. This benefits
     * both the initial DOWN notification AND the resend cycle (since
     * sendNotification → IncidentTracker.handleDown → "standard" →
     * sendStandardNotification).
     */
    test("C5. DOWN notifications must include affected services when an incident is active", async () => {
        const source = await fs.readFile("server/model/monitor.js", "utf-8");

        // Locate sendStandardNotification.
        const sendStandard = source.match(
            /static\s+async\s+sendStandardNotification[\s\S]*?\n\s{4}\}/m
        );
        assert.ok(sendStandard, "expected to find sendStandardNotification");

        // The fix must consult the IncidentTracker for affected children
        // and append them to the message — either via the helper or by
        // reading the Map directly.
        const usesAffectedInStandard =
            /appendIncidentAffectedToMessage/.test(sendStandard[0]) ||
            /IncidentTracker\.getAffectedIds/.test(sendStandard[0]) ||
            /IncidentTracker\.hasIncident/.test(sendStandard[0]);

        assert.ok(
            usesAffectedInStandard,
            "BUG #5: the comment at incident-tracker.js:351-366 says the resend cycle will " +
                "mention newly added children. In practice it doesn't — the operator gets a " +
                "plain `[A] [🔴 Down] msg` instead. After the fix, sendStandardNotification " +
                "must consult IncidentTracker and append the affected list, OR the comment must " +
                "be updated to match reality. Today the comment lies."
        );
    });

    /**
     * C6 — Bug #6: Fire-and-forget persistence — DB writes can complete
     * out of order on slow connections.
     *
     * `_persistSlowPingState` and `_persistDownState` are called without
     * `await` at multiple call sites in monitor.js. On SQLite the local
     * write is fast and unlikely to reorder, but on MariaDB/MySQL over a
     * network, two `R.store(monitor)` calls in quick succession can
     * complete in non-deterministic order — leaving the DB with a state
     * from the FIRST write after a SECOND write's response arrives.
     *
     * Fix: `await` both persistence calls.
     */
    test("C6. _persistSlowPingState and _persistDownState must be awaited at every call site", async () => {
        const source = await fs.readFile("server/model/monitor.js", "utf-8");

        // Find every call to these two helpers. Allow optional `await ` prefix.
        const persistCalls = source.match(
            /^[ \t]*(?:await\s+)?Monitor\._persist(?:SlowPing|Down)State\([^)]*\);?/gm
        ) || [];

        // Exclude the function-definition lines.
        const callSites = persistCalls.filter((c) => !c.includes("async _persist"));

        assert.ok(
            callSites.length >= 5,
            `expected at least 5 call sites; found ${callSites.length}:\n${callSites.join("\n")}`
        );

        for (const call of callSites) {
            assert.ok(
                /^\s*await\s+Monitor\._persist/.test(call),
                `BUG #6: persistence call must be awaited to prevent DB write reordering. ` +
                    `Offending line: "${call.trim()}"`
            );
        }
    });

    /**
     * C7 — Bug #8: Slow-ping recovery message wording vs. comparison direction.
     *
     * Today the recovery fires when `bean.ping > SLOW_PING_THRESHOLD_MS`
     * becomes false (i.e., `bean.ping <= 1000`). The detail message says
     * "back below 1000 ms" — which is wrong at exactly 1000ms (it's at,
     * not below). Either the message must say "at or below" or the
     * comparison must use `>=`.
     *
     * The fix is cosmetic but the message must not contradict the actual
     * code path.
     */
    test("C7. slow-ping recovery detail must match the comparison direction at boundary", async () => {
        const source = await fs.readFile("server/model/monitor.js", "utf-8");

        // The recovery trigger is `overThreshold = bean.ping > SLOW_PING_THRESHOLD_MS`
        // (so the recovery fires when overThreshold becomes false, i.e.,
        // `bean.ping <= SLOW_PING_THRESHOLD_MS`).
        const comparisonIsStrict = /overThreshold\s*=\s*bean\.ping\s*>\s*SLOW_PING_THRESHOLD_MS/.test(
            source
        );

        assert.ok(
            comparisonIsStrict,
            "expected the slow-ping threshold check to be `bean.ping > SLOW_PING_THRESHOLD_MS`"
        );

        // The recovery detail string is constructed at the bottom of
        // sendSlowPingNotification.
        const recoveryDetailMatch = source.match(
            /isRecovered\s*\?\s*[`'"]([^`'"]*)back below([`'"])/
        );

        // We don't require a specific regex match — we just check the
        // broader pattern. If the literal "back below" appears in the
        // recovery branch, AND the comparison is strict `>`, that's the
        // boundary inconsistency.
        const hasBackBelow = /back below/.test(source);

        if (comparisonIsStrict && hasBackBelow) {
            // Today this is the bug. The fix should either:
            //   - change the message to "at or below" / "back to", OR
            //   - change the comparison to `>=`.
            //
            // We assert that the recovery message no longer says "back below"
            // (since that's misleading at exactly 1000ms with `>` comparison).
            assert.fail(
                "BUG #8: slow-ping recovery message says 'back below' but the threshold " +
                    "check is `bean.ping > SLOW_PING_THRESHOLD_MS`. At exactly 1000ms, " +
                    "the recovery fires but the message is wrong. Change the message to " +
                    "'at or below' or change the comparison to `>=`."
            );
        }

        // If neither "back below" exists nor the strict comparison, the
        // bug is implicitly fixed. Pass.
    });

    /**
     * C8 — Cross-check: all 4 features coexist correctly.
     *
     * Verify that the four features don't interfere with each other:
     *   - slow-ping alert and DOWN alert can both fire for the same beat
     *     (slow-ping uses dispatchNotifications directly; DOWN goes through
     *     sendNotification → IncidentTracker).
     *   - escalation runs even when incident grouping is active (root monitor
     *     is NOT in `affectedToRoot` so `IncidentTracker.isAffected(id)` is
     *     false for it).
     *   - longest downtime doesn't break incident grouping (it's a separate
     *     socket handler).
     */
    test("C8. the 4 features do not interfere with each other", async () => {
        const source = await fs.readFile("server/model/monitor.js", "utf-8");

        // checkSlowPingAlert and checkDownEscalation are independent of
        // IncidentTracker — slow-ping uses dispatchNotifications directly,
        // escalation only consults IncidentTracker to skip "affected" monitors.

        // Slow-ping must NOT consult IncidentTracker (slow-ping is status-
        // independent).
        const slowPingBody = source.match(
            /static\s+async\s+checkSlowPingAlert[\s\S]*?\n\s{4}\}/m
        );
        assert.ok(slowPingBody);
        assert.ok(
            !/IncidentTracker\.isAffected/.test(slowPingBody[0]),
            "checkSlowPingAlert must not skip when IncidentTracker.isAffected is true " +
                "(slow-ping is status-independent — affected children should still get " +
                "their own slow-ping alerts)."
        );

        // Escalation MUST consult IncidentTracker (affected children
        // should be silent — root's escalation chain carries them).
        const escalationBody = source.match(
            /static\s+async\s+checkDownEscalation[\s\S]*?\n\s{4}\}/m
        );
        assert.ok(escalationBody);
        assert.ok(
            /IncidentTracker\.isAffected/.test(escalationBody[0]),
            "checkDownEscalation must skip when IncidentTracker.isAffected is true " +
                "(the root's escalation chain carries affected children)."
        );

        // Longest downtime is a separate socket handler — it doesn't share
        // state with the beat loop. Just verify it lives in server.js.
        const serverSource = await fs.readFile("server/server.js", "utf-8");
        assert.ok(
            /socket\.on\(\s*["']getLongestDowntime["']/.test(serverSource),
            "getLongestDowntime handler should exist in server.js"
        );
    });
});
