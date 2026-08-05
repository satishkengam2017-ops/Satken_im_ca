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

/* ── PERMISSIONS ──
   Admin = existing 'owner' role, Staff = existing 'member' role. The
   database enforces this too (see products RLS in migration_step4.sql);
   this only keeps the UI honest. */

function isProductAdmin(){
  return typeof currentUserRole!=='undefined'&&currentUserRole==='owner';
}

function applyFeaturePermissions(){
  var btn=document.getElementById('tab-btn-products');
  if(btn)btn.style.display=isProductAdmin()?'':'none';
}

/* ── PRODUCT LIST ── */

var PRODUCTS_PAGE_SIZE=100;
var HIGH_DISCOUNT_PCT=25;
var RECENT_DAYS=30;

var productsState={page:0, search:'', filter:'all', total:0, rows:[]};
var productSearchTimer=null;

function buildProductsQuery(){
  var q=sb.from('products').select('*',{count:'exact'}).eq('org_id',currentOrgId);

  var term=productsState.search.trim();
  if(term){
    // PostgREST's or() filter is comma/parenthesis delimited, so strip those
    // characters rather than letting them corrupt the filter expression.
    var safe=term.replace(/[%,()]/g,' ').trim();
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

  var from=productsState.page*PRODUCTS_PAGE_SIZE;
  return q.order('item_name',{ascending:true}).range(from,from+PRODUCTS_PAGE_SIZE-1);
}

async function loadProducts(){
  var tbody=document.getElementById('pm-tbody');
  var summary=document.getElementById('pm-summary');
  var empty=document.getElementById('pm-empty');
  var pager=document.getElementById('pm-pager');
  if(!tbody)return;

  summary.textContent='Loading…';
  tbody.innerHTML='';
  empty.style.display='none';
  pager.style.display='none';

  var res=await buildProductsQuery();
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
  productsState.total=res.count||0;

  if(!productsState.total){
    summary.textContent='';
    empty.style.display='';
    empty.textContent=(productsState.search||productsState.filter!=='all')
      ? 'No products match this search or filter.'
      : 'No products yet. Use Add Product to create one.';
    return;
  }

  var first=productsState.page*PRODUCTS_PAGE_SIZE+1;
  var last=Math.min(first+rows.length-1, productsState.total);
  summary.textContent='Showing '+first+'–'+last+' of '+productsState.total+' product'+(productsState.total===1?'':'s');

  tbody.innerHTML=rows.map(renderProductRow).join('');

  var pages=Math.ceil(productsState.total/PRODUCTS_PAGE_SIZE);
  if(pages>1){
    pager.style.display='';
    document.getElementById('pm-pageinfo').textContent='Page '+(productsState.page+1)+' of '+pages;
    document.getElementById('pm-prev').disabled=productsState.page===0;
    document.getElementById('pm-next').disabled=productsState.page>=pages-1;
  }
}

function renderProductRow(p){
  var admin=isProductAdmin();
  var zero=!Number(p.discount_pct);
  var updated=p.updated_at?new Date(p.updated_at).toLocaleDateString():'—';
  return '<tr>'+
    '<td class="pm-mono">'+escapeHtml(p.barcode)+'</td>'+
    '<td>'+escapeHtml(p.item_name)+'</td>'+
    '<td class="pm-mono">'+escapeHtml(p.item_code||'—')+'</td>'+
    '<td class="pm-strike">'+formatMoney(p.mrp)+'</td>'+
    '<td class="pm-sale">'+formatMoney(p.sale_price)+'</td>'+
    '<td><span class="pm-badge'+(zero?' zero':'')+'">'+formatDiscount(p.discount_pct)+'</span></td>'+
    '<td>'+formatMoney(p.savings_amount)+'</td>'+
    '<td>'+escapeHtml(updated)+'</td>'+
    '<td>'+(admin
      ? '<button class="pm-act" onclick="openProductModal(\''+escapeHtml(p.id)+'\')">Edit</button>'+
        '<button class="pm-act danger" onclick="deleteProduct(\''+escapeHtml(p.id)+'\')">Delete</button>'
      : '—')+'</td>'+
  '</tr>';
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

/* ── ADD / EDIT / DELETE ── */

var editingProductId=null;

function openProductModal(id, prefillBarcode){
  if(!isProductAdmin()){ alert('Only the store owner can add or edit products.'); return; }

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
    sb.from('products').select('*').eq('id',editingProductId).eq('org_id',currentOrgId).single()
      .then(function(res){
        if(res.error||!res.data){ showProductModalError('Could not load this product: '+(res.error?res.error.message:'not found')); return; }
        bc.value=res.data.barcode||'';
        nm.value=res.data.item_name||'';
        cd.value=res.data.item_code||'';
        mp.value=res.data.mrp;
        sp.value=res.data.sale_price;
        onProductPriceInput();
      });
  } else {
    bc.focus();
  }
}

function closeProductModal(e){
  if(e&&e.target!==document.getElementById('pm-modal'))return;
  document.getElementById('pm-modal').classList.remove('open');
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

  var res=editingProductId
    ? await sb.from('products').update(record).eq('id',editingProductId).eq('org_id',currentOrgId)
    : await sb.from('products').insert(record);

  btn.disabled=false;

  if(res.error){
    var msg=res.error.message||'Unknown error.';
    if(/products_org_barcode_key/.test(msg))msg='A product with that barcode already exists. Edit that product instead.';
    else if(/products_sale_le_mrp/.test(msg))msg='Sale Price cannot be greater than MRP.';
    else if(/products_mrp_positive/.test(msg))msg='MRP must be greater than 0.';
    else if(/row-level security/i.test(msg))msg='Only the store owner can add or edit products.';
    showProductModalError(msg);
    return;
  }

  document.getElementById('pm-modal').classList.remove('open');
  editingProductId=null;
  loadProducts();
}

async function deleteProduct(id){
  if(!isProductAdmin()){ alert('Only the store owner can delete products.'); return; }

  var match=(productsState.rows||[]).filter(function(r){return r.id===id;})[0];
  var name=match?match.item_name:'this product';
  if(!confirm('Delete "'+name+'"? This cannot be undone.'))return;

  var res=await sb.from('products').delete().eq('id',id).eq('org_id',currentOrgId);
  if(res.error){ alert('Could not delete: '+res.error.message); return; }
  loadProducts();
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
