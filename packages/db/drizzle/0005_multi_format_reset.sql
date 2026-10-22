DELETE FROM "apikey";--> statement-breakpoint
DELETE FROM "invite";--> statement-breakpoint
DROP TABLE "api_key_permission";--> statement-breakpoint
DROP TABLE "cleanup_policy";--> statement-breakpoint
DROP TABLE "deleted_release";--> statement-breakpoint
DROP TABLE "dependency";--> statement-breakpoint
DROP TABLE "build_file";--> statement-breakpoint
DROP TABLE "build";--> statement-breakpoint
DROP TABLE "version";--> statement-breakpoint
DROP TABLE "artifact";--> statement-breakpoint
DROP TABLE "repository";--> statement-breakpoint
CREATE TYPE "public"."asset_origin" AS ENUM('hosted', 'cache');--> statement-breakpoint
CREATE TYPE "public"."cache_result" AS ENUM('hit', 'miss', 'bypass', 'stale');--> statement-breakpoint
CREATE TYPE "public"."usage_action" AS ENUM('download', 'upload', 'delete');--> statement-breakpoint
CREATE TYPE "public"."repo_format" AS ENUM('maven', 'npm', 'docker', 'proto');--> statement-breakpoint
CREATE TYPE "public"."repo_kind" AS ENUM('hosted', 'mirror', 'group');--> statement-breakpoint
CREATE TYPE "public"."upstream_auth" AS ENUM('none', 'basic', 'bearer');--> statement-breakpoint
CREATE TABLE "asset" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"component_id" uuid,
	"path" text NOT NULL,
	"store" text NOT NULL,
	"storage_key" text NOT NULL,
	"size" bigint NOT NULL,
	"content_type" text,
	"md5" text NOT NULL,
	"sha1" text NOT NULL,
	"sha256" text NOT NULL,
	"sha512" text NOT NULL,
	"origin" "asset_origin" NOT NULL,
	"expires_at" timestamp with time zone,
	"last_accessed_at" timestamp with time zone,
	"download_count" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_repository_path_uq" UNIQUE("repository_id","path")
);--> statement-breakpoint
CREATE TABLE "component" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"namespace" text DEFAULT '' NOT NULL,
	"name" text NOT NULL,
	"version" text DEFAULT '' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"download_count" bigint DEFAULT 0 NOT NULL,
	"last_downloaded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "component_coordinate_uq" UNIQUE("repository_id","namespace","name","version")
);--> statement-breakpoint
CREATE TABLE "usage_event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"repository_id" uuid,
	"component_id" uuid,
	"path" text NOT NULL,
	"action" "usage_action" NOT NULL,
	"cache" "cache_result",
	"bytes" bigint DEFAULT 0 NOT NULL,
	"user_id" text,
	"api_key_id" text
);--> statement-breakpoint
CREATE TABLE "cleanup_policy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"kind" "cleanup_kind" NOT NULL,
	"value" integer NOT NULL,
	"include_releases" boolean DEFAULT false NOT NULL,
	"group_prefix" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "group_member" (
	"group_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "group_member_group_id_member_id_pk" PRIMARY KEY("group_id","member_id"),
	CONSTRAINT "group_member_position_uq" UNIQUE("group_id","position")
);--> statement-breakpoint
CREATE TABLE "repo_permission" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"api_key_id" text NOT NULL,
	"repository_id" uuid NOT NULL,
	"group_prefix" text,
	"access" "access" NOT NULL
);--> statement-breakpoint
CREATE TABLE "repository" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"format" "repo_format" NOT NULL,
	"kind" "repo_kind" NOT NULL,
	"description" text,
	"visibility" "visibility" DEFAULT 'private' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"docker_root" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repository_name_unique" UNIQUE("name")
);--> statement-breakpoint
CREATE TABLE "repository_upstream" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"url" text NOT NULL,
	"auth_type" "upstream_auth" DEFAULT 'none' NOT NULL,
	"username" text,
	"secret" text,
	CONSTRAINT "repository_upstream_position_uq" UNIQUE("repository_id","position")
);--> statement-breakpoint
CREATE TABLE "proto_artifact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"group" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proto_artifact_repository_group_name_uq" UNIQUE("repository_id","group","name")
);--> statement-breakpoint
CREATE TABLE "proto_build" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"build_number" integer NOT NULL,
	"store" text NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"published_by_user_id" text,
	"published_by_key_id" text,
	"download_count" integer DEFAULT 0 NOT NULL,
	"last_downloaded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proto_build_version_number_uq" UNIQUE("version_id","build_number")
);--> statement-breakpoint
CREATE TABLE "proto_build_file" (
	"build_id" uuid NOT NULL,
	"path" text NOT NULL,
	"content" text NOT NULL,
	CONSTRAINT "proto_build_file_build_id_path_pk" PRIMARY KEY("build_id","path")
);--> statement-breakpoint
CREATE TABLE "proto_deleted_release" (
	"repository_id" uuid NOT NULL,
	"group" text NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"sha256" text NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proto_deleted_release_repository_id_group_name_version_pk" PRIMARY KEY("repository_id","group","name","version")
);--> statement-breakpoint
CREATE TABLE "proto_dependency" (
	"build_id" uuid NOT NULL,
	"dep_group" text NOT NULL,
	"dep_name" text NOT NULL,
	"dep_version" text NOT NULL,
	CONSTRAINT "proto_dependency_build_id_dep_group_dep_name_pk" PRIMARY KEY("build_id","dep_group","dep_name")
);--> statement-breakpoint
CREATE TABLE "proto_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_id" uuid NOT NULL,
	"version" text NOT NULL,
	"is_snapshot" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proto_version_artifact_version_uq" UNIQUE("artifact_id","version")
);--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "asset_repository_id_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "asset_component_id_component_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."component"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "component" ADD CONSTRAINT "component_repository_id_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_event" ADD CONSTRAINT "usage_event_repository_id_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repository"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_event" ADD CONSTRAINT "usage_event_component_id_component_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."component"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cleanup_policy" ADD CONSTRAINT "cleanup_policy_repository_id_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_member" ADD CONSTRAINT "group_member_group_id_repository_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_member" ADD CONSTRAINT "group_member_member_id_repository_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_permission" ADD CONSTRAINT "repo_permission_api_key_id_apikey_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."apikey"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_permission" ADD CONSTRAINT "repo_permission_repository_id_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_upstream" ADD CONSTRAINT "repository_upstream_repository_id_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proto_artifact" ADD CONSTRAINT "proto_artifact_repository_id_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proto_build" ADD CONSTRAINT "proto_build_version_id_proto_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."proto_version"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proto_build_file" ADD CONSTRAINT "proto_build_file_build_id_proto_build_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."proto_build"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proto_deleted_release" ADD CONSTRAINT "proto_deleted_release_repository_id_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proto_dependency" ADD CONSTRAINT "proto_dependency_build_id_proto_build_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."proto_build"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proto_version" ADD CONSTRAINT "proto_version_artifact_id_proto_artifact_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."proto_artifact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_repository_origin_accessed_idx" ON "asset" USING btree ("repository_id","origin","last_accessed_at");--> statement-breakpoint
CREATE INDEX "usage_event_at_idx" ON "usage_event" USING btree ("at");--> statement-breakpoint
CREATE INDEX "usage_event_api_key_at_idx" ON "usage_event" USING btree ("api_key_id","at");--> statement-breakpoint
CREATE INDEX "repo_permission_api_key_id_idx" ON "repo_permission" USING btree ("api_key_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repository_docker_root_uq" ON "repository" USING btree ("docker_root") WHERE "repository"."docker_root";--> statement-breakpoint
CREATE INDEX "proto_dependency_target_idx" ON "proto_dependency" USING btree ("dep_group","dep_name","dep_version");