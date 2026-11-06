-- Tenant isolation: a workspace's data is read and written as the restricted role tenant_app, with
-- the workspace set per transaction (app.workspace_id). It comes first: tables' defaults and policies name it.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'tenant_app') THEN
    CREATE ROLE tenant_app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;--> statement-breakpoint
GRANT tenant_app TO CURRENT_USER;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO tenant_app;--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_workspace_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.workspace_id', true), '')::uuid $$;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_workspace_id() TO tenant_app;--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('connected', 'failing');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'admin', 'member');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jwks" (
	"id" text PRIMARY KEY NOT NULL,
	"public_key" text NOT NULL,
	"private_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"alg" text,
	"crv" text
);
--> statement-breakpoint
CREATE TABLE "oauth_access_token" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text,
	"client_id" text NOT NULL,
	"session_id" text,
	"user_id" text,
	"reference_id" text,
	"authorization_code_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"refresh_id" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone,
	"revoked" timestamp with time zone,
	"confirmation" jsonb,
	"scopes" text[] NOT NULL,
	CONSTRAINT "oauth_access_token_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "oauth_client" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text,
	"client_discovery_id" text,
	"disabled" boolean DEFAULT false,
	"skip_consent" boolean,
	"enable_end_session" boolean,
	"subject_type" text,
	"scopes" text[],
	"client_credentials_scopes" text[],
	"user_id" text,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"name" text,
	"uri" text,
	"icon" text,
	"contacts" text[],
	"tos" text,
	"policy" text,
	"software_id" text,
	"software_version" text,
	"software_statement" text,
	"redirect_uris" text[] NOT NULL,
	"post_logout_redirect_uris" text[],
	"backchannel_logout_uri" text,
	"backchannel_logout_session_required" boolean,
	"token_endpoint_auth_method" text,
	"application_type" text,
	"jwks" text,
	"jwks_uri" text,
	"grant_types" text[],
	"response_types" text[],
	"require_pkce" boolean,
	"dpop_bound_access_tokens" boolean DEFAULT false,
	"reference_id" text,
	"metadata" jsonb,
	CONSTRAINT "oauth_client_clientId_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE "oauth_client_assertion" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_client_resource" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "oauth_consent" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"user_id" text,
	"reference_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "oauth_refresh_token" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"client_id" text NOT NULL,
	"session_id" text,
	"user_id" text NOT NULL,
	"reference_id" text,
	"authorization_code_id" text,
	"resources" text[],
	"requested_user_info_claims" text[],
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone,
	"revoked" timestamp with time zone,
	"rotated_at" timestamp with time zone,
	"rotation_replay_response" text,
	"rotation_replay_expires_at" timestamp with time zone,
	"auth_time" timestamp with time zone,
	"confirmation" jsonb,
	"scopes" text[] NOT NULL,
	CONSTRAINT "oauth_refresh_token_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "oauth_resource" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"name" text NOT NULL,
	"access_token_ttl" integer,
	"refresh_token_ttl" integer,
	"signing_algorithm" text,
	"signing_key_id" text,
	"allowed_scopes" text[],
	"custom_claims" jsonb,
	"dpop_bound_access_tokens_required" boolean DEFAULT false,
	"disabled" boolean DEFAULT false,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"policy_version" integer DEFAULT 1,
	"metadata" jsonb,
	CONSTRAINT "oauth_resource_identifier_unique" UNIQUE("identifier")
);
--> statement-breakpoint
CREATE TABLE "rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limit_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_key" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"scopes" text[] NOT NULL,
	"created_by" text,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_key_keyHash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
ALTER TABLE "api_key" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"status" "connection_status" DEFAULT 'connected' NOT NULL,
	"sealed_credentials" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"connected_by" text,
	"checked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_workspaceId_kind_label_unique" UNIQUE("workspace_id","kind","label")
);
--> statement-breakpoint
ALTER TABLE "connection" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "index_check" (
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"site_id" uuid NOT NULL,
	"page_id" bigint NOT NULL,
	"day" date NOT NULL,
	"verdict" text NOT NULL,
	"coverage" text,
	"last_crawl_at" timestamp with time zone,
	CONSTRAINT "index_check_page_id_day_pk" PRIMARY KEY("page_id","day")
);
--> statement-breakpoint
ALTER TABLE "index_check" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "keyword" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "keyword_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"site_id" uuid NOT NULL,
	"text" text NOT NULL,
	CONSTRAINT "keyword_siteId_text_unique" UNIQUE("site_id","text"),
	CONSTRAINT "keyword_id_workspaceId_unique" UNIQUE("id","workspace_id")
);
--> statement-breakpoint
ALTER TABLE "keyword" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "keyword_day" (
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"site_id" uuid NOT NULL,
	"day" date NOT NULL,
	"keyword_id" bigint NOT NULL,
	"clicks" integer NOT NULL,
	"impressions" integer NOT NULL,
	"position" real NOT NULL,
	CONSTRAINT "keyword_day_site_id_day_keyword_id_pk" PRIMARY KEY("site_id","day","keyword_id")
);
--> statement-breakpoint
ALTER TABLE "keyword_day" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "page" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "page_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"site_id" uuid NOT NULL,
	"url" text NOT NULL,
	"inspected_at" timestamp with time zone,
	CONSTRAINT "page_siteId_url_unique" UNIQUE("site_id","url"),
	CONSTRAINT "page_id_workspaceId_unique" UNIQUE("id","workspace_id")
);
--> statement-breakpoint
ALTER TABLE "page" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "page_day" (
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"site_id" uuid NOT NULL,
	"day" date NOT NULL,
	"page_id" bigint NOT NULL,
	"clicks" integer NOT NULL,
	"impressions" integer NOT NULL,
	"position" real NOT NULL,
	CONSTRAINT "page_day_site_id_day_page_id_pk" PRIMARY KEY("site_id","day","page_id")
);
--> statement-breakpoint
ALTER TABLE "page_day" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "search_day" (
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"site_id" uuid NOT NULL,
	"day" date NOT NULL,
	"engine" text NOT NULL,
	"clicks" integer NOT NULL,
	"impressions" integer NOT NULL,
	"position" real,
	CONSTRAINT "search_day_site_id_day_engine_pk" PRIMARY KEY("site_id","day","engine")
);
--> statement-breakpoint
ALTER TABLE "search_day" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "site" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"name" text NOT NULL,
	"google_property" text,
	"bing_site" text,
	"last_synced_at" timestamp with time zone,
	"last_sync_error" text,
	"last_read_failed" boolean DEFAULT false NOT NULL,
	"google_read_at" timestamp with time zone,
	"bing_read_at" timestamp with time zone,
	"keywords_read_through" date,
	"pages_read_through" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_workspaceId_name_unique" UNIQUE("workspace_id","name"),
	CONSTRAINT "site_id_workspaceId_unique" UNIQUE("id","workspace_id")
);
--> statement-breakpoint
ALTER TABLE "site" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "site_group" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_group_workspaceId_name_unique" UNIQUE("workspace_id","name"),
	CONSTRAINT "site_group_id_workspaceId_unique" UNIQUE("id","workspace_id")
);
--> statement-breakpoint
ALTER TABLE "site_group" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "site_group_member" (
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"group_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	CONSTRAINT "site_group_member_group_id_site_id_pk" PRIMARY KEY("group_id","site_id")
);
--> statement-breakpoint
ALTER TABLE "site_group_member" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sitemap" (
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"site_id" uuid NOT NULL,
	"engine" text NOT NULL,
	"url" text NOT NULL,
	"submitted_at" timestamp with time zone,
	"last_read_at" timestamp with time zone,
	"errors" integer DEFAULT 0 NOT NULL,
	"warnings" integer DEFAULT 0 NOT NULL,
	"urls" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "sitemap_site_id_engine_url_pk" PRIMARY KEY("site_id","engine","url")
);
--> statement-breakpoint
ALTER TABLE "sitemap" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tracked_keyword" (
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"site_id" uuid NOT NULL,
	"keyword_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracked_keyword_site_id_keyword_id_pk" PRIMARY KEY("site_id","keyword_id")
);
--> statement-breakpoint
ALTER TABLE "tracked_keyword" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid DEFAULT app_workspace_id() NOT NULL,
	"email" text NOT NULL,
	"role" "member_role" DEFAULT 'member' NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"invited_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	CONSTRAINT "invitation_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "invitation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "member" (
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" "member_role" DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "member" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "workspace" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "workspace" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_refresh_id_oauth_refresh_token_id_fk" FOREIGN KEY ("refresh_id") REFERENCES "public"."oauth_refresh_token"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD CONSTRAINT "oauth_client_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client_resource" ADD CONSTRAINT "oauth_client_resource_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client_resource" ADD CONSTRAINT "oauth_client_resource_resource_id_oauth_resource_identifier_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."oauth_resource"("identifier") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_connected_by_user_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "index_check" ADD CONSTRAINT "index_check_site_fk" FOREIGN KEY ("site_id","workspace_id") REFERENCES "public"."site"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "index_check" ADD CONSTRAINT "index_check_page_fk" FOREIGN KEY ("page_id","workspace_id") REFERENCES "public"."page"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keyword" ADD CONSTRAINT "keyword_site_fk" FOREIGN KEY ("site_id","workspace_id") REFERENCES "public"."site"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keyword_day" ADD CONSTRAINT "keyword_day_site_fk" FOREIGN KEY ("site_id","workspace_id") REFERENCES "public"."site"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keyword_day" ADD CONSTRAINT "keyword_day_keyword_fk" FOREIGN KEY ("keyword_id","workspace_id") REFERENCES "public"."keyword"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page" ADD CONSTRAINT "page_site_fk" FOREIGN KEY ("site_id","workspace_id") REFERENCES "public"."site"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_day" ADD CONSTRAINT "page_day_site_fk" FOREIGN KEY ("site_id","workspace_id") REFERENCES "public"."site"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_day" ADD CONSTRAINT "page_day_page_fk" FOREIGN KEY ("page_id","workspace_id") REFERENCES "public"."page"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_day" ADD CONSTRAINT "search_day_site_fk" FOREIGN KEY ("site_id","workspace_id") REFERENCES "public"."site"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site" ADD CONSTRAINT "site_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_group" ADD CONSTRAINT "site_group_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_group_member" ADD CONSTRAINT "site_group_member_site_fk" FOREIGN KEY ("site_id","workspace_id") REFERENCES "public"."site"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_group_member" ADD CONSTRAINT "site_group_member_group_fk" FOREIGN KEY ("group_id","workspace_id") REFERENCES "public"."site_group"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sitemap" ADD CONSTRAINT "sitemap_site_fk" FOREIGN KEY ("site_id","workspace_id") REFERENCES "public"."site"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_keyword" ADD CONSTRAINT "tracked_keyword_site_fk" FOREIGN KEY ("site_id","workspace_id") REFERENCES "public"."site"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_keyword" ADD CONSTRAINT "tracked_keyword_keyword_fk" FOREIGN KEY ("keyword_id","workspace_id") REFERENCES "public"."keyword"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_invited_by_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_id_index" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_access_token_user_id_index" ON "oauth_access_token" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_consent_user_id_index" ON "oauth_consent" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_refresh_token_user_id_index" ON "oauth_refresh_token" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_user_id_index" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_index" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "api_key_workspace_id_index" ON "api_key" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "index_check_site_id_day_index" ON "index_check" USING btree ("site_id","day");--> statement-breakpoint
CREATE INDEX "keyword_day_keyword_id_day_index" ON "keyword_day" USING btree ("keyword_id","day");--> statement-breakpoint
CREATE INDEX "page_site_id_inspected_at_index" ON "page" USING btree ("site_id","inspected_at");--> statement-breakpoint
CREATE INDEX "page_day_page_id_day_index" ON "page_day" USING btree ("page_id","day");--> statement-breakpoint
CREATE INDEX "search_day_workspace_id_day_index" ON "search_day" USING btree ("workspace_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "invitation_workspace_id_email_index" ON "invitation" USING btree ("workspace_id","email") WHERE accepted_at is null;--> statement-breakpoint
CREATE INDEX "invitation_email_index" ON "invitation" USING btree ("email");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "api_key" AS PERMISSIVE FOR ALL TO "tenant_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "connection" AS PERMISSIVE FOR ALL TO "tenant_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "index_check" AS PERMISSIVE FOR ALL TO "tenant_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "keyword" AS PERMISSIVE FOR ALL TO "tenant_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "keyword_day" AS PERMISSIVE FOR ALL TO "tenant_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "page" AS PERMISSIVE FOR ALL TO "tenant_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "page_day" AS PERMISSIVE FOR ALL TO "tenant_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "search_day" AS PERMISSIVE FOR ALL TO "tenant_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "site" AS PERMISSIVE FOR ALL TO "tenant_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "site_group" AS PERMISSIVE FOR ALL TO "tenant_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "site_group_member" AS PERMISSIVE FOR ALL TO "tenant_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sitemap" AS PERMISSIVE FOR ALL TO "tenant_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tracked_keyword" AS PERMISSIVE FOR ALL TO "tenant_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "invitation" AS PERMISSIVE FOR ALL TO "tenant_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "member" AS PERMISSIVE FOR ALL TO "tenant_app" USING ("workspace_id" = app_workspace_id()) WITH CHECK ("workspace_id" = app_workspace_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "workspace" AS PERMISSIVE FOR ALL TO "tenant_app" USING ("id" = app_workspace_id()) WITH CHECK ("id" = app_workspace_id());--> statement-breakpoint
-- What the app role may do: read workspaces and memberships (written by the trusted server path
-- only), and read and write a workspace's own rows, behind row-level security. Identity and the
-- assistants' OAuth tables stay with the owner: only Better Auth's trusted path uses them.
GRANT SELECT ON "workspace", "member" TO tenant_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "invitation", "connection", "api_key", "site", "site_group", "site_group_member", "search_day", "keyword", "keyword_day", "page", "page_day", "tracked_keyword", "index_check", "sitemap" TO tenant_app;
