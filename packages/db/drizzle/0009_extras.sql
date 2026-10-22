CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
ALTER TYPE "public"."cleanup_kind" ADD VALUE 'keep_last_versions';--> statement-breakpoint
ALTER TYPE "public"."cleanup_kind" ADD VALUE 'delete_untagged_manifests';--> statement-breakpoint
ALTER TYPE "public"."cleanup_kind" ADD VALUE 'keep_last_tags';--> statement-breakpoint
CREATE TABLE "storage_snapshot" (
	"day" date NOT NULL,
	"repository_id" uuid NOT NULL,
	"hosted_bytes" bigint NOT NULL,
	"cache_bytes" bigint NOT NULL,
	"asset_count" bigint NOT NULL,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_snapshot_day_repository_id_pk" PRIMARY KEY("day","repository_id")
);
--> statement-breakpoint
CREATE TABLE "usage_daily" (
	"day" date NOT NULL,
	"repository_id" uuid NOT NULL,
	"namespace" text DEFAULT '' NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"action" "usage_action" NOT NULL,
	"count" bigint NOT NULL,
	"bytes" bigint NOT NULL,
	"cache_hit" bigint DEFAULT 0 NOT NULL,
	"cache_miss" bigint DEFAULT 0 NOT NULL,
	"cache_stale" bigint DEFAULT 0 NOT NULL,
	"cache_bypass" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_daily_day_repository_id_namespace_name_action_pk" PRIMARY KEY("day","repository_id","namespace","name","action")
);
--> statement-breakpoint
CREATE TABLE "usage_daily_token" (
	"day" date NOT NULL,
	"api_key_id" text NOT NULL,
	"user_id" text,
	"repository_id" uuid NOT NULL,
	"action" "usage_action" NOT NULL,
	"count" bigint NOT NULL,
	"bytes" bigint NOT NULL,
	CONSTRAINT "usage_daily_token_day_api_key_id_repository_id_action_pk" PRIMARY KEY("day","api_key_id","repository_id","action")
);
--> statement-breakpoint
ALTER TABLE "component" ADD COLUMN "search_text" text GENERATED ALWAYS AS (btrim(lower(translate(namespace || ' ' || name, ':/', '  ')))) STORED;--> statement-breakpoint
ALTER TABLE "cleanup_policy" ADD COLUMN "pattern" text;--> statement-breakpoint
ALTER TABLE "storage_snapshot" ADD CONSTRAINT "storage_snapshot_repository_id_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_daily" ADD CONSTRAINT "usage_daily_repository_id_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_daily_token" ADD CONSTRAINT "usage_daily_token_repository_id_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "usage_daily_day_idx" ON "usage_daily" USING btree ("day");--> statement-breakpoint
CREATE INDEX "usage_daily_token_key_day_idx" ON "usage_daily_token" USING btree ("api_key_id","day");--> statement-breakpoint
CREATE INDEX "component_search_text_trgm" ON "component" USING gin (search_text gin_trgm_ops);