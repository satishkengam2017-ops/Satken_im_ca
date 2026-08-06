# Product Catalogue table UX — Design

## Goal

Make the Product Catalogue table usable on a desktop: no horizontal scrollbar, multi-row selection with bulk delete, clickable column sorting, and a proper toolbar — without changing any other page or losing any existing behaviour.

## Root cause of the horizontal scrollbar

`index.html:169` sets `main { padding:14px; max-width:480px; margin:0 auto; }`. The entire application is a 480px mobile-first column, so the Products table is squeezed narrower than a phone screen is wide. The scrollbar is not a column-sizing problem; the container is the problem. No amount of padding reduction fits ten columns into 480px, so the container must widen for this page.

## Two requirements that did not previously exist

- **Sorting.** The request asks to "ensure sorting continues to work", but there was no user-controllable sorting — `buildProductsQuery` hard-codes `.order('item_name',{ascending:true})`. Sorting is therefore new work in this change, not a preserved behaviour.
- **Export.** Not present on the Products page, and deliberately **out of scope** here: Phase 3 already specifies a CSV + XLSX export whose format round-trips back into the bulk importer. Building a second, different export now would duplicate that work and risk two incompatible formats.

## Constraints

- No framework, no build step, no npm dependency. Plain browser JavaScript, matching the existing ES5-ish style.
- `app.js`, `auth.js`, `pricescan.js`, `netlify.toml` and `migration_step4.sql` must have **zero** changes. No schema change is required.
- Do not edit the existing `main` rule or any other existing CSS rule. New rules are added; new classes stay `pm-`-prefixed.
- `products.js` must keep no top-level DOM or Supabase access, and its `module.exports` shim must stay last, so Node can `require()` it for tests.
- Every existing behaviour must survive: search, filters, pagination, row edit, row delete, and the owner-only permission gating.

## Container width

```css
@media (min-width:900px){
  main:has(#tab-products.active){ max-width:1400px; }
}
```

Only the Products panel widens, and only at ≥900px. This is additive and more specific than the existing `main` rule, which is left alone — so Scan, Inventory, Report and Price Scan are unaffected.

`.pm-table-wrap`'s existing `overflow-x:auto` is left exactly as it is, and that is the point: `auto` shows a scrollbar only when content actually overflows. Once the container is wide enough for all ten columns the bar simply stops appearing, with no rule change needed. Below 900px it still scrolls, which is correct — ten columns cannot fit a phone, the requirement targets a standard desktop, and narrow screens degrade rather than break. A browser without `:has()` support likewise degrades to exactly today's behaviour.

## Table layout

Columns: **checkbox · Barcode · Item Name · Item Code · MRP · Sale Price · Discount · Savings · Updated · Actions**

- Cell padding reduced from `10px 12px` to `9px 10px`.
- MRP, Sale Price, Discount and Savings right-aligned — conventional for figures and easier to scan down a column.
- `vertical-align:middle` on all header and body cells.
- Item Name may wrap; all other cells stay `nowrap` so prices, barcodes and dates never break mid-value.
- "Last Updated" becomes "Updated" to reclaim width.
- The checkbox column is fixed-width and centred.

## Selection model

Selection is **scoped to the currently visible page** and is cleared whenever the visible set changes — page change, search, filter, or sort change.

This is deliberate rather than incidental. "Select All" is specified as selecting currently visible products, and clearing on navigation makes it structurally impossible to bulk-delete rows the user cannot see. A selection that silently persisted across a filter change would be a data-loss trap.

State lives in `productsSelected`, an object keyed by product id. The master checkbox derives its state from the selected count versus the visible count: unchecked at zero, checked when all visible rows are selected, and **indeterminate** in between.

Row checkboxes and row actions dispatch by **array index**, not by interpolating an id into an attribute. This follows the pattern established by Phase 1's review: HTML entities decode before an attribute is compiled as JavaScript, so escaping alone does not protect that string boundary, whereas an integer index cannot carry a payload.

## Bulk delete

Enabled only when at least one row is selected. On click: a confirmation dialog naming the count, then a single scoped delete, then an automatic refresh.

```js
sb.from('products').delete().in('id', ids).eq('org_id', currentOrgId).select('id')
```

`.select('id')` is required, and the returned row count is compared against the requested count. PostgREST reports success with zero rows when an RLS `USING` clause filters every candidate out — so without this check, a lapsed subscription or a row deleted on another device would report a successful delete while changing nothing. A partial result is reported honestly rather than treated as success.

## Sorting

`productsState.sort` holds `{col, asc}`, defaulting to `{col:'item_name', asc:true}` — the current behaviour, so nothing changes until a user clicks.

Sortable columns: `barcode`, `item_name`, `item_code`, `mrp`, `sale_price`, `discount_pct`, `savings_amount`, `updated_at`. Clicking a header sorts ascending; clicking the same header again reverses. A ▲/▼ indicator marks the active column.

Sorting is applied **server-side** through `.order()`, so it orders the whole catalogue. Sorting only the fetched page would be actively misleading once there is more than one page. Changing sort resets to page 1 and clears selection.

Only these eight column names may reach `.order()`, validated against an allow-list, so a column name can never be injected into the query.

## Toolbar

The Products section header becomes a toolbar with **Add Product** and **Delete Selected** aligned right.

Delete Selected remains visible but disabled at zero selection, rather than appearing and disappearing — a control that vanishes makes the toolbar jump and hides the feature's existence. Its label carries a live count: `Delete Selected (3)`.

## Files

- `products.js` — selection state, sort state, bulk delete, master-checkbox logic; modifications to `buildProductsQuery`, `loadProducts` and `renderProductRow`.
- `index.html` — toolbar markup, table header with checkbox and sortable columns, new `pm-` CSS and the scoped width rule.
- `tests/products-pricing.test.js` — tests for the two new pure functions.

## Testing

Two pure functions carry unit tests in the existing plain-Node style:

- `nextSortState(current, col)` → `{col, asc}`; same column flips `asc`, a different column starts ascending.
- `selectionCheckboxState(selectedCount, visibleCount)` → `{checked, indeterminate}`; covering zero, partial, all, and the empty-table case.

The remaining work is DOM and Supabase behaviour, which this project has no framework to test and verifies manually — consistent with how Phases 1 and 2 were handled. Manual verification covers: no horizontal scrollbar at 1920×1080 and 1366×768; all ten columns visible; search, filters, pagination, row edit and row delete all still working; selection clearing on navigation; indeterminate master checkbox; bulk delete removing exactly the selected rows; and the other four tabs rendering unchanged.

## Out of scope

Export (Phase 3), column reordering, column show/hide, saved views, inline editing, and selection persisting across pages.
