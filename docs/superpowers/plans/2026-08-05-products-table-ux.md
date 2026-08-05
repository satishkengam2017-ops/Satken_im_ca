# Product Catalogue Table UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the Product Catalogue's horizontal scrollbar on desktop, and add row-selection checkboxes, bulk delete, column sorting and a proper toolbar — without changing any other page or losing any existing behaviour.

**Architecture:** Additive. All work lands in `products.js` and `index.html`. The horizontal scrollbar is caused by the app's global `main { max-width:480px }`, so one scoped `main:has(#tab-products.active)` rule widens this page only, at ≥900px. Selection is per-visible-page state in `products.js`; sorting is applied server-side through Supabase's `.order()` against a column allow-list. No schema change is needed.

**Tech Stack:** Vanilla HTML/CSS/JS (no framework, no build step, no npm), Supabase REST via `supabase-js`, Netlify static hosting.

## Global Constraints

- No new npm dependencies, no build step, no bundler. Plain browser JavaScript in the existing ES5-ish style (`var`, `function`, no arrow functions or template literals).
- `app.js`, `auth.js`, `pricescan.js`, `netlify.toml` and `migration_step4.sql` must have **zero** changes. No schema change is required.
- **Do not edit the existing `main` rule or any other existing CSS rule.** Only add new rules. New classes stay `pm-`-prefixed.
- `products.js` must keep no top-level DOM or Supabase access, and its `module.exports` shim must remain the **last** thing in the file, so Node can `require()` it for tests.
- Every existing behaviour must survive: search, filters, pagination, row Edit, row Delete, the owner-only permission gating, and the logout state-clearing in `applyFeaturePermissions`.
- Row actions and checkboxes dispatch by **array index**, never by interpolating an id into an attribute — HTML entities decode before an attribute compiles as JavaScript, so escaping alone would not protect that string boundary.
- Only these eight columns may reach `.order()`: `barcode`, `item_name`, `item_code`, `mrp`, `sale_price`, `discount_pct`, `savings_amount`, `updated_at`. Validate against an allow-list so a column name can never be injected.
- Discount % and Savings Amount are database-generated columns — read for display, never written.
- Export is **out of scope** (Phase 3 owns it, with a format that round-trips into the bulk importer).
- All commits authored as `satishkumarkengam-cpu <kengam4s@gmail.com>`.
- Repo root: `C:\Users\satis\OneDrive\Desktop\satken_im_ca`, branch `products-table-ux`.

---

### Task 1: Sort and selection state logic (TDD)

**Files:**
- Modify: `products.js` (add pure functions before the `module.exports` shim, and extend the shim)
- Modify: `tests/products-pricing.test.js`

**Interfaces:**
- Produces: `PRODUCT_SORT_COLUMNS` (array of the eight allowed column names), `nextSortState(current, col)` → `{col, asc}`, `selectionCheckboxState(selectedCount, visibleCount)` → `{checked, indeterminate}`. Tasks 2–4 consume all three.

- [ ] **Step 1: Write the failing test**

Append to `tests/products-pricing.test.js`, immediately **before** the final `console.log('products pricing tests passed');` line:

```javascript
// ── PRODUCT_SORT_COLUMNS ──
assert.deepStrictEqual(
  PRODUCT_SORT_COLUMNS,
  ['barcode','item_name','item_code','mrp','sale_price','discount_pct','savings_amount','updated_at'],
  'the sortable column allow-list is exactly these eight'
);

// ── nextSortState ──
assert.deepStrictEqual(
  nextSortState({col:'item_name', asc:true}, 'mrp'),
  {col:'mrp', asc:true},
  'a different column starts ascending'
);
assert.deepStrictEqual(
  nextSortState({col:'mrp', asc:true}, 'mrp'),
  {col:'mrp', asc:false},
  'the same column reverses'
);
assert.deepStrictEqual(
  nextSortState({col:'mrp', asc:false}, 'mrp'),
  {col:'mrp', asc:true},
  'reversing twice returns to ascending'
);
assert.deepStrictEqual(
  nextSortState({col:'item_name', asc:true}, 'not_a_column'),
  {col:'item_name', asc:true},
  'a column outside the allow-list is ignored, never passed to the query'
);
assert.deepStrictEqual(
  nextSortState(null, 'mrp'),
  {col:'mrp', asc:true},
  'a missing current state still yields a usable sort'
);

// ── selectionCheckboxState ──
assert.deepStrictEqual(
  selectionCheckboxState(0, 10),
  {checked:false, indeterminate:false},
  'nothing selected is unchecked'
);
assert.deepStrictEqual(
  selectionCheckboxState(4, 10),
  {checked:false, indeterminate:true},
  'a partial selection is indeterminate'
);
assert.deepStrictEqual(
  selectionCheckboxState(10, 10),
  {checked:true, indeterminate:false},
  'all visible rows selected is checked'
);
assert.deepStrictEqual(
  selectionCheckboxState(0, 0),
  {checked:false, indeterminate:false},
  'an empty table is neither checked nor indeterminate'
);
```

Then update the `require` line at the top of that same file. Find:

```javascript
var {
  computeSavings,
  computeDiscountPct,
  formatMoney,
  formatDiscount,
  validateProductInput
} = require('../products.js');
```

and replace it with:

```javascript
var {
  computeSavings,
  computeDiscountPct,
  formatMoney,
  formatDiscount,
  validateProductInput,
  PRODUCT_SORT_COLUMNS,
  nextSortState,
  selectionCheckboxState
} = require('../products.js');
```

- [ ] **Step 2: Run it to verify it fails**

```bash
node tests/products-pricing.test.js
```
Expected: a failure on the `PRODUCT_SORT_COLUMNS` assertion — the value is `undefined` because it is not exported yet.

- [ ] **Step 3: Add the pure functions**

In `products.js`, insert immediately **before** the comment line `/* Node export shim — inert in the browser. */` (if the shim's comment differs slightly, insert immediately before the `if(typeof module!=='undefined'&&module.exports){` line):

```javascript
/* ── SORT AND SELECTION LOGIC ──
   Pure helpers, unit-tested. Kept free of DOM and Supabase access. */

// Allow-list. Only these names may ever reach .order(), so a column name
// cannot be injected into the query.
var PRODUCT_SORT_COLUMNS=['barcode','item_name','item_code','mrp','sale_price','discount_pct','savings_amount','updated_at'];

function nextSortState(current, col){
  var safeCurrent=current&&current.col
    ? {col:current.col, asc:current.asc!==false}
    : {col:'item_name', asc:true};

  if(PRODUCT_SORT_COLUMNS.indexOf(col)<0)return safeCurrent;
  if(safeCurrent.col===col)return {col:col, asc:!safeCurrent.asc};
  return {col:col, asc:true};
}

function selectionCheckboxState(selectedCount, visibleCount){
  var sel=Number(selectedCount)||0;
  var vis=Number(visibleCount)||0;
  if(vis===0||sel===0)return {checked:false, indeterminate:false};
  if(sel>=vis)return {checked:true, indeterminate:false};
  return {checked:false, indeterminate:true};
}
```

Then extend the export shim. Find:

```javascript
    formatDiscount:formatDiscount,
    validateProductInput:validateProductInput
  };
}
```
and replace with:

```javascript
    formatDiscount:formatDiscount,
    validateProductInput:validateProductInput,
    PRODUCT_SORT_COLUMNS:PRODUCT_SORT_COLUMNS,
    nextSortState:nextSortState,
    selectionCheckboxState:selectionCheckboxState
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node tests/products-pricing.test.js
```
Expected: `products pricing tests passed`

- [ ] **Step 5: Confirm the other suites still pass**

```bash
node tests/stripe-webhook.test.js
node --check products.js
```
Expected: `stripe-webhook signature tests passed`, then no output from `node --check`.

- [ ] **Step 6: Commit**

```bash
git add products.js tests/products-pricing.test.js
git -c user.name="satishkumarkengam-cpu" -c user.email="kengam4s@gmail.com" commit -m "Add product sort and selection state logic with tests"
```

---

### Task 2: Widen the page and restyle the table

**Files:**
- Modify: `index.html` (new CSS only)

**Interfaces:**
- Produces: CSS classes `pm-toolbar`, `pm-toolbar-actions`, `pm-col-check`, `pm-check`, `pm-sortable`, `pm-sort-ind`, `pm-num`, `pm-wrapcell`, and the scoped width rule. Tasks 3–4 apply these classes.

This task is CSS only, so it is safe to verify visually before any behaviour changes.

- [ ] **Step 1: Add the new CSS**

In `index.html`, find:
```
  .pm-error { color:var(--red); font-size:16px; margin-bottom:10px; display:none; }
```
and replace it with:
```
  .pm-error { color:var(--red); font-size:16px; margin-bottom:10px; display:none; }

  /* ── PRODUCT TABLE: WIDTH AND DENSITY ──
     The app is a 480px mobile-first column (see the `main` rule above), which
     is why the product table scrolled horizontally: the container, not the
     columns, was the constraint. Widen ONLY this panel, and only where there
     is room. Every other tab keeps its 480px layout untouched.
     `.pm-table-wrap` keeps its existing overflow-x:auto deliberately — `auto`
     shows a bar only when content actually overflows, so once the container
     is wide enough the bar simply stops appearing, and narrow screens still
     scroll rather than breaking. */
  @media (min-width:900px){
    main:has(#tab-products.active){ max-width:1400px; }
  }

  .pm-toolbar { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-bottom:10px; }
  .pm-toolbar h2 { font-family:'Cinzel',serif; font-size:16px; font-weight:600; color:var(--gold); letter-spacing:2px; text-transform:uppercase; }
  .pm-toolbar-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .pm-btn-sm { font-family:'Cormorant Garamond',serif; font-size:15px; font-weight:600; padding:6px 14px; border-radius:20px; cursor:pointer; white-space:nowrap; background:rgba(139,94,52,0.08); color:var(--gold); border:1px solid var(--gold); }
  .pm-btn-sm:hover:not(:disabled) { background:rgba(139,94,52,0.16); }
  .pm-btn-sm:disabled { opacity:0.4; cursor:not-allowed; border-color:var(--input-border); color:var(--muted); }
  .pm-btn-sm.danger { color:var(--red); border-color:var(--red); background:var(--red-light); }
  .pm-btn-sm.danger:hover:not(:disabled) { background:rgba(232,90,106,0.24); }

  /* Denser cells and middle alignment so ten columns fit and read cleanly. */
  .pm-table th, .pm-table td { padding:9px 10px; vertical-align:middle; }
  .pm-col-check { width:38px; text-align:center; }
  .pm-check { width:16px; height:16px; cursor:pointer; accent-color:var(--gold); }
  .pm-sortable { cursor:pointer; user-select:none; }
  .pm-sortable:hover { color:var(--gold); }
  .pm-sort-ind { display:inline-block; width:12px; font-size:11px; color:var(--gold); }
  /* Figures right-aligned so they compare down a column. */
  .pm-num { text-align:right; }
  .pm-table th.pm-num { text-align:right; }
  /* Item Name is the one cell allowed to wrap; everything else stays on one
     line so prices, barcodes and dates never break mid-value. */
  .pm-wrapcell { white-space:normal; min-width:180px; }
  .pm-table tbody tr:hover { background:rgba(139,94,52,0.06); }
```

- [ ] **Step 2: Verify the CSS is served and the width rule is present**

```bash
npx -y serve -l 5959 . > ./tmp_serve.log 2>&1 &
sleep 3
curl -s http://localhost:5959/ | grep -c 'main:has(#tab-products.active)'
curl -s http://localhost:5959/ | grep -c 'pm-toolbar-actions'
curl -s http://localhost:5959/ | grep -c 'pm-sort-ind'
echo "--- the existing main rule must be unchanged ---"
curl -s http://localhost:5959/ | grep -c 'main { padding: 14px; max-width: 480px; margin: 0 auto; }'
kill %1
rm -f ./tmp_serve.log
```
Expected: `1`, `1`, `1`, and finally `1` — that last check proves the original `main` rule was left intact rather than edited.

- [ ] **Step 3: Confirm nothing else changed**

```bash
git diff --name-only
```
Expected: only `index.html`.

- [ ] **Step 4: Commit**

```bash
git add index.html
git -c user.name="satishkumarkengam-cpu" -c user.email="kengam4s@gmail.com" commit -m "Widen Products panel on desktop and tighten table density"
```

---

### Task 3: Toolbar and sortable table header markup

**Files:**
- Modify: `index.html` (Products panel markup)

**Interfaces:**
- Consumes: Task 2's CSS classes.
- Produces: DOM ids `pm-check-all`, `pm-delete-selected`; header cells carrying `data-sort` values and `pm-sort-ind` spans. Task 4 reads and updates all of these.

Functions `toggleSelectAllProducts`, `deleteSelectedProducts` and `setProductSort` are referenced here but created in Task 4. Clicking those controls before Task 4 lands logs a ReferenceError; that is expected for staged delivery. Do not stub them.

- [ ] **Step 1: Replace the section header with a toolbar**

In `index.html`, find:
```
      <div class="section-header">
        <h2>Product Catalogue</h2>
        <button class="refresh-btn" onclick="openProductModal()">
          <svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Add Product
        </button>
      </div>
```
and replace it with:
```
      <div class="pm-toolbar">
        <h2>Product Catalogue</h2>
        <div class="pm-toolbar-actions">
          <button class="pm-btn-sm" onclick="openProductModal()">Add Product</button>
          <button class="pm-btn-sm danger" id="pm-delete-selected" disabled onclick="deleteSelectedProducts()">Delete Selected</button>
        </div>
      </div>
```

- [ ] **Step 2: Replace the table header**

In `index.html`, find:
```
          <thead>
            <tr>
              <th>Barcode</th><th>Item Name</th><th>Item Code</th>
              <th>MRP</th><th>Sale Price</th><th>Discount</th><th>Savings</th>
              <th>Last Updated</th><th>Actions</th>
            </tr>
          </thead>
```
and replace it with:
```
          <thead>
            <tr>
              <th class="pm-col-check"><input type="checkbox" class="pm-check" id="pm-check-all" onchange="toggleSelectAllProducts(this)" aria-label="Select all visible products"></th>
              <th class="pm-sortable" data-sort="barcode" onclick="setProductSort('barcode')">Barcode<span class="pm-sort-ind" data-ind="barcode"></span></th>
              <th class="pm-sortable" data-sort="item_name" onclick="setProductSort('item_name')">Item Name<span class="pm-sort-ind" data-ind="item_name"></span></th>
              <th class="pm-sortable" data-sort="item_code" onclick="setProductSort('item_code')">Item Code<span class="pm-sort-ind" data-ind="item_code"></span></th>
              <th class="pm-sortable pm-num" data-sort="mrp" onclick="setProductSort('mrp')">MRP<span class="pm-sort-ind" data-ind="mrp"></span></th>
              <th class="pm-sortable pm-num" data-sort="sale_price" onclick="setProductSort('sale_price')">Sale Price<span class="pm-sort-ind" data-ind="sale_price"></span></th>
              <th class="pm-sortable pm-num" data-sort="discount_pct" onclick="setProductSort('discount_pct')">Discount<span class="pm-sort-ind" data-ind="discount_pct"></span></th>
              <th class="pm-sortable pm-num" data-sort="savings_amount" onclick="setProductSort('savings_amount')">Savings<span class="pm-sort-ind" data-ind="savings_amount"></span></th>
              <th class="pm-sortable" data-sort="updated_at" onclick="setProductSort('updated_at')">Updated<span class="pm-sort-ind" data-ind="updated_at"></span></th>
              <th>Actions</th>
            </tr>
          </thead>
```

- [ ] **Step 3: Verify**

```bash
npx -y serve -l 5959 . > ./tmp_serve.log 2>&1 &
sleep 3
curl -s http://localhost:5959/ | grep -c 'id="pm-check-all"'
curl -s http://localhost:5959/ | grep -c 'id="pm-delete-selected"'
curl -s http://localhost:5959/ | grep -c 'data-sort="savings_amount"'
curl -s http://localhost:5959/ | grep -o 'data-ind="[a-z_]*"' | wc -l
curl -s http://localhost:5959/ | grep -c 'Last Updated' || echo "0 - header shortened as intended"
kill %1
rm -f ./tmp_serve.log
```
Expected: `1`, `1`, `1`, then `8` sort indicators, and the last check reporting `0`.

- [ ] **Step 4: Commit**

```bash
git add index.html
git -c user.name="satishkumarkengam-cpu" -c user.email="kengam4s@gmail.com" commit -m "Add Products toolbar and sortable table header"
```

---

### Task 4: Selection, sorting and bulk delete behaviour

**Files:**
- Modify: `products.js`

**Interfaces:**
- Consumes: Task 1's `PRODUCT_SORT_COLUMNS`, `nextSortState`, `selectionCheckboxState`; Task 3's DOM ids; existing `formatMoney`, `formatDiscount`, `isProductAdmin`, `escapeHtml`, `sb`, `currentOrgId`, `loadProducts`, `deleteProduct`, `openProductModal`.
- Produces: `selectedProductIds()`, `toggleProductSelectionAt(el, i)`, `toggleSelectAllProducts(el)`, `setProductSort(col)`, `refreshSortIndicators()`, `refreshSelectionUi()`, `deleteSelectedProducts()`.

- [ ] **Step 1: Add sort and selection state to productsState**

Find:
```javascript
var productsState={page:0, search:'', filter:'all', total:0, rows:[]};
var productSearchTimer=null;
```
and replace with:
```javascript
var productsState={page:0, search:'', filter:'all', total:0, rows:[], sort:{col:'item_name', asc:true}};
var productSearchTimer=null;

/* Selection is scoped to the currently visible page and cleared whenever the
   visible set changes. "Select All" means what is on screen, and clearing on
   navigation makes it structurally impossible to bulk-delete rows the user
   cannot see. Keyed by product id. */
var productsSelected={};
```

Note there is a second place `productsState` is assigned — inside `applyFeaturePermissions`, which resets it on logout. Update that too. Find:
```javascript
    productsState={page:0, search:'', filter:'all', total:0, rows:[]};
```
and replace with:
```javascript
    productsState={page:0, search:'', filter:'all', total:0, rows:[], sort:{col:'item_name', asc:true}};
    productsSelected={};
```

- [ ] **Step 2: Apply sorting in the query**

Find:
```javascript
  var from=productsState.page*PRODUCTS_PAGE_SIZE;
  return q.order('item_name',{ascending:true}).range(from,from+PRODUCTS_PAGE_SIZE-1);
```
and replace with:
```javascript
  // Sorting is applied server-side so it orders the whole catalogue. Sorting
  // only the fetched page would be actively misleading across pagination.
  // The column is re-checked against the allow-list here as well, so nothing
  // outside it can reach .order() even if state were tampered with.
  var sort=productsState.sort||{col:'item_name', asc:true};
  var col=PRODUCT_SORT_COLUMNS.indexOf(sort.col)>=0?sort.col:'item_name';
  var asc=sort.asc!==false;

  var from=productsState.page*PRODUCTS_PAGE_SIZE;
  return q.order(col,{ascending:asc}).range(from,from+PRODUCTS_PAGE_SIZE-1);
```

- [ ] **Step 3: Clear selection and refresh indicators on every load**

Find:
```javascript
  tbody.innerHTML=rows.map(renderProductRow).join('');
```
and replace with:
```javascript
  tbody.innerHTML=rows.map(renderProductRow).join('');
  refreshSelectionUi();
  refreshSortIndicators();
```

Then find:
```javascript
  var rows=res.data||[];
  // Cached so deleteProduct() can show a product's real name without having
  // to round-trip HTML-escaped text back out of an onclick attribute.
  productsState.rows=rows;
```
and replace with:
```javascript
  var rows=res.data||[];
  // Cached so deleteProduct() can show a product's real name without having
  // to round-trip HTML-escaped text back out of an onclick attribute.
  productsState.rows=rows;
  // The visible set just changed, so any prior selection no longer refers to
  // what is on screen.
  productsSelected={};
```

- [ ] **Step 4: Add the checkbox cell and column classes to each row**

Find:
```javascript
  return '<tr>'+
    '<td class="pm-mono">'+escapeHtml(p.barcode)+'</td>'+
    '<td>'+escapeHtml(p.item_name)+'</td>'+
    '<td class="pm-mono">'+escapeHtml(p.item_code||'—')+'</td>'+
    '<td class="pm-strike">'+formatMoney(p.mrp)+'</td>'+
    '<td class="pm-sale">'+formatMoney(p.sale_price)+'</td>'+
    '<td><span class="pm-badge'+(zero?' zero':'')+'">'+formatDiscount(p.discount_pct)+'</span></td>'+
    '<td>'+formatMoney(p.savings_amount)+'</td>'+
    '<td>'+escapeHtml(updated)+'</td>'+
```
and replace with:
```javascript
  return '<tr>'+
    '<td class="pm-col-check">'+(admin
      ? '<input type="checkbox" class="pm-check" data-row="'+i+'" onchange="toggleProductSelectionAt(this,'+i+')" aria-label="Select product">'
      : '')+'</td>'+
    '<td class="pm-mono">'+escapeHtml(p.barcode)+'</td>'+
    '<td class="pm-wrapcell">'+escapeHtml(p.item_name)+'</td>'+
    '<td class="pm-mono">'+escapeHtml(p.item_code||'—')+'</td>'+
    '<td class="pm-strike pm-num">'+formatMoney(p.mrp)+'</td>'+
    '<td class="pm-sale pm-num">'+formatMoney(p.sale_price)+'</td>'+
    '<td class="pm-num"><span class="pm-badge'+(zero?' zero':'')+'">'+formatDiscount(p.discount_pct)+'</span></td>'+
    '<td class="pm-num">'+formatMoney(p.savings_amount)+'</td>'+
    '<td>'+escapeHtml(updated)+'</td>'+
```

- [ ] **Step 5: Add the selection, sorting and bulk-delete functions**

Insert immediately **before** the `/* ── ADD / EDIT / DELETE ── */` comment:

```javascript
/* ── SELECTION ── */

function selectedProductIds(){
  return Object.keys(productsSelected);
}

/* Dispatched by row index rather than by an id interpolated into the
   attribute — an integer cannot carry a payload. */
function toggleProductSelectionAt(el, i){
  var p=productsState.rows[i];
  if(!p)return;
  if(el.checked)productsSelected[p.id]=true;
  else delete productsSelected[p.id];
  refreshSelectionUi();
}

function toggleSelectAllProducts(el){
  var rows=productsState.rows||[];
  productsSelected={};
  if(el.checked){
    rows.forEach(function(p){ productsSelected[p.id]=true; });
  }
  document.querySelectorAll('#pm-tbody .pm-check').forEach(function(cb){ cb.checked=el.checked; });
  refreshSelectionUi();
}

/* Drives the master checkbox and the Delete Selected button from the current
   counts. Kept in one place so the two can never disagree. */
function refreshSelectionUi(){
  var count=selectedProductIds().length;
  var visible=(productsState.rows||[]).length;

  var all=document.getElementById('pm-check-all');
  if(all){
    var s=selectionCheckboxState(count, visible);
    all.checked=s.checked;
    all.indeterminate=s.indeterminate;
  }

  var btn=document.getElementById('pm-delete-selected');
  if(btn){
    btn.disabled=count===0||!isProductAdmin();
    btn.textContent=count>0?('Delete Selected ('+count+')'):'Delete Selected';
  }
}

/* ── SORTING ── */

function setProductSort(col){
  productsState.sort=nextSortState(productsState.sort, col);
  productsState.page=0;
  productsSelected={};
  loadProducts();
}

function refreshSortIndicators(){
  var sort=productsState.sort||{col:'item_name', asc:true};
  document.querySelectorAll('#tab-products .pm-sort-ind').forEach(function(el){
    var col=el.getAttribute('data-ind');
    el.textContent=(col===sort.col)?(sort.asc?'▲':'▼'):'';
  });
}

/* ── BULK DELETE ── */

async function deleteSelectedProducts(){
  if(!isProductAdmin()){ alert('Only the store owner can delete products.'); return; }

  var ids=selectedProductIds();
  if(!ids.length)return;

  if(!confirm('Delete '+ids.length+' selected product'+(ids.length===1?'':'s')+'? This cannot be undone.'))return;

  var btn=document.getElementById('pm-delete-selected');
  if(btn)btn.disabled=true;

  // .select('id') so a zero-row result is detectable: PostgREST reports no
  // error when an RLS USING clause filters every candidate row out.
  var res=await sb.from('products').delete().in('id',ids).eq('org_id',currentOrgId).select('id');

  if(res.error){
    alert('Could not delete: '+res.error.message);
    refreshSelectionUi();
    return;
  }

  var removed=(res.data||[]).length;
  if(removed===0){
    alert('Nothing was deleted. The products may already have been removed, or your subscription may no longer be active.');
  }else if(removed<ids.length){
    alert('Deleted '+removed+' of '+ids.length+' selected products. The rest may already have been removed, or your subscription may no longer be active.');
  }

  productsSelected={};
  loadProducts();
}
```

- [ ] **Step 6: Verify**

Use targeted presence checks rather than total occurrence counts. An exact count is brittle — it changes whenever a comment mentions the identifier — and a wrong expected number causes a false failure.

```bash
node tests/products-pricing.test.js
node tests/stripe-webhook.test.js
node --check products.js && echo "syntax OK"

for fn in selectedProductIds toggleProductSelectionAt toggleSelectAllProducts refreshSelectionUi setProductSort refreshSortIndicators deleteSelectedProducts; do
  grep -q "function $fn" products.js && echo "OK  $fn defined" || echo "MISSING  $fn"
done

grep -q "var productsSelected={};" products.js && echo "OK  selection state declared" || echo "MISSING selection state"
grep -q "\.in('id',ids)" products.js && echo "OK  bulk delete scoped by id list" || echo "MISSING bulk delete"
grep -q "\.in('id',ids).eq('org_id',currentOrgId).select('id')" products.js && echo "OK  bulk delete is org-scoped and detects zero rows" || echo "MISSING org scope or select('id')"
grep -q "order('item_name',{ascending:true})" products.js && echo "PROBLEM hard-coded sort still present" || echo "OK  hard-coded sort replaced"
grep -q "function clearProductSelection" products.js && echo "PROBLEM dead function present" || echo "OK  no dead selection helper"
tail -3 products.js
```
Expected: both suites pass, `syntax OK`, seven `OK  <fn> defined` lines, then `OK` for each of the remaining five checks with no `PROBLEM` or `MISSING` lines, and `tail -3` showing the export shim still last.

- [ ] **Step 7: Commit**

```bash
git add products.js
git -c user.name="satishkumarkengam-cpu" -c user.email="kengam4s@gmail.com" commit -m "Add row selection, bulk delete and column sorting"
```

---

### Task 5: End-to-end verification and push

**Files:** none — verification only.

- [ ] **Step 1: Confirm no forbidden file changed**

```bash
git diff --name-only 80f4953..HEAD
```
Expected: only `index.html`, `products.js`, `tests/products-pricing.test.js` and files under `docs/`. **`app.js`, `auth.js`, `pricescan.js`, `netlify.toml` and `migration_step4.sql` must not appear.**

- [ ] **Step 2: Confirm the existing `main` rule was not edited**

```bash
grep -c 'main { padding: 14px; max-width: 480px; margin: 0 auto; }' index.html
```
Expected: `1`

- [ ] **Step 3: Run both suites and syntax-check**

```bash
node tests/products-pricing.test.js
node tests/stripe-webhook.test.js
node --check products.js && node --check app.js && node --check auth.js && echo "all JS OK"
```
Expected: two pass lines then `all JS OK`.

- [ ] **Step 4: Browser verification at desktop widths**

Serve locally (`npx -y serve -l 5959 .`) and confirm in a real browser:
- No console errors on load.
- At 1920×1080 and at 1366×768 with the Products tab active, `document.querySelector('.pm-table-wrap').scrollWidth` is **not greater than** its `clientWidth` — that is the actual definition of "no horizontal scrollbar", and it is stronger than eyeballing it.
- All ten header cells are visible.
- With the Scan tab active, `main`'s computed `max-width` is still `480px` — proving the widening is scoped to the Products panel only.
- `toggleSelectAllProducts`, `toggleProductSelectionAt`, `setProductSort`, `deleteSelectedProducts`, `refreshSelectionUi` are all functions, and the existing `switchTab`, `startCamera`, `loadUnmatched`, `handleLogin`, `loadProducts`, `openProductModal`, `deleteProduct` still are too.

- [ ] **Step 5: Manual checks (human, signed in as an owner)**

- No horizontal scrollbar on the Products table; all ten columns readable.
- Search still filters; each filter chip still works; pagination still works.
- Clicking a column header sorts it, clicking again reverses, and the ▲/▼ indicator follows.
- Selecting some rows puts the master checkbox in the indeterminate state; selecting all makes it checked.
- Delete Selected is disabled at zero selection and shows a live count otherwise.
- Bulk delete asks for confirmation, removes exactly the selected rows, and the table refreshes.
- Row Edit and row Delete still work.
- Changing page, search, filter or sort clears the selection.
- The Scan, Inventory, Report and Price Scan tabs look and behave exactly as before.

- [ ] **Step 6: Push**

```bash
git push -u origin products-table-ux
```
