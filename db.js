/* StockFlow TSD IndexedDB — v2.0.3.
 * IMPORTANT: Keep JS keywords and store names in English. Do not translate this file.
 * DB name and version remain unchanged to preserve unfinished assemblies.
 */
'use strict';
window.DB = (() => {
  const DB_NAME = 'stockflow-tsd-v1';
  const DB_VERSION = 1;
  const STORES = ['meta', 'catalog', 'queue', 'draft'];
  let connectionPromise = null;

  function open() {
    if (connectionPromise) return connectionPromise;
    connectionPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('Браузер ТСД не поддерживает IndexedDB'));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const name of STORES) {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name, { keyPath: 'id' });
          }
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          connectionPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error || new Error('Ошибка открытия IndexedDB'));
      request.onblocked = () => reject(new Error('База данных занята другой вкладкой. Закройте лишние вкладки ТСД.'));
    }).catch(err => {
      // Allow the operator to retry after a temporary IndexedDB failure.
      connectionPromise = null;
      throw err;
    });
    return connectionPromise;
  }

  function transaction(db, storeNames, mode, operation) {
    return new Promise((resolve, reject) => {
      let tx;
      let result;
      try {
        tx = db.transaction(storeNames, mode);
        result = operation(tx);
      } catch (error) {
        if (tx) { try { tx.abort(); } catch (_) {} }
        reject(error);
        return;
      }
      // Resolve only once the transaction has actually committed.
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error('Ошибка записи IndexedDB'));
      tx.onabort = () => reject(tx.error || new Error('Транзакция IndexedDB отменена'));
    });
  }

  async function put(store, id, value) {
    const db = await open();
    return transaction(db, store, 'readwrite', tx => {
      tx.objectStore(store).put({ id, value });
    });
  }

  async function del(store, id) {
    const db = await open();
    return transaction(db, store, 'readwrite', tx => {
      tx.objectStore(store).delete(id);
    });
  }

  async function get(store, id) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const request = tx.objectStore(store).get(id);
      request.onsuccess = () => resolve(request.result ? request.result.value : undefined);
      request.onerror = () => reject(request.error || new Error('Не удалось прочитать запись'));
    });
  }

  async function all(store) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const request = tx.objectStore(store).getAll();
      request.onsuccess = () => resolve(request.result.map(row => row.value));
      request.onerror = () => reject(request.error || new Error('Не удалось прочитать список'));
    });
  }

  async function replaceCatalog(data) {
    const db = await open();
    return transaction(db, 'catalog', 'readwrite', tx => {
      const store = tx.objectStore('catalog');
      store.clear();
      store.put({ id: 'snapshot', value: data });
    });
  }

  // One IndexedDB transaction: either both actions succeed, or neither does.
  async function commitAssembly(job) {
    if (!job || !job.jobId) throw new Error('У сборки отсутствует jobId');
    const db = await open();
    return transaction(db, ['queue', 'draft'], 'readwrite', tx => {
      tx.objectStore('queue').put({ id: job.jobId, value: job });
      tx.objectStore('draft').delete('current');
    });
  }

  /** Confirmed TSD receiving is committed in a single local transaction.
   * The scan draft disappears only after the durable queue record is written. */
  async function commitReceipt(job) {
    if(!job || !job.jobId || job.kind!=='RECEIPT')throw Error('Некорректная приёмка');
    const db=await open();
    return transaction(db,['queue','draft'],'readwrite',tx=>{
      tx.objectStore('queue').put({id:job.jobId,value:job});
      tx.objectStore('draft').delete('receipt');
    });
  }

  /**
   * Cancel ONLY the active, unsubmitted draft. Verify identity within one IDB
   * transaction to avoid deleting another draft after a stale confirmation.
   * Queued and submitted jobs remain completely untouched.
   */
  async function cancelDraft(expected) {
    if (!expected || !expected.createdAt || !expected.lkId || !expected.warehouseId)
      throw new Error('Не удалось определить отменяемую сборку');
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('draft', 'readwrite');
      const store = tx.objectStore('draft');
      let failure = null;
      const read = store.get('current');
      read.onsuccess = () => {
        const actual = read.result && read.result.value;
        if (!actual || actual.createdAt !== expected.createdAt ||
            actual.lkId !== expected.lkId || actual.warehouseId !== expected.warehouseId) {
          failure = new Error('Текущая сборка была изменена на другом экране. Обновите приложение и проверьте черновик.');
          tx.abort();
          return;
        }
        store.delete('current');
      };
      read.onerror = () => { failure = read.error || new Error('Не удалось прочитать черновик'); tx.abort(); };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(failure || tx.error || new Error('Ошибка IndexedDB'));
      tx.onabort = () => reject(failure || tx.error || new Error('Не удалось отменить сборку'));
    });
  }

  /** Atomically archive the rejected job and enqueue a corrected replacement.
   * Never delete original error history; never touch the active assembly draft.
   */
  async function resolveConflict(originalId, replacement, removed) {
    const db=await open();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction('queue','readwrite');
      const store=tx.objectStore('queue');
      const read=store.get(originalId);
      read.onsuccess=()=>{
        try {
          const original=read.result && read.result.value;
          if(!original || original.status!=='ERROR')
            throw Error('Исходная сборка не найдена или ещё не получила ошибку сервера');
          if(replacement && (!replacement.jobId || replacement.jobId===originalId))
            throw Error('Для оставшихся товаров требуется новый ID сборки');
          const archive=Object.assign({},original,{
            status:'RESOLVED',resolvedAt:new Date().toISOString(),
            removedConflicts:removed,
            replacementJobId:replacement?replacement.jobId:'',
            message:replacement
              ?'Конфликт ЧЗ разрешён сотрудником; оставшиеся позиции отправлены отдельным заданием'
              :'Все конфликтные товары физически исключены; отправлять нечего'
          });
          store.put({id:originalId,value:archive});
          if(replacement)store.put({id:replacement.jobId,value:replacement});
        }catch(err){try{tx.abort()}catch(_){};reject(err)}
      };
      read.onerror=()=>reject(read.error||Error('Не удалось найти исходную сборку'));
      tx.oncomplete=()=>resolve();
      tx.onerror=()=>reject(tx.error||Error('Ошибка сохранения разрешённого конфликта'));
      tx.onabort=()=>reject(tx.error||Error('Сохранение конфликта отменено'));
    });
  }

  return { open, get, all, put, del, replaceCatalog, commitAssembly, commitReceipt, cancelDraft, resolveConflict };
})();
