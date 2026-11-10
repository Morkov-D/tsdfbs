/* StockFlow TSD device login recovery v5.4.0.
 * Does not store bearer tokens, passwords or PINs. Saves only a previously
 * verified employee ID on this device and obtains a fresh token from GAS.
 * Requires the current GAS login-by-ID endpoint; use device-bound refresh
 * tokens and PIN verification when the backend supports them.
 */
'use strict';
window.TSDSession = (() => {
  const FLAG = 'stockflow_auto_login';
  const ENDPOINT_KEY = 'stockflow_login_endpoint';
  const RETRY_MS = 30000;
  const REFRESH_MS = 15 * 60 * 1000;
  let lastAuthAt = 0, lastFailureAt = 0, pending = null, retryTimer = null, generation = 0;

  function rememberedId() {
    if (localStorage.getItem(FLAG) === '0') return '';
    const savedEndpoint = localStorage.getItem(ENDPOINT_KEY);
    if (savedEndpoint && savedEndpoint !== T.endpoint) return '';
    return (localStorage.getItem('stockflow_employee') || '').trim();
  }
  function remember(id, enabled) {
    localStorage.setItem('stockflow_employee', String(id));
    localStorage.setItem(FLAG, enabled ? '1' : '0');
    if (enabled) localStorage.setItem(ENDPOINT_KEY, T.endpoint);
  }
  function isSessionError(error) {
    return /Сессия истекла|Сессия недействительна|токен.*истек|invalid.*token|unauthoriz|session.*expired|Доступ сотрудника закрыт/i.test(String(error?.message || error || ''));
  }
  function isDenied(error) {
    return /Сотрудник не найден|Доступ сотрудника закрыт|доступ запрещен|access denied|employee.*disabled/i.test(String(error?.message || error || ''));
  }
  function status(text) {
    const node = document.getElementById('autoSyncStatus');
    if (node) node.textContent = text;
  }
  function markServer(ok) {
    T.apiHealth = ok ? 'ok' : 'error';
    showConnection();
  }
  function scheduleRetry() {
    if (retryTimer !== null || !navigator.onLine) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!document.hidden && T.endpoint && (T.employee || rememberedId()))
        void ensure(false);
    }, RETRY_MS);
  }
  async function ensure(force = false) {
    if (!T.endpoint || !navigator.onLine) return false;
    if (pending) return pending;
    if (T.session && !force && Date.now() - lastAuthAt < REFRESH_MS) return true;
    if (!force && !T.session && Date.now() - lastFailureAt < RETRY_MS) return false;
    const id = String(T.employee?.id ?? rememberedId()).trim();
    if (!id) return false;
    const currentGeneration = generation;
    pending = (async () => {
      const result = await API.jsonp(T.endpoint, {op: 'login', employeeId: id});
      if (currentGeneration !== generation) return false; // Logout / endpoint switch during request.
      if (!result?.token || !result?.employee || String(result.employee.id) !== id)
        throw Error('Сервер вернул некорректную сессию сотрудника');
      T.session = result.token;
      T.employee = result.employee;
      lastAuthAt = Date.now();
      lastFailureAt = 0;
      await DB.put('meta', 'lastEmployee', T.employee);
      if (currentGeneration !== generation) return false;
      markServer(true);
      if (!T.catalog.products?.length || !T.catalog.lks?.length || !T.catalog.warehouses?.length) {
        try { await syncCatalog(true); }
        catch (err) { status('Авторизация восстановлена, но справочники не обновились: ' + err.message); }
      }
      if (!document.getElementById('loginView').classList.contains('hidden')) {
        afterLogin();
      } else if (document.getElementById('userName')) {
        document.getElementById('userName').textContent = T.employee.name + ' · ' + T.employee.id;
      }
      window.TSDSync?.wake(0);
      return true;
    })().catch(error => {
      if (currentGeneration !== generation) return false;
      lastFailureAt = Date.now();
      if (isDenied(error)) {
        T.session = null;
        T.employee = null;
        localStorage.setItem(FLAG, '0');
        markServer(false);
        view('loginView');
        status('Доступ сотрудника отклонён сервером. Очередь в IndexedDB сохранена.');
        message('Доступ сотрудника закрыт. Обратитесь к руководителю; очередь не удалена.', 'bad');
      } else {
        // A temporary network/GAS failure must never erase offline drafts or jobs.
        if (!T.session || isSessionError(error)) T.session = null;
        markServer(false);
        status('Нет связи с API: ' + (error.message || String(error)) + '. Очередь сохранена, повторим автоматически.');
        scheduleRetry();
      }
      return false;
    }).finally(() => { pending = null; });
    return pending;
  }

  async function restore() {
    const id = rememberedId();
    if (!T.endpoint || !id) return false;
    const cached = await DB.get('meta', 'lastEmployee');
    if (cached && String(cached.id) === id &&
        T.catalog.products?.length && T.catalog.lks?.length && T.catalog.warehouses?.length) {
      T.employee = cached;
      T.session = null;
      afterLogin(); // Allow offline scans without waiting for the network.
      status(navigator.onLine ? 'Восстанавливаем авторизацию сервера…' :
        'Офлайн: сборки сохранены на ТСД и уйдут после появления связи');
    }
    if (navigator.onLine) void ensure(true);
    return true;
  }
  function recordManualLogin(id, keepSignedIn) {
    generation++;
    remember(id, keepSignedIn);
    lastAuthAt = Date.now();
    lastFailureAt = 0;
    markServer(true);
  }
  function logout() {
    generation++;
    T.session = null;
    T.employee = null;
    localStorage.setItem(FLAG, '0');
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    T.apiHealth = 'unknown';
    showConnection();
  }
  function endpointChanged() {
    generation++;
    T.session = null;
    T.employee = null;
    T.apiHealth = 'unknown';
    localStorage.setItem(FLAG, '0');
    showConnection();
  }
  function wake() {
    if (!T.endpoint || !navigator.onLine) return;
    void ensure(false).then(ok => { if (ok) window.TSDSync?.wake(0); });
  }
  window.addEventListener('online', wake);
  window.addEventListener('focus', wake);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
  setInterval(() => { if (!document.hidden && T.employee && navigator.onLine) wake(); }, 60000);
  return {ensure, restore, recordManualLogin, logout, endpointChanged, wake, isSessionError};
})();
