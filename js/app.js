import * as db from './db.js';
import * as G from './gemini.js';
import * as I from './img.js';
import * as P from './prompts.js';

/* ---------------- tiny helpers ---------------- */
const $app = document.getElementById('app');
const state = { settings: null, jobs: new Map(), progress: { total: 0, done: 0 } };

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

const urls = new Map();
function urlFor(rec) {
  if (!rec?.blob) return '';
  // A record's image never changes, so one URL per record id is safe to reuse.
  const hit = urls.get(rec.id);
  if (hit) return hit;
  const url = URL.createObjectURL(rec.blob);
  urls.set(rec.id, url);
  return url;
}

function toast(msg, type = '') {
  const t = h('div', { class: `toast ${type}` }, msg);
  document.body.append(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, type === 'error' ? 6000 : 2800);
}

function modal(content, { onClose } = {}) {
  const back = h('div', { class: 'modal-back' });
  const box = h('div', { class: 'modal' }, content);
  back.append(box);
  const close = () => { back.remove(); onClose?.(); };
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  document.body.append(back);
  return { close, box };
}

function ask(title, { value = '', placeholder = '', ok = 'Save' } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { class: 'input', value, placeholder });
    let done = false;
    const m = modal(h('div', {},
      h('h3', {}, title), input,
      h('div', { class: 'row end' },
        h('button', { class: 'btn ghost', onclick: () => { done = true; m.close(); resolve(null); } }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => { done = true; m.close(); resolve(input.value.trim()); } }, ok))),
    { onClose: () => { if (!done) resolve(null); } });
    setTimeout(() => input.focus(), 50);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { done = true; m.close(); resolve(input.value.trim()); } });
  });
}

function confirmBox(title, text, ok = 'OK', danger = false) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal(h('div', {},
      h('h3', {}, title), text ? h('p', { class: 'muted' }, text) : null,
      h('div', { class: 'row end' },
        h('button', { class: 'btn ghost', onclick: () => { done = true; m.close(); resolve(false); } }, 'Cancel'),
        h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => { done = true; m.close(); resolve(true); } }, ok))),
    { onClose: () => { if (!done) resolve(false); } });
  });
}

function pickFiles({ multiple = true } = {}) {
  return new Promise((resolve) => {
    const inp = h('input', { type: 'file', accept: 'image/*', multiple: multiple || null, style: 'display:none' });
    inp.addEventListener('change', () => { resolve([...inp.files]); inp.remove(); });
    document.body.append(inp);
    inp.click();
  });
}

const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const b64part = async (blob) => ({ inline_data: { mime_type: blob.type || 'image/jpeg', data: await I.blobToB64(blob) } });

/* ---------------- job queue (parallel generation) ---------------- */
const queue = [];
let running = 0;
function enqueue(task) {
  return new Promise((resolve, reject) => { queue.push({ task, resolve, reject }); pump(); });
}
function pump() {
  const lim = Math.max(1, Number(state.settings?.concurrency) || 2);
  while (running < lim && queue.length) {
    const { task, resolve, reject } = queue.shift();
    running++;
    task().then(resolve, reject).finally(() => { running--; pump(); });
  }
}

function setJob(photoId, status, error) {
  if (status) state.jobs.set(photoId, { status, error }); else state.jobs.delete(photoId);
  refreshTile(photoId);
}
function progress(deltaTotal = 0, deltaDone = 0) {
  state.progress.total += deltaTotal;
  state.progress.done += deltaDone;
  if (state.progress.done >= state.progress.total) state.progress = { total: 0, done: 0 };
  const bar = document.getElementById('progress');
  if (!bar) return;
  const { total, done } = state.progress;
  bar.hidden = !total;
  if (total) {
    bar.querySelector('span').textContent = `Generating ${done}/${total}… keep the app open`;
    bar.querySelector('i').style.width = `${Math.round((done / total) * 100)}%`;
  }
}

/* ---------------- AI operations ---------------- */
const S = () => state.settings;

async function textCall(parts, json = true) {
  const r = await G.generate({ apiKey: S().apiKey, model: S().textModel, parts, json });
  return json ? G.parseJSON(r.text) : r.text.trim();
}

async function imageCall(parts, aspectRatio) {
  const r = await G.generate({ apiKey: S().apiKey, model: S().imageModel, parts, image: true, aspectRatio });
  const raw = I.b64ToBlob(r.images[0].data, r.images[0].mimeType);
  const { blob } = await I.normalize(raw, 4096, 0.93);
  return blob;
}

async function ensureAnalysis(photo) {
  if (photo.analysis) return photo.analysis;
  try {
    const small = (await I.normalize(photo.blob, 1024, 0.85)).blob;
    photo.analysis = await textCall([await b64part(small), { text: P.analyze }]);
    await db.put('photos', photo);
  } catch (e) {
    console.warn('analysis failed', e);
    photo.analysis = null;
  }
  return photo.analysis;
}

async function currentImage(photo) {
  if (photo.currentResultId) {
    const r = await db.get('results', photo.currentResultId);
    if (r) return r;
  }
  return photo;
}

// Decide which photos a "rule" (edit prompt) should apply to. Returns {photoId: {apply, reason}}
async function decideFor(text, photos) {
  const parts = [];
  let n = 0;
  for (const p of photos) {
    n++;
    const img = await currentImage(p);
    const small = (await I.normalize(img.blob, 512, 0.8)).blob;
    const a = p.analysis || {};
    parts.push({ text: `PHOTO ${n} — shot: ${a.shot_type || '?'}, room for props: ${a.room_for_props ?? '?'}` });
    parts.push(await b64part(small));
  }
  parts.push({ text: P.decide(text, photos.length) });
  const out = {};
  try {
    const res = await textCall(parts);
    for (const d of res.decisions || []) {
      const p = photos[(Number(d.n) || 0) - 1];
      if (p) out[p.id] = { apply: !!d.apply, reason: d.reason || '' };
    }
  } catch (e) {
    toast('Could not auto-decide, defaulting to photos with free space. ' + e.message, 'error');
  }
  for (const p of photos) {
    if (!out[p.id]) {
      const st = p.analysis?.shot_type;
      out[p.id] = { apply: !(st === 'closeup_detail' || st === 'label_or_tag') && p.analysis?.room_for_props !== false, reason: 'default' };
    }
  }
  return out;
}

async function ensureRuleDecisions(project, photos) {
  let changed = false;
  for (const rule of project.rules || []) {
    if (rule.active === false) continue;
    rule.decisions ||= {};
    const missing = photos.filter((p) => !(p.id in rule.decisions));
    if (!missing.length) continue;
    const d = await decideFor(rule.text, missing);
    for (const [id, v] of Object.entries(d)) rule.decisions[id] = v.apply;
    changed = true;
  }
  if (changed) await db.put('projects', project);
}

async function generatePhoto(projectId, photoId, { variation = 0, kind = 'background' } = {}) {
  setJob(photoId, 'queued');
  progress(1, 0);
  try {
    await enqueue(async () => {
      setJob(photoId, 'working');
      const project = await db.get('projects', projectId);
      const photo = await db.get('photos', photoId);
      if (!project || !photo) return;
      const bg = await db.get('backgrounds', project.backgroundId);
      if (!bg) throw new Error('Pick a background first.');
      const analysis = await ensureAnalysis(photo);
      const rules = (project.rules || []).filter((r) => r.active !== false && r.decisions?.[photo.id]);
      const prompt = P.replaceBg({ analysis, hasRef: !!bg.blob, bgDescription: bg.description, rules, variation });
      const parts = [{ text: 'IMAGE 1 (original product photo):' }, await b64part(photo.blob)];
      if (bg.blob) parts.push({ text: 'IMAGE 2 (background reference scene):' }, await b64part(bg.blob));
      parts.push({ text: prompt });
      const blob = await imageCall(parts, I.nearestAspect(photo.w, photo.h));
      const result = { id: db.uid(), projectId, photoId, blob, createdAt: Date.now(), kind, backgroundId: bg.id, prompt: variation ? `Variation #${variation}` : bg.name };
      await db.put('results', result);
      const fresh = await db.get('photos', photoId);
      fresh.currentResultId = result.id;
      await db.put('photos', fresh);
      project.updatedAt = Date.now();
      await db.put('projects', project);
    });
    setJob(photoId, null);
  } catch (e) {
    console.error(e);
    setJob(photoId, 'error', e.message);
    toast(e.message, 'error');
  } finally {
    progress(0, 1);
  }
}

async function generateAll(projectId, opts = {}) {
  const project = await db.get('projects', projectId);
  if (!project.backgroundId) return toast('Pick or create a background first.', 'error');
  let photos = await db.byIndex('photos', 'projectId', projectId);
  if (opts.onlyIds) photos = photos.filter((p) => opts.onlyIds.includes(p.id));
  if (!photos.length) return toast('Add some photos first.', 'error');
  if (!S().apiKey) return needKey();
  // analyse first so rules can be decided for new photos
  await Promise.all(photos.map((p) => ensureAnalysis(p)));
  await ensureRuleDecisions(project, photos);
  await Promise.all(photos.map((p) => generatePhoto(projectId, p.id, opts)));
  if (currentRoute().name === 'project') refreshProjectCover();
}

async function editPhoto(projectId, photoId, request) {
  setJob(photoId, 'queued');
  progress(1, 0);
  try {
    await enqueue(async () => {
      setJob(photoId, 'working');
      const photo = await db.get('photos', photoId);
      const src = await currentImage(photo);
      const blob = await imageCall([await b64part(src.blob), { text: P.edit(request) }], I.nearestAspect(photo.w, photo.h));
      const result = { id: db.uid(), projectId, photoId, blob, createdAt: Date.now(), kind: 'edit', prompt: request };
      await db.put('results', result);
      const fresh = await db.get('photos', photoId);
      fresh.currentResultId = result.id;
      await db.put('photos', fresh);
    });
    setJob(photoId, null);
  } catch (e) {
    setJob(photoId, 'error', e.message);
    toast(e.message, 'error');
  } finally {
    progress(0, 1);
  }
}

async function createBackgroundFromText(description, angle, aspect, name) {
  const blob = await imageCall([{ text: P.backdrop(description, angle) }], aspect);
  const bg = { id: db.uid(), name: name || description.slice(0, 40), description, blob, source: 'ai', createdAt: Date.now() };
  await db.put('backgrounds', bg);
  return bg;
}

async function setProjectBackground(projectId, bgId, regenerate = true) {
  const project = await db.get('projects', projectId);
  project.backgroundId = bgId;
  project.updatedAt = Date.now();
  await db.put('projects', project);
  render();
  if (regenerate) generateAll(projectId);
}

function needKey() {
  toast('Add your Gemini API key in Settings first.', 'error');
  location.hash = '#/settings';
}

/* ---------------- sharing / saving ---------------- */
async function shareBlobs(items) {
  const files = items.map(({ blob, name }) => new File([blob], name, { type: blob.type || 'image/jpeg' }));
  if (navigator.canShare && navigator.canShare({ files })) {
    try { await navigator.share({ files }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  for (const f of files) {
    const a = h('a', { href: URL.createObjectURL(f), download: f.name });
    document.body.append(a); a.click(); a.remove();
    await new Promise((r) => setTimeout(r, 300));
  }
}

/* ---------------- router ---------------- */
function currentRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  if (parts[0] === 'project' && parts[1]) return { name: 'project', id: parts[1] };
  if (parts[0] === 'settings') return { name: 'settings' };
  return { name: 'home' };
}

async function render() {
  const r = currentRoute();
  let view;
  if (r.name === 'project') view = await renderProject(r.id);
  else if (r.name === 'settings') view = await renderSettings();
  else view = await renderHome();
  $app.replaceChildren(view);
  progress();
}
window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); });

/* ---------------- views: home ---------------- */
async function renderHome() {
  const projects = (await db.all('projects')).sort((a, b) => b.updatedAt - a.updatedAt);
  const list = h('div', { class: 'projects' });
  for (const p of projects) {
    const photos = await db.byIndex('photos', 'projectId', p.id);
    const first = photos.sort((a, b) => a.order - b.order)[0];
    const cover = first ? await currentImage(first) : null;
    list.append(h('a', { class: 'project-card', href: `#/project/${p.id}` },
      h('div', { class: 'cover' }, cover ? h('img', { src: urlFor(cover), alt: '' }) : h('span', { class: 'muted' }, 'No photos')),
      h('div', { class: 'meta' }, h('b', {}, p.name), h('small', { class: 'muted' }, `${photos.length} photo${photos.length === 1 ? '' : 's'} · ${fmtDate(p.updatedAt)}`))));
  }
  return h('div', { class: 'page' },
    h('header', { class: 'top' }, h('h1', {}, 'BG Studio'), h('a', { class: 'icon-btn', href: '#/settings', 'aria-label': 'Settings' }, '⚙︎')),
    !S().apiKey ? h('a', { class: 'banner', href: '#/settings' }, 'Add your Gemini API key to start →') : null,
    h('button', { class: 'btn primary block', onclick: newProject }, '+ New project'),
    projects.length ? list : h('p', { class: 'empty muted' }, 'No projects yet. Create one per product, add its photos, pick a background — done.'));
}

async function newProject() {
  const name = await ask('New project', { placeholder: 'e.g. Black Nike hoodie', ok: 'Create' });
  if (!name) return;
  const p = { id: db.uid(), name, createdAt: Date.now(), updatedAt: Date.now(), backgroundId: null, rules: [], variationCount: 0 };
  await db.put('projects', p);
  location.hash = `#/project/${p.id}`;
}

/* ---------------- views: project ---------------- */
async function renderProject(id) {
  const project = await db.get('projects', id);
  if (!project) { location.hash = '#/'; return h('div'); }
  const photos = (await db.byIndex('photos', 'projectId', id)).sort((a, b) => a.order - b.order);
  const bg = await db.get('backgrounds', project.backgroundId);

  // --- background card
  const bgCard = h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Background')),
    h('div', { class: 'bg-current' },
      bg ? h('img', { src: urlFor(bg) || '', alt: '' }) : h('div', { class: 'bg-empty muted' }, 'None yet'),
      h('div', {}, h('b', {}, bg ? bg.name : 'Pick one below'), bg?.description ? h('p', { class: 'muted small' }, bg.description) : null)),
    h('div', { class: 'row wrap' },
      h('button', { class: 'btn', onclick: () => suggestFlow(id) }, '✨ Suggest'),
      h('button', { class: 'btn', onclick: () => uploadBgFlow(id) }, '⬆︎ Upload my own'),
      h('button', { class: 'btn', onclick: () => libraryFlow(id) }, '📚 Saved')));

  // --- prompt box
  let mode = 'edit';
  const ta = h('textarea', { class: 'input', rows: 2, placeholder: '' });
  const setMode = (m) => {
    mode = m;
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.m === m));
    ta.placeholder = m === 'bg' ? 'e.g. light oak wooden floor, soft morning window light' : 'e.g. add a small green plant in the corner';
  };
  const seg = h('div', { class: 'seg' },
    h('button', { 'data-m': 'edit', onclick: () => setMode('edit') }, 'Add / edit'),
    h('button', { 'data-m': 'bg', onclick: () => setMode('bg') }, 'New background'));
  setMode('edit');
  const go = async (btn) => {
    const text = ta.value.trim();
    if (!text) return;
    if (!S().apiKey) return needKey();
    btn.disabled = true; btn.textContent = 'Working…';
    try {
      if (mode === 'bg') await promptBackground(id, text);
      else await promptEdit(id, text);
      ta.value = '';
    } catch (e) { toast(e.message, 'error'); }
    btn.disabled = false; btn.textContent = 'Go';
  };
  const goBtn = h('button', { class: 'btn primary', onclick: (e) => go(e.currentTarget) }, 'Go');
  const promptCard = h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'One prompt → all photos')), seg, ta, h('div', { class: 'row end' }, goBtn));

  // --- actions
  const actions = h('div', { class: 'actions' },
    h('button', { class: 'btn primary', onclick: () => addPhotos(id) }, '+ Add photos'),
    h('button', { class: 'btn', onclick: () => generateAll(id) }, '↻ Regenerate all'),
    h('button', { class: 'btn', onclick: () => variationFlow(id) }, '🎲 New variation set'),
    h('button', { class: 'btn', onclick: () => saveAll(id) }, '⤓ Save all'));

  // --- grid
  const grid = h('div', { class: 'grid', id: 'grid' });
  for (const p of photos) grid.append(await renderTile(p));

  // --- memory
  const rules = project.rules || [];
  const memory = h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Project memory'), h('small', { class: 'muted' }, 'Re-applied every time you regenerate')),
    rules.length ? h('ul', { class: 'rules' }, rules.map((r) => h('li', {},
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: r.active !== false, onchange: async (e) => { r.active = e.target.checked; await db.put('projects', project); } }), h('span')),
      h('div', { class: 'grow' }, r.text, h('small', { class: 'muted' }, ` · ${Object.values(r.decisions || {}).filter(Boolean).length} photos`)),
      h('button', { class: 'icon-btn small', onclick: async () => { project.rules = rules.filter((x) => x !== r); await db.put('projects', project); render(); } }, '✕'))))
      : h('p', { class: 'muted small' }, 'Edits you make with "Add / edit" (with "Remember" on) show up here.'));

  return h('div', { class: 'page' },
    h('header', { class: 'top' },
      h('a', { class: 'icon-btn', href: '#/' }, '‹'),
      h('h1', { class: 'title', onclick: async () => { const n = await ask('Rename project', { value: project.name }); if (n) { project.name = n; await db.put('projects', project); render(); } } }, project.name),
      h('button', { class: 'icon-btn', onclick: async () => { if (await confirmBox('Delete project?', 'All photos and results in it will be deleted.', 'Delete', true)) { await db.deleteProject(id); location.hash = '#/'; } } }, '🗑')),
    h('div', { id: 'progress', class: 'progress', hidden: true }, h('span'), h('div', { class: 'track' }, h('i'))),
    bgCard, promptCard, actions,
    photos.length ? grid : h('div', { class: 'drop muted', onclick: () => addPhotos(id) }, 'Tap to add product photos'),
    memory);
}

async function renderTile(photo) {
  const img = await currentImage(photo);
  const job = state.jobs.get(photo.id);
  return h('div', { class: 'tile', 'data-photo': photo.id, onclick: () => photoDetail(photo.id) },
    h('img', { src: urlFor(img), alt: '' }),
    !photo.currentResultId ? h('span', { class: 'badge' }, 'Original') : null,
    job?.status === 'queued' ? h('div', { class: 'overlay' }, h('span', {}, 'Queued')) : null,
    job?.status === 'working' ? h('div', { class: 'overlay' }, h('div', { class: 'spinner' })) : null,
    job?.status === 'error' ? h('span', { class: 'badge error', title: job.error }, '⚠︎ Failed — tap') : null);
}

async function refreshTile(photoId) {
  const old = document.querySelector(`[data-photo="${photoId}"]`);
  if (!old) return;
  const photo = await db.get('photos', photoId);
  if (!photo) return old.remove();
  old.replaceWith(await renderTile(photo));
}
function refreshProjectCover() { /* home covers re-render on navigation */ }

async function addPhotos(projectId) {
  const files = await pickFiles();
  if (!files.length) return;
  const existing = await db.byIndex('photos', 'projectId', projectId);
  let order = existing.length;
  const ids = [];
  for (const f of files) {
    try {
      const { blob, w, h: hh } = await I.normalize(f, S().maxSide || 2048);
      const p = { id: db.uid(), projectId, order: order++, blob, w, h: hh, analysis: null, currentResultId: null, createdAt: Date.now() };
      await db.put('photos', p);
      ids.push(p.id);
    } catch (e) { toast(e.message, 'error'); }
  }
  const project = await db.get('projects', projectId);
  project.updatedAt = Date.now();
  await db.put('projects', project);
  await render();
  if (!S().apiKey) return;
  if (project.backgroundId) generateAll(projectId, { onlyIds: ids });
  else {
    toast(`${ids.length} photo(s) added. Now pick a background.`);
    for (const id of ids) db.get('photos', id).then(ensureAnalysis); // analyse in background
  }
}

async function saveAll(projectId) {
  const photos = (await db.byIndex('photos', 'projectId', projectId)).sort((a, b) => a.order - b.order);
  const project = await db.get('projects', projectId);
  const items = [];
  for (const [i, p] of photos.entries()) {
    const img = await currentImage(p);
    items.push({ blob: img.blob, name: `${project.name.replace(/[^\w-]+/g, '_')}_${i + 1}.jpg` });
  }
  if (!items.length) return toast('No photos yet.');
  await shareBlobs(items);
}

async function variationFlow(projectId) {
  const project = await db.get('projects', projectId);
  if (!project.backgroundId) return toast('Pick a background first.', 'error');
  project.variationCount = (project.variationCount || 0) + 1;
  await db.put('projects', project);
  toast(`Making variation set #${project.variationCount}. Old versions stay saved in each photo.`);
  generateAll(projectId, { variation: project.variationCount, kind: 'variation' });
}

async function firstPhotoInfo(projectId) {
  const photos = (await db.byIndex('photos', 'projectId', projectId)).sort((a, b) => a.order - b.order);
  const main = photos.find((p) => !['closeup_detail', 'label_or_tag'].includes(p.analysis?.shot_type)) || photos[0];
  if (main) await ensureAnalysis(main);
  return { photos, main, angle: main?.analysis?.camera_angle || 'top_down', aspect: main ? I.nearestAspect(main.w, main.h) : '4:5' };
}

async function promptBackground(projectId, text) {
  const { angle, aspect } = await firstPhotoInfo(projectId);
  toast('Creating the new background…');
  const bg = await createBackgroundFromText(text, angle, aspect);
  await setProjectBackground(projectId, bg.id, true);
}

async function promptEdit(projectId, text) {
  const project = await db.get('projects', projectId);
  const photos = (await db.byIndex('photos', 'projectId', projectId)).sort((a, b) => a.order - b.order);
  if (!photos.length) return toast('Add photos first.', 'error');
  toast('Checking which photos this fits…');
  await Promise.all(photos.map(ensureAnalysis));
  const decisions = await decideFor(text, photos);

  const checks = new Map();
  const remember = h('input', { type: 'checkbox', checked: true });
  const list = h('div', { class: 'pick-list' });
  for (const p of photos) {
    const img = await currentImage(p);
    const cb = h('input', { type: 'checkbox', checked: decisions[p.id].apply });
    checks.set(p.id, cb);
    list.append(h('label', { class: 'pick' }, cb, h('img', { src: urlFor(img), alt: '' }), h('small', { class: 'muted' }, decisions[p.id].reason)));
  }
  const m = modal(h('div', {},
    h('h3', {}, 'Apply to these photos?'),
    h('p', { class: 'muted small' }, `"${text}" — AI picked where it fits. Change if you want.`),
    list,
    h('label', { class: 'row' }, remember, h('span', {}, 'Remember in project (re-apply on every regenerate)')),
    h('div', { class: 'row end' },
      h('button', { class: 'btn ghost', onclick: () => m.close() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: async () => {
        m.close();
        const chosen = photos.filter((p) => checks.get(p.id).checked);
        if (remember.checked) {
          const d = {};
          for (const p of photos) d[p.id] = checks.get(p.id).checked;
          project.rules = [...(project.rules || []), { id: db.uid(), text, decisions: d, active: true, createdAt: Date.now() }];
          await db.put('projects', project);
          render();
        }
        await Promise.all(chosen.map((p) => editPhoto(projectId, p.id, text)));
      } }, 'Apply'))));
}

async function suggestFlow(projectId) {
  if (!S().apiKey) return needKey();
  const { photos, main, angle, aspect } = await firstPhotoInfo(projectId).catch((e) => { toast(e.message, 'error'); return {}; });
  if (!photos?.length) return toast('Add at least one product photo first, so ideas match the product.', 'error');
  const body = h('div', { class: 'ideas' }, h('p', { class: 'muted' }, 'Thinking of backgrounds that fit your product…'));
  const custom = h('input', { class: 'input', placeholder: 'Or describe your own…' });
  const m = modal(h('div', {}, h('h3', {}, 'Pick a background'), body,
    h('div', { class: 'row' }, custom, h('button', { class: 'btn', onclick: async () => {
      const t = custom.value.trim(); if (!t) return; m.close();
      try { await promptBackground(projectId, t); } catch (e) { toast(e.message, 'error'); }
    } }, 'Make'))));
  try {
    const refs = [];
    for (const p of photos.slice(0, 2)) refs.push(await b64part((await I.normalize(p.blob, 1024, 0.85)).blob));
    const { ideas = [] } = await textCall([...refs, { text: P.suggest(angle) }]);
    body.replaceChildren();
    for (const idea of ideas.slice(0, 4)) {
      const cell = h('div', { class: 'idea loading' }, h('div', { class: 'thumb' }, h('div', { class: 'spinner' })), h('b', {}, idea.name), h('small', { class: 'muted' }, idea.description));
      body.append(cell);
      enqueue(() => createBackgroundFromText(idea.description, angle, aspect, idea.name)).then((bg) => {
        cell.classList.remove('loading');
        cell.querySelector('.thumb').replaceChildren(h('img', { src: urlFor(bg), alt: '' }));
        cell.addEventListener('click', () => { m.close(); setProjectBackground(projectId, bg.id); });
      }).catch((e) => {
        cell.querySelector('.thumb').replaceChildren(h('span', { class: 'small' }, '⚠︎ ' + e.message.slice(0, 80)));
      });
    }
  } catch (e) {
    body.replaceChildren(h('p', { class: 'error-text' }, e.message));
  }
}

async function uploadBgFlow(projectId) {
  const [file] = await pickFiles({ multiple: false });
  if (!file) return;
  const { blob } = await I.normalize(file, 2048, 0.92);
  const name = (await ask('Name this background', { value: 'My background' })) || 'My background';
  const bg = { id: db.uid(), name, description: '', blob, source: 'upload', createdAt: Date.now() };
  // Describe it so prompts work better (also helps close-ups).
  if (S().apiKey) {
    try { bg.description = await textCall([await b64part((await I.normalize(blob, 768, 0.85)).blob), { text: P.describeBg }], false); } catch {}
  }
  await db.put('backgrounds', bg);
  await setProjectBackground(projectId, bg.id);
}

async function libraryFlow(projectId) {
  const bgs = (await db.all('backgrounds')).sort((a, b) => b.createdAt - a.createdAt);
  const grid = h('div', { class: 'ideas' });
  const m = modal(h('div', {}, h('h3', {}, 'Saved backgrounds'), bgs.length ? grid : h('p', { class: 'muted' }, 'Nothing saved yet. Backgrounds you suggest or upload are saved here for reuse in any project.')));
  for (const bg of bgs) {
    grid.append(h('div', { class: 'idea' },
      h('div', { class: 'thumb', onclick: () => { m.close(); setProjectBackground(projectId, bg.id); } }, bg.blob ? h('img', { src: urlFor(bg), alt: '' }) : null),
      h('div', { class: 'row between' }, h('b', {}, bg.name),
        h('button', { class: 'icon-btn small', onclick: async (e) => { e.stopPropagation(); if (await confirmBox('Delete background?', '', 'Delete', true)) { await db.del('backgrounds', bg.id); e.target.closest('.idea').remove(); } } }, '✕'))));
  }
}

async function photoDetail(photoId) {
  const photo = await db.get('photos', photoId);
  if (!photo) return;
  const job = state.jobs.get(photoId);
  const results = (await db.byIndex('results', 'photoId', photoId)).sort((a, b) => b.createdAt - a.createdAt);
  let shown = (await currentImage(photo));
  const big = h('img', { class: 'big', src: urlFor(shown), alt: '' });
  const strip = h('div', { class: 'strip' });
  const select = async (rec) => {
    shown = rec;
    big.src = urlFor(rec);
    strip.querySelectorAll('img').forEach((i) => i.classList.toggle('on', i.dataset.id === rec.id));
  };
  for (const rec of [...results, photo]) {
    strip.append(h('img', { src: urlFor(rec), 'data-id': rec.id, class: rec.id === shown.id ? 'on' : '', onclick: () => select(rec) }));
  }
  const m = modal(h('div', {},
    job?.status === 'error' ? h('p', { class: 'error-text small' }, job.error) : null,
    big,
    h('p', { class: 'muted small' }, 'Versions (newest first, last = original). Tap one, then "Use this".'),
    strip,
    h('div', { class: 'row wrap' },
      h('button', { class: 'btn primary', onclick: async () => {
        const fresh = await db.get('photos', photoId);
        fresh.currentResultId = shown.id === photo.id ? null : shown.id;
        await db.put('photos', fresh); refreshTile(photoId); m.close();
      } }, 'Use this'),
      h('button', { class: 'btn', onclick: () => shareBlobs([{ blob: shown.blob, name: `photo_${photoId}.jpg` }]) }, '⤓ Save'),
      h('button', { class: 'btn', onclick: () => { m.close(); generatePhoto(photo.projectId, photoId); } }, '↻ Redo'),
      h('button', { class: 'btn', onclick: async () => {
        const t = await ask('Edit just this photo', { placeholder: 'e.g. make the shadow softer', ok: 'Edit' });
        if (t) { m.close(); editPhoto(photo.projectId, photoId, t); }
      } }, '✎ Edit'),
      shown.id !== photo.id ? h('button', { class: 'btn ghost', onclick: async () => {
        await db.del('results', shown.id);
        const fresh = await db.get('photos', photoId);
        if (fresh.currentResultId === shown.id) { fresh.currentResultId = results.find((r) => r.id !== shown.id)?.id || null; await db.put('photos', fresh); }
        m.close(); refreshTile(photoId);
      } }, 'Delete version') : null,
      h('button', { class: 'btn danger', onclick: async () => {
        if (!(await confirmBox('Delete this photo?', 'All its versions go too.', 'Delete', true))) return;
        await db.deletePhoto(photoId); m.close(); render();
      } }, 'Delete photo'))));
}

/* ---------------- views: settings ---------------- */
async function renderSettings() {
  const s = { ...S() };
  const key = h('input', { class: 'input', type: 'password', value: s.apiKey, placeholder: 'Paste your Gemini API key', autocomplete: 'off' });
  const imgModel = h('input', { class: 'input', value: s.imageModel, list: 'img-models' });
  const txtModel = h('input', { class: 'input', value: s.textModel, list: 'txt-models' });
  const conc = h('input', { class: 'input', type: 'number', min: 1, max: 5, value: s.concurrency });
  const imgList = h('datalist', { id: 'img-models' });
  const txtList = h('datalist', { id: 'txt-models' });
  const status = h('p', { class: 'small muted' });
  const usage = h('p', { class: 'small muted' });
  navigator.storage?.estimate?.().then((e) => { usage.textContent = `Storage used: ${(e.usage / 1e6).toFixed(1)} MB`; });

  const save = async (quiet) => {
    state.settings = { ...state.settings, apiKey: key.value.trim(), imageModel: imgModel.value.trim(), textModel: txtModel.value.trim(), concurrency: Number(conc.value) || 2 };
    await db.saveSettings(state.settings);
    if (!quiet) toast('Saved');
  };
  const test = async () => {
    await save(true);
    status.textContent = 'Checking…';
    try {
      const names = await G.listModels(key.value.trim());
      const pick = G.pickModels(names);
      imgList.replaceChildren(...pick.imageModels.map((n) => h('option', { value: n })));
      txtList.replaceChildren(...pick.textModels.map((n) => h('option', { value: n })));
      if (!names.includes(imgModel.value.trim()) && pick.image) imgModel.value = pick.image;
      if (!names.includes(txtModel.value.trim()) && pick.text) txtModel.value = pick.text;
      await save(true);
      status.textContent = `✓ Key works. Image model: ${imgModel.value} · Text model: ${txtModel.value}`;
    } catch (e) { status.textContent = '✕ ' + e.message; }
  };

  return h('div', { class: 'page' },
    h('header', { class: 'top' }, h('a', { class: 'icon-btn', href: '#/' }, '‹'), h('h1', { class: 'title' }, 'Settings'), h('span')),
    h('section', { class: 'card' },
      h('h2', {}, 'Gemini API key'),
      h('p', { class: 'small muted' }, 'Get one free at aistudio.google.com → "Get API key". Image generation needs billing turned on. The key is stored only on this phone.'),
      key,
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => save() }, 'Save'), h('button', { class: 'btn', onclick: test }, 'Test key')),
      status),
    h('section', { class: 'card' },
      h('h2', {}, 'Models'),
      h('label', { class: 'small' }, 'Image model (Nano Banana)'), imgModel, imgList,
      h('label', { class: 'small' }, 'Text model (analysis & ideas)'), txtModel, txtList,
      h('label', { class: 'small' }, 'Photos generated at the same time'), conc,
      h('button', { class: 'btn', onclick: () => save() }, 'Save')),
    h('section', { class: 'card' },
      h('h2', {}, 'Backup'),
      h('p', { class: 'small muted' }, 'Everything is saved on this phone. Export a backup now and then — if Safari data gets cleared, you can import it back.'),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn', onclick: exportBackup }, 'Export backup'),
        h('button', { class: 'btn', onclick: importBackup }, 'Import backup'),
        h('button', { class: 'btn danger', onclick: async () => {
          if (!(await confirmBox('Erase everything?', 'Deletes all projects, photos and backgrounds on this device.', 'Erase', true))) return;
          for (const n of ['projects', 'photos', 'results', 'backgrounds']) await db.clear(n);
          toast('Erased'); location.hash = '#/';
        } }, 'Erase all')),
      usage));
}

async function exportBackup() {
  toast('Preparing backup…');
  const chunks = ['{"app":"bg-studio","version":1'];
  for (const name of ['projects', 'photos', 'results', 'backgrounds']) {
    chunks.push(`,"${name}":[`);
    const rows = await db.all(name);
    for (const [i, r] of rows.entries()) {
      const o = { ...r };
      if (r.blob) { o.blob = await I.blobToB64(r.blob); o.blobType = r.blob.type; }
      chunks.push((i ? ',' : '') + JSON.stringify(o));
    }
    chunks.push(']');
  }
  chunks.push('}');
  const blob = new Blob(chunks, { type: 'application/json' });
  const name = `bg-studio-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
}

async function importBackup() {
  const inp = h('input', { type: 'file', accept: 'application/json,.json', style: 'display:none' });
  document.body.append(inp);
  inp.addEventListener('change', async () => {
    const f = inp.files[0]; inp.remove();
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data.app !== 'bg-studio') throw new Error('Not a BG Studio backup.');
      for (const name of ['projects', 'photos', 'results', 'backgrounds']) {
        for (const r of data[name] || []) {
          if (r.blob) { r.blob = I.b64ToBlob(r.blob, r.blobType || 'image/jpeg'); delete r.blobType; }
          await db.put(name, r);
        }
      }
      toast('Backup imported'); location.hash = '#/';
    } catch (e) { toast('Import failed: ' + e.message, 'error'); }
  });
  inp.click();
}

/* ---------------- boot ---------------- */
(async function boot() {
  state.settings = await db.getSettings();
  navigator.storage?.persist?.();
  await render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();

window.addEventListener('beforeunload', (e) => { if (state.progress.total) { e.preventDefault(); e.returnValue = ''; } });
