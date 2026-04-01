'use strict';

var dbm;

exports.setup = function (options) {
  dbm = options.dbmigrate;
};

exports.up = function (db) {
  return db.runSql(`
    CREATE TABLE IF NOT EXISTS token_prices (
      chain      VARCHAR(20)  NOT NULL,
      token      VARCHAR(60)  NOT NULL,
      timestamp  TIMESTAMPTZ  NOT NULL,
      price      NUMERIC      NOT NULL,
      symbol     VARCHAR(20),
      confidence NUMERIC,
      source     VARCHAR(50)  NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (chain, token, timestamp, source)
    );

    CREATE INDEX IF NOT EXISTS idx_token_prices_range
      ON token_prices (chain, token, timestamp);
  `);
};

exports.down = function (db) {
  return db.runSql(`
    DROP INDEX IF EXISTS idx_token_prices_range;
    DROP TABLE IF EXISTS token_prices;
  `);
};

exports._meta = {
  version: 1
};
