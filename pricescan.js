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
