// Add a per-monitor flag that opts the monitor into root-cause incident
// grouping. When enabled and a parent monitor is configured, this monitor's
// DOWN notifications are folded into a single consolidated incident
// notification keyed by the parent (the root cause) instead of firing
// independently. Default false preserves existing behaviour for monitors
// that don't opt in.

exports.up = function (knex) {
    return knex.schema.alterTable("monitor", function (table) {
        table.boolean("group_notifications").notNullable().defaultTo(false);
    });
};

exports.down = function (knex) {
    return knex.schema.alterTable("monitor", function (table) {
        table.dropColumn("group_notifications");
    });
};
