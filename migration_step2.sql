-- ════════════════════════════════════════════════════════════════
-- SATKEN multi-tenancy migration — STEP 2 (lockdown)
--
-- Run this ONCE, right after you've signed up through the new auth
-- screen for real (creating your own organization). Don't leave a
-- long gap between signup and running this — if a second org gets
-- created before this runs, the blanket backfill below becomes
-- ambiguous about which org the old rows belong to.
--
-- Before running: replace REPLACE_WITH_ORG_ID below with the real
-- org id. Since this should be the only org that exists at this
-- point, you can get it with:
--
--   select id, name, created_at from organizations order by created_at desc;
--
-- ════════════════════════════════════════════════════════════════

-- ── Sanity check first: confirm the permissive policy names before
--    dropping them further down. Expected: "anon full access" on both
--    tables (that's what they were named when originally created).
--    If this returns different names, update section 2d below to match. ──
select tablename, policyname, cmd
from pg_policies
where tablename in ('inventory_items', 'unmatched_scans')
order by tablename, policyname;

-- ── 2a. Backfill existing (pre-multi-tenant) rows to your new org ──
update inventory_items set org_id = 'REPLACE_WITH_ORG_ID' where org_id is null;
update unmatched_scans set org_id = 'REPLACE_WITH_ORG_ID' where org_id is null;

-- ── 2b. Enforce NOT NULL now that every row has an org ──
alter table inventory_items alter column org_id set not null;
alter table unmatched_scans alter column org_id set not null;

-- ── 2c. Swap single-column uniqueness for composite (org_id, barcode) —
--       lets two different stores use the same barcode value without
--       colliding. Also required for the 3-arg increment_scan's
--       ON CONFLICT (org_id, barcode) target from step 1f to work. ──
alter table inventory_items drop constraint inventory_items_item_barcode_key;
alter table inventory_items add constraint inventory_items_org_barcode_key unique (org_id, item_barcode);

alter table unmatched_scans drop constraint unmatched_scans_barcode_key;
alter table unmatched_scans add constraint unmatched_scans_org_barcode_key unique (org_id, barcode);

-- ── 2d. Drop the old permissive policies — THIS is the step that
--       actually enforces isolation. Everything before this point still
--       had the old "using(true)" policy OR'd in, silently granting
--       full access regardless of the new org-scoped policies. ──
drop policy "anon full access" on inventory_items;
drop policy "anon full access" on unmatched_scans;

-- ── 2e. Lock the anon role out entirely; only authenticated (logged-in)
--       requests should ever reach these tables/view now. ──
revoke all on inventory_items from anon;
revoke all on unmatched_scans from anon;
revoke all on unmatched_report from anon;
grant select on unmatched_report to authenticated;

-- ── 2f. Drop the old 2-arg increment_scan overload — the new frontend
--       always calls the 3-arg version from step 1f. ──
drop function if exists increment_scan(text, integer);

-- ── 2g. Verify no orphaned rows remain (should both return 0) ──
select count(*) as orphaned_inventory_items from inventory_items where org_id is null;
select count(*) as orphaned_unmatched_scans from unmatched_scans where org_id is null;
