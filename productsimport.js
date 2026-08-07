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
    // Prices are stored as numeric(12,2), so the value that matters is the one
    // AFTER rounding to two places. Under half a cent rounds to 0.00 and trips
    // products_mrp_positive; within half a cent of MAX_PRICE rounds UP past the
    // column's ceiling and raises 22003. Both would surface raw Postgres text.
    else if(mrp<0.005)rowErrors.push('MRP must be at least 0.01.');
    else if(mrp>=MAX_PRICE-0.005)rowErrors.push('MRP is too large.');
    else mrpOk=true;

    if(!saleRaw)rowErrors.push('Sale Price is required.');
    else if(!CSV_NUMERIC_RE.test(saleRaw))rowErrors.push('Sale Price must be a number.');
    else if(sale<0)rowErrors.push('Sale Price cannot be negative.');
    else if(sale>=MAX_PRICE-0.005)rowErrors.push('Sale Price is too large.');
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

var piPending=null;    // rows awaiting confirmation
var piPrepareSeq=0;    // see prepareImport — mirrors productsRequestSeq in products.js
var piImporting=false; // true only while the import RPC is in flight

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
  reader.onload=function(e){ startImportCheck(decodeFileBuffer(e.target.result), file.name); };
  reader.readAsArrayBuffer(file);
}

/* prepareImport is async, so anything it throws becomes an unhandled rejection
   that leaves the modal stuck on "Checking…" saying nothing. Every caller goes
   through here so the failure is always reported. */
function startImportCheck(text, filename){
  prepareImport(text, filename).catch(function(err){
    alert('Could not prepare that import: '+((err&&err.message)||err));
  });
}

async function prepareImport(text, filename){
  // Two checks can be in flight at once: the user can dismiss the modal during
  // "Checking…" and pick a second file. Without this, the slower response
  // writes its rows into piPending and enables Import while the modal title
  // names the other file — the same guard products.js uses for loadProducts.
  var seq=++piPrepareSeq;

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
  if(seq!==piPrepareSeq)return; // superseded by a newer file — touch nothing

  if(existing.error){
    summaryEl.textContent='Could not check your current catalogue: '+existing.error;
    // Without a retry the only way forward from a transient blip is to close
    // the modal and re-pick the same file.
    var retryBtn=document.createElement('button');
    retryBtn.className='btn btn-outline';
    retryBtn.textContent='Try again';
    retryBtn.onclick=function(){ startImportCheck(text, filename); };
    issuesEl.innerHTML='';
    issuesEl.appendChild(retryBtn);
    return;
  }

  var sum=summarizeImport(parsed.rows, existing.barcodes);
  piPending=parsed.rows;

  summaryEl.innerHTML='<b>'+sum.total+'</b> row'+(sum.total===1?'':'s')+
    // Not "price updates": an upsert replaces Item Name and Item Code too, so
    // an old export re-imported to fix prices would revert every rename.
    ' · <b>'+sum.added+'</b> new · <b>'+sum.updated+'</b> existing product'+
    (sum.updated===1?'':'s')+' updated'+
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
  // Closing cannot abort an RPC that is already on the wire: it will commit
  // whatever the modal does. Rather than let a button labelled Cancel imply
  // otherwise, the modal simply stays put until the import reports back.
  if(piImporting)return;
  document.getElementById('pi-modal').classList.remove('open');
  piPending=null;
}

/* Server messages arrive without a trailing period, so the sentence that
   follows would run straight into them. */
function endSentence(s){
  var t=String(s==null?'':s).trim();
  if(!t)return '';
  return (/[.!?]$/.test(t)?t:t+'.')+' ';
}

var IMPORT_UNCONFIRMED='We could not confirm whether it went through. '+
  'Refresh the products list and check before importing again.';

/* Did Postgres reject the call outright — meaning the single-transaction RPC
   rolled back and nothing was written?

   Requires BOTH a 4xx status and a SQLSTATE-shaped code. The status proves the
   server answered at all. The shape check is deliberately narrower than "five
   alphanumeric characters", because EPIPE and EPERM are also five characters
   and mean the opposite: every real SQLSTATE class begins with a digit or with
   F, H, P or X, so no E-prefixed errno can pass.

   Two SQLSTATEs are then carved out: class 08 is a connection exception and
   57P01 is the server terminating the connection. Both mean the link died
   mid-flight, so the transaction may well have committed.

   Anything unrecognised falls through to false, which is the cautious answer:
   we say we could not confirm, rather than promising nothing changed. */
function importWasRejected(code, status){
  if(!(status>=400&&status<500))return false;
  if(!/^[0-9FHPX][0-9A-Z]{4}$/.test(code))return false;
  if(/^08/.test(code))return false;
  if(code==='57P01')return false;
  return true;
}

/* A net for anything the client-side rules did not catch first. The Add/Edit
   path in products.js already maps these; without the same mapping here a bulk
   import could show an owner a raw constraint name, which the spec rules out.
   Mirrors products.js — keep the two lists in step. */
function friendlyDbMessage(msg){
  var m=String(msg==null?'':msg);
  if(/products_org_barcode_key/.test(m))return 'That file contains a barcode that already exists on another product.';
  if(/products_sale_le_mrp/.test(m))return 'Sale Price cannot be greater than MRP.';
  if(/products_mrp_positive/.test(m))return 'MRP must be greater than 0.';
  if(/products_sale_price_nonneg/.test(m))return 'Sale Price cannot be negative.';
  if(/numeric field overflow/i.test(m))return 'A price in that file is too large.';
  if(/row-level security/i.test(m))return 'Only the store owner can import products.';
  return m;
}

function reportImportFailure(text){
  document.getElementById('pi-summary').textContent=text;
  document.getElementById('pi-import-btn').disabled=false;
  // The modal is held open for the duration of the import, but if anything
  // ever closes it the owner must still be told — silence here reads as
  // success.
  if(!document.getElementById('pi-modal').classList.contains('open'))alert(text);
}

async function runProductImport(){
  if(piImporting)return; // a second click while the first RPC is in flight
  if(!piPending||!piPending.length)return;
  if(!isProductAdmin()){ alert('Only the store owner can import products.'); return; }

  var btn=document.getElementById('pi-import-btn');
  var summaryEl=document.getElementById('pi-summary');
  btn.disabled=true;
  summaryEl.textContent='Importing…';
  piImporting=true;

  // 'upsert' updates existing barcodes and inserts new ones. Nothing is
  // deleted. The RPC validates again and runs in one transaction, so if it
  // raises, nothing at all was written.
  var res=null,thrown=null;
  try{
    res=await sb.rpc('import_products',{
      p_org_id:currentOrgId,
      p_rows:piPending,
      p_mode:'upsert'
    });
  }catch(err){
    thrown=err;
  }

  // Released on every path — settled, rejected or thrown. Left set, it would
  // wedge the modal permanently undismissable and refuse every later import.
  piImporting=false;

  if(thrown){
    // A throw says even less than an error response: we never heard back at
    // all, so the transaction's fate is unknown.
    reportImportFailure('Import failed: '+
      endSentence(thrown&&thrown.message?thrown.message:thrown)+IMPORT_UNCONFIRMED);
    return;
  }

  if(res.error){
    // Never claim the catalogue is untouched when we cannot know it.
    var code=res.error.code?String(res.error.code):'';
    var msg=endSentence(friendlyDbMessage(res.error.message));
    reportImportFailure(importWasRejected(code, res.status)
      ? 'Import failed: '+msg+'It was rejected before anything was written, so nothing was changed.'
      : 'Import failed: '+msg+IMPORT_UNCONFIRMED);
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
    buildSampleCsv:buildSampleCsv,
    importWasRejected:importWasRejected,
    friendlyDbMessage:friendlyDbMessage
  };
}
