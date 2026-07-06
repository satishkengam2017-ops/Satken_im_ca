-- ════════════════════════════════════════════════════════════════
-- SATKEN migration — STEP 3
-- Adds: staff invites, and real billing enforcement (Razorpay-backed).
--
-- Safe to run as one paste. Nothing here removes access from your
-- currently-working account — it's additive until the final
-- transactional policy swap at the bottom, which is itself atomic
-- (wrapped in begin/commit) so there's no window of broken access.
-- ════════════════════════════════════════════════════════════════

-- ═══ PART A — STAFF INVITES ═══

create table invites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  email text not null,
  invited_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  unique (org_id, email)
);

alter table invites enable row level security;

create policy "invites_select_owner"
  on invites for select
  to authenticated
  using (
    org_id in (select org_id from org_members where user_id = auth.uid() and role = 'owner')
  );

create policy "invites_insert_owner"
  on invites for insert
  to authenticated
  with check (
    org_id in (select org_id from org_members where user_id = auth.uid() and role = 'owner')
  );

create policy "invites_delete_owner"
  on invites for delete
  to authenticated
  using (
    org_id in (select org_id from org_members where user_id = auth.uid() and role = 'owner')
  );

-- Single validated entry point for creating/refreshing an invite —
-- client never inserts into invites directly, so email normalization
-- and the owner-only check always happen in one place.
create or replace function insert_staff_invite(p_org_id uuid, p_email text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_invite_id uuid;
  normalized_email text := lower(trim(p_email));
begin
  if not exists (
    select 1 from org_members
    where user_id = auth.uid() and org_id = p_org_id and role = 'owner'
  ) then
    raise exception 'only the store owner can invite staff';
  end if;

  insert into invites (org_id, email, invited_by)
    values (p_org_id, normalized_email, auth.uid())
    on conflict (org_id, email) do update set accepted_at = null, created_at = now()
    returning id into new_invite_id;

  return new_invite_id;
end;
$$;

grant execute on function insert_staff_invite(uuid, text) to authenticated;

-- Replaces create_org_for_new_user: on signup, join a pending invite
-- (by email, case-insensitive) instead of always creating a new org.
create or replace function accept_invite_or_create_org(org_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_org_id uuid;
  my_email text;
  pending_invite invites%rowtype;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if exists (select 1 from org_members where user_id = auth.uid()) then
    raise exception 'user already belongs to an organization';
  end if;

  select email into my_email from auth.users where id = auth.uid();

  select * into pending_invite
    from invites
    where lower(email) = lower(my_email) and accepted_at is null
    order by created_at asc
    limit 1;

  if found then
    insert into org_members (org_id, user_id, role)
      values (pending_invite.org_id, auth.uid(), 'member');
    update invites set accepted_at = now() where id = pending_invite.id;
    return pending_invite.org_id;
  end if;

  insert into organizations (name) values (org_name) returning id into new_org_id;
  insert into org_members (org_id, user_id, role) values (new_org_id, auth.uid(), 'owner');

  return new_org_id;
end;
$$;

grant execute on function accept_invite_or_create_org(text) to authenticated;

-- Disable the old signup RPC for client calls (not dropped — trivially
-- reversible with a matching `grant execute` if anything still needs it).
revoke execute on function create_org_for_new_user(text) from authenticated;

-- ═══ PART B — BILLING ENFORCEMENT ═══

-- Tracks paid-period expiry separately from the 14-day trial_ends_at.
alter table organizations add column current_period_ends_at timestamptz;

create or replace function org_is_active(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when subscription_status = 'active' and current_period_ends_at > now() then true
    when subscription_status = 'trialing' and trial_ends_at > now() then true
    else false
  end
  from organizations
  where id = p_org_id;
$$;

grant execute on function org_is_active(uuid) to authenticated;

-- ── Run this SELECT first and confirm it returns true for your real
--    (currently trialing or active) org before proceeding — sanity
--    check the function against real data before it gates any policy. ──
-- select org_is_active(id) from organizations;

-- ── Transactional policy swap — atomic, no window of open/closed access. ──
begin;

drop policy "inv_items_org_select" on inventory_items;
create policy "inv_items_org_select" on inventory_items for select to authenticated
  using (org_id in (select org_id from org_members where user_id = auth.uid()) and org_is_active(org_id));

drop policy "inv_items_org_insert" on inventory_items;
create policy "inv_items_org_insert" on inventory_items for insert to authenticated
  with check (org_id in (select org_id from org_members where user_id = auth.uid()) and org_is_active(org_id));

drop policy "inv_items_org_update" on inventory_items;
create policy "inv_items_org_update" on inventory_items for update to authenticated
  using (org_id in (select org_id from org_members where user_id = auth.uid()) and org_is_active(org_id));

drop policy "inv_items_org_delete" on inventory_items;
create policy "inv_items_org_delete" on inventory_items for delete to authenticated
  using (org_id in (select org_id from org_members where user_id = auth.uid()) and org_is_active(org_id));

drop policy "unmatched_scans_org_select" on unmatched_scans;
create policy "unmatched_scans_org_select" on unmatched_scans for select to authenticated
  using (org_id in (select org_id from org_members where user_id = auth.uid()) and org_is_active(org_id));

drop policy "unmatched_scans_org_insert" on unmatched_scans;
create policy "unmatched_scans_org_insert" on unmatched_scans for insert to authenticated
  with check (org_id in (select org_id from org_members where user_id = auth.uid()) and org_is_active(org_id));

drop policy "unmatched_scans_org_update" on unmatched_scans;
create policy "unmatched_scans_org_update" on unmatched_scans for update to authenticated
  using (org_id in (select org_id from org_members where user_id = auth.uid()) and org_is_active(org_id));

drop policy "unmatched_scans_org_delete" on unmatched_scans;
create policy "unmatched_scans_org_delete" on unmatched_scans for delete to authenticated
  using (org_id in (select org_id from org_members where user_id = auth.uid()) and org_is_active(org_id));

commit;

-- ── After running: log in as a normal (trialing) account and confirm
--    reads/writes still work before considering this migration done. ──
