// Plain Node script (no test framework), matching the other suites.
// Run with: node tests/products-import.test.js
var assert = require('assert');
var {
  PRODUCT_CSV_HEADERS,
  mapCsvHeaders,
  parseProductCsv,
  summarizeImport,
  buildSampleCsv,
  importWasRejected,
  friendlyDbMessage
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
// Scientific notation is accepted as a format, so the magnitude ceiling has to
// hold for that form too. Without these the client would pass 5E12 through and
// the database would answer with a raw "numeric field overflow" rather than a
// readable message.
assert.ok(/MRP is too large/i.test(firstError('123456,Item,C,5E12,5')), 'an oversized MRP in scientific notation is caught client-side');
assert.ok(/MRP is too large/i.test(firstError('123456,Item,C,1.5e11,5')), 'lower-case exponent form is caught too');
assert.ok(/Sale Price is too large/i.test(firstError('123456,Item,C,10,5E12')), 'an oversized Sale Price in scientific notation is caught client-side');

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

// ── sub-cent MRP ──
// numeric(12,2) rounds anything under half a cent to 0.00, which then trips
// products_mrp_positive and shows the owner a raw constraint name.
var subCent = parseProductCsv('Barcode,Item Name,Item Code,MRP,Sale Price\n1,A,A1,0.004,0.001');
assert.strictEqual(subCent.rows.length, 0, 'a sub-half-cent MRP is rejected client-side');
assert.ok(/at least 0\.01/.test(subCent.errors[0].message), 'and says so readably');
var oneCent = parseProductCsv('Barcode,Item Name,Item Code,MRP,Sale Price\n1,A,A1,0.01,0.01');
assert.strictEqual(oneCent.rows.length, 1, 'exactly one cent is still allowed');

// The other end of the same problem: within half a cent of the ceiling, the
// value rounds UP past numeric(12,2) and raises 22003 numeric field overflow.
var nearCeiling = parseProductCsv('Barcode,Item Name,Item Code,MRP,Sale Price\n1,A,A1,9999999999.995,10');
assert.strictEqual(nearCeiling.rows.length, 0, 'an MRP that rounds up past the column ceiling is rejected');
var justUnder = parseProductCsv('Barcode,Item Name,Item Code,MRP,Sale Price\n1,A,A1,9999999999.99,10');
assert.strictEqual(justUnder.rows.length, 1, 'the largest storable price is still allowed');

// ── database messages ──
// Anything the client rules missed must still read as English, not as a
// constraint name. Mirrors the mapper products.js uses on the Add/Edit path.
assert.ok(/greater than 0/.test(friendlyDbMessage('new row violates check constraint "products_mrp_positive"')), 'products_mrp_positive is translated');
assert.ok(/greater than MRP/.test(friendlyDbMessage('violates check constraint "products_sale_le_mrp"')), 'products_sale_le_mrp is translated');
assert.ok(/too large/.test(friendlyDbMessage('numeric field overflow')), '22003 is translated');
assert.ok(/store owner/.test(friendlyDbMessage('new row violates row-level security policy')), 'an RLS refusal is translated');
assert.strictEqual(friendlyDbMessage('some unmapped server error'), 'some unmapped server error', 'anything unmapped passes through unchanged');
assert.strictEqual(friendlyDbMessage(null), '', 'a null message does not become "null"');

// ── outcome classification ──
// True only means "Postgres rejected it, so the transaction rolled back and
// nothing was written". Every uncertain case must be false, because false
// tells the owner to go and check rather than promising them nothing changed.
assert.strictEqual(importWasRejected('P0001', 400), true, 'a raise_exception with a 4xx really did roll back');
assert.strictEqual(importWasRejected('23514', 400), true, 'so did a check-constraint violation');
assert.strictEqual(importWasRejected('42501', 403), true, 'so did an RLS refusal');
['08000','08003','08006','08P01'].forEach(function(c){
  assert.strictEqual(importWasRejected(c, 400), false, c + ' is a dead connection, not a rollback we can vouch for');
});
assert.strictEqual(importWasRejected('57P01', 400), false, 'admin shutdown leaves the outcome unknown');
assert.strictEqual(importWasRejected('EPIPE', 400), false, 'a 5-char errno is not a SQLSTATE');
assert.strictEqual(importWasRejected('EPERM', 400), false, 'nor is EPERM');
assert.strictEqual(importWasRejected('P0001', undefined), false, 'no status means the server never answered');
assert.strictEqual(importWasRejected('P0001', 0), false, 'nor does a zero status');
assert.strictEqual(importWasRejected('P0001', 500), false, 'a 5xx is not proof the statement was rejected');
assert.strictEqual(importWasRejected('', 400), false, 'an empty code proves nothing');
assert.strictEqual(importWasRejected('PGRST301', 400), false, 'a PostgREST code is not a SQLSTATE');

console.log('products import tests passed');
