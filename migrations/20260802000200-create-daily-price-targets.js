'use strict';

var dbm;

exports.setup = function (options) {
  dbm = options.dbmigrate;
};

exports.up = function (db) {
  return db.runSql(`
    CREATE TABLE IF NOT EXISTS daily_price_targets (
      id                BIGSERIAL PRIMARY KEY,
      chain             VARCHAR(20) NOT NULL,
      token             VARCHAR(60) NOT NULL,
      eod_at            TIMESTAMPTZ NOT NULL,
      status            TEXT NOT NULL DEFAULT 'pending',
      attempt_count     INTEGER NOT NULL DEFAULT 0,
      adapter           TEXT,
      failure_class     TEXT,
      failure_reason    TEXT,
      next_retry_at     TIMESTAMPTZ,
      lease_expires_at  TIMESTAMPTZ,
      last_attempt_at   TIMESTAMPTZ,
      completed_at      TIMESTAMPTZ,
      metadata          JSONB,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (chain, token, eod_at),
      CONSTRAINT daily_price_targets_exact_eod_check CHECK (
        MOD(EXTRACT(EPOCH FROM eod_at)::BIGINT, 86400) = 86399
      ),
      CONSTRAINT daily_price_targets_status_check CHECK (
        status IN ('pending', 'in_progress', 'priced', 'unsupported', 'retryable', 'quarantined')
      ),
      CONSTRAINT daily_price_targets_failure_class_check CHECK (
        failure_class IS NULL OR failure_class IN ('unsupported', 'retryable', 'invalid', 'disagreement')
      )
    );

    CREATE INDEX IF NOT EXISTS idx_daily_price_targets_eligible
      ON daily_price_targets (status, next_retry_at, lease_expires_at, chain, eod_at, token);
  `);
};

exports.down = function (db) {
  return db.runSql(`
    DROP INDEX IF EXISTS idx_daily_price_targets_eligible;
    DROP TABLE IF EXISTS daily_price_targets;
  `);
};

exports._meta = {
  version: 1
};
