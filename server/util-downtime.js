const dayjs = require("dayjs");
dayjs.extend(require("dayjs/plugin/utc"));

const { UP, DOWN, SQL_DATETIME_FORMAT } = require("../src/util");

// Never examine more candidates than this when hunting the longest window.
// Observed downtime is always ≤ the raw window duration, so the
// sort-descending + early-exit below keeps the common cases at one or two
// inner-beat queries regardless of how many outages a monitor has had.
const MAX_CANDIDATES = 50;

/**
 * Compute the longest observed downtime for a monitor, in seconds.
 *
 * Downtime only accrues while the monitor was actually being checked.
 * Any stretch inside an outage window with no stored heartbeats for
 * longer than 2× the monitor's interval (Uptime Kuma itself was offline,
 * the monitor was paused, or beats simply stopped) is treated as "no
 * data" and excluded, instead of being silently attributed to the
 * monitored service.
 * @param {Array<{status: number, time: string}>} transitions Important
 * heartbeats (status UP or DOWN) sorted ascending by time. `time` uses the
 * SQL datetime format ("YYYY-MM-DD HH:mm:ss.SSS"), which compares
 * lexicographically the same as chronologically.
 * @param {object} options
 * @param {number} options.intervalSec Monitor check interval in seconds
 * @param {(downTime: string, endTime: string) => Promise<Array<{time: string}>>} options.loadInnerBeats
 * Returns ALL stored beats for the monitor strictly between the two given
 * times, ascending.
 * @param {number} options.nowMs Current time, used as the end bound for
 * an outage that is still ongoing. Defaults to Date.now(). Injectable for
 * deterministic tests.
 * @returns {Promise<number>} Longest downtime in seconds (0 if none).
 */
async function computeLongestDowntime(transitions, options) {
    const nowMs = options.nowMs ?? Date.now();
    const intervalSec = Math.max(Number(options.intervalSec) || 60, 20);
    const noDataThresholdMs = intervalSec * 2 * 1000;
    const toMs = (time) => dayjs.utc(time).valueOf();

    // Pair DOWN transitions with the UP transition that closes them.
    const closed = [];
    let lastDownBeat = null;
    for (const beat of transitions) {
        const status = Number(beat.status);
        if (status === DOWN) {
            // Repeated DOWN transitions shouldn't happen with important=1
            // rows; keep the earliest so the outage spans the whole period.
            if (!lastDownBeat) {
                lastDownBeat = beat;
            }
        } else if (status === UP && lastDownBeat) {
            closed.push({
                downTimeStr: lastDownBeat.time,
                endTimeStr: beat.time,
                endMs: toMs(beat.time),
                rawMs: toMs(beat.time) - toMs(lastDownBeat.time),
            });
            lastDownBeat = null;
        }
        // UP without a preceding DOWN (monitor just came online for the
        // first time) — skip, no outage to measure.
    }

    // An outage that never closed is still ongoing: measure up to now.
    let ongoing = null;
    if (lastDownBeat) {
        ongoing = {
            downTimeStr: lastDownBeat.time,
            endTimeStr: dayjs.utc(nowMs).format(SQL_DATETIME_FORMAT),
            endMs: nowMs,
            rawMs: nowMs - toMs(lastDownBeat.time),
        };
    }

    const all = [
        ...closed,
        ...(ongoing ? [ongoing] : []),
    ].sort((a, b) => b.rawMs - a.rawMs);

    let longestMs = 0;
    for (const candidate of all.slice(0, MAX_CANDIDATES)) {
        // Observed ≤ raw, so once the raw duration can't beat the best
        // observed duration found so far, no later candidate can either.
        if (candidate.rawMs <= longestMs) {
            break;
        }
        const observedMs = await measureObservedDowntime(candidate, options.loadInnerBeats, noDataThresholdMs, toMs);
        if (observedMs > longestMs) {
            longestMs = observedMs;
        }
    }

    return Math.round(longestMs / 1000);
}

/**
 * Sum the observed (data-backed) downtime inside one DOWN→UP window.
 * Walks the window's stored beats in order; consecutive beats closer
 * together than the no-data threshold contribute their gap to the total,
 * while longer gaps are excluded entirely.
 * @param {object} candidate Window descriptor
 * @param {string} candidate.downTimeStr SQL datetime of the DOWN transition
 * @param {string} candidate.endTimeStr SQL datetime of the closing UP transition (or "now")
 * @param {number} candidate.endMs Epoch ms of the window end
 * @param {Function} loadInnerBeats See computeLongestDowntime
 * @param {number} noDataThresholdMs Gaps longer than this are "no data"
 * @param {Function} toMs SQL datetime string → epoch ms
 * @returns {Promise<number>} Observed downtime in ms
 */
async function measureObservedDowntime(candidate, loadInnerBeats, noDataThresholdMs, toMs) {
    const inner = await loadInnerBeats(candidate.downTimeStr, candidate.endTimeStr);

    let observedMs = 0;
    let prevMs = toMs(candidate.downTimeStr);
    for (const row of inner) {
        const beatMs = toMs(row.time);
        if (beatMs <= prevMs) {
            // Defensive: duplicate or out-of-order rows.
            continue;
        }
        if (beatMs - prevMs <= noDataThresholdMs) {
            observedMs += beatMs - prevMs;
        }
        // A longer gap is "no data": it splits the observed window and is
        // not counted, but the walk continues on the far side of it.
        prevMs = beatMs;
    }
    if (candidate.endMs > prevMs && candidate.endMs - prevMs <= noDataThresholdMs) {
        observedMs += candidate.endMs - prevMs;
    }
    return observedMs;
}

module.exports = {
    computeLongestDowntime,
};
