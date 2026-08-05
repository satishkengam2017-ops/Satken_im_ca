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
