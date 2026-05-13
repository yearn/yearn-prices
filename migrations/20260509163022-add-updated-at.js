'use strict';

var dbm;

exports.setup = function (options) {
  dbm = options.dbmigrate;
};

exports.up = function (db) {
  return db.runSql(`
    ALTER TABLE token_prices
      ADD COLUMN updated_at TIMESTAMP DEFAULT NOW();
  `);
};

exports.down = function (db) {
  return db.runSql(`
    ALTER TABLE token_prices
      DROP COLUMN updated_at;
  `);
};

exports._meta = {
  version: 1
};
