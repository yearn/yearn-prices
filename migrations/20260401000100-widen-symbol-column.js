'use strict'

var dbm

exports.setup = (options) => {
  dbm = options.dbmigrate
}

exports.up = (db) =>
  db.runSql(`
    ALTER TABLE token_prices
      ALTER COLUMN symbol TYPE TEXT;
  `)

exports.down = (db) =>
  db.runSql(`
    ALTER TABLE token_prices
      ALTER COLUMN symbol TYPE VARCHAR(20)
      USING LEFT(symbol, 20);
  `)

exports._meta = {
  version: 1
}
