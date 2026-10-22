CREATE INDEX "docker_manifest_ref_digest_idx" ON "docker_manifest_ref" USING btree ("digest");--> statement-breakpoint
CREATE INDEX "docker_tag_manifest_id_idx" ON "docker_tag" USING btree ("manifest_id");--> statement-breakpoint
CREATE INDEX "docker_upload_updated_at_idx" ON "docker_upload" USING btree ("updated_at");