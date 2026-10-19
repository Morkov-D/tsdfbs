'use strict';
const T={endpoint:'',session:null,employee:null,catalog:{lks:[],warehouses:[],products:[],savedAt:''},draft:null,queue:[],sending:false,cameraStream:null,cameraTimer:null,cameraBusy:false,scanBusy:false,pickerOptions:[],feedbackTimer:null,audio:null,byId:new Map(),byBarcode:new Map(),scanCodes:new Set()};
const $=id=>document.getElementById(id);
function stage(label,percent){const box=$('workProgress');box.classList.remove('hidden');$('workProgressLabel').textContent=label;$('workProgressValue').textContent=percent==null?'Синхронизация…':percent+'%';$('workProgressFill').style.width=percent==null?'35%':percent+'%';$('workProgressFill').classList.toggle('moving',percent==null);}
function stageEnd(){const box=$('workProgress');if(box)box.classList.add('hidden');}
function productNeedsCHZ(p){return p?.requiresCHZ===undefined||p?.requiresCHZ===null||p?.requiresCHZ===''?!!p?.gtin:(p.requiresCHZ===true||p.requiresCHZ==='1');}
function buildIndexes(){
 T.byId=new Map();T.byBarcode=new Map();
 (T.catalog.products||[]).forEach(p=>{
  T.byId.set(p.uuid,p);
  const keys=[p.articleCode,p.gtin,...(p.barcodes||[])].filter(Boolean);
  keys.forEach(code=>{
   const key=String(code).trim().toLowerCase(),arr=T.byBarcode.get(key)||[];
   if(!arr.some(x=>x.uuid===p.uuid))arr.push(p);
   T.byBarcode.set(key,arr);
  });
 });
 T.scanCodes=new Set((T.draft?.scans||[]).map(x=>x.dm).filter(Boolean));
}

function focusScanner() {
  if(!T.draft || document.hidden || $('assemblyView').classList.contains('hidden')
    || !$('pickerOverlay').classList.contains('hidden')
    || !$('finishOverlay').classList.contains('hidden')
    || !$('conflictOverlay').classList.contains('hidden')
    || !$('conflictConfirmOverlay').classList.contains('hidden')
    || !$('cancelAssemblyOverlay').classList.contains('hidden')) return;
  const input=$('scanInput');
  if(document.activeElement!==input){try{input.focus({preventScroll:true});}catch(_){input.focus();}}
  if(document.activeElement===input && $('scanFocusStatus')){
    $('scanFocusStatus').textContent='● Сканер готов · поле активно';
    $('scanFocusStatus').classList.add('ready');
  }
}
function haptic(pattern){try{if(navigator.vibrate)navigator.vibrate(pattern);}catch(_){}}
function armAudio() {
  try{
    const C=window.AudioContext||window.webkitAudioContext;
    if(C&&!T.audio)T.audio=new C();
    if(T.audio&&T.audio.state==='suspended')T.audio.resume().catch(()=>{});
  }catch(_){}
}
function playTone(ok){
  try{
    if(!T.audio)armAudio();if(!T.audio||T.audio.state!=='running')return;
    const start=T.audio.currentTime+.008,osc=T.audio.createOscillator(),gain=T.audio.createGain();
    osc.type=ok?'sine':'square';
    osc.frequency.setValueAtTime(ok?1050:230,start);
    if(!ok)osc.frequency.exponentialRampToValueAtTime(145,start+.19);
    gain.gain.setValueAtTime(.0001,start);
    gain.gain.exponentialRampToValueAtTime(ok?.12:.19,start+.018);
    gain.gain.exponentialRampToValueAtTime(.0001,start+(ok?.10:.29));
    osc.connect(gain);gain.connect(T.audio.destination);osc.start(start);osc.stop(start+(ok?.12:.32));
  }catch(_){}
}
function scanSignal(ok,text){
  $('scanFeedback').className='scan-feedback '+(ok?'success':'failure');
  $('scanFeedbackIcon').textContent=ok?'✓':'!';
  $('scanFeedbackText').textContent=text;
  $('scanCard').classList.remove('state-good','state-error');
  $('scanCard').classList.add(ok?'state-good':'state-error');
  $('screenFlash').className='screen-flash '+(ok?'flash-good':'flash-error');
  haptic(ok?[55]:[140,65,190]);playTone(ok);
  clearTimeout(T.feedbackTimer);
  T.feedbackTimer=setTimeout(()=>{$('scanCard').classList.remove('state-good','state-error');$('screenFlash').className='screen-flash';},650);
}


const escapeHtml=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function view(id){['setupView','loginView','homeView','assemblyView'].forEach(x=>$(x).classList.toggle('hidden',x!==id));}
function message(text,type='good'){const area=$('alerts');area.innerHTML=`<div class="notice ${type}">${escapeHtml(text)}</div>`;clearTimeout(window.alertTimer);window.alertTimer=setTimeout(()=>area.innerHTML='',8000);}
function busy(button,cb){if(button.disabled)return;button.disabled=true;const original=button.dataset.label||button.textContent;button.dataset.label=original;button.textContent='⏳ Выполняется…';Promise.resolve().then(cb).catch(e=>{console.error(e);message(e.message||String(e),'bad');}).finally(()=>{button.disabled=false;button.textContent=original;});}
function activeOnline(){return navigator.onLine;}
function showConnection(){$('connection').classList.toggle('offline',!activeOnline());$('connection').textContent=activeOnline()?'● В сети':'● Офлайн';$('connection').title=activeOnline()?'Сеть доступна':'Нет сети: очередь сохранится';}

const lkLabel=lk=>(lk.name||'ЛК')+' · '+(lk.marketplace||'')+' · '+(lk.externalId||'');
function setViewportSheet(){
  const vp=window.visualViewport;
  document.documentElement.style.setProperty('--sheet-height',(vp?vp.height:window.innerHeight)+'px');
  document.documentElement.style.setProperty('--sheet-top',(vp?vp.offsetTop:0)+'px');
}
if(window.visualViewport){window.visualViewport.addEventListener('resize',setViewportSheet);window.visualViewport.addEventListener('scroll',setViewportSheet);}
window.addEventListener('resize',setViewportSheet);
function closePicker(){ $('pickerOverlay').classList.add('hidden'); $('pickerSearch').blur();setViewportSheet(); }
function showLKPicker(){
  const options=(T.catalog.lks||[]).map(lk=>({
    id:lk.uuid,
    title:lk.name||lk.externalId||'Без названия',
    subtitle:[lk.marketplace,lk.externalId?'ID '+lk.externalId:'',lk.legalEntity,lk.inn?'ИНН '+lk.inn:''].filter(Boolean).join(' · '),
    search:[lk.name,lk.marketplace,lk.externalId,lk.legalEntity,lk.inn].filter(Boolean).join(' ')
  })).sort((a,b)=>a.title.localeCompare(b.title,'ru'));
  if(!options.length)throw Error('Нет личных кабинетов. Обновите справочники.');
  T.pickerOptions=options;
  $('pickerTitle').textContent='Выберите ЛК';
  $('pickerStep').textContent='НОВАЯ СБОРКА';
  $('pickerHint').textContent='Юрлицо и ИНН определяются автоматически по выбранному ЛК.';
  $('pickerSearch').value=''; $('pickerOverlay').classList.remove('hidden');
  setViewportSheet();renderPickerItems();
}
function renderPickerItems(){
  const q=$('pickerSearch').value.trim().toLowerCase();
  const found=T.pickerOptions.filter(o=>(o.title+' '+o.subtitle+' '+o.search).toLowerCase().includes(q));
  $('pickerItems').innerHTML=found.length?found.slice(0,160).map(o=>
    '<button type="button" class="picker-item" data-id="'+escapeHtml(o.id)+'">'+
    '<span class="picker-label">'+escapeHtml(o.title)+'</span>'+
    '<span class="picker-sub">'+escapeHtml(o.subtitle)+'</span>'+
    '<span class="picker-arrow">›</span></button>'
  ).join(''):'<p class="picker-empty">Нет совпадений. Уточните поиск.</p>';
}
$('pickerSearch').addEventListener('input',renderPickerItems);
$('pickerItems').addEventListener('click',async e=>{
  const button=e.target.closest('[data-id]');if(!button||T.draft)return;
  const item=T.pickerOptions.find(o=>o.id===button.dataset.id);if(!item)return;
  button.disabled=true;
  try{await beginDraft(item.id);closePicker();}
  catch(err){button.disabled=false;message(err.message,'bad');haptic([150,70,170]);}
});
$('pickerClose').onclick=closePicker;
$('pickerOverlay').addEventListener('click',e=>{if(e.target===$('pickerOverlay'))closePicker();});
async function beginDraft(lkId){
  const warehouseId=$('warehouse').value;
  if(!warehouseId)throw Error('Не выбран склад');
  const lk=T.catalog.lks.find(x=>x.uuid===lkId);
  if(!lk)throw Error('ЛК отсутствует в справочнике');
  if(!lk.inn||!lk.legalEntity)throw Error('У выбранного ЛК не заполнены юрлицо или ИНН. Заполните их в карточке ЛК.');
  T.draft={lkId:lk.uuid,warehouseId,stage:'barcode',pendingProductId:null,scans:[],createdAt:new Date().toISOString()};
  T.scanCodes=new Set();
  await DB.put('draft','current',T.draft);
  localStorage.setItem('stockflow_last_lk',lk.uuid);
  localStorage.setItem('stockflow_last_warehouse',warehouseId);
  view('assemblyView');renderAssembly();
  message('Сборка открыта: '+lk.name+' · '+lk.legalEntity);
}
function isGTINValid(gtin){if(!/^\d{14}$/.test(gtin))return false;let sum=0;for(let i=0;i<13;i++)sum+=Number(gtin[i])*(i%2===0?3:1);return (10-sum%10)%10===Number(gtin[13]);}
function parseDM(value){const code=String(value||'').replace(/^\]d2/,'');const m=code.match(/^01(\d{14})21([^\x1d]{1,20})(?:\x1d|$)/);if(!m)throw Error('Не распознан DataMatrix: нужны AI 01 + GTIN и AI 21 + серия. Проверьте настройки сканера (разделитель GS).');if(!isGTINValid(m[1]))throw Error('Ошибка контрольной цифры GTIN в ЧЗ');return {raw:code,gtin:m[1],serial:m[2]};}
async function start(){await DB.open();T.endpoint=localStorage.getItem('stockflow_endpoint')||'';T.catalog=await DB.get('catalog','snapshot')||T.catalog;T.draft=await DB.get('draft','current')||null;T.queue=await DB.all('queue');buildIndexes();$('employeeId').value=localStorage.getItem('stockflow_employee')||'';showConnection();if(T.endpoint)view('loginView');else view('setupView');}
$('setupForm').onsubmit=e=>{e.preventDefault();const url=$('endpoint').value.trim();let u;try{u=new URL(url);}catch(e){return message('Некорректный URL','bad');}if(u.protocol!=='https:'||u.hostname!=='script.google.com'||!/^\/macros\/s\/[^/]+\/exec$/.test(u.pathname))return message('Нужна опубликованная HTTPS-ссылка Apps Script, оканчивающаяся на /exec','bad');T.endpoint=u.origin+u.pathname;localStorage.setItem('stockflow_endpoint',T.endpoint);view('loginView');message('Адрес сервера сохранён');};
$('changeEndpoint').onclick=()=>{$('endpoint').value=T.endpoint;view('setupView');};
$('loginForm').onsubmit=e=>{e.preventDefault();armAudio();busy($('loginForm').querySelector('button'),async()=>{
  const id=$('employeeId').value.trim();if(!id)throw Error('Введите ID сотрудника');
  try{const response=await API.jsonp(T.endpoint,{op:'login',employeeId:id});T.session=response.token;T.employee=response.employee;localStorage.setItem('stockflow_employee',id);await DB.put('meta','lastEmployee',T.employee);
    try{await syncCatalog();}catch(err){message('Вход выполнен, но обновить справочники не удалось: '+err.message,'bad');}
  }catch(err){const cached=await DB.get('meta','lastEmployee');if((!activeOnline() || /Нет связи|Превышено время ожидания/i.test(err.message)) && cached && cached.id===id && T.catalog.products.length){T.employee=cached;T.session=null;message('Офлайн-вход по ранее подтверждённому ID. На сервер данные уйдут только после повторного онлайн-входа.','');}else throw err;}
  afterLogin();
});};
function afterLogin(){$('userName').textContent=`${T.employee.name} · ${T.employee.id}`;buildIndexes();if(T.draft){view('assemblyView');renderAssembly();}else{view('homeView');renderHome();}if(activeOnline()&&T.session){sendQueue();setTimeout(()=>window.sendReceipts?.(),0);}}
$('logout').onclick=()=>{T.employee=null;T.session=null;view('loginView');};

function renderHome(){
  const warehouse=$('warehouse'),previous=localStorage.getItem('stockflow_last_warehouse');
  warehouse.innerHTML='<option value="">Выберите склад…</option>'+(T.catalog.warehouses||[]).map(w=>
     '<option value="'+escapeHtml(w.uuid)+'">'+escapeHtml(w.name)+'</option>'
  ).join('');
  if(previous&&T.catalog.warehouses.some(w=>w.uuid===previous))warehouse.value=previous;
  $('beginAssembly').textContent=T.draft?'Вернуться к сборке':'Начать сборку →';
  $('cacheStats').textContent='ЛК: '+T.catalog.lks.length+' · Товаров: '+T.catalog.products.length+' · Складов: '+T.catalog.warehouses.length;
  $('cachedAt').textContent=T.catalog.savedAt?new Date(T.catalog.savedAt).toLocaleString('ru-RU'):'Не загружено';
  renderQueue();
}
$('warehouse').addEventListener('change',()=>{if($('warehouse').value)localStorage.setItem('stockflow_last_warehouse',$('warehouse').value);});
$('beginAssembly').onclick=()=>{
  armAudio();
  try{
    if(T.draft){view('assemblyView');renderAssembly();return;}
    if(!$('warehouse').value)throw Error('Сначала выберите склад');
    localStorage.setItem('stockflow_last_warehouse',$('warehouse').value);
    showLKPicker();
  }catch(e){message(e.message,'bad');haptic([140,65,190]);}
};
function renderAssembly(){if(!T.draft)return;const lk=T.catalog.lks.find(x=>x.uuid===T.draft.lkId);$('assemblyTitle').textContent=lk?lk.name+' · '+(lk.legalEntity||''):'ЛК';const codes=T.draft.scans;const stage=T.draft.stage;
  $('assemblyCount').textContent=codes.length+' шт.';$('scanStageCount').textContent=stage==='barcode'?'01 / 02':'02 / 02';
  $('scanTitle').textContent=stage==='barcode'?'Штрихкод товара':'DataMatrix ЧЗ';
  const product=T.byId.get(T.draft.pendingProductId);
  $('scanHelp').textContent=stage==='barcode'?'Сканируйте ШК или артикул. Обычный товар принимается сразу, маркируемый — после ЧЗ.':`Товар: ${product?.article||'Не найден'}. Отсканируйте код ЧЗ.`;
  $('scanInput').value='';$('scanInput').placeholder=stage==='barcode'?'ШК товара…':'GS1 DataMatrix…';$('scanTargetLabel').textContent=stage==='barcode'?'Ожидание штрихкода':'Ожидание DataMatrix ЧЗ';$('scanCard').dataset.stage=stage;
  $('scanStepOne').classList.toggle('done',stage==='dm');$('scanStepTwo').classList.toggle('active',stage==='dm');
  const ag={};codes.forEach(s=>{ag[s.productId]=(ag[s.productId]||0)+1;});const entries=Object.entries(ag);$('scanSummary').textContent=entries.length+' артикулов';
  $('scanHistory').innerHTML=entries.length?entries.slice(-24).reverse().map(([id,n])=>{const p=T.byId.get(id);return `<div class="item"><div><b>${escapeHtml(p?.article||'Неизвестный товар')}</b><small>${escapeHtml(p?.gtin||'')}</small></div><span>${n} шт.</span></div>`;}).join('')+(entries.length>24?`<p class="muted">Показаны 24 из ${entries.length} артикулов</p>`:''):'<p class="muted">Здесь появятся отсканированные товары</p>';
  requestAnimationFrame(focusScanner);
}
/* Urovo CT48 keyboard-wedge input: Enter/Tab may precede input/IME text.
 * Do not treat an empty Enter as a scanned DataMatrix. */
const scanIO={inputTimer:0,emptyTimer:0,pending:[],composing:false,manual:false,focusTimer:0};
function updateScanMode(){
 $('scanForm').classList.toggle('manual-mode',scanIO.manual);
 $('manualKeyboard').textContent=scanIO.manual?'↩ Вернуться к сканеру':'⌨ Ручной ввод';
 $('scanInput').inputMode='text';
 if(!scanIO.manual)requestAnimationFrame(focusScanner);
}
function scanScreenActive(){
  return !!T.draft && !$('assemblyView').classList.contains('hidden')
    && $('pickerOverlay').classList.contains('hidden')
    && $('finishOverlay').classList.contains('hidden')
    && $('conflictOverlay').classList.contains('hidden')
    && $('conflictConfirmOverlay').classList.contains('hidden')
    && $('cancelAssemblyOverlay').classList.contains('hidden');
}
function clearScanTimers(){
  clearTimeout(scanIO.inputTimer);
  clearTimeout(scanIO.emptyTimer);
  scanIO.inputTimer=0;
  scanIO.emptyTimer=0;
}
function missingScannerData(){
  if(!scanScreenActive() || String($('scanInput').value||'').length)return;
  const reason='Сканер CT48 отправил Enter, но код не попал в поле. Откройте ScanWedge → Output mode: Keystroke output (клавиатурный ввод), Keyboard type: Auto text. Затем снова сканируйте ЧЗ.';
  scanSignal(false,reason);
  message(reason,'bad');
  focusScanner();
}
function flushScannedInput(){
  if(!scanScreenActive()) return;
  clearScanTimers();
  const input=$('scanInput'),value=input.value;
  if(!value || !value.trim()){
    scanIO.emptyTimer=setTimeout(missingScannerData,900);
    return;
  }
  input.value='';
  if(T.scanBusy){
    if(scanIO.pending.length<20)scanIO.pending.push(value);
    else {scanSignal(false,'Очередь сканирования переполнена. Не сканируйте следующий код до завершения обработки.');}
    return;
  }
  void acceptScan(value);
}
function scheduleScanCommit(delay){
  clearTimeout(scanIO.inputTimer);
  clearTimeout(scanIO.emptyTimer);
  scanIO.inputTimer=setTimeout(flushScannedInput,delay);
}
$('scanForm').onsubmit=e=>{
  e.preventDefault();armAudio();
  scheduleScanCommit($('scanInput').value?80:320);
};
$('scanInput').addEventListener('input',()=>{
  clearTimeout(scanIO.emptyTimer);
  if(!scanScreenActive() || scanIO.composing || scanIO.manual)return;
  const value=$('scanInput').value;
  if(value.length >= (T.draft.stage==='dm'?18:5)){
    // Idle debounce: scanner batches key events or Android IME paste asynchronously.
    scheduleScanCommit(240);
  }
});
$('scanInput').addEventListener('compositionstart',()=>{scanIO.composing=true;clearTimeout(scanIO.inputTimer);});
$('scanInput').addEventListener('compositionend',()=>{
  scanIO.composing=false;
  if(!scanIO.manual && $('scanInput').value) scheduleScanCommit(240);
});
document.addEventListener('keydown',e=>{
  if(!scanScreenActive())return;
  const field=$('scanInput');
  const target=e.target;
  const otherControl=target!==field && target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName||'');
  if(otherControl)return;
  // Hardware ScanWedge can type while a recently pressed action button has focus.
  if(e.key==='Enter' || e.key==='Tab'){
    e.preventDefault();
    armAudio();
    scheduleScanCommit(field.value?100:350);
    return;
  }
  // Some keystroke profiles send characters after the focus is lost.
  if(target!==field && typeof e.key==='string' && e.key.length===1 &&
     !e.ctrlKey && !e.altKey && !e.metaKey){
    e.preventDefault();
    focusScanner();
    field.value+=e.key;
    field.dispatchEvent(new Event('input',{bubbles:true}));
  }
},true);
$('manualKeyboard').onclick=()=>{
 armAudio();scanIO.manual=!scanIO.manual;clearScanTimers();updateScanMode();focusScanner();
};
$('assemblyView').addEventListener('click',e=>{if(e.target.closest('button,a,video'))return;focusScanner();});
async function acceptScan(value){if(T.scanBusy)return;T.scanBusy=true;try{
 let feedbackText='';
  if(!T.draft)throw Error('Нет активной сборки');const val=String(value||'').trim();if(!val)throw Error('Пустой скан');
  if(T.draft.stage==='barcode'){
    const candidates=T.byBarcode.get(val.toLowerCase())||[];
    if(!candidates.length)throw Error('Штрихкод не найден в общем каталоге: '+val);
    if(candidates.length>1)throw Error('Штрихкод привязан к нескольким товарам. Исправьте общий каталог.');
    const p=candidates[0];
    if(productNeedsCHZ(p)){
      T.draft.pendingProductId=p.uuid;T.draft.stage='dm';
      feedbackText='ШК верный · '+p.article+' · Отсканируйте ЧЗ';
    }else{
      T.draft.scans.push({productId:p.uuid,barcode:val,dm:'',gtin:''});
      T.draft.pendingProductId=null;T.draft.stage='barcode';
      feedbackText='Обычный товар принят без ЧЗ · '+p.article+' · Всего '+T.draft.scans.length+' шт.';
    }
  }else{
    const p=T.byId.get(T.draft.pendingProductId);if(!p)throw Error('Сначала сканируйте ШК товара');
    const dm=parseDM(val);if(dm.gtin!==p.gtin)throw Error('GTIN ЧЗ '+dm.gtin+' не совпадает с товаром ('+p.gtin+')');
    if(T.scanCodes.has(dm.raw))throw Error('Этот ЧЗ уже отсканирован в текущей сборке');
    T.draft.scans.push({productId:p.uuid,barcode:p.barcodes?.[0]||p.articleCode,dm:dm.raw,gtin:dm.gtin});T.scanCodes.add(dm.raw);T.draft.pendingProductId=null;T.draft.stage='barcode';
    feedbackText='ЧЗ принят · '+p.article+' · Всего '+T.draft.scans.length+' шт.';
  }
  await DB.put('draft','current',T.draft);renderAssembly();scanSignal(true,feedbackText);
}catch(err){scanSignal(false,err.message);message(err.message,'bad');focusScanner();$('scanInput').select();}finally{T.scanBusy=false;if(scanIO.pending.length){const next=scanIO.pending.shift();Promise.resolve().then(()=>acceptScan(next));}}}
$('backHome').onclick=()=>{stopCamera();view('homeView');renderHome();if(T.draft)message('Незакрытая сборка сохранена локально. Нажмите «Вернуться к сборке», чтобы продолжить.','');};

let cancellingDraft=false;
$('cancelAssembly').onclick=()=>{
 if(cancellingDraft||T.scanBusy)return message('Дождитесь завершения текущего сканирования и повторите отмену.','bad');
 if(!T.draft)return message('Активной сборки нет.','bad');
 clearScanTimers();
 const draft=T.draft,lk=T.catalog.lks.find(x=>x.uuid===draft.lkId),
       warehouse=T.catalog.warehouses.find(x=>x.uuid===draft.warehouseId);
 $('cancelAssemblySummary').innerHTML=
  '<div><span>Личный кабинет</span><b>'+escapeHtml(lk?.name||'—')+'</b></div>'+
  '<div><span>Юридическое лицо</span><b>'+escapeHtml(lk?.legalEntity||'—')+'</b></div>'+
  '<div><span>Склад</span><b>'+escapeHtml(warehouse?.name||'—')+'</b></div>'+
  '<div><span>Отсканировано</span><b>'+draft.scans.length+' шт.</b></div>';
 $('cancelAssemblyOverlay').classList.remove('hidden');
 setViewportSheet();
};
$('keepAssembly').onclick=()=>{
 if(cancellingDraft)return;
 $('cancelAssemblyOverlay').classList.add('hidden');
 requestAnimationFrame(focusScanner);
};
$('cancelAssemblyOverlay').addEventListener('click',e=>{
 if(e.target===$('cancelAssemblyOverlay'))$('keepAssembly').click();
});
$('confirmCancelAssembly').onclick=async()=>{
 if(cancellingDraft)return;
 if(T.scanBusy)return message('Сканирование ещё выполняется. Попробуйте снова.','bad');
 if(!T.draft)return message('Сборка уже отсутствует.','bad');
 cancellingDraft=true;
 const btn=$('confirmCancelAssembly');btn.disabled=true;
 const expected={createdAt:T.draft.createdAt,lkId:T.draft.lkId,warehouseId:T.draft.warehouseId};
 try{
  await DB.cancelDraft(expected);
  clearScanTimers();scanIO.pending.length=0;T.scanCodes.clear();
  T.draft=null;
  stopCamera();
  $('scanInput').value='';
  $('cancelAssemblyOverlay').classList.add('hidden');
  view('homeView');renderHome();
  haptic([60,40,90]);
  message('Сборка отменена. Черновик удалён; выберите правильный ЛК и начните новую сборку.');
 }catch(e){
  message('Не удалось отменить сборку: '+e.message,'bad');
 }finally{
  cancellingDraft=false;btn.disabled=false;
 }
};
$('finishAssembly').onclick=()=>{
  armAudio();
  try{
    if(!T.draft)throw Error('Нет активной сборки');
    if(T.draft.stage==='dm')throw Error('Сначала отсканируйте ЧЗ последнего товара');
    if(!T.draft.scans.length)throw Error('Нет отсканированных товаров');
    const lk=T.catalog.lks.find(x=>x.uuid===T.draft.lkId);
    const warehouse=T.catalog.warehouses.find(x=>x.uuid===T.draft.warehouseId);
    const count=new Set(T.draft.scans.map(x=>x.productId)).size;
    $('finishDescription').textContent='Проверьте итог и подтвердите закрытие.';
    $('finishSummary').innerHTML=
      '<div><span>Юридическое лицо</span><b>'+escapeHtml(lk?.legalEntity||'—')+'</b></div>'+
      '<div><span>Личный кабинет</span><b>'+escapeHtml(lk?.name||'—')+'</b></div>'+
      '<div><span>Склад</span><b>'+escapeHtml(warehouse?.name||'—')+'</b></div>'+
      '<div><span>Количество</span><b>'+T.draft.scans.length+' шт. · '+count+' артикулов</b></div>';
    $('finishOverlay').classList.remove('hidden');setViewportSheet();
  }catch(e){scanSignal(false,e.message);message(e.message,'bad');}
};
$('cancelFinish').onclick=()=>{$('finishOverlay').classList.add('hidden');focusScanner();};
$('finishOverlay').addEventListener('click',e=>{if(e.target===$('finishOverlay'))$('cancelFinish').click();});
$('confirmFinish').onclick=()=>busy($('confirmFinish'),async()=>{
  if(!T.draft||T.draft.stage!=='barcode'||!T.draft.scans.length)throw Error('Сборка не готова к закрытию');
  const id=crypto.randomUUID(),byProduct=new Map();
  T.draft.scans.forEach(s=>{
    if(!byProduct.has(s.productId))byProduct.set(s.productId,{qty:0,codes:[]});
    const group=byProduct.get(s.productId);
    group.qty++;
    if(s.dm)group.codes.push(s.dm);
  });
  const items=[...byProduct].map(([productId,g])=>({productId,qty:g.qty,codes:g.codes}));
  for(const item of items){
    const p=T.byId.get(item.productId);
    if(!p)throw Error('Товар отсутствует в справочнике. Обновите его.');
    if(productNeedsCHZ(p)&&item.codes.length!==item.qty)throw Error('Недостаточно ЧЗ для маркируемого товара '+p.article);
    if(!productNeedsCHZ(p)&&item.codes.length)throw Error('У обычного товара неожиданно появились ЧЗ: '+p.article);
  }
  const job={jobId:id,employeeId:T.employee.id,lkId:T.draft.lkId,warehouseId:T.draft.warehouseId,items,qty:T.draft.scans.length,createdAt:new Date().toISOString(),status:'QUEUED',message:''};
  await DB.commitAssembly(job);
  T.draft=null;T.queue=await DB.all('queue');$('finishOverlay').classList.add('hidden');
  stopCamera();view('homeView');renderHome();
  message('Сборка '+job.qty+' шт. сохранена. Отправка в фоне при наличии связи.');
  haptic([60,35,60]);playTone(true);
  if(activeOnline()&&T.session)sendQueue();
});
$('syncCatalog').onclick=()=>busy($('syncCatalog'),async()=>{const changed=await syncCatalog(true);renderHome();message(changed?'Справочники обновлены':'Нет изменений');});
async function syncCatalog(force=false){
 if(!T.session)throw Error('Для синхронизации войдите онлайн');
 stage('Проверяем изменения справочников…',null);
 try{
  const meta=await API.jsonp(T.endpoint,{op:'meta',token:T.session});
  if(!force&&T.catalog.products.length&&T.catalog.version===meta.version){stageEnd();return false;}
  const products=[],lks=[],warehouses=[];let page=0,version='';
  while(true){
   const part=await API.jsonp(T.endpoint,{op:'catalog',token:T.session,page,limit:300});
   if(page===0){lks.push(...part.lks);warehouses.push(...part.warehouses);version=part.version;}
   if(part.version!==version)throw Error('Справочник изменился во время загрузки. Обновите ещё раз.');
   products.push(...part.products);
   stage('Загружено товаров: '+products.length+' / '+part.total,part.total?Math.round(products.length/part.total*100):100);
   if(part.nextPage===null)break;
   page=part.nextPage;if(page>10000)throw Error('Слишком много страниц справочника');
  }
  const snapshot={lks,warehouses,products,version,savedAt:new Date().toISOString(),schema:'unified-v5.1'};
  await DB.replaceCatalog(snapshot);T.catalog=snapshot;buildIndexes();return true;
 }finally{stageEnd();}
}

function conflictParts(job){
 const all=[];
 (job.items||[]).forEach((item,i)=>(item.codes||[]).forEach((code,j)=>all.push({itemIndex:i,codeIndex:j,productId:item.productId,rawCode:code})));
 return all;
}
function conflictMatches(job){
 const conflicts=job.conflicts||[];
 const flat=conflictParts(job);
 return conflicts.map(c=>{
  const match=flat.find(x=>x.itemIndex===c.itemIndex&&x.codeIndex===c.codeIndex&&x.rawCode===c.rawCode);
  return {conflict:c,found:match};
 });
}
function renderQueue(){
 const pending=T.queue.filter(j=>!['SUCCESS','RESOLVED'].includes(j.status));
 $('queueCount').textContent=pending.length;
 $('queueList').innerHTML=pending.length?pending.slice().reverse().map(j=>{
  const lk=T.catalog.lks.find(x=>x.uuid===j.lkId);
  const labels={QUEUED:'На устройстве',SENDING:'Отправляется',UNCERTAIN:'Ожидает ответа',ERROR:'Ошибка сервера'};
  const conflict=j.status==='ERROR'&&((j.errorCode==='CHZ_DUPLICATES'&&j.safeToResubmit&&Array.isArray(j.conflicts)&&j.conflicts.length)||(/^ЧЗ уже учтён ранее|^ЧЗ повторяется в сборке/i.test(j.message||'')));
  return '<div class="item job"><div><b>'+escapeHtml(j.kind==='RECEIPT'?'Приёмка':(lk?.name||'ЛК'))+' · '+j.qty+' шт.</b><small>'+new Date(j.createdAt).toLocaleString('ru-RU')+' · '+escapeHtml(j.jobId.slice(0,8))+'</small><small>'+escapeHtml(j.message||'Сохранено локально')+'</small>'+
    (conflict?'<button type="button" class="primary conflict-open" data-job="'+escapeHtml(j.jobId)+'">'+(j.totalConflicts?'Проверить дубли · '+(j.confirmedConflicts?.length||0)+'/'+j.totalConflicts:'Проверить дубли')+'</button>':'')+
    '</div><span class="job-status '+(j.status==='ERROR'?'error':j.status==='UNCERTAIN'?'unknown':'')+'">'+escapeHtml(labels[j.status]||j.status)+'</span></div>';
 }).join(''):'<p class="muted">Очередь пуста. Подтверждённые задания удалены из очереди, а разрешённые конфликты сохранены в архиве устройства.</p>';
 $('sendQueue').disabled=T.sending||pending.every(j=>j.status==='ERROR');
}
$('queueList').addEventListener('click',e=>{
 const btn=e.target.closest('.conflict-open');
 if(btn)openConflict(btn.dataset.job);
});
let conflictJobId='';
function openConflict(id){
 const job=T.queue.find(j=>j.jobId===id);
 if(!job||job.status!=='ERROR')return;
 if(job.errorCode!=='CHZ_DUPLICATES' && /^ЧЗ уже учтён ранее|^ЧЗ повторяется в сборке/i.test(job.message||'')){
   if(!T.session){message('Для проверки старой сборки войдите онлайн.','bad');return;}
   const scans=conflictParts(job);
   if(scans.length>2000){message('Слишком большая сборка для проверки','bad');return;}
   stage('Проверяем ЧЗ старой сборки на сервере…',null);
   (async()=>{
     try{
       const conflicts=[],seen=new Set();
       for(let i=0;i<scans.length;i+=12){
         const chunk=scans.slice(i,i+12);
         const found=await API.jsonp(T.endpoint,{op:'findDuplicateCHZ',token:T.session,codes:JSON.stringify(chunk.map(x=>x.rawCode))});
         found.duplicates.forEach((x,j)=>{
           const scan=chunk[j],inside=seen.has(scan.rawCode);
           if(x.registered||inside)conflicts.push({...scan,reason:x.registered?'REGISTERED':'IN_ASSEMBLY'});
           seen.add(scan.rawCode);
         });
       }
       if(!conflicts.length)throw Error('Дубли не найдены. Не разрешайте старую ошибку без проверки администратора.');
       job.errorCode='CHZ_DUPLICATES';job.safeToResubmit=true;
       job.conflicts=conflicts;job.totalConflicts=conflicts.length;
       await DB.put('queue',job.jobId,job);
       T.queue=await DB.all('queue');renderQueue();openConflict(job.jobId);
     }catch(e){message('Не удалось проверить старую сборку: '+e.message,'bad');}
     finally{stageEnd();}
   })();
   return;
 }
 if(job.errorCode!=='CHZ_DUPLICATES'||!job.safeToResubmit)return;
 if(job.totalConflicts!==job.conflicts.length){message('Сервер вернул не все дубли. Требуется дополнительная проверка администратора.','bad');return;}
 const matches=conflictMatches(job);
 if(matches.some(x=>!x.found)){message('Невозможно однозначно сопоставить конфликт с товаром. Не списывайте вручную.','bad');return;}
 conflictJobId=id;
 const lk=T.catalog.lks.find(x=>x.uuid===job.lkId),wh=T.catalog.warehouses.find(x=>x.uuid===job.warehouseId);
 $('conflictContext').textContent=(lk?.name||'ЛК')+' · '+(wh?.name||'Склад')+' · '+job.qty+' шт.';
 $('conflictOverlay').classList.remove('hidden');
 $('conflictConfirmOverlay').classList.add('hidden');
 conflictManual=false;
 $('conflictSearch').inputMode='text';
 $('conflictReceiver').classList.remove('manual-mode');
 $('conflictKeyboard').textContent='⌨ Ручной ввод';
 $('conflictSearch').value='';
 renderConflictRows(job);
 setViewportSheet();
 focusConflictScanner();
 if((job.confirmedConflicts||[]).length===job.totalConflicts){
   void finalizeConfirmedConflicts(id).catch(e=>message(e.message,'bad'));
 }
}
const conflictScan={timer:null,busy:false,candidate:null};
let conflictManual=false;
function conflictKey(c){return String(c.itemIndex)+'|'+String(c.codeIndex);}
function conflictCode(v){
 return String(v==null?'':v).replace(/^\]d2/,'').replace(/[\r\n]+$/g,'');
}
function conflictIsOpen(){
 return !$('conflictOverlay').classList.contains('hidden');
}
function focusConflictScanner(){
 if(document.hidden||!conflictIsOpen()||!$('conflictConfirmOverlay').classList.contains('hidden'))return;
 const input=$('conflictSearch');
 if(document.activeElement!==input){try{input.focus({preventScroll:true});}catch(_){input.focus();}}
}
function currentConflictJob(){
 return T.queue.find(j=>j.jobId===conflictJobId);
}
function renderConflictRows(job){
 const matches=conflictMatches(job);
 const done=new Set((job.confirmedConflicts||[]).map(conflictKey));
 $('conflictCount').textContent='Проверено '+done.size+' из '+matches.length;
 $('conflictList').innerHTML=matches.map((x,i)=>{
  const p=T.byId.get(x.conflict.productId),verified=done.has(conflictKey(x.conflict));
  return '<div class="conflict-row '+(verified?'conflict-done':'')+'"><div class="conflict-heading">'+
    (verified?'✓ Подтверждено удаление':'⚠ Требует сканирования')+' · '+(i+1)+'/'+matches.length+'</div>'+
    '<b>'+escapeHtml(p?.article||x.conflict.article||'Товар')+'</b>'+
    '<small>GTIN '+escapeHtml(p?.gtin||'—')+' · '+escapeHtml(x.conflict.reason==='IN_ASSEMBLY'?'Дубль внутри сборки':'Уже есть на сервере')+'</small>'+
    '<code>'+escapeHtml(x.conflict.rawCode)+'</code></div>';
 }).join('');
 $('conflictHelp').textContent=done.size===matches.length
   ?'Все дубли подтверждены. Сохраняем сборку и ставим оставшиеся товары в очередь…'
   :'Отсканируйте DataMatrix товара, который нужно убрать из сборки. После сканирования подтвердите его физическое удаление.';
}
function conflictFeedback(ok,text){
 const box=$('conflictFeedback');
 box.textContent=text;
 box.className='conflict-feedback '+(ok?'success':'failure');
 haptic(ok?[50]:[130,60,170]);
 playTone(ok);
}
function conflictScanInput(){
 clearTimeout(conflictScan.timer);
 conflictScan.timer=setTimeout(()=>void verifyConflictScan(),conflictManual?1400:400);
}
async function verifyConflictScan(){
 if(conflictScan.busy||!conflictIsOpen()||!$('conflictConfirmOverlay').classList.contains('hidden'))return;
 clearTimeout(conflictScan.timer);
 const scanned=conflictCode($('conflictSearch').value);
 if(!scanned){
  conflictFeedback(false,'Сканер не передал DataMatrix. Проверьте клавиатурный режим ScanWedge.');
  focusConflictScanner();
  return;
 }
 $('conflictSearch').value='';
 const job=currentConflictJob();
 if(!job){conflictFeedback(false,'Задание отсутствует в очереди');return;}
 const matches=conflictMatches(job);
 const verified=new Set((job.confirmedConflicts||[]).map(conflictKey));
 const pending=matches.find(x=>conflictCode(x.conflict.rawCode)===scanned&&!verified.has(conflictKey(x.conflict)));
 if(!pending){
  const already=matches.some(x=>conflictCode(x.conflict.rawCode)===scanned);
  conflictFeedback(false,already?'Этот экземпляр ЧЗ уже проверен. Сканируйте следующий проблемный товар.':'Отсканированный ЧЗ отсутствует в списке дублей. Товар не удалён из задания.');
  focusConflictScanner();
  return;
 }
 conflictScan.candidate={jobId:job.jobId,key:conflictKey(pending.conflict),rawCode:pending.conflict.rawCode};
 const p=T.byId.get(pending.conflict.productId);
 $('conflictProduct').textContent=p?.article||pending.conflict.article||'Товар';
 $('conflictGtin').textContent='GTIN: '+(p?.gtin||'—');
 $('conflictMatrix').textContent=pending.conflict.rawCode;
 $('conflictConfirmOverlay').classList.remove('hidden');
 $('conflictConfirmRemove').disabled=false;
 conflictFeedback(false,'Дубль найден. Уберите товар физически и подтвердите это в окне.');
}
$('conflictSearch').addEventListener('input',()=>{
 if(conflictIsOpen()&&$('conflictConfirmOverlay').classList.contains('hidden')&&!conflictManual){
   conflictScanInput();
 }
});
$('conflictSearch').addEventListener('compositionend',()=>{if(!conflictManual)conflictScanInput();});
$('conflictSearch').addEventListener('keydown',e=>{
 if(e.key==='Enter'||e.key==='Tab'){
  e.preventDefault();e.stopPropagation();
  clearTimeout(conflictScan.timer);
  conflictScan.timer=setTimeout(()=>void verifyConflictScan(),$('conflictSearch').value?120:460);
 }
});
document.addEventListener('keydown',e=>{
 if(!conflictIsOpen()||!$('conflictConfirmOverlay').classList.contains('hidden'))return;
 const input=$('conflictSearch'),target=e.target;
 if(target===input)return;
 if(target&&/^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName||''))return;
 if(e.key==='Enter'||e.key==='Tab'){
  e.preventDefault();clearTimeout(conflictScan.timer);
  conflictScan.timer=setTimeout(()=>void verifyConflictScan(),input.value?120:460);
 }else if(e.key.length===1&&!e.ctrlKey&&!e.altKey&&!e.metaKey){
  e.preventDefault();focusConflictScanner();input.value+=e.key;
  input.dispatchEvent(new Event('input',{bubbles:true}));
 }
},true);
$('conflictKeyboard').onclick=()=>{
 conflictManual=!conflictManual;
 $('conflictSearch').inputMode='text';
 $('conflictReceiver').classList.toggle('manual-mode',conflictManual);
 $('conflictKeyboard').textContent=conflictManual?'↩ Вернуться к сканеру':'⌨ Ручной ввод';
 focusConflictScanner();
};
$('conflictVerify').onclick=()=>void verifyConflictScan();
$('conflictClose').onclick=()=>{
 if(conflictScan.busy)return;
 clearTimeout(conflictScan.timer);
 $('conflictOverlay').classList.add('hidden');
 $('conflictConfirmOverlay').classList.add('hidden');
 conflictScan.candidate=null;conflictJobId='';
};
$('conflictCancelRemove').onclick=()=>{
 if(conflictScan.busy)return;
 $('conflictConfirmOverlay').classList.add('hidden');
 conflictScan.candidate=null;
 $('conflictSearch').value='';
 $('conflictFeedback').textContent='Отмена подтверждения. Отсканируйте нужный DataMatrix.';
 $('conflictFeedback').className='conflict-feedback';
 focusConflictScanner();
};
$('conflictConfirmRemove').onclick=async()=>{
 if(conflictScan.busy)return;
 conflictScan.busy=true;
 const btn=$('conflictConfirmRemove');btn.disabled=true;
 try{
  const candidate=conflictScan.candidate;
  if(!candidate||!conflictJobId||candidate.jobId!==conflictJobId)throw Error('Не выбран код для подтверждения');
  const job=await DB.get('queue',conflictJobId);
  if(!job||job.status!=='ERROR'||job.errorCode!=='CHZ_DUPLICATES'||!job.safeToResubmit)
    throw Error('Задание больше не находится в безопасном состоянии для исправления');
  const matches=conflictMatches(job);
  const match=matches.find(x=>conflictKey(x.conflict)===candidate.key&&x.conflict.rawCode===candidate.rawCode&&x.found);
  if(!match)throw Error('Код не соответствует конфликту. Повторите проверку');
  const confirmations=job.confirmedConflicts||[];
  if(confirmations.some(x=>conflictKey(x)===candidate.key))throw Error('Этот товар уже отмечен как убранный');
  job.confirmedConflicts=[...confirmations,{
   itemIndex:match.conflict.itemIndex,codeIndex:match.conflict.codeIndex,
   rawCode:match.conflict.rawCode,productId:match.conflict.productId,
   confirmedBy:T.employee.id,confirmedAt:new Date().toISOString()
  }];
  await DB.put('queue',job.jobId,job);
  T.queue=await DB.all('queue');
  $('conflictConfirmOverlay').classList.add('hidden');
  conflictScan.candidate=null;
  $('conflictSearch').value='';
  renderConflictRows(job);
  conflictFeedback(true,'Подтверждено: товар убран. '+job.confirmedConflicts.length+' из '+job.totalConflicts);
  if(job.confirmedConflicts.length===job.totalConflicts){
   await finalizeConfirmedConflicts(job.jobId);
  }else{
   focusConflictScanner();
  }
 }catch(e){
  conflictFeedback(false,'Не удалось сохранить подтверждение: '+e.message);
  message(e.message,'bad');
 }finally{conflictScan.busy=false;btn.disabled=false;}
};
async function finalizeConfirmedConflicts(jobId){
 const job=await DB.get('queue',jobId);
 if(!job||job.status!=='ERROR'||job.errorCode!=='CHZ_DUPLICATES'||!job.safeToResubmit)
  throw Error('Нельзя автоматически отправить сборку: неверный статус');
 const matches=conflictMatches(job);
 const verified=job.confirmedConflicts||[];
 const keys=new Set(verified.map(conflictKey));
 if(!matches.length||matches.length!==job.totalConflicts||keys.size!==matches.length||
    matches.some(x=>!x.found||!keys.has(conflictKey(x.conflict))) ||
    verified.some(x=>!matches.some(y=>conflictKey(x)===conflictKey(y.conflict)&&x.rawCode===y.conflict.rawCode))){
  throw Error('Не все конфликтные ЧЗ проверены. Остаток сборки не отправлен.');
 }
 const drop=new Set(verified.map(conflictKey));
 const items=job.items.map((item,i)=>{
   const p=T.byId.get(item.productId);
   const codes=item.codes.filter((_,j)=>!drop.has(i+'|'+j));
   return {...item,codes,qty:productNeedsCHZ(p)?codes.length:Number(item.qty)};
  }).filter(item=>item.qty>0);
 const count=items.reduce((n,item)=>n+item.qty,0);
 const newJob=count?{jobId:crypto.randomUUID(),employeeId:T.employee.id,
   lkId:job.lkId,warehouseId:job.warehouseId,items,qty:count,
   createdAt:new Date().toISOString(),status:'QUEUED',message:'После исключения дублей ЧЗ из '+job.jobId.slice(0,8),
   parentJobId:job.jobId}:null;
 await DB.resolveConflict(job.jobId,newJob,verified);
 T.queue=await DB.all('queue');
 $('conflictConfirmOverlay').classList.add('hidden');
 $('conflictOverlay').classList.add('hidden');
 conflictJobId='';conflictScan.candidate=null;
 renderQueue();
 conflictFeedback(true,'Проверено и исключено '+verified.length+' дублей.');
 message(newJob?'Дубли удалены. Оставшиеся '+count+' шт. отправляются на сервер.':'Все товары были дублями; отправлять нечего.');
 if(newJob&&T.session&&activeOnline()){
   if(T.sending)setTimeout(()=>sendQueue(),1500);
   else void sendQueue();
 }
}
$('sendQueue').onclick=()=>sendQueue();
async function sendQueue(){
 if(T.sending)return;
 if(!T.session){message('Для отправки очереди выполните онлайн-вход','bad');return;}
 if(!activeOnline()){message('Нет соединения. Очередь сохранена на устройстве.','');return;}
 T.sending=true;$('sendQueue').disabled=true;
 try{
  T.queue=await DB.all('queue');
  const items=T.queue.filter(j=>j.kind!=='RECEIPT'&&!['ERROR','RESOLVED','SUCCESS'].includes(j.status));
  let num=0;
  for(const job of items){
   num++;
   job.status='SENDING';job.message='Проверяем подтверждение на сервере';
   await DB.put('queue',job.jobId,job);
   T.queue=await DB.all('queue');renderQueue();
   stage('Передача сборки '+num+' из '+items.length+' · '+job.qty+' шт.',Math.round((num-1)/items.length*100));
   let result;
   try{result=await API.sendAssembly(T.endpoint,{action:'assembly',token:T.session,jobId:job.jobId,lkId:job.lkId,warehouseId:job.warehouseId,items:job.items});}
   catch(e){
    job.status='UNCERTAIN';job.message=e.message;
    await DB.put('queue',job.jobId,job);
    message('Нет подтверждения сервера: '+e.message,'bad');
    break; // Could have written; stop until jobId status is known.
   }
   if(result.status==='SUCCESS'){
    await DB.del('queue',job.jobId);
    stage('Подтверждена сборка '+num+' из '+items.length,Math.round(num/items.length*100));
    message('Подтверждено сервером: '+job.qty+' шт. · '+job.jobId.slice(0,8));
   }else if(result.status==='ERROR'){
    job.status='ERROR';job.message=result.message||'Ошибка сервера';
    if(result.errorCode==='CHZ_DUPLICATES'&&result.safeToResubmit&&Array.isArray(result.conflicts)){
      job.errorCode=result.errorCode;job.conflicts=result.conflicts;job.totalConflicts=result.totalConflicts;job.safeToResubmit=true;
      job.message='Обнаружено повторных кодов ЧЗ: '+job.totalConflicts+'. Откройте поиск дублей.';
    }else{job.errorCode='';job.conflicts=[];job.safeToResubmit=false;}
    await DB.put('queue',job.jobId,job);
    message('Ошибка сборки '+job.jobId.slice(0,8)+': '+job.message,'bad');
    // Known validation error before writes is isolated; continue sending OTHER jobs.
   }else{
    job.status='UNCERTAIN';job.message=result.message||'Нет подтверждения';
    await DB.put('queue',job.jobId,job);
    message('Сборка '+job.jobId.slice(0,8)+' пока не подтверждена, повторно сканировать её нельзя.','bad');
    break;
   }
  }
 }finally{
  stageEnd();T.queue=await DB.all('queue');T.sending=false;
  if(!$('homeView').classList.contains('hidden'))renderQueue();
 }
}

// Camera scanning is optional. Hardware TSD scanners work as keyboard input + Enter.
$('cameraBtn').onclick=async()=>{try{if(!('BarcodeDetector'in window))throw Error('Браузер не поддерживает BarcodeDetector. Используйте сканер ТСД или ручной ввод.');
  const formats=await BarcodeDetector.getSupportedFormats();const needed=T.draft?.stage==='dm'?'data_matrix':'code_128';
  if(!formats.includes(needed)&&!formats.includes('data_matrix'))throw Error('Камера браузера не поддерживает требуемые форматы штрихкодов');
  T.cameraStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'},audio:false});
  $('cameraVideo').srcObject=T.cameraStream;$('cameraBox').classList.remove('hidden');const detector=new BarcodeDetector({formats:formats.filter(x=>['data_matrix','ean_13','ean_8','code_128','upc_a','itf'].includes(x))});
  T.cameraTimer=setInterval(async()=>{if(T.cameraBusy||!T.cameraStream)return;T.cameraBusy=true;try{const found=await detector.detect($('cameraVideo'));if(found.length){const v=found[0].rawValue;stopCamera();await acceptScan(v);}}catch(e){}finally{T.cameraBusy=false;}},650);
}catch(err){message(err.message,'bad');stopCamera();}};
$('cameraStop').onclick=stopCamera;
function stopCamera(){clearInterval(T.cameraTimer);T.cameraTimer=null;T.cameraStream?.getTracks().forEach(t=>t.stop());T.cameraStream=null;$('cameraBox').classList.add('hidden');}
/* Restore wedge focus after any screen transition, app resume or toolbar touch.
 * Only a visible scanner gets focus; forms, confirmation dialogs, and LK search retain control. */
function restoreWedgeFocus(){
 if(document.hidden)return;
 if(conflictIsOpen()){
   if($('conflictConfirmOverlay').classList.contains('hidden'))focusConflictScanner();
 }else if(scanScreenActive())focusScanner();
}
function deferWedgeFocus(delay=80){
 clearTimeout(scanIO.focusTimer);
 scanIO.focusTimer=setTimeout(restoreWedgeFocus,delay);
}
document.addEventListener('focusout',e=>{
 if(e.target===$('scanInput')||e.target===$('conflictSearch'))deferWedgeFocus(110);
},true);
document.addEventListener('pointerup',()=>deferWedgeFocus(100),true);
document.addEventListener('touchend',()=>deferWedgeFocus(110),{passive:true,capture:true});
window.addEventListener('pageshow',()=>deferWedgeFocus(130));
window.addEventListener('focus',()=>deferWedgeFocus(130));
window.addEventListener('online',()=>{showConnection();if(T.session)sendQueue();});
window.addEventListener('offline',showConnection);
window.addEventListener('focus',()=>{if(T.session&&activeOnline()&&!T.sending)sendQueue();});
document.addEventListener('visibilitychange',()=>{
 if(!document.hidden){
  deferWedgeFocus(140);
  if(T.session&&activeOnline())sendQueue();
 }
});
if('serviceWorker'in navigator)navigator.serviceWorker.register('./sw.js').catch(e=>console.warn('SW:',e));
start().then(()=>window.stockflowBootReady?.()).catch(e=>{window.stockflowBootError?.(e.message);message('Ошибка инициализации IndexedDB: '+e.message,'bad');});
