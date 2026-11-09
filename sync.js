/* StockFlow TSD safe background queue synchronization v5.3.0.
 * Important: Does not upgrade, clear or rename IndexedDB. An in-flight job
 * is never POSTed again automatically until the server confirms its result.
 */
'use strict';
window.TSDSync = (() => {
  const BATCH_SIZE = 5;
  const BETWEEN_BATCHES_MS = 1500;
  const RETRY_MS = 15000;
  const STATUS_RECHECK_MS = 60000;
  const LOCK_NAME = 'tsdfbs-assembly-sync-v1';
  const LEASE_KEY = 'tsdfbs_assembly_sync_lease_v1';
  const OWNER = (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random();
  let timer = null, active = false, wakeRequested = false;

  const assembly = job => job && job.kind !== 'RECEIPT';
  const nowISO = () => new Date().toISOString();
  const online = () => Boolean(T.endpoint && T.session && navigator.onLine);
  const isHome = () => !document.getElementById('homeView').classList.contains('hidden');

  function showStatus(text) {
    // Never move focus, display modal progress or re-render the scanner.
    const node = document.getElementById('autoSyncStatus');
    if (node) node.textContent = text;
  }

  function schedule(delay = 0) {
    if (!online()) return;
    if (active) { wakeRequested = true; return; }
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, Math.max(0, delay));
  }

  async function exclusive(task) {
    // Web Locks synchronizes tabs of the SAME PWA origin on modern Chromium.
    if (navigator.locks && typeof navigator.locks.request === 'function') {
      return navigator.locks.request(LOCK_NAME, {mode: 'exclusive', ifAvailable: true},
        lock => lock ? task() : false);
    }
    // Conservative fallback for browsers without Web Locks.
    // The backend still must enforce idempotency by jobId across devices.
    let existing = null;
    try { existing = JSON.parse(localStorage.getItem(LEASE_KEY) || 'null'); } catch (_) {}
    if (existing && existing.owner !== OWNER && existing.until > Date.now()) return false;
    try {
      localStorage.setItem(LEASE_KEY, JSON.stringify({owner: OWNER, until: Date.now() + 1200000}));
      const written = JSON.parse(localStorage.getItem(LEASE_KEY) || '{}');
      if (written.owner !== OWNER) return false;
    } catch (_) {
      // Cannot establish a cross-tab lock: fail closed, do not send.
      throw Error('Не удалось защитить очередь от одновременной отправки из разных вкладок');
    }
    const renew = setInterval(() => {
      try {
        const saved = JSON.parse(localStorage.getItem(LEASE_KEY) || '{}');
        if (saved.owner === OWNER)
          localStorage.setItem(LEASE_KEY, JSON.stringify({owner: OWNER, until: Date.now() + 1200000}));
      } catch (_) {}
    }, 30000);
    try { return await task(); }
    finally {
      clearInterval(renew);
      try {
        const saved = JSON.parse(localStorage.getItem(LEASE_KEY) || '{}');
        if (saved.owner === OWNER) localStorage.removeItem(LEASE_KEY);
      } catch (_) {}
    }
  }

  function applyOutcome(job, result) {
    if (result && result.status === 'SUCCESS') {
      return {...job, status: 'SUCCESS',
        confirmedAt: nowISO(), serverMessage: result.message || '',
        message: result.message || 'Сервер подтвердил списание'};
    }
    if (result && result.status === 'ERROR') {
      const patch = {...job, status: 'ERROR',
        message: result.message || 'Сервер отклонил сборку', confirmedAt: nowISO()};
      if (result.errorCode === 'CHZ_DUPLICATES' && result.safeToResubmit && Array.isArray(result.conflicts)) {
        patch.errorCode = 'CHZ_DUPLICATES';
        patch.conflicts = result.conflicts;
        patch.totalConflicts = result.totalConflicts;
        patch.safeToResubmit = true;
        patch.message = 'Обнаружено повторных кодов ЧЗ: ' + patch.totalConflicts + '. Откройте поиск дублей.';
      } else {
        patch.errorCode = '';
        patch.conflicts = [];
        patch.safeToResubmit = false;
      }
      return patch;
    }
    return {...job, status: 'UNCERTAIN',
      lastStatusCheckAt: nowISO(),
      message: result?.message || 'Результат неизвестен: повторная отправка заблокирована до сверки'};
  }

  async function processOne(job) {
    // Read the current persisted record; never use an outdated snapshot.
    const current = await DB.get('queue', job.jobId);
    if (!current || !assembly(current) || ['SUCCESS', 'RESOLVED', 'ERROR'].includes(current.status))
      return;

    if (current.status === 'SENDING' || current.status === 'UNCERTAIN') {
      // SENDING left from a previous app instance may already have written stock.
      // Check the server ONLY; never submit the payload a second time.
      let result;
      try {
        result = await API.jsonp(T.endpoint, {op: 'jobStatus', token: T.session, jobId: current.jobId});
      } catch (err) {
        result = {status: 'UNCERTAIN', message: 'Сверка серверного статуса не удалась: ' + err.message};
      }
      const updated = applyOutcome(current, result);
      updated.lastStatusCheckAt = nowISO();
      await DB.put('queue', current.jobId, updated);
      return;
    }

    if (current.status !== 'QUEUED') return;
    // Durable state transition BEFORE network I/O ensures crash recovery does
    // not blindly repeat POST for a job that might have reached Apps Script.
    const sending = {...current, status: 'SENDING', lastAttemptAt: nowISO(),
      message: 'Отправлено в фоне; проверяется подтверждение сервера'};
    await DB.put('queue', sending.jobId, sending);

    let result;
    try {
      result = await API.sendAssembly(T.endpoint, {
        action: 'assembly', token: T.session, jobId: sending.jobId,
        lkId: sending.lkId, warehouseId: sending.warehouseId, items: sending.items
      });
    } catch (err) {
      result = {status: 'UNCERTAIN',
        message: 'Нет достоверного ответа сервера: ' + (err.message || String(err))};
    }
    await DB.put('queue', sending.jobId, applyOutcome(sending, result));
  }

  async function cycle() {
    const all = (await DB.all('queue')).filter(assembly);
    const queued = all.filter(j => j.status === 'QUEUED')
      .sort((a,b) => String(a.createdAt||'').localeCompare(String(b.createdAt||'')));
    const recover = all.filter(j => (j.status === 'SENDING' || j.status === 'UNCERTAIN') &&
      (!j.lastStatusCheckAt || Date.now() - Date.parse(j.lastStatusCheckAt) >= STATUS_RECHECK_MS))
      .sort((a,b) => String(a.lastStatusCheckAt||'').localeCompare(String(b.lastStatusCheckAt||'')));

    // One reconciliation check plus at most four new uploads per wave,
    // or five new uploads when there are no uncertain jobs.
    const selected = [...recover.slice(0,1), ...queued].slice(0, BATCH_SIZE);
    if (!selected.length) {
      if (all.some(j => j.status === 'SENDING' || j.status === 'UNCERTAIN'))
        return STATUS_RECHECK_MS;
      return null;
    }

    T.sending = true;
    try {
      let done = 0;
      for (const job of selected) {
        if (!online()) break;
        showStatus('Фоновая отправка: ' + (done + 1) + ' из ' + selected.length +
          ' в пакете · новые сборки можно продолжать');
        await processOne(job);
        done++;
        // Yield between jobs to keep UI / scanner event handlers responsive.
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    } finally {
      T.sending = false;
      T.queue = await DB.all('queue');
      if (isHome()) renderQueue();
    }

    const left = T.queue.filter(assembly);
    const pending = left.filter(j => j.status === 'QUEUED').length;
    const unknown = left.filter(j => ['SENDING', 'UNCERTAIN'].includes(j.status)).length;
    const errors = left.filter(j => j.status === 'ERROR').length;
    const success = left.filter(j => j.status === 'SUCCESS').length;
    showStatus('Автоотправка по 5 · ожидают ' + pending + ' · подтверждено ' + success +
      ' · ошибок ' + errors + ' · на сверке ' + unknown);
    if (pending) return BETWEEN_BATCHES_MS;
    if (unknown) return STATUS_RECHECK_MS;
    return null;
  }

  async function run() {
    if (active || !online()) return;
    active = true;
    let delay = null;
    try {
      const result = await exclusive(cycle);
      delay = result === false ? RETRY_MS : result;
    } catch (err) {
      console.error('Background sync:', err);
      showStatus('Автоотправка приостановлена: ' + (err.message || String(err)));
      delay = RETRY_MS;
    } finally {
      active = false;
      const requested = wakeRequested;
      wakeRequested = false;
      if (online() && (requested || delay !== null))
        schedule(requested ? 0 : delay);
    }
  }

  window.addEventListener('offline', () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    showStatus('Офлайн: сборки сохранены на этом устройстве');
  });

  return {wake: schedule};
})();
