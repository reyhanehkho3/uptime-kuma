// Add columns to persist the down-escalation state across server restarts.
// The Monitor instance keeps an in-memory Map for fast access during a beat
// (see getDownState / downState in server/model/monitor.js), and writes the
// relevant fields here whenever the downStart or downAlertLevel flags change
// via Monitor._persistDownState. Without these columns the persistence call
// throws "SQLITE_ERROR: no column named down_start" the first time a
// monitor enters DOWN escalation.
//
//   down_start       BIGINT NULL    — epoch ms when this monitor first went DOWN in the current escalation window
//   down_alert_level INTEGER NOT NULL DEFAULT 0 — 0 = none, 1 = dev/legacy notified, 2 = tech lead, 3 = admin

exports.up = function (knex) {
    return knex.schema.alterTable("monitor", function (table) {
        table.bigInteger("down_start").nullable().defaultTo(null);
        table.integer("down_alert_level").notNullable().defaultTo(0);
    });
};

exports.down = function (knex) {
    return knex.schema.alterTable("monitor", function (table) {
        table.dropColumn("down_alert_level");
        table.dropColumn("down_start");
    });
};
