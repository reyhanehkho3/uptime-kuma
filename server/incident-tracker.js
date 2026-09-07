const { R } = require("redbean-node");
const { DOWN, PENDING } = require("../src/util");

/**
 * In-memory state for active root-cause incidents.
 *
 * incidents: rootMonitorId -> {
 *     startedAt: number,        // epoch ms when incident was created
 *     affected: Set<id>,        // monitor IDs that are folded in (excludes the root itself)
 *     rootNotified: boolean,    // whether the consolidated DOWN notification has been sent
 *     escalatedLevels: Set<1|2|3>, // which escalation tiers have been notified for the root
 * }
 *
 * affectedToRoot: childMonitorId -> rootMonitorId (reverse lookup for O(1) suppression checks)
 *
 * State is in-memory only; it is lost on server restart. Each monitor re-evaluates
 * on its next beat after a restart, so an in-progress incident re-establishes if
 * conditions still hold. Same trade-off as Monitor.downState / slowPingState.
 */
const incidents = new Map();
const affectedToRoot = new Map();

/**
 * Get-or-create the incident for a given root monitor ID.
 * @param {number} rootMonitorId Root-cause monitor ID
 * @returns {object} Incident record
 */
function getOrCreate(rootMonitorId) {
    let inc = incidents.get(rootMonitorId);
    if (!inc) {
        inc = {
            rootMonitorId,
            startedAt: Date.now(),
            affected: new Set(),
            rootNotified: false,
            escalatedLevels: new Set(),
        };
        incidents.set(rootMonitorId, inc);
    }
    return inc;
}

/**
 * Is this monitor ID currently folded into an incident as an affected child?
 * @param {number} monitorID
 * @returns {boolean}
 */
function isAffected(monitorID) {
    return affectedToRoot.has(monitorID);
}

/**
 * For an affected monitor, return its root-cause monitor ID.
 * @param {number} monitorID
 * @returns {number|null}
 */
function getRootFor(monitorID) {
    return affectedToRoot.get(monitorID) || null;
}

/**
 * Add an affected monitor to the incident for the given root.
 * @param {number} rootMonitorId
 * @param {number} childMonitorId
 * @returns {object} The (existing or new) incident record
 */
function addAffected(rootMonitorId, childMonitorId) {
    const inc = getOrCreate(rootMonitorId);
    if (!inc.affected.has(childMonitorId)) {
        inc.affected.add(childMonitorId);
        affectedToRoot.set(childMonitorId, rootMonitorId);
    }
    return inc;
}

/**
 * Remove an affected monitor from its incident (e.g. it recovered before the root).
 * @param {number} rootMonitorId
 * @param {number} childMonitorId
 */
function removeAffected(rootMonitorId, childMonitorId) {
    const inc = incidents.get(rootMonitorId);
    if (inc) {
        inc.affected.delete(childMonitorId);
    }
    affectedToRoot.delete(childMonitorId);
}

/**
 * Mark the consolidated root-cause DOWN notification as sent for an incident.
 */
function markRootNotified(rootMonitorId) {
    const inc = getOrCreate(rootMonitorId);
    inc.rootNotified = true;
}

/**
 * Record that a given escalation tier has been notified for the root.
 */
function markEscalated(rootMonitorId, level) {
    const inc = getOrCreate(rootMonitorId);
    inc.escalatedLevels.add(level);
}

/**
 * Return the set of escalation tiers already notified for the root (or empty set).
 */
function getEscalatedLevels(rootMonitorId) {
    const inc = incidents.get(rootMonitorId);
    return inc ? inc.escalatedLevels : new Set();
}

/**
 * Get the affected monitor IDs for an incident (empty if no incident).
 */
function getAffectedIds(rootMonitorId) {
    const inc = incidents.get(rootMonitorId);
    return inc ? Array.from(inc.affected) : [];
}

/**
 * Check whether an incident exists and is still active for a given root monitor.
 */
function hasIncident(rootMonitorId) {
    return incidents.has(rootMonitorId);
}

/**
 * Check whether an incident exists for a root monitor AND the consolidated
 * DOWN notification has NOT yet been sent. The parent's beat loop polls
 * this on every DOWN→DOWN beat; while it's true, the parent will fire the
 * consolidated notification on its own beat instead of waiting for a
 * resend-interval or the next UP→DOWN transition.
 */
function hasPendingIncidentForRoot(rootMonitorId) {
    const inc = incidents.get(rootMonitorId);
    return Boolean(inc) && !inc.rootNotified;
}

/**
 * Clear an incident entirely. Used when the root recovers.
 */
function clear(rootMonitorId) {
    const inc = incidents.get(rootMonitorId);
    if (inc) {
        for (const childId of inc.affected) {
            affectedToRoot.delete(childId);
        }
        incidents.delete(rootMonitorId);
    }
}

/**
 * Read the most recent heartbeat status of a monitor.
 * @param {number} monitorID
 * @returns {Promise<number|null>} Status constant (UP/DOWN/PENDING/MAINTENANCE) or null
 */
async function getMonitorStatus(monitorID) {
    const row = await R.getRow(
        "SELECT status FROM heartbeat WHERE monitor_id = ? ORDER BY time DESC LIMIT 1",
        [monitorID]
    );
    return row ? Number(row.status) : null;
}

/**
 * Read the most recent heartbeat timestamp of a monitor.
 * @param {number} monitorID
 * @returns {Promise<number|null>} Epoch ms or null if no heartbeat
 */
async function getLastBeatTimeMs(monitorID) {
    const row = await R.getRow(
        "SELECT time FROM heartbeat WHERE monitor_id = ? ORDER BY time DESC LIMIT 1",
        [monitorID]
    );
    return row ? Number(row.time) : null;
}

/**
 * Compute the defer window (ms) a child should wait before firing its own
 * DOWN notification, so the parent has a chance to record its own DOWN
 * transition in the same window. Aims for just past the parent's next
 * expected beat. Returns null when the parent is "stale" (no recent
 * heartbeat within 3× its interval) — caller should fire the standalone
 * notification immediately in that case, since the parent is unlikely to
 * fail in lockstep with the child.
 *
 *   parentInterval = max(monitor.interval, 20) (matches Monitor.beat's clamp)
 *
 * @param {number} parentID
 * @param {number|null} parentIntervalSec Value from monitor.interval column (or null if not loaded)
 * @returns {Promise<number|null>} Defer window in ms, or null if parent is stale
 */
async function computeDeferWindowMs(parentID, parentIntervalSec) {
    const intervalSec = Math.max(Number(parentIntervalSec) || 60, 20);
    const intervalMs = intervalSec * 1000;
    const lastBeatMs = await getLastBeatTimeMs(parentID);
    if (lastBeatMs === null) {
        // No heartbeat yet — parent is brand new or hasn't run. Use a
        // conservative interval-aligned defer so the first parent beat
        // gets a chance to land.
        return intervalMs;
    }
    const timeSinceLastBeat = Date.now() - lastBeatMs;
    if (timeSinceLastBeat > intervalMs * 3) {
        // Parent is stale (silent for more than 3× its interval). It is
        // very unlikely to fail in lockstep with the child — fire the
        // child's standalone notification right away.
        return null;
    }
    // Aim for just past the parent's next expected beat (with a 1s buffer
    // for clock skew / DB-write latency). Floor at 1s and cap at one full
    // interval so we never wait longer than one parent beat cycle.
    const timeToNextBeat = Math.max(0, intervalMs - timeSinceLastBeat);
    return Math.min(Math.max(timeToNextBeat + 1000, 1000), intervalMs);
}

/**
 * Find monitors whose parent is `rootMonitorId` and that opted in to incident
 * grouping (`group_notifications = 1`). Excludes inactive monitors and ones
 * currently in MAINTENANCE (those aren't really "in production" and shouldn't
 * appear as affected). Returned regardless of UP/DOWN status so that a
 * parent going DOWN can proactively fold in its children as the blast
 * radius before they themselves start failing.
 *
 * Returns array of { id, name }. Empty array on any failure (DB unavailable,
 * invalid input) so callers can safely default to "no affected".
 * @param {number} rootMonitorId
 * @returns {Promise<Array<{id: number, name: string}>>}
 */
async function queryFlaggedChildren(rootMonitorId) {
    if (!rootMonitorId) return [];
    try {
        const rows = await R.getAll(
            `SELECT m.id, m.name
             FROM monitor m
             WHERE m.parent = ?
               AND m.group_notifications = 1
               AND m.active = 1`,
            [rootMonitorId]
        );
        if (!rows || rows.length === 0) return [];

        // Filter out anyone whose most recent heartbeat is MAINTENANCE — those
        // aren't really in production and shouldn't be reported as affected.
        const filtered = [];
        for (const row of rows) {
            const status = await getMonitorStatus(row.id);
            if (status !== MAINTENANCE) {
                filtered.push(row);
            }
        }
        return filtered;
    } catch (e) {
        return [];
    }
}

/**
 * Like `queryFlaggedChildren` but restricted to those whose most recent
 * heartbeat is DOWN or PENDING. Kept for compatibility with callers that
 * specifically want only currently-broken dependents (e.g. tests).
 * @param {number} rootMonitorId
 * @returns {Promise<Array<{id: number, name: string}>>}
 */
async function queryFlaggedDownChildren(rootMonitorId) {
    const all = await queryFlaggedChildren(rootMonitorId);
    const out = [];
    for (const row of all) {
        const status = await getMonitorStatus(row.id);
        if (status === DOWN || status === PENDING) {
            out.push(row);
        }
    }
    return out;
}

/**
 * Decide what to do when a monitor goes DOWN.
 *
 * Returns one of:
 *   { send: "standard" }                                  — no grouping applies; fall through to existing notification
 *   { send: "incident-root", rootMonitor, affectedIds }   — first DOWN in incident; send consolidated notification on behalf of root
 *   { send: "suppress", rootMonitor }                     — already covered by an existing incident's notification
 *   { send: "deferred", rootMonitor, deferMs }            — wait `deferMs`, then re-decide (see below)
 *
 * "deferred" is returned when the child beats DOWN but the parent's most
 * recent heartbeat is still UP. This typically happens when both monitors
 * share an upstream dependency and fail in the same window: the parent's
 * DOWN heartbeat hasn't been written yet. To avoid a duplicate
 * notification, the caller should wait `deferMs` and re-call handleDown.
 * If the parent has since gone DOWN, the re-call returns "suppress" and
 * the child folds into the incident silently. Otherwise ("standard") the
 * caller fires the child's standalone DOWN notification. The defer window
 * targets just past the parent's next expected beat, capped at one full
 * parent beat interval.
 *
 * Accepts an optional `options.parent` to skip the DB lookup; useful for tests
 * and for callers that already have the parent row loaded.
 * @param {object} monitor The monitor that just transitioned to DOWN
 * @param {object} [options]
 * @param {{id: number, name: string, interval?: number}} [options.parent] Pre-loaded parent monitor row
 * @param {number} [options.parentStatus] Pre-loaded parent heartbeat status (UP/DOWN/PENDING/MAINTENANCE)
 * @param {Array<{id: number, name: string}>} [options.downFlaggedChildren] Pre-loaded list of flagged children currently DOWN (used when this monitor is the root of an incident)
 * @returns {Promise<object>}
 */
async function handleDown(monitor, options = {}) {
    // The flag controls participation as an *affected* child. A monitor
    // without the flag is still allowed to act as the root of an incident
    // (children with the flag get folded under it).
    const hasFlag = Boolean(monitor.groupNotifications || monitor.group_notifications);

    let parent = options.parent;
    if (!parent && monitor.parent) {
        parent = await R.getRow(
            "SELECT id, name, interval FROM monitor WHERE id = ?",
            [monitor.parent]
        ).catch(() => null);
    }

    // Top-level monitor going DOWN: fold in all of its flagged children
    // (the "blast radius") and send the consolidated notification on this
    // monitor's behalf. The children might still be UP at this moment —
    // any subsequent DOWN beat by a child will fold them in silently
    // (return "suppress") and let THIS monitor's next DOWN→DOWN beat
    // dispatch the consolidated notification. This path runs regardless
    // of this monitor's own flag — the flag controls child participation
    // only.
    if (!parent || !parent.id) {
        let flaggedChildren;
        if (options.downFlaggedChildren) {
            // Caller passed in the broken-only list (test fixture or
            // operational query that just wants the currently-down subset).
            flaggedChildren = options.downFlaggedChildren;
        } else {
            flaggedChildren = await queryFlaggedChildren(monitor.id);
        }
        if (flaggedChildren.length === 0) {
            return { send: "standard" };
        }

        const incident = getOrCreate(monitor.id);
        for (const child of flaggedChildren) {
            if (!incident.affected.has(child.id)) {
                incident.affected.add(child.id);
                affectedToRoot.set(child.id, monitor.id);
            }
        }

        if (incident.rootNotified) {
            // The incident's root-cause notification was already sent (e.g.
            // by a previous child beat). Don't fire again on this monitor's
            // beat — the next resend cycle or escalation will mention any
            // newly added children.
            return { send: "standard" };
        }

        incident.rootNotified = true;
        return {
            send: "incident-root",
            rootMonitor: { id: monitor.id, name: monitor.name },
            affectedIds: [monitor.id, ...Array.from(incident.affected)],
        };
    }

    // This monitor has a parent. To be folded into the parent's incident
    // it must have the flag enabled; otherwise it fires its own standalone
    // DOWN as before.
    if (!hasFlag) {
        return { send: "standard" };
    }

    // Look up parent's most recent heartbeat to see if it is also down.
    let parentStatus = options.parentStatus;
    if (parentStatus === undefined || parentStatus === null) {
        parentStatus = await getMonitorStatus(parent.id);
    }
    const parentIsDown = parentStatus === DOWN || parentStatus === PENDING;

    if (!parentIsDown) {
        // Parent is UP right now. Defer the child's notification so the
        // parent has a chance to record its own DOWN transition in the
        // same window (common when both monitors share an upstream
        // dependency). Caller will re-invoke handleDown after `deferMs`.
        // If the parent has since gone DOWN, the child is folded into
        // the incident and remains silent. If the parent is still UP
        // (genuine orphan), the caller fires the child's standalone.
        const deferMs = await computeDeferWindowMs(parent.id, parent.interval);
        if (deferMs === null) {
            // Parent is stale (no recent heartbeat) — fire child's
            // standalone notification immediately. The parent is very
            // unlikely to fail in lockstep with the child.
            return { send: "standard" };
        }
        return {
            send: "deferred",
            rootMonitor: parent,
            deferMs,
        };
    }

    const incident = addAffected(parent.id, monitor.id);

    // The child folds into the parent's incident silently. The parent is
    // responsible for firing the consolidated DOWN notification — its beat
    // loop polls IncidentTracker.hasPendingIncidentForRoot on every beat
    // (including DOWN→DOWN) and calls Monitor.maybeFirePendingIncident,
    // which dispatches the consolidated on the parent's behalf. This keeps
    // the trigger on the root-cause monitor instead of any one of its
    // dependents, and ensures the operator's notification list (configured
    // on the parent) is the only channel used for the consolidated alert.
    return { send: "suppress", rootMonitor: parent };
}

/**
 * Decide what to do when a monitor transitions to UP.
 *
 * Returns one of:
 *   { send: "standard" }                                         — no grouping; standard UP
 *   { send: "incident-resolved", rootMonitor, stillAffectedIds } — root recovered; send consolidated UP mentioning still-affected children
 *   { send: "suppress" }                                          — affected child recovered before root; suppressed
 *
 * @param {object} monitor
 * @param {object} [options]
 * @param {Map<number, number>} [options.statusByMonitorId] Optional pre-loaded map of monitor ID → most recent heartbeat status. Used to skip the DB lookup in tests and by callers that already have statuses loaded.
 * @returns {Promise<object>}
 */
async function handleUp(monitor, options = {}) {
    // If this monitor is itself the root of an active incident, close it.
    if (incidents.has(monitor.id)) {
        const incident = incidents.get(monitor.id);
        // Only list children that are CURRENTLY DOWN as "still affected".
        // Children we proactively folded in while they were still UP may
        // have recovered already (or never failed), and we don't want to
        // report them in the recovery message.
        const stillAffectedIds = [];
        for (const childId of incident.affected) {
            let status;
            if (options.statusByMonitorId && options.statusByMonitorId.has(childId)) {
                status = options.statusByMonitorId.get(childId);
            } else {
                status = await getMonitorStatus(childId);
            }
            if (status === DOWN || status === PENDING) {
                stillAffectedIds.push(childId);
            }
        }
        clear(monitor.id);
        return {
            send: "incident-resolved",
            rootMonitor: { id: monitor.id, name: monitor.name },
            stillAffectedIds,
        };
    }

    // If this monitor is an affected child, remove it silently. The root's
    // eventual recovery notification will reflect the final state.
    if (affectedToRoot.has(monitor.id)) {
        const rootId = affectedToRoot.get(monitor.id);
        removeAffected(rootId, monitor.id);
        return { send: "suppress" };
    }

    return { send: "standard" };
}

/**
 * When a root monitor re-fires its DOWN notification via the resendInterval
 * path, we want the message to keep mentioning the affected list. The
 * caller passes the parent's notification context; this helper returns
 * the updated affected IDs (empty if the incident has been cleared).
 */
function getActiveAffectedForRoot(rootMonitorId) {
    return getAffectedIds(rootMonitorId);
}

/**
 * Format the consolidated DOWN message body for an incident.
 *
 * Layout (matches user's spec):
 *
 *   🔴 Incident detected
 *
 *   Root cause:
 *   PostgreSQL unavailable
 *
 *   Affected services:
 *   • API
 *   • Website
 *   • Payment service
 *
 *   Notifications suppressed:
 *   3 duplicate alerts
 *
 * @param {string} rootName Name of root-cause monitor
 * @param {string} rootMsg  Heartbeat message from root (e.g. "timeout by AbortSignal")
 * @param {Array<{name: string}>} affectedMonitors List of affected child monitors (without root)
 * @returns {string}
 */
function formatIncidentDownMessage(rootName, rootMsg, affectedMonitors) {
    const affectedList = affectedMonitors.map((m) => `• ${m.name}`).join("\n");
    const suppressed = affectedMonitors.length;

    return [
        "🔴 Incident detected",
        "",
        "Root cause:",
        `${rootName} ${rootMsg || "unavailable"}`.trim(),
        "",
        "Affected services:",
        affectedList || "(none)",
        "",
        "Notifications suppressed:",
        `${suppressed} duplicate alert${suppressed === 1 ? "" : "s"}`,
    ].join("\n");
}

/**
 * Format the consolidated UP/recovery message body for an incident.
 */
function formatIncidentUpMessage(rootName, stillAffectedMonitors) {
    const lines = [
        "✅ Incident resolved",
        "",
        `${rootName} recovered`,
    ];

    if (stillAffectedMonitors.length > 0) {
        lines.push("", "Still affected:");
        for (const m of stillAffectedMonitors) {
            lines.push(`• ${m.name}`);
        }
    }

    return lines.join("\n");
}

/**
 * Look up monitor rows by IDs and return a name-indexed map { id -> row }.
 * @param {Array<number>} monitorIDs
 * @returns {Promise<Map<number, object>>}
 */
async function getMonitorsByIDs(monitorIDs) {
    if (!monitorIDs || monitorIDs.length === 0) {
        return new Map();
    }
    const placeholders = monitorIDs.map(() => "?").join(",");
    const rows = await R.getAll(
        `SELECT id, name FROM monitor WHERE id IN (${placeholders})`,
        monitorIDs
    );
    const map = new Map();
    for (const row of rows) {
        map.set(row.id, row);
    }
    return map;
}

module.exports = {
    handleDown,
    handleUp,
    isAffected,
    getRootFor,
    addAffected,
    removeAffected,
    markRootNotified,
    markEscalated,
    getEscalatedLevels,
    getAffectedIds,
    hasIncident,
    hasPendingIncidentForRoot,
    getActiveAffectedForRoot,
    clear,
    formatIncidentDownMessage,
    formatIncidentUpMessage,
    getMonitorsByIDs,
    getMonitorStatus,
    computeDeferWindowMs,
    // Exposed for tests
    _incidents: incidents,
    _affectedToRoot: affectedToRoot,
    _reset: () => {
        incidents.clear();
        affectedToRoot.clear();
    },
};
