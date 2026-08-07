# Product CSV Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an owner download a correctly-shaped sample CSV and bulk-import products from a CSV file, with a summary and explicit confirmation before anything is written.

**Architecture:** Mostly wiring. The `import_products(org_id, rows, mode)` RPC already exists in the live database and does the atomic write with server-side validation, so this adds a parse/validate/summarise front end in a new `productsimport.js`, two toolbar buttons, and a summary modal. One SQL file replaces the RPC's numeric pre-check so Excel's scientific notation is accepted. No schema change.

**Tech Stack:** Vanilla HTML/CSS/JS (no framework, no build step, no npm), Supabase REST + RPC, Netlify static hosting.

## Global Constraints

- No new npm dependencies, no build step, no bundler, no third-party library. **CSV only — no XLSX** (that needs a library and stays with the fuller Phase 3 import).
- `app.js`, `auth.js`, `products.js`, `pricescan.js`, `netlify.toml` and `migration_step4.sql` must have **zero** changes.
- No schema change. `migration_step5.sql` contains a `create or replace function` and nothing else.
- Import mode is `'upsert'` — existing barcodes update, new ones insert, **nothing is deleted**. Clear & Replace is out of scope.
- Discount % and Savings Amount are Postgres generated columns: never written, never present in the sample file. Unrecognised CSV columns are **ignored**, not rejected.
- `productsimport.js` must contain no top-level DOM or Supabase access, must end with a `module.exports` shim, and must declare `typeof`-guarded fallbacks for `PRODUCT_BARCODE_RE` and `MAX_PRICE` so Node can require it. Without the fallbacks the test file cannot load the module at all.
- New CSS classes must be prefixed `pi-`. Do not edit any existing CSS rule.
- Owner-only. Enforced by RLS and by the RPC; the Products tab is already hidden from staff.
- All commits authored as `satishkumarkengam-cpu <kengam4s@gmail.com>`.
- Repo root: `C:\Users\satis\OneDrive\Desktop\satken_im_ca`, branch `products-csv-import` (branched from `products-table-ux`).

## Interfaces available from earlier work (do not redefine)

From `products.js`: `PRODUCT_BARCODE_RE` (`/^[A-Za-z0-9\-\.\ ]+$/`), `MAX_PRICE` (`1e10`), `CURRENCY_SYMBOL`, `formatMoney`, `isProductAdmin`, `loadProducts`, `productsState`.
From `app.js`: `decodeFileBuffer(arrayBuffer)` → string (handles Windows-1252 and BOM), `parseUploadLine(line)` → array of cells, `csvField(v)` → quoted CSV value, `escapeHtml(s)`.
From `auth.js`: `sb`, `currentOrgId`.

The live RPC: `sb.rpc('import_products', {p_org_id, p_rows, p_mode})` where `p_rows` is an array of `{barcode, item_name, item_code, mrp, sale_price}` objects, `p_mode` is `'upsert'`. Returns `{added, updated, removed}`.

---

### Task 1: Widen the RPC's numeric pre-check

**Files:**
- Create: `migration_step5.sql`

**Interfaces:**
- Consumes: the existing `import_products` function and `products` table from `migration_step4.sql`.
- Produces: nothing in code. Task 5's manual verification depends on this having been run.

The live pre-check regex rejects scientific notation and a leading `+`, both of which Postgres's own `::numeric` accepts and **Excel emits for large numbers**. Harmless until now because nothing called the RPC; the moment import ships, a real spreadsheet export can be rejected as "non-numeric" for a cell that looks fine.

- [ ] **Step 1: Create the migration**

Create `migration_step5.sql`:

```sql
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
```

- [ ] **Step 2: Verify structure**

There is no local Postgres and no `psql` here — do not try to execute this. Check it structurally instead:

```bash
grep -c '^\$\$;$' migration_step5.sql
grep -c 'eE\]\[+-\]' migration_step5.sql
grep -c 'create table\|alter table\|drop table\|create policy\|create trigger' migration_step5.sql
```
Expected: `1` (one function body), `2` (the widened pattern used for both mrp and sale_price), and `0` — that last check proves this touches no table, policy or trigger.

- [ ] **Step 3: Commit**

```bash
git add migration_step5.sql
git -c user.name="satishkumarkengam-cpu" -c user.email="kengam4s@gmail.com" commit -m "Widen import numeric pre-check to accept scientific notation"
```

- [ ] **Step 4: USER GATE — run the migration**

Performed by the human, not the agent. Surface this and continue with other tasks:

> Open the Supabase SQL Editor for project `gkhayphmzopttyasclww`, paste all of `migration_step5.sql`, and run it. Expected: "Success. No rows returned." This only replaces a function body.

Tasks 2–4 do not need it. Task 5's scientific-notation check does.

---

### Task 2: CSV parsing, validation and summary (TDD)

**Files:**
- Create: `productsimport.js`
- Create: `tests/products-import.test.js`

**Interfaces:**
- Produces: `PRODUCT_CSV_HEADERS` (array of the five column names, in sample order), `mapCsvHeaders(cells)` → `{map, error}`, `parseProductCsv(text)` → `{rows, errors, warnings}` where `errors` and `warnings` are arrays of `{line, message}`, `summarizeImport(rows, existingBarcodes)` → `{total, added, updated}`, `buildSampleCsv()` → string. Tasks 3 and 4 consume all of these.

Row shape produced by `parseProductCsv`: `{line, barcode, item_name, item_code, mrp, sale_price}` where `line` is the 1-based line number in the file (header is line 1) and `mrp`/`sale_price` are **strings**, passed through to the RPC unparsed so Postgres does the final conversion.

- [ ] **Step 1: Write the failing test**

Create `tests/products-import.test.js`:

```javascript
// Plain Node script (no test framework), matching the other suites.
// Run with: node tests/products-import.test.js
var assert = require('assert');
var {
  PRODUCT_CSV_HEADERS,
  mapCsvHeaders,
  parseProductCsv,
  summarizeImport,
  buildSampleCsv
} = require('../productsimport.js');

// ── headers ──
assert.deepStrictEqual(
  PRODUCT_CSV_HEADERS,
  ['Barcode','Item Name','Item Code','MRP','Sale Price'],
  'the sample and importer agree on exactly these five columns'
);

var exact = mapCsvHeaders(['Barcode','Item Name','Item Code','MRP','Sale Price']);
assert.strictEqual(exact.error, null, 'exact headers map cleanly');
assert.deepStrictEqual(exact.map, {barcode:0, item_name:1, item_code:2, mrp:3, sale_price:4}, 'columns map to their indexes');

var messy = mapCsvHeaders(['  BARCODE ','name','SKU','mrp','Selling Price']);
assert.strictEqual(messy.error, null, 'case, spacing and accepted synonyms all map');
assert.deepStrictEqual(messy.map, {barcode:0, item_name:1, item_code:2, mrp:3, sale_price:4}, 'synonyms resolve to the same fields');

var reordered = mapCsvHeaders(['MRP','Sale Price','Barcode','Item Name']);
assert.strictEqual(reordered.error, null, 'column order does not matter');
assert.strictEqual(reordered.map.barcode, 2, 'barcode found at its actual index');
assert.strictEqual(reordered.map.item_code, undefined, 'optional item code may be absent');

var extra = mapCsvHeaders(['Barcode','Item Name','MRP','Sale Price','Discount','Savings','Notes']);
assert.strictEqual(extra.error, null, 'unrecognised columns are ignored, not rejected');

var missing = mapCsvHeaders(['Barcode','Item Name','MRP']);
assert.ok(missing.error, 'a missing required column is an error');
assert.ok(/Sale Price/i.test(missing.error), 'the error names the missing column');

// ── parsing and validation ──
var good = parseProductCsv(
  'Barcode,Item Name,Item Code,MRP,Sale Price\n' +
  '8901234567890,Premium Coffee 500g,COF-500,19.99,14.99\n' +
  '8901234567891,Green Tea 100g,TEA-100,9.99,7.99\n'
);
assert.strictEqual(good.errors.length, 0, 'a clean file has no errors');
assert.strictEqual(good.rows.length, 2, 'both rows parsed');
assert.strictEqual(good.rows[0].barcode, '8901234567890', 'barcode captured');
assert.strictEqual(good.rows[0].item_name, 'Premium Coffee 500g', 'name captured');
assert.strictEqual(good.rows[0].mrp, '19.99', 'MRP kept as a string for the database to convert');
assert.strictEqual(good.rows[0].line, 2, 'line numbers are 1-based and count the header');

var quoted = parseProductCsv(
  'Barcode,Item Name,Item Code,MRP,Sale Price\r\n' +
  '"8901234567890","Coffee, Ground, 500g","COF-500","19.99","14.99"\r\n' +
  '\r\n'
);
assert.strictEqual(quoted.errors.length, 0, 'CRLF and a blank trailing line are tolerated');
assert.strictEqual(quoted.rows.length, 1, 'the blank line is skipped, not treated as a row');
assert.strictEqual(quoted.rows[0].item_name, 'Coffee, Ground, 500g', 'commas inside quotes stay in the field');

// Returns the message text, not the error object — matching against the object
// would stringify to "[object Object]" and pass or fail for the wrong reason.
function firstError(csv){
  var e=parseProductCsv('Barcode,Item Name,Item Code,MRP,Sale Price\n'+csv).errors[0];
  return e?e.message:'';
}

assert.ok(/barcode/i.test(firstError(',Item,C,10,5')), 'missing barcode is an error');
assert.ok(/barcode/i.test(firstError('AB$%^,Item,C,10,5')), 'illegal barcode characters are an error');
assert.ok(/name/i.test(firstError('123456, ,C,10,5')), 'missing item name is an error');
assert.ok(/MRP/i.test(firstError('123456,Item,C,,5')), 'missing MRP is an error');
assert.ok(/MRP/i.test(firstError('123456,Item,C,abc,5')), 'non-numeric MRP is an error');
assert.ok(/MRP/i.test(firstError('123456,Item,C,0,0')), 'zero MRP is an error');
assert.ok(/MRP/i.test(firstError('123456,Item,C,-5,1')), 'negative MRP is an error');
assert.ok(/Sale Price/i.test(firstError('123456,Item,C,10,')), 'missing sale price is an error');
assert.ok(/Sale Price/i.test(firstError('123456,Item,C,10,-1')), 'negative sale price is an error');
assert.ok(/greater than MRP/i.test(firstError('123456,Item,C,10,12')), 'sale price above MRP is an error');
assert.ok(/too large/i.test(firstError('123456,Item,C,10000000000,5')), 'a price at the numeric(12,2) ceiling is an error');

var dupBarcode = parseProductCsv(
  'Barcode,Item Name,MRP,Sale Price\n' +
  '123456,A,10,5\n' +
  '123456,B,20,15\n'
);
assert.ok(dupBarcode.errors.some(function(e){return /duplicate/i.test(e.message);}), 'a barcode repeated in the file is an error');

var noCode = parseProductCsv(
  'Barcode,Item Name,Item Code,MRP,Sale Price\n' +
  '123456,Item,,10,5\n'
);
assert.strictEqual(noCode.errors.length, 0, 'a missing item code does not block the import');
assert.ok(noCode.warnings.length >= 1, 'a missing item code is reported as a warning');
assert.strictEqual(noCode.rows[0].item_code, '', 'absent item code becomes an empty string');

var sci = parseProductCsv(
  'Barcode,Item Name,MRP,Sale Price\n' +
  '123456,Item,1.2E+3,999\n'
);
assert.strictEqual(sci.errors.length, 0, 'scientific notation is accepted, as Excel emits it for large numbers');

var headerless = parseProductCsv('123456,Item,C,10,5\n');
assert.ok(headerless.errors.length >= 1, 'a file with no recognisable header row is rejected');

// ── summary ──
var rows = [
  {line:2, barcode:'A', item_name:'x', item_code:'', mrp:'10', sale_price:'5'},
  {line:3, barcode:'B', item_name:'y', item_code:'', mrp:'10', sale_price:'5'},
  {line:4, barcode:'C', item_name:'z', item_code:'', mrp:'10', sale_price:'5'}
];
var sum = summarizeImport(rows, ['B','C','D']);
assert.strictEqual(sum.total, 3, 'total counts parsed rows');
assert.strictEqual(sum.added, 1, 'barcodes not already present count as new');
assert.strictEqual(sum.updated, 2, 'barcodes already present count as updates');

var allNew = summarizeImport(rows, []);
assert.strictEqual(allNew.added, 3, 'an empty catalogue makes every row new');
assert.strictEqual(allNew.updated, 0, 'and nothing an update');

var empty = summarizeImport([], ['A']);
assert.strictEqual(empty.total, 0, 'an empty file totals zero');
assert.strictEqual(empty.added, 0, 'with nothing added');

// Existing-barcode matching must be case-insensitive: the database
// normalises barcodes to upper case on write.
var caseMix = summarizeImport(
  [{line:2, barcode:'ABC', item_name:'x', item_code:'', mrp:'10', sale_price:'5'}],
  ['abc']
);
assert.strictEqual(caseMix.updated, 1, 'a lower-case existing barcode still matches');

// ── sample file ──
var sample = buildSampleCsv();
var sampleHeader = sample.split('\n')[0].split(',');
assert.deepStrictEqual(sampleHeader, PRODUCT_CSV_HEADERS, 'the sample header is exactly the five importable columns');
assert.ok(!/Discount|Savings/i.test(sample), 'the sample omits generated columns so nobody tries to fill them in');
var sampleParsed = parseProductCsv(sample);
assert.strictEqual(sampleParsed.errors.length, 0, 'the sample file parses through the importer with no errors');
assert.ok(sampleParsed.rows.length >= 1, 'the sample contains at least one example row');

console.log('products import tests passed');
```

- [ ] **Step 2: Run it to verify it fails**

```bash
node tests/products-import.test.js
```
Expected: `Error: Cannot find module '../productsimport.js'`

- [ ] **Step 3: Create productsimport.js**

```javascript
/* ══════════════════════════════════════════════════════════════
   PRODUCT CSV IMPORT — sample download, parsing, validation and
   the confirmed bulk import.

   The database does the actual write via the import_products RPC,
   which validates every row again and runs in one transaction, so a
   bad file changes nothing. The checks here exist to give a readable
   message and an accurate summary before that call, not as the
   security boundary.

   No top-level DOM or Supabase access, so Node can require() this
   for unit tests. Wiring is via inline onclick in index.html.
   ══════════════════════════════════════════════════════════════ */

// products.js owns these in the browser. The guarded fallbacks exist only so
// this module can be required standalone under Node for its unit tests.
if(typeof PRODUCT_BARCODE_RE==='undefined'){
  var PRODUCT_BARCODE_RE=/^[A-Za-z0-9\-\.\ ]+$/;
}
if(typeof MAX_PRICE==='undefined'){
  var MAX_PRICE=1e10;
}

var PRODUCT_CSV_HEADERS=['Barcode','Item Name','Item Code','MRP','Sale Price'];

/* Accepted header spellings. Matching is case-insensitive and
   whitespace-tolerant. Anything not listed here is ignored rather than
   rejected, so a file carrying extra columns (Discount, Savings, notes of
   any kind) still imports. */
var CSV_HEADER_SYNONYMS={
  barcode:['barcode','item barcode'],
  item_name:['item name','name','product name'],
  item_code:['item code','code','sku'],
  mrp:['mrp','m.r.p','mrp price'],
  sale_price:['sale price','sale','selling price','offer price']
};

var CSV_REQUIRED_FIELDS=['barcode','item_name','mrp','sale_price'];

var CSV_FIELD_LABELS={
  barcode:'Barcode', item_name:'Item Name', item_code:'Item Code',
  mrp:'MRP', sale_price:'Sale Price'
};

// Mirrors the widened pre-check in migration_step5.sql, so the client and the
// database agree on what counts as a number.
var CSV_NUMERIC_RE=/^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$/;

function normalizeHeaderCell(s){
  return String(s==null?'':s).replace(/^\uFEFF/,'').replace(/"/g,'').trim().toLowerCase().replace(/\s+/g,' ');
}

function mapCsvHeaders(cells){
  var map={};
  (cells||[]).forEach(function(cell, idx){
    var norm=normalizeHeaderCell(cell);
    Object.keys(CSV_HEADER_SYNONYMS).forEach(function(field){
      if(map[field]===undefined&&CSV_HEADER_SYNONYMS[field].indexOf(norm)>=0)map[field]=idx;
    });
  });

  var missing=CSV_REQUIRED_FIELDS.filter(function(f){ return map[f]===undefined; });
  if(missing.length){
    return {map:map, error:'Missing required column'+(missing.length>1?'s':'')+': '+
      missing.map(function(f){return CSV_FIELD_LABELS[f];}).join(', ')};
  }
  return {map:map, error:null};
}

function cellAt(cells, idx){
  if(idx===undefined||idx===null)return '';
  var v=cells[idx];
  return String(v==null?'':v).replace(/"/g,'').trim();
}

function parseProductCsv(text){
  var rows=[], errors=[], warnings=[];
  var src=String(text||'').replace(/\r\n/g,'\n').replace(/\r/g,'\n');
  var lines=src.split('\n');

  var headerIdx=-1;
  for(var i=0;i<lines.length;i++){ if(lines[i].trim()){ headerIdx=i; break; } }
  if(headerIdx<0){
    errors.push({line:0, message:'The file is empty.'});
    return {rows:rows, errors:errors, warnings:warnings};
  }

  var mapped=mapCsvHeaders(parseUploadLine(lines[headerIdx]));
  if(mapped.error){
    errors.push({line:headerIdx+1, message:mapped.error});
    return {rows:rows, errors:errors, warnings:warnings};
  }
  var map=mapped.map;

  var seenBarcodes={}, seenCodes={};

  for(var n=headerIdx+1;n<lines.length;n++){
    var raw=lines[n];
    if(!raw.trim())continue; // blank lines, including a trailing newline
    var lineNo=n+1;
    var cells=parseUploadLine(raw);

    var barcode=cellAt(cells,map.barcode).toUpperCase();
    var itemName=cellAt(cells,map.item_name);
    var itemCode=cellAt(cells,map.item_code);
    var mrpRaw=cellAt(cells,map.mrp);
    var saleRaw=cellAt(cells,map.sale_price);

    var rowErrors=[];

    if(!barcode)rowErrors.push('Barcode is required.');
    else if(!PRODUCT_BARCODE_RE.test(barcode))rowErrors.push('Barcode may contain only letters, numbers, "-", "." and spaces.');
    else if(seenBarcodes[barcode])rowErrors.push('Duplicate barcode — already used on line '+seenBarcodes[barcode]+'.');

    if(!itemName)rowErrors.push('Item Name is required.');

    var mrp=Number(mrpRaw), sale=Number(saleRaw);
    var mrpOk=false, saleOk=false;

    if(!mrpRaw)rowErrors.push('MRP is required.');
    else if(!CSV_NUMERIC_RE.test(mrpRaw))rowErrors.push('MRP must be a number.');
    else if(!(mrp>0))rowErrors.push('MRP must be greater than 0.');
    else if(mrp>=MAX_PRICE)rowErrors.push('MRP is too large.');
    else mrpOk=true;

    if(!saleRaw)rowErrors.push('Sale Price is required.');
    else if(!CSV_NUMERIC_RE.test(saleRaw))rowErrors.push('Sale Price must be a number.');
    else if(sale<0)rowErrors.push('Sale Price cannot be negative.');
    else if(sale>=MAX_PRICE)rowErrors.push('Sale Price is too large.');
    else saleOk=true;

    if(mrpOk&&saleOk&&sale>mrp)rowErrors.push('Sale Price cannot be greater than MRP.');

    if(rowErrors.length){
      rowErrors.forEach(function(m){ errors.push({line:lineNo, message:m}); });
      continue;
    }

    if(!itemCode)warnings.push({line:lineNo, message:'No Item Code.'});
    else if(seenCodes[itemCode])warnings.push({line:lineNo, message:'Item Code also used on line '+seenCodes[itemCode]+'.'});
    else seenCodes[itemCode]=lineNo;

    seenBarcodes[barcode]=lineNo;
    rows.push({line:lineNo, barcode:barcode, item_name:itemName, item_code:itemCode, mrp:mrpRaw, sale_price:saleRaw});
  }

  return {rows:rows, errors:errors, warnings:warnings};
}

/* Splitting the total into new versus updates is the point of this: it is the
   number that tells an owner whether they are about to rewrite the whole
   catalogue because they picked the wrong file. */
function summarizeImport(rows, existingBarcodes){
  var have={};
  (existingBarcodes||[]).forEach(function(b){ have[String(b).trim().toUpperCase()]=true; });

  var added=0, updated=0;
  (rows||[]).forEach(function(r){
    if(have[String(r.barcode).trim().toUpperCase()])updated++;
    else added++;
  });

  return {total:(rows||[]).length, added:added, updated:updated};
}

/* Deliberately omits Discount and Savings: they are database-generated, so a
   client cannot write them and offering the columns would only invite someone
   to fill them in and wonder why they were ignored. */
function buildSampleCsv(){
  return PRODUCT_CSV_HEADERS.join(',')+'\n'+
    '8901234567890,Premium Coffee 500g,COF-500,19.99,14.99\n'+
    '8901234567891,Green Tea 100g,TEA-100,9.99,7.99\n'+
    '8901234567892,Butter Cookies 200g,CK-200,5.99,4.49\n';
}

/* Node export shim — inert in the browser. Later tasks append code ABOVE
   this block; it must stay last in the file. */
if(typeof module!=='undefined'&&module.exports){
  module.exports={
    PRODUCT_CSV_HEADERS:PRODUCT_CSV_HEADERS,
    mapCsvHeaders:mapCsvHeaders,
    parseProductCsv:parseProductCsv,
    summarizeImport:summarizeImport,
    buildSampleCsv:buildSampleCsv
  };
}
```

`parseProductCsv` calls `parseUploadLine`, which lives in `app.js` and is undefined under Node. Add this immediately below the `MAX_PRICE` fallback so the module stays requireable:

```javascript
/* app.js owns parseUploadLine in the browser. This minimal equivalent exists
   only so the module can be required standalone under Node for its tests. */
if(typeof parseUploadLine==='undefined'){
  var parseUploadLine=function(line){
    var cols=[],cur='',inQ=false;
    for(var i=0;i<line.length;i++){
      var ch=line[i];
      if(ch==='"'){inQ=!inQ;}
      else if(ch===','&&!inQ){cols.push(cur);cur='';}
      else{cur+=ch;}
    }
    cols.push(cur);
    return cols;
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node tests/products-import.test.js
```
Expected: `products import tests passed`

- [ ] **Step 5: Confirm the other suites still pass**

```bash
node tests/products-pricing.test.js
node tests/stripe-webhook.test.js
node --check productsimport.js && echo "syntax OK"
```
Expected: two pass lines then `syntax OK`.

- [ ] **Step 6: Commit**

```bash
git add productsimport.js tests/products-import.test.js
git -c user.name="satishkumarkengam-cpu" -c user.email="kengam4s@gmail.com" commit -m "Add product CSV parsing, validation and summary with tests"
```

---

### Task 3: Toolbar buttons, file input and summary modal

**Files:**
- Modify: `index.html`

**Interfaces:**
- Consumes: Task 2's module (loaded by script tag).
- Produces: DOM ids `pi-file-input`, `pi-modal`, `pi-modal-title`, `pi-summary`, `pi-issues`, `pi-import-btn`. Task 4 reads and drives all of these.

`downloadProductSampleCsv()`, `onProductCsvChosen()`, `closeImportModal()` and `runProductImport()` are created in Task 4. Clicking these controls before then logs a ReferenceError — expected staged delivery. Do not stub them.

- [ ] **Step 1: Add the two toolbar buttons**

In `index.html`, find:
```
        <div class="pm-toolbar-actions">
          <button class="pm-btn-sm" onclick="openProductModal()">Add Product</button>
          <button class="pm-btn-sm danger" id="pm-delete-selected" disabled onclick="deleteSelectedProducts()">Delete Selected</button>
        </div>
```
and replace with:
```
        <div class="pm-toolbar-actions">
          <button class="pm-btn-sm" onclick="downloadProductSampleCsv()">Sample CSV</button>
          <button class="pm-btn-sm" onclick="document.getElementById('pi-file-input').click()">Import CSV</button>
          <button class="pm-btn-sm" onclick="openProductModal()">Add Product</button>
          <button class="pm-btn-sm danger" id="pm-delete-selected" disabled onclick="deleteSelectedProducts()">Delete Selected</button>
        </div>
        <input type="file" id="pi-file-input" accept=".csv,text/csv" style="display:none" onchange="onProductCsvChosen(this)">
```

- [ ] **Step 2: Add the summary modal**

In `index.html`, find:
```
  <div class="modal-bg" id="pm-modal" onclick="closeProductModal(event)">
```
and replace with:
```
  <div class="modal-bg" id="pi-modal" onclick="closeImportModal(event)">
    <div class="modal">
      <h3 id="pi-modal-title">Import Products</h3>
      <div class="pi-summary" id="pi-summary"></div>
      <div class="pi-issues" id="pi-issues"></div>
      <div class="modal-btns">
        <button class="btn btn-outline" onclick="closeImportModal()">Cancel</button>
        <button class="btn btn-gold" id="pi-import-btn" onclick="runProductImport()">Import</button>
      </div>
    </div>
  </div>

  <div class="modal-bg" id="pm-modal" onclick="closeProductModal(event)">
```

- [ ] **Step 3: Add the CSS**

In `index.html`, find:
```
  .pm-table th.pm-col-check { text-align:center; }
```
and replace with:
```
  .pm-table th.pm-col-check { text-align:center; }

  /* ── PRODUCT CSV IMPORT (add-on) ── */
  .pi-summary { font-size:17px; color:var(--text); line-height:1.7; margin-bottom:12px; }
  .pi-summary b { color:var(--gold); }
  .pi-issues { max-height:220px; overflow-y:auto; margin-bottom:14px; }
  .pi-issue { font-size:15px; color:var(--red); padding:4px 0; border-bottom:1px solid var(--border-soft); }
  .pi-issue:last-child { border-bottom:none; }
  .pi-issue.warn { color:var(--warn); }
  .pi-issue .pi-line { font-family:'JetBrains Mono',monospace; font-size:13px; color:var(--muted); margin-right:6px; }
  /* The product modal already needs this; the import modal can be just as tall
     once it is listing issues, and .modal-bg is a fixed flex-end container
     with no scroll of its own. */
  #pi-modal .modal { max-height:90dvh; overflow-y:auto; }
```

- [ ] **Step 4: Load the module**

In `index.html`, find:
```
<script src="products.js"></script>
```
and replace with:
```
<script src="products.js"></script>
<script src="productsimport.js"></script>
```

- [ ] **Step 5: Verify**

```bash
npx -y serve -l 5959 . > ./tmp_serve.log 2>&1 &
sleep 3
curl -s http://localhost:5959/ | grep -c 'id="pi-file-input"'
curl -s http://localhost:5959/ | grep -c 'id="pi-modal"'
curl -s http://localhost:5959/ | grep -c 'id="pi-import-btn"'
curl -s http://localhost:5959/ | grep -c 'productsimport.js'
curl -s http://localhost:5959/ | grep -c 'Sample CSV'
echo "--- the existing product modal must still be present and separate ---"
curl -s http://localhost:5959/ | grep -c 'id="pm-modal"'
kill %1
rm -f ./tmp_serve.log
```
Expected: `1` for each of the six checks.

- [ ] **Step 6: Commit**

```bash
git add index.html
git -c user.name="satishkumarkengam-cpu" -c user.email="kengam4s@gmail.com" commit -m "Add CSV import toolbar buttons, file input and summary modal"
```

---

### Task 4: Sample download and the import flow

**Files:**
- Modify: `productsimport.js` (append before the export shim)

**Interfaces:**
- Consumes: Task 2's `buildSampleCsv`, `parseProductCsv`, `summarizeImport`; Task 3's DOM ids; `sb`, `currentOrgId`, `isProductAdmin`, `loadProducts`, `escapeHtml`, `decodeFileBuffer`.
- Produces: `downloadProductSampleCsv()`, `onProductCsvChosen(input)`, `closeImportModal(e)`, `runProductImport()`.

- [ ] **Step 1: Append the flow**

Insert immediately **before** the `module.exports` shim:

```javascript
/* ── SAMPLE DOWNLOAD ── */

function downloadProductSampleCsv(){
  var blob=new Blob([buildSampleCsv()],{type:'text/csv'});
  var url=URL.createObjectURL(blob);
  var a=document.createElement('a');
  a.href=url;a.download='product-import-sample.csv';
  document.body.appendChild(a);a.click();
  document.body.removeChild(a);URL.revokeObjectURL(url);
}

/* ── IMPORT ── */

var piPending=null; // rows awaiting confirmation

/* PostgREST caps a response at 1000 rows, so page through — the same approach
   fetchAllUnmatched() uses. Without this a catalogue over 1000 products would
   silently report existing items as new. */
async function fetchExistingBarcodes(){
  var PAGE=1000, all=[], from=0;
  while(true){
    var res=await sb.from('products').select('barcode')
      .eq('org_id',currentOrgId).range(from,from+PAGE-1);
    if(res.error)return {error:res.error.message, barcodes:[]};
    (res.data||[]).forEach(function(r){ all.push(r.barcode); });
    if(!res.data||res.data.length<PAGE)break;
    from+=PAGE;
  }
  return {error:null, barcodes:all};
}

function onProductCsvChosen(input){
  if(!isProductAdmin()){ alert('Only the store owner can import products.'); return; }
  var file=input.files&&input.files[0];
  // Clear immediately so choosing the same file twice in a row still fires.
  input.value='';
  if(!file)return;

  var reader=new FileReader();
  reader.onerror=function(){ alert('Could not read that file. Please try again.'); };
  reader.onload=function(e){ prepareImport(decodeFileBuffer(e.target.result), file.name); };
  reader.readAsArrayBuffer(file);
}

async function prepareImport(text, filename){
  var parsed=parseProductCsv(text);

  var titleEl=document.getElementById('pi-modal-title');
  var summaryEl=document.getElementById('pi-summary');
  var issuesEl=document.getElementById('pi-issues');
  var btn=document.getElementById('pi-import-btn');

  titleEl.textContent='Import '+filename;
  issuesEl.innerHTML='';
  summaryEl.textContent='Checking…';
  btn.disabled=true;
  piPending=null;
  document.getElementById('pi-modal').classList.add('open');

  if(parsed.errors.length){
    summaryEl.innerHTML='<b>'+parsed.errors.length+'</b> problem'+
      (parsed.errors.length===1?'':'s')+' found. Nothing has been imported.';
    issuesEl.innerHTML=renderImportIssues(parsed.errors,'', 5);
    return;
  }

  if(!parsed.rows.length){
    summaryEl.textContent='That file has no product rows.';
    return;
  }

  // Existing barcodes are what turn "240 rows" into "228 updates" — the number
  // that reveals a wrong file before it overwrites anything.
  var existing=await fetchExistingBarcodes();
  if(existing.error){
    summaryEl.textContent='Could not check your current catalogue: '+existing.error;
    return;
  }

  var sum=summarizeImport(parsed.rows, existing.barcodes);
  piPending=parsed.rows;

  summaryEl.innerHTML='<b>'+sum.total+'</b> row'+(sum.total===1?'':'s')+
    ' · <b>'+sum.added+'</b> new · <b>'+sum.updated+'</b> price update'+
    (sum.updated===1?'':'s')+
    (parsed.warnings.length?' · <b>'+parsed.warnings.length+'</b> warning'+(parsed.warnings.length===1?'':'s'):'');

  if(parsed.warnings.length)issuesEl.innerHTML=renderImportIssues(parsed.warnings,' warn', 5);
  btn.disabled=false;
}

function renderImportIssues(list, cls, limit){
  var shown=list.slice(0,limit).map(function(it){
    return '<div class="pi-issue'+cls+'"><span class="pi-line">Line '+it.line+'</span>'+
      escapeHtml(it.message)+'</div>';
  }).join('');
  if(list.length>limit){
    shown+='<div class="pi-issue'+cls+'">…and '+(list.length-limit)+' more.</div>';
  }
  return shown;
}

function closeImportModal(e){
  if(e&&e.target!==document.getElementById('pi-modal'))return;
  document.getElementById('pi-modal').classList.remove('open');
  piPending=null;
}

async function runProductImport(){
  if(!piPending||!piPending.length)return;
  if(!isProductAdmin()){ alert('Only the store owner can import products.'); return; }

  var btn=document.getElementById('pi-import-btn');
  var summaryEl=document.getElementById('pi-summary');
  btn.disabled=true;
  summaryEl.textContent='Importing…';

  // 'upsert' updates existing barcodes and inserts new ones. Nothing is
  // deleted. The RPC validates again and runs in one transaction, so if it
  // raises, nothing at all was written.
  var res=await sb.rpc('import_products',{
    p_org_id:currentOrgId,
    p_rows:piPending,
    p_mode:'upsert'
  });

  if(res.error){
    summaryEl.textContent='Import failed: '+res.error.message+' Nothing was changed.';
    btn.disabled=false;
    return;
  }

  var out=res.data||{};
  document.getElementById('pi-modal').classList.remove('open');
  piPending=null;
  alert('Imported successfully — '+(out.added||0)+' added, '+(out.updated||0)+' updated.');
  loadProducts();
}
```

- [ ] **Step 2: Verify**

```bash
node tests/products-import.test.js
node tests/products-pricing.test.js
node tests/stripe-webhook.test.js
node --check productsimport.js && echo "syntax OK"

echo "--- upsert mode only; nothing deletes ---"
grep -q "p_mode:'upsert'" productsimport.js && echo "OK  upsert" || echo "MISSING"
grep -qE "p_mode:'replace'|\.delete\(" productsimport.js && echo "PROBLEM destructive call present" || echo "OK  no destructive call"

echo "--- paging present so >1000 products are not mis-reported as new ---"
grep -q 'PAGE=1000' productsimport.js && echo "OK  paged" || echo "MISSING"

echo "--- export shim still last ---"
tail -3 productsimport.js
```
Expected: three suites pass, `syntax OK`, `OK  upsert`, `OK  no destructive call`, `OK  paged`, and the shim's closing lines.

Then confirm the module still loads standalone, since this task adds `document`/`sb` references that must all be inside function bodies:

```bash
node -e "var m=require('./productsimport.js'); console.log('requires cleanly:', Object.keys(m).length, 'exports');"
```
Expected: `requires cleanly: 5 exports`

- [ ] **Step 3: Commit**

```bash
git add productsimport.js
git -c user.name="satishkumarkengam-cpu" -c user.email="kengam4s@gmail.com" commit -m "Add sample CSV download and confirmed import flow"
```

---

### Task 5: End-to-end verification and push

**Files:** none — verification only.

- [ ] **Step 1: Confirm no forbidden file changed**

```bash
git diff --name-only 83984f6..HEAD
```
Expected: only `migration_step5.sql`, `productsimport.js`, `index.html`, `tests/products-import.test.js`, and files under `docs/`. **`app.js`, `auth.js`, `products.js`, `pricescan.js`, `netlify.toml` and `migration_step4.sql` must not appear.**

- [ ] **Step 2: Confirm the migration is a function replacement only**

```bash
grep -cE 'create table|alter table|drop table|create policy|create trigger|drop function' migration_step5.sql
```
Expected: `0`

- [ ] **Step 3: Run all suites and syntax-check**

```bash
node tests/products-import.test.js
node tests/products-pricing.test.js
node tests/stripe-webhook.test.js
node --check productsimport.js && node --check products.js && node --check app.js && echo "all JS OK"
```
Expected: three pass lines then `all JS OK`.

- [ ] **Step 4: Browser verification**

Serve locally (`npx -y serve -l 5959 .`) and confirm in a real browser: no console errors on load; `downloadProductSampleCsv`, `onProductCsvChosen`, `prepareImport`, `runProductImport`, `parseProductCsv`, `summarizeImport` are all functions; existing `loadProducts`, `openProductModal`, `deleteSelectedProducts`, `setProductSort`, `switchTab` still are; and `buildSampleCsv()` output fed straight into `parseProductCsv()` yields zero errors and three rows.

- [ ] **Step 5: Manual checks (human, signed in as an owner)**

- **Sample CSV** downloads and opens in Excel with the five expected columns.
- Importing that sample creates the three example products; the table refreshes and shows them.
- Editing one MRP in that file and re-importing reports **0 new, 3 updated**, and the changed price appears in the table.
- A file with a row where Sale Price exceeds MRP is rejected in the modal, with the line number shown and **Import disabled** — and nothing changes in the table.
- A file missing the Sale Price column is rejected naming that column.
- Deleting the three example products afterwards leaves the catalogue as it was.
- **Requires `migration_step5.sql` to have been run:** a row with MRP `1.2E+3` imports successfully rather than failing with "non-numeric MRP or Sale Price".
- Scan, Inventory, Report and Price Scan tabs all behave exactly as before.

- [ ] **Step 6: Push**

```bash
git push -u origin products-csv-import
```
