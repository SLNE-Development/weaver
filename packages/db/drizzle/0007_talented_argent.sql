CREATE TABLE "npm_login_session" (
	"id" text PRIMARY KEY NOT NULL,
	"poll_hash" text NOT NULL,
	"repository_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"user_id" text,
	"token_ciphertext" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "npm_login_session_poll_hash_unique" UNIQUE("poll_hash")
);
--> statement-breakpoint
CREATE TABLE "npm_package" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"name" text NOT NULL,
	"document" jsonb NOT NULL,
	"rev" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "npm_package_repo_name_uq" UNIQUE("repository_id","name")
);
--> statement-breakpoint
ALTER TABLE "npm_login_session" ADD CONSTRAINT "npm_login_session_repository_id_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npm_login_session" ADD CONSTRAINT "npm_login_session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npm_package" ADD CONSTRAINT "npm_package_repository_id_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "npm_login_session_expires_at_idx" ON "npm_login_session" USING btree ("expires_at");