/* AnimeVault PWA — надёжный трекер аниме */
'use strict';

const DB_NAME = 'AnimeTrackerDB';
const DB_VERSION = 5;
const STATUSES = ['Смотрю', 'В планах', 'Просмотрено', 'Отложено', 'Брошено'];
const STATUS_ALIASES = {
  'просмотренно': 'Просмотрено', 'просмотрено': 'Просмотрено',
  'watching': 'Смотрю', 'planned': 'В планах', 'completed': 'Просмотрено',
  'watched': 'Просмотрено', 'on-hold': 'Отложено', 'dropped': 'Брошено'
};
const db = new Dexie(DB_NAME);
db.version(5).stores({
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
let searchQuery = '';
let currentItems = [];
let busy = false;

const $ = id => document.getElementById(id);
const els = {
  list: $('anime-list'), empty: $('empty-state'), tabAll: $('tab-all'), tabFav: $('tab-fav'),
  search: $('search-input'), filter: $('filter-status'), csv: $('csv-file'), export: $('btn-export'),
  modal: $('anime-modal'), form: $('anime-form'), add: $('btn-add-modal'),
  close: $('btn-close-modal'), close2: $('btn-close-modal-2'), status: $('form-status'),
  episodesWrap: $('form-episodes-container'), episodes: $('form-episodes'),
  poster: $('form-poster'), posterPreview: $('poster-preview'), posterSearch: $('btn-search-poster'),
  titleRu: $('form-title-ru'), titleOrig: $('form-title-orig'), titleAlt: $('form-title-alt'),
  link: $('form-link'), favorite: $('form-favorite'), editId: $('edit-id'),
  modalTitle: $('modal-title'), importStatus: $('import-status'), toast: $('toast')
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
  const watching = els.status.value === 'Смотрю';
  els.episodesWrap.classList.toggle('is-disabled', !watching);
  els.episodes.disabled = !watching;
  if (!watching) els.episodes.value = '0';
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
      const haystack = norm([item.titleRu, item.titleOrig, item.titleAlt].join(' '));
      return statusOK && (!query || haystack.includes(query));
    });
    items.sort((a,b) => (b.id || 0) - (a.id || 0));
    currentItems = items;
    renderList(items);
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
  els.empty.classList.toggle('hidden', items.length !== 0);
  for (const item of items) {
    const card = document.createElement('article');
    card.className = 'anime-card';
    const poster = safeURL(item.posterUrl) || 'icon-512.png';
    const watch = safeURL(item.watchLink);
    const title = escapeHTML(item.titleRu || 'Без названия');
    const original = escapeHTML(item.titleOrig || '—');
    const alt = escapeHTML(item.titleAlt || '');
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
        <div class="card-meta">
          ${status === 'Смотрю' ? `<div class="episode-stepper"><button data-action="episode-down" aria-label="Уменьшить серию">−</button><span>${Math.max(0, Number(item.currentEpisode)||0)} сер.</span><button data-action="episode-up" aria-label="Увеличить серию">+</button></div>` : '<span class="progress-muted">Прогресс не ведётся</span>'}
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
  if (!item || normalizeStatus(item.status) !== 'Смотрю') return;
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
async function fetchPosterUrl(title) {
  if (!title.trim()) return '';
  const endpoint = `https://shikimori.one/api/animes?search=${encodeURIComponent(title.trim())}&limit=1`;
  try {
    const response = await fetch(endpoint, {headers:{'Accept':'application/json'}});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const image = data?.[0]?.image;
    const candidate = image?.original || image?.preview || image?.x96;
    return candidate ? safeURL(candidate.startsWith('/') ? `https://shikimori.one${candidate}` : candidate) : '';
  } catch (err) {
    console.warn('Shikimori poster search failed:', err);
    return '';
  }
}
async function searchPoster() {
  const title = els.titleOrig.value.trim() || els.titleRu.value.trim();
  if (!title) { showToast('Сначала укажите название аниме', 'error'); return; }
  els.posterSearch.disabled = true;
  els.posterSearch.textContent = 'Ищем…';
  const url = await fetchPosterUrl(title);
  els.posterSearch.disabled = false;
  els.posterSearch.textContent = 'Найти на Shikimori';
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
    currentEpisode: els.status.value === 'Смотрю' ? Math.max(0, parseInt(els.episodes.value,10)||0) : 0,
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
    poster: find('ссылка на постер','постер','poster')
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
      posterUrl: idx.poster >= 0 ? safeURL(get('poster')) : ''
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
          watchLink: incoming.watchLink || old.watchLink || ''
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
          watchLink:incoming.watchLink || ''
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
  const headers=['Русское название','Оригинальное название','Альтернативные названия','Добавлено в избранное','Статус просмотра','Текущая серия','Ссылка на просмотр','Ссылка на постер'];
  const rows=[headers.join(';')];
  for (const x of items) rows.push([
    x.titleRu,x.titleOrig,x.titleAlt,Number(x.favorite)===1?'Добавлено':'Не добавлено',
    normalizeStatus(x.status),x.currentEpisode||0,x.watchLink,x.posterUrl
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

function bindEvents() {
  els.tabAll.addEventListener('click',()=>switchTab('all'));
  els.tabFav.addEventListener('click',()=>switchTab('favorite'));
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
  updateStatusField();
  try {
    await db.open();
    await importBundledLibraryIfNeeded();
    await loadAnimeData();
  } catch(err) {
    console.error(err); showToast('Не удалось открыть локальную базу данных', 'error');
  }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch(err=>console.warn('Service Worker:',err));
  }
  $('app-version').textContent='v1.0';
}
document.addEventListener('DOMContentLoaded',init);
