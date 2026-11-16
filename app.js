/* AnimeVault PWA — надёжный трекер аниме */
'use strict';

const DB_NAME = 'AnimeTrackerDB';
const DB_VERSION = 7;
const STATUSES = ['Смотрю', 'В планах', 'Просмотрено', 'Отложено', 'Брошено'];
const STATUS_ALIASES = {
  'просмотренно': 'Просмотрено', 'просмотрено': 'Просмотрено',
  'watching': 'Смотрю', 'planned': 'В планах', 'completed': 'Просмотрено',
  'watched': 'Просмотрено', 'on-hold': 'Отложено', 'dropped': 'Брошено'
};
const db = new Dexie(DB_NAME);
db.version(6).stores({
  anime: '++id, titleRu, titleOrig, favorite, status, currentEpisode, [titleRu+titleOrig]'
}).upgrade(async tx => {
  await tx.table('anime').toCollection().modify(item => {
    item.favorite = item.favorite ? 1 : 0;
    item.currentEpisode = Math.max(0, Number(item.currentEpisode) || 0);
    item.status = normalizeStatus(item.status);
  });
});
db.version(7).stores({
  anime: '++id, titleRu, titleOrig, favorite, status, currentEpisode, [titleRu+titleOrig], recordUuid, syncUpdatedAt',
  sync_meta: '&key'
});

let applyingCloudData = false;
db.anime.hook('creating', (_key, obj) => {
  if (applyingCloudData) return;
  obj.recordUuid = obj.recordUuid || crypto.randomUUID();
  obj.syncUpdatedAt = new Date().toISOString();
});
db.anime.hook('updating', (mods, _key, obj) => {
  if (applyingCloudData) return mods;
  const nextTime=Math.max(Date.now(),Date.parse(obj?.syncUpdatedAt||0)+1);
  return {...mods, syncUpdatedAt: new Date(nextTime).toISOString()};
});
db.anime.hook('deleting', (key, obj, tx) => {
  if (applyingCloudData || obj?._remoteDelete || !obj?.recordUuid) return;
  return tx.table('sync_meta').put({key:`tombstone:${obj.recordUuid}`, value:{recordUuid:obj.recordUuid, deletedAt:new Date().toISOString()}});
});

let currentTab = 'all';
let filterStatus = 'Все';
let filterGenre = 'Все', filterFormat = 'Все', filterYear = 'Все', filterProgress = 'Все';
let viewMode = localStorage.getItem('animevault-view') || 'cards';
let enrichmentRunning = false, enrichmentCancel = false;
let deferredInstallPrompt = null;
let searchQuery = '';
let currentItems = [];
let busy = false;
let renderedCount = 0;
const PAGE_SIZE = 48;
let searchDebounceTimer = null;
let firstLibraryLoad = true;
let loadMoreObserver = null;
let pageRenderPending = false;

const $ = id => document.getElementById(id);
const els = {
  list: $('anime-list'), empty: $('empty-state'), tabAll: $('tab-all'), tabFav: $('tab-fav'), tabStats: $('tab-stats'), statsPage: $('stats-page'),
  search: $('search-input'), filter: $('filter-status'), csv: $('csv-file'), export: $('btn-export'),
  modal: $('anime-modal'), form: $('anime-form'), add: $('btn-add-modal'),
  close: $('btn-close-modal'), close2: $('btn-close-modal-2'), status: $('form-status'),
  episodesWrap: $('form-episodes-container'), episodes: $('form-episodes'),
  poster: $('form-poster'), posterPreview: $('poster-preview'), posterSearch: $('btn-search-poster'),
  titleRu: $('form-title-ru'), titleOrig: $('form-title-orig'), titleAlt: $('form-title-alt'),
  link: $('form-link'), favorite: $('form-favorite'), editId: $('edit-id'),
  modalTitle: $('modal-title'), importStatus: $('import-status'), toast: $('toast'), genre: $('filter-genre'), format: $('filter-format'), year: $('filter-year'), progress: $('filter-progress'), enrichProgress: $('enrich-progress')
};

function normalizeStatus(value) {
  const s = String(value || '').trim();
  return STATUS_ALIASES[s.toLowerCase()] || (STATUSES.includes(s) ? s : 'В планах');
}
function norm(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase('ru')
    .replace(/[ё]/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}
function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function safeURL(value, allowHttp = true) {
  try {
    const u = new URL(String(value || '').trim());
    return (allowHttp && (u.protocol === 'https:' || u.protocol === 'http:')) ? u.href : '';
  } catch { return ''; }
}
function showToast(message, type = 'info') {
  if (!els.toast) return;
  els.toast.textContent = message;
  els.toast.className = `toast toast-${type} show`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => els.toast.classList.remove('show'), 3500);
}
function setBusy(value) {
  busy = value;
  document.body.classList.toggle('is-busy', value);
}
function updateStatusField() {
  els.episodesWrap.classList.remove('is-disabled');
  els.episodes.disabled = false;
  const label=els.episodesWrap.querySelector('label'); if(label) label.textContent='Просмотрено серий';
}
function switchTab(tab) {
  currentTab = tab;
  els.tabAll.classList.toggle('active', tab === 'all');
  els.tabFav.classList.toggle('active', tab === 'favorite');
  els.tabAll.setAttribute('aria-pressed', String(tab === 'all'));
  els.tabFav.setAttribute('aria-pressed', String(tab === 'favorite'));
  loadAnimeData();
}
async function loadAnimeData() {
  const loading = $('library-loading');
  if (firstLibraryLoad && loading) loading.classList.remove('hidden');
  try {
    let items = await db.anime.toArray();
    if (currentTab === 'favorite') items = items.filter(x => Number(x.favorite) === 1);
    items = items.filter(item => {
      const statusOK = filterStatus === 'Все' || normalizeStatus(item.status) === filterStatus;
      const query = norm(searchQuery);
      const haystack = norm([item.titleRu, item.titleOrig, item.titleAlt, item.description, ...(item.genres||[])].join(' '));
      const genreOK = filterGenre === 'Все' || (item.genres||[]).includes(filterGenre);
      const formatOK = filterFormat === 'Все' || item.format === filterFormat;
      const yearOK = filterYear === 'Все' || String(item.year||'') === filterYear;
      const progressOK = filterProgress === 'Все' || (filterProgress === 'С постером' ? !!item.posterUrl : filterProgress === 'Без постера' ? !item.posterUrl : filterProgress === 'С метаданными' ? !!item.anilistId : !item.anilistId);
      return statusOK && genreOK && formatOK && yearOK && progressOK && (!query || haystack.includes(query));
    });
    items.sort((a,b) => (b.id || 0) - (a.id || 0));
    currentItems = items;
    renderList(items);
    if (currentTab === 'update' || currentTab === 'stats' || currentTab === 'cloud') { els.list.classList.add('hidden'); els.empty.classList.add('hidden'); }
    refreshFilterOptions(await db.anime.toArray());
    $('library-count').textContent = `${items.length} ${plural(items.length, ['аниме','аниме','аниме'])}`;
    $('total-count').textContent = `${(await db.anime.count()).toLocaleString('ru-RU')} в библиотеке`;
    firstLibraryLoad = false;
    if (loading) loading.classList.add('hidden');
  } catch (err) {
    firstLibraryLoad = false;
    if (loading) loading.classList.add('hidden');
    console.error(err);
    showToast('Не удалось загрузить библиотеку. Проверьте IndexedDB.', 'error');
  }
}
function plural(n, forms) { return forms[0]; }

const statusStyles = {
  'Смотрю':'status-watching', 'В планах':'status-planned',
  'Просмотрено':'status-completed', 'Отложено':'status-paused', 'Брошено':'status-dropped'
};
function renderList(items, append = false) {
  if (!append) {
    els.list.replaceChildren();
    renderedCount = 0;
  }
  els.list.classList.toggle('view-list', viewMode === 'list');
  els.empty.classList.toggle('hidden', items.length !== 0);

  const fragment = document.createDocumentFragment();
  const nextItems = items.slice(renderedCount, renderedCount + PAGE_SIZE);
  for (const item of nextItems) fragment.appendChild(createAnimeCard(item));
  els.list.appendChild(fragment);
  renderedCount += nextItems.length;
  updateRenderProgress(items.length);
  observeLoadMore();
}

function createAnimeCard(item) {
  const card = document.createElement('article');
  card.className = `anime-card${viewMode === 'list' ? ' list-card' : ''}`;
  const poster = safeURL(item.posterCloudUrl) || safeURL(item.posterUrl) || safeURL(item.apiPosterUrl) || 'icon-512.png';
  const watch = safeURL(item.watchLink);
  const title = escapeHTML(item.titleRu || 'Без названия');
  const original = escapeHTML(item.titleOrig || '—');
  const alt = escapeHTML(item.titleAlt || '');
  const description = escapeHTML(item.description || '');
  const status = normalizeStatus(item.status);
  card.innerHTML = `
      <div class="poster-wrap">
        <img class="poster" src="${escapeHTML(poster)}" alt="Постер: ${title}" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='icon-512.png'">
        <div class="poster-shade"></div>
        <button class="favorite-btn ${item.favorite ? 'is-favorite' : ''}" data-action="favorite" aria-label="${item.favorite ? 'Убрать из избранного' : 'Добавить в избранное'}">${item.favorite ? '★' : '☆'}</button>
        <span class="status-badge ${statusStyles[status] || ''}">${escapeHTML(status)}</span>
      </div>
      <div class="card-content">
        <h2 class="anime-title" title="${title}">${title}</h2>
        <p class="anime-subtitle" title="${original}">${original}${alt ? ` <span>· ${alt}</span>` : ''}</p>
        ${description ? `<p class="description">${description}</p>` : ''}
        ${viewMode === 'list' ? `<div class="list-details">${[item.year, item.format, item.totalEpisodes ? `${item.totalEpisodes} серий` : '', item.episodeDuration ? `${item.episodeDuration} мин/серия` : ''].filter(Boolean).map(x => `<span>${escapeHTML(String(x))}</span>`).join('')}</div>` : ''}
        ${viewMode === 'list' && Array.isArray(item.genres) && item.genres.length ? `<div class="list-genres">${item.genres.slice(0,5).map(g => `<span>${escapeHTML(g)}</span>`).join('')}${item.genres.length > 5 ? `<span class="genre-more">+${item.genres.length-5}</span>` : ''}</div>` : ''}
        <div class="card-meta">
          <div class="episode-stepper"><button data-action="episode-down" aria-label="Уменьшить число серий">−</button><span>${Math.max(0, Number(item.currentEpisode)||0) || (status==='Просмотрено' ? Number(item.totalEpisodes)||0 : 0)} сер.</span><button data-action="episode-up" aria-label="Увеличить число серий">+</button></div>
          ${watch ? `<a class="watch-link" href="${escapeHTML(watch)}" target="_blank" rel="noopener noreferrer">Смотреть ↗</a>` : ''}
        </div>
      </div>
      <div class="card-actions">
        <button class="edit-btn" data-action="edit">Редактировать</button>
        <button class="delete-btn" data-action="delete" aria-label="Удалить">Удалить</button>
      </div>`;
  card.dataset.id = item.id;
  return card;
}

function updateRenderProgress(total) {
  const progress = $('render-progress');
  const button = $('btn-load-more');
  const sentinel = $('load-more-sentinel');
  if (progress) progress.textContent = total
    ? `Показано ${renderedCount.toLocaleString('ru-RU')} из ${total.toLocaleString('ru-RU')}`
    : '';
  const remaining = Math.max(0, total - renderedCount);
  if (button) {
    button.classList.toggle('hidden', remaining === 0);
    button.disabled = false;
    button.textContent = remaining
      ? `Показать ещё ${Math.min(PAGE_SIZE, remaining)} · осталось ${remaining}`
      : '';
  }
  if (sentinel) sentinel.classList.toggle('hidden', remaining === 0);
}

function loadNextPage() {
  if (pageRenderPending || renderedCount >= currentItems.length) return;
  pageRenderPending = true;
  const button = $('btn-load-more');
  if (button) {
    button.disabled = true;
    button.textContent = 'Загружаю…';
  }
  requestAnimationFrame(() => {
    renderList(currentItems, true);
    pageRenderPending = false;
  });
}

function observeLoadMore() {
  const sentinel = $('load-more-sentinel');
  if (!sentinel || !('IntersectionObserver' in window)) return;
  if (loadMoreObserver) loadMoreObserver.disconnect();
  loadMoreObserver = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) loadNextPage();
  }, { rootMargin: '700px 0px' });
  if (renderedCount < currentItems.length) loadMoreObserver.observe(sentinel);
}
async function changeEpisode(id, delta) {
  const item = await db.anime.get(Number(id));
  if (!item) return;
  await db.anime.update(Number(id), {currentEpisode: Math.max(0, (Number(item.currentEpisode)||0) + delta)});
  loadAnimeData();
}
async function toggleFavorite(id) {
  const item = await db.anime.get(Number(id));
  if (!item) return;
  await db.anime.update(Number(id), {favorite: item.favorite ? 0 : 1});
  loadAnimeData();
}
async function deleteAnime(id) {
  const item = await db.anime.get(Number(id));
  if (!item) return;
  if (confirm(`Удалить «${item.titleRu}» из библиотеки?`)) {
    await db.anime.delete(Number(id));
    showToast('Аниме удалено');
    loadAnimeData();
  }
}
function openModal(item = null) {
  els.form.reset();
  els.editId.value = item?.id ?? '';
  els.modalTitle.textContent = item ? 'Редактировать карточку' : 'Добавить новое аниме';
  els.titleRu.value = item?.titleRu || '';
  els.titleOrig.value = item?.titleOrig || '';
  els.titleAlt.value = item?.titleAlt || '';
  els.status.value = item ? normalizeStatus(item.status) : 'В планах';
  els.episodes.value = String(Math.max(0, Number(item?.currentEpisode)||0));
  els.link.value = item?.watchLink || '';
  els.poster.value = item?.posterUrl || '';
  els.favorite.checked = Number(item?.favorite) === 1;
  updatePosterPreview();
  updateStatusField();
  els.modal.classList.add('is-open');
  els.modal.setAttribute('aria-hidden', 'false');
  setTimeout(() => els.titleRu.focus(), 80);
}
function closeModal() {
  els.modal.classList.remove('is-open');
  els.modal.setAttribute('aria-hidden', 'true');
}
function updatePosterPreview() {
  const url = safeURL(els.poster.value);
  els.posterPreview.src = url || 'icon-512.png';
}
const ANILIST_ENDPOINT = 'https://graphql.anilist.co';
async function fetchAnimeMetadata(title) {
  const query = `query ($search: String) { Media(search: $search, type: ANIME) { id idMal title { romaji english native } description(asHtml: false) episodes duration format seasonYear averageScore genres coverImage { extraLarge large medium } } }`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);
  let response;
  try { response = await fetch(ANILIST_ENDPOINT, {method:'POST', headers:{'Content-Type':'application/json','Accept':'application/json'}, body:JSON.stringify({query,variables:{search:title.trim()}}), signal:controller.signal}); }
  finally { clearTimeout(timeoutId); }
  if (!response.ok) { const reset=Number(response.headers.get('X-RateLimit-Reset')||0); const wait=reset>0?Math.max(1000,reset*1000-Date.now()+1500):60000; const error=new Error(`AniList HTTP ${response.status}`); error.retryAfter=wait; throw error; }
  const json = await response.json();
  const m = json?.data?.Media;
  if (!m?.id) return null;
  const clean = value => String(value || '').replace(/<br\s*\/?\s*>/gi,' ').replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').replace(/&#039;/g,"'").replace(/&quot;/g,'"').trim();
  return {anilistId:m.id, malId:m.idMal || null, titleApi:m.title?.english || m.title?.romaji || m.title?.native || '', description:clean(m.description).slice(0,2500), totalEpisodes:m.episodes || null, episodeDuration:m.duration || null, format:m.format || '', year:m.seasonYear || null, score:m.averageScore || null, genres:Array.isArray(m.genres)?m.genres:[], apiPosterUrl:m.coverImage?.extraLarge || m.coverImage?.large || m.coverImage?.medium || ''};
}
async function fetchPosterUrl(title) {
  if (!title.trim()) return '';
  try { const m = await fetchAnimeMetadata(title); return m?.apiPosterUrl || ''; }
  catch (err) { console.warn('AniList lookup failed:', err); return ''; }
}
const ENRICH_LOG_KEY = 'animevault-enrichment-log-v1';
let enrichmentLog = [];
function loadEnrichmentLog() {
  try {
    const saved = JSON.parse(localStorage.getItem(ENRICH_LOG_KEY) || '[]');
    enrichmentLog = Array.isArray(saved) ? saved.slice(-400) : [];
  } catch { enrichmentLog = []; }
  renderEnrichmentLogs();
}
function addEnrichmentLog(message, type='info') {
  const entry = {time:new Date().toISOString(), message:String(message), type};
  enrichmentLog.push(entry);
  if (enrichmentLog.length > 400) enrichmentLog = enrichmentLog.slice(-400);
  try { localStorage.setItem(ENRICH_LOG_KEY, JSON.stringify(enrichmentLog)); } catch {}
  renderEnrichmentLogs();
}
function renderEnrichmentLogs() {
  const host = $('enrich-log-list');
  if (!host) return;
  if (!enrichmentLog.length) {
    host.innerHTML = '<div class="log-empty">Здесь появятся события обновления. Найденные данные и уже проверенные записи повторно обрабатываться не будут.</div>';
    return;
  }
  host.replaceChildren(...enrichmentLog.slice(-160).map(entry => {
    const row = document.createElement('div');
    row.className = `enrich-log-entry log-${entry.type || 'info'}`;
    const time = document.createElement('time');
    time.dateTime = entry.time;
    time.textContent = new Date(entry.time).toLocaleTimeString('ru-RU', {hour:'2-digit',minute:'2-digit',second:'2-digit'});
    const message = document.createElement('span');
    message.textContent = entry.message;
    row.append(time, message);
    return row;
  }));
  host.scrollTop = host.scrollHeight;
}
function setEnrichmentSummary(text) {
  const node = $('enrich-progress');
  if (node) node.textContent = text;
  const detail = $('enrich-progress-detail');
  if (detail) detail.textContent = text;
}
async function enrichOne(item) {
  const candidates=[item.titleOrig,item.titleRu,...String(item.titleAlt||'').split(/[,;|]/)].map(x=>String(x||'').trim()).filter((x,i,a)=>x&&a.indexOf(x)===i);
  if (!candidates.length) return 'no_title';
  try {
    let meta=null;
    for (const title of candidates) { meta=await fetchAnimeMetadata(title); if(meta) break; }
    if (!meta) {
      await db.anime.update(item.id, {metadataLookupAttemptedAt:new Date().toISOString(), metadataLookupStatus:'not_found'});
      return 'miss';
    }
    const patch = {...meta, metadataUpdatedAt:new Date().toISOString(), metadataLookupAttemptedAt:new Date().toISOString(), metadataLookupStatus:'found'};
    if (!item.posterUrl && meta.apiPosterUrl) patch.posterUrl = meta.apiPosterUrl;
    await db.anime.update(item.id, patch);
    return 'ok';
  } catch (err) {
    console.warn('Metadata lookup failed:', item.titleRu, err);
    if(err.retryAfter) await new Promise(r=>setTimeout(r,err.retryAfter));
    await db.anime.update(item.id, {metadataLookupStatus:'error', metadataLookupError:String(err?.message || err).slice(0,180)}).catch(()=>{});
    return 'error';
  }
}
async function enrichLibrary() {
  if (enrichmentRunning) return;
  if (!navigator.onLine) {
    addEnrichmentLog('Нет подключения к интернету. Подключитесь и запустите обновление снова.', 'error');
    showToast('Для обновления нужен интернет', 'error');
    return;
  }
  enrichmentRunning = true; enrichmentCancel = false;
  const all = await db.anime.toArray();
  // Found entries and completed lookups (including "not found") are never searched again.
  const queue = all.filter(x => !x.anilistId && !x.metadataLookupAttemptedAt && !x.metadataUpdatedAt &&
    [x.titleOrig, x.titleRu, x.titleAlt].some(v => String(v || '').trim()));
  let done=0, found=0, missed=0, errors=0;
  const button = $('btn-enrich-start');
  const stopButton = $('btn-stop-enrich');
  if (button) button.disabled = true;
  if (stopButton) stopButton.classList.remove('hidden');
  $('enrich-total').textContent = queue.length.toLocaleString('ru-RU');
  $('enrich-done').textContent = '0'; $('enrich-found').textContent = '0';
  $('enrich-missed').textContent = '0'; $('enrich-errors').textContent = '0';
  $('enrich-progress-bar').style.width = '0%';
  addEnrichmentLog(`Запуск. В библиотеке ${all.length}; новых записей для поиска ${queue.length}.`, 'info');
  if (!queue.length) {
    $('enrich-progress-bar').style.width = '100%';
    addEnrichmentLog('Новых записей для поиска нет. Уже найденные и проверенные записи пропущены.', 'success');
    setEnrichmentSummary('Всё уже проверено — новых запросов не требуется.');
  }
  try {
    for (let i=0; i<queue.length; i+=1) {
      if (enrichmentCancel) break;
      if (!navigator.onLine) {
        addEnrichmentLog('Соединение пропало. Очередь остановлена; необработанные записи останутся в ожидании.', 'error');
        break;
      }
      const item = queue[i];
      const result = await enrichOne(item);
      done += 1;
      if (result==='ok') { found += 1; addEnrichmentLog(`✓ Найдено: ${item.titleRu || item.titleOrig}`, 'success'); }
      else if (result==='miss') { missed += 1; addEnrichmentLog(`— Не найдено: ${item.titleRu || item.titleOrig}. Повторно искать не будем.`, 'muted'); }
      else if (result==='no_title') { missed += 1; addEnrichmentLog(`Пропуск записи без названия (ID ${item.id}).`, 'muted'); }
      else { errors += 1; const failed=await db.anime.get(item.id); addEnrichmentLog(`Ошибка: ${item.titleRu || item.titleOrig} — ${failed?.metadataLookupError || 'временная ошибка сети/API'}. Попытку можно повторить позже.`, 'error'); }
      $('enrich-done').textContent = done.toLocaleString('ru-RU');
      $('enrich-found').textContent = found.toLocaleString('ru-RU');
      $('enrich-missed').textContent = missed.toLocaleString('ru-RU');
      $('enrich-errors').textContent = errors.toLocaleString('ru-RU');
      $('enrich-progress-bar').style.width = `${queue.length ? done/queue.length*100 : 100}%`;
      setEnrichmentSummary(`Обработано ${done}/${queue.length} · найдено ${found} · без совпадения ${missed} · ошибок ${errors}`);
      if (done % 10 === 0 || done === queue.length) await loadAnimeData();
      // Sequential requests are intentionally used for mobile network stability and AniList rate limits.
      if (i+1 < queue.length && !enrichmentCancel) await new Promise(r=>setTimeout(r,2300));
    }
    await loadAnimeData();
    const status = enrichmentCancel ? `Остановлено: ${done} из ${queue.length}` : `Завершено: найдено ${found}, не найдено ${missed}, ошибок ${errors}`;
    addEnrichmentLog(status, enrichmentCancel ? 'muted' : 'success');
    showToast(enrichmentCancel ? `Остановлено: ${done} из ${queue.length}` : `Обновление завершено: найдено ${found}`, enrichmentCancel?'info':'success');
  } finally {
    enrichmentRunning=false;
    if (button) { button.disabled=false; button.textContent='Обновить только непроверенные'; }
    if (stopButton) stopButton.classList.add('hidden');
  }
}

function refreshFilterOptions(items) {
  const apiGenres = Array.isArray(window.animeVaultApiGenres) ? window.animeVaultApiGenres : [];
  const storedGenres = items.flatMap(x => Array.isArray(x.genres) ? x.genres : []);
  const genres=[...new Set([...apiGenres, ...storedGenres].filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ru'));
  const years=[...new Set(items.map(x=>x.year).filter(Boolean).map(String))].sort((a,b)=>Number(b)-Number(a));
  const fill=(select, values, first)=>{if(!select)return;const selected=select.value||'Все';select.innerHTML=`<option value="Все">${first}</option>`+values.map(v=>`<option value="${escapeHTML(v)}">${escapeHTML(v)}</option>`).join('');select.value=values.includes(selected)?selected:'Все';};
  fill(els.genre,genres,'Все жанры'); fill(els.year,years,'Все годы');
  renderActiveFilters();
}


async function loadAniListGenreCollection() {
  const cacheKey='animevault-anilist-genres-v1';
  try {
    const cached=JSON.parse(localStorage.getItem(cacheKey)||'null');
    if(cached && Array.isArray(cached.genres) && Date.now()-cached.savedAt < 30*24*60*60*1000) {
      window.animeVaultApiGenres=cached.genres;
      refreshFilterOptions(await db.anime.toArray());
      return;
    }
  } catch {}
  try {
    const query='query { GenreCollection }';
    const response=await fetch(ANILIST_ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({query})});
    if(!response.ok) throw new Error(`AniList HTTP ${response.status}`);
    const json=await response.json();
    const genres=Array.isArray(json?.data?.GenreCollection)?json.data.GenreCollection.filter(Boolean):[];
    if(genres.length) {
      window.animeVaultApiGenres=genres;
      localStorage.setItem(cacheKey,JSON.stringify({genres,savedAt:Date.now()}));
      refreshFilterOptions(await db.anime.toArray());
    }
  } catch(err) {
    console.warn('AniList GenreCollection unavailable; using genres saved with anime metadata.',err);
    window.animeVaultApiGenres=[];
  }
}

function activeFilterEntries() {
  return [
    ['status',filterStatus,'Статус'],
    ['genre',filterGenre,'Жанр'],
    ['format',filterFormat,'Формат'],
    ['year',filterYear,'Год'],
    ['progress',filterProgress,'Данные']
  ].filter(([,value])=>value && value!=='Все');
}
function renderActiveFilters() {
  const host=$('active-filters'); if(!host) return;
  const entries=activeFilterEntries();
  host.innerHTML=entries.map(([key,value,label])=>`<span class="filter-chip">${label}: ${escapeHTML(value)}<button type="button" data-clear-filter="${key}" aria-label="Убрать фильтр ${label}">×</button></span>`).join('');
  host.classList.toggle('hidden',entries.length===0);
  const count=$('filter-count'); count.textContent=String(entries.length); count.classList.toggle('hidden',entries.length===0);
}
function clearOneFilter(key) {
  const map={status:['filter-status',v=>filterStatus=v],genre:['filter-genre',v=>filterGenre=v],format:['filter-format',v=>filterFormat=v],year:['filter-year',v=>filterYear=v],progress:['filter-progress',v=>filterProgress=v]};
  if(!map[key]) return;
  const [id,setter]=map[key]; $(id).value='Все'; setter('Все'); loadAnimeData();
}
function clearAllFilters() {
  filterStatus=filterGenre=filterFormat=filterYear=filterProgress='Все';
  ['filter-status','filter-genre','filter-format','filter-year','filter-progress'].forEach(id=>$(id).value='Все');
  loadAnimeData();
}
function toggleFilterPanel(force) {
  const panel=$('filter-panel'), button=$('btn-filter-toggle');
  const open=typeof force==='boolean'?force:panel.classList.contains('hidden');
  panel.classList.toggle('hidden',!open); button.setAttribute('aria-expanded',String(open));
}

function setView(mode) {
  viewMode=mode; localStorage.setItem('animevault-view',mode);
  $('view-cards').classList.toggle('active',mode==='cards'); $('view-list').classList.toggle('active',mode==='list');
  renderList(currentItems);
}
function switchStats(tab) {
  const isStats=tab==='stats', isUpdate=tab==='update', isCloud=tab==='cloud';
  currentTab=(isStats || isUpdate)?tab:tab;
  els.statsPage.classList.toggle('hidden',!isStats);
  $('update-page').classList.toggle('hidden',!isUpdate);
  $('cloud-page').classList.toggle('hidden',!isCloud);
  els.list.classList.toggle('hidden',isStats || isUpdate || isCloud);
  els.empty.classList.toggle('hidden',isStats || isUpdate || isCloud || currentItems.length>0);
  $('load-more-wrap').classList.toggle('hidden',isStats || isUpdate || isCloud);
  $('tab-all').classList.toggle('active',tab==='all'); $('tab-fav').classList.toggle('active',tab==='favorite'); $('tab-stats').classList.toggle('active',isStats); $('tab-update').classList.toggle('active',isUpdate); $('tab-cloud').classList.toggle('active',isCloud);
  $('tab-all').setAttribute('aria-pressed',String(tab==='all')); $('tab-fav').setAttribute('aria-pressed',String(tab==='favorite')); $('tab-stats').setAttribute('aria-pressed',String(isStats)); $('tab-update').setAttribute('aria-pressed',String(isUpdate)); $('tab-cloud').setAttribute('aria-pressed',String(isCloud));
  $('mobile-library')?.classList.toggle('active',tab==='all');
  $('mobile-fav')?.classList.toggle('active',tab==='favorite');
  $('mobile-stats')?.classList.toggle('active',isStats);
  $('mobile-update')?.classList.toggle('active',isUpdate); $('mobile-cloud')?.classList.toggle('active',isCloud);
  document.querySelector('.toolbar').classList.toggle('hidden',isStats || isUpdate || isCloud);
  const libraryStats=document.getElementById('library-stats');
  if(libraryStats) libraryStats.classList.toggle('hidden',isStats || isUpdate || isCloud);
  if(isStats) renderStatistics(); else if(!isUpdate && !isCloud) loadAnimeData();
}

function renderStatistics() {
  db.anime.toArray().then(items=>{
    const counts=Object.fromEntries(STATUSES.map(s=>[s,items.filter(x=>normalizeStatus(x.status)===s).length]));
    const watched=items.reduce((sum,x)=>sum+(normalizeStatus(x.status)==='Просмотрено'?Math.max(0,Number(x.totalEpisodes)||Number(x.currentEpisode)||0):Math.max(0,Number(x.currentEpisode)||0)),0);
    const watchedMinutes=items.reduce((sum,x)=>sum+(normalizeStatus(x.status)==='Просмотрено'?Math.max(0,Number(x.totalEpisodes)||Number(x.currentEpisode)||0):Math.max(0,Number(x.currentEpisode)||0))*Math.max(0,Number(x.episodeDuration)||0),0);
    const completedMinutes=items.filter(x=>normalizeStatus(x.status)==='Просмотрено').reduce((sum,x)=>sum+Math.max(0,Number(x.totalEpisodes)||Number(x.currentEpisode)||0)*Math.max(0,Number(x.episodeDuration)||0),0);
    const allMinutes=items.reduce((sum,x)=>sum+(normalizeStatus(x.status)==='Просмотрено'?Math.max(0,Number(x.totalEpisodes)||Number(x.currentEpisode)||0):Math.max(0,Number(x.currentEpisode)||0))*Math.max(0,Number(x.episodeDuration)||0),0);
    const hours=n=>`${(n/60).toFixed(1)} ч`;
    $('stats-kpis').innerHTML=[['Всего в библиотеке',items.length],['Просмотрено серий',watched],['Время просмотренного',hours(watchedMinutes)],['Полное время завершённых',hours(completedMinutes)]].map(([a,b])=>`<div class="kpi"><small>${a}</small><strong>${b}</strong></div>`).join('');
    const colors=['#ef4444','#3b82f6','#10b981','#f59e0b','#71717a'];
    const total=items.length||1; let cursor=0; const stops=STATUSES.map((s,i)=>{const start=cursor;cursor+=counts[s]/total*100;return `${colors[i]} ${start}% ${cursor}%`;}).join(',');
    $('status-chart').innerHTML=`<div class="donut-wrap"><div class="donut" style="background:conic-gradient(${stops})"></div><div class="legend">${STATUSES.map((s,i)=>`<span style="--c:${colors[i]}">${escapeHTML(s)} — ${counts[s]}</span>`).join('')}</div></div>`;
    const watchByStatus=STATUSES.map(status=>{const group=items.filter(x=>normalizeStatus(x.status)===status);const episodes=group.reduce((sum,x)=>sum+(status==='Просмотрено'?Math.max(0,Number(x.totalEpisodes)||Number(x.currentEpisode)||0):Math.max(0,Number(x.currentEpisode)||0)),0);const minutes=group.reduce((sum,x)=>sum+(status==='Просмотрено'?Math.max(0,Number(x.totalEpisodes)||Number(x.currentEpisode)||0):Math.max(0,Number(x.currentEpisode)||0))*Math.max(0,Number(x.episodeDuration)||0),0);return {status,episodes,minutes};});
    const maxStatusEpisodes=Math.max(1,...watchByStatus.map(x=>x.episodes));
    $('watch-chart').innerHTML=`${watchByStatus.map(x=>`<div class="bar-row"><span>${escapeHTML(x.status)}</span><div class="bar-track"><div class="bar-fill" style="width:${x.episodes/maxStatusEpisodes*100}%"></div></div><b>${x.episodes} сер.</b></div><div style="margin:-6px 0 9px 109px;color:#92929c;font-size:11px">${hours(x.minutes)}</div>`).join('')}<p style="color:#92929c;font-size:12px">Серии и часы показаны отдельно по каждому статусу. Для завершённых учитывается полное число серий из API, для остальных — отмеченный прогресс.</p>`;
    const formats={}; for(const x of items) if(x.format) formats[x.format]=(formats[x.format]||0)+1;
    $('format-chart').innerHTML=Object.keys(formats).length?Object.entries(formats).map(([name,n])=>`<div class="bar-row"><span>${escapeHTML(name)}</span><div class="bar-track"><div class="bar-fill" style="width:${n/Math.max(1,...Object.values(formats))*100}%"></div></div><b>${n}</b></div>`).join(''):'<p style="color:#92929c">Пока нет данных. Запустите массовое обновление через AniList.</p>';
    const withMeta=items.filter(x=>x.anilistId).length, withPoster=items.filter(x=>x.posterUrl).length;
    $('metadata-chart').innerHTML=`<div class="bar-row"><span>Метаданные API</span><div class="bar-track"><div class="bar-fill" style="width:${withMeta/total*100}%"></div></div><b>${withMeta}</b></div><div class="bar-row"><span>Постеры</span><div class="bar-track"><div class="bar-fill" style="width:${withPoster/total*100}%"></div></div><b>${withPoster}</b></div><p style="color:#92929c;font-size:12px">Время считается приблизительно: длительность серии × число серий. Для незавершённых учитываются только отмеченные серии.</p>`;
  });
}
async function searchPoster() {
  const title = els.titleOrig.value.trim() || els.titleRu.value.trim();
  if (!title) { showToast('Сначала укажите название аниме', 'error'); return; }
  els.posterSearch.disabled = true;
  els.posterSearch.textContent = 'Ищем…';
  const url = await fetchPosterUrl(title);
  els.posterSearch.disabled = false;
  els.posterSearch.textContent = 'Найти через AniList';
  if (url) {
    els.poster.value = url;
    updatePosterPreview();
    showToast('Постер найден. Сохраните карточку.');
  } else showToast('Постер не найден. Можно вставить ссылку вручную.', 'error');
}
async function handleFormSubmit(event) {
  event.preventDefault();
  const titleRu = els.titleRu.value.trim();
  if (!titleRu) return;
  const id = Number(els.editId.value) || null;
  const existing = id ? await db.anime.get(id) : null;
  let posterValue = safeURL(els.poster.value);
  if (!posterValue && !existing) posterValue = await fetchPosterUrl(els.titleOrig.value.trim() || titleRu);
  const data = {
    titleRu,
    titleOrig: els.titleOrig.value.trim(),
    titleAlt: els.titleAlt.value.trim(),
    status: normalizeStatus(els.status.value),
    currentEpisode: Math.max(0, parseInt(els.episodes.value,10)||0),
    watchLink: safeURL(els.link.value),
    posterUrl: posterValue,
    favorite: els.favorite.checked ? 1 : 0
  };
  if (!data.posterUrl && existing?.posterUrl) data.posterUrl = existing.posterUrl;
  if (!data.watchLink && existing?.watchLink) data.watchLink = existing.watchLink;
  if (id) await db.anime.update(id, data);
  else await db.anime.add(data);
  closeModal();
  showToast(id ? 'Изменения сохранены' : 'Аниме добавлено');
  loadAnimeData();
}

/* CSV parser: supports quoted delimiters, escaped quotes, BOM and Anixart's
   multiline/occasionally malformed records. */
function detectDelimiter(line) {
  const candidates = [',',';','\\t'];
  let best = ',', bestCount = -1;
  for (const d of candidates) {
    let count = 0, quoted = false;
    for (let i=0;i<line.length;i++) {
      if (line[i] === '"') quoted = !quoted;
      else if (line[i] === d && !quoted) count++;
    }
    if (count > bestCount) { bestCount = count; best = d; }
  }
  return best;
}
function parseCSVRecord(line, delimiter) {
  const out=[]; let field='', quoted=false, started=false;
  for (let i=0;i<line.length;i++) {
    const ch=line[i];
    if (ch === '"') {
      if (quoted) {
        const next=line[i+1] || '', after=line[i+2] || '';
        if (next === '"' && (after === delimiter || after === '' || after === '\n' || after === '\r')) {
          field += '"'; quoted=false; i++;
        } else if (next === '"') { field += '"'; i++; }
        else if (next === delimiter || next === '' || next === '\n' || next === '\r') quoted=false;
        else field += '"';
      } else if (!started) quoted=true;
      else field += '"';
    } else if (ch === delimiter && !quoted) {
      out.push(field.trim()); field=''; started=false;
    } else { field += ch; started=true; }
  }
  out.push(field.trim());
  return out;
}
function parseCSV(text) {
  text = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const physical = text.split('\n');
  const first = physical.find(x => x.trim()) || '';
  const delimiter = detectDelimiter(first);
  const anixart = /русское название/i.test(first) && /^\s*#\s*[,;]/.test(first);
  let records=[];
  if (anixart) {
    let current='';
    for (const line of physical.slice(1)) {
      if (/^\s*\d+\s*[,;]/.test(line)) {
        if (current) records.push(current);
        current=line;
      } else if (current && line.trim()) current += '\n' + line;
    }
    if (current) records.push(current);
  } else {
    let current='', quoted=false;
    for (let i=0;i<text.length;i++) {
      const ch=text[i];
      current += ch;
      if (ch === '"') {
        if (quoted && text[i+1] === '"') { current += text[++i]; }
        else quoted=!quoted;
      }
      if (ch === '\n' && !quoted) { if (current.trim()) records.push(current.trimEnd()); current=''; }
    }
    if (current.trim()) records.push(current.trimEnd());
    if (records.length) records.shift();
  }
  const header = parseCSVRecord(first, delimiter).map(h => h.replace(/^"|"$/g,'').trim().toLocaleLowerCase('ru'));
  const find = (...parts) => header.findIndex(h => parts.some(p => h.includes(p)));
  const idx = {
    ru: find('русское название','название','title','name'),
    orig: find('оригинальное название','оригинал','original'),
    alt: find('альтернативные названия','альтернатив','синоним','alternative'),
    fav: find('добавлено в избранное','избранное','favorite'),
    status: find('статус просмотра','статус','status'),
    episode: find('текущая серия','серия','episode'),
    link: find('ссылка на просмотр','ссылка','watchlink','watch link'),
    poster: find('ссылка на постер','постер','poster'),
    anilistId: find('anilist id'), malId:find('mal id'), apiTitle:find('название api'), description: find('описание','description'), totalEpisodes: find('всего серий','total episodes'), duration: find('длительность серии','episode duration'), format: find('формат','format'), year: find('год','year'), score: find('оценка','score'), genres: find('жанры','genres'), apiPoster: find('постер api'), metadataUpdated: find('дата обновления api'), metadataAttempt:find('дата попытки поиска anilist'), metadataLookupStatus:find('статус поиска anilist')
  };
  if (idx.ru < 0) throw new Error('Не найден столбец с русским названием.');
  const result=[];
  for (const record of records) {
    let row=parseCSVRecord(record, delimiter);
    // In Anixart exports a few malformed quoted alternate-title cells split into
    // extra comma-separated pieces. The final two columns remain favorite/status.
    if (anixart && row.length > header.length && header.length >= 6) {
      const altIndex = idx.alt >= 0 ? idx.alt : 3;
      const tailCount = header.length - altIndex - 1;
      row = row.slice(0,altIndex).concat([row.slice(altIndex,row.length-tailCount).join(', ')], row.slice(-tailCount));
    }
    if (row.length < header.length) row = row.concat(Array(header.length-row.length).fill(''));
    const get = key => idx[key] >= 0 ? String(row[idx[key]] ?? '').trim() : '';
    const ru=get('ru');
    if (!ru) continue;
    let titleAlt = get('alt');
    // Recover two known broken quote boundaries in the supplied Anixart export.
    if (ru === 'Время пыток, принцесса!') titleAlt = titleAlt.replace('"Interrogation, Princess!', '"Interrogation", Princess!').replace(/desu\"$/, 'desu');
    if (ru === 'Девочка, которая видит это') titleAlt = titleAlt.replace('"Them, Girl That', '"Them", Girl That').replace(/It\"$/, 'It');
    result.push({
      titleRu:ru, titleOrig:get('orig'), titleAlt,
      favorite: idx.fav >= 0 ? (/^(1|true|yes|да|добавлено|избранное)$/i.test(get('fav'))) : null,
      status: idx.status >= 0 ? normalizeStatus(get('status')) : null,
      currentEpisode: idx.episode >= 0 ? Math.max(0,parseInt(get('episode'),10)||0) : null,
      watchLink: idx.link >= 0 ? safeURL(get('link')) : '',
      posterUrl: idx.poster >= 0 ? safeURL(get('poster')) : '',
      anilistId: get('anilistId') ? Number(get('anilistId')) : null, malId:get('malId')?Number(get('malId')):null, titleApi:get('apiTitle'), description:get('description'), totalEpisodes:idx.totalEpisodes>=0?(parseInt(get('totalEpisodes'),10)||null):null, episodeDuration:idx.duration>=0?(parseInt(get('duration'),10)||null):null, format:get('format'), year:idx.year>=0?(parseInt(get('year'),10)||null):null, score:idx.score>=0?(parseInt(get('score'),10)||null):null, genres:get('genres')?get('genres').split(/[,|]/).map(x=>x.trim()).filter(Boolean):[], apiPosterUrl:idx.apiPoster>=0?safeURL(get('apiPoster')):'', metadataUpdatedAt:get('metadataUpdated'), metadataLookupAttemptedAt:get('metadataAttempt'), metadataLookupStatus:get('metadataLookupStatus')
    });
  }
  return result;
}
function duplicateKey(item) {
  const ru=norm(item.titleRu), orig=norm(item.titleOrig);
  return ru ? `${ru}|${orig}` : `|${orig}`;
}
async function importAnime(items) {
  let added=0, updated=0, skipped=0;
  await db.transaction('rw', db.anime, async () => {
    const all=await db.anime.toArray();
    const byRu=new Map(), byOrig=new Map(), exact=new Map();
    for (const item of all) {
      const ru=norm(item.titleRu), orig=norm(item.titleOrig);
      if (ru && !byRu.has(ru)) byRu.set(ru,item);
      if (orig && !byOrig.has(orig)) byOrig.set(orig,item);
      exact.set(duplicateKey(item),item);
    }
    for (const incoming of items) {
      const key=duplicateKey(incoming);
      let old=exact.get(key) || (norm(incoming.titleRu) ? byRu.get(norm(incoming.titleRu)) : null);
      if (!old && norm(incoming.titleOrig)) old=byOrig.get(norm(incoming.titleOrig));
      if (old) {
        const patch = {
          titleRu: incoming.titleRu || old.titleRu,
          titleOrig: incoming.titleOrig || old.titleOrig,
          titleAlt: incoming.titleAlt || old.titleAlt || '',
          status: incoming.status || old.status,
          favorite: incoming.favorite === null ? old.favorite : (incoming.favorite ? 1 : 0),
          currentEpisode: incoming.currentEpisode === null ? (old.currentEpisode || 0) : incoming.currentEpisode,
          // Empty import values must never erase manually added poster/link.
          posterUrl: incoming.posterUrl || old.posterUrl || '',
          watchLink: incoming.watchLink || old.watchLink || '',
          anilistId: incoming.anilistId || old.anilistId || null, malId:incoming.malId || old.malId || null, titleApi:incoming.titleApi || old.titleApi || '', description: incoming.description || old.description || '',
          totalEpisodes: incoming.totalEpisodes || old.totalEpisodes || null, episodeDuration: incoming.episodeDuration || old.episodeDuration || null,
          format: incoming.format || old.format || '', year: incoming.year || old.year || null, score: incoming.score || old.score || null, genres: incoming.genres || old.genres || [], apiPosterUrl:incoming.apiPosterUrl || old.apiPosterUrl || '', metadataUpdatedAt:incoming.metadataUpdatedAt || old.metadataUpdatedAt || '', metadataLookupAttemptedAt:incoming.metadataLookupAttemptedAt || old.metadataLookupAttemptedAt || '', metadataLookupStatus:incoming.metadataLookupStatus || old.metadataLookupStatus || ''
        };
        await db.anime.update(old.id,patch);
        const merged={...old,...patch};
        exact.set(duplicateKey(merged),merged);
        byRu.set(norm(merged.titleRu),merged);
        if (norm(merged.titleOrig)) byOrig.set(norm(merged.titleOrig),merged);
        updated++;
      } else {
        const item = {
          titleRu:incoming.titleRu, titleOrig:incoming.titleOrig, titleAlt:incoming.titleAlt,
          status:incoming.status || 'В планах', favorite:incoming.favorite ? 1 : 0,
          currentEpisode:incoming.currentEpisode || 0, posterUrl:incoming.posterUrl || '',
          watchLink:incoming.watchLink || '', anilistId:incoming.anilistId || null, malId:incoming.malId || null, titleApi:incoming.titleApi || '', description:incoming.description || '', totalEpisodes:incoming.totalEpisodes || null, episodeDuration:incoming.episodeDuration || null, format:incoming.format || '', year:incoming.year || null, score:incoming.score || null, genres:incoming.genres || [], apiPosterUrl:incoming.apiPosterUrl || '', metadataUpdatedAt:incoming.metadataUpdatedAt || '', metadataLookupAttemptedAt:incoming.metadataLookupAttemptedAt || '', metadataLookupStatus:incoming.metadataLookupStatus || ''
        };
        const id=await db.anime.add(item);
        item.id=id; exact.set(duplicateKey(item),item); byRu.set(norm(item.titleRu),item);
        if (norm(item.titleOrig)) byOrig.set(norm(item.titleOrig),item);
        added++;
      }
    }
  });
  return {added,updated,skipped};
}
async function handleCSVImport(event) {
  const file=event.target.files?.[0];
  if (!file) return;
  setBusy(true);
  try {
    const text=await file.text();
    const items=parseCSV(text);
    if (!items.length) throw new Error('В файле не найдено записей с названиями.');
    const preview=`Найдено записей: ${items.length}.\nНовые записи будут добавлены, совпадающие — обновлены.\nПустые поля постера и ссылки не затронут уже сохранённые значения.\n\nПродолжить импорт?`;
    if (!confirm(preview)) return;
    const result=await importAnime(items);
    showToast(`Импорт завершён: добавлено ${result.added}, обновлено ${result.updated}.`, 'success');
    if (els.importStatus) els.importStatus.textContent=`Импортировано: ${result.added} новых, ${result.updated} обновлено`;
    await loadAnimeData();
  } catch(err) {
    console.error(err); showToast(`Ошибка импорта: ${err.message}`, 'error');
  } finally {
    setBusy(false); event.target.value='';
  }
}
function csvEscape(value) {
  const s=String(value ?? '');
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
}
async function handleCSVExport() {
  const items=await db.anime.toArray();
  if (!items.length) { showToast('Библиотека пуста', 'error'); return; }
  const headers=['Русское название','Оригинальное название','Альтернативные названия','Добавлено в избранное','Статус просмотра','Текущая серия','Ссылка на просмотр','Ссылка на постер','AniList ID','MAL ID','Название API','Описание','Всего серий','Длительность серии (мин)','Формат','Год','Оценка','Жанры','Постер API','Дата обновления API','Дата попытки поиска AniList','Статус поиска AniList'];
  const rows=[headers.join(';')];
  for (const x of items) rows.push([
    x.titleRu,x.titleOrig,x.titleAlt,Number(x.favorite)===1?'Добавлено':'Не добавлено',
    normalizeStatus(x.status),x.currentEpisode||0,x.watchLink,x.posterUrl,x.anilistId||'',x.malId||'',x.titleApi||'',x.description||'',x.totalEpisodes||'',x.episodeDuration||'',x.format||'',x.year||'',x.score||'',(x.genres||[]).join(', '),x.apiPosterUrl||'',x.metadataUpdatedAt||'',x.metadataLookupAttemptedAt||'',x.metadataLookupStatus||''
  ].map(csvEscape).join(';'));
  const blob=new Blob(['\uFEFF'+rows.join('\r\n')],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url;
  a.download=`AnimeVault_${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  showToast(`Экспортировано записей: ${items.length}`, 'success');
}
async function backupDatabase() {
  const items=await db.anime.toArray();
  const blob=new Blob([JSON.stringify({version:1,exportedAt:new Date().toISOString(),anime:items},null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob), a=document.createElement('a');
  a.href=url; a.download=`AnimeVault_backup_${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}


async function importBundledLibraryIfNeeded() {
  const marker = 'animevault-bundled-library-v1';
  try {
    if (localStorage.getItem(marker) === 'done') return;
    const count = await db.anime.count();
    if (count > 0) { localStorage.setItem(marker, 'done'); return; }
    const response = await fetch('./AnimeVault_Import_1042.csv', {cache:'no-store'});
    if (!response.ok) return;
    const items = parseCSV(await response.text());
    if (!items.length) return;
    const result = await importAnime(items);
    localStorage.setItem(marker, 'done');
    showToast(`Стартовая библиотека загружена: ${result.added} аниме`, 'success');
  } catch (err) {
    console.warn('Bundled library import skipped:', err);
  }
}

function setupInstallPrompt() {
  const btn=$('btn-install');
  const standalone=window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone===true;
  if(standalone) return;
  btn.classList.remove('hidden');
  window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();deferredInstallPrompt=event;btn.classList.remove('hidden');});
  window.addEventListener('appinstalled',()=>{deferredInstallPrompt=null;btn.classList.add('hidden');showToast('AnimeVault установлен');});
  btn.addEventListener('click',async()=>{
    if(deferredInstallPrompt){deferredInstallPrompt.prompt();const choice=await deferredInstallPrompt.userChoice;deferredInstallPrompt=null;if(choice?.outcome==='accepted')btn.classList.add('hidden');}
    else showToast('Откройте меню браузера и выберите «Установить приложение» или «Добавить на главный экран». Для установки нужен HTTPS или localhost.');
  });
}

/* Supabase cloud sync — IndexedDB remains the offline-first local source. */
const SUPABASE_URL = 'https://ytmnsnvxjhpejidcndyw.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_qDspg8-HRV2VeewVPVKK8w_uZ8sJhpR';
const POSTER_BUCKET = 'animevault-posters';
const supabaseClient = window.supabase?.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});
let cloudUser = null, syncBusy = false, syncTimer = null;
const POSTER_LOG_KEY='animevault-poster-log-v1';
let posterLogEntries=[];
try { posterLogEntries=JSON.parse(localStorage.getItem(POSTER_LOG_KEY)||'[]'); if(!Array.isArray(posterLogEntries)) posterLogEntries=[]; } catch { posterLogEntries=[]; }
function renderPosterLog(){
  const list=$('poster-log-list'), summary=$('poster-log-summary'); if(!list||!summary) return;
  const failed=posterLogEntries.filter(x=>x.level==='error').length;
  summary.textContent=`Записей в журнале: ${posterLogEntries.length}. Ошибок: ${failed}. Журнал хранится на этом устройстве.`;
  list.innerHTML=posterLogEntries.slice().reverse().map(x=>{
    const wrap=document.createElement('div'); wrap.style.cssText='padding:9px;border:1px solid #303036;border-radius:8px;background:#141418';
    const head=document.createElement('div'); head.style.cssText='font-size:12px;font-weight:700;color:'+(x.level==='error'?'#ff7777':'#86d6a0'); head.textContent=`${x.level==='error'?'ОШИБКА':'ГОТОВО'} · ${x.title||'Без названия'} · ${x.time}`; wrap.append(head);
    const body=document.createElement('div'); body.style.cssText='font-size:11px;color:#c4c4cc;white-space:pre-wrap;overflow-wrap:anywhere;margin-top:5px'; body.textContent=[`Этап: ${x.stage||'—'}`,`Причина: ${x.reason||'—'}`,x.http?`HTTP: ${x.http}`:'',x.size?`Размер: ${x.size}`:'',x.url?`Источник: ${x.url}`:''].filter(Boolean).join('\n'); wrap.append(body); return wrap.outerHTML;
  }).join('');
}
function addPosterLog(entry){ posterLogEntries.push({...entry,time:new Date().toLocaleString('ru-RU')}); if(posterLogEntries.length>250) posterLogEntries=posterLogEntries.slice(-250); try{localStorage.setItem(POSTER_LOG_KEY,JSON.stringify(posterLogEntries));}catch{} renderPosterLog(); }
function posterFailureReason(error,stage){
  const msg=String(error?.message||error||'Неизвестная ошибка');
  if(stage==='Источник' && (error instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(msg))) return 'Браузер не смог прочитать изображение. Возможны CORS-ограничение источника, блокировка сети или недоступный сервер; точную причину браузер не раскрывает.';
  if(/row.level security|permission|unauthorized|not authorized|403/i.test(msg)) return 'Supabase Storage отклонил доступ. Проверьте bucket и Storage policies для папки пользователя.';
  if(/bucket.*not found|not found/i.test(msg)) return 'Bucket animevault-posters не найден. Выполните актуальный SUPABASE_SETUP.sql.';
  return msg;
}
function cloudStatus(message, type='info') {
  const el=$('cloud-status'); if(!el) return;
  el.textContent=message; el.dataset.type=type;
}
function cloudUserLabel(user) {
  const email=user?.email || user?.user_metadata?.email || 'Аккаунт подключён';
  $('cloud-user').textContent=email;
}
function setCloudSignedIn(user) {
  cloudUser=user || null;
  $('cloud-auth-form').classList.toggle('hidden',!!user);
  $('cloud-account').classList.toggle('hidden',!user);
  if(user) { cloudUserLabel(user); cloudStatus('Аккаунт подключён. Можно синхронизировать библиотеку.','success'); }
  else { $('cloud-user').textContent=''; cloudStatus('Войдите, чтобы включить синхронизацию.'); }
}
async function cloudSignIn(event) {
  event.preventDefault();
  if(!supabaseClient) return cloudStatus('Не загрузилась библиотека Supabase. Проверьте интернет и обновите страницу.','error');
  const email=$('cloud-email').value.trim(), password=$('cloud-password').value;
  const mode=$('cloud-auth-mode').value;
  $('cloud-submit').disabled=true;
  try {
    const result=mode==='signup'
      ? await supabaseClient.auth.signUp({email,password})
      : await supabaseClient.auth.signInWithPassword({email,password});
    if(result.error) throw result.error;
    if(mode==='signup' && !result.data.session) cloudStatus('Аккаунт создан. Подтвердите email по письму Supabase, затем войдите.','success');
    else { setCloudSignedIn(result.data.user); await syncCloudNow(); }
  } catch(err) { cloudStatus(err.message || 'Не удалось войти.','error'); }
  finally { $('cloud-submit').disabled=false; }
}
async function cloudGitHubSignIn() {
  if(!supabaseClient) return cloudStatus('Не загрузилась библиотека Supabase. Проверьте интернет и обновите страницу.','error');
  const button=$('cloud-github-login');
  button.disabled=true;
  try {
    const redirectTo=window.location.origin + window.location.pathname;
    const {error}=await supabaseClient.auth.signInWithOAuth({
      provider:'github',
      options:{redirectTo}
    });
    if(error) throw error;
  } catch(err) {
    cloudStatus(err.message || 'Не удалось начать вход через GitHub. Проверьте настройки GitHub Provider в Supabase.','error');
    button.disabled=false;
  }
}
async function cloudSignOut() {
  if(!supabaseClient) return;
  try { await supabaseClient.auth.signOut(); setCloudSignedIn(null); cloudStatus('Вы вышли. Локальная библиотека сохранена.','success'); }
  catch(err) { cloudStatus(err.message || 'Не удалось выйти.','error'); }
}
async function ensureLocalCloudIds() {
  const rows=await db.anime.toArray();
  for(const row of rows) {
    if(!row.recordUuid) await db.anime.update(row.id,{recordUuid:crypto.randomUUID(),syncUpdatedAt:new Date().toISOString()});
    else if(!row.syncUpdatedAt) await db.anime.update(row.id,{syncUpdatedAt:new Date().toISOString()});
  }
}
async function uploadPosterToCloud(item) {
  const sourceUrl=safeURL(item?.posterUrl || item?.apiPosterUrl);
  if (!(item?.posterUrl || item?.apiPosterUrl) || item.posterCloudUrl || !item.recordUuid) return {status:'skip'};
  let stage='Источник', response=null, blob=null;
  try {
    if(!sourceUrl) throw new Error('URL постера пустой или не прошёл проверку безопасности');
    response=await fetch(sourceUrl,{mode:'cors',credentials:'omit',cache:'force-cache'});
    if(!response.ok) throw Object.assign(new Error(`Сервер источника ответил HTTP ${response.status} ${response.statusText||''}`.trim()),{http:response.status});
    blob=await response.blob();
    const type=(blob.type||'').toLowerCase();
    if(!type.startsWith('image/')) throw new Error(`Ответ не является изображением (Content-Type: ${type||'не указан'})`);
    if(blob.size>10*1024*1024) throw new Error(`Файл ${ (blob.size/1024/1024).toFixed(2) } МБ превышает лимит 10 МБ`);
    const ext=type.includes('png')?'png':type.includes('webp')?'webp':type.includes('gif')?'gif':type.includes('avif')?'avif':'jpg';
    const path=`${cloudUser.id}/${item.recordUuid}.${ext}`;
    stage='Supabase Storage';
    const {error}=await supabaseClient.storage.from(POSTER_BUCKET).upload(path,blob,{contentType:type,cacheControl:'31536000',upsert:true});
    if(error) throw error;
    const {data}=supabaseClient.storage.from(POSTER_BUCKET).getPublicUrl(path);
    if(!data?.publicUrl) throw new Error('Supabase не вернул публичную ссылку на загруженный файл');
    stage='Сохранение ссылки';
    await db.anime.update(item.id,{posterStoragePath:path,posterCloudUrl:data.publicUrl});
    addPosterLog({level:'success',title:item.titleRu||item.titleOrig||item.id,stage:'Загрузка завершена',reason:'Постер скопирован в Supabase Storage',url:sourceUrl,size:`${(blob.size/1024).toFixed(1)} КБ`});
    return {status:'uploaded'};
  } catch(error) {
    const reason=posterFailureReason(error,stage);
    addPosterLog({level:'error',title:item.titleRu||item.titleOrig||item.id,stage,reason,http:error?.http||response?.status||null,size:blob?`${(blob.size/1024).toFixed(1)} КБ`:null,url:sourceUrl||String(item.posterUrl||item.apiPosterUrl||'')});
    console.warn('AnimeVault poster upload failed:',item.titleRu,stage,reason);
    return {status:'failed',stage,message:reason};
  }
}
async function uploadLibraryPosters(items) {
  const queue=items.filter(item=>(item.posterUrl || item.apiPosterUrl) && !item.posterCloudUrl && item.recordUuid);
  let uploaded=0,failed=0,done=0;
  if(!queue.length) { cloudStatus('Постеры: новых для загрузки нет. Облачные ссылки уже сохранены либо у записей отсутствует URL постера.'); return {uploaded,failed,total:0}; }
  addPosterLog({level:'success',title:'Начало проверки',stage:'Очередь',reason:`В очереди ${queue.length} постеров без облачной копии.`});
  for(let i=0;i<queue.length;i+=3) {
    const results=await Promise.all(queue.slice(i,i+3).map(uploadPosterToCloud));
    for(const result of results) { if(result.status==='uploaded') uploaded++; else if(result.status==='failed') failed++; }
    done+=results.length;
    cloudStatus(`Постеры: ${done}/${queue.length}. Успешно: ${uploaded}. Ошибки: ${failed}. Подробности — в журнале ниже.`);
  }
  addPosterLog({level:failed?'error':'success',title:'Итог загрузки',stage:'Завершение',reason:`Проверено: ${done}; загружено: ${uploaded}; ошибок: ${failed}; пропущено: ${items.length-queue.length}.`});
  return {uploaded,failed,total:queue.length};
}

async function syncCloudNow() {
  if(!supabaseClient || !cloudUser || syncBusy || !navigator.onLine) {
    if(!navigator.onLine) cloudStatus('Нет подключения к интернету. Локальная библиотека доступна.','error');
    return;
  }
  syncBusy=true; $('cloud-sync-now').disabled=true; cloudStatus('Синхронизация…');
  try {
    await ensureLocalCloudIds();
    let remoteRows=[];
    for(let offset=0;;offset+=1000) {
      const {data,error}=await supabaseClient.from('animevault_records').select('record_id,payload,updated_at,deleted').eq('owner_id',cloudUser.id).order('updated_at',{ascending:true}).range(offset,offset+999);
      if(error) throw error;
      remoteRows.push(...(data||[]));
      if(!data || data.length<1000) break;
    }
    const remote=new Map((remoteRows||[]).map(row=>[row.record_id,row]));
    const local=await db.anime.toArray();
    const tombstones=await db.sync_meta.toArray();
    const pendingDeletes=tombstones.filter(x=>x.key.startsWith('tombstone:'));
    const staleDeletes=pendingDeletes.filter(x=>Date.parse(remote.get(x.value.recordUuid)?.updated_at||0)>Date.parse(x.value.deletedAt||0));
    if(staleDeletes.length) await db.sync_meta.bulkDelete(staleDeletes.map(x=>x.key));
    const effectiveDeletes=pendingDeletes.filter(x=>!staleDeletes.includes(x));
    const deleteRows=effectiveDeletes.map(x=>({owner_id:cloudUser.id,record_id:x.value.recordUuid,payload:{},updated_at:x.value.deletedAt,deleted:true}));
    if(deleteRows.length) {
      const {error}=await supabaseClient.from('animevault_records').upsert(deleteRows,{onConflict:'owner_id,record_id'});
      if(error) throw error;
      await db.sync_meta.bulkDelete(effectiveDeletes.map(x=>x.key));
      for(const tombstone of effectiveDeletes) {
        const prior=remote.get(tombstone.value.recordUuid);
        const deletedRow={record_id:tombstone.value.recordUuid,payload:{},updated_at:tombstone.value.deletedAt,deleted:true};
        remote.set(tombstone.value.recordUuid,deletedRow);
        const idx=remoteRows.findIndex(row=>row.record_id===tombstone.value.recordUuid);
        if(idx>=0) remoteRows[idx]=deletedRow;
      }
    }
    let pulled=0, pushed=0;
    for(const row of remoteRows||[]) {
      const item=local.find(x=>x.recordUuid===row.record_id);
      if(!item) {
        if(!row.deleted && row.payload && typeof row.payload==='object') {
          applyingCloudData=true;
          try { const copy={...row.payload}; delete copy.id; copy.recordUuid=row.record_id; copy.syncUpdatedAt=row.updated_at; await db.anime.add(copy); pulled++; }
          finally { applyingCloudData=false; }
        }
        continue;
      }
      const localTime=Date.parse(item.syncUpdatedAt||0), remoteTime=Date.parse(row.updated_at||0);
      if(remoteTime>localTime) {
        applyingCloudData=true;
        try {
          if(row.deleted) { item._remoteDelete=true; await db.anime.delete(item.id); }
          else if(row.payload && typeof row.payload==='object') { const copy={...row.payload}; delete copy.id; copy.recordUuid=row.record_id; copy.syncUpdatedAt=row.updated_at; await db.anime.update(item.id,copy); }
          pulled++;
        } finally { applyingCloudData=false; }
      }
    }
    cloudStatus('Записи синхронизированы. Проверяем постеры и загружаем их в облако…');
    const posterResult=await uploadLibraryPosters(await db.anime.toArray());
    const refresh=await db.anime.toArray();
    const upserts=[];
    for(const item of refresh) {
      const cloud=remote.get(item.recordUuid);
      const localTime=Date.parse(item.syncUpdatedAt||0), remoteTime=Date.parse(cloud?.updated_at||0);
      if(!cloud || localTime>remoteTime) {
        const payload={...item}; delete payload.id;
        upserts.push({owner_id:cloudUser.id,record_id:item.recordUuid,payload,updated_at:item.syncUpdatedAt||new Date().toISOString(),deleted:false});
      }
    }
    for(let i=0;i<upserts.length;i+=100) {
      const {error}=await supabaseClient.from('animevault_records').upsert(upserts.slice(i,i+100),{onConflict:'owner_id,record_id'});
      if(error) throw error; pushed+=Math.min(100,upserts.length-i);
    }
    cloudStatus(`Синхронизация записей завершена: получено ${pulled}, отправлено ${pushed}. Постеры: проверено ${posterResult.total}, загружено ${posterResult.uploaded}, ошибок ${posterResult.failed}. Подробные причины ошибок см. в журнале постеров.`,'success');
    $('cloud-last-sync').textContent=`Последняя синхронизация: ${new Date().toLocaleString('ru-RU')}`;
    await loadAnimeData();
  } catch(err) {
    console.error('AnimeVault cloud sync:',err);
    const msg=err?.message || 'Неизвестная ошибка';
    cloudStatus(msg.includes('animevault_records') || msg.includes('relation') ? 'Таблица Supabase ещё не настроена. Выполните SQL из файла SUPABASE_SETUP.sql.' : `Ошибка синхронизации: ${msg}`,'error');
  } finally { syncBusy=false; $('cloud-sync-now').disabled=false; }
}
async function initCloudAuth() {
  if(!supabaseClient) { cloudStatus('Не удалось загрузить Supabase SDK.','error'); return; }
  $('cloud-auth-form').addEventListener('submit',cloudSignIn);
  $('cloud-github-login').addEventListener('click',cloudGitHubSignIn);
  $('cloud-auth-mode').addEventListener('change',e=>{$('cloud-submit').textContent=e.target.value==='signup'?'Создать аккаунт':'Войти';});
  $('cloud-signout').addEventListener('click',cloudSignOut);
  $('cloud-sync-now').addEventListener('click',syncCloudNow);
  $('poster-log-copy')?.addEventListener('click',async()=>{const txt=posterLogEntries.map(x=>`${x.time} | ${x.level} | ${x.title} | этап: ${x.stage} | причина: ${x.reason} | HTTP: ${x.http||'-'} | URL: ${x.url||'-'}`).join('\n');try{await navigator.clipboard.writeText(txt);cloudStatus('Журнал постеров скопирован.','success');}catch{cloudStatus('Не удалось скопировать журнал: браузер запретил доступ к буферу обмена.','error');}});
  $('poster-log-clear')?.addEventListener('click',()=>{posterLogEntries=[];try{localStorage.removeItem(POSTER_LOG_KEY);}catch{}renderPosterLog();cloudStatus('Журнал постеров очищен.');});
  renderPosterLog();
  const {data:{session}}=await supabaseClient.auth.getSession();
  setCloudSignedIn(session?.user || null);
  supabaseClient.auth.onAuthStateChange((_event,nextSession)=>{
    setCloudSignedIn(nextSession?.user || null);
    if(nextSession?.user) setTimeout(()=>syncCloudNow(),0);
  });
  if(session?.user) await syncCloudNow();
  window.addEventListener('online',()=>{if(cloudUser) syncCloudNow();});
  window.addEventListener('focus',()=>{if(cloudUser) syncCloudNow();});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden && cloudUser) syncCloudNow();});
  syncTimer=setInterval(()=>{if(cloudUser && !document.hidden) syncCloudNow();},60000);
}

function bindEvents() {
  els.tabAll.addEventListener('click',()=>switchStats('all'));
  els.tabFav.addEventListener('click',()=>switchStats('favorite'));
  els.tabStats.addEventListener('click',()=>switchStats('stats'));
  $('view-cards').addEventListener('click',()=>setView('cards')); $('view-list').addEventListener('click',()=>setView('list'));
  $('btn-filter-toggle').addEventListener('click',()=>toggleFilterPanel());
  $('btn-clear-filters').addEventListener('click',clearAllFilters);
  $('active-filters').addEventListener('click',e=>{const btn=e.target.closest('[data-clear-filter]');if(btn)clearOneFilter(btn.dataset.clearFilter);});
  $('mobile-library').addEventListener('click',()=>switchStats('all'));
  $('mobile-fav').addEventListener('click',()=>switchStats('favorite'));
  $('mobile-stats').addEventListener('click',()=>switchStats('stats'));
  $('mobile-add').addEventListener('click',()=>openModal());
  document.addEventListener('click',e=>{const menu=document.querySelector('.manage-menu');if(menu && !menu.contains(e.target))menu.open=false;});
  els.genre.addEventListener('change',e=>{filterGenre=e.target.value;loadAnimeData();}); els.format.addEventListener('change',e=>{filterFormat=e.target.value;loadAnimeData();}); els.year.addEventListener('change',e=>{filterYear=e.target.value;loadAnimeData();}); els.progress.addEventListener('change',e=>{filterProgress=e.target.value;loadAnimeData();});
  $('tab-update').addEventListener('click',()=>switchStats('update'));
  $('tab-cloud').addEventListener('click',()=>switchStats('cloud'));
  $('mobile-cloud').addEventListener('click',()=>switchStats('cloud'));
  $('menu-cloud').addEventListener('click',()=>{document.querySelector('.manage-menu').open=false;switchStats('cloud');});
  $('menu-update').addEventListener('click',()=>{document.querySelector('.manage-menu').open=false;switchStats('update');});
  $('mobile-update').addEventListener('click',()=>switchStats('update'));
  $('btn-enrich-start').addEventListener('click',enrichLibrary);
  $('btn-stop-enrich').addEventListener('click',()=>{enrichmentCancel=true;setEnrichmentSummary('Остановка после текущего запроса…');addEnrichmentLog('Запрошена остановка. Дождёмся завершения текущего запроса.','muted');});
  $('btn-clear-enrich-log').addEventListener('click',()=>{enrichmentLog=[];try{localStorage.removeItem(ENRICH_LOG_KEY);}catch{}renderEnrichmentLogs();addEnrichmentLog('Журнал очищен.','info');});
  window.addEventListener('online',()=>addEnrichmentLog('Соединение восстановлено. Можно продолжить обновление.','success'));
  window.addEventListener('offline',()=>addEnrichmentLog('Устройство перешло в офлайн. Текущая очередь остановится после запроса.','error'));
  els.search.addEventListener('input',e=>{searchQuery=e.target.value;clearTimeout(searchDebounceTimer);searchDebounceTimer=setTimeout(()=>loadAnimeData(),180);});
  $('btn-load-more').addEventListener('click',loadNextPage);
  els.filter.addEventListener('change',e=>{filterStatus=e.target.value;loadAnimeData();});
  els.csv.addEventListener('change',handleCSVImport);
  els.export.addEventListener('click',handleCSVExport);
  $('btn-backup').addEventListener('click',backupDatabase);
  els.add.addEventListener('click',()=>openModal());
  els.close.addEventListener('click',closeModal);
  els.close2.addEventListener('click',closeModal);
  els.modal.addEventListener('click',e=>{if(e.target===els.modal)closeModal();});
  document.addEventListener('keydown',e=>{if(e.key==='Escape')closeModal();});
  els.form.addEventListener('submit',handleFormSubmit);
  els.status.addEventListener('change',updateStatusField);
  els.poster.addEventListener('input',updatePosterPreview);
  els.posterSearch.addEventListener('click',searchPoster);
  els.list.addEventListener('click',async e=>{
    const btn=e.target.closest('[data-action]');
    if(!btn) return;
    const card=btn.closest('.anime-card'), id=Number(card?.dataset.id);
    if(!id) return;
    const action=btn.dataset.action;
    if(action==='favorite') await toggleFavorite(id);
    if(action==='episode-up') await changeEpisode(id,1);
    if(action==='episode-down') await changeEpisode(id,-1);
    if(action==='edit') openModal(await db.anime.get(id));
    if(action==='delete') await deleteAnime(id);
  });
}
async function init() {
  bindEvents();
  loadEnrichmentLog();
  setupInstallPrompt();
  updateStatusField();
  try {
    await db.open();
    await importBundledLibraryIfNeeded();
    await loadAnimeData();
    await initCloudAuth();
    loadAniListGenreCollection();
  } catch(err) {
    console.error(err); showToast('Не удалось открыть локальную базу данных', 'error');
    cloudStatus('Локальная база не открылась: '+(err.message||err),'error');
  }
  if (viewMode==='list') setView('list');
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch(err=>console.warn('Service Worker:',err));
  }
  $('app-version').textContent='v1.3.5 · Detailed Poster Log';
}
document.addEventListener('DOMContentLoaded',init);
