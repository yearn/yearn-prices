'use strict';

var dbm;

exports.setup = function (options) {
  dbm = options.dbmigrate;
};

exports.up = function (db) {
  return db.runSql(`
    ALTER TABLE token_prices
      ALTER COLUMN symbol TYPE TEXT;
  `);
};

exports.down = function (db) {
  return db.runSql(`
    ALTER TABLE token_prices
      ALTER COLUMN symbol TYPE VARCHAR(20)
      USING LEFT(symbol, 20);
  `);
};

exports._meta = {
  version: 1
};
