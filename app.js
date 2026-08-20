/* MTG Card Scanner — camera → OCR → Scryfall lookup → IndexedDB */

// ---------- IndexedDB ----------
const DB_NAME = 'mtg-collection';
const STORE = 'cards';
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const s = req.result.createObjectStore(STORE, { keyPath: 'id' });
      s.createIndex('name', 'name', { unique: false });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function tx(mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const s = t.objectStore(STORE);
    const r = fn(s);
    t.oncomplete = () => resolve(r && r.result);
    t.onerror = () => reject(t.error);
  });
}
const dbAll = () => tx('readonly', s => s.getAll());
const dbGet = id => tx('readonly', s => s.get(id));
const dbPut = card => tx('readwrite', s => s.put(card));
const dbDelete = id => tx('readwrite', s => s.delete(id));
const dbClear = () => tx('readwrite', s => s.clear());

// ---------- DOM ----------
const $ = id => document.getElementById(id);
const video = $('video'), canvas = $('capture'), statusEl = $('status');
let stream = null, facing = 'environment', pending = null, ocrWorker = null;
let scanning = false, scanTimer = null;
let lastId = '', streak = 0, lockedId = null, missCount = 0;
let qrMode = false, qrTimer = null, qrGot = null;

const setStatus = msg => (statusEl.textContent = msg);

let toastTimer = null;
function toast(msg, ms = 5000) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// ---------- Tabs ----------
$('tab-scan').onclick = () => showView('scan');
$('tab-collection').onclick = () => showView('collection');
function showView(v) {
  $('view-scan').hidden = v !== 'scan';
  $('view-collection').hidden = v !== 'collection';
  $('tab-scan').classList.toggle('active', v === 'scan');
  $('tab-collection').classList.toggle('active', v === 'collection');
  if (v === 'collection') renderCollection();
}

// ---------- Camera ----------
async function startCamera() {
  stopCamera();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing, width: { ideal: 3840 }, height: { ideal: 2160 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    $('btn-camera').textContent = 'Stop Camera';
    setStatus('Camera ready — show a card.');
    setupZoom();
    startAutoScan();
  } catch (e) {
    setStatus('Camera error: ' + e.message + ' (HTTPS or localhost required)');
  }
}
function stopCamera() {
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null;
  video.srcObject = null;
  stopAutoScan();
  $('btn-camera').textContent = 'Start Camera';
}
$('btn-camera').onclick = () => (stream ? stopCamera() : startCamera());

// ---- Optical/digital zoom via MediaStreamTrack constraints (if supported) ----
function setupZoom() {
  const track = stream && stream.getVideoTracks()[0];
  const caps = track && track.getCapabilities ? track.getCapabilities() : {};
  const row = $('zoom-row'), slider = $('zoom');
  if (!caps.zoom) { row.hidden = true; return; }
  row.hidden = false;
  slider.min = caps.zoom.min; slider.max = caps.zoom.max; slider.step = caps.zoom.step || 0.1;
  applySavedZoom();
  slider.oninput = () => applyZoom(parseFloat(slider.value));
}
function applySavedZoom() {
  const track = stream && stream.getVideoTracks()[0];
  const caps = track && track.getCapabilities ? track.getCapabilities() : {};
  if (!caps.zoom) return;
  const saved = parseFloat(localStorage.getItem('mtg-zoom-' + scanMode));
  const z = Math.min(caps.zoom.max, Math.max(caps.zoom.min, isNaN(saved) ? caps.zoom.min : saved));
  $('zoom').value = z;
  applyZoom(z);
}
async function applyZoom(z) {
  const track = stream && stream.getVideoTracks()[0];
  if (!track) return;
  $('zoom-val').textContent = z.toFixed(1) + '×';
  localStorage.setItem('mtg-zoom-' + scanMode, z);
  try { await track.applyConstraints({ advanced: [{ zoom: z }] }); }
  catch (e) { console.warn('zoom failed', e); }
}
$('btn-flip').onclick = () => { facing = facing === 'environment' ? 'user' : 'environment'; if (stream) startCamera(); };

// ---------- OCR ----------
async function getWorker() {
  if (ocrWorker) return ocrWorker;
  setStatus('Loading OCR engine (first time only)…');
  ocrWorker = await Tesseract.createWorker('eng');
  return ocrWorker;
}
async function ocr(canvas, profile) {
  const w = await getWorker();
  await w.setParameters(profile === 'footer'
    ? { tessedit_char_whitelist: '0123456789/ABCDEFGHIJKLMNOPQRSTUVWXYZ•- ', tessedit_pageseg_mode: '6' }
    : { tessedit_char_whitelist: '', tessedit_pageseg_mode: '6' });
  const { data } = await w.recognize(canvas);
  return data.text;
}

// ---- Guide layout (fractions of the camera view) ----
// The card outline is inset from the view; the OCR strips are positioned
// relative to the card (fractions of card width/height).
const CARD_DEFAULT = { x: 0.06, y: 0.04, w: 0.88, h: 0.92 };
const CARD = Object.assign({}, CARD_DEFAULT, JSON.parse(localStorage.getItem('mtg-guide') || '{}'));
// Footer-only mode: one big strip the camera zooms into — its own saved rect.
const FOOT_DEFAULT = { x: 0.08, y: 0.35, w: 0.84, h: 0.30 };
const FOOT = Object.assign({}, FOOT_DEFAULT, JSON.parse(localStorage.getItem('mtg-guide-footer') || '{}'));
let scanMode = localStorage.getItem('mtg-mode') || 'full';
const activeRect = () => (scanMode === 'footer' ? FOOT : CARD);
const REGIONS = {
  name:   { x: 0.06, y: 0.040, w: 0.78, h: 0.070 },   // title bar
  footer: { x: 0.03, y: 0.930, w: 0.60, h: 0.060 },   // bottom-left: collector no. / set code
};
function regionRect(r) {                  // → fractions of the whole view
  return { x: CARD.x + r.x * CARD.w, y: CARD.y + r.y * CARD.h, w: r.w * CARD.w, h: r.h * CARD.h };
}
function layoutGuides() {
  const place = (el, r) => Object.assign(el.style, {
    left: r.x * 100 + '%', top: r.y * 100 + '%', width: r.w * 100 + '%', height: r.h * 100 + '%',
  });
  place(document.querySelector('.card-outline'), activeRect());
  place(document.querySelector('.name-box'), regionRect(REGIONS.name));
  place(document.querySelector('.footer-box'), regionRect(REGIONS.footer));
}
layoutGuides();

// ---- Drag / resize the card outline so it matches where the card really is
// (e.g. in a phone rig). Saved to localStorage. ----
(() => {
  const wrap = document.querySelector('.camera-wrap');
  const outline = document.querySelector('.card-outline');
  const handle = outline.querySelector('.resize-handle');
  let drag = null;
  const frac = e => {
    const r = wrap.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  function down(e, mode) {
    e.preventDefault(); e.stopPropagation();
    drag = { mode, start: frac(e), card: { ...activeRect() } };
    e.target.setPointerCapture(e.pointerId);
  }
  function move(e) {
    if (!drag) return;
    const p = frac(e), dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    const R = activeRect();
    if (drag.mode === 'move') {
      R.x = clamp(drag.card.x + dx, 0, 1 - R.w);
      R.y = clamp(drag.card.y + dy, 0, 1 - R.h);
    } else {
      R.w = clamp(drag.card.w + dx, 0.1, 1 - R.x);
      R.h = clamp(drag.card.h + dy, 0.05, 1 - R.y);
    }
    layoutGuides();
  }
  function up() {
    if (!drag) return;
    drag = null;
    localStorage.setItem(scanMode === 'footer' ? 'mtg-guide-footer' : 'mtg-guide', JSON.stringify(activeRect()));
  }
  outline.addEventListener('pointerdown', e => down(e, 'move'));
  handle.addEventListener('pointerdown', e => down(e, 'resize'));
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
  $('btn-reset-guide').onclick = () => {
    if (scanMode === 'footer') { Object.assign(FOOT, FOOT_DEFAULT); localStorage.removeItem('mtg-guide-footer'); }
    else { Object.assign(CARD, CARD_DEFAULT); localStorage.removeItem('mtg-guide'); }
    layoutGuides();
  };

  // ---- Mode toggle: full card (name + footer) vs footer-only (zoomed) ----
  function setMode(m) {
    scanMode = m;
    localStorage.setItem('mtg-mode', m);
    $('mode-full').classList.toggle('active', m === 'full');
    $('mode-footer').classList.toggle('active', m === 'footer');
    document.querySelector('.guide').classList.toggle('footer-mode', m === 'footer');
    document.querySelector('#prev-name').parentElement.hidden = m === 'footer';
    layoutGuides();
    lastId = ''; streak = 0; lockedId = null;   // fresh detection state
    if (stream) applySavedZoom();
  }
  $('mode-full').onclick = () => setMode('full');
  $('mode-footer').onclick = () => setMode('footer');
  setMode(scanMode);
})();

// Grab the region of the video that corresponds to an on-screen guide box.
// In footer-only mode the outline rect IS the footer region.
function captureRegion(region, targetHeight) {
  const r = scanMode === 'footer' ? FOOT : regionRect(region);
  const vw = video.videoWidth, vh = video.videoHeight;
  const ew = video.clientWidth, eh = video.clientHeight;
  // object-fit: cover — compute visible crop of the source video
  const scale = Math.max(ew / vw, eh / vh);
  const visW = ew / scale, visH = eh / scale;
  const offX = (vw - visW) / 2, offY = (vh - visH) / 2;
  const sx = offX + visW * r.x, sw = visW * r.w;
  const sy = offY + visH * r.y, sh = visH * r.h;

  const upscale = Math.max(1, targetHeight / sh);   // scale so the strip is ~targetHeight px tall
  const c = document.createElement('canvas');
  c.width = Math.round(sw * upscale); c.height = Math.round(sh * upscale);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, c.width, c.height);

  // Grayscale, then auto-invert (card footers are white-on-black; Tesseract
  // wants dark-on-light), then stretch contrast to the full range.
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data, n = d.length / 4, gray = new Float32Array(n);
  let sum = 0, min = 255, max = 0;
  for (let i = 0; i < n; i++) {
    const g = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    gray[i] = g; sum += g;
    if (g < min) min = g;
    if (g > max) max = g;
  }
  const invert = sum / n < 128;
  const range = Math.max(1, max - min);
  for (let i = 0; i < n; i++) {
    let v = ((gray[i] - min) / range) * 255;
    if (invert) v = 255 - v;
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function cleanOCR(text) {
  return text
    .split('\n')
    .map(l => l.replace(/[^A-Za-z' ,\-]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(l => l.length >= 3);
}

// Parse the footer text, e.g. "0267/0281 C" + "MKM • EN" or "267/281 C  M20 • EN"
// → { set: 'mkm', number: '267' }. Either part may be missing.
function parseFooter(text) {
  const t = text.toUpperCase().replace(/[•·*]/g, ' ');
  let number = null, set = null;
  const m = t.match(/(\d{1,4}[A-Z]?)\s*\/\s*\d{1,4}/) || t.match(/(?:^|\s)(\d{2,4}[A-Z]?)(?=\s|$)/m);
  if (m) number = m[1].replace(/^0+(?=\d)/, '').toLowerCase();
  // Set code: 3–5 chars, at least one letter, often followed by a language code
  const lang = t.match(/\b([A-Z][A-Z0-9]{2,4})\s+(?:EN|DE|FR|IT|ES|PT|JA|JP|KO|RU|ZH|ZHS|ZHT)\b/);
  if (lang) set = lang[1];
  else {
    const cands = (t.match(/\b[A-Z][A-Z0-9]{2,4}\b/g) || []).filter(w => !['EN', 'AND', 'THE', 'LLC', 'WIZARDS', 'COAST'].includes(w));
    if (cands.length) set = cands[cands.length - 1];
  }
  return { set: set ? set.toLowerCase() : null, number };
}

// ---------- Scryfall ----------
// All Scryfall calls flow through one queue that enforces the documented
// hard limits (500ms between /cards/named|search calls, 100ms otherwise)
// and honors HTTP 429 by pausing all lookups for the penalty window.
const SF_SPACING = { named: 550, default: 110 };   // ms, small safety buffer
const sfLast = { named: 0, default: 0 };
let sfChain = Promise.resolve();
let sfBlockedUntil = 0;
let sfLastError = null;          // '429' | 'network' | null — outcome of the most recent call
const sfCooldownSecs = () => Math.max(0, Math.ceil((sfBlockedUntil - Date.now()) / 1000));

function sf(path) {
  const tier = /^\/cards\/(named|search|random|collection)/.test(path) ? 'named' : 'default';
  const call = sfChain.then(async () => {
    if (Date.now() < sfBlockedUntil) { sfLastError = '429'; return null; }
    const wait = sfLast[tier] + SF_SPACING[tier] - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    sfLast[tier] = Date.now();
    try {
      const r = await fetch('https://api.scryfall.com' + path);
      if (r.status === 429) {
        const retry = parseInt(r.headers.get('Retry-After'), 10) || 30;
        sfBlockedUntil = Date.now() + retry * 1000;
        sfLastError = '429';
        toast(`⏳ Scryfall rate limit reached — pausing lookups for ${retry}s`, retry * 1000);
        console.warn(`Scryfall 429 — pausing lookups ${retry}s`);
        return null;
      }
      sfLastError = null;
      if (!r.ok) return null;
      return r.json();
    } catch (e) {
      if (sfLastError !== 'network') toast('⚠ Network error reaching Scryfall — check your connection.');
      sfLastError = 'network';
      console.warn('Scryfall fetch failed', e);
      return null;
    }
  });
  sfChain = call;
  return call;
}
const lookupCard = (name, set) =>
  sf('/cards/named?fuzzy=' + encodeURIComponent(name) + (set ? '&set=' + encodeURIComponent(set) : ''));
const lookupPrinting = (set, number) =>
  sf('/cards/' + encodeURIComponent(set) + '/' + encodeURIComponent(number));
function summarize(c) {
  const face = c.card_faces && !c.image_uris ? c.card_faces[0] : c;
  return {
    id: c.id,
    name: c.name,
    set: c.set.toUpperCase(),
    setName: c.set_name,
    number: c.collector_number,
    type: face.type_line || c.type_line || '',
    mana: face.mana_cost || c.mana_cost || '',
    text: face.oracle_text || c.oracle_text || '',
    rarity: c.rarity,
    image: (c.image_uris || face.image_uris || {}).normal || '',
    thumb: (c.image_uris || face.image_uris || {}).small || '',
    price: c.prices && c.prices.usd ? c.prices.usd : null,
    scryfall: c.scryfall_uri,
  };
}

// ---------- Auto-scan loop ----------
// Continuously OCR the name strip AND the footer strip. The footer gives the
// set code + collector number, which pins the exact printing. When the same
// printing is matched on two consecutive passes it is "locked": shown in the
// result panel and, if Auto-add is on and the set was confirmed from the
// footer, added to the collection. It will not be added again until a
// different card (or nothing) is seen for a few passes.
const lookupCache = new Map();
const guide = document.querySelector('.guide');

function similarity(a, b) {
  a = a.toLowerCase().replace(/[^a-z]/g, ''); b = b.toLowerCase().replace(/[^a-z]/g, '');
  if (!a.length || !b.length) return 0;
  const m = a.length, n = b.length, dp = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return 1 - dp[m][n] / Math.max(m, n);
}
const MIN_SIMILARITY = 0.7;

const MISS = Symbol('miss');
async function cached(key, fn) {
  if (!lookupCache.has(key)) {
    const v = await fn();
    if (v) lookupCache.set(key, v);
    else if (Date.now() >= sfBlockedUntil) lookupCache.set(key, MISS);  // real miss, not a cooldown
    else return null;
  }
  const v = lookupCache.get(key);
  return v === MISS ? null : v;
}

// Resolve (name guesses, footer) → { card, setConfirmed } or null
async function identify(nameLines, footer) {
  const nameOk = c => !c ? false : nameLines.length === 0 || nameLines.some(l => similarity(l, c.name) >= MIN_SIMILARITY);

  // 1. Exact printing from footer, cross-checked against the name
  if (footer.set && footer.number) {
    const c = await cached(`p:${footer.set}/${footer.number}`, () => lookupPrinting(footer.set, footer.number));
    if (c && nameOk(c) && nameLines.length) return { card: c, setConfirmed: true };
  }
  // 2. Name within the set read from the footer
  for (const l of nameLines.slice(0, 2)) {
    if (footer.set) {
      const c = await cached(`ns:${footer.set}:${l.toLowerCase()}`, () => lookupCard(l, footer.set));
      if (c && similarity(l, c.name) >= MIN_SIMILARITY) return { card: c, setConfirmed: true };
    }
  }
  // 3. Name only — set unconfirmed
  for (const l of nameLines.slice(0, 2)) {
    const c = await cached(`n:${l.toLowerCase()}`, () => lookupCard(l));
    if (c && similarity(l, c.name) >= MIN_SIMILARITY) return { card: c, setConfirmed: false };
  }
  return null;
}

function startAutoScan() {
  if (scanning) return;
  scanning = true;
  lastId = ''; streak = 0; lockedId = null; missCount = 0;
  guide.classList.add('scanning');
  scanLoop();
}
function stopAutoScan() {
  scanning = false;
  clearTimeout(scanTimer);
  guide.classList.remove('scanning', 'locked');
}

async function scanLoop() {
  if (!scanning || !stream) return;
  try {
    if (video.readyState >= 2 && !qrMode) await scanOnce();
  } catch (e) {
    console.warn('scan pass failed', e);
  }
  if (scanning) scanTimer = setTimeout(scanLoop, 250);
}

function preview(id, src) {
  const c = $(id); c.width = src.width; c.height = src.height;
  c.getContext('2d').drawImage(src, 0, 0);
}
// Footer-only mode: identify purely by set + collector number. No name
// cross-check, so require a longer streak of identical reads before locking.
const STREAK_FULL = 2, STREAK_FOOTER = 3;

async function scanOnce() {
  if (Date.now() < sfBlockedUntil) {
    setStatus(`Scryfall rate limit hit — resuming in ${Math.ceil((sfBlockedUntil - Date.now()) / 1000)}s…`);
    return;
  }
  let hit = null, nameLines = [], footer = { set: null, number: null };
  if (scanMode === 'footer') {
    const crop = captureRegion(null, 300);
    preview('prev-footer', crop);
    footer = parseFooter(await ocr(crop, 'footer'));
    if (footer.set && footer.number) {
      const card = await cached(`p:${footer.set}/${footer.number}`, () => lookupPrinting(footer.set, footer.number));
      if (card) hit = { card, setConfirmed: true };
    }
  } else {
    const nameCrop = captureRegion(REGIONS.name, 160), footerCrop = captureRegion(REGIONS.footer, 200);
    preview('prev-name', nameCrop); preview('prev-footer', footerCrop);
    const nameText = await ocr(nameCrop, 'name');
    const footerText = await ocr(footerCrop, 'footer');
    nameLines = cleanOCR(nameText);
    footer = parseFooter(footerText);
    hit = await identify(nameLines, footer);
  }

  if (!hit) {
    missCount++;
    streak = 0; lastId = '';
    if (missCount >= 4 && lockedId) {            // card removed from view → allow re-detect
      lockedId = null;
      guide.classList.remove('locked');
      setStatus('Show the next card.');
    }
    if (!lockedId) {
      const bits = [];
      if (nameLines.length) bits.push(`name "${nameLines[0]}"`);
      if (footer.set || footer.number) bits.push(`footer ${footer.set || '?'} #${footer.number || '?'}`);
      setStatus(bits.length ? 'Reading… ' + bits.join(', ') : 'Looking for a card…');
    }
    return;
  }

  const { card, setConfirmed } = hit;
  missCount = 0;
  if (card.id === lockedId) return;              // already handled this printing
  streak = card.id === lastId ? streak + 1 : 1;
  lastId = card.id;
  const need = scanMode === 'footer' ? STREAK_FOOTER : STREAK_FULL;
  setStatus(`Recognizing… ${card.name} (${card.set.toUpperCase()} #${card.collector_number}) ${streak}/${need}`);

  if (streak >= need) {
    lockedId = card.id;
    guide.classList.add('locked');
    const c = summarize(card);
    showResult(c, setConfirmed);
    if (setConfirmed && $('auto-add').checked) await addCard(c);
    else if (!setConfirmed) setStatus(`Found ${c.name} but could not read the set from the footer — showing ${c.set} #${c.number}. Tap Add if correct.`);
  }
}

$('btn-manual').onclick = manualLookup;
$('manual-name').addEventListener('keydown', e => { if (e.key === 'Enter') manualLookup(); });
async function manualLookup() {
  const name = $('manual-name').value.trim();
  if (!name) return;
  setStatus('Looking up "' + name + '"…');
  const card = await lookupCard(name);
  if (!card) {
    if (sfLastError === '429') setStatus(`Rate limited — try again in ${sfCooldownSecs()}s.`);
    else if (sfLastError === 'network') setStatus('Network error — could not reach Scryfall.');
    else setStatus('No match for "' + name + '".');
    return;
  }
  showResult(summarize(card));
}

function showResult(c, setConfirmed = true) {
  pending = c;
  $('result').hidden = false;
  $('btn-add').textContent = 'Add to Collection';
  $('result-meta').classList.toggle('warn', !setConfirmed);
  $('result-img').src = c.image;
  $('result-name').textContent = c.name + (c.mana ? '  ' + c.mana : '');
  $('result-meta').textContent = `${c.type}\n${c.setName} (${c.set}) #${c.number} · ${c.rarity}` + (c.price ? ` · $${c.price}` : '') + (setConfirmed ? '' : '\n⚠ set not confirmed from footer');
  $('result-text').textContent = c.text;
  setStatus('Found: ' + c.name);
}

$('btn-discard').onclick = () => { pending = null; $('result').hidden = true; setStatus(''); };
async function addCard(c) {
  const existing = await dbGet(c.id);
  const card = existing
    ? { ...existing, qty: existing.qty + 1 }
    : { ...c, qty: 1, added: new Date().toISOString() };
  await dbPut(card);
  setStatus(`✓ Added ${card.name} (×${card.qty} in collection).`);
  $('btn-add').textContent = 'Add another copy';
  updateCount();
}
$('btn-add').onclick = async () => { if (pending) await addCard(pending); };

// ---------- Collection ----------
async function updateCount() {
  const all = await dbAll();
  $('count').textContent = all.reduce((n, c) => n + c.qty, 0);
}

async function renderCollection() {
  const q = $('search').value.trim().toLowerCase();
  const all = (await dbAll())
    .filter(c => !q || c.name.toLowerCase().includes(q) || c.type.toLowerCase().includes(q) || c.set.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));
  const ul = $('cards');
  ul.innerHTML = '';
  $('empty').hidden = all.length > 0;
  for (const c of all) {
    const li = document.createElement('li');
    li.className = 'card-row';
    li.innerHTML = `
      <img src="${c.thumb}" alt="">
      <div class="info">
        <div class="name"><a href="${c.scryfall}" target="_blank" rel="noopener">${esc(c.name)}</a></div>
        <div class="meta">${esc(c.type)} · ${esc(c.set)} #${esc(c.number)}${c.price ? ' · $' + c.price : ''}</div>
      </div>
      <div class="qty"><button data-d="-1">−</button><span>${c.qty}</span><button data-d="1">+</button></div>
      <button class="del" title="Remove">×</button>`;
    li.querySelectorAll('.qty button').forEach(b => b.onclick = async () => {
      const qty = c.qty + Number(b.dataset.d);
      if (qty <= 0) await dbDelete(c.id); else await dbPut({ ...c, qty });
      updateCount(); renderCollection();
    });
    li.querySelector('.del').onclick = async () => { await dbDelete(c.id); updateCount(); renderCollection(); };
    ul.appendChild(li);
  }
}
const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

$('search').oninput = renderCollection;

$('btn-export').onclick = async () => {
  const blob = new Blob([JSON.stringify(await dbAll(), null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'mtg-collection.json' });
  a.click();
  URL.revokeObjectURL(a.href);
};
$('import-file').onchange = async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const cards = JSON.parse(await file.text());
    for (const c of cards) {
      if (!c.id || !c.name) continue;
      const ex = await dbGet(c.id);
      await dbPut(ex ? { ...ex, qty: ex.qty + (c.qty || 1) } : { ...c, qty: c.qty || 1 });
    }
    updateCount(); renderCollection();
  } catch (err) { alert('Import failed: ' + err.message); }
  e.target.value = '';
};
$('btn-clear').onclick = async () => {
  if (confirm('Delete your entire collection? This cannot be undone.')) { await dbClear(); updateCount(); renderCollection(); }
};


// ---------- QR share / transfer ----------
// Collection → compact string "set/number/qty;…" → deflate → base64 →
// one or more QR codes (multi-part header MTGQR|<enc>|<part>|<total>|<data>).
// The receiving device scans them with its camera and rehydrates each
// printing from Scryfall by set + collector number.
const QR_CHUNK = 1200;   // base64 chars per QR — conservative for easy scanning
let qrParts = [], qrIndex = 0;

const b64encode = bytes => btoa(String.fromCharCode(...bytes));
const b64decode = str => Uint8Array.from(atob(str), ch => ch.charCodeAt(0));

async function deflateText(text) {
  if (!('CompressionStream' in window)) return { enc: 'r', data: new TextEncoder().encode(text) };
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return { enc: 'z', data: new Uint8Array(await new Response(stream).arrayBuffer()) };
}
async function inflateText(enc, bytes) {
  if (enc === 'r') return new TextDecoder().decode(bytes);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

$('btn-share').onclick = async () => {
  const all = await dbAll();
  if (!all.length) { alert('Collection is empty — nothing to share.'); return; }
  const compact = all.map(c => `${c.set.toLowerCase()}/${c.number}/${c.qty}`).join(';');
  const { enc, data } = await deflateText(compact);
  const b64 = b64encode(data);
  const chunks = [];
  for (let i = 0; i < b64.length; i += QR_CHUNK) chunks.push(b64.slice(i, i + QR_CHUNK));
  qrParts = chunks.map((chunk, i) => `MTGQR|${enc}|${i + 1}|${chunks.length}|${chunk}`);
  qrIndex = 0;
  renderQR();
  $('qr-modal').hidden = false;
};

function renderQR() {
  const qr = qrcode(0, 'M');
  qr.addData(qrParts[qrIndex], 'Byte');
  qr.make();
  $('qr-holder').innerHTML = qr.createSvgTag({ scalable: true, margin: 2 });
  $('qr-part').textContent = qrParts.length > 1
    ? `Part ${qrIndex + 1} of ${qrParts.length} — show each part to the scanner`
    : 'Single code — contains the whole collection';
  $('qr-prev').disabled = qrIndex === 0;
  $('qr-next').disabled = qrIndex === qrParts.length - 1;
}
$('qr-prev').onclick = () => { if (qrIndex > 0) { qrIndex--; renderQR(); } };
$('qr-next').onclick = () => { if (qrIndex < qrParts.length - 1) { qrIndex++; renderQR(); } };
$('qr-close').onclick = () => { $('qr-modal').hidden = true; };

// ---- Receiving side ----
$('btn-scanqr').onclick = async () => {
  if (qrMode) { stopQRScan('QR scan cancelled.'); return; }
  showView('scan');
  if (!stream) await startCamera();
  if (!stream) return;
  qrMode = true;
  qrGot = { enc: null, total: null, parts: new Map() };
  $('btn-scanqr').textContent = 'Cancel QR';
  setStatus('Point the camera at the QR code…');
  qrLoop();
};
function stopQRScan(msg) {
  qrMode = false;
  clearTimeout(qrTimer);
  $('btn-scanqr').textContent = 'Scan QR';
  if (msg) setStatus(msg);
}

function qrLoop() {
  if (!qrMode || !stream) return;
  try {
    if (video.readyState >= 2) {
      const w = Math.min(1024, video.videoWidth);
      const h = Math.round(video.videoHeight * (w / video.videoWidth));
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, w, h);
      const hit = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
      if (hit && hit.data) handleQRPayload(hit.data);
    }
  } catch (e) { console.warn('qr pass failed', e); }
  if (qrMode) qrTimer = setTimeout(qrLoop, 200);
}

async function handleQRPayload(text) {
  const m = /^MTGQR\|([zr])\|(\d+)\|(\d+)\|([A-Za-z0-9+/=]+)$/.exec(text);
  if (!m) return;                       // not one of ours
  const [, enc, part, total, data] = m;
  qrGot.enc = enc; qrGot.total = Number(total);
  if (!qrGot.parts.has(Number(part))) {
    qrGot.parts.set(Number(part), data);
    setStatus(`Got part ${part} of ${total} (${qrGot.parts.size}/${total} collected)…`);
  }
  if (qrGot.parts.size < qrGot.total) return;

  // All parts in — decode and import
  stopQRScan();
  stopCamera();
  try {
    const b64 = Array.from({ length: qrGot.total }, (_, i) => qrGot.parts.get(i + 1)).join('');
    const compact = await inflateText(qrGot.enc, b64decode(b64));
    const entries = compact.split(';').filter(Boolean).map(e => {
      const [set, number, qty] = e.split('/');
      return { set, number, qty: Math.max(1, parseInt(qty, 10) || 1) };
    });
    await importEntries(entries);
  } catch (e) {
    setStatus('QR import failed: ' + e.message);
  }
}

async function importEntries(entries) {
  let done = 0, failed = [];
  for (const e of entries) {
    setStatus(`Importing ${++done}/${entries.length} — ${e.set.toUpperCase()} #${e.number}…`);
    let card = null;
    for (let attempt = 0; attempt < 3 && !card; attempt++) {
      card = await cached(`p:${e.set}/${e.number}`, () => lookupPrinting(e.set, e.number));
      if (card) break;
      if (sfLastError === '429') {                      // wait out the penalty, then retry
        while (sfCooldownSecs() > 0) {
          setStatus(`Rate limited — import resumes in ${sfCooldownSecs()}s (${done - 1}/${entries.length} done)…`);
          await new Promise(r => setTimeout(r, 1000));
        }
      } else if (sfLastError === 'network') {
        setStatus('Network error — retrying…');
        await new Promise(r => setTimeout(r, 2000));
      } else break;                                     // genuine 404 — don't retry
    }
    if (!card) { failed.push(`${e.set.toUpperCase()} #${e.number}`); continue; }
    const c = summarize(card);
    const existing = await dbGet(c.id);
    await dbPut(existing
      ? { ...existing, qty: existing.qty + e.qty }
      : { ...c, qty: e.qty, added: new Date().toISOString() });
    await new Promise(r => setTimeout(r, 110));   // stay under Scryfall rate limits
  }
  updateCount();
  showView('collection');
  setStatus('');
  alert(`Imported ${done - failed.length} of ${entries.length} cards.` + (failed.length ? `\nNot found: ${failed.join(', ')}` : ''));
}

// ---------- Init ----------
(async () => {
  db = await openDB();
  updateCount();
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('sw.js'); }
    catch (e) { console.warn('SW registration failed', e); }
  }
})();
