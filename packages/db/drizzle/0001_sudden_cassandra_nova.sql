CREATE TABLE IF NOT EXISTS "magic_link_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"requested_ip" text,
	"requested_user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "magic_link_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "magic_link_tokens_email_idx" ON "magic_link_tokens" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "magic_link_tokens_expires_idx" ON "magic_link_tokens" USING btree ("expires_at");
--> statement-breakpoint
ALTER TYPE "cost_service" ADD VALUE IF NOT EXISTS 'openai' BEFORE 'openai_whisper';