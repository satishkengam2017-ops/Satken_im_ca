-- ════════════════════════════════════════════════════════════════
-- SATKEN multi-tenancy migration — STEP 1 (additive)
--
-- Safe to run immediately, while the OLD single-tenant frontend is
-- still live. Nothing here removes or restricts existing access —
-- it only ADDS org infrastructure and nullable org_id columns, plus
-- NEW org-scoped RLS policies that sit ALONGSIDE the existing
-- permissive "using(true)" policies (Postgres OR's multiple
-- permissive policies together, so old requests keep working).
--
-- Run STEP 2 only after a real user has signed up through the new
-- auth UI and been assigned an org — see migration_step2.sql.
-- ════════════════════════════════════════════════════════════════

-- ── 1a. Organizations (with forward-compatible billing columns) ──
create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now(),
  -- billing scaffolding — Stripe integration itself is a later pass
  subscription_status text not null default 'trialing'
    check (subscription_status in ('trialing','active','past_due','canceled')),
  trial_ends_at timestamptz not null default (now() + interval '14 days'),
  stripe_customer_id text,
  stripe_subscription_id text
);

alter table organizations enable row level security;

-- ── 1b. Org membership (join table; role gates future staff invites) ──
create table org_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'owner' check (role in ('owner','member')),
  created_at timestamptz not null default now(),
  unique (org_id, user_id)
);

alter table org_members enable row level security;

-- A user can see their own membership row(s) — needed so the frontend
-- can resolve "which org am I in" right after login.
create policy "members_select_own"
  on org_members for select
  to authenticated
  using (user_id = auth.uid());

-- A user can see organizations they belong to.
create policy "orgs_select_member"
  on organizations for select
  to authenticated
  using (id in (select org_id from org_members where user_id = auth.uid()));

-- ── 1c. Nullable org_id on existing tables (NOT NULL comes in step 2,
--       once every row has been backfilled) ──
alter table inventory_items add column org_id uuid references organizations(id);
alter table unmatched_scans add column org_id uuid references organizations(id);

-- ── 1d. Signup RPC — one call from the client creates org + membership ──
create or replace function create_org_for_new_user(org_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_org_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  -- Guard against a stray double-call spawning a second org for the
  -- same user (e.g. a double-submit on the signup form).
  if exists (select 1 from org_members where user_id = auth.uid()) then
    raise exception 'user already belongs to an organization';
  end if;

  insert into organizations (name) values (org_name) returning id into new_org_id;
  insert into org_members (org_id, user_id, role) values (new_org_id, auth.uid(), 'owner');

  return new_org_id;
end;
$$;

grant execute on function create_org_for_new_user(text) to authenticated;

-- ── 1e. New org-scoped policies, ADDED ALONGSIDE the existing
--       permissive "using(true)" policies already on these tables.
--       (Do not drop the old ones here — that happens in step 2,
--       only after real data has been backfilled to a real org.) ──
create policy "inv_items_org_select"
  on inventory_items for select
  to authenticated
  using (org_id in (select org_id from org_members where user_id = auth.uid()));

create policy "inv_items_org_insert"
  on inventory_items for insert
  to authenticated
  with check (org_id in (select org_id from org_members where user_id = auth.uid()));

create policy "inv_items_org_update"
  on inventory_items for update
  to authenticated
  using (org_id in (select org_id from org_members where user_id = auth.uid()));

create policy "inv_items_org_delete"
  on inventory_items for delete
  to authenticated
  using (org_id in (select org_id from org_members where user_id = auth.uid()));

create policy "unmatched_scans_org_select"
  on unmatched_scans for select
  to authenticated
  using (org_id in (select org_id from org_members where user_id = auth.uid()));

create policy "unmatched_scans_org_insert"
  on unmatched_scans for insert
  to authenticated
  with check (org_id in (select org_id from org_members where user_id = auth.uid()));

create policy "unmatched_scans_org_update"
  on unmatched_scans for update
  to authenticated
  using (org_id in (select org_id from org_members where user_id = auth.uid()));

create policy "unmatched_scans_org_delete"
  on unmatched_scans for delete
  to authenticated
  using (org_id in (select org_id from org_members where user_id = auth.uid()));

-- ── 1f. New 3-arg increment_scan overload (org-scoped). The OLD 2-arg
--       overload is left untouched so the still-live old frontend keeps
--       working; it's dropped in step 2 once the new frontend is live
--       everywhere. NOTE: the ON CONFLICT target here is (org_id, barcode),
--       which doesn't exist as a constraint until step 2c runs — this
--       overload will error if called before step 2c. That's fine: the
--       new frontend (which calls this overload) only goes live once you
--       deploy it, and step 2 should be run in the same sitting as your
--       first real signup, before real scanning starts on the new build. ──
create or replace function increment_scan(p_barcode text, p_qty integer, p_org_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  matched_id uuid;
begin
  update inventory_items
    set scanned_qty = scanned_qty + p_qty, last_scanned_at = now()
    where item_barcode = p_barcode and org_id = p_org_id
    returning id into matched_id;

  if matched_id is null then
    insert into unmatched_scans (barcode, scanned_qty, last_scanned_at, org_id)
    values (p_barcode, p_qty, now(), p_org_id)
    on conflict (org_id, barcode) do update
      set scanned_qty = unmatched_scans.scanned_qty + excluded.scanned_qty,
          last_scanned_at = excluded.last_scanned_at;
  end if;
end;
$$;

grant execute on function increment_scan(text, integer, uuid) to authenticated;

-- ── 1g. Recreate unmatched_report with security_invoker=true, so RLS on
--       the base tables actually propagates through the view (Postgres
--       views default to running as the view OWNER, not the querying
--       user, unless security_invoker is set — this is the single
--       highest-risk correctness item in this whole migration). org_id
--       is added to both halves of the UNION ALL so the frontend can
--       also filter on it directly (belt-and-suspenders, not the actual
--       enforcement mechanism — security_invoker + base-table RLS is). ──
drop view if exists unmatched_report;

create view unmatched_report
with (security_invoker = true)
as
select
  id, item_name, item_barcode, available_stock, scanned_qty, last_scanned_at, org_id,
  case when last_scanned_at is null then 'Not scanned yet' else 'Quantity mismatch' end as reason,
  'inventory_items' as source
from inventory_items
where (last_scanned_at is null or scanned_qty <> available_stock) and resolved = false
union all
select
  id, null as item_name, barcode as item_barcode, null as available_stock, scanned_qty, last_scanned_at, org_id,
  'Not in inventory' as reason,
  'unmatched_scans' as source
from unmatched_scans
where resolved = false;

grant select on unmatched_report to authenticated;
