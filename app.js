/* AnimeVault PWA — надёжный трекер аниме */
'use strict';

const DB_NAME = 'AnimeTrackerDB';
const DB_VERSION = 6;
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

let currentTab = 'all';
let filterStatus = 'Все';
let filterGenre = 'Все', filterFormat = 'Все', filterYear = 'Все', filterProgress = 'Все';
let viewMode = localStorage.getItem('animevault-view') || 'cards';
let enrichmentRunning = false, enrichmentCancel = false;
let deferredInstallPrompt = null;
let searchQuery = '';
let currentItems = [];
let busy = false;

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
    refreshFilterOptions(await db.anime.toArray());
    $('library-count').textContent = `${items.length} ${plural(items.length, ['аниме','аниме','аниме'])}`;
    $('total-count').textContent = `${(await db.anime.count()).toLocaleString('ru-RU')} в библиотеке`;
  } catch (err) {
    console.error(err);
    showToast('Не удалось загрузить библиотеку. Проверьте IndexedDB.', 'error');
  }
}
function plural(n, forms) { return forms[0]; }

const statusStyles = {
  'Смотрю':'status-watching', 'В планах':'status-planned',
  'Просмотрено':'status-completed', 'Отложено':'status-paused', 'Брошено':'status-dropped'
};
function renderList(items) {
  els.list.replaceChildren();
  els.list.classList.toggle('view-list', viewMode === 'list');
  els.empty.classList.toggle('hidden', items.length !== 0);
  for (const item of items) {
    const card = document.createElement('article');
    card.className = `anime-card${viewMode === 'list' ? ' list-card' : ''}`;
    const poster = safeURL(item.posterUrl) || 'icon-512.png';
    const watch = safeURL(item.watchLink);
    const title = escapeHTML(item.titleRu || 'Без названия');
    const original = escapeHTML(item.titleOrig || '—');
    const alt = escapeHTML(item.titleAlt || '');
    const description = escapeHTML(item.description || '');
    const status = normalizeStatus(item.status);
    card.innerHTML = `
      <div class="poster-wrap">
        <img class="poster" src="${escapeHTML(poster)}" alt="Постер: ${title}" loading="lazy" onerror="this.onerror=null;this.src='icon-512.png'">
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
          ${`<div class="episode-stepper"><button data-action="episode-down" aria-label="Уменьшить число серий">−</button><span>${Math.max(0, Number(item.currentEpisode)||0) || (status==='Просмотрено' ? Number(item.totalEpisodes)||0 : 0)} сер.</span><button data-action="episode-up" aria-label="Увеличить число серий">+</button></div>`}
          ${watch ? `<a class="watch-link" href="${escapeHTML(watch)}" target="_blank" rel="noopener noreferrer">Смотреть ↗</a>` : ''}
        </div>
      </div>
      <div class="card-actions">
        <button class="edit-btn" data-action="edit">Редактировать</button>
        <button class="delete-btn" data-action="delete" aria-label="Удалить">Удалить</button>
      </div>`;
    card.dataset.id = item.id;
    els.list.appendChild(card);
  }
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
  const response = await fetch(ANILIST_ENDPOINT, {method:'POST', headers:{'Content-Type':'application/json','Accept':'application/json'}, body:JSON.stringify({query,variables:{search:title.trim()}})});
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
async function enrichOne(item) {
  const candidates=[item.titleOrig,item.titleRu,...String(item.titleAlt||'').split(/[,;|]/)].map(x=>String(x||'').trim()).filter((x,i,a)=>x&&a.indexOf(x)===i);
  if (!candidates.length) return 'miss';
  try {
    let meta=null;
    for (const title of candidates) { meta=await fetchAnimeMetadata(title); if(meta) break; }
    if (!meta) return 'miss';
    const patch = {...meta, metadataUpdatedAt:new Date().toISOString()};
    // Do not replace a manually supplied poster. API cover is a fallback only.
    if (!item.posterUrl && meta.apiPosterUrl) patch.posterUrl = meta.apiPosterUrl;
    await db.anime.update(item.id, patch);
    return 'ok';
  } catch (err) { console.warn('Metadata lookup failed:', item.titleRu, err); if(err.retryAfter) await new Promise(r=>setTimeout(r,err.retryAfter)); return 'error'; }
}
async function enrichLibrary(onlyMissing=false) {
  if (enrichmentRunning) return;
  enrichmentRunning = true; enrichmentCancel = false;
  const all = await db.anime.toArray();
  const queue = all.filter(x => !onlyMissing || !x.anilistId);
  let done=0, found=0, missed=0, errors=0;
  const button = $('btn-enrich-all');
  if (button) button.disabled = true;
  $('btn-stop-enrich').classList.remove('hidden');
  const missingButton = $('btn-enrich-missing'); if (missingButton) missingButton.disabled = true;
  try {
    for (let i=0; i<queue.length; i+=1) {
      if (enrichmentCancel) break;
      const batch=queue.slice(i,i+1);
      const results=await Promise.all(batch.map(enrichOne));
      done += batch.length; found += results.filter(x=>x==='ok').length; missed += results.filter(x=>x==='miss').length; errors += results.filter(x=>x==='error').length;
      if (els.enrichProgress) els.enrichProgress.textContent=`Обработано ${done}/${queue.length} · найдено ${found} · без совпадения ${missed} · ошибок ${errors}`;
      if (done % 10 === 0 || done === queue.length) await loadAnimeData();
      if (i+1 < queue.length && !enrichmentCancel) await new Promise(r=>setTimeout(r,2200)); // Safe for AniList's currently reduced 30 requests/minute limit
    }
    await loadAnimeData();
    showToast(enrichmentCancel ? `Остановлено: ${done} из ${queue.length}` : `Обогащение завершено: найдено ${found}, нет совпадения ${missed}, ошибок ${errors}`, enrichmentCancel?'info':'success');
  } finally {
    enrichmentRunning=false;
    if (button) {button.disabled=false;button.textContent='Обновить данные для всей библиотеки';}
    if (missingButton) missingButton.disabled=false;
    $('btn-stop-enrich').classList.add('hidden');
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
  const isStats=tab==='stats'; currentTab=isStats?'stats':tab;
  els.statsPage.classList.toggle('hidden',!isStats);
  els.list.classList.toggle('hidden',isStats); els.empty.classList.toggle('hidden',isStats || currentItems.length>0);
  $('tab-all').classList.toggle('active',tab==='all'); $('tab-fav').classList.toggle('active',tab==='favorite'); $('tab-stats').classList.toggle('active',isStats);
  $('tab-all').setAttribute('aria-pressed',String(tab==='all')); $('tab-fav').setAttribute('aria-pressed',String(tab==='favorite')); $('tab-stats').setAttribute('aria-pressed',String(isStats));
  $('mobile-library')?.classList.toggle('active',tab==='all');
  $('mobile-fav')?.classList.toggle('active',tab==='favorite');
  $('mobile-stats')?.classList.toggle('active',isStats);
  document.querySelector('.toolbar').classList.toggle('hidden',isStats); document.querySelector('.stats').classList.toggle('hidden',isStats);
  if(isStats) renderStatistics(); else loadAnimeData();
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
    anilistId: find('anilist id'), malId:find('mal id'), apiTitle:find('название api'), description: find('описание','description'), totalEpisodes: find('всего серий','total episodes'), duration: find('длительность серии','episode duration'), format: find('формат','format'), year: find('год','year'), score: find('оценка','score'), genres: find('жанры','genres'), apiPoster: find('постер api'), metadataUpdated: find('дата обновления api')
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
      anilistId: get('anilistId') ? Number(get('anilistId')) : null, malId:get('malId')?Number(get('malId')):null, titleApi:get('apiTitle'), description:get('description'), totalEpisodes:idx.totalEpisodes>=0?(parseInt(get('totalEpisodes'),10)||null):null, episodeDuration:idx.duration>=0?(parseInt(get('duration'),10)||null):null, format:get('format'), year:idx.year>=0?(parseInt(get('year'),10)||null):null, score:idx.score>=0?(parseInt(get('score'),10)||null):null, genres:get('genres')?get('genres').split(/[,|]/).map(x=>x.trim()).filter(Boolean):[], apiPosterUrl:idx.apiPoster>=0?safeURL(get('apiPoster')):'', metadataUpdatedAt:get('metadataUpdated')
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
          format: incoming.format || old.format || '', year: incoming.year || old.year || null, score: incoming.score || old.score || null, genres: incoming.genres || old.genres || [], apiPosterUrl:incoming.apiPosterUrl || old.apiPosterUrl || '', metadataUpdatedAt:incoming.metadataUpdatedAt || old.metadataUpdatedAt || ''
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
          watchLink:incoming.watchLink || '', anilistId:incoming.anilistId || null, malId:incoming.malId || null, titleApi:incoming.titleApi || '', description:incoming.description || '', totalEpisodes:incoming.totalEpisodes || null, episodeDuration:incoming.episodeDuration || null, format:incoming.format || '', year:incoming.year || null, score:incoming.score || null, genres:incoming.genres || [], apiPosterUrl:incoming.apiPosterUrl || '', metadataUpdatedAt:incoming.metadataUpdatedAt || ''
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
  const headers=['Русское название','Оригинальное название','Альтернативные названия','Добавлено в избранное','Статус просмотра','Текущая серия','Ссылка на просмотр','Ссылка на постер','AniList ID','MAL ID','Название API','Описание','Всего серий','Длительность серии (мин)','Формат','Год','Оценка','Жанры','Постер API','Дата обновления API'];
  const rows=[headers.join(';')];
  for (const x of items) rows.push([
    x.titleRu,x.titleOrig,x.titleAlt,Number(x.favorite)===1?'Добавлено':'Не добавлено',
    normalizeStatus(x.status),x.currentEpisode||0,x.watchLink,x.posterUrl,x.anilistId||'',x.malId||'',x.titleApi||'',x.description||'',x.totalEpisodes||'',x.episodeDuration||'',x.format||'',x.year||'',x.score||'',(x.genres||[]).join(', '),x.apiPosterUrl||'',x.metadataUpdatedAt||''
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
  $('btn-enrich-all').addEventListener('click',()=>enrichLibrary(false)); $('btn-enrich-missing').addEventListener('click',()=>enrichLibrary(true)); $('btn-stop-enrich').addEventListener('click',()=>{enrichmentCancel=true;els.enrichProgress.textContent+=' · остановка после текущего запроса…';});
  els.search.addEventListener('input',e=>{searchQuery=e.target.value;loadAnimeData();});
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
  setupInstallPrompt();
  updateStatusField();
  try {
    await db.open();
    await importBundledLibraryIfNeeded();
    await loadAnimeData();
    loadAniListGenreCollection();
  } catch(err) {
    console.error(err); showToast('Не удалось открыть локальную базу данных', 'error');
  }
  if (viewMode==='list') setView('list');
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch(err=>console.warn('Service Worker:',err));
  }
  $('app-version').textContent='v1.2';
}
document.addEventListener('DOMContentLoaded',init);
