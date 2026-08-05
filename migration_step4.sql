-- ════════════════════════════════════════════════════════════════
-- SATKEN — STEP 4: Product Scanner & Offers (pricing catalogue)
--
-- ADDITIVE ONLY. This migration creates one new table, its indexes,
-- its RLS policies, an updated_at trigger, and one RPC. It does not
-- alter, drop, or re-policy anything that already exists.
--
-- Safe to run on a live database while the current app is in use.
-- ════════════════════════════════════════════════════════════════

-- ── 4a. Pricing catalogue ──
-- Deliberately separate from inventory_items: that table is wiped by the
-- stock-count upload/reset flow, which would destroy pricing every month.
create table products (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  barcode        text not null,
  item_name      text not null,
  item_code      text,
  mrp            numeric(12,2) not null,
  sale_price     numeric(12,2) not null,
  -- Derived, never authored. GENERATED ... STORED means no client can write
  -- these, so they cannot drift from MRP/Sale Price by any code path.
  savings_amount numeric(12,2) generated always as (mrp - sale_price) stored,
  discount_pct   numeric(5,2)  generated always as (round(((mrp - sale_price) / mrp) * 100, 2)) stored,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint products_org_barcode_key   unique (org_id, barcode),
  -- mrp > 0 also guarantees the discount_pct expression never divides by zero.
  constraint products_mrp_positive      check (mrp > 0),
  constraint products_sale_price_nonneg check (sale_price >= 0),
  constraint products_sale_le_mrp       check (sale_price <= mrp)
);

create index products_org_id_idx on products(org_id);
create index products_org_item_code_idx on products(org_id, item_code);

-- ── 4b. updated_at maintenance (drives "Last Updated" + Recently Updated filter) ──
create or replace function set_products_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger products_set_updated_at
  before update on products
  for each row execute function set_products_updated_at();

-- ── 4c. Row-level security ──
-- Read: any member of the org. Write: owners only. Both gated on billing,
-- matching the pattern used by inventory_items and unmatched_scans.
alter table products enable row level security;

create policy "products_select_member" on products
  for select to authenticated
  using (
    org_id in (select org_id from org_members where user_id = auth.uid())
    and org_is_active(org_id)
  );

create policy "products_insert_owner" on products
  for insert to authenticated
  with check (
    org_id in (select org_id from org_members where user_id = auth.uid() and role = 'owner')
    and org_is_active(org_id)
  );

create policy "products_update_owner" on products
  for update to authenticated
  using (
    org_id in (select org_id from org_members where user_id = auth.uid() and role = 'owner')
    and org_is_active(org_id)
  )
  with check (
    org_id in (select org_id from org_members where user_id = auth.uid() and role = 'owner')
    and org_is_active(org_id)
  );

create policy "products_delete_owner" on products
  for delete to authenticated
  using (
    org_id in (select org_id from org_members where user_id = auth.uid() and role = 'owner')
    and org_is_active(org_id)
  );

grant select, insert, update, delete on products to authenticated;
revoke all on products from anon;

-- ── 4d. Atomic bulk import (consumed in Phase 3) ──
-- SECURITY INVOKER (the default) so the RLS policies above still apply.
-- A PL/pgSQL body runs inside one transaction, so any raise below rolls the
-- entire import back: a 1,500-row file with one bad row changes nothing.
create or replace function import_products(p_org_id uuid, p_rows jsonb, p_mode text)
returns jsonb
language plpgsql
as $$
declare
  v_added   int := 0;
  v_updated int := 0;
  v_removed int := 0;
  v_bad     int := 0;
begin
  if not exists (
    select 1 from org_members
    where user_id = auth.uid() and org_id = p_org_id and role = 'owner'
  ) then
    raise exception 'only the store owner can import products';
  end if;

  if p_mode not in ('upsert','replace') then
    raise exception 'invalid import mode: %', p_mode;
  end if;

  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'rows payload must be a JSON array';
  end if;

  -- Server-side revalidation. The client validates first and shows a friendly
  -- preview; this is the last line of defence against a bypassed UI.
  select count(*) into v_bad from (
    select
      upper(trim(r->>'barcode'))  as barcode,
      trim(r->>'item_name')       as item_name,
      (r->>'mrp')::numeric        as mrp,
      (r->>'sale_price')::numeric as sale_price
    from jsonb_array_elements(p_rows) r
  ) x
  where x.barcode is null or x.barcode = ''
     or x.item_name is null or x.item_name = ''
     or x.mrp is null or x.mrp <= 0
     or x.sale_price is null or x.sale_price < 0
     or x.sale_price > x.mrp;

  if v_bad > 0 then
    raise exception 'import rejected: % row(s) failed validation', v_bad;
  end if;

  select count(*) into v_bad from (
    select upper(trim(r->>'barcode')) as barcode
    from jsonb_array_elements(p_rows) r
    group by 1 having count(*) > 1
  ) d;

  if v_bad > 0 then
    raise exception 'import rejected: % duplicate barcode(s) in file', v_bad;
  end if;

  if p_mode = 'replace' then
    delete from products p
    where p.org_id = p_org_id
      and p.barcode not in (
        select upper(trim(r->>'barcode')) from jsonb_array_elements(p_rows) r
      );
    get diagnostics v_removed = row_count;
  end if;

  with incoming as (
    select
      upper(trim(r->>'barcode'))                    as barcode,
      trim(r->>'item_name')                         as item_name,
      nullif(trim(coalesce(r->>'item_code','')),'') as item_code,
      (r->>'mrp')::numeric                          as mrp,
      (r->>'sale_price')::numeric                   as sale_price
    from jsonb_array_elements(p_rows) r
  ),
  upserted as (
    insert into products (org_id, barcode, item_name, item_code, mrp, sale_price)
    select p_org_id, i.barcode, i.item_name, i.item_code, i.mrp, i.sale_price
    from incoming i
    on conflict (org_id, barcode) do update
      set item_name  = excluded.item_name,
          item_code  = excluded.item_code,
          mrp        = excluded.mrp,
          sale_price = excluded.sale_price
    returning (xmax = 0) as was_insert
  )
  select
    count(*) filter (where was_insert),
    count(*) filter (where not was_insert)
  into v_added, v_updated
  from upserted;

  return jsonb_build_object('added', v_added, 'updated', v_updated, 'removed', v_removed);
end;
$$;

grant execute on function import_products(uuid, jsonb, text) to authenticated;
