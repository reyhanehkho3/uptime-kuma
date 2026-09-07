const { describe, test } = require("node:test");
const assert = require("node:assert");
const dayjs = require("dayjs");
const NotificationProvider = require("../../server/notification-providers/notification-provider");
const { UP, DOWN, MAINTENANCE } = require("../../src/util");
dayjs.extend(require("dayjs/plugin/utc"));

// Tests exercise the REAL longest-downtime implementation
// (server/util-downtime.js) — the same module the getLongestDowntime socket
// handler uses — with an in-memory beat list instead of a hand-maintained
// port, so the tests cannot drift from production logic.
const { computeLongestDowntime } = require("../../server/util-downtime");

const SQL_DATETIME_FORMAT = "YYYY-MM-DD HH:mm:ss.SSS";
const fmt = (d) => d.format(SQL_DATETIME_FORMAT);

/**
 * Build a loadInnerBeats callback over an in-memory list of beat times
 * (SQL datetime strings). Mimics the handler's
 * `SELECT time ... WHERE time > ? AND time < ? ORDER BY time ASC` query.
 * @param {string[]} allBeatTimes Every stored beat time for the monitor
 * @returns {Function} loadInnerBeats(downTime, endTime)
 */
function makeInnerBeatLoader(allBeatTimes) {
    return async (downTime, endTime) =>
        allBeatTimes
            .filter((t) => t > downTime && t < endTime)
            .sort()
            .map((time) => ({ time }));
}

describe("Longest downtime algorithm", () => {
    test("empty heartbeats → 0", async () => {
        const duration = await computeLongestDowntime([], {
            intervalSec: 60,
            loadInnerBeats: makeInnerBeatLoader([]),
            nowMs: dayjs.utc("2026-01-01 12:00:00.000").valueOf(),
        });
        assert.strictEqual(duration, 0);
    });

    test("ongoing outage with beats at normal cadence → full window counted", async () => {
        const t0 = dayjs.utc("2026-01-01 10:00:00.000");
        const now = t0.add(2, "minute");
        const duration = await computeLongestDowntime(
            [{ status: DOWN, time: fmt(t0) }],
            {
                intervalSec: 60,
                loadInnerBeats: makeInnerBeatLoader([fmt(t0.add(60, "second"))]),
                nowMs: now.valueOf(),
            }
        );
        assert.strictEqual(duration, 120);
    });

    test("DOWN→UP pair within one interval, no inner beats → gap counted", async () => {
        const t0 = dayjs.utc("2026-01-01 10:00:00.000");
        const duration = await computeLongestDowntime(
            [
                { status: DOWN, time: fmt(t0) },
                { status: UP, time: fmt(t0.add(2, "minute")) },
            ],
            {
                intervalSec: 60,
                loadInnerBeats: makeInnerBeatLoader([]),
                nowMs: t0.add(3, "minute").valueOf(),
            }
        );
        assert.strictEqual(duration, 120);
    });

    test("DOWN→UP→DOWN (recover then down again) → max of completed + ongoing", async () => {
        const t0 = dayjs.utc("2026-01-01 10:00:00.000");
        const t2 = t0.add(10, "minute"); // ongoing outage starts here

        const duration = await computeLongestDowntime(
            [
                { status: DOWN, time: fmt(t0) },
                { status: UP, time: fmt(t0.add(1, "minute")) },
                { status: DOWN, time: fmt(t2) },
            ],
            {
                intervalSec: 60,
                loadInnerBeats: makeInnerBeatLoader([
                    fmt(t2.add(60, "second")),
                    fmt(t2.add(120, "second")),
                ]),
                nowMs: t2.add(3, "minute").valueOf(),
            }
        );

        // 60s completed, 180s ongoing → 180
        assert.strictEqual(duration, 180);
    });

    test("long ongoing outage with continuous beats → fully counted", async () => {
        const t0 = dayjs.utc("2026-01-01 10:00:00.000");
        const inner = [];
        for (let i = 1; i <= 9; i++) {
            inner.push(fmt(t0.add(i, "minute")));
        }
        const duration = await computeLongestDowntime(
            [{ status: DOWN, time: fmt(t0) }],
            {
                intervalSec: 60,
                loadInnerBeats: makeInnerBeatLoader(inner),
                nowMs: t0.add(10, "minute").valueOf(),
            }
        );
        assert.strictEqual(duration, 600);
    });

    test("multiple completed outages → longest wins", async () => {
        const t0 = dayjs.utc("2026-01-01 10:00:00.000");
        const innerForTenMinWindow = [];
        for (let i = 1; i <= 9; i++) {
            innerForTenMinWindow.push(fmt(t0.add(10, "minute").add(i, "minute")));
        }
        const duration = await computeLongestDowntime(
            [
                { status: DOWN, time: fmt(t0) },
                { status: UP, time: fmt(t0.add(1, "minute")) },
                { status: DOWN, time: fmt(t0.add(10, "minute")) },
                { status: UP, time: fmt(t0.add(20, "minute")) },  // 10-min
                { status: DOWN, time: fmt(t0.add(30, "minute")) },
                { status: UP, time: fmt(t0.add(33, "minute")) },  // 3-min
            ],
            {
                intervalSec: 60,
                loadInnerBeats: makeInnerBeatLoader([
                    ...innerForTenMinWindow,
                    fmt(t0.add(31, "minute")),
                    fmt(t0.add(32, "minute")),
                ]),
                nowMs: t0.add(40, "minute").valueOf(),
            }
        );
        assert.strictEqual(duration, 600);
    });

    test("UP beat without preceding DOWN is skipped", async () => {
        const t0 = dayjs.utc("2026-01-01 10:00:00.000");
        const duration = await computeLongestDowntime(
            [
                { status: UP, time: fmt(t0) },  // initial UP, ignored
                { status: DOWN, time: fmt(t0.add(1, "minute")) },
                { status: UP, time: fmt(t0.add(2, "minute")) },
            ],
            {
                intervalSec: 60,
                loadInnerBeats: makeInnerBeatLoader([]),
                nowMs: t0.add(3, "minute").valueOf(),
            }
        );
        assert.strictEqual(duration, 60);
    });

    test("no data at all inside a long window (Uptime Kuma offline) → 0", async () => {
        // Monitor added while the service was down; Uptime Kuma was off for
        // the whole window and the first post-restart beat was UP.
        const t0 = dayjs.utc("2026-01-01 10:00:00.000");
        const duration = await computeLongestDowntime(
            [
                { status: DOWN, time: fmt(t0) },
                { status: UP, time: fmt(t0.add(10, "minute")) },
            ],
            {
                intervalSec: 60,
                loadInnerBeats: makeInnerBeatLoader([]),
                nowMs: t0.add(11, "minute").valueOf(),
            }
        );
        assert.strictEqual(duration, 0);
    });

    test("regression: Uptime Kuma offline for hours mid-outage → only observed downtime counted", async () => {
        // DOWN, beats for 2 minutes, Uptime Kuma goes offline for ~3 hours,
        // comes back and the first beat is UP (service recovered while Kuma
        // was off — or at least, there is no data to say it stayed down).
        const t0 = dayjs.utc("2026-01-01 10:00:00.000");
        const duration = await computeLongestDowntime(
            [
                { status: DOWN, time: fmt(t0) },
                { status: UP, time: fmt(t0.add(3, "hour")) },
            ],
            {
                intervalSec: 60,
                loadInnerBeats: makeInnerBeatLoader([
                    fmt(t0.add(60, "second")),
                    fmt(t0.add(120, "second")),
                ]),
                nowMs: t0.add(3, "hour").add(1, "minute").valueOf(),
            }
        );
        // Previously this returned the full 3-hour window (10800s).
        assert.strictEqual(duration, 120);
    });

    test("regression: Uptime Kuma restarted mid-outage and service still down → gap excluded, observed parts summed", async () => {
        // DOWN at t0, beats for 5 minutes, Kuma off for ~55 minutes, restart
        // (first beat after restart is an important DOWN transition), beats
        // resume for another 4 minutes, still down at `now`.
        const t0 = dayjs.utc("2026-01-01 10:00:00.000");
        const inner = [];
        for (let i = 1; i <= 5; i++) {
            inner.push(fmt(t0.add(i, "minute")));
        }
        for (let i = 1; i <= 4; i++) {
            inner.push(fmt(t0.add(60, "minute").add(i, "minute")));
        }
        const duration = await computeLongestDowntime(
            [
                { status: DOWN, time: fmt(t0) },
                { status: DOWN, time: fmt(t0.add(60, "minute")) },  // first beat after restart
            ],
            {
                intervalSec: 60,
                loadInnerBeats: makeInnerBeatLoader(inner),
                nowMs: t0.add(65, "minute").valueOf(),
            }
        );
        // Observed: 300s before the gap + 180s of beats after restart + 60s
        // tail = 540s. The ~55-minute no-data stretch is excluded.
        assert.strictEqual(duration, 540);
    });

    test("ongoing outage with a stale tail (Kuma currently offline) → tail excluded", async () => {
        const t0 = dayjs.utc("2026-01-01 10:00:00.000");
        const duration = await computeLongestDowntime(
            [{ status: DOWN, time: fmt(t0) }],
            {
                intervalSec: 60,
                loadInnerBeats: makeInnerBeatLoader([
                    fmt(t0.add(60, "second")),
                    fmt(t0.add(120, "second")),
                ]),
                nowMs: t0.add(1, "hour").valueOf(),
            }
        );
        // Beats stopped 58 minutes ago — no data since, so only the first
        // 120 seconds count.
        assert.strictEqual(duration, 120);
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

describe("Slow-ping notification rendering", () => {
    test("template status labels slow-ping notifications as slow ping instead of down", async () => {
        const provider = new NotificationProvider();
        const rendered = await provider.renderTemplate(
            "{{ status }}",
            "Slow response exceeded 1s",
            {
                name: "Demo Monitor",
                type: "ping",
                hostname: "example.com",
            },
            {
                status: DOWN,
                ping: 1500,
                msg: "Slow response exceeded 1s",
                isSlowPing: true,
            }
        );

        assert.match(rendered, /Slow Ping/i);
        assert.doesNotMatch(rendered, /Down/i);
    });
});
