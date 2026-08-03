'use strict';

var dbm;

exports.setup = function (options) {
  dbm = options.dbmigrate;
};

exports.up = function (db) {
  return db.runSql(`
    CREATE TABLE IF NOT EXISTS daily_price_requeue_audits (
      id            BIGSERIAL PRIMARY KEY,
      requested_by  TEXT NOT NULL,
      reason        TEXT NOT NULL,
      scope         JSONB NOT NULL,
      targets       JSONB NOT NULL,
      target_count  INTEGER NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT daily_price_requeue_audits_target_count_check CHECK (
        target_count >= 0 AND target_count <= 500
      )
    );

    CREATE INDEX IF NOT EXISTS idx_daily_price_requeue_audits_created_at
      ON daily_price_requeue_audits (created_at DESC);
  `);
};

exports.down = function (db) {
  return db.runSql(`
    DROP INDEX IF EXISTS idx_daily_price_requeue_audits_created_at;
    DROP TABLE IF EXISTS daily_price_requeue_audits;
  `);
};

exports._meta = {
  version: 1
};
