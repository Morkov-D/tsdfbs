'use strict';
/* TSD receiving module. Scan locally; write stock ONLY on confirmed queued job. */
(()=>{
 const $=id=>document.getElementById(id);
 let draft=null, manual=false, timer=0,busy=false, sending=false;
 const escape=v=>String(v??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
 const foundByCode=val=>{
  const text=String(val).trim().toLowerCase();
  return (T.catalog.products||[]).filter(p=>[p.article,p.articleCode,p.gtin,...(p.barcodes||[])].filter(Boolean).some(x=>String(x).trim().toLowerCase()===text));
 };
 const count=()=>draft?Object.values(draft.lines).reduce((n,x)=>n+x.qty,0):0;
 const focus=()=>{
  if(document.hidden||$('receiptView').classList.contains('hidden')||!$('receiptConfirmOverlay').classList.contains('hidden'))return;
  try{$('receiptScanInput').focus({preventScroll:true})}catch(_){$('receiptScanInput').focus()}
 };
 async function persist(){await DB.put('draft','receipt',draft)}
 const warehouses=()=>{
  const e=$('receiptWarehouse');e.innerHTML='<option value="">Выберите склад…</option>'+
   T.catalog.warehouses.map(w=>'<option value="'+escape(w.uuid)+'">'+escape(w.name)+'</option>').join('');
  if(draft?.warehouseId)e.value=draft.warehouseId;
  else if(localStorage.stockflow_last_warehouse)e.value=localStorage.stockflow_last_warehouse;
 };
 function draw(){
  const wh=T.catalog.warehouses.find(w=>w.uuid===draft?.warehouseId);
  $('receiptWarehouseLabel').textContent=wh?.name||'Выберите склад';
  $('receiptTotal').textContent=count()+' шт.';
  $('receiptScanArea').classList.toggle('manual-mode',manual);
  $('receiptManual').textContent=manual?'↩ Режим сканера':'⌨ Ручной ввод';
  $('receiptManualAdd').classList.toggle('hidden',!manual);
  const lines=draft?Object.values(draft.lines):[];
  $('receiptItems').innerHTML=lines.length?lines.map(x=>'<div class="receipt-line"><div><b>'+escape(x.article)+
   '</b><small>'+escape(x.name)+'</small></div><div class="receipt-qty"><button type="button" data-less="'+escape(x.productId)+'">−</button>'+
   '<input type="number" inputmode="numeric" min="0" max="100000000" step="1" data-qty="'+escape(x.productId)+'" value="'+x.qty+'" aria-label="Количество '+escape(x.article)+'">'+
   '<button type="button" data-more="'+escape(x.productId)+'">+</button></div></div>').join(''):'<p class="muted">Список пуст. Сканируйте товар или введите его артикул.</p>';
 }
 function feedback(ok,text){
  const el=$('receiptFeedback');el.className='scan-feedback '+(ok?'success':'failure');el.textContent=text;
  try{navigator.vibrate?.(ok?[50]:[120,60,150])}catch(_){}
  try{playTone(ok)}catch(_){}
 }
 async function scan(raw){
  if(busy||!draft)return;
  const val=String(raw||'').trim();if(!val)return;
  busy=true;
  try{
   if(!draft.warehouseId)throw Error('Выберите склад до начала сканирования');
   const matches=foundByCode(val);
   if(matches.length!==1)throw Error(matches.length?'Код найден у нескольких товаров. Проверьте справочник.':'Код не найден: '+val);
   const p=matches[0],pid=p.uuid;
   const x=draft.lines[pid]||{productId:pid,article:p.article||p.articleCode,name:p.productName||'',qty:0};
   if(x.qty>=100000000)throw Error('Превышен максимум количества');
   x.qty++;draft.lines[pid]=x;await persist();draw();
   feedback(true,x.article+' · '+x.qty+' шт. · Всего '+count());
  }catch(e){feedback(false,e.message)}finally{busy=false;focus()}
 }
 function schedule(delay=270){
  clearTimeout(timer);
  timer=setTimeout(()=>{const e=$('receiptScanInput'),v=e.value;e.value='';if(v.trim())void scan(v)},delay);
 }
 function show(){
  $('homeView').classList.add('hidden');$('receiptView').classList.remove('hidden');
  warehouses();draw();focus();
 }
 $('openReceipt').onclick=async()=>{
  try{
   draft=await DB.get('draft','receipt')||{warehouseId:localStorage.stockflow_last_warehouse||'',lines:{},createdAt:new Date().toISOString()};
   if(!draft.lines)draft.lines={};
   show();
  }catch(e){message(e.message,'bad')}
 };
 $('receiptBack').onclick=()=>{$('receiptView').classList.add('hidden');view('homeView');renderHome()};
 $('receiptWarehouse').onchange=async()=>{
  if(!draft)return;
  const next=$('receiptWarehouse').value;
  if(Object.keys(draft.lines).length&&draft.warehouseId&&draft.warehouseId!==next){
   $('receiptWarehouse').value=draft.warehouseId;
   feedback(false,'Нельзя сменить склад после начала приёмки. Отмените черновик и начните новую.');
   return;
  }
  draft.warehouseId=next;localStorage.stockflow_last_warehouse=next;
  await persist();draw();focus();
 };
 $('receiptScanInput').addEventListener('input',()=>{if(!manual)schedule(330)});
 $('receiptScanInput').addEventListener('compositionend',()=>{if(!manual)schedule(330)});
 $('receiptScanInput').addEventListener('keydown',e=>{
  if(e.key==='Enter'||e.key==='Tab'){e.preventDefault();schedule(110)}
 });
 $('receiptManual').onclick=()=>{manual=!manual;draw();focus()};
 $('receiptManualAdd').onclick=()=>{const e=$('receiptScanInput'),v=e.value;e.value='';void scan(v)};
 $('receiptItems').addEventListener('click',async e=>{
  const b=e.target.closest('button');if(!b||!draft||busy)return;
  const pid=b.dataset.more||b.dataset.less,x=draft.lines[pid];if(!x)return;
  if(b.dataset.more)x.qty++;
  else x.qty--;
  if(x.qty<=0)delete draft.lines[pid];
  await persist();draw();focus();
 });
 $('receiptItems').addEventListener('change',async e=>{
  const el=e.target;if(!el.dataset.qty||!draft)return;
  const n=Number(el.value);
  if(!Number.isSafeInteger(n)||n<0||n>100000000){feedback(false,'Количество должно быть целым числом от 0 до 100 000 000');draw();return}
  if(n===0)delete draft.lines[el.dataset.qty];else draft.lines[el.dataset.qty].qty=n;
  await persist();draw();focus();
 });
 $('receiptFinish').onclick=()=>{
  if(!draft?.warehouseId)return feedback(false,'Сначала выберите склад');
  if(!count())return feedback(false,'Нет товаров для оприходования');
  const wh=T.catalog.warehouses.find(w=>w.uuid===draft.warehouseId);
  $('receiptConfirmSummary').innerHTML='<div><span>Склад</span><b>'+escape(wh?.name||'')+'</b></div>'+
  '<div><span>Артикулов</span><b>'+Object.keys(draft.lines).length+'</b></div>'+
  '<div><span>Количество</span><b>'+count()+' шт.</b></div>';
  $('receiptConfirmOverlay').classList.remove('hidden');
 };
 $('receiptKeep').onclick=()=>{$('receiptConfirmOverlay').classList.add('hidden');focus()};
 $('receiptCommit').onclick=async()=>{
  if(busy||sending||!draft)return;
  sending=true;const b=$('receiptCommit');b.disabled=true;
  try{
   const items=Object.values(draft.lines).map(x=>({productId:x.productId,qty:x.qty}));
   if(items.length<1||items.length>300)throw Error('В одной приёмке допускается 1–300 разных артикулов');
   if(!draft.warehouseId)throw Error('Не выбран склад');
   const job={kind:'RECEIPT',jobId:crypto.randomUUID(),warehouseId:draft.warehouseId,
    employeeId:T.employee.id,items,qty:count(),createdAt:new Date().toISOString(),status:'QUEUED',message:'Приёмка ожидает отправки'};
   await DB.commitReceipt(job);
   draft=null;$('receiptConfirmOverlay').classList.add('hidden');$('receiptView').classList.add('hidden');
   view('homeView');renderHome();message('Приёмка '+job.qty+' шт. сохранена. Отправляем на сервер.');
   sending=false; void sendReceipts();
  }catch(e){feedback(false,e.message)}
  finally{sending=false;b.disabled=false}
 };
 $('receiptCancel').onclick=async()=>{
  if(!draft)return;
  if(!confirm('Отменить текущую приёмку? Все отсканированные количества этого черновика будут удалены.'))return;
  await DB.del('draft','receipt');draft=null;$('receiptView').classList.add('hidden');view('homeView');renderHome();
 };
 async function sendReceipts(){
  if(sending||!T.session||!navigator.onLine)return;
  sending=true;
  try{
   const jobs=(await DB.all('queue')).filter(x=>x.kind==='RECEIPT'&&!['ERROR','SUCCESS','RESOLVED'].includes(x.status));
   for(const job of jobs){
    let result;
    try{
     job.status='SENDING';await DB.put('queue',job.jobId,job);
     result=await API.sendReceipt(T.endpoint,{action:'receipt',token:T.session,jobId:job.jobId,warehouseId:job.warehouseId,items:job.items});
    }catch(e){job.status='UNCERTAIN';job.message=e.message;await DB.put('queue',job.jobId,job);break}
    if(result.status==='SUCCESS'){await DB.del('queue',job.jobId);message('Приёмка подтверждена сервером: '+job.qty+' шт.')}
    else{job.status=result.status==='ERROR'?'ERROR':'UNCERTAIN';job.message=result.message||'Требуется сверка';await DB.put('queue',job.jobId,job);if(job.status==='UNCERTAIN')break;}
   }
  }finally{sending=false;T.queue=await DB.all('queue');if(!$('homeView').classList.contains('hidden'))renderHome();}
 }
 window.sendReceipts=sendReceipts;
 window.addEventListener('online',()=>void sendReceipts());
 window.addEventListener('focus',()=>{if(!$('receiptView').classList.contains('hidden'))focus();void sendReceipts()});
 $('sendQueue').addEventListener('click',()=>void sendReceipts());
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)focus()});
 document.addEventListener('keydown',e=>{
  if($('receiptView').classList.contains('hidden')||!$('receiptConfirmOverlay').classList.contains('hidden'))return;
  const target=e.target,input=$('receiptScanInput');
  if(target===input||e.ctrlKey||e.altKey||e.metaKey)return;
  if(target?.matches('input,select,textarea'))return;
  if(e.key==='Enter'||e.key==='Tab'){e.preventDefault();schedule(120)}
  else if(e.key.length===1){e.preventDefault();focus();input.value+=e.key;if(!manual)schedule(330)}
 },true);
})();