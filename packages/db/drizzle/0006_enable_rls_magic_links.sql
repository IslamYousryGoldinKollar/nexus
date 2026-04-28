-- Enable RLS on `magic_link_tokens` to close the security advisor's
-- "rls_disabled_in_public" alert. With RLS on and zero policies, only
-- the postgres superuser and roles with BYPASSRLS (i.e. our service-
-- role connection from the Next.js server) can read/write the table.
-- The anon key — should it ever leak — gets DENIED.
--
-- Every other public table already has RLS enabled with zero
-- policies, so this brings magic_link_tokens to parity. Idempotent —
-- calling ENABLE on an already-enabled table is a no-op.
ALTER TABLE "magic_link_tokens" ENABLE ROW LEVEL SECURITY;
