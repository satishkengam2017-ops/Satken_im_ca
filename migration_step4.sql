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
  discount_pct   numeric(5,2)  generated always as (round(((mrp - sale_price) / nullif(mrp, 0)) * 100, 2)) stored,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint products_org_barcode_key   unique (org_id, barcode),
  -- Stored generated columns are computed BEFORE check constraints run, so the
  -- nullif(mrp,0) above is what prevents a raw division-by-zero error; this
  -- constraint is what actually rejects the row.
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

-- Normalizes on every write path (RPC, direct insert, direct update) so the
-- unique (org_id, barcode) constraint cannot be defeated by case or whitespace.
create or replace function normalize_product_row()
returns trigger
language plpgsql
as $$
begin
  new.barcode   = upper(trim(new.barcode));
  new.item_name = trim(new.item_name);
  new.item_code = nullif(trim(coalesce(new.item_code,'')),'');
  return new;
end;
$$;

create trigger products_normalize
  before insert or update on products
  for each row execute function normalize_product_row();

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

  if not org_is_active(p_org_id) then
    raise exception 'subscription is not active for this store';
  end if;

  if p_mode not in ('upsert','replace') then
    raise exception 'invalid import mode: %', p_mode;
  end if;

  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'rows payload must be a JSON array';
  end if;

  if p_mode = 'replace' and jsonb_array_length(p_rows) = 0 then
    raise exception 'refusing to replace the catalogue with an empty file';
  end if;

  -- Checked before any cast: a malformed value would otherwise raise a raw
  -- "invalid input syntax for type numeric" before the friendly checks below.
  -- Values are trimmed first so whitespace-padded numbers from a spreadsheet
  -- export (" 19.99 ") stay valid, matching what ::numeric itself accepts.
  -- Empty and absent values deliberately pass this check: they are caught by
  -- the counted per-row validation below, which reports them accurately as
  -- missing rather than as malformed.
  if exists (
    select 1 from jsonb_array_elements(p_rows) r
    where (btrim(coalesce(r->>'mrp','')) <> ''
           and btrim(r->>'mrp') !~ '^-?([0-9]+(\.[0-9]*)?|\.[0-9]+)$')
       or (btrim(coalesce(r->>'sale_price','')) <> ''
           and btrim(r->>'sale_price') !~ '^-?([0-9]+(\.[0-9]*)?|\.[0-9]+)$')
  ) then
    raise exception 'import rejected: one or more rows have a non-numeric MRP or Sale Price';
  end if;

  -- Server-side revalidation. The client validates first and shows a friendly
  -- preview; this is the last line of defence against a bypassed UI.
  select count(*) into v_bad from (
    select
      upper(trim(r->>'barcode'))  as barcode,
      trim(r->>'item_name')       as item_name,
      nullif(btrim(r->>'mrp'),'')::numeric        as mrp,
      nullif(btrim(r->>'sale_price'),'')::numeric as sale_price
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
      nullif(btrim(r->>'mrp'),'')::numeric          as mrp,
      nullif(btrim(r->>'sale_price'),'')::numeric   as sale_price
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
    -- xmax = 0 distinguishes a fresh insert from an ON CONFLICT update. This is
    -- the standard idiom but relies on an internal detail; re-verify it on a
    -- future major-version upgrade.
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
