# Phase 1 — Products Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `products` pricing catalogue to the existing SATKEN app — database table, a searchable/filterable product management table, and manual add/edit/delete — without altering any existing behaviour.

**Architecture:** Purely additive. One new SQL migration creates a `products` table (with Discount %/Savings as Postgres generated columns) and an `import_products` RPC. One new browser file, `products.js`, holds all product logic. `index.html` gains one tab, one panel, one modal, one script tag and a block of new CSS classes (all prefixed `pm-` so they cannot collide with existing rules). `auth.js` gains exactly one guarded line. `app.js` and `netlify.toml` are not touched at all.

**Tech Stack:** Vanilla HTML/CSS/JS (no framework, no build step, no npm), Supabase (Postgres + Auth + RLS + RPC), Netlify static hosting.

## Global Constraints

- No new npm dependencies, no build step, no bundler. Third-party code loads by `<script>` tag only.
- `inventory_items`, `unmatched_scans`, `unmatched_report`, `increment_scan`, and the whole stock-counting workflow must not be modified.
- `app.js` must have **zero** changes. `netlify.toml` must have **zero** changes. `auth.js` gets exactly **one** line.
- No second authentication system. Permissions come from the existing `org_members.role` (`'owner'` = Admin, `'member'` = Staff).
- MRP and Sale Price are the only pricing sources of truth. Discount % and Savings Amount are always derived, never authored or hand-entered.
- New CSS classes must be prefixed `pm-`. Do not edit any existing CSS rule except the one new media query specified in Task 3.
- Currency symbol is `$`, defined once as `CURRENCY_SYMBOL` in `products.js`.
- **Deliberate deviation from the request, §25:** the row Actions are Edit and Delete only — there is no separate "View". The table row already displays every field a product has, and the Edit modal shows the same data in editable form, so a read-only View screen would duplicate both. Staff never see this tab at all. Raise this if you want View built as a distinct screen anyway.
- All commits authored as `satishkumarkengam-cpu <kengam4s@gmail.com>`.
- Repo root for all paths: `C:\Users\satis\OneDrive\Desktop\satken_im_ca` (git repo, remote `satishkengam2017-ops/Satken_im_ca`).

---

### Task 1: Database migration

**Files:**
- Create: `migration_step4.sql`

**Interfaces:**
- Consumes: existing `organizations`, `org_members` tables and the existing `org_is_active(uuid)` function (created in `migration_step3.sql`).
- Produces: table `products` with columns `id, org_id, barcode, item_name, item_code, mrp, sale_price, savings_amount, discount_pct, created_at, updated_at`; RPC `import_products(p_org_id uuid, p_rows jsonb, p_mode text) returns jsonb` returning `{"added":n,"updated":n,"removed":n}`. Task 4 and Task 5 query this table; Phase 3 calls this RPC.

The `import_products` RPC is created here, in the same migration, even though it is not called until Phase 3. This is deliberate: it means the user runs **one** migration for the whole feature rather than being asked back to the Supabase SQL editor twice.

- [ ] **Step 1: Create the migration file**

Create `migration_step4.sql`:

```sql
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
```

- [ ] **Step 2: Verify the file has no obvious structural errors**

There is no local Postgres in this environment, so check balance of `$$` delimiters and statement count instead:

```bash
grep -c '^\$\$;$' migration_step4.sql
grep -c 'create policy' migration_step4.sql
```
Expected: `2` (two function bodies closed) and `4` (four RLS policies).

- [ ] **Step 3: Commit**

```bash
git add migration_step4.sql
git -c user.name="satishkumarkengam-cpu" -c user.email="kengam4s@gmail.com" commit -m "Add migration_step4: products pricing catalogue + import RPC"
```

- [ ] **Step 4: USER GATE — run the migration**

This step is performed by the human, not the agent. Surface this instruction and stop until confirmed:

> Open the Supabase dashboard → SQL Editor for project `gkhayphmzopttyasclww`, paste the entire contents of `migration_step4.sql`, and run it. Expected result: "Success. No rows returned." Then confirm so Task 4 can be verified against a real table.

Tasks 2 and 3 do not need the table and may proceed while this is pending. Task 4 cannot be verified without it.

---

### Task 2: Price maths and validation (TDD)

**Files:**
- Create: `products.js`
- Create: `tests/products-pricing.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces, all as browser globals and also exported for Node:
  - `CURRENCY_SYMBOL` → `'$'`
  - `computeSavings(mrp, salePrice)` → `Number` rounded to 2dp, or `null` if either input is not finite
  - `computeDiscountPct(mrp, salePrice)` → `Number` rounded to 2dp, or `null` if inputs not finite or `mrp <= 0`
  - `formatMoney(n)` → `String` like `"$14.99"`, or `"—"` for null/blank/non-numeric
  - `formatDiscount(pct)` → `String` like `"25%"` (whole number), or `"—"` for null
  - `validateProductInput({barcode, itemName, itemCode, mrp, salePrice})` → `{valid: Boolean, errors: [String]}`

Tasks 4 and 5 call all of these. Phase 2 and Phase 3 call them too.

`products.js` must contain **no top-level DOM or Supabase access** — every reference to `document`, `sb` or `currentOrgId` lives inside a function body. This is what lets Node `require()` the file for unit testing. Event wiring uses inline `onclick`/`oninput` attributes in the HTML, matching the existing app's style.

- [ ] **Step 1: Write the failing test**

Create `tests/products-pricing.test.js`:

```javascript
// Plain Node script (no test framework), matching tests/stripe-webhook.test.js.
// Run with: node tests/products-pricing.test.js
var assert = require('assert');
var {
  computeSavings,
  computeDiscountPct,
  formatMoney,
  formatDiscount,
  validateProductInput
} = require('../products.js');

// ── computeSavings ──
assert.strictEqual(computeSavings(19.99, 14.99), 5, 'savings 19.99 -> 14.99 is 5.00');
assert.strictEqual(computeSavings(100, 75), 25, 'savings 100 -> 75 is 25');
assert.strictEqual(computeSavings(5.99, 4.49), 1.5, 'savings 5.99 -> 4.49 is 1.50');
assert.strictEqual(computeSavings(10, 10), 0, 'no discount means zero savings');
assert.strictEqual(computeSavings('abc', 5), null, 'non-numeric mrp yields null');

// ── computeDiscountPct ──
assert.strictEqual(computeDiscountPct(100, 75), 25, '100 -> 75 is 25%');
assert.strictEqual(computeDiscountPct(19.99, 14.99), 25.01, '19.99 -> 14.99 is 25.01%');
assert.strictEqual(computeDiscountPct(9.99, 7.99), 20.02, '9.99 -> 7.99 is 20.02%');
assert.strictEqual(computeDiscountPct(10, 10), 0, 'equal prices is 0%');
assert.strictEqual(computeDiscountPct(0, 5), null, 'zero mrp yields null, never divide by zero');
assert.strictEqual(computeDiscountPct(-5, 1), null, 'negative mrp yields null');

// ── formatting ──
assert.strictEqual(formatMoney(14.99), '$14.99', 'money formats to 2dp with symbol');
assert.strictEqual(formatMoney(5), '$5.00', 'whole numbers get 2dp');
assert.strictEqual(formatMoney(null), '—', 'null money renders as em dash');
assert.strictEqual(formatMoney(''), '—', 'blank money renders as em dash');
assert.strictEqual(formatDiscount(25.01), '25%', 'discount displays as whole number');
assert.strictEqual(formatDiscount(0), '0%', 'zero discount still displays');
assert.strictEqual(formatDiscount(null), '—', 'null discount renders as em dash');

// ── validateProductInput ──
var ok = validateProductInput({barcode:'8901234567890', itemName:'Premium Coffee 500g', itemCode:'COF-500', mrp:'19.99', salePrice:'14.99'});
assert.strictEqual(ok.valid, true, 'a well-formed product is valid');
assert.deepStrictEqual(ok.errors, [], 'a valid product reports no errors');

var noBarcode = validateProductInput({barcode:'', itemName:'X', mrp:'10', salePrice:'5'});
assert.strictEqual(noBarcode.valid, false, 'missing barcode is invalid');
assert.ok(noBarcode.errors.some(function(e){return /Barcode is required/.test(e);}), 'reports missing barcode');

var badBarcode = validateProductInput({barcode:'ABC$%^', itemName:'X', mrp:'10', salePrice:'5'});
assert.strictEqual(badBarcode.valid, false, 'barcode with illegal characters is invalid');

var noName = validateProductInput({barcode:'123456', itemName:'  ', mrp:'10', salePrice:'5'});
assert.strictEqual(noName.valid, false, 'whitespace-only item name is invalid');

var zeroMrp = validateProductInput({barcode:'123456', itemName:'X', mrp:'0', salePrice:'0'});
assert.strictEqual(zeroMrp.valid, false, 'zero MRP is invalid');

var negMrp = validateProductInput({barcode:'123456', itemName:'X', mrp:'-10', salePrice:'5'});
assert.strictEqual(negMrp.valid, false, 'negative MRP is invalid');

var negSale = validateProductInput({barcode:'123456', itemName:'X', mrp:'10', salePrice:'-1'});
assert.strictEqual(negSale.valid, false, 'negative sale price is invalid');

var saleOverMrp = validateProductInput({barcode:'123456', itemName:'X', mrp:'10', salePrice:'12'});
assert.strictEqual(saleOverMrp.valid, false, 'sale price above MRP is invalid');
assert.ok(saleOverMrp.errors.some(function(e){return /cannot be greater than MRP/.test(e);}), 'reports the sale > MRP rule');

var missingPrices = validateProductInput({barcode:'123456', itemName:'X', mrp:'', salePrice:''});
assert.strictEqual(missingPrices.valid, false, 'missing prices are invalid');
assert.strictEqual(missingPrices.errors.length, 2, 'reports both missing MRP and missing Sale Price');

var noItemCode = validateProductInput({barcode:'123456', itemName:'X', itemCode:'', mrp:'10', salePrice:'8'});
assert.strictEqual(noItemCode.valid, true, 'item code is optional');

console.log('products pricing tests passed');
```

- [ ] **Step 2: Run it to verify it fails**

```bash
node tests/products-pricing.test.js
```
Expected: `Error: Cannot find module '../products.js'` — the module does not exist yet.

- [ ] **Step 3: Create products.js with the pure logic**

Create `products.js`:

```javascript
/* ══════════════════════════════════════════════════════════════
   PRODUCT SCANNER & OFFERS — pricing catalogue module.

   Add-on to the existing app. Deliberately contains no top-level
   DOM or Supabase access so it can be require()'d by Node for unit
   testing; all wiring is via inline onclick/oninput in index.html,
   matching the existing app's style.
   ══════════════════════════════════════════════════════════════ */

var CURRENCY_SYMBOL='$';

// Intentionally mirrors BARCODE_RE in app.js. Kept as its own constant so
// this module stays independently loadable and unit-testable rather than
// depending on app.js script order.
var PRODUCT_BARCODE_RE=/^[A-Za-z0-9\-\.\ ]+$/;

/* ── PRICE MATHS ──
   MRP and Sale Price are the only sources of truth. These mirror the
   generated columns in migration_step4.sql, so client and server agree. */

function computeSavings(mrp, salePrice){
  var m=Number(mrp), s=Number(salePrice);
  if(!isFinite(m)||!isFinite(s))return null;
  return Math.round((m-s)*100)/100;
}

function computeDiscountPct(mrp, salePrice){
  var m=Number(mrp), s=Number(salePrice);
  if(!isFinite(m)||!isFinite(s)||m<=0)return null;
  return Math.round(((m-s)/m)*10000)/100;
}

function formatMoney(n){
  if(n===null||n===undefined||n==='')return '—';
  var v=Number(n);
  if(!isFinite(v))return '—';
  return CURRENCY_SYMBOL+v.toFixed(2);
}

function formatDiscount(pct){
  if(pct===null||pct===undefined||pct==='')return '—';
  var v=Number(pct);
  if(!isFinite(v))return '—';
  return Math.round(v)+'%';
}

/* ── VALIDATION ──
   Mirrors the CHECK constraints in migration_step4.sql so the user sees a
   readable inline message instead of a raw Postgres constraint error. */

function validateProductInput(input){
  input=input||{};
  var errors=[];

  var barcode=String(input.barcode||'').trim().toUpperCase();
  var itemName=String(input.itemName||'').trim();
  var mrpRaw=String(input.mrp===undefined||input.mrp===null?'':input.mrp).trim();
  var saleRaw=String(input.salePrice===undefined||input.salePrice===null?'':input.salePrice).trim();

  if(!barcode)errors.push('Barcode is required.');
  else if(!PRODUCT_BARCODE_RE.test(barcode))errors.push('Barcode may contain only letters, numbers, "-", "." and spaces.');

  if(!itemName)errors.push('Item Name is required.');

  var mrp=Number(mrpRaw), sale=Number(saleRaw);
  var mrpOk=false, saleOk=false;

  if(mrpRaw==='')errors.push('MRP is required.');
  else if(!isFinite(mrp))errors.push('MRP must be a number.');
  else if(mrp<=0)errors.push('MRP must be greater than 0.');
  else mrpOk=true;

  if(saleRaw==='')errors.push('Sale Price is required.');
  else if(!isFinite(sale))errors.push('Sale Price must be a number.');
  else if(sale<0)errors.push('Sale Price cannot be negative.');
  else saleOk=true;

  if(mrpOk&&saleOk&&sale>mrp)errors.push('Sale Price cannot be greater than MRP.');

  return {valid:errors.length===0, errors:errors};
}

/* Node export shim — inert in the browser, where `module` is undefined. */
if(typeof module!=='undefined'&&module.exports){
  module.exports={
    CURRENCY_SYMBOL:CURRENCY_SYMBOL,
    computeSavings:computeSavings,
    computeDiscountPct:computeDiscountPct,
    formatMoney:formatMoney,
    formatDiscount:formatDiscount,
    validateProductInput:validateProductInput
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node tests/products-pricing.test.js
```
Expected: `products pricing tests passed`

- [ ] **Step 5: Confirm the existing test suite still passes**

```bash
node tests/stripe-webhook.test.js
```
Expected: `stripe-webhook signature tests passed`

- [ ] **Step 6: Commit**

```bash
git add products.js tests/products-pricing.test.js
git -c user.name="satishkumarkengam-cpu" -c user.email="kengam4s@gmail.com" commit -m "Add product price maths and validation with unit tests"
```

---

### Task 3: Wire the Products tab into the existing shell

**Files:**
- Modify: `index.html` (tab bar, new panel, new CSS block, new script tag)
- Modify: `auth.js` (one line inside `resolveOrgAndEnterApp()`)
- Modify: `products.js` (append `applyFeaturePermissions`)

**Interfaces:**
- Consumes: `computeSavings`, `computeDiscountPct` (Task 2) are already loaded; existing globals `currentUserRole`, `switchTab(name)`.
- Produces: DOM ids `tab-btn-products`, `tab-products`, `pm-search`, `pm-filter-chips`, `pm-tbody`, `pm-summary`, `pm-pager`, `pm-empty`; global `applyFeaturePermissions()`. Task 4 renders into `pm-tbody`/`pm-summary`/`pm-pager`/`pm-empty`; Task 5 adds the modal.

`app.js` is **not** edited: the new tab button calls `switchTab('products'); loadProducts()` inline, reusing the existing tab machinery.

- [ ] **Step 1: Add the Products tab button**

In `index.html`, find the tab bar and add one button after the Report button.

```
OLD:     <button class="tab-btn" data-tab="unmatched" onclick="switchTab('unmatched')">Report <span class="tab-badge" id="unmatched-badge" style="display:none">0</span></button>
  </div>
NEW:     <button class="tab-btn" data-tab="unmatched" onclick="switchTab('unmatched')">Report <span class="tab-badge" id="unmatched-badge" style="display:none">0</span></button>
    <button class="tab-btn" data-tab="products" id="tab-btn-products" style="display:none" onclick="switchTab('products'); loadProducts()">Products</button>
  </div>
```

It starts hidden; `applyFeaturePermissions()` reveals it for owners.

- [ ] **Step 2: Add the Products panel**

In `index.html`, add a new panel immediately after the closing `</div>` of the unmatched tab panel and immediately before `</main>`.

```
OLD:       <div id="unmatched-list">
        <div class="empty-state">
          <svg viewBox="0 0 24 24"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
          Open this tab to load the report
        </div>
      </div>
    </div>

  </main>
NEW:       <div id="unmatched-list">
        <div class="empty-state">
          <svg viewBox="0 0 24 24"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
          Open this tab to load the report
        </div>
      </div>
    </div>

    <!-- ══════════ PRODUCTS TAB ══════════ -->
    <div class="tab-panel" id="tab-products">
      <div class="section-header">
        <h2>Product Catalogue</h2>
        <button class="refresh-btn" onclick="openProductModal()">
          <svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Add Product
        </button>
      </div>

      <input class="manual-input pm-search" id="pm-search" type="text"
             placeholder="Search barcode, item name or item code"
             oninput="onProductSearchInput()">

      <div class="pm-filters" id="pm-filter-chips">
        <button class="pm-chip active" data-filter="all" onclick="setProductFilter('all')">All</button>
        <button class="pm-chip" data-filter="onsale" onclick="setProductFilter('onsale')">On Sale</button>
        <button class="pm-chip" data-filter="nodiscount" onclick="setProductFilter('nodiscount')">No Discount</button>
        <button class="pm-chip" data-filter="high" onclick="setProductFilter('high')">High Discount</button>
        <button class="pm-chip" data-filter="recent" onclick="setProductFilter('recent')">Recently Updated</button>
      </div>

      <div class="pm-summary" id="pm-summary">Open this tab to load your products</div>

      <div class="pm-table-wrap">
        <table class="pm-table">
          <thead>
            <tr>
              <th>Barcode</th><th>Item Name</th><th>Item Code</th>
              <th>MRP</th><th>Sale Price</th><th>Discount</th><th>Savings</th>
              <th>Last Updated</th><th>Actions</th>
            </tr>
          </thead>
          <tbody id="pm-tbody"></tbody>
        </table>
      </div>

      <div class="pm-empty" id="pm-empty" style="display:none"></div>

      <div class="pm-pager" id="pm-pager" style="display:none">
        <button class="btn btn-outline" id="pm-prev" onclick="productsPrevPage()">Previous</button>
        <span class="pm-pageinfo" id="pm-pageinfo"></span>
        <button class="btn btn-outline" id="pm-next" onclick="productsNextPage()">Next</button>
      </div>
    </div>

  </main>
```

- [ ] **Step 3: Add the new CSS**

In `index.html`, insert this block immediately before the closing `</style>` tag. Every class is `pm-`-prefixed except the one media query, which is the only change to existing styling.

```
OLD:   .password-eye svg { width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:1.8; }
</style>
NEW:   .password-eye svg { width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:1.8; }

  /* ── PRODUCT MANAGEMENT (add-on module) ── */
  .pm-search { width:100%; margin-bottom:10px; }
  .pm-filters { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:12px; }
  .pm-chip { font-family:'Cormorant Garamond',serif; font-size:15px; font-weight:600; padding:5px 12px; border-radius:20px; cursor:pointer; white-space:nowrap; background:rgba(139,94,52,0.08); color:var(--gold); border:1px solid var(--input-border); }
  .pm-chip.active { background:var(--gold); color:#FFF8E7; border-color:var(--gold); }
  .pm-summary { font-size:16px; color:var(--muted); margin-bottom:10px; }
  .pm-table-wrap { overflow-x:auto; border:1px solid var(--border-soft); border-radius:12px; background:var(--surface); margin-bottom:12px; }
  .pm-table { width:100%; border-collapse:collapse; font-size:15px; }
  .pm-table th { text-align:left; white-space:nowrap; padding:10px 12px; font-family:'Cinzel',serif; font-size:12px; letter-spacing:1px; text-transform:uppercase; color:var(--muted); border-bottom:1px solid var(--border-soft); }
  .pm-table td { padding:10px 12px; border-bottom:1px solid var(--border-soft); color:var(--text); white-space:nowrap; }
  .pm-table tr:last-child td { border-bottom:none; }
  .pm-mono { font-family:'JetBrains Mono',monospace; font-size:14px; }
  .pm-strike { color:var(--dim); text-decoration:line-through; }
  .pm-sale { font-weight:700; color:var(--gold); }
  .pm-badge { display:inline-block; font-size:13px; font-weight:700; padding:2px 8px; border-radius:20px; background:var(--green-light); color:var(--green); }
  .pm-badge.zero { background:rgba(0,0,0,0.06); color:var(--dim); }
  .pm-act { background:none; border:none; cursor:pointer; color:var(--gold); font-family:'Cormorant Garamond',serif; font-size:15px; font-weight:600; text-decoration:underline; padding:0 6px; }
  .pm-act.danger { color:var(--red); }
  .pm-empty { padding:32px 20px; text-align:center; color:var(--muted); font-size:18px; border:1px dashed var(--border); border-radius:12px; margin-bottom:12px; }
  .pm-pager { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:20px; }
  .pm-pageinfo { font-size:16px; color:var(--muted); }
  .pm-form-row { margin-bottom:10px; }
  .pm-label { display:block; font-size:15px; color:var(--muted); margin-bottom:4px; }
  .pm-calc { display:flex; gap:16px; padding:10px 12px; border-radius:10px; background:rgba(139,94,52,0.08); margin:4px 0 14px; font-size:16px; }
  .pm-calc b { color:var(--gold); }
  .pm-error { color:var(--red); font-size:16px; margin-bottom:10px; display:none; }

  /* Five tabs no longer fit a narrow phone at the base type size. */
  @media (max-width:480px){
    .tab-btn { font-size:12px; letter-spacing:0.3px; padding:12px 4px; }
  }
</style>
```

- [ ] **Step 4: Load the module**

In `index.html`, add the script tag after `app.js` so `products.js` can rely on everything already defined.

```
OLD: <script src="auth.js"></script>
<script src="app.js"></script>
NEW: <script src="auth.js"></script>
<script src="app.js"></script>
<script src="products.js"></script>
```

- [ ] **Step 5: Add the permission hook to auth.js**

Exactly one line, guarded so a failed module load cannot break login.

```
OLD:   applyBranding();
  applySubscribeVisibility();
NEW:   applyBranding();
  applySubscribeVisibility();
  if(typeof applyFeaturePermissions==='function')applyFeaturePermissions();
```

- [ ] **Step 6: Implement applyFeaturePermissions in products.js**

Append to `products.js`, immediately **before** the Node export shim (the shim must stay last):

```javascript
/* ── PERMISSIONS ──
   Admin = existing 'owner' role, Staff = existing 'member' role. The
   database enforces this too (see products RLS in migration_step4.sql);
   this only keeps the UI honest. */

function isProductAdmin(){
  return typeof currentUserRole!=='undefined'&&currentUserRole==='owner';
}

function applyFeaturePermissions(){
  var btn=document.getElementById('tab-btn-products');
  if(btn)btn.style.display=isProductAdmin()?'':'none';
}
```

- [ ] **Step 7: Verify the module still loads in Node**

`applyFeaturePermissions` references `document`, but only inside a function body, so requiring the file must still work.

```bash
node tests/products-pricing.test.js
```
Expected: `products pricing tests passed`

- [ ] **Step 8: Verify the page serves and the wiring is present**

```bash
npx -y serve -l 5959 . > ./tmp_serve.log 2>&1 &
sleep 3
curl -s http://localhost:5959/ -o ./tmp_page.html
grep -c 'id="tab-btn-products"' ./tmp_page.html
grep -c 'id="tab-products"' ./tmp_page.html
grep -c 'products.js' ./tmp_page.html
grep -c 'max-width:480px' ./tmp_page.html
curl -s http://localhost:5959/products.js | grep -c 'applyFeaturePermissions'
kill %1
rm -f ./tmp_page.html ./tmp_serve.log
```
Expected: each `grep -c` prints `1` or more.

- [ ] **Step 9: Commit**

```bash
git add index.html auth.js products.js
git -c user.name="satishkumarkengam-cpu" -c user.email="kengam4s@gmail.com" commit -m "Wire Products tab, panel and permissions into the existing shell"
```

---

### Task 4: Product list — query, render, search, filter, paging

**Files:**
- Modify: `products.js` (append list logic before the Node export shim)

**Interfaces:**
- Consumes: `formatMoney`, `formatDiscount`, `isProductAdmin` (Tasks 2–3); existing globals `sb`, `currentOrgId`, `escapeHtml` (from `app.js`); DOM ids from Task 3.
- Produces: `loadProducts()`, `onProductSearchInput()`, `setProductFilter(name)`, `productsPrevPage()`, `productsNextPage()`. Task 5 calls `loadProducts()` to refresh after a write.

- [ ] **Step 1: Append the list logic to products.js**

Insert immediately **before** the Node export shim:

```javascript
/* ── PRODUCT LIST ── */

var PRODUCTS_PAGE_SIZE=100;
var HIGH_DISCOUNT_PCT=25;
var RECENT_DAYS=30;

var productsState={page:0, search:'', filter:'all', total:0, rows:[]};
var productSearchTimer=null;

function buildProductsQuery(){
  var q=sb.from('products').select('*',{count:'exact'}).eq('org_id',currentOrgId);

  var term=productsState.search.trim();
  if(term){
    // PostgREST's or() filter is comma/parenthesis delimited, so strip those
    // characters rather than letting them corrupt the filter expression.
    var safe=term.replace(/[%,()]/g,' ').trim();
    if(safe){
      q=q.or('barcode.ilike.%'+safe+'%,item_name.ilike.%'+safe+'%,item_code.ilike.%'+safe+'%');
    }
  }

  if(productsState.filter==='onsale')q=q.gt('discount_pct',0);
  else if(productsState.filter==='nodiscount')q=q.eq('discount_pct',0);
  else if(productsState.filter==='high')q=q.gte('discount_pct',HIGH_DISCOUNT_PCT);
  else if(productsState.filter==='recent'){
    q=q.gte('updated_at',new Date(Date.now()-RECENT_DAYS*86400000).toISOString());
  }

  var from=productsState.page*PRODUCTS_PAGE_SIZE;
  return q.order('item_name',{ascending:true}).range(from,from+PRODUCTS_PAGE_SIZE-1);
}

async function loadProducts(){
  var tbody=document.getElementById('pm-tbody');
  var summary=document.getElementById('pm-summary');
  var empty=document.getElementById('pm-empty');
  var pager=document.getElementById('pm-pager');
  if(!tbody)return;

  summary.textContent='Loading…';
  tbody.innerHTML='';
  empty.style.display='none';
  pager.style.display='none';

  var res=await buildProductsQuery();
  if(res.error){
    summary.textContent='';
    empty.style.display='';
    empty.textContent='Could not load products: '+res.error.message;
    return;
  }

  var rows=res.data||[];
  // Cached so deleteProduct() can show a product's real name without having
  // to round-trip HTML-escaped text back out of an onclick attribute.
  productsState.rows=rows;
  productsState.total=res.count||0;

  if(!productsState.total){
    summary.textContent='';
    empty.style.display='';
    empty.textContent=(productsState.search||productsState.filter!=='all')
      ? 'No products match this search or filter.'
      : 'No products yet. Use Add Product to create one.';
    return;
  }

  var first=productsState.page*PRODUCTS_PAGE_SIZE+1;
  var last=Math.min(first+rows.length-1, productsState.total);
  summary.textContent='Showing '+first+'–'+last+' of '+productsState.total+' product'+(productsState.total===1?'':'s');

  tbody.innerHTML=rows.map(renderProductRow).join('');

  var pages=Math.ceil(productsState.total/PRODUCTS_PAGE_SIZE);
  if(pages>1){
    pager.style.display='';
    document.getElementById('pm-pageinfo').textContent='Page '+(productsState.page+1)+' of '+pages;
    document.getElementById('pm-prev').disabled=productsState.page===0;
    document.getElementById('pm-next').disabled=productsState.page>=pages-1;
  }
}

function renderProductRow(p){
  var admin=isProductAdmin();
  var zero=!Number(p.discount_pct);
  var updated=p.updated_at?new Date(p.updated_at).toLocaleDateString():'—';
  return '<tr>'+
    '<td class="pm-mono">'+escapeHtml(p.barcode)+'</td>'+
    '<td>'+escapeHtml(p.item_name)+'</td>'+
    '<td class="pm-mono">'+escapeHtml(p.item_code||'—')+'</td>'+
    '<td class="pm-strike">'+formatMoney(p.mrp)+'</td>'+
    '<td class="pm-sale">'+formatMoney(p.sale_price)+'</td>'+
    '<td><span class="pm-badge'+(zero?' zero':'')+'">'+formatDiscount(p.discount_pct)+'</span></td>'+
    '<td>'+formatMoney(p.savings_amount)+'</td>'+
    '<td>'+escapeHtml(updated)+'</td>'+
    '<td>'+(admin
      ? '<button class="pm-act" onclick="openProductModal(\''+escapeHtml(p.id)+'\')">Edit</button>'+
        '<button class="pm-act danger" onclick="deleteProduct(\''+escapeHtml(p.id)+'\')">Delete</button>'
      : '—')+'</td>'+
  '</tr>';
}

function onProductSearchInput(){
  // Debounced so typing does not fire a query per keystroke.
  if(productSearchTimer)clearTimeout(productSearchTimer);
  productSearchTimer=setTimeout(function(){
    productsState.search=document.getElementById('pm-search').value;
    productsState.page=0;
    loadProducts();
  },300);
}

function setProductFilter(name){
  productsState.filter=name;
  productsState.page=0;
  document.querySelectorAll('#pm-filter-chips .pm-chip').forEach(function(el){
    el.classList.toggle('active', el.getAttribute('data-filter')===name);
  });
  loadProducts();
}

function productsPrevPage(){
  if(productsState.page===0)return;
  productsState.page--;
  loadProducts();
}

function productsNextPage(){
  if((productsState.page+1)*PRODUCTS_PAGE_SIZE>=productsState.total)return;
  productsState.page++;
  loadProducts();
}
```

- [ ] **Step 2: Verify Node still loads the module**

```bash
node tests/products-pricing.test.js
```
Expected: `products pricing tests passed`

- [ ] **Step 3: Verify the page still serves cleanly**

```bash
npx -y serve -l 5959 . > ./tmp_serve.log 2>&1 &
sleep 3
curl -s http://localhost:5959/products.js | grep -c 'function loadProducts'
kill %1
rm -f ./tmp_serve.log
```
Expected: `1`

- [ ] **Step 4: Commit**

```bash
git add products.js
git -c user.name="satishkumarkengam-cpu" -c user.email="kengam4s@gmail.com" commit -m "Add product list with search, filters and paging"
```

---

### Task 5: Add, edit and delete a product

**Files:**
- Modify: `index.html` (add the product modal)
- Modify: `products.js` (append modal logic before the Node export shim)

**Interfaces:**
- Consumes: `validateProductInput`, `computeSavings`, `computeDiscountPct`, `formatMoney`, `formatDiscount`, `isProductAdmin`, `loadProducts` (Tasks 2–4); existing globals `sb`, `currentOrgId`.
- Produces: `openProductModal(id)`, `closeProductModal(e)`, `onProductPriceInput()`, `saveProduct()`, `deleteProduct(id)`. Phase 2's "Add Product" button on the not-found screen calls `openProductModal(null, barcode)`.

- [ ] **Step 1: Add the modal markup**

In `index.html`, add this immediately after the existing reset modal's closing `</div>` and before the closing `</div>` of `#app-shell`.

```
OLD:   <div class="modal-bg" id="reset-modal" onclick="closeResetModal(event)">
    <div class="modal">
      <h3>Clear local scan list?</h3>
      <p>This clears the "Scanned This Session" list on this device only. It does not undo counts already synced to the inventory.</p>
      <div class="modal-btns">
        <button class="btn btn-outline" onclick="closeResetModal()">Cancel</button>
        <button class="btn btn-red" onclick="confirmReset()">
          <svg viewBox="0 0 24 24"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.5"/></svg>
          Yes, Clear
        </button>
      </div>
    </div>
  </div>

</div>
NEW:   <div class="modal-bg" id="reset-modal" onclick="closeResetModal(event)">
    <div class="modal">
      <h3>Clear local scan list?</h3>
      <p>This clears the "Scanned This Session" list on this device only. It does not undo counts already synced to the inventory.</p>
      <div class="modal-btns">
        <button class="btn btn-outline" onclick="closeResetModal()">Cancel</button>
        <button class="btn btn-red" onclick="confirmReset()">
          <svg viewBox="0 0 24 24"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.5"/></svg>
          Yes, Clear
        </button>
      </div>
    </div>
  </div>

  <div class="modal-bg" id="pm-modal" onclick="closeProductModal(event)">
    <div class="modal">
      <h3 id="pm-modal-title">Add Product</h3>
      <div class="pm-error" id="pm-modal-error"></div>

      <div class="pm-form-row">
        <label class="pm-label" for="pm-f-barcode">Barcode</label>
        <input class="manual-input" id="pm-f-barcode" type="text" style="width:100%" placeholder="8901234567890">
      </div>
      <div class="pm-form-row">
        <label class="pm-label" for="pm-f-name">Item Name</label>
        <input class="manual-input" id="pm-f-name" type="text" style="width:100%" placeholder="Premium Coffee 500g">
      </div>
      <div class="pm-form-row">
        <label class="pm-label" for="pm-f-code">Item Code <span style="opacity:0.7">(optional)</span></label>
        <input class="manual-input" id="pm-f-code" type="text" style="width:100%" placeholder="COF-500">
      </div>
      <div class="pm-form-row">
        <label class="pm-label" for="pm-f-mrp">MRP</label>
        <input class="manual-input" id="pm-f-mrp" type="number" inputmode="decimal" min="0" step="0.01" style="width:100%" placeholder="19.99" oninput="onProductPriceInput()">
      </div>
      <div class="pm-form-row">
        <label class="pm-label" for="pm-f-sale">Sale Price</label>
        <input class="manual-input" id="pm-f-sale" type="number" inputmode="decimal" min="0" step="0.01" style="width:100%" placeholder="14.99" oninput="onProductPriceInput()">
      </div>

      <div class="pm-calc">
        <span>Discount: <b id="pm-calc-discount">—</b></span>
        <span>Savings: <b id="pm-calc-savings">—</b></span>
      </div>

      <div class="modal-btns">
        <button class="btn btn-outline" onclick="closeProductModal()">Cancel</button>
        <button class="btn btn-gold" id="pm-save-btn" onclick="saveProduct()">Save Product</button>
      </div>
    </div>
  </div>

</div>
```

- [ ] **Step 2: Append the modal logic to products.js**

Insert immediately **before** the Node export shim:

```javascript
/* ── ADD / EDIT / DELETE ── */

var editingProductId=null;

function openProductModal(id, prefillBarcode){
  if(!isProductAdmin()){ alert('Only the store owner can add or edit products.'); return; }

  editingProductId=id||null;
  document.getElementById('pm-modal-title').textContent=editingProductId?'Edit Product':'Add Product';
  showProductModalError('');

  var bc=document.getElementById('pm-f-barcode');
  var nm=document.getElementById('pm-f-name');
  var cd=document.getElementById('pm-f-code');
  var mp=document.getElementById('pm-f-mrp');
  var sp=document.getElementById('pm-f-sale');

  bc.value=prefillBarcode||''; nm.value=''; cd.value=''; mp.value=''; sp.value='';
  onProductPriceInput();
  document.getElementById('pm-modal').classList.add('open');

  if(editingProductId){
    sb.from('products').select('*').eq('id',editingProductId).eq('org_id',currentOrgId).single()
      .then(function(res){
        if(res.error||!res.data){ showProductModalError('Could not load this product: '+(res.error?res.error.message:'not found')); return; }
        bc.value=res.data.barcode||'';
        nm.value=res.data.item_name||'';
        cd.value=res.data.item_code||'';
        mp.value=res.data.mrp;
        sp.value=res.data.sale_price;
        onProductPriceInput();
      });
  } else {
    bc.focus();
  }
}

function closeProductModal(e){
  if(e&&e.target!==document.getElementById('pm-modal'))return;
  document.getElementById('pm-modal').classList.remove('open');
  editingProductId=null;
}

function showProductModalError(msg){
  var el=document.getElementById('pm-modal-error');
  el.textContent=msg||'';
  el.style.display=msg?'block':'none';
}

function onProductPriceInput(){
  var mrp=document.getElementById('pm-f-mrp').value;
  var sale=document.getElementById('pm-f-sale').value;
  var pct=computeDiscountPct(mrp,sale);
  var save=computeSavings(mrp,sale);
  // Never show a fabricated discount: if the pair is invalid, show nothing.
  var valid=(pct!==null&&save!==null&&save>=0);
  document.getElementById('pm-calc-discount').textContent=valid?formatDiscount(pct):'—';
  document.getElementById('pm-calc-savings').textContent=valid?formatMoney(save):'—';
}

async function saveProduct(){
  var input={
    barcode:document.getElementById('pm-f-barcode').value,
    itemName:document.getElementById('pm-f-name').value,
    itemCode:document.getElementById('pm-f-code').value,
    mrp:document.getElementById('pm-f-mrp').value,
    salePrice:document.getElementById('pm-f-sale').value
  };

  var check=validateProductInput(input);
  if(!check.valid){ showProductModalError(check.errors.join(' ')); return; }

  var btn=document.getElementById('pm-save-btn');
  btn.disabled=true;
  showProductModalError('');

  var record={
    org_id:currentOrgId,
    barcode:String(input.barcode).trim().toUpperCase(),
    item_name:String(input.itemName).trim(),
    item_code:String(input.itemCode||'').trim()||null,
    mrp:Number(input.mrp),
    sale_price:Number(input.salePrice)
  };

  var res=editingProductId
    ? await sb.from('products').update(record).eq('id',editingProductId).eq('org_id',currentOrgId)
    : await sb.from('products').insert(record);

  btn.disabled=false;

  if(res.error){
    var msg=res.error.message||'Unknown error.';
    if(/products_org_barcode_key/.test(msg))msg='A product with that barcode already exists. Edit that product instead.';
    else if(/products_sale_le_mrp/.test(msg))msg='Sale Price cannot be greater than MRP.';
    else if(/products_mrp_positive/.test(msg))msg='MRP must be greater than 0.';
    else if(/row-level security/i.test(msg))msg='Only the store owner can add or edit products.';
    showProductModalError(msg);
    return;
  }

  document.getElementById('pm-modal').classList.remove('open');
  editingProductId=null;
  loadProducts();
}

async function deleteProduct(id){
  if(!isProductAdmin()){ alert('Only the store owner can delete products.'); return; }

  var match=(productsState.rows||[]).filter(function(r){return r.id===id;})[0];
  var name=match?match.item_name:'this product';
  if(!confirm('Delete "'+name+'"? This cannot be undone.'))return;

  var res=await sb.from('products').delete().eq('id',id).eq('org_id',currentOrgId);
  if(res.error){ alert('Could not delete: '+res.error.message); return; }
  loadProducts();
}
```

- [ ] **Step 3: Verify Node still loads the module**

```bash
node tests/products-pricing.test.js
```
Expected: `products pricing tests passed`

- [ ] **Step 4: Verify the markup and logic are served**

```bash
npx -y serve -l 5959 . > ./tmp_serve.log 2>&1 &
sleep 3
curl -s http://localhost:5959/ | grep -c 'id="pm-modal"'
curl -s http://localhost:5959/products.js | grep -c 'async function saveProduct'
kill %1
rm -f ./tmp_serve.log
```
Expected: `1` and `1`

- [ ] **Step 5: Commit**

```bash
git add index.html products.js
git -c user.name="satishkumarkengam-cpu" -c user.email="kengam4s@gmail.com" commit -m "Add manual product add, edit and delete"
```

---

### Task 6: End-to-end verification and push

**Files:** none — verification only.

This task requires the Task 1 user gate (migration run) to be complete.

- [ ] **Step 1: Confirm no forbidden files changed**

```bash
git diff --name-only dae0893..HEAD
```
Expected: only `migration_step4.sql`, `products.js`, `tests/products-pricing.test.js`, `index.html`, `auth.js`, and files under `docs/`. `app.js` and `netlify.toml` must **not** appear.

- [ ] **Step 2: Confirm auth.js changed by exactly one line**

```bash
git diff dae0893..HEAD -- auth.js | grep -c '^+[^+]'
```
Expected: `1`

- [ ] **Step 3: Run both test suites**

```bash
node tests/products-pricing.test.js
node tests/stripe-webhook.test.js
```
Expected: `products pricing tests passed` then `stripe-webhook signature tests passed`

- [ ] **Step 4: Manual regression check of the existing app**

Serve locally (`npx -y serve -l 5959 .`) and confirm, against the live Supabase project, that **existing behaviour is unchanged**:
- Login works
- The Scan tab's camera starts and a scan still increments counts
- The Inventory tab loads its summary
- The Report tab loads the unmatched report
- The nav bar, Sign out, and the Upgrade badge all behave as before

- [ ] **Step 5: Manual check of the new feature**

As an **owner** account:
- The Products tab is visible; opening it lists products (or the empty state)
- Add Product: entering MRP 19.99 and Sale Price 14.99 shows `Discount: 25%` and `Savings: $5.00` live, before saving
- Saving creates the product and it appears in the table
- Editing changes values and Discount/Savings recalculate
- Entering Sale Price 12 with MRP 10 is rejected with "Sale Price cannot be greater than MRP."
- Re-using an existing barcode is rejected with the duplicate-barcode message
- Search matches on barcode, item name and item code; each filter chip changes the result set
- Delete asks for confirmation and removes the row

As a **member (staff)** account:
- The Products tab is **not** visible

- [ ] **Step 6: Push**

```bash
git push origin main
```

- [ ] **Step 7: Confirm the Netlify deploy succeeds**

`products.js` is a new top-level file and `netlify.toml` was not modified, so the static publish should be unaffected. Confirm the deploy goes green and the live site still loads before considering Phase 1 done.
