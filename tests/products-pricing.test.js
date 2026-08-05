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

var hugeMrp = validateProductInput({barcode:'123456', itemName:'X', mrp:'10000000000', salePrice:'5'});
assert.strictEqual(hugeMrp.valid, false, 'MRP at 1e10 overflows numeric(12,2) and is invalid');
assert.ok(hugeMrp.errors.some(function(e){return /MRP is too large/.test(e);}), 'reports oversized MRP');

var hugeSale = validateProductInput({barcode:'123456', itemName:'X', mrp:'9999999999', salePrice:'10000000000'});
assert.strictEqual(hugeSale.valid, false, 'Sale Price at 1e10 overflows numeric(12,2) and is invalid');

var maxOk = validateProductInput({barcode:'123456', itemName:'X', mrp:'9999999999.99', salePrice:'100'});
assert.strictEqual(maxOk.valid, true, 'the largest value numeric(12,2) accepts is still valid');

console.log('products pricing tests passed');
