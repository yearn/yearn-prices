CREATE TABLE "historical_price_repair_queue" (
	"chain_id" bigint NOT NULL,
	"token" varchar(60) NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_token" text,
	"lease_expires_at" timestamp with time zone,
	"last_outcome" varchar(20),
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "historical_price_repair_queue_pkey" PRIMARY KEY("token","timestamp","chain_id"),
	CONSTRAINT "historical_price_repair_queue_chain_id_check" CHECK (chain_id > 0),
	CONSTRAINT "historical_price_repair_queue_token_check" CHECK ((token)::text ~ '^0x[0-9a-f]{40}$'::text),
	CONSTRAINT "historical_price_repair_queue_token_check1" CHECK ((token)::text = lower((token)::text)),
	CONSTRAINT "historical_price_repair_queue_timestamp_check" CHECK (mod((EXTRACT(epoch FROM "timestamp"))::bigint, (86400)::bigint) = 86399),
	CONSTRAINT "historical_price_repair_queue_attempts_check" CHECK (attempts >= 0),
	CONSTRAINT "historical_price_repair_queue_outcome_check" CHECK (last_outcome IS NULL OR last_outcome IN ('missing', 'retryable', 'invalid'))
);
--> statement-breakpoint
CREATE INDEX "historical_price_repair_queue_due_idx" ON "historical_price_repair_queue" USING btree ("next_attempt_at","updated_at");--> statement-breakpoint
CREATE INDEX "historical_price_repair_queue_lease_idx" ON "historical_price_repair_queue" USING btree ("lease_expires_at");