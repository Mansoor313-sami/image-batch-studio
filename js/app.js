import * as store from './store.js?v=3';
import * as runner from './runner.js?v=3';
import {
  ACTIVE, ENGINES, FLOW_MODELS, GEMINI_MODELS, POLLINATIONS_MODELS, RATIOS, csv, imageExtension, initialDraft,
  labelStatus, modelOf, parsePrompts, safeSegment, sceneName, validateDraft
} from './model.js?v=3';
import { buildZip } from './zip.js?v=3';
import { callHelper, helperState, onHelper, refreshHelper } from './bridge.js?v=3';
import { chooseFolder, ensureFolderAccess, folderSupported, forgetFolder, savedFolder } from './folder.js?v=3';

const $ = id => document.getElementById(id);
const VIEWS = ['new', 'queue', 'gallery', 'projects', 'settings'];
const QUEUE_PAGE = 40;
const GALLERY_PAGE = 48;
const fmt = value => Number(value || 0).toLocaleString();
const SAMPLES = [
  'A lighthouse on a rocky cliff at sunset, waves crashing below, cinematic wide shot',
  'A cozy wooden cabin in a snowy forest at night, warm light glowing from the windows',
  'A busy futuristic city street with flying cars and neon signs on a rainy evening',
  'An astronaut sitting on the moon watching the Earth rise, highly detailed',
  'A small fishing boat on a calm misty lake at dawn, soft pastel colors',
  'A medieval castle on a hill surrounded by autumn trees, aerial view',
  'A golden retriever puppy playing in a field of sunflowers on a bright summer day',
  'A desert caravan of camels crossing sand dunes under a starry sky',
  'An ancient library with tall bookshelves and floating candles, magical atmosphere',
  'A waterfall in a lush green jungle with colorful parrots in morning light'
];

let draft;
let keys = {};
let refs = {};
const refUrls = {};
let view = 'new';
let active = null;
let galleryId = null;
let queueFilter = '';
let queuePage = 0;
let galleryFilter = '';
let galleryPage = 0;
let zipping = false;
let draftTimer;
let keyTimer;
let renderTimer;
let wakeLock = null;
const urlSets = { queue: [], gallery: [], projects: [], preview: [] };
const viewer = { projectId: null, numbers: [], index: 0, url: null };

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child != null && child !== false) node.append(child);
  return node;
}

function objectUrl(set, blob) {
  const url = URL.createObjectURL(blob);
  urlSets[set].push(url);
  return url;
}
function releaseUrls(set) {
  for (const url of urlSets[set]) URL.revokeObjectURL(url);
  urlSets[set] = [];
}

function toast(text, error = false, keep = false) {
  const node = el('div', { class: 'toast' + (error ? ' error' : ''), text });
  $('toasts').append(node);
  if (!keep) setTimeout(() => node.remove(), error ? 7000 : 4000);
  return node;
}

async function attempt(work, success) {
  try {
    const value = await work();
    if (success) toast(success);
    return value === undefined ? true : value;
  } catch (error) {
    toast(error.message || String(error), true);
    return undefined;
  }
}

function confirmDialog(title, text, ok) {
  const dialog = $('confirm');
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  $('confirm-ok').textContent = ok;
  dialog.showModal();
  return new Promise(resolve => {
    const done = value => {
      dialog.close();
      $('confirm-ok').onclick = $('confirm-cancel').onclick = null;
      resolve(value);
    };
    $('confirm-ok').onclick = () => done(true);
    $('confirm-cancel').onclick = () => done(false);
    dialog.oncancel = () => done(false);
  });
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/* ---------- Routing ---------- */
function route() {
  const next = location.hash.slice(1);
  view = VIEWS.includes(next) ? next : 'new';
  for (const name of VIEWS) $('view-' + name).hidden = name !== view;
  for (const link of document.querySelectorAll('[data-nav]')) {
    if (link.dataset.nav === view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  document.title = `${$('view-' + view).querySelector('h1').textContent} | Image Batch Studio`;
  window.scrollTo(0, 0);
  void render();
}

/* ---------- New batch ---------- */
function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => void store.putMeta('draft', { ...draft }).catch(error => toast('The draft could not be saved. ' + error.message, true)), 250);
}

function engineStatus(engine) {
  const helper = helperState();
  if (engine === 'flow') {
    if (!helper) return ['Needs helper', 'attn'];
    return helper.flow ? ['Ready', 'ok'] : ['Open a Flow project', 'attn'];
  }
  if (engine === 'gemini') return keys.gemini ? ['Key added', 'ok'] : ['Needs API key', 'attn'];
  return keys.pollinations ? ['Key added', 'ok'] : ['Free', ''];
}

function renderEngines() {
  const box = $('engines');
  box.replaceChildren(...Object.entries(ENGINES).map(([key, engine]) => {
    const [label, tone] = engineStatus(key);
    return el('button', {
      type: 'button', class: 'engine', role: 'radio', 'aria-checked': String(draft.engine === key),
      onclick: () => { draft.engine = key; saveDraft(); renderEngines(); review(); }
    }, el('i'), el('strong', {}, engine.name, el('span', { class: 'tag ' + tone, text: label })), el('small', { text: engine.note }));
  }));
  for (const key of Object.keys(ENGINES)) $('fields-' + key).hidden = draft.engine !== key;
  $('workers-field').hidden = draft.engine === 'flow';
  let hint = '';
  if (draft.engine === 'flow') hint = 'Flow makes one image at a time in your open Flow project. Every image must cost 0 credits, or the batch pauses.';
  if (draft.engine === 'gemini' && !keys.gemini) hint = 'Add your Gemini API key in Settings to use this engine.';
  if (draft.engine === 'pollinations' && !keys.pollinations) hint = 'Without a key: one image about every 45 seconds at reduced size. Add a free key in Settings for full speed.';
  $('engine-hint').textContent = hint;
  $('engine-hint').hidden = !hint;
}

function renderRatios() {
  const box = $('ratios');
  box.querySelectorAll('button').forEach(node => node.remove());
  for (const ratio of RATIOS) {
    const [w, h] = ratio.split(':').map(Number);
    const scale = 22 / Math.max(w, h);
    box.append(el('button', {
      type: 'button', class: 'ratio', 'aria-pressed': String(draft.ratio === ratio),
      onclick: () => { draft.ratio = ratio; saveDraft(); renderRatios(); review(); }
    }, el('i', { style: `width:${Math.round(w * scale)}px;height:${Math.round(h * scale)}px` }), ratio));
  }
}

let stripTimer;
function renderStrip(prompts) {
  clearTimeout(stripTimer);
  stripTimer = setTimeout(() => {
    const digits = Math.max(3, String(prompts.at(-1)?.number ?? 1).length);
    const shown = prompts.slice(0, 30);
    const track = $('strip-track');
    track.replaceChildren(...shown.map(prompt => el('div', { class: 'frame-card' },
      el('b', { text: String(prompt.number).padStart(digits, '0') }), el('span', { text: prompt.text }))));
    if (prompts.length > shown.length) track.append(el('div', { class: 'frame-card more', text: `+${fmt(prompts.length - shown.length)} more scenes` }));
    $('strip').hidden = !prompts.length;
  }, 120);
}

function review() {
  let prompts = [];
  let warning = '';
  try { prompts = parsePrompts(draft.text); } catch (error) { warning = error.message; }
  $('prompt-count').textContent = prompts.length ? `${fmt(prompts.length)} ${prompts.length === 1 ? 'scene' : 'scenes'}` : 'No scenes yet';
  $('prompt-warning').textContent = warning;
  renderStrip(prompts);
  let summary = 'Add a script to begin.';
  let blocker = warning;
  try {
    const { settings, prompts: queued } = validateDraft(draft);
    const from = queued.length !== prompts.length ? `, starting at scene ${settings.startFrom}` : '';
    summary = `<strong>${fmt(queued.length)} ${queued.length === 1 ? 'image' : 'images'}</strong> with ${ENGINES[settings.engine].name}, ${settings.ratio}${from}`;
    $('output-hint').textContent = `Files are named ${sceneName(settings, queued[0].number)}, ${sceneName(settings, queued[1]?.number ?? queued[0].number + 1)} and so on, in scene order.`;
    if (settings.engine === 'gemini' && !keys.gemini) blocker = 'Add your Gemini API key in Settings first.';
    if (settings.engine === 'flow' && !helperState()) blocker = 'Install the Flow helper extension (see Settings) to use Google Flow.';
  } catch (error) {
    blocker ||= prompts.length ? error.message : '';
    $('output-hint').textContent = '';
  }
  if (active && (ACTIVE.has(active.status) || runner.isRunning(active.id))) blocker = `"${active.settings.name}" is still running. Pause it before starting another batch.`;
  $('launch-summary').innerHTML = '';
  if (blocker) $('launch-summary').append(el('span', { class: 'warn', text: blocker }));
  else $('launch-summary').innerHTML = summary;
  $('start').disabled = $('preview').disabled = Boolean(blocker) || !prompts.length;
}

function showRef(kind) {
  if (refUrls[kind]) URL.revokeObjectURL(refUrls[kind]);
  refUrls[kind] = refs[kind] instanceof Blob ? URL.createObjectURL(refs[kind]) : null;
  $(kind + '-thumb').hidden = $(kind + '-clear').hidden = !refUrls[kind];
  if (refUrls[kind]) $(kind + '-thumb').src = refUrls[kind];
  $(kind + '-pick').textContent = refUrls[kind] ? 'Replace image' : 'Add reference image';
}

async function setRef(kind, file) {
  await attempt(async () => {
    if (file && file.size > 8 * 1024 * 1024) throw new Error('Use a reference image under 8 MB.');
    const next = { ...refs };
    if (file) next[kind] = new Blob([await file.arrayBuffer()], { type: file.type || 'image/png' });
    else delete next[kind];
    await store.putMeta('refs', next);
    refs = next;
    showRef(kind);
  });
}

async function start(preview) {
  $('start').disabled = $('preview').disabled = true;
  const project = await attempt(async () => {
    const batch = validateDraft(draft);
    await store.putMeta('draft', { ...draft });
    if (await savedFolder() && !await ensureFolderAccess()) toast('Folder access was not given, so images are kept here for the ZIP only.', true);
    return runner.startBatch(batch, preview);
  });
  if (project) {
    galleryId = project.id;
    location.hash = '#queue';
  }
  review();
}

/* ---------- Progress and time left ---------- */
function formatDuration(ms) {
  const seconds = Math.max(0, ms / 1000);
  if (seconds < 60) return 'less than a minute';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

function estimate(project) {
  const { counts, settings } = project;
  const processed = counts.completed + counts.failed + counts.skipped;
  const percent = settings.total ? Math.floor((processed / settings.total) * 100) : 0;
  const left = counts.pending + counts.generating;
  const running = ACTIVE.has(project.status) || runner.isRunning(project.id);
  const finishes = project.recentFinishes || [];
  const now = Date.now();
  let perImage = null;
  if (finishes.length >= 2) perImage = (finishes.at(-1) - finishes[0]) / (finishes.length - 1);
  else if (finishes.length === 1 && project.runStartedAt) {
    const single = settings.engine === 'flow' || (settings.engine === 'pollinations' && !keys.pollinations);
    perImage = (finishes[0] - project.runStartedAt) / (single ? 1 : settings.workers || 1);
  }
  let ms = null;
  if (!left) ms = 0;
  else if (perImage) {
    ms = left * perImage;
    if (running) ms = Math.max(ms - (now - finishes.at(-1)), perImage * 0.5);
  }
  return { percent, left, running, ms };
}

function renderEta(project) {
  if (!project) { document.title = `${$('view-' + view).querySelector('h1').textContent} | Image Batch Studio`; return; }
  const { percent, left, running, ms } = estimate(project);
  const percentText = `${percent}% done, ${100 - percent}% to go`;
  let etaText;
  if (!left) etaText = project.status === 'completed' ? 'All scenes processed.' : 'Nothing left to generate.';
  else if (ms == null) etaText = running ? 'Estimating time left. This appears after the first images finish.' : `${fmt(left)} ${left === 1 ? 'scene' : 'scenes'} left.`;
  else if (running) {
    const end = new Date(Date.now() + ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    etaText = ms < 60_000 ? `<strong>Less than a minute</strong> left. Should finish around ${end}.` :
      `About <strong>${formatDuration(ms)}</strong> left. Should finish around ${end}.`;
  } else etaText = ms < 60_000 ? 'Less than a minute of work left when you resume.' : `About <strong>${formatDuration(ms)}</strong> of work left when you resume.`;
  if (view === 'queue' && active?.id === project.id) {
    $('run-percent').textContent = percentText;
    $('run-eta').innerHTML = etaText;
    $('run-meter').setAttribute('aria-valuenow', String(percent));
    $('run-meter').setAttribute('aria-valuemin', '0');
    $('run-meter').setAttribute('aria-valuemax', '100');
  }
  if (running) {
    $('rail-run-count').textContent = !ms ? `${percent}% done` : ms < 60_000 ? `${percent}% done, under a minute left` : `${percent}% done, about ${formatDuration(ms)} left`;
    document.title = `(${percent}%) ${project.settings.name} | Image Batch Studio`;
  } else document.title = `${$('view-' + view).querySelector('h1').textContent} | Image Batch Studio`;
}

/* ---------- Queue ---------- */
function tabs(container, items, selected, onSelect) {
  container.replaceChildren(...items.map(([value, label, count]) => el('button', {
    type: 'button', role: 'tab', 'aria-selected': String(value === selected), onclick: () => onSelect(value)
  }, label, count != null ? el('em', { text: ` ${fmt(count)}` }) : null)));
}

function sceneThumb(project, scene, thumbs) {
  const blob = thumbs.get(scene.number);
  if (!blob) return el('div', { class: 'thumb', 'aria-hidden': 'true' });
  return el('button', { type: 'button', class: 'thumb', title: 'Open frame', onclick: () => openViewer(project.id, scene.number) },
    el('img', { src: objectUrl('queue', blob), alt: sceneName(project.settings, scene.number), loading: 'lazy' }));
}

async function renderQueue() {
  const project = active;
  $('queue-empty').hidden = Boolean(project);
  $('queue-body').hidden = !project;
  $('queue-actions').replaceChildren();
  if (!project) {
    $('queue-title').textContent = 'Queue';
    $('queue-sub').textContent = 'Keep this tab open while a batch runs.';
    return;
  }
  const { settings, counts, status } = project;
  const running = ACTIVE.has(status) || runner.isRunning(project.id);
  const done = counts.completed;
  $('queue-title').textContent = settings.name;
  $('queue-sub').textContent = running ? 'Running. Keep this tab open; you can switch to other tabs.' :
    `Created ${new Date(project.createdAt).toLocaleString()}.`;
  const actions = $('queue-actions');
  if (status === 'running') actions.append(el('button', { type: 'button', class: 'secondary', onclick: () => attempt(() => runner.pause(project.id)) }, 'Pause'));
  if (ACTIVE.has(status)) actions.append(el('button', { type: 'button', class: 'ghost', disabled: status === 'stopping', onclick: () => attempt(() => runner.pause(project.id, true)) }, 'Stop'));
  if (!ACTIVE.has(status) && counts.pending) actions.append(el('button', { type: 'button', class: 'primary', onclick: () => attempt(() => runner.resume(project.id)) }, 'Resume'));
  if (counts.failed) actions.append(el('button', { type: 'button', class: 'secondary', onclick: () => attempt(() => runner.retry(project.id)) }, 'Retry failed'));
  if (done) actions.append(el('button', { type: 'button', class: ACTIVE.has(status) ? 'secondary' : 'primary', disabled: zipping, onclick: () => downloadZip(project) }, zipping ? 'Building ZIP…' : 'Download ZIP'));
  actions.append(el('button', { type: 'button', class: 'ghost', onclick: () => report(project) }, 'Export report'));

  $('run-done').textContent = fmt(done);
  $('run-of').textContent = `of ${fmt(settings.total)} done`;
  $('run-status').textContent = labelStatus(status);
  $('run-status').className = 'pill ' + status;
  $('run-bar').style.width = `${(done / settings.total) * 100}%`;
  $('run-bar-failed').style.width = `${(counts.failed / settings.total) * 100}%`;
  $('fig-pending').textContent = fmt(counts.pending);
  $('fig-generating').textContent = fmt(counts.generating);
  $('fig-failed').textContent = fmt(counts.failed);
  $('fig-engine').textContent = `${ENGINES[settings.engine].name}, ${modelOf(settings)}`;
  $('fig-engine').title = $('fig-engine').textContent;
  renderEta(project);
  $('run-reason').hidden = !project.reason;
  $('run-reason').textContent = project.reason || '';

  releaseUrls('preview');
  const shot = $('preview-shot');
  shot.hidden = !(project.previewNumber && project.preview && !running);
  if (!shot.hidden) {
    const image = await store.getImage(project.id, project.previewNumber);
    shot.replaceChildren(image ? el('img', { src: objectUrl('preview', image.thumb || image.blob), alt: 'Preview frame' }) : el('span'),
      el('div', { class: 'preview-copy' }, el('h2', { text: 'Check the first frame' }),
        el('p', { class: 'hint', text: 'If it looks right, select Resume to generate the rest. If not, change the settings and start a new batch.' })));
  }
  const canSwitch = !running && (counts.pending || counts.failed);
  $('switcher').hidden = !canSwitch;
  if (canSwitch) {
    const select = $('switch-engine');
    select.replaceChildren(...Object.entries(ENGINES).map(([key, engine]) => new Option(engine.name, key, false, key === settings.engine)));
    $('switch-go').onclick = () => attempt(() => runner.switchEngine(project.id, select.value));
  }

  tabs($('queue-tabs'), [['', 'All', settings.total], ['pending', 'Waiting', counts.pending], ['generating', 'Generating', counts.generating],
    ['completed', 'Done', counts.completed], ['failed', 'Failed', counts.failed]], queueFilter, value => { queueFilter = value; queuePage = 0; void render(); });
  const total = queueFilter ? counts[queueFilter] : settings.total;
  queuePage = Math.min(queuePage, Math.max(0, Math.ceil(total / QUEUE_PAGE) - 1));
  const offset = queuePage * QUEUE_PAGE;
  const page = await store.jobPage(project.id, offset, QUEUE_PAGE, queueFilter);
  const thumbs = await store.imageThumbs(project.id, page.filter(scene => scene.status === 'completed').map(scene => scene.number));
  releaseUrls('queue');
  const rows = page.map(scene => el('li', { class: 'scene ' + scene.status },
    el('span', { class: 'frame-no', text: String(scene.number).padStart(settings.digits, '0') }),
    sceneThumb(project, scene, thumbs),
    el('div', { class: 'scene-body' }, el('p', { text: scene.prompt }), scene.error ? el('p', { class: 'err', text: scene.error }) : null),
    el('div', { class: 'scene-side' },
      scene.status === 'failed' ? el('button', { type: 'button', class: 'ghost small', onclick: () => attempt(() => runner.retry(project.id, [scene.number])) }, 'Retry') : null,
      scene.status === 'failed' ? el('button', { type: 'button', class: 'ghost small', onclick: () => attempt(() => runner.retry(project.id, [scene.number], true)) }, 'Skip') : null,
      el('span', { class: 'pill ' + scene.status, text: labelStatus(scene.status) }))));
  $('scene-list').replaceChildren(...(rows.length ? rows : [el('li', { class: 'scene' }, el('span'), el('p', { class: 'hint', text: 'No scenes here.' }))]));
  pager('scene', total, offset, page.length, QUEUE_PAGE);
}

function pager(name, total, offset, length, size) {
  $(name + '-pager').hidden = total <= size;
  $(name + '-prev').disabled = offset === 0;
  $(name + '-next').disabled = offset + length >= total;
  $(name + '-range').textContent = length ? `${fmt(offset + 1)} to ${fmt(offset + length)} of ${fmt(total)}` : '';
}

/* ---------- Gallery ---------- */
async function renderGallery() {
  const project = (galleryId && await store.getProject(galleryId)) || active;
  galleryId = project?.id ?? null;
  const contact = $('contact');
  releaseUrls('gallery');
  $('gallery-zip').disabled = zipping || !project?.counts.completed;
  $('gallery-zip').textContent = zipping ? 'Building ZIP…' : 'Download all as ZIP';
  $('gallery-retry').hidden = !project?.counts.failed;
  if (!project) {
    $('gallery-sub').textContent = 'Finished frames in scene order.';
    $('gallery-tabs').replaceChildren();
    contact.replaceChildren(el('div', { class: 'empty' }, el('h2', { text: 'No frames yet' }),
      el('p', { text: 'Generated images appear here as a contact sheet, in scene order.' })));
    $('gallery-pager').hidden = true;
    return;
  }
  const { settings, counts } = project;
  $('gallery-sub').textContent = `${settings.name}: ${fmt(counts.completed)} of ${fmt(settings.total)} frames finished.`;
  tabs($('gallery-tabs'), [['', 'All', settings.total], ['completed', 'Done', counts.completed], ['failed', 'Failed', counts.failed]],
    galleryFilter, value => { galleryFilter = value; galleryPage = 0; void render(); });
  const total = galleryFilter ? counts[galleryFilter] : settings.total;
  galleryPage = Math.min(galleryPage, Math.max(0, Math.ceil(total / GALLERY_PAGE) - 1));
  const offset = galleryPage * GALLERY_PAGE;
  const page = await store.jobPage(project.id, offset, GALLERY_PAGE, galleryFilter);
  const thumbs = await store.imageThumbs(project.id, page.filter(scene => scene.status === 'completed').map(scene => scene.number));
  const shots = page.map(scene => {
    const blob = thumbs.get(scene.number);
    const number = String(scene.number).padStart(settings.digits, '0');
    const frame = blob
      ? el('button', { type: 'button', title: `Open frame ${number}`, onclick: () => openViewer(project.id, scene.number) },
        el('img', { src: objectUrl('gallery', blob), alt: `Frame ${number}`, loading: 'lazy' }))
      : el('div', { class: 'slot', text: { failed: 'Failed', generating: 'Generating', skipped: 'Skipped' }[scene.status] || 'Waiting' });
    return el('figure', { class: 'shot ' + scene.status },
      el('div', { class: 'shot-frame' }, frame),
      el('figcaption', {},
        el('div', { class: 'shot-cap' }, el('span', { class: 'frame-no', text: number }),
          scene.status === 'failed' ? el('button', { type: 'button', onclick: () => attempt(() => runner.retry(project.id, [scene.number])) }, 'Retry') : null),
        el('p', { class: 'shot-text' + (scene.error ? ' err' : ''), text: scene.error || scene.prompt })));
  });
  contact.replaceChildren(...(shots.length ? shots : [el('div', { class: 'empty' }, el('h2', { text: 'Nothing here' }), el('p', { text: 'No frames match this filter.' }))]));
  pager('gallery', total, offset, page.length, GALLERY_PAGE);
}

/* ---------- Viewer ---------- */
async function openViewer(projectId, number) {
  const keysList = await store.imageKeys(projectId);
  viewer.projectId = projectId;
  viewer.numbers = keysList.map(([, n]) => n);
  viewer.index = Math.max(0, viewer.numbers.indexOf(number));
  await showViewerFrame();
  if (!$('viewer').open) $('viewer').showModal();
}

async function showViewerFrame() {
  const number = viewer.numbers[viewer.index];
  const [project, image, job] = await Promise.all([store.getProject(viewer.projectId), store.getImage(viewer.projectId, number), store.getJob(viewer.projectId, number)]);
  if (!project || !image) return;
  if (viewer.url) URL.revokeObjectURL(viewer.url);
  viewer.url = URL.createObjectURL(image.blob);
  $('viewer-image').src = viewer.url;
  $('viewer-image').alt = `Frame ${number}`;
  $('viewer-title').textContent = `Frame ${String(number).padStart(project.settings.digits, '0')}`;
  $('viewer-prompt').textContent = job?.prompt || '';
  const facts = [image.filename, `${fmt(Math.round(image.blob.size / 1024))} KB`];
  if (job?.engine) facts.push(`made with ${ENGINES[job.engine]?.name || job.engine}`);
  if (job?.engine === 'flow' && job.original === false) facts.push('grid-size copy from Flow');
  $('viewer-meta').textContent = facts.join(', ');
  $('viewer-prev').disabled = viewer.index === 0;
  $('viewer-next').disabled = viewer.index >= viewer.numbers.length - 1;
  $('viewer-download').onclick = () => saveBlob(image.blob, image.filename);
  $('viewer-redo').onclick = async () => {
    if (await attempt(() => runner.redo(viewer.projectId, [number]), `Frame ${number} will be made again.`) !== undefined) $('viewer').close();
  };
}

/* ---------- Projects ---------- */
async function renderProjects() {
  const list = await store.projectList();
  releaseUrls('projects');
  const box = $('project-list');
  if (!list.length) {
    box.replaceChildren(el('div', { class: 'empty' }, el('h2', { text: 'No projects yet' }),
      el('p', { text: 'Each batch you start is saved here with its frames.' }), el('a', { class: 'button primary', href: '#new', text: 'New batch' })));
    return;
  }
  const rows = [];
  for (const project of list) {
    const { settings, counts } = project;
    const [first] = await store.jobsWithStatus(project.id, 'completed', 1);
    const cover = first && (await store.imageThumbs(project.id, [first.number])).get(first.number);
    const running = ACTIVE.has(project.status) || runner.isRunning(project.id);
    rows.push(el('article', { class: 'project' },
      el('div', { class: 'project-cover' }, cover ? el('img', { src: objectUrl('projects', cover), alt: '' }) : el('b', { text: fmt(settings.total) })),
      el('div', { class: 'project-info' },
        el('h2', { text: settings.name }),
        el('div', { class: 'project-facts' },
          el('span', { class: 'pill ' + project.status, text: labelStatus(project.status) }),
          el('span', { text: `${fmt(counts.completed)} of ${fmt(settings.total)} ${settings.total === 1 ? 'frame' : 'frames'}` }),
          counts.failed ? el('span', { class: 'warn', text: `${fmt(counts.failed)} failed` }) : null,
          el('span', { text: ENGINES[settings.engine].name }),
          el('span', { text: new Date(project.createdAt).toLocaleDateString() })),
        el('div', { class: 'meter' }, el('span', { style: `width:${(counts.completed / settings.total) * 100}%` }))),
      el('div', { class: 'project-actions' },
        el('button', { type: 'button', class: 'secondary small', onclick: async () => { if (await attempt(() => runner.setActive(project.id)) !== undefined) location.hash = '#queue'; } }, 'Open queue'),
        el('button', { type: 'button', class: 'secondary small', onclick: () => { galleryId = project.id; galleryFilter = ''; galleryPage = 0; location.hash = '#gallery'; } }, 'Gallery'),
        counts.completed ? el('button', { type: 'button', class: 'ghost small', disabled: zipping, onclick: () => downloadZip(project) }, 'ZIP') : null,
        el('button', { type: 'button', class: 'ghost small', disabled: running, onclick: async () => {
          if (!await confirmDialog(`Delete "${settings.name}"?`, `This removes the project and its ${fmt(counts.completed)} stored frames from this browser. Files you already downloaded stay where they are.`, 'Delete project')) return;
          await attempt(() => runner.removeProject(project.id), 'Project deleted.');
          if (galleryId === project.id) galleryId = null;
        } }, 'Delete'))));
  }
  box.replaceChildren(el('div', { class: 'projects' }, rows));
}

/* ---------- Settings ---------- */
function renderHelper() {
  const helper = helperState();
  const state = !helper ? 'off' : helper.flow ? 'ready' : 'no-tab';
  const text = { off: 'Flow helper not found', 'no-tab': 'Helper ready. Open a Flow project', ready: 'Flow helper ready' }[state];
  $('helper-chip').dataset.state = state;
  $('helper-text').textContent = text;
  $('helper-status').dataset.state = state;
  $('helper-status').textContent = !helper ? 'The helper extension is not installed or not enabled for this site.' :
    helper.flow ? `Connected (helper ${helper.version}). Flow project found.` : `Connected (helper ${helper.version}). Open a project in Google Flow to use it.`;
  $('open-flow').disabled = !helper;
  if (view === 'new') { renderEngines(); review(); }
}

async function renderSettings() {
  renderHelper();
  const handle = folderSupported() ? await savedFolder() : null;
  $('choose-folder').disabled = !folderSupported();
  $('folder-hint').textContent = folderSupported() ? 'Write each image into a folder on your computer as soon as it is finished.' :
    'This browser cannot write to folders. Use Chrome or Edge, or download the ZIP.';
  $('folder-name').textContent = handle ? `Saving into: ${handle.name}` : '';
  $('forget-folder').hidden = !handle;
  $('choose-folder').textContent = handle ? 'Change folder' : 'Choose folder';
}

/* ---------- Export ---------- */
async function downloadZip(project) {
  if (zipping) return;
  zipping = true;
  void render();
  const progress = toast('Building ZIP…', false, true);
  try {
    const stored = await store.imageKeys(project.id);
    if (!stored.length) throw new Error('No finished frames are stored for this project yet.');
    async function* files() {
      for (const [, number] of stored) {
        const image = await store.getImage(project.id, number);
        if (image?.blob) yield { name: `${project.folder}/${image.filename || `${sceneName(project.settings, number)}.${imageExtension(image.type)}`}`, blob: image.blob };
      }
    }
    const zip = await buildZip(files(), count => { progress.textContent = `Building ZIP… ${fmt(count)} of ${fmt(stored.length)}`; });
    saveBlob(zip, `${project.folder}.zip`);
    toast(`ZIP ready: ${fmt(stored.length)} frames in scene order.`);
  } catch (error) {
    toast(error.message, true);
  } finally {
    progress.remove();
    zipping = false;
    void render();
  }
}

async function report(project) {
  await attempt(async () => {
    const jobs = await store.allJobs(project.id);
    const rows = [['Scene', 'Prompt', 'Status', 'Engine', 'File', 'Seconds', 'Error'],
      ...jobs.map(job => [job.number, job.prompt, labelStatus(job.status), ENGINES[job.engine]?.name || '', job.filename,
        job.duration ? Math.round(job.duration / 1000) : '', job.error])];
    saveBlob(new Blob([csv(rows)], { type: 'text/csv;charset=utf-8' }), `${safeSegment(project.settings.name, 'Batch')} report.csv`);
  });
}

/* ---------- Render loop ---------- */
async function renderRail() {
  const project = active;
  const running = project && (ACTIVE.has(project.status) || runner.isRunning(project.id));
  $('rail-run').hidden = !running;
  $('nav-queue').hidden = !running;
  if (running) {
    const { counts, settings } = project;
    $('rail-run-name').textContent = settings.name;
    $('rail-run-bar').style.width = `${(counts.completed / settings.total) * 100}%`;
    $('rail-run-count').textContent = `${fmt(counts.completed)} of ${fmt(settings.total)} done`;
    $('nav-queue').textContent = fmt(counts.pending + counts.generating);
  }
  renderEta(project);
  void keepAwake(running);
}

async function keepAwake(on) {
  try {
    if (on && !wakeLock && document.visibilityState === 'visible' && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { wakeLock = null; }
}

let rendering = false;
let again = false;
async function render() {
  if (rendering) { again = true; return; }
  rendering = true;
  try {
    active = await store.getProject(await store.getMeta('active'));
    await renderRail();
    if (view === 'new') review();
    if (view === 'queue') await renderQueue();
    if (view === 'gallery') await renderGallery();
    if (view === 'projects') await renderProjects();
    if (view === 'settings') await renderSettings();
  } catch (error) {
    console.error(error);
    toast(error.message, true);
  } finally {
    rendering = false;
    if (again) { again = false; void render(); }
  }
}

function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => void render(), 200);
}

/* ---------- Wiring ---------- */
function bindDraft() {
  const fields = { prompts: 'text', 'project-name': 'name', prefix: 'prefix', 'start-from': 'startFrom', character: 'character', style: 'style',
    'flow-model': 'flowModel', 'gemini-model': 'geminiModel', 'poll-model': 'pollinationsModel', workers: 'workers' };
  for (const [id, key] of Object.entries(fields)) {
    const input = $(id);
    input.value = draft[key] ?? '';
    input.addEventListener(input.tagName === 'SELECT' ? 'change' : 'input', () => {
      draft[key] = key === 'workers' ? Math.min(5, Math.max(1, Number(input.value) || 1)) : input.value;
      saveDraft();
      review();
    });
  }
  const checks = { fallback: 'fallback', 'character-on': 'characterOn', 'style-on': 'styleOn', 'flow-downloads': 'flowDownloads' };
  for (const [id, key] of Object.entries(checks)) {
    const input = $(id);
    input.checked = Boolean(draft[key]);
    const mark = () => {
      if (key === 'characterOn') $('consist-character').classList.toggle('on', input.checked);
      if (key === 'styleOn') $('consist-style').classList.toggle('on', input.checked);
    };
    mark();
    input.addEventListener('change', () => { draft[key] = input.checked; mark(); saveDraft(); review(); });
  }
  const step = delta => {
    draft.workers = Math.min(5, Math.max(1, (Number(draft.workers) || 1) + delta));
    $('workers').value = draft.workers;
    saveDraft();
  };
  $('workers-down').addEventListener('click', () => step(-1));
  $('workers-up').addEventListener('click', () => step(1));
  const loadText = text => { $('prompts').value = draft.text = text; saveDraft(); review(); };
  $('import-file').addEventListener('click', () => $('prompt-file').click());
  $('prompt-file').addEventListener('change', async event => {
    const [file] = event.target.files;
    if (file) loadText(await file.text());
    event.target.value = '';
  });
  $('sample-10').addEventListener('click', () => loadText(SAMPLES.map((text, index) => `Scene ${index + 1}: ${text}`).join('\n')));
  $('sample-1000').addEventListener('click', () => loadText(Array.from({ length: 1000 }, (_, index) =>
    `${SAMPLES[index % SAMPLES.length]}, variation ${Math.floor(index / SAMPLES.length) + 1}`).join('\n')));
  for (const kind of ['character', 'style']) {
    showRef(kind);
    $(kind + '-pick').addEventListener('click', () => $(kind + '-file').click());
    $(kind + '-file').addEventListener('change', event => {
      const [file] = event.target.files;
      if (file) void setRef(kind, file);
      event.target.value = '';
    });
    $(kind + '-clear').addEventListener('click', () => setRef(kind, null));
  }
  $('preview').addEventListener('click', () => start(true));
  $('start').addEventListener('click', () => start(false));
}

function bindSettings() {
  for (const [id, key] of [['gemini-key', 'gemini'], ['poll-key', 'pollinations']]) {
    const input = $(id);
    input.value = keys[key] || '';
    input.addEventListener('input', () => {
      const value = input.value.trim();
      if (value) keys[key] = value; else delete keys[key];
      clearTimeout(keyTimer);
      keyTimer = setTimeout(() => void store.putMeta('keys', { ...keys }).then(() => toast('Key saved in this browser.')), 600);
    });
  }
  $('open-flow').addEventListener('click', () => attempt(() => callHelper('open-flow')));
  $('check-helper').addEventListener('click', async () => {
    const helper = await refreshHelper();
    toast(helper ? (helper.flow ? 'Helper connected and Flow project found.' : 'Helper connected. Open a Flow project next.') :
      'Helper not found. Install it, then reload this page.', !helper);
  });
  $('choose-folder').addEventListener('click', async () => {
    try {
      const handle = await chooseFolder();
      toast(`New images will also be saved into "${handle.name}".`);
    } catch (error) { if (error.name !== 'AbortError') toast(error.message, true); }
    void render();
  });
  $('forget-folder').addEventListener('click', async () => { await forgetFolder(); toast('Images will no longer be saved to a folder.'); void render(); });
  $('clear-all').addEventListener('click', async () => {
    if (active && (ACTIVE.has(active.status) || runner.isRunning(active.id))) { toast('Pause or stop the running batch first.', true); return; }
    if (!await confirmDialog('Clear all data?', 'Every project, frame, key and setting saved by this website in this browser will be deleted. Downloaded files are not affected.', 'Clear all data')) return;
    await store.clearEverything();
    location.hash = '#new';
    location.reload();
  });
}

function bindNavigation() {
  window.addEventListener('hashchange', route);
  $('scene-prev').addEventListener('click', () => { queuePage--; void render(); });
  $('scene-next').addEventListener('click', () => { queuePage++; void render(); });
  $('gallery-prev').addEventListener('click', () => { galleryPage--; void render(); });
  $('gallery-next').addEventListener('click', () => { galleryPage++; void render(); });
  $('gallery-zip').addEventListener('click', async () => { const project = await store.getProject(galleryId); if (project) void downloadZip(project); });
  $('gallery-retry').addEventListener('click', () => attempt(() => runner.retry(galleryId)));
  $('viewer-close').addEventListener('click', () => $('viewer').close());
  $('viewer-prev').addEventListener('click', () => { viewer.index--; void showViewerFrame(); });
  $('viewer-next').addEventListener('click', () => { viewer.index++; void showViewerFrame(); });
  $('viewer').addEventListener('close', () => { if (viewer.url) URL.revokeObjectURL(viewer.url); viewer.url = null; });
  $('viewer').addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft' && viewer.index > 0) { viewer.index--; void showViewerFrame(); }
    if (event.key === 'ArrowRight' && viewer.index < viewer.numbers.length - 1) { viewer.index++; void showViewerFrame(); }
  });
  $('viewer').addEventListener('click', event => { if (event.target === $('viewer')) $('viewer').close(); });
  window.addEventListener('beforeunload', event => {
    if (active && (ACTIVE.has(active.status) || runner.isRunning(active.id))) { event.preventDefault(); event.returnValue = ''; }
  });
  document.addEventListener('visibilitychange', () => void renderRail());
}

async function init() {
  draft = { ...initialDraft(), ...((await store.getMeta('draft')) || {}) };
  keys = (await store.getMeta('keys')) || {};
  refs = (await store.getMeta('refs')) || {};
  $('flow-model').replaceChildren(...FLOW_MODELS.map(model => new Option(model, model)));
  $('gemini-models').replaceChildren(...GEMINI_MODELS.map(model => new Option(model)));
  $('poll-models').replaceChildren(...POLLINATIONS_MODELS.map(model => new Option(model)));
  bindDraft();
  bindSettings();
  bindNavigation();
  renderEngines();
  renderRatios();
  await runner.boot();
  runner.onChange(detail => {
    if (detail?.settled) {
      const { settings, counts, status } = detail.settled;
      if (status === 'completed') toast(`"${settings.name}" finished: ${fmt(counts.completed)} ${counts.completed === 1 ? 'frame' : 'frames'}${counts.failed ? `, ${fmt(counts.failed)} failed` : ''}.`);
    }
    scheduleRender();
  });
  onHelper(() => renderHelper());
  setInterval(() => void refreshHelper(), 20_000);
  setInterval(() => { if (active && (ACTIVE.has(active.status) || runner.isRunning(active.id))) renderEta(active); }, 5000);
  route();
  void refreshHelper();
}

void init().catch(error => { console.error(error); toast('Image Batch Studio could not start: ' + error.message, true, true); });
