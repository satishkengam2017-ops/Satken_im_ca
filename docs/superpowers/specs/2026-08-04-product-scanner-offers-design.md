# Product Scanner & Offers — Design

## Goal

Add a pricing-catalogue feature to the existing SATKEN app: staff scan a barcode, see the product's MRP / Sale Price / Discount / Savings, and show the customer a large sale display. Admins manage that catalogue in bulk via Excel/CSV upload, optimised for a monthly price-update cycle.

This is an **add-on module**. The existing application is the source of truth for architecture, and its current behaviour must remain byte-for-byte intact.

## Existing architecture (inspected, not assumed)

| Concern | Current implementation |
|---|---|
| Frontend | Static SPA: `index.html` (markup + all CSS inline in one `<style>` block), `auth.js`, `app.js`. No framework, no build step, no npm, no bundler. |
| Screens | `#auth-screen`, `#reset-password-screen`, `#trial-gate-screen`, `#app-shell`, toggled via `style.display`. |
| Navigation | `.tab-bar` with 3 `.tab-btn`s → `switchTab(name)` toggles `.tab-panel#tab-<name>`. Lazy loads via `if(name==='x')loadX()`. |
| Auth | Supabase Auth. Globals: `currentUser`, `currentOrgId`, `currentOrgName`, `currentUserRole` (`'owner'` \| `'member'`), `currentOrgSubStatus`. |
| Database | `organizations`, `org_members`, `invites`, `inventory_items`, `unmatched_scans`, view `unmatched_report`. |
| RLS pattern | `org_id in (select org_id from org_members where user_id = auth.uid()) and org_is_active(org_id)`. |
| Server logic | Postgres RPCs (`increment_scan`, `accept_invite_or_create_org`, `org_is_active`) + 2 Netlify functions for Stripe. |
| Barcode scanning | **Already present**: `vendor/zxing.js` (UMD, `window.ZXingBrowser`), configured for EAN-13, EAN-8, UPC-A, UPC-E, CODE-128, CODE-39, ITF, DATA_MATRIX, QR. |
| CSV handling | **Already present** as globals in `app.js`: `decodeFileBuffer()` (handles Excel's Windows-1252 output), `parseUploadLine()`, `csvField()`, `escapeHtml()`. |
| Third-party JS | supabase-js loaded from jsdelivr CDN; zxing vendored locally. |
| Deployment | Netlify. `netlify.toml`: `publish = "."`, `functions = "netlify/functions"`. |

## Constraints

- No framework, no build step, no npm dependency, no bundler. New third-party code loads by `<script>` tag, matching the existing pattern.
- `inventory_items`, `unmatched_scans`, `unmatched_report`, `increment_scan` and the entire stock-counting workflow are **not modified**.
- No second authentication system. Existing `org_members.role` is the permission source.
- No changes to `netlify.toml` or the Netlify deployment model.
- MRP and Sale Price are the only pricing sources of truth. Discount % and Savings Amount are always derived, never authored.

## Why a new `products` table

The spec asks to reuse an existing product table if one fits. `inventory_items` does not fit:

1. It has no Item Code, MRP, or Sale Price columns.
2. Decisively: the existing "Upload Inventory" flow (`processInventoryCSV`) **deletes every `inventory_items` row for the org** to begin a fresh stock count, and `resetCounts()` does the same. Pricing stored there would be destroyed on every stock count.
3. The two datasets have different lifecycles — stock counts reset frequently; the price catalogue persists and is revised monthly.

A separate table is therefore genuinely required. The migration is purely additive: it creates one table, one trigger, and one function, and alters nothing that already exists.

## Data model

`migration_step4.sql` — additive only.

```sql
create table products (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  barcode        text not null,
  item_name      text not null,
  item_code      text,
  mrp            numeric(12,2) not null,
  sale_price     numeric(12,2) not null,
  savings_amount numeric(12,2) generated always as (mrp - sale_price) stored,
  discount_pct   numeric(5,2)  generated always as (round(((mrp - sale_price) / mrp) * 100, 2)) stored,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint products_org_barcode_key    unique (org_id, barcode),
  constraint products_mrp_positive       check (mrp > 0),
  constraint products_sale_price_nonneg  check (sale_price >= 0),
  constraint products_sale_le_mrp        check (sale_price <= mrp)
);
```

**Generated columns, not stored values.** `savings_amount` and `discount_pct` are Postgres `GENERATED ALWAYS ... STORED`. They cannot be written to by any client, so they cannot drift from MRP/Sale Price — this satisfies "calculated rather than independent sources of truth" at the database level rather than by convention. `mrp > 0` guarantees the discount expression can never divide by zero. `sale_price <= mrp` makes invalid pricing physically unstorable through any code path, including a direct SQL write.

Indexes: `(org_id)` for listing, `(org_id, item_code)` for code lookups. The `unique (org_id, barcode)` constraint already indexes barcode lookups, which is the scanner's hot path.

`updated_at` is maintained by a `before update` trigger so the "Last Updated" column and the "Recently Updated" filter are reliable.

### RLS

Follows the existing pattern exactly, with the write half narrowed to owners:

- `select` — any member of the org, gated by `org_is_active(org_id)`
- `insert` / `update` / `delete` — members whose `org_members.role = 'owner'`, gated by `org_is_active(org_id)`

Permissions are enforced in the database, not merely hidden in the UI. A staff account cannot write products even by calling the API directly.

### Import RPC

```
import_products(p_org_id uuid, p_rows jsonb, p_mode text) returns jsonb
```

- `p_mode` is `'upsert'` (update existing + add new — the default monthly workflow) or `'replace'` (additionally delete org products whose barcode is absent from the file — Clear & Replace).
- `SECURITY INVOKER`, so RLS applies and non-owners are rejected by the database. It additionally raises a clear exception when the caller is not an owner, so the UI can show a useful message instead of a silent zero-row result.
- Re-validates every row server-side (missing/invalid barcode, name, MRP, sale price; sale price > MRP; duplicate barcodes within the payload) and raises on the first failure.
- Returns `{"added": n, "updated": n, "removed": n}`.

**Atomicity.** A PL/pgSQL function body executes inside a single transaction. Any raised exception rolls the whole thing back. This is what makes the §35 requirement real: a 1,500-row file with one invalid row changes nothing at all. Client-side chunked `upsert` calls could not provide this guarantee, which is why the import goes through an RPC rather than the PostgREST table endpoint.

## File layout

New files:

| File | Responsibility |
|---|---|
| `migration_step4.sql` | `products` table, indexes, RLS, `updated_at` trigger, `import_products` RPC |
| `products.js` | Product data access, management table, search/filter, manual add/edit/delete, permission gating, shared price maths |
| `pricescan.js` | Lookup scanner (camera + manual), result/not-found rendering, customer-window handoff |
| `stock.js` | Import/export: file parsing, validation, diff preview, Clear & Replace, Delete All |
| `customer.html` | Standalone customer-facing sale showcase |
| `tests/products-pricing.test.js` | Unit tests for the pure logic |

Each file has one clear responsibility and can be read without holding the others in mind. `app.js` is already 587 lines; none of this is added to it.

Changes to existing files, in full:

- **`index.html`** — 2 tab buttons, 2 `.tab-panel` divs, 2 modals (add/edit product; Delete All confirmation), 4 `<script>` tags (`products.js`, `pricescan.js`, `stock.js`, SheetJS CDN), 1 CSS media query.
- **`auth.js`** — one line at the end of `resolveOrgAndEnterApp()`:
  `if(typeof applyFeaturePermissions==='function')applyFeaturePermissions();`
  Guarded so it is inert if the module fails to load.
- **`app.js`** — **no changes.** New tabs call `switchTab('products'); loadProducts()` directly from their `onclick`, reusing the existing tab machinery without editing it.
- **`netlify.toml`** — **no changes.** `publish = "."` already serves `customer.html`.

## Navigation

Two tabs are added to the existing `.tab-bar`: **Price Scan** and **Products**. Product management and bulk stock operations share the Products panel as two sections, because bulk upload is an operation *on* the product list rather than a separate domain — this keeps the tab count at five instead of six.

Five uppercase 16px labels do not fit a 375px phone. One media query below 480px reduces `.tab-btn` font-size and letter-spacing. This is the only change touching existing visual styling; the three existing tabs keep working and simply render slightly smaller on narrow screens.

The **Products** tab is hidden for `member` (staff) accounts.

## Price calculation

Defined once, in `products.js`, and used by every screen:

```
savings  = mrp - salePrice
discount = round(((mrp - salePrice) / mrp) * 100)
```

The database stores `discount_pct` at 2 decimals using this same formula, so client and server never disagree on the underlying value. Discount is *displayed* as a whole number (`25% OFF`) on the scanner and customer screens, where a fractional percent reads as noise; the management table and both export formats carry the stored 2-decimal value so a downloaded file round-trips exactly. Savings displays at 2 decimals everywhere. Currency is a single `CURRENCY_SYMBOL = '$'` constant so it can be changed in one place.

Staff enter only MRP and Sale Price. Discount and Savings update live in the add/edit form as read-only computed text.

## Phase 1 — Products foundation

Delivers the table, the migration, and manual product management.

**Products tab, management section:**
- Table columns: Barcode, Item Name, Item Code, MRP, Sale Price, Discount %, Savings, Last Updated, Actions (View / Edit / Delete)
- Search across barcode, item name, item code (single input, `ilike` server-side)
- Filters: On Sale, No Discount, High Discount (≥25%), Recently Updated (last 30 days)
- Paged at 100 rows per page, following the existing `.range()` paging approach used by `fetchAllUnmatched()`
- Empty state reusing `.empty-state`

**Add / Edit product modal** (reuses `.modal-bg` / `.modal`): Barcode, Item Name, Item Code, MRP, Sale Price, with live Discount/Savings readout. Client-side validation mirrors the database constraints so users get an inline message rather than a Postgres error. Delete asks for confirmation.

All write controls are hidden for staff accounts.

## Phase 2 — Scanner & customer showcase

**Price Scan tab.** Reuses the existing `.camera-card` markup/CSS and the already-vendored ZXing library, in a **separate reader instance** with its own `<video>` element. The existing counting scanner in `app.js` is untouched and the two never share state. Critically, this scanner performs a **lookup only** — it never calls `increment_scan` and never affects stock counts.

Flow: request camera → scan → on first successful decode, stop the camera → look up `products` by `(org_id, barcode)` → render result. A manual barcode input with a Search button sits alongside, for damaged or unreadable barcodes.

**Found:** Item Name, Item Code, Barcode, MRP (struck through), Sale Price (dominant), Discount % badge, Savings Amount. Actions: **SHOW CUSTOMER**, **Scan Another**.

**Not found:** shows the scanned barcode verbatim, with **Scan Again** and **Enter Barcode**; plus **Add Product** for owners only, which opens the Phase 1 modal pre-filled with that barcode. No product information is ever inferred or invented.

**Customer display.** `SHOW CUSTOMER` calls `window.open('customer.html', 'satken-customer')` — a named window, so repeat clicks reuse the same tab rather than spawning new ones. The product is pushed over a `BroadcastChannel('satken-customer')`, so the staff member keeps scanning on their device and the customer screen updates live. The product is also written to `localStorage` under `satken_customer_product` so a freshly opened window renders immediately, before any broadcast arrives.

`customer.html` is a standalone same-origin page carrying its own copy of the theme variables. It contains no admin controls, no navigation, and no data access — it only renders what it is sent, so nothing privileged is reachable from it. A single unobtrusive **Exit** control closes the window.

Layout: two-column MRP / SALE PRICE comparison at ≥600px, stacked vertically below that. Sale Price is the largest element on screen; MRP is secondary and struck through; Discount % is prominent; Savings is clearly legible. Sized to stay readable on a tablet or a wall-mounted display.

## Phase 3 — Bulk stock management

**Column mapping.** Header-based and case-insensitive, tolerant of common variants (`barcode` / `item barcode`; `item name` / `name`; `item code` / `code` / `sku`; `mrp`; `sale price` / `selling price` / `offer price`). Required: Barcode, Item Name, MRP, Sale Price. Item Code is optional. A missing required column fails the whole file with a named message.

**Formats.** CSV reuses the existing `decodeFileBuffer()` + `parseUploadLine()` helpers. XLSX/XLS uses SheetJS loaded by `<script>` from its official CDN, matching how supabase-js is already loaded — no build step is introduced.

**Validation.** Per row:

*Errors (block the import):* missing barcode; barcode failing the app's existing `BARCODE_RE`; missing item name; missing/non-numeric MRP; MRP ≤ 0; missing/non-numeric Sale Price; negative Sale Price; Sale Price > MRP; barcode duplicated within the file.

*Warnings (import proceeds):* missing item code; item code duplicated within the file; a Discount % column present in the file (accepted as informational and recalculated from MRP/Sale Price); Sale Price equal to MRP (0% discount).

**Preview before writing.** Selecting a file never touches the database. The client parses and validates, fetches the org's current products, and shows: totals (rows / valid / warnings / errors); a per-row table with status; and a price-change diff listing New, Updated (old → new MRP and Sale Price), Unchanged, and — in Clear & Replace mode — Removed. Import is disabled while any error exists. Only on explicit confirmation is the single atomic RPC called.

**Download current stock.** Exports Barcode, Item Name, Item Code, MRP, Sale Price, Discount %, Savings Amount as CSV or XLSX. The exported file re-imports cleanly, which is what makes the monthly cycle work: download → edit in Excel → upload → review → confirm.

**Clear & Replace** runs the same validated preview and then calls the RPC in `'replace'` mode, so removals and upserts land in one transaction. **Delete All Stock** is owner-only, states the current product count, and requires typing `DELETE ALL` before the button enables.

## Error handling

Every failure surfaces a specific, human-readable message; nothing fails silently. Covered: product not found; invalid barcode; camera permission denied; no camera present; camera in use; unreadable/invalid CSV; unreadable/invalid XLSX; missing required column; empty file; duplicate barcode; invalid MRP; invalid Sale Price; Sale Price > MRP; RPC/network failure; permission denied. Camera errors reuse the existing `NotAllowedError` / `NotFoundError` handling already proven in `startCamera()`.

## Testing

The repository has no test framework by design. Pure logic is therefore written as standalone functions and tested with plain Node `assert`, matching the existing `tests/stripe-webhook.test.js` pattern: price maths, row validation, header mapping, and the current-vs-incoming diff. Everything else is verified manually against the checklist in §41 of the request, with explicit regression checks that login, the three existing tabs, stock counting, and the Stripe flow all still work.

## Out of scope

Product images and image upload; Import History; Price History; multi-currency; offline scanning; POS integration. Each is separable and none is required by the workflows above.
