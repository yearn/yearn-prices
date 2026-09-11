'use strict'

var dbm

exports.setup = function (options) {
  dbm = options.dbmigrate
}

exports.up = function (db) {
  return db.runSql(`
    CREATE TABLE IF NOT EXISTS historical_price_gap_inventory (
      chain_id BIGINT NOT NULL CHECK (chain_id > 0),
      token VARCHAR(60) NOT NULL
        CHECK (token ~ '^0x[0-9a-f]{40}$')
        CHECK (token = lower(token)),
      timestamp TIMESTAMPTZ NOT NULL
        CHECK (
          MOD(EXTRACT(EPOCH FROM timestamp)::BIGINT, 86400) = 86399
        ),
      PRIMARY KEY (chain_id, token, timestamp)
    );
  `)
}

exports.down = function (db) {
  return db.runSql(`
    DROP TABLE IF EXISTS historical_price_gap_inventory;
  `)
}

exports._meta = {
  version: 1
}
