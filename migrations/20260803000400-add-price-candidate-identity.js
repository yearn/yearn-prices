'use strict';

var dbm;

exports.setup = function (options) {
  dbm = options.dbmigrate;
};

exports.up = function (db) {
  return db.runSql(`
    ALTER TABLE token_prices
      ADD COLUMN IF NOT EXISTS candidate_id TEXT;

    UPDATE token_prices
    SET candidate_id = COALESCE(NULLIF(adapter, ''), source)
      || COALESCE(
        '|provider:' || NULLIF(evidence_metadata->>'matchedIdentifier', ''),
        '|provider:' || NULLIF(evidence_metadata->'mapping'->>'providerIdentifier', ''),
        ''
      )
    WHERE candidate_id IS NULL;

    ALTER TABLE token_prices
      ALTER COLUMN candidate_id SET DEFAULT 'legacy',
      ALTER COLUMN candidate_id SET NOT NULL,
      DROP CONSTRAINT IF EXISTS token_prices_pkey;

    ALTER TABLE token_prices
      ADD CONSTRAINT token_prices_pkey
      PRIMARY KEY (chain, token, timestamp, source, candidate_id);
  `);
};

exports.down = function (db) {
  return db.runSql(`
    ALTER TABLE token_prices
      DROP CONSTRAINT IF EXISTS token_prices_pkey;

    DELETE FROM token_prices duplicate
    USING token_prices retained
    WHERE duplicate.ctid < retained.ctid
      AND duplicate.chain = retained.chain
      AND duplicate.token = retained.token
      AND duplicate.timestamp = retained.timestamp
      AND duplicate.source = retained.source;

    ALTER TABLE token_prices
      DROP COLUMN IF EXISTS candidate_id;

    ALTER TABLE token_prices
      ADD CONSTRAINT token_prices_pkey
      PRIMARY KEY (chain, token, timestamp, source);
  `);
};

exports._meta = {
  version: 1
};
