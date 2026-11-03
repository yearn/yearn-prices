-- Current sql file was generated after introspecting the database
-- If you want to run this migration please uncomment this code before executing migrations
/*
CREATE TABLE "backfill_progress" (
	"token_key" text PRIMARY KEY NOT NULL,
	"done_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "quarantined_token_prices" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"original_row" jsonb NOT NULL,
	"reason" text NOT NULL,
	"quarantined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_underlying_map" (
	"chain" text NOT NULL,
	"vault" text NOT NULL,
	"underlying" text NOT NULL,
	CONSTRAINT "vault_underlying_map_pkey" PRIMARY KEY("vault","chain")
);
--> statement-breakpoint
CREATE TABLE "historical_price_gap_inventory" (
	"chain_id" bigint NOT NULL,
	"token" varchar(60) NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	CONSTRAINT "historical_price_gap_inventory_pkey" PRIMARY KEY("token","timestamp","chain_id"),
	CONSTRAINT "historical_price_gap_inventory_chain_id_check" CHECK (chain_id > 0),
	CONSTRAINT "historical_price_gap_inventory_token_check" CHECK ((token)::text ~ '^0x[0-9a-f]{40}$'::text),
	CONSTRAINT "historical_price_gap_inventory_token_check1" CHECK ((token)::text = lower((token)::text)),
	CONSTRAINT "historical_price_gap_inventory_timestamp_check" CHECK (mod((EXTRACT(epoch FROM "timestamp"))::bigint, (86400)::bigint) = 86399)
);
--> statement-breakpoint
CREATE TABLE "defillama_repair_ratio" (
	"chain" text NOT NULL,
	"token" text NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"ratio" numeric NOT NULL,
	"applied" boolean DEFAULT false NOT NULL,
	CONSTRAINT "defillama_repair_ratio_pkey" PRIMARY KEY("token","timestamp","chain")
);
--> statement-breakpoint
CREATE TABLE "rejected_price_observations" (
	"chain" text NOT NULL,
	"token" text NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "rejected_price_observations_pkey" PRIMARY KEY("token","timestamp","source","chain"),
	CONSTRAINT "rejected_price_observations_token_check" CHECK (token = lower(token))
);
--> statement-breakpoint
CREATE TABLE "token_prices" (
	"chain" varchar(20) NOT NULL,
	"token" varchar(60) NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"price" numeric NOT NULL,
	"symbol" text,
	"confidence" numeric,
	"source" varchar(50) NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "token_prices_pkey" PRIMARY KEY("token","timestamp","source","chain")
);
--> statement-breakpoint
CREATE INDEX "idx_token_prices_range" ON "token_prices" USING btree ("chain" timestamptz_ops,"token" timestamptz_ops,"timestamp" timestamptz_ops);--> statement-breakpoint
*/