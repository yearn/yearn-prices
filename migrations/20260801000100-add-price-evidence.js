'use strict';

var dbm;

exports.setup = function (options) {
  dbm = options.dbmigrate;
};

exports.up = function (db) {
  return db.runSql(`
    ALTER TABLE token_prices
      ADD COLUMN IF NOT EXISTS observed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS evidence_kind TEXT,
      ADD COLUMN IF NOT EXISTS quality TEXT,
      ADD COLUMN IF NOT EXISTS adapter TEXT,
      ADD COLUMN IF NOT EXISTS block_number BIGINT,
      ADD COLUMN IF NOT EXISTS input_evidence JSONB,
      ADD COLUMN IF NOT EXISTS validation_status TEXT,
      ADD COLUMN IF NOT EXISTS failure_reason TEXT,
      ADD COLUMN IF NOT EXISTS evidence_metadata JSONB;

    ALTER TABLE token_prices
      ADD CONSTRAINT token_prices_evidence_kind_check
        CHECK (evidence_kind IS NULL OR evidence_kind IN ('observed', 'derived', 'estimated', 'legacy')),
      ADD CONSTRAINT token_prices_quality_check
        CHECK (quality IS NULL OR quality IN ('exact', 'near-eod', 'fallback', 'legacy')),
      ADD CONSTRAINT token_prices_validation_status_check
        CHECK (validation_status IS NULL OR validation_status IN ('validated', 'legacy-unvalidated', 'quarantined'));

    CREATE INDEX IF NOT EXISTS idx_token_prices_eod_evidence
      ON token_prices (chain, token, timestamp, validation_status, source);
  `);
};

exports.down = function (db) {
  return db.runSql(`
    DROP INDEX IF EXISTS idx_token_prices_eod_evidence;

    ALTER TABLE token_prices
      DROP CONSTRAINT IF EXISTS token_prices_validation_status_check,
      DROP CONSTRAINT IF EXISTS token_prices_quality_check,
      DROP CONSTRAINT IF EXISTS token_prices_evidence_kind_check,
      DROP COLUMN IF EXISTS evidence_metadata,
      DROP COLUMN IF EXISTS failure_reason,
      DROP COLUMN IF EXISTS validation_status,
      DROP COLUMN IF EXISTS input_evidence,
      DROP COLUMN IF EXISTS block_number,
      DROP COLUMN IF EXISTS adapter,
      DROP COLUMN IF EXISTS quality,
      DROP COLUMN IF EXISTS evidence_kind,
      DROP COLUMN IF EXISTS observed_at;
  `);
};

exports._meta = {
  version: 1
};
