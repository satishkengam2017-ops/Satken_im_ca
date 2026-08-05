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
