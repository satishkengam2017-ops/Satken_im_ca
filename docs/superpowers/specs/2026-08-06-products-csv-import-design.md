# Product CSV import and sample download — Design

## Goal

Let an owner populate and update the product catalogue from a CSV file instead of adding products one at a time, and give them a correctly-shaped sample file to start from.

## What already exists

This is mostly wiring, not new machinery:

- **`import_products(p_org_id uuid, p_rows jsonb, p_mode text)`** is already live in the production database (created by `migration_step4.sql`). It re-validates every row server-side, runs inside a single transaction so a bad file changes nothing, enforces owner-only access and the billing gate, and returns `{"added":n,"updated":n,"removed":n}`. `'upsert'` mode updates existing barcodes and inserts new ones without deleting anything.
- **`decodeFileBuffer()`** in `app.js` already handles Excel's habit of exporting CSV as Windows-1252 rather than UTF-8, and strips a BOM.
- **`parseUploadLine()`** in `app.js` already parses a CSV line with quoted fields.
- **`downloadSampleInventoryCSV()`** in `app.js` is the established pattern for a Blob-based sample download.

No schema change is required. The only database work is replacing one function body (see below).

## Required database change

`migration_step5.sql` — a single `create or replace function import_products(...)`, no table changes.

The live function's numeric pre-check is:

```
'^-?([0-9]+(\.[0-9]*)?|\.[0-9]+)$'
```

This rejects scientific notation (`1.2E+3`) and a leading `+`, both of which Postgres's own `::numeric` cast accepts and **which Excel emits for large numbers**. Until CSV import shipped this was harmless because nothing called the RPC; the moment it ships, a real spreadsheet export can be rejected with "non-numeric MRP or Sale Price" for a cell that looks perfectly valid. The replacement widens it to:

```
'^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$'
```

Comma-thousands values such as `1,299.00` remain rejected, with the existing clear message. Stripping commas is genuinely ambiguous across locales — in much of Europe `1,5` means one-and-a-half — so silently reinterpreting them could corrupt prices.

## Scope

**In:** CSV only. Sample download. Upload with client-side validation, a summary, and explicit confirmation before anything is written. Upsert mode.

**Out:** XLSX (needs a third-party library; stays with the fuller Phase 3 import). Clear & Replace. Row-by-row preview tables and price-change diffs. Import history. Export.

## Columns

The sample file and the importer use the five columns a client may actually write:

```
Barcode,Item Name,Item Code,MRP,Sale Price
```

Discount % and Savings Amount are deliberately absent. They are Postgres generated columns — a client cannot write them, and inviting someone to fill them in would only produce confusion about which value wins. The importer therefore **ignores unrecognised columns** rather than erroring on them, so a file that happens to carry Discount/Savings (for example a future export) still imports cleanly.

Header matching is case-insensitive and tolerant of common variants: `barcode`/`item barcode`; `item name`/`name`; `item code`/`code`/`sku`; `mrp`; `sale price`/`selling price`/`offer price`. Barcode, Item Name, MRP and Sale Price are required; a missing one fails the whole file with a message naming the column. Item Code is optional.

## Flow

Choose file → parse → validate → fetch the org's existing barcodes → summarise → confirm → one atomic RPC call → refresh the table.

The summary is what makes this safe to ship:

> **240 rows** · 12 new · 228 updates · 0 errors

Splitting "240 rows" into new versus updates is the point of fetching existing barcodes first. That second number is what tells an owner whether they are about to rewrite their entire catalogue because they picked the wrong file. Existing barcodes are fetched with the paging approach already used by `fetchAllUnmatched()`, since PostgREST caps a single response at 1000 rows.

Deliberately "updates", not "price updates": an upsert replaces Item Name and Item Code as well, so an old export re-imported to correct prices would silently revert every product renamed since. Naming only prices would understate what the owner is agreeing to.

If any row has an error, the Import button is disabled and the first five errors are listed with their line numbers. Warnings do not block.

## Validation

Client-side rules mirror the database constraints, so the user sees a readable message rather than a Postgres constraint violation.

*Errors — block the import:* missing barcode; barcode failing the app's existing `PRODUCT_BARCODE_RE`; missing item name; missing, non-numeric, or zero/negative MRP; missing, non-numeric, or negative Sale Price; Sale Price greater than MRP; MRP or Sale Price at or above `MAX_PRICE` (10^10, the `numeric(12,2)` ceiling); the same barcode appearing twice in the file; a missing required header.

*Warnings — do not block:* missing Item Code; the same Item Code on more than one row.

Server-side validation in the RPC is unchanged and still runs. The client checks exist for message quality, not as the security boundary.

## Permissions

Owner-only, which is already true structurally: the Products tab is hidden from staff, and the `products` RLS policies restrict writes to `role = 'owner'`. The RPC additionally raises a clear exception for a non-owner caller. No new permission surface.

## Files

- **`migration_step5.sql`** — the widened numeric pre-check, as a function replacement.
- **`productsimport.js`** — new. Header mapping, CSV parsing, validation, summary building, and the import flow. `products.js` is already about 450 lines and this is a distinct job, so it gets its own file, following the precedent set by `pricescan.js`.
- **`index.html`** — two toolbar buttons, a hidden file input, the summary modal, `pi-`-prefixed CSS, one script tag.
- **`tests/products-import.test.js`** — new.

`app.js`, `auth.js`, `products.js`, `pricescan.js`, `netlify.toml` and `migration_step4.sql` are untouched.

## Testing

Three pure functions carry unit tests in the existing plain-Node style:

- `mapCsvHeaders(cells)` → `{map, error}`; covering exact names, case and spacing variants, accepted synonyms, unknown columns being ignored, and each missing required column.
- `parseProductCsv(text)` → `{rows, errors, warnings}`; covering a clean file, quoted fields containing commas, CRLF line endings, a blank trailing line, and one case per validation rule above.
- `summarizeImport(rows, existingBarcodes)` → `{total, added, updated}`; covering all-new, all-updates, a mix, an empty file, and case-insensitive matching against existing barcodes (the database stores them upper-cased).

`productsimport.js` must contain no top-level DOM or Supabase access and must end with a `module.exports` shim, so Node can require it — the same constraint the other modules follow.

It also needs `PRODUCT_BARCODE_RE` and `MAX_PRICE`, both of which live in `products.js` and exist as browser globals at runtime but are undefined under Node. As `pricescan.js` already does for the barcode pattern, the module declares `typeof`-guarded fallbacks so it stays independently requireable rather than depending on script load order. Without this the test file cannot load the module at all.

The remaining behaviour is DOM and Supabase work, which this project has no framework to test and verifies manually: the sample file's headers parse cleanly through `mapCsvHeaders` with no error (checked as a unit test rather than by importing the sample, which would create three example products in the live catalogue); a valid file imports and the table refreshes; a file with an invalid row is rejected with the Import button disabled and the offending line numbers shown; a file whose Sale Price exceeds MRP is caught client-side rather than surfacing a Postgres error; and — once `migration_step5.sql` has been run — a file containing `1.2E+3` is accepted rather than rejected as non-numeric.

## Branch

`products-csv-import`, branched from `products-table-ux` (PR #2), shipping as a stacked PR. The toolbar these buttons live in exists only on that branch.
