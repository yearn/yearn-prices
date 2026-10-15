'use strict'

// This dated incident manifest is immutable: later incidents need a new migration.
const observations = require('../src/prices/rejected-observations-2026-10.json')

exports.up = function (db) {
  const manifest = JSON.stringify(observations).replace(/'/g, "''")
  return db.runSql(`
    CREATE TABLE rejected_price_observations (
      chain TEXT NOT NULL,
      token TEXT NOT NULL CHECK (token = lower(token)),
      timestamp TIMESTAMPTZ NOT NULL,
      source TEXT NOT NULL,
      reason TEXT NOT NULL,
      PRIMARY KEY (chain, token, timestamp, source)
    );
    CREATE TABLE quarantined_token_prices (
      id BIGSERIAL PRIMARY KEY,
      original_row JSONB NOT NULL,
      reason TEXT NOT NULL,
      quarantined_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO rejected_price_observations (chain, token, timestamp, source, reason)
    SELECT item->>'chain', item->>'token', to_timestamp((item->>'timestamp')::bigint),
      source, 'Confirmed invalid provider observation; issue #' || (item->>'issue')
    FROM jsonb_array_elements('${manifest}'::jsonb) item
    CROSS JOIN (VALUES ('defillama'), ('defillama-alias')) sources(source);

    -- Protect against old warmup processes as well as the new application code.
    CREATE FUNCTION quarantine_rejected_price() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE rejection_reason TEXT;
    BEGIN
      SELECT reason INTO rejection_reason FROM rejected_price_observations
      WHERE chain = NEW.chain AND token = lower(NEW.token)
        AND timestamp = NEW.timestamp AND source = NEW.source;
      IF FOUND THEN
        INSERT INTO quarantined_token_prices (original_row, reason)
        VALUES (to_jsonb(NEW), rejection_reason);
        RETURN NULL;
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER quarantine_rejected_price
      BEFORE INSERT OR UPDATE ON token_prices
      FOR EACH ROW EXECUTE FUNCTION quarantine_rejected_price();

    WITH removed AS (
      DELETE FROM token_prices tp USING rejected_price_observations rejected
      WHERE rejected.chain = tp.chain AND rejected.token = lower(tp.token)
        AND rejected.timestamp = tp.timestamp AND rejected.source = tp.source
      RETURNING tp.*, rejected.reason AS rejection_reason
    )
    INSERT INTO quarantined_token_prices (original_row, reason)
    SELECT to_jsonb(removed) - 'rejection_reason', rejection_reason FROM removed;
  `)
}

exports.down = function () {
  // Rolling back this containment would restore invalid selectable prices.
  return Promise.reject(new Error('Price quarantine is irreversible; use a reviewed forward migration'))
}

exports._meta = { version: 1 }
