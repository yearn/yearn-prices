'use strict';

var dbm;

exports.setup = function (options) {
  dbm = options.dbmigrate;
};

exports.up = function (db) {
  return db.runSql(`
    UPDATE daily_price_targets
    SET metadata = COALESCE(metadata, '{}'::jsonb)
      || jsonb_strip_nulls(jsonb_build_object(
        'policyVersion', COALESCE(
          metadata->>'policyVersion',
          'eod-candidate-selection-v1'
        ),
        'adapterVersion', COALESCE(
          metadata->>'adapterVersion',
          CASE
            WHEN adapter IN (
              'historical-market-price',
              'defillama-historical',
              'defillama-coingecko-alias',
              'defillama-canonical-market-proxy',
              'production-yearn-prices-import'
            ) THEN 'defillama-eod-v1'
            WHEN adapter IS NOT NULL AND adapter <> 'candidate-selection'
              THEN 'historical-onchain-v1'
            ELSE NULL
          END
        ),
        'outcomeVersionBackfill', jsonb_build_object(
          'policyAdded', NOT COALESCE(metadata, '{}'::jsonb) ? 'policyVersion',
          'adapterAdded', (
            adapter IS NOT NULL
            AND adapter <> 'candidate-selection'
            AND NOT COALESCE(metadata, '{}'::jsonb) ? 'adapterVersion'
          )
        )
      ))
    WHERE status IN ('unsupported', 'quarantined')
      AND (
        NOT COALESCE(metadata, '{}'::jsonb) ? 'policyVersion'
        OR (
          adapter IS NOT NULL
          AND adapter <> 'candidate-selection'
          AND NOT COALESCE(metadata, '{}'::jsonb) ? 'adapterVersion'
        )
      );
  `);
};

exports.down = function (db) {
  return db.runSql(`
    UPDATE daily_price_targets
    SET metadata = (
      CASE
        WHEN metadata->'outcomeVersionBackfill'->>'adapterAdded' = 'true'
          THEN (
            CASE
              WHEN metadata->'outcomeVersionBackfill'->>'policyAdded' = 'true'
                THEN metadata - 'policyVersion'
              ELSE metadata
            END
          ) - 'adapterVersion'
        WHEN metadata->'outcomeVersionBackfill'->>'policyAdded' = 'true'
          THEN metadata - 'policyVersion'
        ELSE metadata
      END
    ) - 'outcomeVersionBackfill'
    WHERE metadata ? 'outcomeVersionBackfill';
  `);
};

exports._meta = {
  version: 1
};
