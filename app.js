var BARCODE_RE=/^[A-Za-z0-9\-\.\ ]+$/;

function decodeFileBuffer(buffer){
  // Excel/Windows often exports CSV as Windows-1252, not UTF-8 — auto-detect.
  var text;
  try{
    text=new TextDecoder('utf-8',{fatal:true}).decode(buffer);
  }catch(e){
    text=new TextDecoder('windows-1252').decode(buffer);
  }
  if(text.charCodeAt(0)===0xFEFF)text=text.slice(1);
  return text;
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}

/* ── TAB SWITCHING ── */
function switchTab(name){
  document.querySelectorAll('.tab-panel').forEach(function(el){el.classList.remove('active');});
  document.querySelectorAll('.tab-btn').forEach(function(el){el.classList.remove('active');});
  document.getElementById('tab-'+name).classList.add('active');
  document.querySelector('.tab-btn[data-tab="'+name+'"]').classList.add('active');
  if(name==='unmatched')loadUnmatched();
  if(name==='inventory')loadInventorySummary();
}

var scans={},scanOrder=[],lastCode='',lastTime=0,totalUnique=0;
var audioCtx=null,audioUnlocked=false;

/* ── AUDIO ── */
function autoUnlockAudio(){
  if(audioUnlocked)return;
  try{
    audioCtx=new(window.AudioContext||window.webkitAudioContext)();
    var buf=audioCtx.createBuffer(1,1,22050);
    var src=audioCtx.createBufferSource();
    src.buffer=buf;src.connect(audioCtx.destination);src.start(0);
    audioUnlocked=true;
    document.getElementById('sound-banner').style.display='none';
  }catch(e){}
}
document.addEventListener('touchstart',autoUnlockAudio,{once:true});
document.addEventListener('click',autoUnlockAudio,{once:true});

function unlockAudio(){
  try{
    audioCtx=new(window.AudioContext||window.webkitAudioContext)();
    var buf=audioCtx.createBuffer(1,1,22050);
    var src=audioCtx.createBufferSource();
    src.buffer=buf; src.connect(audioCtx.destination); src.start(0);
    audioUnlocked=true;
    document.getElementById('sound-banner').style.display='none';
    setTimeout(beep,100);
  }catch(e){document.getElementById('sound-banner').innerHTML='<span>Sound not supported on this browser.</span>';}
}

function beep(){
  if(!audioUnlocked||!audioCtx)return;
  try{
    if(audioCtx.state==='suspended')audioCtx.resume();
    var o1=audioCtx.createOscillator(),g1=audioCtx.createGain();
    o1.connect(g1);g1.connect(audioCtx.destination);
    o1.type='square';o1.frequency.value=1046;
    g1.gain.setValueAtTime(0.4,audioCtx.currentTime);
    g1.gain.exponentialRampToValueAtTime(0.001,audioCtx.currentTime+0.12);
    o1.start(audioCtx.currentTime);o1.stop(audioCtx.currentTime+0.12);
    var o2=audioCtx.createOscillator(),g2=audioCtx.createGain();
    o2.connect(g2);g2.connect(audioCtx.destination);
    o2.type='square';o2.frequency.value=1318;
    g2.gain.setValueAtTime(0.4,audioCtx.currentTime+0.08);
    g2.gain.exponentialRampToValueAtTime(0.001,audioCtx.currentTime+0.22);
    o2.start(audioCtx.currentTime+0.08);o2.stop(audioCtx.currentTime+0.22);
    if(navigator.vibrate)navigator.vibrate(60);
  }catch(e){}
}

/* ── CAMERA ── */
function startCamera(){
  var zx=window.ZXingBrowser||window.ZXing;
  if(!zx){document.getElementById('status-text').textContent='Library error — please refresh.';return;}
  var btn=document.getElementById('start-btn');
  btn.disabled=true;
  document.getElementById('status-text').textContent='Starting camera…';
  try{
    var hints=new Map();
    var formats=[
      zx.BarcodeFormat.EAN_13,
      zx.BarcodeFormat.EAN_8,
      zx.BarcodeFormat.UPC_A,
      zx.BarcodeFormat.UPC_E,
      zx.BarcodeFormat.CODE_128,
      zx.BarcodeFormat.CODE_39,
      zx.BarcodeFormat.ITF,
      zx.BarcodeFormat.DATA_MATRIX,
      zx.BarcodeFormat.QR_CODE
    ].filter(Boolean);
    if(formats.length>0) hints.set(zx.DecodeHintType?zx.DecodeHintType.POSSIBLE_FORMATS:2, formats);
    codeReader=new zx.BrowserMultiFormatReader(hints);
  }
  catch(e){document.getElementById('status-text').textContent='Error: '+e.message;btn.disabled=false;return;}
  codeReader.decodeFromConstraints(
    {video:{facingMode:'environment',width:{ideal:1280},height:{ideal:720}}},
    document.getElementById('video'),
    function(result,err){if(result)handleScan(result.getText());}
  ).then(function(c){
    controls=c;
    document.getElementById('placeholder').style.display='none';
    document.getElementById('scan-line').style.display='block';
    document.getElementById('start-btn').style.display='none';
    document.getElementById('stop-btn').style.display='';
    document.getElementById('status-text').textContent='Point camera at a barcode…';
  }).catch(function(err){
    var msg='Camera error.';
    if(err.name==='NotAllowedError')msg='Permission denied — allow camera in settings.';
    else if(err.name==='NotFoundError')msg='No camera found.';
    else msg='Error: '+err.message;
    document.getElementById('status-text').textContent=msg;
    btn.disabled=false;
  });
}
var codeReader=null,controls=null;

function stopCamera(){
  if(codeReader){try{codeReader.reset();}catch(e){}codeReader=null;}
  controls=null;
  document.getElementById('placeholder').style.display='flex';
  document.getElementById('scan-line').style.display='none';
  document.getElementById('start-btn').style.display='';
  document.getElementById('stop-btn').style.display='none';
  document.getElementById('start-btn').disabled=false;
  document.getElementById('status-text').textContent='Camera stopped.';
}

/* ── SCAN CONFIRMATION BUFFER ── */
var pendingScan=null,pendingTime=0,pendingTimer=null;

function handleScan(code){
  if(!code||code.trim().length<6)return;
  code=code.trim().toUpperCase();
  if(!BARCODE_RE.test(code))return;
  var now=Date.now();
  if(code===pendingScan&&now-pendingTime<1500){
    pendingScan=null;
    if(pendingTimer){clearTimeout(pendingTimer);pendingTimer=null;}
    commitScan(code);
  } else {
    pendingScan=code;
    pendingTime=now;
    if(pendingTimer)clearTimeout(pendingTimer);
    pendingTimer=setTimeout(function(){pendingScan=null;},1500);
  }
}

function commitScan(code){
  var now=Date.now();
  if(code===lastCode&&now-lastTime<2500)return;
  lastCode=code;lastTime=now;
  var isNew=!scans[code];
  if(isNew){scans[code]={count:0,first:new Date()};totalUnique++;scanOrder.unshift(code);}
  else{scanOrder=scanOrder.filter(function(c){return c!==code;});scanOrder.unshift(code);}
  scans[code].count++;scans[code].last=new Date();scans[code].isNew=true;
  beep();flashEffect();renderList();
  var short=code.length>24?code.slice(0,24)+'…':code;
  document.getElementById('status-text').textContent=isNew?('New item: '+short):('Again ×'+scans[code].count+': '+short);
  document.getElementById('total-count').textContent=totalUnique+' scanned';
  setTimeout(function(){if(scans[code]){scans[code].isNew=false;renderList();}},900);
  syncScan(code,1);
}

function flashEffect(){
  var el=document.getElementById('flash');
  el.style.opacity='0.3';
  setTimeout(function(){el.style.opacity='0';},100);
}

function renderList(){
  var list=document.getElementById('scan-list');
  if(!scanOrder.length){
    list.innerHTML='<div class="empty-state"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="3" height="18" rx="1"/><rect x="8" y="3" width="1.5" height="18" rx="0.5"/><rect x="11.5" y="3" width="3" height="18" rx="1"/><rect x="16.5" y="3" width="1.5" height="18" rx="0.5"/><rect x="19.5" y="3" width="2.5" height="18" rx="1"/></svg>No items scanned yet</div>';
    return;
  }
  list.innerHTML=scanOrder.map(function(code){
    var data=scans[code];
    var t=data.last.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});
    var multi=data.count>1;
    return '<div class="scan-item'+(data.isNew?' new-scan':'')+'">'+
      '<div class="barcode-icon"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="2.5" height="18" rx="0.5"/><rect x="7" y="3" width="1" height="18" rx="0.3"/><rect x="10" y="3" width="2.5" height="18" rx="0.5"/><rect x="14.5" y="3" width="1" height="18" rx="0.3"/><rect x="17.5" y="3" width="3" height="18" rx="0.5"/></svg></div>'+
      '<div class="scan-info"><div class="scan-code">'+escapeHtml(code)+'</div><div class="scan-time">Last: '+t+'</div></div>'+
      '<div class="scan-count'+(multi?'':' once')+'">'+data.count+'×</div>'+
      '</div>';
  }).join('');
}

/* ── SUPABASE SYNC (org-scoped) ── */
function syncScan(barcode,qty){
  sb.rpc('increment_scan',{p_barcode:barcode,p_qty:qty,p_org_id:currentOrgId}).then(function(res){
    if(res.error)console.warn('sync error:',res.error.message);
  });
}

function openResetModal(){document.getElementById('reset-modal').classList.add('open');}
function closeResetModal(e){if(!e||e.target===document.getElementById('reset-modal'))document.getElementById('reset-modal').classList.remove('open');}
function confirmReset(){
  stopCamera();
  scans={};scanOrder=[];totalUnique=0;lastCode='';
  renderList();
  document.getElementById('status-text').textContent='Tap Start to scan';
  document.getElementById('total-count').textContent='0 scanned';
  document.getElementById('reset-modal').classList.remove('open');
}

/* ── MANUAL ENTRY ── */
function toggleManualEntry(){
  var panel=document.getElementById('manual-entry-panel');
  panel.classList.toggle('open');
  if(panel.classList.contains('open')){
    document.getElementById('manual-barcode').focus();
  }
}

function addManualBarcode(){
  var barcodeEl=document.getElementById('manual-barcode');
  var qtyEl=document.getElementById('manual-qty');
  var code=barcodeEl.value.trim().toUpperCase();
  var qty=parseInt(qtyEl.value)||1;

  if(!code){ barcodeEl.focus(); return; }
  if(!BARCODE_RE.test(code)){
    var statusEl0=document.getElementById('status-text');
    var orig0=statusEl0.textContent;
    statusEl0.textContent='Invalid barcode — letters, numbers, "-", "." and spaces only.';
    setTimeout(function(){statusEl0.textContent=orig0;},2500);
    barcodeEl.focus();
    return;
  }
  if(qty<1)qty=1;

  var isNew=!scans[code];
  if(isNew){
    scans[code]={count:0,first:new Date()};
    totalUnique++;
    scanOrder.unshift(code);
  } else {
    scanOrder=scanOrder.filter(function(c){return c!==code;});
    scanOrder.unshift(code);
  }
  scans[code].count+=qty;
  scans[code].last=new Date();
  scans[code].isNew=true;

  document.getElementById('total-count').textContent=totalUnique+' scanned';

  beep();
  flashEffect();
  renderList();

  barcodeEl.value='';
  qtyEl.value='1';
  barcodeEl.focus();

  var statusEl=document.getElementById('status-text');
  var orig=statusEl.textContent;
  statusEl.textContent='Added: '+code+' × '+qty;
  setTimeout(function(){statusEl.textContent=orig;},2000);

  syncScan(code,qty);
}

document.addEventListener('DOMContentLoaded',function(){
  var barcodeEl=document.getElementById('manual-barcode');
  if(barcodeEl){
    barcodeEl.addEventListener('keydown',function(e){
      if(e.key==='Enter') addManualBarcode();
    });
  }
  var qtyEl=document.getElementById('manual-qty');
  if(qtyEl){
    qtyEl.addEventListener('keydown',function(e){
      if(e.key==='Enter') addManualBarcode();
    });
  }
});

/* ── SCAN CSV IMPORT (barcode + qty, bulk-adds scanned counts) ── */
function toggleUpload(){
  var panel=document.getElementById('upload-panel');
  panel.classList.toggle('open');
  document.getElementById('manual-entry-panel').classList.remove('open');
}

function handleCSVUpload(fileList){
  if(!fileList||!fileList.length)return;
  var file=fileList[0];
  if(!file||!(file instanceof Blob)){
    alert('Could not read file. Please try again.');
    return;
  }
  try{
    document.getElementById('csv-upload-input').value='';
  }catch(e){}
  var reader=new FileReader();
  reader.onload=function(e){ processUploadedCSV(decodeFileBuffer(e.target.result), file.name); };
  reader.onerror=function(){ alert('Error reading file. Please try again.'); };
  reader.readAsArrayBuffer(file);
}

function processUploadedCSV(text, filename){
  text = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n');
  var lines=text.trim().split('\n');
  if(!lines.length){ alert('File appears empty.'); return; }

  var added=0, skipped=0, toSync=[];

  lines.forEach(function(line){
    line=line.trim();
    if(!line)return;

    var cols=parseUploadLine(line);
    var barcode=cols[0]?cols[0].replace(/"/g,'').trim().toUpperCase():'';
    var qtyRaw=cols[1]?cols[1].replace(/"/g,'').trim():'';
    var qty=parseInt(qtyRaw)||1;

    if(!barcode)return;
    if(barcode.toLowerCase()==='barcode'||barcode.toLowerCase()==='item barcode')return;
    if(!BARCODE_RE.test(barcode)){ skipped++; return; }

    qty=Math.max(1,qty);

    var isNew=!scans[barcode];
    if(isNew){
      scans[barcode]={count:0,first:new Date()};
      totalUnique++;
      scanOrder.push(barcode);
    }
    scans[barcode].count+=qty;
    scans[barcode].last=new Date();
    scans[barcode].isNew=true;
    added++;
    toSync.push({barcode:barcode,qty:qty});
  });

  if(added===0){
    alert('No valid barcodes found in "'+filename+'"\n\nMake sure the file has:\nColumn A: Barcode\nColumn B: Quantity');
    return;
  }

  document.getElementById('total-count').textContent=totalUnique+' scanned';
  renderList();
  beep();

  document.getElementById('upload-panel').classList.remove('open');
  var statusEl=document.getElementById('status-text');
  var orig=statusEl.textContent;
  statusEl.textContent='✓ Imported '+added+' barcode(s) from '+filename+(skipped?' ('+skipped+' skipped)':'')+' — syncing…';

  (function syncNext(i){
    if(i>=toSync.length){
      statusEl.textContent='✓ Imported and synced '+added+' barcode(s) from '+filename;
      setTimeout(function(){statusEl.textContent=orig;},3000);
      return;
    }
    sb.rpc('increment_scan',{p_barcode:toSync[i].barcode,p_qty:toSync[i].qty,p_org_id:currentOrgId}).then(function(){
      syncNext(i+1);
    });
  })(0);
}

function parseUploadLine(line){
  var cols=[],cur='',inQ=false;
  for(var i=0;i<line.length;i++){
    var ch=line[i];
    if(ch==='"'){inQ=!inQ;}
    else if(ch===','&&!inQ){cols.push(cur);cur='';}
    else{cur+=ch;}
  }
  cols.push(cur);
  return cols;
}

/* ── INVENTORY TAB ── */
function parseInventoryLine(line){ return parseUploadLine(line); }

async function loadInventorySummary(){
  var countEl=document.getElementById('inv-count');
  var updatedEl=document.getElementById('inv-updated');
  countEl.textContent='…';
  updatedEl.textContent='Loading…';
  var {count, error}=await sb.from('inventory_items').select('*',{count:'exact',head:true}).eq('org_id',currentOrgId);
  if(error){ updatedEl.textContent='Error loading inventory.'; return; }
  countEl.textContent=count||0;
  if(!count){ updatedEl.textContent='No inventory uploaded yet.'; return; }
  var {data}=await sb.from('inventory_items').select('created_at').eq('org_id',currentOrgId).order('created_at',{ascending:false}).limit(1);
  var when=(data&&data[0]&&data[0].created_at)?new Date(data[0].created_at).toLocaleString():'unknown';
  updatedEl.textContent='Last uploaded: '+when;
}

function handleInventoryUpload(fileList){
  if(!fileList||!fileList.length)return;
  var file=fileList[0];
  if(!file||!(file instanceof Blob)){ alert('Could not read file. Please try again.'); return; }
  try{ document.getElementById('inventory-upload-input').value=''; }catch(e){}
  var reader=new FileReader();
  reader.onload=function(e){ processInventoryCSV(decodeFileBuffer(e.target.result), file.name); };
  reader.onerror=function(){ alert('Error reading file. Please try again.'); };
  reader.readAsArrayBuffer(file);
}

async function processInventoryCSV(text, filename){
  text=text.replace(/\r\n/g,'\n').replace(/\r/g,'\n');
  var lines=text.trim().split('\n');
  if(!lines.length){ alert('File appears empty.'); return; }

  var rows=[];
  lines.forEach(function(line){
    line=line.trim();
    if(!line)return;
    var cols=parseInventoryLine(line);
    var name=cols[0]?cols[0].replace(/"/g,'').trim():'';
    var barcode=cols[1]?cols[1].replace(/"/g,'').trim().toUpperCase():'';
    var stockRaw=cols[2]?cols[2].replace(/"/g,'').trim():'';
    if(barcode.toLowerCase()==='item barcode'||barcode.toLowerCase()==='barcode')return;
    if(!barcode||!BARCODE_RE.test(barcode))return;
    var stock=parseInt(stockRaw)||0;
    rows.push({item_name:name||null,item_barcode:barcode,available_stock:stock,scanned_qty:0,org_id:currentOrgId});
  });

  if(!rows.length){
    alert('No valid rows found in "'+filename+'"\n\nMake sure the file has:\nColumn A: Item Name\nColumn B: Barcode\nColumn C: Available Stock');
    return;
  }

  if(!confirm('This will replace your current inventory ('+rows.length+' items in this file) and start a fresh count. Continue?')) return;

  var panel=document.getElementById('inventory-upload-panel');
  var origHtml=panel.innerHTML;
  panel.innerHTML='<div class="ud-title">Uploading '+rows.length+' items…</div>';

  await sb.from('inventory_items').delete().eq('org_id',currentOrgId);
  await sb.from('unmatched_scans').delete().eq('org_id',currentOrgId);

  var CHUNK=500;
  for(var i=0;i<rows.length;i+=CHUNK){
    var chunk=rows.slice(i,i+CHUNK);
    var {error}=await sb.from('inventory_items').insert(chunk);
    if(error){
      alert('Upload failed partway through: '+error.message);
      panel.innerHTML=origHtml;
      loadInventorySummary();
      return;
    }
    panel.innerHTML='<div class="ud-title">Uploading… '+Math.min(i+CHUNK,rows.length)+' / '+rows.length+'</div>';
  }

  panel.innerHTML=origHtml;
  loadInventorySummary();
  alert('✓ Uploaded '+rows.length+' items. Fresh count started.');
}

function downloadSampleInventoryCSV(){
  var csv='Item Name,Barcode,Available Stock\n'+
    'Example Cotton Shirt,8901234567890,25\n'+
    'Example Denim Jeans,8901234567891,12\n'+
    'Example Silk Scarf,8901234567892,8\n';
  var blob=new Blob([csv],{type:'text/csv'});
  var url=URL.createObjectURL(blob);
  var a=document.createElement('a');
  a.href=url;a.download='inventory-sample.csv';
  document.body.appendChild(a);a.click();
  document.body.removeChild(a);URL.revokeObjectURL(url);
}

async function resetCounts(){
  if(!confirm('This permanently deletes your entire inventory catalog (all '+ (document.getElementById('inv-count').textContent||'') +' items) and all scan data. You will need to upload a new inventory CSV afterward. Continue?')) return;
  await sb.from('inventory_items').delete().eq('org_id',currentOrgId);
  await sb.from('unmatched_scans').delete().eq('org_id',currentOrgId);
  scans={};scanOrder=[];totalUnique=0;lastCode='';
  renderList();
  document.getElementById('total-count').textContent='0 scanned';
  loadInventorySummary();
  loadUnmatched();
  alert('✓ Inventory cleared. Upload a new CSV to start.');
}

/* ── UNMATCHED TAB ── */
var lastUnmatchedRows=[];

async function fetchAllUnmatched(){
  // Supabase/PostgREST caps a single request at 1000 rows by default —
  // page through with .range() so large inventories aren't silently truncated.
  var PAGE=1000,all=[],from=0;
  while(true){
    var res=await sb.from('unmatched_report').select('*').eq('org_id',currentOrgId).order('reason').range(from,from+PAGE-1);
    if(res.error)return res;
    all=all.concat(res.data);
    if(res.data.length<PAGE)break;
    from+=PAGE;
  }
  return {data:all,error:null};
}

async function loadUnmatched(){
  var listEl=document.getElementById('unmatched-list');
  listEl.innerHTML='<div class="empty-state">Loading…</div>';

  var {count:totalItems}=await sb.from('inventory_items').select('*',{count:'exact',head:true}).eq('org_id',currentOrgId);
  var {data:rows,error}=await fetchAllUnmatched();

  if(error){
    listEl.innerHTML='<div class="empty-state">Error loading report: '+escapeHtml(error.message)+'</div>';
    return;
  }

  lastUnmatchedRows=rows;

  var invMismatchCount=rows.filter(function(r){return r.source==='inventory_items';}).length;
  var matched=(totalItems||0)-invMismatchCount;
  document.getElementById('stat-matched').textContent=matched<0?0:matched;
  document.getElementById('stat-total').textContent=totalItems||0;
  document.getElementById('stat-unmatched').textContent=rows.length;

  var badge=document.getElementById('unmatched-badge');
  if(rows.length>0){ badge.style.display='inline-block'; badge.textContent=rows.length; }
  else{ badge.style.display='none'; }

  if(!rows.length){
    listEl.innerHTML='<div class="empty-state"><svg viewBox="0 0 24 24"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>Everything matches. No unmatched items.</div>';
    return;
  }

  listEl.innerHTML=rows.map(function(r){
    var badgeClass=r.reason==='Quantity mismatch'?'mismatch':(r.reason==='Not scanned yet'?'notscanned':'notfound');
    var name=r.item_name?escapeHtml(r.item_name):'(barcode not in inventory)';
    var stockLabel=(r.available_stock===null||r.available_stock===undefined)?'—':r.available_stock;
    return '<div class="unmatched-item">'+
      '<div class="um-left">'+
        '<div class="um-name" title="'+name+'">'+name+'</div>'+
        '<div class="um-code">'+escapeHtml(r.item_barcode)+'</div>'+
      '</div>'+
      '<div class="um-mid">'+
        '<div class="reason-badge '+badgeClass+'">'+escapeHtml(r.reason)+'</div>'+
        '<div class="um-qty-compact">Exp <b>'+stockLabel+'</b> · Scan <b>'+r.scanned_qty+'</b></div>'+
      '</div>'+
      '<button class="resolve-icon" title="Mark Resolved" onclick="resolveUnmatched(\''+r.source+'\',\''+r.id+'\')">'+
        '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>'+
      '</button>'+
    '</div>';
  }).join('');
}

function csvField(v){
  var s=(v===null||v===undefined)?'':String(v);
  return '"'+s.replace(/"/g,'""')+'"';
}

function downloadUnmatchedCSV(){
  if(!lastUnmatchedRows.length){ alert('No unmatched items to download. Open the Report tab first.'); return; }
  var header=['Item Name','Barcode','Available Stock','Scanned Qty','Not Scanned Yet/Unmatched'];
  var lines=[header.map(csvField).join(',')];
  lastUnmatchedRows.forEach(function(r){
    lines.push([
      csvField(r.item_name||''),
      csvField(r.item_barcode),
      csvField(r.available_stock===null||r.available_stock===undefined?'':r.available_stock),
      csvField(r.scanned_qty),
      csvField(r.reason)
    ].join(','));
  });
  var csv=lines.join('\n');
  var blob=new Blob([csv],{type:'text/csv'});
  var url=URL.createObjectURL(blob);
  var a=document.createElement('a');
  var ts=new Date().toISOString().slice(0,10);
  a.href=url;a.download='unmatched-report-'+ts+'.csv';
  document.body.appendChild(a);a.click();
  document.body.removeChild(a);URL.revokeObjectURL(url);
}

async function resolveUnmatched(source,id){
  var note=prompt('Add a note (optional):','');
  if(note===null)return;
  await sb.from(source).update({resolved:true,resolved_note:note||null,resolved_at:new Date().toISOString()}).eq('id',id).eq('org_id',currentOrgId);
  await loadUnmatched();
}
