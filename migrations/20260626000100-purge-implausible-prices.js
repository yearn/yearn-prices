'use strict';

// One-time cleanup of provider garbage already stored before the ingestion guard
// existed: 0 / negative prices and the ~1e10 stale-Curve-LP bug. The read path
// now filters these too, so this only shrinks the table; it does not change what
// is served. MAX_PLAUSIBLE_PRICE = 1_000_000 (keep in sync with src/format.ts).

var dbm;

exports.setup = function (options) {
  dbm = options.dbmigrate;
};

exports.up = function (db) {
  return db.runSql(`
    DELETE FROM token_prices
    WHERE price <= 0 OR price > 1000000;
  `);
};

// Irreversible: the deleted rows were garbage and are not retained.
exports.down = function () {
  return Promise.resolve();
};

exports._meta = {
  version: 1
};
