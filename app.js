// Инициализация базы данных Dexie.js
const db = new Dexie('AnimeTrackerDB');
db.version(4).stores({
  anime: '++id, titleRu, titleOrig, titleAlt, favorite, status, currentEpisode, watchLink, posterUrl'
});

// Состояние приложения
let currentTab = 'all'; 
let filterStatus = 'Все';
let searchQuery = '';

// DOM элементы
const animeList = document.getElementById('anime-list');
const emptyState = document.getElementById('empty-state');
const tabAll = document.getElementById('tab-all');
const tabFav = document.getElementById('tab-fav');
const searchInput = document.getElementById('search-input');
const filterStatusSelect = document.getElementById('filter-status');
const csvFileInput = document.getElementById('csv-file');
const btnExport = document.getElementById('btn-export');

const animeModal = document.getElementById('anime-modal');
const animeForm = document.getElementById('anime-form');
const btnAddModal = document.getElementById('btn-add-modal');
const btnCloseModal = document.getElementById('btn-close-modal');
const formStatus = document.getElementById('form-status');
const formEpisodesContainer = document.getElementById('form-episodes-container');

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(err => console.log('SW Error:', err));
}

document.addEventListener('DOMContentLoaded', () => {
  loadAnimeData();
  
  tabAll.addEventListener('click', () => switchTab('all'));
  tabFav.addEventListener('click', () => switchTab('favorite'));
  
  searchInput.addEventListener('input', (e) => { searchQuery = e.target.value.toLowerCase(); loadAnimeData(); });
  filterStatusSelect.addEventListener('change', (e) => { filterStatus = e.target.value; loadAnimeData(); });

  csvFileInput.addEventListener('change', handleCSVImport);
  btnExport.addEventListener('click', handleCSVExport);

  btnAddModal.addEventListener('click', () => openModal());
  btnCloseModal.addEventListener('click', closeModal);
  animeForm.addEventListener('submit', handleFormSubmit);
  formStatus.addEventListener('change', toggleModalEpisodeField);
});

function switchTab(tab) {
  currentTab = tab;
  if (tab === 'all') {
    tabAll.className = "px-4 py-2 bg-red-600 text-white rounded font-medium transition hover:bg-red-700";
    tabFav.className = "px-4 py-2 bg-zinc-900 text-zinc-400 rounded font-medium transition hover:bg-zinc-800 border border-zinc-800";
  } else {
    tabFav.className = "px-4 py-2 bg-red-600 text-white rounded font-medium transition hover:bg-red-700";
    tabAll.className = "px-4 py-2 bg-zinc-900 text-zinc-400 rounded font-medium transition hover:bg-zinc-800 border border-zinc-800";
  }
  loadAnimeData();
}

function toggleModalEpisodeField() {
  if (formStatus.value === 'Смотрю') {
    formEpisodesContainer.style.display = 'block';
  } else {
    formEpisodesContainer.style.display = 'none';
    document.getElementById('form-episodes').value = 0;
  }
}

async function loadAnimeData() {
  let collection = db.anime.toCollection();

  if (currentTab === 'favorite') {
    collection = db.anime.where('favorite').equals(1);
  }

  let items = await collection.toArray();

  items = items.filter(item => {
    const matchesStatus = (filterStatus === 'Все') || (item.status === filterStatus);
    const matchesSearch = item.titleRu.toLowerCase().includes(searchQuery) || 
                          (item.titleOrig && item.titleOrig.toLowerCase().includes(searchQuery)) ||
                          (item.titleAlt && item.titleAlt.toLowerCase().includes(searchQuery));
    return matchesStatus && matchesSearch;
  });

  items.reverse();
  renderList(items);
}

function renderList(items) {
  animeList.innerHTML = '';
  if (items.length === 0) {
    emptyState.classList.remove('hidden');
    return;
  }
  emptyState.classList.add('hidden');

  items.forEach(item => {
    const card = document.createElement('div');
    card.className = "bg-zinc-950 border border-zinc-800 rounded-lg p-4 flex gap-4 items-start hover:border-zinc-700 transition";
    const posterSrc = item.posterUrl || 'https://placehold.co';
    const isWatching = item.status === 'Смотрю';

    card.innerHTML = `
      <img src="${posterSrc}" alt="Постер" class="w-20 h-28 object-cover rounded bg-zinc-900 flex-shrink-0 border border-zinc-800">
      <div class="flex-1 min-w-0">
        <div class="flex items-start justify-between gap-2">
          <h4 class="font-bold text-lg text-white truncate">${item.titleRu}</h4>
          <button onclick="toggleFavorite(${item.id}, ${item.favorite})" class="text-xl transition focus:outline-none ${item.favorite ? 'text-yellow-500' : 'text-zinc-600 hover:text-zinc-400'}">
            ${item.favorite ? '★' : '☆'}
          </button>
        </div>
        <p class="text-xs text-zinc-400 truncate mb-2">${item.titleOrig || ''} ${item.titleAlt ? '• ' + item.titleAlt : ''}</p>
        
        <div class="flex flex-wrap items-center gap-3 mt-2">
          <span class="status-badge px-2 py-0.5 text-xs font-semibold rounded">${item.status}</span>
          
          ${isWatching ? `
            <div class="flex items-center bg-zinc-900 border border-zinc-800 rounded overflow-hidden">
              <button onclick="changeEpisode(${item.id}, -1)" class="px-2 py-0.5 text-zinc-400 hover:bg-zinc-800">-</button>
              <span class="px-3 text-sm font-medium text-white">${item.currentEpisode || 0} сер.</span>
              <button onclick="changeEpisode(${item.id}, 1)" class="px-2 py-0.5 text-zinc-400 hover:bg-zinc-800">+</button>
            </div>
          ` : ''}

          ${item.watchLink ? `
            <a href="${item.watchLink}" target="_blank" class="text-xs bg-red-950/40 text-red-400 border border-red-900/50 px-2 py-1 rounded hover:bg-red-900/40 transition">Смотреть →</a>
          ` : ''}
        </div>
      </div>
      
      <div class="flex flex-col gap-2 justify-between h-full text-right self-stretch">
        <div class="flex gap-2">
          <button onclick="editAnime(${item.id})" class="text-xs bg-zinc-900 border border-zinc-800 px-2 py-1 rounded hover:bg-zinc-800 text-zinc-300">Ред.</button>
          <button onclick="deleteAnime(${item.id})" class="text-xs bg-zinc-900 border border-zinc-800 px-2 py-1 rounded hover:text-red-500 hover:border-red-900 transition text-zinc-500">Удал.</button>
        </div>
      </div>
    `;
    animeList.appendChild(card);
  });
}

async function changeEpisode(id, delta) {
  const item = await db.anime.get(id);
  if (item) {
    const newEp = Math.max(0, (item.currentEpisode || 0) + delta);
    await db.anime.update(id, { currentEpisode: newEp });
    loadAnimeData();
  }
}

async function toggleFavorite(id, currentVal) {
  await db.anime.update(id, { favorite: currentVal ? 0 : 1 });
  loadAnimeData();
}

async function deleteAnime(id) {
  if (confirm('Удалить это аниме из базы данных?')) {
    await db.anime.delete(id);
    loadAnimeData();
  }
}

async function fetchPosterUrl(title) {
  try {
    const url = `https://shikimori.one{encodeURIComponent(title)}&limit=1`;
    const response = await fetch(url);
    if (response.ok) {
      const data = await response.json();
      if (data && data.length > 0 && data[0].image) {
        return `https://shikimori.one${data[0].image.original}`;
      }
    }
  } catch (e) {
    console.error('Ошибка поиска постера:', e);
  }
  return '';
}

/* Модальное окно */
function openModal(item = null) {
  animeModal.classList.remove('hidden');
  if (item) {
    document.getElementById('modal-title').innerText = 'Редактировать Аниме';
    document.getElementById('edit-id').value = item.id;
    document.getElementById('form-title-ru').value = item.titleRu;
    document.getElementById('form-title-orig').value = item.titleOrig || '';
    document.getElementById('form-title-alt').value = item.titleAlt || '';
    document.getElementById('form-status').value = item.status;
    document.getElementById('form-episodes').value = item.currentEpisode || 0;
    document.getElementById('form-link').value = item.watchLink || '';
    document.getElementById('form-poster').value = item.posterUrl || '';
    document.getElementById('form-favorite').checked = item.favorite === 1;
  } else {
    document.getElementById('modal-title').innerText = 'Добавить Аниме';
    animeForm.reset();
    document.getElementById('edit-id').value = '';
  }
  toggleModalEpisodeField();
}

function closeModal() {
  animeModal.classList.add('hidden');
}

async function handleFormSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('edit-id').value;
  const titleRu = document.getElementById('form-title-ru').value.trim();
  const status = document.getElementById('form-status').value;
  
  let posterUrl = document.getElementById('form-poster').value.trim();
  if (!posterUrl) {
    posterUrl = await fetchPosterUrl(titleRu);
  }

  const animeData = {
    titleRu,
    titleOrig: document.getElementById('form-title-orig').value.trim(),
    titleAlt: document.getElementById('form-title-alt').value.trim(),
    status,
    currentEpisode: status === 'Смотрю' ? parseInt(document.getElementById('form-episodes').value) || 0 : 0,
    watchLink: document.getElementById('form-link').value.trim(),
    posterUrl,
    favorite: document.getElementById('form-favorite').checked ? 1 : 0
  };

  if (id) {
    await db.anime.update(parseInt(id), animeData);
  } else {
    await db.anime.add(animeData);
  }

  closeModal();
  loadAnimeData();
}

async function editAnime(id) {
  const item = await db.anime.get(id);
  if (item) openModal(item);
}

/* Работа с CSV */
function handleCSVImport(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async function(evt) {
    const text = evt.target.result;
    const lines = text.split(/\r?\n/);
    if (lines.length < 2) return;

    const firstLine = lines[0];
const delimiter = firstLine.includes(';') ? ';' : ',';
function parseCSVLine(line) {
const result = [];
let current = '';
let inQuotes = false;
for (let i = 0; i < line.length; i++) {
const char = line[i];
if (char === '"') {
inQuotes = !inQuotes;
} else if (char === delimiter && !inQuotes) {
result.push(current.trim().replace(/^"|"$/g, ''));
current = '';
} else {
current += char;
}
}
result.push(current.trim().replace(/^"|"$/g, ''));
return result;
}
const headers = parseCSVLine(lines[0]);
const idxRu = headers.findIndex(h => h.toLowerCase().includes('русское'));
const idxOrig = headers.findIndex(h => h.toLowerCase().includes('оригинальное'));
const idxAlt = headers.findIndex(h => h.toLowerCase().includes('альтернативные'));
const idxFav = headers.findIndex(h => h.toLowerCase().includes('избранное'));
const idxStatus = headers.findIndex(h => h.toLowerCase().includes('статус'));
let importedCount = 0;
for (let i = 1; i < lines.length; i++) {
if (!lines[i].trim()) continue;
const row = parseCSVLine(lines[i]);
if (idxRu !== -1 && row[idxRu]) {
const titleRu = row[idxRu];
const statusValue = idxStatus !== -1 ? row[idxStatus] : 'В планах';
let isFav = 0;
if (idxFav !== -1 && row[idxFav]) {
const favText = row[idxFav].toLowerCase();
if (favText.includes('добавлено') && !favText.includes('не')) isFav = 1;
if (favText === '1' || favText === 'yes' || favText === 'true') isFav = 1;
}
const exists = await db.anime.where('titleRu').equals(titleRu).first();
if (!exists) {
const poster = await fetchPosterUrl(titleRu);
await db.anime.add({
titleRu,
titleOrig: idxOrig !== -1 ? row[idxOrig] : '',
titleAlt: idxAlt !== -1 ? row[idxAlt] : '',
status: statusValue,
currentEpisode: 0,
watchLink: '',
posterUrl: poster,
favorite: isFav
});
importedCount++;
}
}
}
alert(Импорт завершен! Добавлено записей: ${importedCount});
loadAnimeData();
};
reader.readAsText(file, 'UTF-8');
}
async function handleCSVExport() {
const items = await db.anime.toArray();
if (items.length === 0) {
alert('База пуста.');
return;
}
const headers = ['№', 'Русское название', 'Оригинальное название', 'Альтернативные названия', 'Добавлено в избранное', 'Статус просмотра'];
let csvContent = headers.join(';') + '\n';
items.forEach((item, index) => {
const favText = item.favorite === 1 ? 'добавлено' : 'Не добавлено';
const row = [
index + 1,
"${item.titleRu.replace(/"/g, '""')}",
"${(item.titleOrig || '').replace(/"/g, '""')}",
"${(item.titleAlt || '').replace(/"/g, '""')}",
"${favText}",
"${item.status}"
];
csvContent += row.join(';') + '\n';
});
const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
const url = URL.createObjectURL(blob);
const link = document.createElement("a");
link.setAttribute("href", url);
link.setAttribute("download", "anime_base_export.csv");
document.body.appendChild(link);
link.click();
document.body.removeChild(link);
}