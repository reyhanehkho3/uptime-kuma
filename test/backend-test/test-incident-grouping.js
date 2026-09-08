const { describe, test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");

// Import after stubbing redbean-node so requiring incident-tracker.js
// does not open a real database.
const R = { getRow: async () => null, getAll: async () => [] };
require.cache[require.resolve("redbean-node")] = {
    exports: { R, isoDateTime: () => "", isoDateTimeMillis: () => "" },
};
const IncidentTracker = require("../../server/incident-tracker");
const { UP, DOWN, PENDING, MAINTENANCE } = require("../../src/util");

/**
 * @param overrides
 */
function makeMonitor(overrides = {}) {
    return {
        id: 100,
        name: "API",
        parent: null,
        active: 1,
        groupNotifications: true,
        group_notifications: true,
        ...overrides,
    };
}

describe("IncidentTracker state machine", () => {
    beforeEach(() => {
        IncidentTracker._reset();
    });

    test("flag disabled → standard flow", async () => {
        const m = makeMonitor({ groupNotifications: false, group_notifications: false });
        const decision = await IncidentTracker.handleDown(m, { parent: { id: 10, name: "DB" }, parentStatus: DOWN });
        assert.strictEqual(decision.send, "standard");
    });

    test("flag enabled, no parent → standard flow", async () => {
        const m = makeMonitor({ parent: null });
        const decision = await IncidentTracker.handleDown(m);
        assert.strictEqual(decision.send, "standard");
    });

    test("flag enabled, parent UP → deferred (caller will re-check after deferMs)", async () => {
        const m = makeMonitor({ parent: 10 });
        // Pre-load a parent row with interval and a "fresh" last beat via
        // options so the test doesn't need a real DB. The defer window
        // should be capped at the parent's interval.
        const decision = await IncidentTracker.handleDown(m, {
            parent: { id: 10, name: "DB", interval: 60 },
            parentStatus: UP,
        });
        assert.strictEqual(decision.send, "deferred");
        assert.strictEqual(decision.rootMonitor.id, 10);
        assert.ok(decision.deferMs >= 1000, `expected deferMs >= 1000, got ${decision.deferMs}`);
        assert.ok(decision.deferMs <= 60_000, `expected deferMs <= 60_000, got ${decision.deferMs}`);
        // No incident should have been created yet — defer is a wait, not a fold-in.
        assert.strictEqual(IncidentTracker._incidents.size, 0);
    });

    test("first affected DOWN → child folds in silently (suppress); parent will fire on its next beat", async () => {
        const m = makeMonitor({ id: 100, name: "API", parent: 10 });
        const decision = await IncidentTracker.handleDown(m, {
            parent: { id: 10, name: "DB" },
            parentStatus: DOWN,
        });
        // The child does NOT fire the consolidated notification — the
        // root-cause monitor is responsible. This avoids the operator
        // seeing "triggered by API" in logs/audit when the real cause is
        // the parent.
        assert.strictEqual(decision.send, "suppress");
        assert.strictEqual(decision.rootMonitor.id, 10);

        // The child IS folded into the incident; the parent's next
        // DOWN→DOWN beat will dispatch the consolidated notification.
        assert.strictEqual(IncidentTracker.isAffected(100), true);
        assert.strictEqual(IncidentTracker.getRootFor(100), 10);
        assert.strictEqual(IncidentTracker.hasIncident(10), true);
        assert.strictEqual(IncidentTracker.hasPendingIncidentForRoot(10), true);
    });

    test("second affected DOWN → suppress (still silent; parent will fold both into one consolidated notification)", async () => {
        const m1 = makeMonitor({ id: 100, name: "API", parent: 10 });
        const m2 = makeMonitor({ id: 101, name: "Website", parent: 10 });

        // Both children fold in silently. Neither dispatches the
        // consolidated notification — the parent will, on its next beat.
        const d1 = await IncidentTracker.handleDown(m1, {
            parent: { id: 10, name: "DB" },
            parentStatus: DOWN,
        });
        assert.strictEqual(d1.send, "suppress");

        const d2 = await IncidentTracker.handleDown(m2, {
            parent: { id: 10, name: "DB" },
            parentStatus: DOWN,
        });
        assert.strictEqual(d2.send, "suppress");
        assert.strictEqual(d2.rootMonitor.id, 10);

        // Both affected monitors tracked; parent's next beat has
        // pending-incident state so it will dispatch.
        assert.strictEqual(IncidentTracker.isAffected(100), true);
        assert.strictEqual(IncidentTracker.isAffected(101), true);
        assert.strictEqual(IncidentTracker.getRootFor(100), 10);
        assert.strictEqual(IncidentTracker.getRootFor(101), 10);
        assert.strictEqual(IncidentTracker.getAffectedIds(10).length, 2);
        assert.strictEqual(IncidentTracker.hasPendingIncidentForRoot(10), true);
    });

    test("PENDING parent is treated as DOWN", async () => {
        const m = makeMonitor({ id: 100, parent: 10 });
        const decision = await IncidentTracker.handleDown(m, {
            parent: { id: 10, name: "DB" },
            parentStatus: PENDING,
        });
        // Child folds in silently; parent will fire consolidated on next beat.
        assert.strictEqual(decision.send, "suppress");
        assert.strictEqual(IncidentTracker.hasPendingIncidentForRoot(10), true);
    });

    test("root recovers with active incident → incident-resolved listing still-affected", async () => {
        const m1 = makeMonitor({ id: 100, name: "API", parent: 10 });
        const m2 = makeMonitor({ id: 101, name: "Website", parent: 10 });
        await IncidentTracker.handleDown(m1, {
            parent: { id: 10, name: "DB" },
            parentStatus: DOWN,
        });
        await IncidentTracker.handleDown(m2, {
            parent: { id: 10, name: "DB" },
            parentStatus: DOWN,
        });

        const rootMonitor = makeMonitor({ id: 10, name: "DB" });
        // Both children still DOWN at recovery time (typical scenario).
        const statusByMonitorId = new Map([
            [100, DOWN],
            [101, DOWN],
        ]);
        const decision = await IncidentTracker.handleUp(rootMonitor, { statusByMonitorId });

        assert.strictEqual(decision.send, "incident-resolved");
        assert.strictEqual(decision.rootMonitor.id, 10);
        assert.deepStrictEqual(decision.stillAffectedIds.sort(), [100, 101]);

        // Incident cleared
        assert.strictEqual(IncidentTracker.hasIncident(10), false);
        assert.strictEqual(IncidentTracker._affectedToRoot.has(100), false);
        assert.strictEqual(IncidentTracker._affectedToRoot.has(101), false);
    });

    test("root recovers but a previously-folded child is already UP → not listed as still-affected", async () => {
        // Parent went DOWN first and proactively folded in the child
        // (new blast-radius behavior). By the time parent recovers, the
        // child never actually failed, so the consolidated UP should
        // report "no still-affected services".
        const api = makeMonitor({ id: 100, name: "API", parent: 10 });
        await IncidentTracker.handleDown(api, {
            parent: { id: 10, name: "DB" },
            parentStatus: DOWN,
        });
        // API was folded in. Now simulate API recovering before parent.
        IncidentTracker.handleUp(api);

        const rootMonitor = makeMonitor({ id: 10, name: "DB" });
        const statusByMonitorId = new Map([
            [100, UP], // API is back up
        ]);
        const decision = await IncidentTracker.handleUp(rootMonitor, { statusByMonitorId });
        assert.strictEqual(decision.send, "incident-resolved");
        assert.deepStrictEqual(decision.stillAffectedIds, []);
    });

    test("affected UP before root → suppress; incident remains", async () => {
        const m1 = makeMonitor({ id: 100, name: "API", parent: 10 });
        await IncidentTracker.handleDown(m1, {
            parent: { id: 10, name: "DB" },
            parentStatus: DOWN,
        });

        const decision = await IncidentTracker.handleUp(m1);
        assert.strictEqual(decision.send, "suppress");

        // Incident still active for root
        assert.strictEqual(IncidentTracker.hasIncident(10), true);
        assert.strictEqual(IncidentTracker.getAffectedIds(10).length, 0);
    });

    test("monitor with no incident going UP → standard", async () => {
        const m = makeMonitor({ id: 100, name: "API" });
        const decision = await IncidentTracker.handleUp(m);
        assert.strictEqual(decision.send, "standard");
    });

    test("idempotency: re-running handleDown for already-tracked monitor does not duplicate", async () => {
        const m = makeMonitor({ id: 100, name: "API", parent: 10 });

        await IncidentTracker.handleDown(m, {
            parent: { id: 10, name: "DB" },
            parentStatus: DOWN,
        });

        const sizeBefore = IncidentTracker.getAffectedIds(10).length;
        await IncidentTracker.handleDown(m, {
            parent: { id: 10, name: "DB" },
            parentStatus: DOWN,
        });
        const sizeAfter = IncidentTracker.getAffectedIds(10).length;
        assert.strictEqual(sizeBefore, sizeAfter);
        assert.strictEqual(sizeAfter, 1);
    });

    test("escalation guard: isAffected() returns true after fold-in, false after root recovers", async () => {
        const m = makeMonitor({ id: 100, name: "API", parent: 10 });
        await IncidentTracker.handleDown(m, {
            parent: { id: 10, name: "DB" },
            parentStatus: DOWN,
        });
        assert.strictEqual(IncidentTracker.isAffected(100), true);

        const rootMonitor = makeMonitor({ id: 10, name: "DB" });
        await IncidentTracker.handleUp(rootMonitor);
        assert.strictEqual(IncidentTracker.isAffected(100), false);
    });

    test("clear() removes incident and all affected back-references", () => {
        IncidentTracker.addAffected(10, 100);
        IncidentTracker.addAffected(10, 101);
        IncidentTracker.markRootNotified(10);

        IncidentTracker.clear(10);

        assert.strictEqual(IncidentTracker._incidents.has(10), false);
        assert.strictEqual(IncidentTracker._affectedToRoot.has(100), false);
        assert.strictEqual(IncidentTracker._affectedToRoot.has(101), false);
    });

    test("markEscalated + getEscalatedLevels round-trip", () => {
        IncidentTracker.markEscalated(10, 2);
        IncidentTracker.markEscalated(10, 3);
        const levels = IncidentTracker.getEscalatedLevels(10);
        assert.ok(levels.has(2));
        assert.ok(levels.has(3));
        assert.strictEqual(levels.size, 2);
    });

    test("hasPendingIncidentForRoot transitions correctly across the incident lifecycle", async () => {
        // No incident yet
        assert.strictEqual(IncidentTracker.hasPendingIncidentForRoot(10), false);

        // Child folds in silently → incident exists but parent hasn't fired
        const api = makeMonitor({ id: 100, name: "API", parent: 10 });
        await IncidentTracker.handleDown(api, {
            parent: { id: 10, name: "DB" },
            parentStatus: DOWN,
        });
        assert.strictEqual(IncidentTracker.hasPendingIncidentForRoot(10), true);

        // Parent fires on its next beat
        IncidentTracker.markRootNotified(10);
        assert.strictEqual(IncidentTracker.hasPendingIncidentForRoot(10), false);

        // Root recovers → incident cleared
        const root = makeMonitor({ id: 10, name: "DB" });
        await IncidentTracker.handleUp(root);
        assert.strictEqual(IncidentTracker.hasPendingIncidentForRoot(10), false);
    });

    test("parent DOWN→DOWN beat after silent child fold-in → incident-root (parent fires)", async () => {
        // Simulate: child folded in silently. Parent's next beat fires the
        // consolidated notification on its own — rootNotified flips false→true.
        const api = makeMonitor({ id: 100, name: "API", parent: 10 });
        await IncidentTracker.handleDown(api, {
            parent: { id: 10, name: "PostgreSQL" },
            parentStatus: DOWN,
        });
        assert.strictEqual(IncidentTracker.hasPendingIncidentForRoot(10), true);

        // Now the parent's DOWN→DOWN beat runs.
        const postgres = makeMonitor({ id: 10, name: "PostgreSQL", parent: null });
        const decision = await IncidentTracker.handleDown(postgres, {
            downFlaggedChildren: [{ id: 100, name: "API" }],
        });
        assert.strictEqual(decision.send, "incident-root");
        assert.strictEqual(decision.rootMonitor.id, 10);
        assert.deepStrictEqual(decision.affectedIds, [10, 100]);

        // After firing, no longer pending — subsequent beats won't re-fire.
        assert.strictEqual(IncidentTracker.hasPendingIncidentForRoot(10), false);
    });

    test("parent had no flagged children at UP→DOWN → child folds in later → parent fires on next beat", async () => {
        // Edge case: parent went DOWN before any child was opted-in (or before
        // the child existed). Parent's UP→DOWN beat returned "standard" and
        // never created an incident. Then the child beats DOWN and folds in
        // silently. Parent's next DOWN→DOWN beat must create the incident
        // and dispatch the consolidated notification.
        const postgres = makeMonitor({ id: 10, name: "PostgreSQL", parent: null });

        // (No prior addAffected / markRootNotified — incident does not exist.)
        assert.strictEqual(IncidentTracker.hasIncident(10), false);

        const api = makeMonitor({ id: 100, name: "API", parent: 10 });
        await IncidentTracker.handleDown(api, {
            parent: { id: 10, name: "PostgreSQL" },
            parentStatus: DOWN,
        });
        // Child silently creates the incident so the parent can pick it up.
        assert.strictEqual(IncidentTracker.hasPendingIncidentForRoot(10), true);

        const decision = await IncidentTracker.handleDown(postgres, {
            downFlaggedChildren: [{ id: 100, name: "API" }],
        });
        assert.strictEqual(decision.send, "incident-root");
        assert.strictEqual(decision.rootMonitor.id, 10);
        assert.deepStrictEqual(decision.affectedIds, [10, 100]);
    });

    test("defer → re-call flow: parent UP at first call, DOWN at re-call → suppress", async () => {
        // Simulates the race: child beats DOWN while parent is still UP.
        // Caller defers. Parent then beats DOWN (e.g., it caught up a
        // moment later). Re-calling handleDown must fold the child in
        // silently rather than fire the child's standalone.
        const api = makeMonitor({ id: 100, name: "API", parent: 10 });

        // First call: parent UP → deferred.
        const d1 = await IncidentTracker.handleDown(api, {
            parent: { id: 10, name: "DB", interval: 60 },
            parentStatus: UP,
        });
        assert.strictEqual(d1.send, "deferred");
        assert.strictEqual(IncidentTracker._incidents.size, 0);

        // Second call (after defer expires): parent now DOWN → suppress.
        const d2 = await IncidentTracker.handleDown(api, {
            parent: { id: 10, name: "DB", interval: 60 },
            parentStatus: DOWN,
        });
        assert.strictEqual(d2.send, "suppress");
        assert.strictEqual(IncidentTracker.isAffected(100), true);
        assert.strictEqual(IncidentTracker.hasPendingIncidentForRoot(10), true);
    });

    test("top-level monitor with flagged DOWN children → incident-root on its own DOWN", async () => {
        // Simulate: API is DOWN and was DOWN before PostgreSQL went DOWN.
        // API is tracked as "potential affected" — we'll pre-stage the
        // incident via addAffected before PostgreSQL's handleDown runs.
        const apiMonitor = makeMonitor({ id: 100, name: "API", parent: 10, group_notifications: true });
        IncidentTracker.addAffected(10, 100);
        // (Incident is created; rootNotified is still false so PostgreSQL
        // will be allowed to send the consolidated notification.)

        const postgresMonitor = makeMonitor({ id: 10, name: "PostgreSQL", parent: null });
        // Inject the pre-loaded flagged-down-children list so we don't need a DB.
        const decision = await IncidentTracker.handleDown(postgresMonitor, {
            downFlaggedChildren: [{ id: 100, name: "API" }],
        });
        assert.strictEqual(decision.send, "incident-root");
        assert.strictEqual(decision.rootMonitor.id, 10);
        assert.deepStrictEqual(decision.affectedIds, [10, 100]);
        // Marked so subsequent children's handleDown will suppress.
        assert.strictEqual(IncidentTracker._incidents.get(10).rootNotified, true);
    });

    test("top-level monitor with NO flagged DOWN children → standard", async () => {
        const postgresMonitor = makeMonitor({ id: 10, name: "PostgreSQL", parent: null });
        const decision = await IncidentTracker.handleDown(postgresMonitor, {
            downFlaggedChildren: [],
        });
        assert.strictEqual(decision.send, "standard");
        assert.strictEqual(IncidentTracker._incidents.size, 0);
    });

    test("top-level monitor with incident already notified → standard (no double-fire)", async () => {
        // Simulate: the parent already fired the consolidated notification
        // (rootNotified = true). A subsequent parent beat must not re-fire.
        IncidentTracker.addAffected(10, 100);
        IncidentTracker.markRootNotified(10);
        assert.strictEqual(IncidentTracker.hasPendingIncidentForRoot(10), false);

        // PostgreSQL's subsequent beat fires with the same child in DOWN state.
        // It should NOT re-fire the consolidated notification.
        const postgresMonitor = makeMonitor({ id: 10, name: "PostgreSQL", parent: null });
        const decision = await IncidentTracker.handleDown(postgresMonitor, {
            downFlaggedChildren: [{ id: 100, name: "API" }],
        });
        assert.strictEqual(decision.send, "standard");
    });
});

describe("computeDeferWindowMs", () => {
    let originalGetRow;
    beforeEach(() => {
        originalGetRow = R.getRow;
    });

    afterEach(() => {
        R.getRow = originalGetRow;
    });

    test("no heartbeat yet → returns full interval", async () => {
        // Default stub returns null → no heartbeat.
        const deferMs = await IncidentTracker.computeDeferWindowMs(10, 60);
        assert.strictEqual(deferMs, 60_000);
    });

    test("interval below minimum is clamped to 20s", async () => {
        // Match the Monitor.beat() clamp (interval >= 20).
        const deferMs = await IncidentTracker.computeDeferWindowMs(10, 5);
        assert.strictEqual(deferMs, 20_000);
    });

    test("null interval falls back to 60s default", async () => {
        const deferMs = await IncidentTracker.computeDeferWindowMs(10, null);
        assert.strictEqual(deferMs, 60_000);
    });

    test("recent last beat → defer aims for just past parent's next expected beat", async () => {
        // Last beat 5s ago, interval 60s. Next beat in ~55s.
        R.getRow = async () => ({ time: Date.now() - 5_000 });
        const deferMs = await IncidentTracker.computeDeferWindowMs(10, 60);
        // 60_000 - 5_000 + 1_000 buffer = 56_000.
        assert.strictEqual(deferMs, 56_000);
    });

    test("stale last beat (older than 3× interval) → null (fire standalone)", async () => {
        // 1 hour ago, interval 60s. Threshold is 3×60s = 180s. Way past it.
        R.getRow = async () => ({ time: Date.now() - 60 * 60 * 1000 });
        const deferMs = await IncidentTracker.computeDeferWindowMs(10, 60);
        assert.strictEqual(deferMs, null);
    });
});

describe("queryFlaggedChildren (regression: missing MAINTENANCE import)", () => {
    let originalGetAll;
    let originalGetRow;

    beforeEach(() => {
        originalGetAll = R.getAll;
        originalGetRow = R.getRow;
    });

    afterEach(() => {
        R.getAll = originalGetAll;
        R.getRow = originalGetRow;
    });

    test("returns flagged children and excludes ones in MAINTENANCE", async () => {
        R.getAll = async () => [{ id: 6, name: "api" }, { id: 7, name: "front" }];
        R.getRow = async (sql, params) => {
            if (/SELECT status/i.test(sql)) {
                return { status: params[0] === 6 ? UP : MAINTENANCE };
            }
            return null;
        };
        const out = await IncidentTracker.queryFlaggedChildren(5);
        assert.deepStrictEqual(out, [{ id: 6, name: "api" }]);
    });

    test("root handleDown folds flagged children without downFlaggedChildren option → incident-root", async () => {
        // This is the path that dispatches the consolidated notification.
        // Before the MAINTENANCE import fix, queryFlaggedChildren always
        // returned [] (the ReferenceError was swallowed by its catch), so
        // root monitors fell through to the standard per-monitor DOWN
        // message instead of consolidating.
        R.getAll = async () => [{ id: 6, name: "api" }];
        const root = makeMonitor({ id: 5, name: "parent", parent: null });
        const decision = await IncidentTracker.handleDown(root);
        assert.strictEqual(decision.send, "incident-root");
        assert.strictEqual(decision.rootMonitor.id, 5);
        assert.deepStrictEqual(decision.affectedIds.sort(), [5, 6]);
        // Incident recorded as notified so later beats don't re-fire.
        assert.strictEqual(IncidentTracker.hasPendingIncidentForRoot(5), false);
    });
});

describe("IncidentTracker message formatters", () => {
    test("DOWN message matches user's spec", () => {
        const msg = IncidentTracker.formatIncidentDownMessage(
            "PostgreSQL",
            "Connection refused",
            [{ name: "API" }, { name: "Website" }, { name: "Payment service" }]
        );
        const expected = [
            "🔴 Incident detected",
            "",
            "Root cause:",
            "PostgreSQL Connection refused",
            "",
            "Affected services:",
            "• API",
            "• Website",
            "• Payment service",
            "",
            "Notifications suppressed:",
            "3 duplicate alerts",
        ].join("\n");
        assert.strictEqual(msg, expected);
    });

    test("DOWN message pluralises correctly", () => {
        const single = IncidentTracker.formatIncidentDownMessage(
            "Redis",
            "timeout",
            [{ name: "Cache reader" }]
        );
        assert.ok(single.includes("1 duplicate alert"), "expected singular, got: " + JSON.stringify(single));
        assert.ok(!single.includes("1 duplicate alerts"), "should not be plural");

        const multi = IncidentTracker.formatIncidentDownMessage(
            "Redis",
            "timeout",
            [{ name: "A" }, { name: "B" }, { name: "C" }]
        );
        assert.ok(multi.includes("3 duplicate alerts"), "expected plural, got: " + JSON.stringify(multi));
    });

    test("DOWN message handles empty affected list", () => {
        const msg = IncidentTracker.formatIncidentDownMessage(
            "PostgreSQL",
            "down",
            []
        );
        assert.ok(msg.includes("Affected services:\n(none)"));
        assert.ok(msg.includes("0 duplicate alerts"));
    });

    test("UP message lists still-affected services", () => {
        const msg = IncidentTracker.formatIncidentUpMessage(
            "PostgreSQL",
            [{ name: "Payment service" }]
        );
        const expected = [
            "✅ Incident resolved",
            "",
            "PostgreSQL recovered",
            "",
            "Still affected:",
            "• Payment service",
        ].join("\n");
        assert.strictEqual(msg, expected);
    });

    test("UP message omits Still affected section when list is empty", () => {
        const msg = IncidentTracker.formatIncidentUpMessage("PostgreSQL", []);
        assert.strictEqual(msg.includes("Still affected"), false);
        assert.ok(msg.endsWith("PostgreSQL recovered"));
    });

    test("UP message handles multiple still-affected services", () => {
        const msg = IncidentTracker.formatIncidentUpMessage("DB", [
            { name: "API" },
            { name: "Website" },
            { name: "Payment service" },
        ]);
        assert.ok(msg.includes("• API\n• Website\n• Payment service"));
    });
});
