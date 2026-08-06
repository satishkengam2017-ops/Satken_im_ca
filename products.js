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

// Mirrors numeric(12,2) in migration_step4.sql: values at or above 10^10 overflow.
var MAX_PRICE=1e10;

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

  // MAX_PRICE mirrors the database's numeric(12,2), which rejects values at or
  // above 10^10. Without this the user sees a raw Postgres overflow message.
  if(mrpRaw==='')errors.push('MRP is required.');
  else if(!isFinite(mrp))errors.push('MRP must be a number.');
  else if(mrp<=0)errors.push('MRP must be greater than 0.');
  else if(mrp>=MAX_PRICE)errors.push('MRP is too large.');
  else mrpOk=true;

  if(saleRaw==='')errors.push('Sale Price is required.');
  else if(!isFinite(sale))errors.push('Sale Price must be a number.');
  else if(sale<0)errors.push('Sale Price cannot be negative.');
  else if(sale>=MAX_PRICE)errors.push('Sale Price is too large.');
  else saleOk=true;

  if(mrpOk&&saleOk&&sale>mrp)errors.push('Sale Price cannot be greater than MRP.');

  return {valid:errors.length===0, errors:errors};
}

/* ── PERMISSIONS ──
   Admin = existing 'owner' role, Staff = existing 'member' role. The
   database enforces this too (see products RLS in migration_step4.sql);
   this only keeps the UI honest. */

function isProductAdmin(){
  return typeof currentUserRole!=='undefined'&&currentUserRole==='owner';
}

function applyFeaturePermissions(){
  var btn=document.getElementById('tab-btn-products');
  var admin=isProductAdmin();
  if(btn)btn.style.display=admin?'':'none';

  // Hiding the button is not enough: an already-open Products panel survives a
  // logout, so the next user to sign in on a shared device would land on the
  // previous account's catalogue. Clear the rendered data and leave the tab.
  if(!admin){
    productsState=defaultProductsState();
    productsSelected={};
    var tb=document.getElementById('pm-tbody');
    if(tb)tb.innerHTML='';
    var search=document.getElementById('pm-search');
    if(search)search.value='';
    var panel=document.getElementById('tab-products');
    if(panel&&panel.classList.contains('active')&&typeof switchTab==='function')switchTab('scan');
  }
}

/* ── PRODUCT LIST ── */

var PRODUCTS_PAGE_SIZE=100;
var HIGH_DISCOUNT_PCT=25;
var RECENT_DAYS=30;

// Incremented per request so a slow earlier response cannot overwrite a newer
// render. The debounce only spaces out request starts, not completions.
var productsRequestSeq=0;

/* Single source of truth for the list's initial state. Assigned both at load
   and on logout, so a literal repeated in two places would drift as soon as a
   field is added. */
function defaultProductsState(){
  return {page:0, search:'', filter:'all', total:0, rows:[], sort:{col:'item_name', asc:true}};
}

var productsState=defaultProductsState();
var productSearchTimer=null;

/* Selection is scoped to the currently visible page and cleared whenever the
   visible set changes. "Select All" means what is on screen, and clearing on
   navigation makes it structurally impossible to bulk-delete rows the user
   cannot see. Keyed by product id. */
var productsSelected={};

function buildProductsQuery(){
  var q=sb.from('products').select('*',{count:'exact'}).eq('org_id',currentOrgId);

  var term=productsState.search.trim();
  if(term){
    // PostgREST's or() filter is comma/parenthesis delimited, so strip those
    // characters rather than letting them corrupt the filter expression.
    var safe=term.replace(/[%*,()]/g,' ').trim();
    if(safe){
      q=q.or('barcode.ilike.%'+safe+'%,item_name.ilike.%'+safe+'%,item_code.ilike.%'+safe+'%');
    }
  }

  if(productsState.filter==='onsale')q=q.gt('discount_pct',0);
  else if(productsState.filter==='nodiscount')q=q.eq('discount_pct',0);
  else if(productsState.filter==='high')q=q.gte('discount_pct',HIGH_DISCOUNT_PCT);
  else if(productsState.filter==='recent'){
    q=q.gte('updated_at',new Date(Date.now()-RECENT_DAYS*86400000).toISOString());
  }

  // Sorting is applied server-side so it orders the whole catalogue. Sorting
  // only the fetched page would be actively misleading across pagination.
  // The column is re-checked against the allow-list here as well, so nothing
  // outside it can reach .order() even if state were tampered with.
  var sort=productsState.sort||{col:'item_name', asc:true};
  var col=PRODUCT_SORT_COLUMNS.indexOf(sort.col)>=0?sort.col:'item_name';
  var asc=sort.asc!==false;

  var from=productsState.page*PRODUCTS_PAGE_SIZE;
  return q.order(col,{ascending:asc}).range(from,from+PRODUCTS_PAGE_SIZE-1);
}

async function loadProducts(){
  var tbody=document.getElementById('pm-tbody');
  var summary=document.getElementById('pm-summary');
  var empty=document.getElementById('pm-empty');
  var pager=document.getElementById('pm-pager');
  if(!tbody)return;

  var seq=++productsRequestSeq;

  summary.textContent='Loading…';
  tbody.innerHTML='';
  empty.style.display='none';
  pager.style.display='none';

  var res=await buildProductsQuery();
  if(seq!==productsRequestSeq)return; // superseded by a newer request
  if(res.error){
    summary.textContent='';
    empty.style.display='';
    empty.textContent='Could not load products: '+res.error.message;
    return;
  }

  var rows=res.data||[];
  // Cached so deleteProduct() can show a product's real name without having
  // to round-trip HTML-escaped text back out of an onclick attribute.
  productsState.rows=rows;
  // The visible set just changed, so any prior selection no longer refers to
  // what is on screen.
  productsSelected={};
  productsState.total=res.count||0;

  // If rows were deleted while we were on a later page, the current page can
  // fall outside the result set. Clamp and refetch rather than rendering an
  // empty table with an impossible "Showing 201-150 of 150" summary.
  var lastPage=Math.max(0, Math.ceil(productsState.total/PRODUCTS_PAGE_SIZE)-1);
  if(productsState.total>0&&productsState.page>lastPage){
    productsState.page=lastPage;
    return loadProducts();
  }

  if(!productsState.total){
    summary.textContent='';
    empty.style.display='';
    empty.textContent=(productsState.search||productsState.filter!=='all')
      ? 'No products match this search or filter.'
      : 'No products yet. Use Add Product to create one.';
    // This early return would otherwise skip the repaint below, leaving a "Delete Selected (3)" button over an empty table.
    refreshSelectionUi();
    refreshSortIndicators();
    return;
  }

  var first=productsState.page*PRODUCTS_PAGE_SIZE+1;
  var last=Math.min(first+rows.length-1, productsState.total);
  summary.textContent='Showing '+first+'–'+last+' of '+productsState.total+' product'+(productsState.total===1?'':'s');

  tbody.innerHTML=rows.map(renderProductRow).join('');
  refreshSelectionUi();
  refreshSortIndicators();

  var pages=Math.ceil(productsState.total/PRODUCTS_PAGE_SIZE);
  if(pages>1){
    pager.style.display='';
    document.getElementById('pm-pageinfo').textContent='Page '+(productsState.page+1)+' of '+pages;
    document.getElementById('pm-prev').disabled=productsState.page===0;
    document.getElementById('pm-next').disabled=productsState.page>=pages-1;
  }
}

function renderProductRow(p, i){
  var admin=isProductAdmin();
  var zero=!Number(p.discount_pct);
  var updated=p.updated_at?new Date(p.updated_at).toLocaleDateString():'—';
  return '<tr>'+
    '<td class="pm-col-check">'+(admin
      ? '<input type="checkbox" class="pm-check" data-row="'+i+'" onchange="toggleProductSelectionAt(this,'+i+')" aria-label="Select product">'
      : '')+'</td>'+
    '<td class="pm-mono">'+escapeHtml(p.barcode)+'</td>'+
    '<td class="pm-wrapcell">'+escapeHtml(p.item_name)+'</td>'+
    '<td class="pm-mono">'+escapeHtml(p.item_code||'—')+'</td>'+
    '<td class="pm-strike pm-num">'+formatMoney(p.mrp)+'</td>'+
    '<td class="pm-sale pm-num">'+formatMoney(p.sale_price)+'</td>'+
    '<td class="pm-num"><span class="pm-badge'+(zero?' zero':'')+'">'+formatDiscount(p.discount_pct)+'</span></td>'+
    '<td class="pm-num">'+formatMoney(p.savings_amount)+'</td>'+
    '<td>'+escapeHtml(updated)+'</td>'+
    '<td>'+(admin
      ? '<button class="pm-act" onclick="editProductAt('+i+')">Edit</button>'+
        '<button class="pm-act danger" onclick="deleteProductAt('+i+')">Delete</button>'
      : '—')+'</td>'+
  '</tr>';
}

/* Row actions are dispatched by array index rather than by interpolating an id
   into an onclick attribute. HTML entities decode before the attribute is
   compiled as JavaScript, so escaping alone would not protect that string
   boundary; an integer index cannot carry a payload at all. */
function editProductAt(i){
  var p=productsState.rows[i];
  if(p)openProductModal(p.id);
}

function deleteProductAt(i){
  var p=productsState.rows[i];
  if(p)deleteProduct(p.id);
}

function onProductSearchInput(){
  // Debounced so typing does not fire a query per keystroke.
  if(productSearchTimer)clearTimeout(productSearchTimer);
  productSearchTimer=setTimeout(function(){
    productsState.search=document.getElementById('pm-search').value;
    productsState.page=0;
    loadProducts();
  },300);
}

function setProductFilter(name){
  productsState.filter=name;
  productsState.page=0;
  document.querySelectorAll('#pm-filter-chips .pm-chip').forEach(function(el){
    el.classList.toggle('active', el.getAttribute('data-filter')===name);
  });
  loadProducts();
}

function productsPrevPage(){
  if(productsState.page===0)return;
  productsState.page--;
  loadProducts();
}

function productsNextPage(){
  if((productsState.page+1)*PRODUCTS_PAGE_SIZE>=productsState.total)return;
  productsState.page++;
  loadProducts();
}

/* ── SELECTION ── */

function selectedProductIds(){
  return Object.keys(productsSelected);
}

/* Dispatched by row index rather than by an id interpolated into the
   attribute — an integer cannot carry a payload. */
function toggleProductSelectionAt(el, i){
  var p=productsState.rows[i];
  if(!p)return;
  if(el.checked)productsSelected[p.id]=true;
  else delete productsSelected[p.id];
  refreshSelectionUi();
}

function toggleSelectAllProducts(el){
  var rows=productsState.rows||[];
  productsSelected={};
  if(el.checked){
    rows.forEach(function(p){ productsSelected[p.id]=true; });
  }
  document.querySelectorAll('#pm-tbody .pm-check').forEach(function(cb){ cb.checked=el.checked; });
  refreshSelectionUi();
}

/* Drives the master checkbox and the Delete Selected button from the current
   counts. Kept in one place so the two can never disagree. */
function refreshSelectionUi(){
  var count=selectedProductIds().length;
  var visible=(productsState.rows||[]).length;

  var all=document.getElementById('pm-check-all');
  if(all){
    var s=selectionCheckboxState(count, visible);
    all.checked=s.checked;
    all.indeterminate=s.indeterminate;
  }

  var btn=document.getElementById('pm-delete-selected');
  if(btn){
    btn.disabled=count===0||!isProductAdmin();
    btn.textContent=count>0?('Delete Selected ('+count+')'):'Delete Selected';
  }
}

/* ── SORTING ── */

function setProductSort(col){
  productsState.sort=nextSortState(productsState.sort, col);
  productsState.page=0;
  // Selection is deliberately NOT cleared here. loadProducts() clears it at
  // the same moment it re-renders the rows, so state and DOM change together;
  // clearing early would leave ticked checkboxes over an empty selection if
  // the fetch then failed or was superseded. This matches how paging, search
  // and filtering already behave.
  loadProducts();
}

/* A <th> is not keyboard-operable on its own, so the sortable headers carry
   tabindex="0" and role="button" and are activated here. Space is prevented
   from scrolling the page, which is the behaviour a real button would have. */
function onSortKeydown(e){
  if(e.key!=='Enter'&&e.key!==' '&&e.key!=='Spacebar')return;
  var th=e.currentTarget;
  var col=th.getAttribute('data-sort');
  if(!col)return;
  e.preventDefault();
  setProductSort(col);
}

function refreshSortIndicators(){
  var sort=productsState.sort||{col:'item_name', asc:true};
  document.querySelectorAll('#tab-products .pm-sort-ind').forEach(function(el){
    var col=el.getAttribute('data-ind');
    el.textContent=(col===sort.col)?(sort.asc?'▲':'▼'):'';
  });

  // Bind once per header, and expose sort direction to assistive tech.
  document.querySelectorAll('#tab-products .pm-sortable').forEach(function(th){
    if(!th.getAttribute('data-kb')){
      th.setAttribute('data-kb','1');
      th.addEventListener('keydown', onSortKeydown);
    }
    var col=th.getAttribute('data-sort');
    if(col===sort.col)th.setAttribute('aria-sort', sort.asc?'ascending':'descending');
    else th.removeAttribute('aria-sort');
  });
}

/* ── BULK DELETE ── */

async function deleteSelectedProducts(){
  if(!isProductAdmin()){ alert('Only the store owner can delete products.'); return; }

  var ids=selectedProductIds();
  if(!ids.length)return;

  if(!confirm('Delete '+ids.length+' selected product'+(ids.length===1?'':'s')+'? This cannot be undone.'))return;

  var btn=document.getElementById('pm-delete-selected');
  if(btn)btn.disabled=true;

  // .select('id') so a zero-row result is detectable: PostgREST reports no
  // error when an RLS USING clause filters every candidate row out.
  var res=await sb.from('products').delete().in('id',ids).eq('org_id',currentOrgId).select('id');

  if(res.error){
    alert('Could not delete: '+res.error.message);
    refreshSelectionUi();
    return;
  }

  var removed=(res.data||[]).length;
  if(removed===0){
    alert('Nothing was deleted. The products may already have been removed, or your subscription may no longer be active.');
  }else if(removed<ids.length){
    alert('Deleted '+removed+' of '+ids.length+' selected products. The rest may already have been removed, or your subscription may no longer be active.');
  }

  productsSelected={};
  loadProducts();
}

/* ── ADD / EDIT / DELETE ── */

var editingProductId=null;
// Bumped on every modal open and on close. An in-flight edit fetch compares
// its own token before touching the form, so a slow response from a
// previously-opened product can never repopulate the form for a different one.
var productModalSeq=0;

function openProductModal(id, prefillBarcode){
  if(!isProductAdmin()){ alert('Only the store owner can add or edit products.'); return; }

  var seq=++productModalSeq;
  editingProductId=id||null;
  document.getElementById('pm-modal-title').textContent=editingProductId?'Edit Product':'Add Product';
  showProductModalError('');

  var bc=document.getElementById('pm-f-barcode');
  var nm=document.getElementById('pm-f-name');
  var cd=document.getElementById('pm-f-code');
  var mp=document.getElementById('pm-f-mrp');
  var sp=document.getElementById('pm-f-sale');

  bc.value=prefillBarcode||''; nm.value=''; cd.value=''; mp.value=''; sp.value='';
  onProductPriceInput();
  document.getElementById('pm-modal').classList.add('open');

  if(editingProductId){
    // Save stays disabled until this product's own data has loaded, so the
    // user cannot submit a blank or half-populated form.
    var saveBtn=document.getElementById('pm-save-btn');
    saveBtn.disabled=true;
    sb.from('products').select('*').eq('id',editingProductId).eq('org_id',currentOrgId).single()
      .then(function(res){
        if(seq!==productModalSeq)return; // superseded: this modal was closed or reopened
        saveBtn.disabled=false;
        if(res.error||!res.data){ showProductModalError('Could not load this product: '+(res.error?res.error.message:'not found')); return; }
        bc.value=res.data.barcode||'';
        nm.value=res.data.item_name||'';
        cd.value=res.data.item_code||'';
        mp.value=res.data.mrp;
        sp.value=res.data.sale_price;
        onProductPriceInput();
        bc.focus();
      });
  } else {
    bc.focus();
  }
}

function closeProductModal(e){
  if(e&&e.target!==document.getElementById('pm-modal'))return;
  productModalSeq++; // invalidate any edit fetch still in flight
  document.getElementById('pm-modal').classList.remove('open');
  document.getElementById('pm-save-btn').disabled=false;
  editingProductId=null;
}

function showProductModalError(msg){
  var el=document.getElementById('pm-modal-error');
  el.textContent=msg||'';
  el.style.display=msg?'block':'none';
}

function onProductPriceInput(){
  var mrp=document.getElementById('pm-f-mrp').value;
  var sale=document.getElementById('pm-f-sale').value;
  var pct=computeDiscountPct(mrp,sale);
  var save=computeSavings(mrp,sale);
  // Never show a fabricated discount: if the pair is invalid, show nothing.
  var valid=(pct!==null&&save!==null&&save>=0);
  document.getElementById('pm-calc-discount').textContent=valid?formatDiscount(pct):'—';
  document.getElementById('pm-calc-savings').textContent=valid?formatMoney(save):'—';
}

async function saveProduct(){
  var input={
    barcode:document.getElementById('pm-f-barcode').value,
    itemName:document.getElementById('pm-f-name').value,
    itemCode:document.getElementById('pm-f-code').value,
    mrp:document.getElementById('pm-f-mrp').value,
    salePrice:document.getElementById('pm-f-sale').value
  };

  var check=validateProductInput(input);
  if(!check.valid){ showProductModalError(check.errors.join(' ')); return; }

  var seq=productModalSeq;
  var btn=document.getElementById('pm-save-btn');
  btn.disabled=true;
  showProductModalError('');

  var record={
    org_id:currentOrgId,
    barcode:String(input.barcode).trim().toUpperCase(),
    item_name:String(input.itemName).trim(),
    item_code:String(input.itemCode||'').trim()||null,
    mrp:Number(input.mrp),
    sale_price:Number(input.salePrice)
  };

  // .select() so a zero-row result is detectable: PostgREST reports no error
  // when an RLS USING clause filters every candidate row out.
  var res=editingProductId
    ? await sb.from('products').update(record).eq('id',editingProductId).eq('org_id',currentOrgId).select('id')
    : await sb.from('products').insert(record).select('id');

  if(seq!==productModalSeq)return; // modal was closed or reopened while saving
  btn.disabled=false;

  if(res.error){
    var msg=res.error.message||'Unknown error.';
    if(/products_org_barcode_key/.test(msg))msg='A product with that barcode already exists. Edit that product instead.';
    else if(/products_sale_le_mrp/.test(msg))msg='Sale Price cannot be greater than MRP.';
    else if(/products_mrp_positive/.test(msg))msg='MRP must be greater than 0.';
    else if(/products_sale_price_nonneg/.test(msg))msg='Sale Price cannot be negative.';
    else if(/row-level security/i.test(msg))msg='Only the store owner can add or edit products.';
    showProductModalError(msg);
    return;
  }

  if(!res.data||!res.data.length){
    showProductModalError('This product could not be saved. It may have been deleted, or your subscription may no longer be active.');
    return;
  }

  document.getElementById('pm-modal').classList.remove('open');
  // A newly inserted row may not match the active filter or fall on the current
  // page; reset to an unfiltered first page so the user can see what they added.
  if(!editingProductId){
    productsState.page=0;
    productsState.filter='all';
    productsState.search='';
    var searchEl=document.getElementById('pm-search');
    if(searchEl)searchEl.value='';
    document.querySelectorAll('#pm-filter-chips .pm-chip').forEach(function(el){
      el.classList.toggle('active', el.getAttribute('data-filter')==='all');
    });
  }
  editingProductId=null;
  loadProducts();
}

async function deleteProduct(id){
  if(!isProductAdmin()){ alert('Only the store owner can delete products.'); return; }

  var match=(productsState.rows||[]).filter(function(r){return r.id===id;})[0];
  var name=match?match.item_name:'this product';
  if(!confirm('Delete "'+name+'"? This cannot be undone.'))return;

  var res=await sb.from('products').delete().eq('id',id).eq('org_id',currentOrgId).select('id');
  if(res.error){ alert('Could not delete: '+res.error.message); return; }
  if(!res.data||!res.data.length){
    alert('This product could not be deleted. It may already have been removed, or your subscription may no longer be active.');
    loadProducts();
    return;
  }
  loadProducts();
}

/* ── SORT AND SELECTION LOGIC ──
   Pure helpers, unit-tested. Kept free of DOM and Supabase access. */

// Allow-list. Only these names may ever reach .order(), so a column name
// cannot be injected into the query.
var PRODUCT_SORT_COLUMNS=['barcode','item_name','item_code','mrp','sale_price','discount_pct','savings_amount','updated_at'];

function nextSortState(current, col){
  // The incoming state's column is validated too, not just the clicked one.
  // Otherwise a caller that seeded state with an unlisted column could get it
  // returned straight back, and the allow-list would only be advisory.
  var safeCurrent=(current&&PRODUCT_SORT_COLUMNS.indexOf(current.col)>=0)
    ? {col:current.col, asc:current.asc!==false}
    : {col:'item_name', asc:true};

  if(PRODUCT_SORT_COLUMNS.indexOf(col)<0)return safeCurrent;
  if(safeCurrent.col===col)return {col:col, asc:!safeCurrent.asc};
  return {col:col, asc:true};
}

function selectionCheckboxState(selectedCount, visibleCount){
  var sel=Number(selectedCount)||0;
  var vis=Number(visibleCount)||0;
  if(vis===0||sel===0)return {checked:false, indeterminate:false};
  if(sel>=vis)return {checked:true, indeterminate:false};
  return {checked:false, indeterminate:true};
}

/* Node export shim — inert in the browser, where `module` is undefined. */
if(typeof module!=='undefined'&&module.exports){
  module.exports={
    CURRENCY_SYMBOL:CURRENCY_SYMBOL,
    computeSavings:computeSavings,
    computeDiscountPct:computeDiscountPct,
    formatMoney:formatMoney,
    formatDiscount:formatDiscount,
    validateProductInput:validateProductInput,
    PRODUCT_SORT_COLUMNS:PRODUCT_SORT_COLUMNS,
    nextSortState:nextSortState,
    selectionCheckboxState:selectionCheckboxState
  };
}
