/**
 * Operational constants for the historical price gap backfill.
 *
 * Every value here is provisional until the read-only replay approves it.
 * Final values land in a follow-up commit, before any production `--write`.
 */

export const MANIFEST_VERSION = 1

export const PROVIDER_SEARCH_WIDTH = '6h'

export const MAXIMUM_ACCEPTED_OFFSET_SECONDS = 21_600

export const MAXIMUM_CHART_SPAN_DAYS = 365

export const FINALIZATION_BATCH_SIZE = 100

export const FINALIZATION_LOCK_RETRY_LIMIT = 3

export const MAXIMUM_MANIFEST_BYTES = 8 * 1024 * 1024

export const MAXIMUM_MANIFEST_TARGETS = 200_000

export const EXACT_READ_CHUNK_SIZE = 5_000

export const CHART_REQUEST_TIMEOUT_MS = 30_000

export const CHART_RETRY_AFTER_CAP_MS = 60_000
