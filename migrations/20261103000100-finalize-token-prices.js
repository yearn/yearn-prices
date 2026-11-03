'use strict'

exports.up = function (db) {
  return db.runSql(`
    ALTER TABLE token_prices
      ADD COLUMN finalized BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN observed_at TIMESTAMPTZ,
      ADD COLUMN observation_endpoint TEXT;

    -- Rows keyed to today's UTC close are still provisional until a later
    -- warmup can request the closed-day observation.
    UPDATE token_prices
    SET finalized = FALSE
    WHERE timestamp = to_timestamp(floor(extract(epoch from now()) / 86400)::bigint * 86400 + 86399);

    -- Move pre-existing invalid values to the same quarantine used for
    -- incident-rejected observations before enforcing the ingestion invariant.
    INSERT INTO quarantined_token_prices (original_row, reason)
    SELECT jsonb_build_object(
      'chain', tp.chain,
      'token', tp.token,
      'timestamp', tp.timestamp,
      'price', tp.price::text,
      'symbol', tp.symbol,
      'confidence', CASE WHEN tp.confidence IS NULL THEN NULL ELSE tp.confidence::text END,
      'source', tp.source,
      'created_at', tp.created_at,
      'updated_at', tp.updated_at
    ),
      'Invalid token price: expected a finite positive value'
    FROM token_prices tp
    WHERE tp.price <= 0 OR tp.price::text IN ('NaN', 'Infinity', '-Infinity');

    DELETE FROM token_prices tp
    WHERE tp.price <= 0 OR tp.price::text IN ('NaN', 'Infinity', '-Infinity');

    ALTER TABLE token_prices
      ADD CONSTRAINT token_prices_price_finite_positive
      CHECK (price > 0 AND price::text NOT IN ('NaN', 'Infinity', '-Infinity'));
  `)
}

exports.down = function () {
  return Promise.reject(
    new Error('Finalization and invalid-price quarantine are forward-only; use a reviewed forward migration')
  )
}

exports._meta = { version: 1 }
