/* StockFlow TSD API v2.0.6 — Google Apps Script transport. Do not translate JS source. */
'use strict';
window.API = (() => {
  function callbackId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return 'cb_' + window.crypto.randomUUID().replace(/-/g, '');
    }
    return 'cb_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2);
  }

  function jsonp(endpoint, params) {
    return new Promise((resolve, reject) => {
      if (!endpoint) { reject(new Error('Не указан адрес сервера Apps Script')); return; }
      const callback = callbackId();
      const script = document.createElement('script');
      const url = new URL(endpoint);
      url.searchParams.set('api', 'tsd');
      url.searchParams.set('callback', callback);
      Object.entries(params || {}).forEach(([key, value]) => {
        url.searchParams.set(key, String(value));
      });
      let finished = false;
      const timer = setTimeout(() => finish(new Error('Превышено время ожидания сервера')), 26000);
      function finish(error, result) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try { delete window[callback]; } catch (_) { window[callback] = undefined; }
        script.remove();
        if (error) reject(error);
        else resolve(result);
      }
      window[callback] = response => {
        if (!response || !response.ok) {
          finish(new Error((response && response.error) || 'Ошибка сервера'));
        } else {
          finish(null, response.data);
        }
      };
      script.onerror = () => finish(new Error('Нет ответа от Apps Script. Проверьте ссылку /exec, публичный доступ к развёртыванию и код callback.'));
      script.src = url.toString();
      document.head.appendChild(script);
    });
  }

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function sendAssembly(endpoint, payload) {
    if (!endpoint) throw new Error('Не указан адрес сервера Apps Script');
    // GAS response for no-cors POST is opaque. Confirm the job by its stable jobId.
    try {
      await fetch(endpoint, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
        redirect: 'follow'
      });
    } catch (_) {
      // The POST might still have reached GAS. Check before retrying.
    }
    for (let attempt = 0; attempt < 7; attempt++) {
      await sleep(attempt === 0 ? 1200 : 2300);
      try {
        const result = await jsonp(endpoint, {
          op: 'jobStatus',
          token: payload.token,
          jobId: payload.jobId
        });
        if (result && (result.status === 'SUCCESS' || result.status === 'ERROR')) {
          return result;
        }
      } catch (error) {
        if (/Сессия истекла|Доступ сотрудника закрыт/.test(error.message)) throw error;
      }
    }
    return {
      status: 'UNCERTAIN',
      message: 'Нет подтверждения сервера. Задание осталось в очереди; не сканируйте его повторно.'
    };
  }

  /** Receipt POST is opaque on GAS; status is authoritative. Never issue a new job ID on retries. */
  async function sendReceipt(endpoint,payload) {
    if(!endpoint)throw Error('Не указан адрес сервера Apps Script');
    try{
      await fetch(endpoint,{method:'POST',mode:'no-cors',
        headers:{'Content-Type':'text/plain;charset=utf-8'},
        body:JSON.stringify(payload),redirect:'follow'});
    }catch(_){}
    for(let attempt=0;attempt<7;attempt++){
      await sleep(attempt===0?1200:2300);
      try{
        const result=await jsonp(endpoint,{op:'receiptStatus',token:payload.token,jobId:payload.jobId});
        if(result&&['SUCCESS','ERROR','UNCERTAIN'].includes(result.status))return result;
      }catch(err){
        if(/Сессия истекла|Доступ сотрудника закрыт/.test(err.message))throw err;
      }
    }
    return {status:'UNCERTAIN',message:'Подтверждение приёмки не получено; ID сохранён для сверки'};
  }

  return { jsonp, sendAssembly, sendReceipt };
})();