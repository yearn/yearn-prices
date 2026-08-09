'use strict'

var dbm

exports.setup = (options) => {
  dbm = options.dbmigrate
}

exports.up = (db) =>
  db.runSql(`
    ALTER TABLE token_prices
      ADD COLUMN updated_at TIMESTAMP DEFAULT NOW();
  `)

exports.down = (db) =>
  db.runSql(`
    ALTER TABLE token_prices
      DROP COLUMN updated_at;
  `)

exports._meta = {
  version: 1
}
