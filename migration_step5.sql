-- ════════════════════════════════════════════════════════════════
-- SATKEN — STEP 5: widen import_products' numeric pre-check
--
-- FUNCTION REPLACEMENT ONLY. No table, index, policy or trigger is
-- touched. Safe to run on the live database at any time.
--
-- Why: the previous pre-check regex rejected scientific notation
-- ("1.2E+3") and a leading "+", both of which Postgres's own ::numeric
-- cast accepts and which Excel emits for large numbers. Until CSV
-- import shipped nothing called this function, so it never mattered.
-- Now a real spreadsheet export could be rejected as "non-numeric"
-- for a cell that looks perfectly valid.
--
-- Comma-thousands values ("1,299.00") remain rejected on purpose:
-- stripping commas is ambiguous across locales — in much of Europe
-- "1,5" means one-and-a-half — so guessing could corrupt prices.
-- ════════════════════════════════════════════════════════════════

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

  -- Widened: accepts a leading + and scientific notation, matching what
  -- ::numeric itself accepts, so an Excel export is not wrongly rejected.
  if exists (
    select 1 from jsonb_array_elements(p_rows) r
    where (btrim(coalesce(r->>'mrp','')) <> ''
           and btrim(r->>'mrp') !~ '^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$')
       or (btrim(coalesce(r->>'sale_price','')) <> ''
           and btrim(r->>'sale_price') !~ '^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$')
  ) then
    raise exception 'import rejected: one or more rows have a non-numeric MRP or Sale Price';
  end if;

  select count(*) into v_bad from (
    select
      upper(trim(r->>'barcode'))                     as barcode,
      trim(r->>'item_name')                          as item_name,
      nullif(btrim(r->>'mrp'),'')::numeric           as mrp,
      nullif(btrim(r->>'sale_price'),'')::numeric    as sale_price
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
