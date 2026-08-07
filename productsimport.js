/* ══════════════════════════════════════════════════════════════
   PRODUCT CSV IMPORT — sample download, parsing, validation and
   the confirmed bulk import.

   The database does the actual write via the import_products RPC,
   which validates every row again and runs in one transaction, so a
   bad file changes nothing. The checks here exist to give a readable
   message and an accurate summary before that call, not as the
   security boundary.

   No top-level DOM or Supabase access, so Node can require() this
   for unit tests. Wiring is via inline onclick in index.html.
   ══════════════════════════════════════════════════════════════ */

// products.js owns these in the browser. The guarded fallbacks exist only so
// this module can be required standalone under Node for its unit tests.
if(typeof PRODUCT_BARCODE_RE==='undefined'){
  var PRODUCT_BARCODE_RE=/^[A-Za-z0-9\-\.\ ]+$/;
}
if(typeof MAX_PRICE==='undefined'){
  var MAX_PRICE=1e10;
}

/* app.js owns parseUploadLine in the browser. This minimal equivalent exists
   only so the module can be required standalone under Node for its tests. */
if(typeof parseUploadLine==='undefined'){
  var parseUploadLine=function(line){
    var cols=[],cur='',inQ=false;
    for(var i=0;i<line.length;i++){
      var ch=line[i];
      if(ch==='"'){inQ=!inQ;}
      else if(ch===','&&!inQ){cols.push(cur);cur='';}
      else{cur+=ch;}
    }
    cols.push(cur);
    return cols;
  };
}

var PRODUCT_CSV_HEADERS=['Barcode','Item Name','Item Code','MRP','Sale Price'];

/* Accepted header spellings. Matching is case-insensitive and
   whitespace-tolerant. Anything not listed here is ignored rather than
   rejected, so a file carrying extra columns (Discount, Savings, notes of
   any kind) still imports. */
var CSV_HEADER_SYNONYMS={
  barcode:['barcode','item barcode'],
  item_name:['item name','name','product name'],
  item_code:['item code','code','sku'],
  mrp:['mrp','m.r.p','mrp price'],
  sale_price:['sale price','sale','selling price','offer price']
};

var CSV_REQUIRED_FIELDS=['barcode','item_name','mrp','sale_price'];

var CSV_FIELD_LABELS={
  barcode:'Barcode', item_name:'Item Name', item_code:'Item Code',
  mrp:'MRP', sale_price:'Sale Price'
};

// Mirrors the widened pre-check in migration_step5.sql, so the client and the
// database agree on what counts as a number.
var CSV_NUMERIC_RE=/^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$/;

function normalizeHeaderCell(s){
  return String(s==null?'':s).replace(/^\uFEFF/,'').replace(/"/g,'').trim().toLowerCase().replace(/\s+/g,' ');
}

function mapCsvHeaders(cells){
  var map={};
  (cells||[]).forEach(function(cell, idx){
    var norm=normalizeHeaderCell(cell);
    Object.keys(CSV_HEADER_SYNONYMS).forEach(function(field){
      if(map[field]===undefined&&CSV_HEADER_SYNONYMS[field].indexOf(norm)>=0)map[field]=idx;
    });
  });

  var missing=CSV_REQUIRED_FIELDS.filter(function(f){ return map[f]===undefined; });
  if(missing.length){
    return {map:map, error:'Missing required column'+(missing.length>1?'s':'')+': '+
      missing.map(function(f){return CSV_FIELD_LABELS[f];}).join(', ')};
  }
  return {map:map, error:null};
}

function cellAt(cells, idx){
  if(idx===undefined||idx===null)return '';
  var v=cells[idx];
  return String(v==null?'':v).replace(/"/g,'').trim();
}

function parseProductCsv(text){
  var rows=[], errors=[], warnings=[];
  var src=String(text||'').replace(/\r\n/g,'\n').replace(/\r/g,'\n');
  var lines=src.split('\n');

  var headerIdx=-1;
  for(var i=0;i<lines.length;i++){ if(lines[i].trim()){ headerIdx=i; break; } }
  if(headerIdx<0){
    errors.push({line:0, message:'The file is empty.'});
    return {rows:rows, errors:errors, warnings:warnings};
  }

  var mapped=mapCsvHeaders(parseUploadLine(lines[headerIdx]));
  if(mapped.error){
    errors.push({line:headerIdx+1, message:mapped.error});
    return {rows:rows, errors:errors, warnings:warnings};
  }
  var map=mapped.map;

  var seenBarcodes={}, seenCodes={};

  for(var n=headerIdx+1;n<lines.length;n++){
    var raw=lines[n];
    if(!raw.trim())continue; // blank lines, including a trailing newline
    var lineNo=n+1;
    var cells=parseUploadLine(raw);

    var barcode=cellAt(cells,map.barcode).toUpperCase();
    var itemName=cellAt(cells,map.item_name);
    var itemCode=cellAt(cells,map.item_code);
    var mrpRaw=cellAt(cells,map.mrp);
    var saleRaw=cellAt(cells,map.sale_price);

    var rowErrors=[];

    if(!barcode)rowErrors.push('Barcode is required.');
    else if(!PRODUCT_BARCODE_RE.test(barcode))rowErrors.push('Barcode may contain only letters, numbers, "-", "." and spaces.');
    else if(seenBarcodes[barcode])rowErrors.push('Duplicate barcode — already used on line '+seenBarcodes[barcode]+'.');

    if(!itemName)rowErrors.push('Item Name is required.');

    var mrp=Number(mrpRaw), sale=Number(saleRaw);
    var mrpOk=false, saleOk=false;

    if(!mrpRaw)rowErrors.push('MRP is required.');
    else if(!CSV_NUMERIC_RE.test(mrpRaw))rowErrors.push('MRP must be a number.');
    else if(!(mrp>0))rowErrors.push('MRP must be greater than 0.');
    else if(mrp>=MAX_PRICE)rowErrors.push('MRP is too large.');
    else mrpOk=true;

    if(!saleRaw)rowErrors.push('Sale Price is required.');
    else if(!CSV_NUMERIC_RE.test(saleRaw))rowErrors.push('Sale Price must be a number.');
    else if(sale<0)rowErrors.push('Sale Price cannot be negative.');
    else if(sale>=MAX_PRICE)rowErrors.push('Sale Price is too large.');
    else saleOk=true;

    if(mrpOk&&saleOk&&sale>mrp)rowErrors.push('Sale Price cannot be greater than MRP.');

    if(rowErrors.length){
      rowErrors.forEach(function(m){ errors.push({line:lineNo, message:m}); });
      continue;
    }

    if(!itemCode)warnings.push({line:lineNo, message:'No Item Code.'});
    else if(seenCodes[itemCode])warnings.push({line:lineNo, message:'Item Code also used on line '+seenCodes[itemCode]+'.'});
    else seenCodes[itemCode]=lineNo;

    seenBarcodes[barcode]=lineNo;
    rows.push({line:lineNo, barcode:barcode, item_name:itemName, item_code:itemCode, mrp:mrpRaw, sale_price:saleRaw});
  }

  return {rows:rows, errors:errors, warnings:warnings};
}

/* Splitting the total into new versus updates is the point of this: it is the
   number that tells an owner whether they are about to rewrite the whole
   catalogue because they picked the wrong file. */
function summarizeImport(rows, existingBarcodes){
  var have={};
  (existingBarcodes||[]).forEach(function(b){ have[String(b).trim().toUpperCase()]=true; });

  var added=0, updated=0;
  (rows||[]).forEach(function(r){
    if(have[String(r.barcode).trim().toUpperCase()])updated++;
    else added++;
  });

  return {total:(rows||[]).length, added:added, updated:updated};
}

/* Deliberately omits Discount and Savings: they are database-generated, so a
   client cannot write them and offering the columns would only invite someone
   to fill them in and wonder why they were ignored. */
function buildSampleCsv(){
  return PRODUCT_CSV_HEADERS.join(',')+'\n'+
    '8901234567890,Premium Coffee 500g,COF-500,19.99,14.99\n'+
    '8901234567891,Green Tea 100g,TEA-100,9.99,7.99\n'+
    '8901234567892,Butter Cookies 200g,CK-200,5.99,4.49\n';
}

/* ── SAMPLE DOWNLOAD ── */

function downloadProductSampleCsv(){
  var blob=new Blob([buildSampleCsv()],{type:'text/csv'});
  var url=URL.createObjectURL(blob);
  var a=document.createElement('a');
  a.href=url;a.download='product-import-sample.csv';
  document.body.appendChild(a);a.click();
  document.body.removeChild(a);URL.revokeObjectURL(url);
}

/* ── IMPORT ── */

var piPending=null; // rows awaiting confirmation

/* PostgREST caps a response at 1000 rows, so page through — the same approach
   fetchAllUnmatched() uses. Without this a catalogue over 1000 products would
   silently report existing items as new. */
async function fetchExistingBarcodes(){
  var PAGE=1000, all=[], from=0;
  while(true){
    var res=await sb.from('products').select('barcode')
      .eq('org_id',currentOrgId).range(from,from+PAGE-1);
    if(res.error)return {error:res.error.message, barcodes:[]};
    (res.data||[]).forEach(function(r){ all.push(r.barcode); });
    if(!res.data||res.data.length<PAGE)break;
    from+=PAGE;
  }
  return {error:null, barcodes:all};
}

function onProductCsvChosen(input){
  if(!isProductAdmin()){ alert('Only the store owner can import products.'); return; }
  var file=input.files&&input.files[0];
  // Clear immediately so choosing the same file twice in a row still fires.
  input.value='';
  if(!file)return;

  var reader=new FileReader();
  reader.onerror=function(){ alert('Could not read that file. Please try again.'); };
  reader.onload=function(e){ prepareImport(decodeFileBuffer(e.target.result), file.name); };
  reader.readAsArrayBuffer(file);
}

async function prepareImport(text, filename){
  var parsed=parseProductCsv(text);

  var titleEl=document.getElementById('pi-modal-title');
  var summaryEl=document.getElementById('pi-summary');
  var issuesEl=document.getElementById('pi-issues');
  var btn=document.getElementById('pi-import-btn');

  titleEl.textContent='Import '+filename;
  issuesEl.innerHTML='';
  summaryEl.textContent='Checking…';
  btn.disabled=true;
  piPending=null;
  document.getElementById('pi-modal').classList.add('open');

  if(parsed.errors.length){
    summaryEl.innerHTML='<b>'+parsed.errors.length+'</b> problem'+
      (parsed.errors.length===1?'':'s')+' found. Nothing has been imported.';
    issuesEl.innerHTML=renderImportIssues(parsed.errors,'', 5);
    return;
  }

  if(!parsed.rows.length){
    summaryEl.textContent='That file has no product rows.';
    return;
  }

  // Existing barcodes are what turn "240 rows" into "228 updates" — the number
  // that reveals a wrong file before it overwrites anything.
  var existing=await fetchExistingBarcodes();
  if(existing.error){
    summaryEl.textContent='Could not check your current catalogue: '+existing.error;
    return;
  }

  var sum=summarizeImport(parsed.rows, existing.barcodes);
  piPending=parsed.rows;

  summaryEl.innerHTML='<b>'+sum.total+'</b> row'+(sum.total===1?'':'s')+
    ' · <b>'+sum.added+'</b> new · <b>'+sum.updated+'</b> price update'+
    (sum.updated===1?'':'s')+
    (parsed.warnings.length?' · <b>'+parsed.warnings.length+'</b> warning'+(parsed.warnings.length===1?'':'s'):'');

  if(parsed.warnings.length)issuesEl.innerHTML=renderImportIssues(parsed.warnings,' warn', 5);
  btn.disabled=false;
}

function renderImportIssues(list, cls, limit){
  var shown=list.slice(0,limit).map(function(it){
    return '<div class="pi-issue'+cls+'"><span class="pi-line">Line '+it.line+'</span>'+
      escapeHtml(it.message)+'</div>';
  }).join('');
  if(list.length>limit){
    shown+='<div class="pi-issue'+cls+'">…and '+(list.length-limit)+' more.</div>';
  }
  return shown;
}

function closeImportModal(e){
  if(e&&e.target!==document.getElementById('pi-modal'))return;
  document.getElementById('pi-modal').classList.remove('open');
  piPending=null;
}

async function runProductImport(){
  if(!piPending||!piPending.length)return;
  if(!isProductAdmin()){ alert('Only the store owner can import products.'); return; }

  var btn=document.getElementById('pi-import-btn');
  var summaryEl=document.getElementById('pi-summary');
  btn.disabled=true;
  summaryEl.textContent='Importing…';

  // 'upsert' updates existing barcodes and inserts new ones. Nothing is
  // deleted. The RPC validates again and runs in one transaction, so if it
  // raises, nothing at all was written.
  var res=await sb.rpc('import_products',{
    p_org_id:currentOrgId,
    p_rows:piPending,
    p_mode:'upsert'
  });

  if(res.error){
    summaryEl.textContent='Import failed: '+res.error.message+' Nothing was changed.';
    btn.disabled=false;
    return;
  }

  var out=res.data||{};
  document.getElementById('pi-modal').classList.remove('open');
  piPending=null;
  alert('Imported successfully — '+(out.added||0)+' added, '+(out.updated||0)+' updated.');
  loadProducts();
}

/* Node export shim — inert in the browser. Later tasks append code ABOVE
   this block; it must stay last in the file. */
if(typeof module!=='undefined'&&module.exports){
  module.exports={
    PRODUCT_CSV_HEADERS:PRODUCT_CSV_HEADERS,
    mapCsvHeaders:mapCsvHeaders,
    parseProductCsv:parseProductCsv,
    summarizeImport:summarizeImport,
    buildSampleCsv:buildSampleCsv
  };
}
