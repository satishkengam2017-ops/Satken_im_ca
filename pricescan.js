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

// products.js owns PRODUCT_BARCODE_RE in the browser; this fallback exists only
// so the module can be required under Node for unit tests.
if(typeof PRODUCT_BARCODE_RE==='undefined'){
  var PRODUCT_BARCODE_RE=/^[A-Za-z0-9\-\.\ ]+$/;
}

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
