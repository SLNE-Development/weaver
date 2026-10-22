CREATE TABLE "docker_blob" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store" text NOT NULL,
	"digest" text NOT NULL,
	"size" bigint NOT NULL,
	"storage_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "docker_blob_store_digest_uq" UNIQUE("store","digest")
);
--> statement-breakpoint
CREATE TABLE "docker_blob_link" (
	"repository_id" uuid NOT NULL,
	"image" text NOT NULL,
	"blob_id" uuid NOT NULL,
	"digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "docker_blob_link_repository_id_image_digest_pk" PRIMARY KEY("repository_id","image","digest")
);
--> statement-breakpoint
CREATE TABLE "docker_manifest" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"image" text NOT NULL,
	"digest" text NOT NULL,
	"media_type" text NOT NULL,
	"artifact_type" text,
	"subject_digest" text,
	"annotations" jsonb,
	"platforms" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"size" bigint NOT NULL,
	"total_size" bigint NOT NULL,
	"content" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_pulled_at" timestamp with time zone,
	"pull_count" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "docker_manifest_repo_image_digest_uq" UNIQUE("repository_id","image","digest")
);
--> statement-breakpoint
CREATE TABLE "docker_manifest_ref" (
	"manifest_id" uuid NOT NULL,
	"digest" text NOT NULL,
	"kind" text NOT NULL,
	"media_type" text NOT NULL,
	"size" bigint NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "docker_manifest_ref_manifest_id_digest_pk" PRIMARY KEY("manifest_id","digest")
);
--> statement-breakpoint
CREATE TABLE "docker_tag" (
	"repository_id" uuid NOT NULL,
	"image" text NOT NULL,
	"tag" text NOT NULL,
	"manifest_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_pulled_at" timestamp with time zone,
	CONSTRAINT "docker_tag_repository_id_image_tag_pk" PRIMARY KEY("repository_id","image","tag")
);
--> statement-breakpoint
CREATE TABLE "docker_upload" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"image" text NOT NULL,
	"offset" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "docker_blob_link" ADD CONSTRAINT "docker_blob_link_repository_id_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_blob_link" ADD CONSTRAINT "docker_blob_link_blob_id_docker_blob_id_fk" FOREIGN KEY ("blob_id") REFERENCES "public"."docker_blob"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_manifest" ADD CONSTRAINT "docker_manifest_repository_id_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_manifest_ref" ADD CONSTRAINT "docker_manifest_ref_manifest_id_docker_manifest_id_fk" FOREIGN KEY ("manifest_id") REFERENCES "public"."docker_manifest"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_tag" ADD CONSTRAINT "docker_tag_repository_id_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_tag" ADD CONSTRAINT "docker_tag_manifest_id_docker_manifest_id_fk" FOREIGN KEY ("manifest_id") REFERENCES "public"."docker_manifest"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_upload" ADD CONSTRAINT "docker_upload_repository_id_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "docker_blob_link_blob_id_idx" ON "docker_blob_link" USING btree ("blob_id");--> statement-breakpoint
CREATE INDEX "docker_manifest_subject_idx" ON "docker_manifest" USING btree ("repository_id","image","subject_digest");