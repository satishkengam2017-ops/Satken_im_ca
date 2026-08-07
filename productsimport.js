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
