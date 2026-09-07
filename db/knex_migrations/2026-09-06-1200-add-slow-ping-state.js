// Add columns to persist the slow-ping alert state across server restarts.
// The Monitor instance keeps an in-memory Map for fast access during a beat,
// and writes the relevant fields here whenever the slowPingStart or
// slowPingAlertSent flags change.

exports.up = function (knex) {
    return knex.schema.alterTable("monitor", function (table) {
        table.bigInteger("slow_ping_start").nullable().defaultTo(null);
        table.boolean("slow_ping_alert_sent").notNullable().defaultTo(false);
    });
};

exports.down = function (knex) {
    return knex.schema.alterTable("monitor", function (table) {
        table.dropColumn("slow_ping_start");
        table.dropColumn("slow_ping_alert_sent");
    });
};
