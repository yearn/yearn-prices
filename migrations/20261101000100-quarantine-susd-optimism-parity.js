'use strict'

// This dated incident manifest is immutable: later incidents need a new migration.
const observations = require('../src/prices/rejected-observations-2026-11.json')

const DERIVED_TOKENS = [
  '0x6d5ba400640226e24b50214d2bbb3d4db8e6e15a',
  '0x0fbea11f39be912096cec5ce22f46908b5375c19',
  '0x2a90f479002daae9934c3a70ebb6e8dbeb46292b',
  '0x3fc986cc3b44bad5baf1e47031055cf69466ad57',
  '0x6554aa3acf15cce6206470cc29416304f16b55d9',
  '0x7427c44d2824e4df3b518822f2b11154e937efea',
  '0xb151887bbba5585119c91914e740613ea16e7afd',
  '0xc328d83883f5f90e1108d4dd7a18ffca17ae74d7',
  '0x5e70e0ede43373bd9cf4bc85199d424acf0241ef',
  '0x1b1d2efb6045851f8ccde24369003e0ff157980b',
  '0xcf6abb37336e3a756b564e2c29222bf187a0de2a'
]

exports.up = function (db) {
  const manifest = JSON.stringify(observations).replace(/'/g, "''")
  const derivedTokens = DERIVED_TOKENS.map((token) => `'${token}'`).join(', ')
  return db.runSql(`
    INSERT INTO rejected_price_observations (chain, token, timestamp, source, reason)
    SELECT item->>'chain', item->>'token', to_timestamp((item->>'timestamp')::bigint),
      source, 'Confirmed invalid provider observation; issue #' || (item->>'issue')
    FROM jsonb_array_elements('${manifest}'::jsonb) item
    CROSS JOIN (VALUES ('defillama'), ('defillama-alias')) sources(source)
    ON CONFLICT (chain, token, timestamp, source) DO NOTHING;

    WITH removed AS (
      DELETE FROM token_prices tp USING rejected_price_observations rejected
      WHERE rejected.chain = tp.chain AND rejected.token = lower(tp.token)
        AND rejected.timestamp = tp.timestamp AND rejected.source = tp.source
        AND rejected.reason LIKE '%issue #74'
      RETURNING tp.*, rejected.reason AS rejection_reason
    )
    INSERT INTO quarantined_token_prices (original_row, reason)
    SELECT to_jsonb(removed) - 'rejection_reason', rejection_reason FROM removed;

    WITH removed AS (
      DELETE FROM token_prices
      WHERE chain = 'optimism' AND source = 'derived'
        AND timestamp BETWEEN '2026-07-01 23:59:59+00' AND '2026-10-20 23:59:59+00'
        AND lower(token) IN (${derivedTokens})
      RETURNING *
    )
    INSERT INTO quarantined_token_prices (original_row, reason)
    SELECT to_jsonb(removed), 'Derived from rejected sUSD parity observation; issue #74' FROM removed;
  `)
}

exports.down = function () {
  // Rolling back this containment would restore invalid selectable prices.
  return Promise.reject(new Error('Price quarantine is irreversible; use a reviewed forward migration'))
}

exports._meta = { version: 1 }
