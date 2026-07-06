-- ════════════════════════════════════════════════════════════════
-- SATKEN — STEP 0 (base schema, single-tenant, pre-multi-tenancy)
--
-- migration_step1.sql was written as an ADDITIVE migration on top of
-- an already-existing single-tenant schema (inventory_items,
-- unmatched_scans, the 2-arg increment_scan, permissive "anon full
-- access" policies). That base schema was created directly through
-- the Supabase dashboard's table editor on the OLD project and was
-- never captured as SQL anywhere in this repo.
--
-- Run this ONLY when starting from a brand-new, empty Supabase
-- project (no inventory_items / unmatched_scans tables yet). If you
-- already have those tables (e.g. you're migrating the existing
-- project in place), skip straight to migration_step1.sql.
--
-- This reconstructs the base schema by inference from how app.js /
-- auth.js / index.html actually read and write these tables, plus
-- the exact constraint/policy names migration_step1.sql and
-- migration_step2.sql assume exist (e.g. `inventory_items_item_barcode_key`,
-- the policy named "anon full access"). Review before running.
-- ════════════════════════════════════════════════════════════════

-- ── Inventory: one row per catalog item ──
create table inventory_items (
  id uuid primary key default gen_random_uuid(),
  item_name text,
  item_barcode text not null unique,
  available_stock integer,
  scanned_qty integer not null default 0,
  last_scanned_at timestamptz,
  resolved boolean not null default false,
  resolved_note text,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

alter table inventory_items enable row level security;

create policy "anon full access"
  on inventory_items for all
  to anon
  using (true)
  with check (true);

grant select, insert, update, delete on inventory_items to anon;

-- ── Unmatched scans: barcodes scanned that don't match any catalog item ──
create table unmatched_scans (
  id uuid primary key default gen_random_uuid(),
  barcode text not null unique,
  scanned_qty integer not null default 0,
  last_scanned_at timestamptz,
  resolved boolean not null default false,
  resolved_note text,
  resolved_at timestamptz
);

alter table unmatched_scans enable row level security;

create policy "anon full access"
  on unmatched_scans for all
  to anon
  using (true)
  with check (true);

grant select, insert, update, delete on unmatched_scans to anon;

-- Note: the pre-multi-tenancy `increment_scan(text, integer)` function and
-- the original (non-org-scoped) `unmatched_report` view are intentionally
-- NOT recreated here — migration_step1.sql creates the definitive
-- org-scoped versions of both (`drop ... if exists` there tolerates their
-- absence), and the current frontend only ever calls the 3-arg
-- `increment_scan` overload that step1 creates.
