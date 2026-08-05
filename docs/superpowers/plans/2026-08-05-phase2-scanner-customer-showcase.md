# Phase 2 — Scanner & Customer Showcase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let staff scan or type a barcode, see that product's MRP / Sale Price / Discount / Savings, and push a large customer-facing sale display to a second screen.

**Architecture:** Purely additive, same as Phase 1. One new browser module `pricescan.js` and one new standalone page `customer.html`. `index.html` gains a Price Scan tab, its panel, `ps-`-prefixed CSS and one script tag. The already-vendored ZXing library drives a **second, independent** reader instance with its own `<video>` element, so the existing stock-count scanner in `app.js` is untouched and the two never share state. Staff and customer screens are linked by a `BroadcastChannel`, with `localStorage` as the seed and cross-tab fallback.

**Tech Stack:** Vanilla HTML/CSS/JS (no framework, no build step, no npm), vendored ZXing (`vendor/zxing.js`, `window.ZXingBrowser`), Supabase REST, Netlify static hosting.

## Global Constraints

- No new npm dependencies, no build step, no bundler, no new third-party library — ZXing is already vendored and already configured for UPC-A, UPC-E, EAN-13, EAN-8 and CODE-128.
- `app.js`, `auth.js`, `netlify.toml`, `products.js` and `migration_step4.sql` must have **zero** changes. This phase needs no migration — the `products` table already exists.
- The existing stock-counting workflow must be untouched. **This scanner performs lookup only: it must never call `increment_scan` and must never write to `inventory_items` or `unmatched_scans`.**
- New CSS classes must be prefixed `ps-`. Do not edit any existing CSS rule.
- `pricescan.js` must have no top-level DOM or Supabase access, and must end with a `module.exports` shim, so Node can `require()` it for unit tests.
- Discount % and Savings Amount displayed anywhere must come from the database's generated columns (`discount_pct`, `savings_amount`) or from `products.js`'s shared helpers. **Never invent, round up, or recompute a more flattering discount.** If a value is missing, show nothing rather than a guess.
- `customer.html` must contain no admin controls, no navigation into the app, and no Supabase access — it renders only what it is sent.
- Permissions come from the existing `org_members.role`. Price Scan is available to **both** owner and member (staff) accounts — the customer's requirements grant Staff "Look up product, View pricing, Show customer display". Only the "Add Product" affordance on the not-found screen is owner-only.
- All commits authored as `satishkumarkengam-cpu <kengam4s@gmail.com>`.
- Repo root: `C:\Users\satis\OneDrive\Desktop\satken_im_ca` (git repo, remote `satishkengam2017-ops/Satken_im_ca`).

## Interfaces available from Phase 1 (already shipped, do not redefine)

From `products.js`: `CURRENCY_SYMBOL`, `PRODUCT_BARCODE_RE`, `computeSavings(mrp,salePrice)`, `computeDiscountPct(mrp,salePrice)`, `formatMoney(n)`, `formatDiscount(pct)`, `isProductAdmin()`, `openProductModal(id, prefillBarcode)`.
From `app.js`: `escapeHtml(s)`, `switchTab(name)`, `stopCamera()`.
From `auth.js`: `sb`, `currentOrgId`, `currentUserRole`.
`products` table columns: `id, org_id, barcode, item_name, item_code, mrp, sale_price, savings_amount, discount_pct, created_at, updated_at`.

---

### Task 1: Lookup and payload logic (TDD)

**Files:**
- Create: `pricescan.js`
- Create: `tests/pricescan.test.js`

**Interfaces:**
- Produces: `PRICESCAN_CHANNEL` (`'satken-customer'`), `PRICESCAN_STORAGE_KEY` (`'satken_customer_product'`), `normalizeBarcode(raw)`, `classifyBarcode(raw)`, `buildCustomerPayload(product)`. Tasks 2–4 consume all of these.

- [ ] **Step 1: Write the failing test**

Create `tests/pricescan.test.js`:

```javascript
// Plain Node script (no test framework), matching the other suites.
// Run with: node tests/pricescan.test.js
var assert = require('assert');
var {
  PRICESCAN_CHANNEL,
  PRICESCAN_STORAGE_KEY,
  normalizeBarcode,
  classifyBarcode,
  buildCustomerPayload
} = require('../pricescan.js');

assert.strictEqual(PRICESCAN_CHANNEL, 'satken-customer', 'channel name is stable');
assert.strictEqual(PRICESCAN_STORAGE_KEY, 'satken_customer_product', 'storage key is stable');

// ── normalizeBarcode ──
assert.strictEqual(normalizeBarcode('  8901234567890 '), '8901234567890', 'trims whitespace');
assert.strictEqual(normalizeBarcode('cof-500'), 'COF-500', 'uppercases');
assert.strictEqual(normalizeBarcode(''), '', 'empty stays empty');
assert.strictEqual(normalizeBarcode(null), '', 'null becomes empty');
assert.strictEqual(normalizeBarcode(undefined), '', 'undefined becomes empty');

// ── classifyBarcode ──
assert.strictEqual(classifyBarcode('  ').status, 'empty', 'whitespace only is empty');
assert.strictEqual(classifyBarcode('8901234567890').status, 'ok', 'a plain barcode is ok');
assert.strictEqual(classifyBarcode('COF-500').status, 'ok', 'hyphens allowed');
assert.strictEqual(classifyBarcode('AB$%^').status, 'invalid', 'illegal characters rejected');
assert.strictEqual(classifyBarcode('  cof-500 ').barcode, 'COF-500', 'returns the normalized form');

// ── buildCustomerPayload ──
var row = {
  id:'abc', org_id:'org1', barcode:'8901234567890',
  item_name:'Premium Coffee 500g', item_code:'COF-500',
  mrp:'19.99', sale_price:'14.99', discount_pct:'25.01', savings_amount:'5.00'
};
var payload = buildCustomerPayload(row);
assert.strictEqual(payload.itemName, 'Premium Coffee 500g', 'carries item name');
assert.strictEqual(payload.itemCode, 'COF-500', 'carries item code');
assert.strictEqual(payload.barcode, '8901234567890', 'carries barcode');
assert.strictEqual(payload.mrp, '19.99', 'carries MRP verbatim from the database');
assert.strictEqual(payload.salePrice, '14.99', 'carries sale price verbatim');
assert.strictEqual(payload.discountPct, '25.01', 'carries the database-generated discount, not a recomputed one');
assert.strictEqual(payload.savingsAmount, '5.00', 'carries the database-generated savings');
assert.strictEqual(typeof payload.sentAt, 'number', 'stamps a send time');

// Internal ids must never reach the customer screen.
assert.strictEqual(payload.id, undefined, 'does not leak the row id');
assert.strictEqual(payload.org_id, undefined, 'does not leak the org id');

assert.strictEqual(buildCustomerPayload(null), null, 'null product yields null payload');

var noCode = buildCustomerPayload({barcode:'1', item_name:'X', item_code:null, mrp:'5', sale_price:'5', discount_pct:'0.00', savings_amount:'0.00'});
assert.strictEqual(noCode.itemCode, '', 'missing item code becomes empty string, not null');

console.log('pricescan tests passed');
```

- [ ] **Step 2: Run it to verify it fails**

```bash
node tests/pricescan.test.js
```
Expected: `Error: Cannot find module '../pricescan.js'`

- [ ] **Step 3: Create pricescan.js**

```javascript
/* ══════════════════════════════════════════════════════════════
   PRICE SCAN — staff-facing barcode lookup against the products
   catalogue, plus the handoff to the customer-facing display.

   LOOKUP ONLY. This module never calls increment_scan and never
   writes to inventory_items or unmatched_scans — the existing
   stock-count scanner in app.js owns all of that.

   No top-level DOM or Supabase access, so Node can require() this
   file for unit tests. Wiring is via inline onclick in index.html.
   ══════════════════════════════════════════════════════════════ */

var PRICESCAN_CHANNEL='satken-customer';
var PRICESCAN_STORAGE_KEY='satken_customer_product';

function normalizeBarcode(raw){
  if(raw===null||raw===undefined)return '';
  return String(raw).trim().toUpperCase();
}

function classifyBarcode(raw){
  var barcode=normalizeBarcode(raw);
  if(!barcode)return {status:'empty', barcode:''};
  if(!PRODUCT_BARCODE_RE.test(barcode))return {status:'invalid', barcode:barcode};
  return {status:'ok', barcode:barcode};
}

/* The payload sent to the customer screen. Prices and the derived discount
   are copied verbatim from the database row — discount_pct and
   savings_amount are generated columns, so they are authoritative and must
   never be recomputed into something more flattering here. Internal ids are
   deliberately excluded: the customer window has no need for them. */
function buildCustomerPayload(p){
  if(!p)return null;
  return {
    itemName:p.item_name||'',
    itemCode:p.item_code||'',
    barcode:p.barcode||'',
    mrp:p.mrp,
    salePrice:p.sale_price,
    discountPct:p.discount_pct,
    savingsAmount:p.savings_amount,
    sentAt:Date.now()
  };
}

/* Node export shim — inert in the browser. Later tasks append code ABOVE
   this block; it must stay last in the file. */
if(typeof module!=='undefined'&&module.exports){
  module.exports={
    PRICESCAN_CHANNEL:PRICESCAN_CHANNEL,
    PRICESCAN_STORAGE_KEY:PRICESCAN_STORAGE_KEY,
    normalizeBarcode:normalizeBarcode,
    classifyBarcode:classifyBarcode,
    buildCustomerPayload:buildCustomerPayload
  };
}
```

`classifyBarcode` uses `PRODUCT_BARCODE_RE` from `products.js`, which is not defined under Node. Add this immediately below the two constants, so the module is testable standalone:

```javascript
// products.js owns PRODUCT_BARCODE_RE in the browser; this fallback exists only
// so the module can be required under Node for unit tests.
if(typeof PRODUCT_BARCODE_RE==='undefined'){
  var PRODUCT_BARCODE_RE=/^[A-Za-z0-9\-\.\ ]+$/;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node tests/pricescan.test.js
```
Expected: `pricescan tests passed`

- [ ] **Step 5: Confirm the other suites still pass**

```bash
node tests/products-pricing.test.js
node tests/stripe-webhook.test.js
```
Expected: `products pricing tests passed` and `stripe-webhook signature tests passed`

- [ ] **Step 6: Commit**

```bash
git add pricescan.js tests/pricescan.test.js
git -c user.name="satishkumarkengam-cpu" -c user.email="kengam4s@gmail.com" commit -m "Add price-scan lookup classification and customer payload with tests"
```

---

### Task 2: Price Scan tab, panel and manual lookup

**Files:**
- Modify: `index.html` (tab button, panel, `ps-` CSS, script tag)
- Modify: `pricescan.js` (append lookup + render, before the export shim)

**Interfaces:**
- Consumes: Task 1's `classifyBarcode`, `buildCustomerPayload`; Phase 1's `formatMoney`, `formatDiscount`, `isProductAdmin`, `openProductModal`; `escapeHtml`, `sb`, `currentOrgId`.
- Produces: DOM ids `tab-btn-pricescan`, `tab-pricescan`, `ps-video`, `ps-placeholder`, `ps-scanline`, `ps-status`, `ps-start-btn`, `ps-stop-btn`, `ps-manual-barcode`, `ps-result`; functions `lookupProductByBarcode(raw)`, `renderScanResult(result)`, `submitManualBarcode()`, `scanAnother()`, `psCurrentProduct` state. Task 3 adds the camera; Task 4 adds `showCustomer()`.

- [ ] **Step 1: Add the Price Scan tab button**

In `index.html`, find:
```
    <button class="tab-btn" data-tab="products" id="tab-btn-products" style="display:none" onclick="switchTab('products'); loadProducts()">Products</button>
  </div>
```
and replace with:
```
    <button class="tab-btn" data-tab="products" id="tab-btn-products" style="display:none" onclick="switchTab('products'); loadProducts()">Products</button>
    <button class="tab-btn" data-tab="pricescan" id="tab-btn-pricescan" onclick="switchTab('pricescan')">Price Scan</button>
  </div>
```
No permission gating: Price Scan is available to staff and owners alike.

- [ ] **Step 2: Add the Price Scan panel**

In `index.html`, find:
```
      <div class="pm-pager" id="pm-pager" style="display:none">
        <button class="btn btn-outline" id="pm-prev" onclick="productsPrevPage()">Previous</button>
        <span class="pm-pageinfo" id="pm-pageinfo"></span>
        <button class="btn btn-outline" id="pm-next" onclick="productsNextPage()">Next</button>
      </div>
    </div>

  </main>
```
and replace with:
```
      <div class="pm-pager" id="pm-pager" style="display:none">
        <button class="btn btn-outline" id="pm-prev" onclick="productsPrevPage()">Previous</button>
        <span class="pm-pageinfo" id="pm-pageinfo"></span>
        <button class="btn btn-outline" id="pm-next" onclick="productsNextPage()">Next</button>
      </div>
    </div>

    <!-- ══════════ PRICE SCAN TAB ══════════ -->
    <div class="tab-panel" id="tab-pricescan">
      <div class="section-header"><h2>Scan Product</h2></div>
      <p class="ps-hint">Point your camera at the product barcode.</p>

      <div class="camera-card">
        <div class="video-wrap">
          <video id="ps-video" autoplay playsinline muted></video>
          <div class="viewfinder">
            <div class="corner tl"></div><div class="corner tr"></div>
            <div class="corner bl"></div><div class="corner br"></div>
            <div id="ps-scanline" class="ps-scanline"></div>
          </div>
          <div class="placeholder-icon" id="ps-placeholder">
            <svg viewBox="0 0 24 24" stroke-width="1.2"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><rect x="7" y="7" width="10" height="10" rx="1"/></svg>
            <p>Camera off</p>
          </div>
        </div>
        <div class="camera-footer">
          <span id="ps-status">Tap Start to scan</span>
          <button class="btn btn-gold" id="ps-start-btn" onclick="startPriceScanCamera()">
            <svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            Start
          </button>
          <button class="btn btn-outline" id="ps-stop-btn" onclick="stopPriceScanCamera()" style="display:none">
            <svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
            Stop
          </button>
        </div>
      </div>

      <div class="section-header"><h2>Enter Barcode Manually</h2></div>
      <div class="manual-row" style="margin-bottom:14px">
        <input class="manual-input" id="ps-manual-barcode" type="text" inputmode="numeric"
               placeholder="Barcode number" style="flex:1">
        <button class="btn-add" onclick="submitManualBarcode()">Search</button>
      </div>

      <div id="ps-result"></div>
    </div>

  </main>
```

- [ ] **Step 3: Add the `ps-` CSS**

In `index.html`, find:
```
  #pm-modal .modal { max-height:90dvh; overflow-y:auto; }
```
and replace with:
```
  #pm-modal .modal { max-height:90dvh; overflow-y:auto; }

  /* ── PRICE SCAN (add-on module) ── */
  .ps-hint { font-size:17px; color:var(--muted); margin-bottom:10px; }
  /* The existing video styling is an #video ID selector, so it does not reach
     this element — restate it rather than widening the existing rule. */
  #ps-video { width:100%; height:100%; object-fit:cover; display:block; }
  /* Own scan line: #scan-line belongs to the stock-count scanner in app.js and
     is toggled by that module, so this scanner must not share it. The `sweep`
     keyframes it animates are already defined globally in this stylesheet. */
  .ps-scanline { position:absolute;left:20px;right:20px;height:2px;background:linear-gradient(90deg,transparent,var(--gold),transparent);display:none;animation:sweep 2s ease-in-out infinite;box-shadow:0 0 8px var(--gold); }
  .ps-card { background:var(--surface); border:1px solid var(--border); border-radius:16px; box-shadow:var(--card-shadow); padding:18px; margin-bottom:14px; }
  .ps-card.notfound { border-color:var(--warn); }
  .ps-name { font-family:'Cinzel',serif; font-size:22px; font-weight:600; color:var(--text); margin-bottom:4px; }
  .ps-meta { font-family:'JetBrains Mono',monospace; font-size:14px; color:var(--muted); margin-bottom:2px; }
  .ps-prices { display:flex; align-items:baseline; gap:12px; margin:14px 0 6px; flex-wrap:wrap; }
  .ps-mrp { font-family:'JetBrains Mono',monospace; font-size:20px; color:var(--dim); text-decoration:line-through; }
  .ps-sale { font-family:'Cinzel',serif; font-size:38px; font-weight:700; color:var(--gold); text-shadow:0 0 16px var(--gold-glow); line-height:1.1; }
  .ps-offer { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:14px; }
  .ps-discount { display:inline-block; background:var(--gold); color:#FFF8E7; font-family:'Cinzel',serif; font-size:15px; font-weight:700; letter-spacing:1px; padding:4px 12px; border-radius:20px; }
  .ps-savings { font-size:18px; font-weight:600; color:var(--green); }
  .ps-actions { display:flex; gap:8px; flex-wrap:wrap; }
  .ps-actions .btn { flex:1 1 45%; justify-content:center; }
  .ps-notfound-title { font-family:'Cinzel',serif; font-size:20px; font-weight:600; color:var(--warn); margin-bottom:6px; }
  .ps-error { color:var(--red); font-size:17px; }
```

- [ ] **Step 4: Load the module**

In `index.html`, find:
```
<script src="products.js"></script>
```
and replace with:
```
<script src="products.js"></script>
<script src="pricescan.js"></script>
```

- [ ] **Step 5: Append the lookup and render logic to pricescan.js**

Insert immediately **before** the `module.exports` shim:

```javascript
/* ── LOOKUP ── */

var psCurrentProduct=null;
var psLookupSeq=0;

async function lookupProductByBarcode(raw){
  var check=classifyBarcode(raw);
  if(check.status!=='ok')return check;

  var res=await sb.from('products').select('*')
    .eq('org_id',currentOrgId).eq('barcode',check.barcode).maybeSingle();

  if(res.error)return {status:'error', barcode:check.barcode, message:res.error.message};
  if(!res.data)return {status:'notfound', barcode:check.barcode};
  return {status:'found', barcode:check.barcode, product:res.data};
}

async function runLookup(raw){
  var seq=++psLookupSeq;
  var statusEl=document.getElementById('ps-status');
  var resultEl=document.getElementById('ps-result');
  resultEl.innerHTML='<div class="ps-card">Looking up…</div>';

  var result=await lookupProductByBarcode(raw);
  if(seq!==psLookupSeq)return; // a newer scan superseded this lookup

  if(statusEl)statusEl.textContent=(result.status==='found')
    ? 'Found: '+result.product.item_name
    : 'Tap Start to scan';
  renderScanResult(result);
}

function submitManualBarcode(){
  var el=document.getElementById('ps-manual-barcode');
  runLookup(el.value);
}

function scanAnother(){
  psCurrentProduct=null;
  document.getElementById('ps-result').innerHTML='';
  var el=document.getElementById('ps-manual-barcode');
  if(el)el.value='';
  var statusEl=document.getElementById('ps-status');
  if(statusEl)statusEl.textContent='Tap Start to scan';
}

function focusManualBarcode(){
  var el=document.getElementById('ps-manual-barcode');
  if(el){ el.value=''; el.focus(); }
}

/* ── RENDER ── */

function renderScanResult(result){
  var el=document.getElementById('ps-result');
  psCurrentProduct=null;

  if(result.status==='empty'){
    el.innerHTML='<div class="ps-card"><div class="ps-error">Enter or scan a barcode first.</div></div>';
    return;
  }

  if(result.status==='invalid'){
    el.innerHTML='<div class="ps-card"><div class="ps-error">That barcode contains characters we don\'t recognise. Letters, numbers, "-", "." and spaces only.</div></div>';
    return;
  }

  if(result.status==='error'){
    el.innerHTML='<div class="ps-card"><div class="ps-error">Could not look that up: '+escapeHtml(result.message||'unknown error')+'</div></div>';
    return;
  }

  if(result.status==='notfound'){
    el.innerHTML='<div class="ps-card notfound">'+
      '<div class="ps-notfound-title">Product Not Found</div>'+
      '<div class="ps-meta">Barcode: '+escapeHtml(result.barcode)+'</div>'+
      '<div class="ps-actions" style="margin-top:14px">'+
        '<button class="btn btn-gold" onclick="scanAnother()">Scan Again</button>'+
        '<button class="btn btn-outline" onclick="focusManualBarcode()">Enter Barcode</button>'+
        (isProductAdmin()
          ? '<button class="btn btn-outline" onclick="addProductForScannedBarcode()">Add Product</button>'
          : '')+
      '</div>'+
    '</div>';
    return;
  }

  var p=result.product;
  psCurrentProduct=p;

  // Discount and savings come from the database's generated columns. If either
  // is absent we omit that line rather than computing a substitute — an
  // invented discount would be worse than none.
  var hasOffer=Number(p.discount_pct)>0;

  el.innerHTML='<div class="ps-card">'+
    '<div class="ps-name">'+escapeHtml(p.item_name)+'</div>'+
    (p.item_code?'<div class="ps-meta">Item Code: '+escapeHtml(p.item_code)+'</div>':'')+
    '<div class="ps-meta">Barcode: '+escapeHtml(p.barcode)+'</div>'+
    '<div class="ps-prices">'+
      '<span class="ps-mrp">MRP '+formatMoney(p.mrp)+'</span>'+
      '<span class="ps-sale">'+formatMoney(p.sale_price)+'</span>'+
    '</div>'+
    (hasOffer
      ? '<div class="ps-offer">'+
          '<span class="ps-discount">'+formatDiscount(p.discount_pct)+' OFF</span>'+
          '<span class="ps-savings">You Save '+formatMoney(p.savings_amount)+'</span>'+
        '</div>'
      : '')+
    '<div class="ps-actions">'+
      '<button class="btn btn-gold" onclick="showCustomer()">Show Customer</button>'+
      '<button class="btn btn-outline" onclick="scanAnother()">Scan Another</button>'+
    '</div>'+
  '</div>';
}

function addProductForScannedBarcode(){
  var barcode=normalizeBarcode(document.getElementById('ps-manual-barcode').value);
  if(!barcode){
    // Came from a camera scan rather than the manual field — recover it from
    // the rendered not-found card.
    var meta=document.querySelector('#ps-result .ps-meta');
    if(meta)barcode=normalizeBarcode(meta.textContent.replace(/^Barcode:\s*/,''));
  }
  openProductModal(null, barcode);
}
```

- [ ] **Step 6: Verify**

```bash
node tests/pricescan.test.js
node tests/products-pricing.test.js
npx -y serve -l 5959 . > ./tmp_serve.log 2>&1 &
sleep 3
curl -s http://localhost:5959/ | grep -c 'id="tab-btn-pricescan"'
curl -s http://localhost:5959/ | grep -c 'id="ps-result"'
curl -s http://localhost:5959/ | grep -c 'pricescan.js'
curl -s http://localhost:5959/pricescan.js | grep -c 'function renderScanResult'
kill %1
rm -f ./tmp_serve.log
```
Expected: both suites pass, then `1`, `1`, `1`, `1`.

`showCustomer()` and `startPriceScanCamera()` do not exist yet (Tasks 3 and 4). That is expected for staged delivery; clicking those buttons logs a ReferenceError until those tasks land. Do not stub them.

- [ ] **Step 7: Commit**

```bash
git add index.html pricescan.js
git -c user.name="satishkumarkengam-cpu" -c user.email="kengam4s@gmail.com" commit -m "Add Price Scan tab with manual barcode lookup and result rendering"
```

---

### Task 3: Camera scanner (independent ZXing instance)

**Files:**
- Modify: `pricescan.js` (append before the export shim)

**Interfaces:**
- Consumes: `window.ZXingBrowser` (already vendored), `runLookup` and `scanAnother` from Task 2, `stopCamera()` from `app.js`.
- Produces: `startPriceScanCamera()`, `stopPriceScanCamera()`, `onPriceScanDetected(code)`.

The existing stock-count scanner in `app.js` owns the globals `codeReader` and `controls` and the element `#video`. This scanner must use its own reader variable and its own `#ps-video`, and must stop the other scanner before starting, because a phone will not grant the same camera to two readers at once.

- [ ] **Step 1: Append the camera logic**

Insert immediately **before** the `module.exports` shim:

```javascript
/* ── CAMERA ──
   A second, independent ZXing reader. app.js owns `codeReader`/`controls` and
   the #video element for stock counting; this module owns psCodeReader and
   #ps-video and never touches those. Both scanners cannot hold the camera at
   once, so starting this one stops that one first. */

var psCodeReader=null;

function startPriceScanCamera(){
  var zx=window.ZXingBrowser||window.ZXing;
  var statusEl=document.getElementById('ps-status');
  if(!zx){ statusEl.textContent='Scanner library error — please refresh.'; return; }

  // Release the camera from the stock-count scanner if it is running.
  if(typeof stopCamera==='function'){
    try{ stopCamera(); }catch(e){}
  }

  var btn=document.getElementById('ps-start-btn');
  btn.disabled=true;
  statusEl.textContent='Starting camera…';

  try{
    var hints=new Map();
    var formats=[
      zx.BarcodeFormat.EAN_13,
      zx.BarcodeFormat.EAN_8,
      zx.BarcodeFormat.UPC_A,
      zx.BarcodeFormat.UPC_E,
      zx.BarcodeFormat.CODE_128,
      zx.BarcodeFormat.CODE_39,
      zx.BarcodeFormat.ITF
    ].filter(Boolean);
    if(formats.length>0)hints.set(zx.DecodeHintType?zx.DecodeHintType.POSSIBLE_FORMATS:2, formats);
    psCodeReader=new zx.BrowserMultiFormatReader(hints);
  }catch(e){
    statusEl.textContent='Scanner error: '+e.message;
    btn.disabled=false;
    return;
  }

  psCodeReader.decodeFromConstraints(
    {video:{facingMode:'environment',width:{ideal:1280},height:{ideal:720}}},
    document.getElementById('ps-video'),
    function(result,err){ if(result)onPriceScanDetected(result.getText()); }
  ).then(function(){
    document.getElementById('ps-placeholder').style.display='none';
    document.getElementById('ps-scanline').style.display='block';
    document.getElementById('ps-start-btn').style.display='none';
    document.getElementById('ps-stop-btn').style.display='';
    statusEl.textContent='Point camera at a barcode…';
  }).catch(function(err){
    var msg='Camera error.';
    if(err.name==='NotAllowedError')msg='Camera permission denied — allow camera access in your browser settings.';
    else if(err.name==='NotFoundError')msg='No camera found on this device.';
    else if(err.name==='NotReadableError')msg='Camera is in use by another app or tab.';
    else msg='Camera error: '+err.message;
    statusEl.textContent=msg;
    btn.disabled=false;
  });
}

function stopPriceScanCamera(){
  if(psCodeReader){ try{ psCodeReader.reset(); }catch(e){} psCodeReader=null; }
  var ph=document.getElementById('ps-placeholder');
  if(ph)ph.style.display='flex';
  var line=document.getElementById('ps-scanline');
  if(line)line.style.display='none';
  var start=document.getElementById('ps-start-btn');
  var stop=document.getElementById('ps-stop-btn');
  if(start){ start.style.display=''; start.disabled=false; }
  if(stop)stop.style.display='none';
}

/* One successful decode is enough: stop the camera, then look the product up.
   This is a price check, not a counting session, so it must not keep firing. */
function onPriceScanDetected(code){
  var barcode=normalizeBarcode(code);
  if(!barcode||barcode.length<6)return;
  stopPriceScanCamera();
  var statusEl=document.getElementById('ps-status');
  if(statusEl)statusEl.textContent='Scanned '+barcode+' — looking up…';
  var manual=document.getElementById('ps-manual-barcode');
  if(manual)manual.value=barcode;
  runLookup(barcode);
}
```

- [ ] **Step 2: Verify**

```bash
node tests/pricescan.test.js
node --check pricescan.js
grep -c 'psCodeReader' pricescan.js
grep -c "getElementById('ps-video')" pricescan.js
grep -qE 'increment_scan|inventory_items|unmatched_scans' pricescan.js && echo "PROBLEM: writes stock data" || echo "CLEAN: lookup only"
grep -qE "getElementById\('video'\)|\bcodeReader\b" pricescan.js && echo "PROBLEM: touches app.js scanner state" || echo "CLEAN: independent scanner"
tail -3 pricescan.js
```
Expected: test passes, syntax OK, `psCodeReader` on `4` lines, `ps-video` on `1`, then `CLEAN: lookup only` and `CLEAN: independent scanner`, and `tail -3` shows the export shim still last.

Note the two `grep -qE` forms are written so they print only the verdict — a bare `grep -c` would also print a `0`, which reads confusingly next to the word CLEAN.

- [ ] **Step 3: Commit**

```bash
git add pricescan.js
git -c user.name="satishkumarkengam-cpu" -c user.email="kengam4s@gmail.com" commit -m "Add independent camera scanner for price lookup"
```

---

### Task 4: Customer sale showcase

**Files:**
- Create: `customer.html`
- Modify: `pricescan.js` (append `showCustomer` before the export shim)

**Interfaces:**
- Consumes: Task 1's `buildCustomerPayload`, `PRICESCAN_CHANNEL`, `PRICESCAN_STORAGE_KEY`; Task 2's `psCurrentProduct`.
- Produces: `showCustomer()`, and the `customer.html` page.

- [ ] **Step 1: Append the handoff to pricescan.js**

Insert immediately **before** the `module.exports` shim:

```javascript
/* ── CUSTOMER DISPLAY HANDOFF ──
   The customer screen is a separate same-origin window. It is pushed new
   products over a BroadcastChannel so the staff member can keep scanning
   without the window being reopened or refocused; localStorage seeds a
   freshly-opened window and doubles as the fallback for browsers without
   BroadcastChannel (they receive the 'storage' event instead). */

var psChannel=null;
var psCustomerWindow=null;

function getCustomerChannel(){
  if(psChannel)return psChannel;
  if(typeof BroadcastChannel==='undefined')return null;
  psChannel=new BroadcastChannel(PRICESCAN_CHANNEL);
  return psChannel;
}

function showCustomer(){
  if(!psCurrentProduct)return;
  var payload=buildCustomerPayload(psCurrentProduct);

  // Written first so a window opened a moment later renders immediately, and
  // so browsers without BroadcastChannel still update via the storage event.
  try{ localStorage.setItem(PRICESCAN_STORAGE_KEY, JSON.stringify(payload)); }catch(e){}

  var ch=getCustomerChannel();
  if(ch)ch.postMessage(payload);

  // Only open when there is no live window: reopening would steal focus from
  // the staff device mid-scan.
  if(!psCustomerWindow||psCustomerWindow.closed){
    psCustomerWindow=window.open('customer.html','satken-customer');
    if(!psCustomerWindow){
      var statusEl=document.getElementById('ps-status');
      if(statusEl)statusEl.textContent='Allow pop-ups for this site to open the customer display.';
    }
  }
}
```

- [ ] **Step 2: Create customer.html**

```html
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Special Offer</title>
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&family=Cormorant+Garamond:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{
    --bg-deep:#FFF8E7; --bg-mid:#FFFDF5; --bg-black:#E8D5A3;
    --gold:#8B5E34; --gold-glow:rgba(139,94,52,0.25);
    --text:#5C3A21; --muted:rgba(139,94,52,0.6); --dim:rgba(92,58,33,0.35);
    --green:#6DBE8C;
    --surface:rgba(255,250,240,0.75); --border:rgba(139,94,52,0.35);
  }
  html,body{min-height:100%}
  body{
    font-family:'Cormorant Garamond',serif;
    background:radial-gradient(ellipse at top,var(--bg-mid) 0%,var(--bg-deep) 60%,var(--bg-black) 100%);
    background-attachment:fixed;
    color:var(--text);
    display:flex;align-items:center;justify-content:center;
    padding:24px;min-height:100dvh;
  }
  .exit{
    position:fixed;top:12px;right:14px;background:none;border:none;
    font-family:'Cormorant Garamond',serif;font-size:15px;color:var(--muted);
    cursor:pointer;opacity:0.55;
  }
  .exit:hover{opacity:1}
  .wrap{width:100%;max-width:980px;text-align:center}
  .eyebrow{
    font-family:'Cinzel',serif;font-size:15px;font-weight:700;letter-spacing:4px;
    text-transform:uppercase;color:var(--gold);margin-bottom:18px;
  }
  .name{
    font-family:'Cinzel',serif;font-weight:700;color:var(--text);
    font-size:clamp(30px,5.5vw,60px);line-height:1.15;
  }
  .code{
    font-family:'JetBrains Mono',monospace;font-size:clamp(13px,1.4vw,17px);
    color:var(--muted);margin-top:8px;
  }
  .prices{
    display:grid;grid-template-columns:1fr;gap:14px;
    margin:34px auto 0;max-width:760px;
  }
  .cell{
    background:var(--surface);border:1px solid var(--border);border-radius:18px;
    padding:22px 18px;
  }
  .cell .label{
    font-family:'Cinzel',serif;font-size:14px;font-weight:600;letter-spacing:2.5px;
    text-transform:uppercase;color:var(--muted);margin-bottom:8px;
  }
  .mrp{
    font-family:'JetBrains Mono',monospace;color:var(--dim);
    text-decoration:line-through;font-size:clamp(26px,3.4vw,40px);
  }
  .sale{
    font-family:'Cinzel',serif;font-weight:700;color:var(--gold);
    font-size:clamp(52px,9vw,116px);line-height:1;
    text-shadow:0 0 28px var(--gold-glow);
  }
  .discount{
    display:inline-block;margin-top:30px;background:var(--gold);color:#FFF8E7;
    font-family:'Cinzel',serif;font-weight:700;letter-spacing:3px;
    font-size:clamp(22px,3.6vw,44px);padding:10px 30px;border-radius:60px;
  }
  .savings{
    margin-top:18px;font-weight:600;color:var(--green);
    font-size:clamp(20px,2.8vw,34px);
  }
  .idle{font-size:clamp(18px,2.4vw,26px);color:var(--muted)}
  /* Two-column price comparison once there is room; stacked below that. */
  @media (min-width:600px){
    .prices{grid-template-columns:1fr 1fr}
  }
</style>

<button class="exit" onclick="window.close()">Exit customer view</button>

<div class="wrap" id="wrap">
  <div class="idle">Waiting for a product…</div>
</div>

<script>
var STORAGE_KEY='satken_customer_product';
var CHANNEL='satken-customer';

function esc(s){
  return String(s==null?'':s).replace(/[&<>"']/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}

function money(v){
  if(v===null||v===undefined||v==='')return '';
  var n=Number(v);
  if(!isFinite(n))return '';
  return '$'+n.toFixed(2);
}

function render(p){
  var wrap=document.getElementById('wrap');
  if(!p||!p.itemName){
    wrap.innerHTML='<div class="idle">Waiting for a product…</div>';
    return;
  }

  // Discount and savings are shown only when the data actually carries them.
  // Nothing here is computed or embellished.
  var pct=Number(p.discountPct);
  var hasOffer=isFinite(pct)&&pct>0;

  wrap.innerHTML=
    '<div class="eyebrow">'+(hasOffer?'Special Offer':'Price')+'</div>'+
    '<div class="name">'+esc(p.itemName)+'</div>'+
    (p.itemCode?'<div class="code">'+esc(p.itemCode)+'</div>':'')+
    '<div class="prices">'+
      '<div class="cell"><div class="label">MRP</div><div class="mrp">'+esc(money(p.mrp))+'</div></div>'+
      '<div class="cell"><div class="label">Sale Price</div><div class="sale">'+esc(money(p.salePrice))+'</div></div>'+
    '</div>'+
    (hasOffer
      ? '<div class="discount">'+Math.round(pct)+'% OFF</div>'+
        '<div class="savings">You Save '+esc(money(p.savingsAmount))+'</div>'
      : '');
}

function readStored(){
  try{ return JSON.parse(localStorage.getItem(STORAGE_KEY)||'null'); }
  catch(e){ return null; }
}

render(readStored());

if(typeof BroadcastChannel!=='undefined'){
  new BroadcastChannel(CHANNEL).onmessage=function(e){ render(e.data); };
}

// Fallback for browsers without BroadcastChannel, and a safety net if a
// message is posted while this window is still loading.
window.addEventListener('storage',function(e){
  if(e.key===STORAGE_KEY)render(readStored());
});
</script>
```

Netlify serves this at `/customer.html` with no config change, because `netlify.toml` already publishes the repo root.

- [ ] **Step 3: Verify**

```bash
node tests/pricescan.test.js
npx -y serve -l 5959 . > ./tmp_serve.log 2>&1 &
sleep 3
curl -s -o /dev/null -w "customer.html HTTP %{http_code}\n" http://localhost:5959/customer.html
curl -s http://localhost:5959/customer.html | grep -c 'satken-customer'
curl -s http://localhost:5959/customer.html | grep -c 'min-width:600px'
curl -s http://localhost:5959/pricescan.js | grep -c 'function showCustomer'
echo "--- customer.html must contain no admin controls and no Supabase access ---"
curl -s http://localhost:5959/customer.html > ./tmp_cust.html
grep -qE 'supabase|openProductModal|deleteProduct|switchTab|saveProduct' ./tmp_cust.html && echo "PROBLEM: admin surface present" || echo "CLEAN: display only"
rm -f ./tmp_cust.html
kill %1
rm -f ./tmp_serve.log
```
Expected: `HTTP 200`, then `1`, `1`, `1`, and finally `CLEAN: display only`.

- [ ] **Step 4: Commit**

```bash
git add customer.html pricescan.js
git -c user.name="satishkumarkengam-cpu" -c user.email="kengam4s@gmail.com" commit -m "Add customer sale showcase page and staff handoff"
```

---

### Task 5: End-to-end verification and push

**Files:** none — verification only.

- [ ] **Step 1: Confirm no forbidden file changed**

```bash
git diff --name-only 80f4953..HEAD
```
Expected: only `index.html`, `pricescan.js`, `customer.html`, `tests/pricescan.test.js`, and files under `docs/`. **`app.js`, `auth.js`, `products.js`, `netlify.toml` and `migration_step4.sql` must not appear.**

- [ ] **Step 2: Confirm this phase writes no stock data**

A plain `grep` over these files gives a false positive, because their own comments name the forbidden identifiers while explaining why they are never used. Strip comments first so the assertion tests code:

```bash
node -e '
var fs=require("fs");
["pricescan.js","customer.html"].forEach(function(f){
  var src=fs.readFileSync(f,"utf8");
  var code=src.replace(/\/\*[\s\S]*?\*\//g,"").replace(/<!--[\s\S]*?-->/g,"").replace(/^\s*\/\/.*$/gm,"");
  ["increment_scan","inventory_items","unmatched_scans"].forEach(function(t){
    if(code.indexOf(t)>=0)console.log("PROBLEM "+f+" references "+t);
  });
});
console.log("CLEAN: no stock-table writes in either file");
'
```
Expected: only `CLEAN: no stock-table writes in either file`, with no `PROBLEM` lines above it.

- [ ] **Step 3: Run all three suites and syntax-check**

```bash
node tests/pricescan.test.js
node tests/products-pricing.test.js
node tests/stripe-webhook.test.js
node --check pricescan.js && node --check products.js && node --check app.js && node --check auth.js && echo "all JS OK"
```
Expected: three pass lines then `all JS OK`.

- [ ] **Step 4: Browser verification**

Serve locally and confirm in a real browser: no console errors on load; `tab-btn-pricescan` and `tab-pricescan` exist; `startPriceScanCamera`, `stopPriceScanCamera`, `showCustomer`, `runLookup`, `renderScanResult` are all functions; the existing `switchTab`, `startCamera`, `handleScan`, `loadUnmatched`, `handleLogin` are still functions; and `customer.html` renders its "Waiting for a product…" idle state standalone.

- [ ] **Step 5: Manual checks (human)**

Signed in as an owner: open Price Scan, search a known barcode manually, confirm MRP struck through, Sale Price dominant, correct `% OFF` and `You Save`. Click **Show Customer** and confirm a second window opens with the large display; scan/search a different product and confirm that window updates **without** being reopened. Search a barcode that does not exist and confirm the not-found card with **Add Product**. Then sign in as a staff (member) account and confirm Price Scan is available but **Add Product** is absent, and the Products tab stays hidden. Finally confirm the existing Scan tab still counts stock as before, and that using Price Scan did not change any scanned quantity.

- [ ] **Step 6: Push**

```bash
git push origin HEAD
```
