ALTER TABLE "npm_login_session" ADD COLUMN "api_key_id" text;--> statement-breakpoint
ALTER TABLE "npm_login_session" ADD COLUMN "requester_ip" text;--> statement-breakpoint
ALTER TABLE "npm_login_session" ADD COLUMN "requester_user_agent" text;--> statement-breakpoint
ALTER TABLE "npm_login_session" ADD CONSTRAINT "npm_login_session_api_key_id_apikey_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."apikey"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "npm_login_session_requester_ip_idx" ON "npm_login_session" USING btree ("requester_ip");