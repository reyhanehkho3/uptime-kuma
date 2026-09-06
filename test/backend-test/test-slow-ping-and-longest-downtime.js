const { describe, test } = require("node:test");
const assert = require("node:assert");
const dayjs = require("dayjs");
const { UP, DOWN, MAINTENANCE } = require("../../src/util");
dayjs.extend(require("dayjs/plugin/utc"));

/**
 * Pure-JS port of the longest-downtime algorithm from server/server.js
 * getLongestDowntime handler. Same logic, no DB.
 * @param {Array<{status: number, time: string}>} heartbeats Important heartbeats sorted ASC by time
 * @returns {number} Longest downtime duration in seconds (0 if no outages)
 */
function computeLongestDowntime(heartbeats) {
    let longestDowntime = 0;
    let lastDownBeat = null;
    const now = dayjs.utc().valueOf();

    for (const beat of heartbeats) {
        const beatStatus = Number(beat.status);
        if (beatStatus === DOWN) {
            if (!lastDownBeat) {
                lastDownBeat = beat;
            }
        } else if (beatStatus === UP && lastDownBeat) {
            const durationSec = Math.round(
                (dayjs.utc(beat.time).valueOf() - dayjs.utc(lastDownBeat.time).valueOf()) / 1000
            );
            if (durationSec > longestDowntime) {
                longestDowntime = durationSec;
            }
            lastDownBeat = null;
        }
    }

    if (lastDownBeat) {
        const ongoingSec = Math.round(
            (now - dayjs.utc(lastDownBeat.time).valueOf()) / 1000
        );
        if (ongoingSec > longestDowntime) {
            longestDowntime = ongoingSec;
        }
    }

    return longestDowntime;
}

describe("Longest downtime algorithm", () => {
    test("empty heartbeats → 0", () => {
        assert.strictEqual(computeLongestDowntime([]), 0);
    });

    test("single DOWN beat (currently down) → ongoing duration in seconds", () => {
        const twoMinAgo = dayjs.utc().subtract(2, "minute").format("YYYY-MM-DD HH:mm:ss.SSS");
        assert.strictEqual(computeLongestDowntime([
            { status: DOWN, time: twoMinAgo },
        ]), 120);
    });

    test("DOWN→UP pair → returns the gap", () => {
        const start = dayjs.utc("2026-01-01 10:00:00.000");
        const end = start.add(2, "minute");
        assert.strictEqual(computeLongestDowntime([
            { status: DOWN, time: start.format("YYYY-MM-DD HH:mm:ss.SSS") },
            { status: UP, time: end.format("YYYY-MM-DD HH:mm:ss.SSS") },
        ]), 120);
    });

    test("DOWN→UP→DOWN (recover then down again) → max of completed + ongoing", () => {
        const t0 = dayjs.utc("2026-01-01 10:00:00.000");
        const t1 = t0.add(1, "minute");   // short outage ended here
        const t2 = dayjs.utc().subtract(3, "minute");  // longer ongoing outage

        const longest = computeLongestDowntime([
            { status: DOWN, time: t0.format("YYYY-MM-DD HH:mm:ss.SSS") },
            { status: UP, time: t1.format("YYYY-MM-DD HH:mm:ss.SSS") },
            { status: DOWN, time: t2.format("YYYY-MM-DD HH:mm:ss.SSS") },
        ]);

        // 60s completed, ~180s ongoing → 180
        assert.ok(longest >= 175 && longest <= 185, `expected ~180, got ${longest}`);
    });

    test("only DOWN beats (never recovered) → ongoing duration", () => {
        const tenMinAgo = dayjs.utc().subtract(10, "minute").format("YYYY-MM-DD HH:mm:ss.SSS");
        assert.strictEqual(computeLongestDowntime([
            { status: DOWN, time: tenMinAgo },
        ]), 600);
    });

    test("multiple completed outages → longest wins", () => {
        const t0 = dayjs.utc("2026-01-01 10:00:00.000");
        assert.strictEqual(computeLongestDowntime([
            { status: DOWN, time: t0.format("YYYY-MM-DD HH:mm:ss.SSS") },
            { status: UP, time: t0.add(1, "minute").format("YYYY-MM-DD HH:mm:ss.SSS") },
            { status: DOWN, time: t0.add(10, "minute").format("YYYY-MM-DD HH:mm:ss.SSS") },
            { status: UP, time: t0.add(20, "minute").format("YYYY-MM-DD HH:mm:ss.SSS") },  // 10-min
            { status: DOWN, time: t0.add(30, "minute").format("YYYY-MM-DD HH:mm:ss.SSS") },
            { status: UP, time: t0.add(33, "minute").format("YYYY-MM-DD HH:mm:ss.SSS") },  // 3-min
        ]), 600);
    });

    test("UP beat without preceding DOWN is skipped", () => {
        const t0 = dayjs.utc("2026-01-01 10:00:00.000");
        assert.strictEqual(computeLongestDowntime([
            { status: UP, time: t0.format("YYYY-MM-DD HH:mm:ss.SSS") },  // initial UP, ignored
            { status: DOWN, time: t0.add(1, "minute").format("YYYY-MM-DD HH:mm:ss.SSS") },
            { status: UP, time: t0.add(2, "minute").format("YYYY-MM-DD HH:mm:ss.SSS") },
        ]), 60);
    });
});

// ---------------------------------------------------------------------------
// Slow-ping state machine tests
// ---------------------------------------------------------------------------
// We exercise the algorithm (state transitions + notification triggers)
// without spinning up a real database. The implementation reads from the
// module-level `slowPingState` Map and calls sendSlowPingNotification via
// the Monitor class. We bypass Monitor.start / R.store entirely by mocking
// the Notification.send surface and verifying that the right calls happen
// at the right state transitions.

const SLOW_PING_THRESHOLD_MS = 1000;
const SLOW_PING_DURATION_MS = 5 * 60 * 1000;

/**
 * Build a heartbeat bean fixture
 * @param {object} opts Bean fields
 * @param {number} opts.status Heartbeat status code
 * @param {?number} opts.ping Ping in ms (null if unmeasured)
 * @param {string} opts.msg Message
 * @returns {object} Heartbeat-shaped object
 */
function makeBean({ status = UP, ping = null, msg = "" } = {}) {
    return { status, ping, msg };
}

/**
 * Build a monitor fixture with an id, name, and active flag
 * @param {object} opts Monitor fields
 * @param {number} opts.id Monitor ID
 * @param {string} opts.name Monitor name
 * @param {boolean} opts.active Whether the monitor is active
 * @returns {object} Monitor-shaped object
 */
function makeMonitor({ id = 1, name = "Test Monitor", active = true } = {}) {
    return { id, name, active };
}

/**
 * Inline replica of the production algorithm (server/model/monitor.js)
 * so we can drive it directly with mock Notification.send. This duplicates
 * the logic, but the alternative (requiring monitor.js into a test) would
 * pull in a database connection. The duplication is acceptable for a unit
 * test — the algorithm is short.
 * @param {Array} notificationCalls Array that will receive {kind, monitor, bean} entries
 * @returns {{state: object, check: Function}} Mutable state and the check function
 */
function makeTracker(notificationCalls) {
    const state = {
        slowPingStart: null,
        slowPingAlertSent: false,
    };

    /**
     * Run one beat through the slow-ping state machine.
     * @param {object} monitor Monitor fixture
     * @param {object} bean Heartbeat fixture
     * @returns {Promise<void>}
     */
    async function check(monitor, bean) {
        // Skip rules (must match server/model/monitor.js exactly)
        if (!monitor.active) {
            return;
        }
        if (bean.status === MAINTENANCE) {
            return;
        }
        if (bean.ping == null || typeof bean.ping !== "number") {
            return;
        }

        const overThreshold = bean.ping > SLOW_PING_THRESHOLD_MS;

        if (overThreshold) {
            if (state.slowPingStart === null) {
                state.slowPingStart = Date.now();
            }
            if (
                !state.slowPingAlertSent &&
                Date.now() - state.slowPingStart >= SLOW_PING_DURATION_MS
            ) {
                notificationCalls.push({ monitor, bean, kind: "slow" });
                state.slowPingAlertSent = true;
            }
        } else {
            if (state.slowPingAlertSent) {
                notificationCalls.push({ monitor, bean, kind: "recovered" });
            }
            state.slowPingStart = null;
            state.slowPingAlertSent = false;
        }
    }

    return { state, check };
}

describe("Slow-ping state machine", () => {
    test("below threshold → no notification, state stays empty", async () => {
        const calls = [];
        const { state, check } = makeTracker(calls);
        const monitor = makeMonitor();
        const bean = makeBean({ status: UP, ping: 500 });

        await check(monitor, bean);

        assert.strictEqual(state.slowPingStart, null);
        assert.strictEqual(state.slowPingAlertSent, false);
        assert.strictEqual(calls.length, 0);
    });

    test("above threshold → slowPingStart set, no alert until duration", async () => {
        const calls = [];
        const { state, check } = makeTracker(calls);
        const monitor = makeMonitor();

        await check(monitor, makeBean({ ping: 1500 }));
        assert.notStrictEqual(state.slowPingStart, null);
        assert.strictEqual(state.slowPingAlertSent, false);
        assert.strictEqual(calls.length, 0);

        // Second beat while still over threshold — no duplicate start, still no alert
        await check(monitor, makeBean({ ping: 1800 }));
        assert.strictEqual(calls.length, 0);
    });

    test("alert fires once after sustained duration elapses", async () => {
        const calls = [];
        const tracker = makeTracker(calls);
        const monitor = makeMonitor();

        // Set start time so that "now" looks like the threshold has elapsed
        tracker.state.slowPingStart = Date.now() - SLOW_PING_DURATION_MS - 1000;

        await tracker.check(monitor, makeBean({ ping: 2000 }));

        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].kind, "slow");
        assert.strictEqual(tracker.state.slowPingAlertSent, true);
    });

    test("no duplicate alerts while still slow", async () => {
        const calls = [];
        const tracker = makeTracker(calls);
        const monitor = makeMonitor();
        tracker.state.slowPingStart = Date.now() - SLOW_PING_DURATION_MS - 1000;

        await tracker.check(monitor, makeBean({ ping: 2000 }));
        await tracker.check(monitor, makeBean({ ping: 2500 }));
        await tracker.check(monitor, makeBean({ ping: 1800 }));

        assert.strictEqual(calls.length, 1, "only the first one should have alerted");
    });

    test("recovery alert when ping drops back below threshold", async () => {
        const calls = [];
        const tracker = makeTracker(calls);
        const monitor = makeMonitor();

        // Pre-arm: simulate that we already alerted
        tracker.state.slowPingStart = Date.now() - SLOW_PING_DURATION_MS;
        tracker.state.slowPingAlertSent = true;

        await tracker.check(monitor, makeBean({ ping: 500 }));

        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].kind, "recovered");
        assert.strictEqual(tracker.state.slowPingStart, null);
        assert.strictEqual(tracker.state.slowPingAlertSent, false);
    });

    test("no recovery notification if we never alerted", async () => {
        const calls = [];
        const tracker = makeTracker(calls);
        const monitor = makeMonitor();

        // Simulate: ping went over briefly but never long enough to alert
        tracker.state.slowPingStart = Date.now() - 1000;
        tracker.state.slowPingAlertSent = false;

        await tracker.check(monitor, makeBean({ ping: 500 }));

        assert.strictEqual(calls.length, 0);
        assert.strictEqual(tracker.state.slowPingStart, null);
    });

    test("MAINTENANCE status skips the check entirely", async () => {
        const calls = [];
        const tracker = makeTracker(calls);
        const monitor = makeMonitor();

        await tracker.check(monitor, makeBean({ status: MAINTENANCE, ping: 5000 }));

        assert.strictEqual(calls.length, 0);
        assert.strictEqual(tracker.state.slowPingStart, null);
    });

    test("null ping skips the check entirely", async () => {
        const calls = [];
        const tracker = makeTracker(calls);
        const monitor = makeMonitor();

        await tracker.check(monitor, makeBean({ status: UP, ping: null }));

        assert.strictEqual(calls.length, 0);
        assert.strictEqual(tracker.state.slowPingStart, null);
    });

    test("non-number ping skips the check entirely", async () => {
        const calls = [];
        const tracker = makeTracker(calls);
        const monitor = makeMonitor();

        await tracker.check(monitor, makeBean({ status: UP, ping: "1500" }));

        assert.strictEqual(calls.length, 0);
        assert.strictEqual(tracker.state.slowPingStart, null);
    });

    test("paused monitor skips the check entirely", async () => {
        const calls = [];
        const tracker = makeTracker(calls);
        const monitor = makeMonitor({ active: false });

        await tracker.check(monitor, makeBean({ ping: 5000 }));

        assert.strictEqual(calls.length, 0);
        assert.strictEqual(tracker.state.slowPingStart, null);
    });

    test("new slow period after recovery is treated independently", async () => {
        const calls = [];
        const tracker = makeTracker(calls);
        const monitor = makeMonitor();

        // First slow period (with alert)
        tracker.state.slowPingStart = Date.now() - SLOW_PING_DURATION_MS;
        await tracker.check(monitor, makeBean({ ping: 2000 }));
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(tracker.state.slowPingAlertSent, true);

        // Recovery
        await tracker.check(monitor, makeBean({ ping: 100 }));
        assert.strictEqual(calls.length, 2);
        assert.strictEqual(calls[1].kind, "recovered");
        assert.strictEqual(tracker.state.slowPingStart, null);

        // Second slow period — fresh start, alert again after duration
        tracker.state.slowPingStart = Date.now() - SLOW_PING_DURATION_MS;
        await tracker.check(monitor, makeBean({ ping: 2000 }));
        assert.strictEqual(calls.length, 3);
        assert.strictEqual(calls[2].kind, "slow");
        assert.strictEqual(tracker.state.slowPingAlertSent, true);
    });

    test("ping exactly at threshold (1000 ms) is NOT slow (uses >, not >=)", async () => {
        const calls = [];
        const tracker = makeTracker(calls);
        const monitor = makeMonitor();

        await tracker.check(monitor, makeBean({ ping: 1000 }));

        assert.strictEqual(calls.length, 0);
        assert.strictEqual(tracker.state.slowPingStart, null);
    });
});
