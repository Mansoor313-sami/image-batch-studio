// The batch queue. Runs in the open page: parallel workers, rate-limit waits, retries and engine fallback.
import * as store from './store.js?v=4';
import { ACTIVE, ENGINES, JOB_STATES, StudioError, imageExtension, safeSegment, sceneName } from './model.js?v=4';
import { POLLINATIONS_ANON_GAP, gemini, pollinations, thumbnail } from './engines.js?v=4';
import { flowImage, refreshHelper } from './bridge.js?v=4';
import { writeImage } from './folder.js?v=4';
import { pollinationsKey } from './config.js?v=4';

const LIMIT = new Set(['quota', 'rate', 'credits']);
const TRANSIENT = new Set(['network', 'timeout', 'generation']);
const HALT = new Set(['auth', 'settings', 'security', 'helper', 'tab', 'references', 'busy', 'interface']);
const inflight = new Map();
const listeners = new Set();
let chain = Promise.resolve();
let timer;
let queued = false;
let cooldownUntil = 0;
let lastAnonymous = 0;

const flightKey = (id, number) => `${id}:${number}`;
const runningFor = id => [...inflight.values()].filter(projectId => projectId === id).length;
export const isRunning = id => runningFor(id) > 0;
export function onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); }
function changed(detail) { for (const listener of listeners) listener(detail); }

function serial(operation) {
  const task = chain.then(operation);
  chain = task.catch(() => {});
  return task;
}

export function kick(delay = 0) {
  clearTimeout(timer);
  if (delay) { timer = setTimeout(() => kick(), delay); return; }
  if (queued) return;
  queued = true;
  void serial(async () => { queued = false; await drive(); }).catch(error => console.error(error));
}

function jobState(project, job, status) {
  if (job.status !== status) {
    project.counts[job.status]--;
    project.counts[status]++;
    job.status = status;
  }
  if (['completed', 'failed', 'skipped'].includes(status) && project.selection?.[0] === job.number) project.selection.shift();
}

async function checkEngine(engine) {
  if (engine === 'gemini') {
    const keys = (await store.getMeta('keys')) || {};
    if (!keys.gemini) throw new StudioError('auth', 'Add your Gemini API key in Settings before using the Gemini engine.');
  }
  if (engine === 'flow') {
    const helper = await refreshHelper();
    if (!helper) throw new StudioError('helper', 'Google Flow needs the Image Batch Studio Helper extension. Install it from Settings, then reload this page.');
    if (!helper.flow) throw new StudioError('tab', 'Open Google Flow, sign in, and open a project in another tab. Then try again.');
  }
}

export async function boot() {
  const id = await store.getMeta('active');
  const project = id && await store.getProject(id);
  if (!project) return;
  const orphans = await store.jobsWithStatus(id, 'generating');
  if (orphans.length) await store.editJobs(id, orphans.map(job => job.number), (record, job) => { jobState(record, job, 'pending'); });
  if (ACTIVE.has(project.status)) {
    await store.editProject(id, record => {
      record.status = 'paused';
      record.reason = 'The page was closed or reloaded while this batch was running. Select Resume to continue.';
    });
  }
}

export async function startBatch({ settings, prompts }, preview) {
  const current = await store.getProject(await store.getMeta('active'));
  if (current && (ACTIVE.has(current.status) || isRunning(current.id))) {
    throw new StudioError('busy', `Pause or stop "${current.settings.name}" before starting another batch.`);
  }
  await checkEngine(settings.engine);
  const base = safeSegment(settings.name, 'Project');
  const taken = new Set((await store.projectList()).map(project => project.folder.toLowerCase()));
  let folder = base;
  for (let suffix = 2; taken.has(folder.toLowerCase()); suffix++) folder = `${base} (${suffix})`;
  const now = Date.now();
  const project = {
    id: crypto.randomUUID(), settings, folder, createdAt: now, updatedAt: now, status: 'running', reason: '',
    preview: Boolean(preview), selection: preview ? [prompts[0].number] : null, rateHits: 0, runStartedAt: now, recentFinishes: [],
    counts: Object.fromEntries(JOB_STATES.map(state => [state, state === 'pending' ? prompts.length : 0]))
  };
  await store.createProject(project, prompts);
  cooldownUntil = 0;
  changed();
  kick();
  return project;
}

async function guard(id) {
  const project = await store.getProject(id);
  if (!project) throw new StudioError('project', 'This project no longer exists.');
  return project;
}

export async function setActive(id) {
  const current = await store.getProject(await store.getMeta('active'));
  if (current && current.id !== id && (ACTIVE.has(current.status) || isRunning(current.id))) {
    throw new StudioError('busy', `Pause "${current.settings.name}" before opening another project's queue.`);
  }
  await store.putMeta('active', id);
  changed();
}

export async function pause(id, stop = false) {
  await guard(id);
  await store.editProject(id, record => {
    if (!ACTIVE.has(record.status)) return;
    record.status = stop ? 'stopping' : 'pausing';
    record.reason = 'Finishing the images already in progress.';
  });
  changed();
  kick();
}

export async function resume(id) {
  const project = await guard(id);
  await setActive(id);
  await checkEngine(project.settings.engine);
  cooldownUntil = 0;
  await store.editProject(id, record => {
    record.status = 'running';
    record.reason = '';
    record.rateHits = 0;
    record.runStartedAt = Date.now();
    record.recentFinishes = [];
    if (record.previewFile) record.preview = false;
    if (!record.preview || !record.selection?.length) record.selection = null;
  });
  changed();
  kick();
}

export async function retry(id, numbers, skip = false) {
  const project = await guard(id);
  if (ACTIVE.has(project.status) && !skip) {
    // Retrying while running just puts the scenes back in line.
  } else if (!skip) {
    await setActive(id);
    await checkEngine(project.settings.engine);
  }
  const targets = numbers ?? (await store.jobsWithStatus(id, 'failed')).map(job => job.number);
  const result = await store.editJobs(id, targets, (record, job) => {
    if (job.status !== 'failed') return false;
    jobState(record, job, skip ? 'skipped' : 'pending');
    delete job.error;
    job.tries = 0;
  });
  if (!result?.changed.length) throw new StudioError('queue', 'There are no failed scenes to retry.');
  await store.editProject(id, record => {
    if (!skip && !ACTIVE.has(record.status)) {
      record.status = 'running';
      record.reason = '';
      record.rateHits = 0;
      record.selection = numbers ? [...result.changed].sort((a, b) => a - b) : null;
      record.runStartedAt = Date.now();
      record.recentFinishes = [];
    } else if (skip && !ACTIVE.has(record.status) && !record.counts.pending && !record.counts.failed) {
      record.status = 'completed';
      record.reason = record.fallbackNote || '';
    }
  });
  cooldownUntil = 0;
  changed();
  kick();
}

export async function redo(id, numbers) {
  const project = await guard(id);
  const active = ACTIVE.has(project.status);
  if (!active) { await setActive(id); await checkEngine(project.settings.engine); }
  const result = await store.editJobs(id, numbers, (record, job) => {
    if (!['completed', 'failed', 'skipped'].includes(job.status)) return false;
    jobState(record, job, 'pending');
    delete job.error;
    job.tries = 0;
  });
  if (!result?.changed.length) throw new StudioError('queue', 'That frame is already waiting or generating.');
  if (!active) await store.editProject(id, record => {
    record.status = 'running';
    record.reason = '';
    record.selection = [...result.changed].sort((a, b) => a - b);
    record.runStartedAt = Date.now();
    record.recentFinishes = [];
  });
  cooldownUntil = 0;
  changed();
  kick();
}

export async function switchEngine(id, engine) {
  const project = await guard(id);
  if (ACTIVE.has(project.status) || isRunning(id)) throw new StudioError('busy', 'Pause the batch and wait for running images to finish first.');
  if (!ENGINES[engine]) throw new StudioError('settings', 'Choose an image engine.');
  await checkEngine(engine);
  await store.editProject(id, record => {
    record.settings.engine = engine;
    record.rateHits = 0;
    if (record.status !== 'completed') record.status = 'paused';
    record.reason = `Switched to ${ENGINES[engine].name}. Select Resume to continue.`;
  });
  changed();
}

export async function removeProject(id) {
  const project = await guard(id);
  if (ACTIVE.has(project.status) || isRunning(id)) throw new StudioError('busy', 'Pause or stop this batch before deleting it.');
  await store.deleteProject(id);
  changed();
}

async function settle(project) {
  const finished = await store.editProject(project.id, record => {
    if (record.status === 'stopping') {
      record.status = 'stopped';
      record.reason = 'Batch stopped. Select Resume to continue.';
    } else if (record.status === 'pausing') {
      record.status = 'paused';
      record.reason = 'Batch paused. Select Resume to continue.';
    } else if (record.counts.pending) {
      record.status = 'paused';
      record.reason = record.preview ? 'Preview ready. Select Resume to generate the remaining scenes.' :
        'The selected scenes are done. Select Resume to generate the rest.';
    } else {
      record.status = 'completed';
      record.reason = record.counts.failed ? 'Finished. Some scenes failed and can be retried.' : record.fallbackNote || '';
    }
    record.selection = null;
  });
  changed({ settled: finished });
}

async function drive() {
  const id = await store.getMeta('active');
  let project = await store.getProject(id);
  if (!project || (!ACTIVE.has(project.status) && !runningFor(project.id))) return;
  const orphans = (await store.jobsWithStatus(id, 'generating')).filter(job => !inflight.has(flightKey(id, job.number)));
  if (orphans.length) {
    await store.editJobs(id, orphans.map(job => job.number), (record, job) => { jobState(record, job, 'pending'); });
    project = await store.getProject(id);
  }
  if (!ACTIVE.has(project.status)) return;
  const running = runningFor(id);
  if (project.status !== 'running' || project.selection?.length === 0 || !project.counts.pending) {
    if (!running) await settle(project);
    return;
  }
  const now = Date.now();
  if (now < cooldownUntil) { kick(cooldownUntil - now + 50); return; }
  const engine = project.settings.engine;
  const keys = (await store.getMeta('keys')) || {};
  const anonymous = engine === 'pollinations' && !pollinationsKey(keys);
  const limit = engine === 'flow' || anonymous ? 1 : project.settings.workers || 1;
  if (anonymous && running === 0 && now - lastAnonymous < POLLINATIONS_ANON_GAP) {
    kick(POLLINATIONS_ANON_GAP - (now - lastAnonymous) + 50);
    return;
  }
  const slots = limit - running;
  if (slots <= 0) return;
  let candidates;
  if (project.selection?.length) {
    candidates = [];
    for (const number of project.selection) {
      if (candidates.length >= slots) break;
      const job = await store.getJob(id, number);
      if (job?.status === 'pending') candidates.push(job);
    }
  } else candidates = await store.jobsWithStatus(id, 'pending', slots);
  for (const candidate of candidates) {
    const attempt = crypto.randomUUID();
    const result = await store.editJob(id, candidate.number, (record, job) => {
      if (job.status !== 'pending') return false;
      job.attempt = attempt;
      job.startedAt = Date.now();
      job.engine = engine;
      jobState(record, job, 'generating');
    });
    if (!result) continue;
    inflight.set(flightKey(id, candidate.number), id);
    if (anonymous) lastAnonymous = Date.now();
    void run(id, candidate.number, attempt, engine);
  }
  changed();
}

async function run(id, number, attempt, engine) {
  const outcome = {};
  try {
    const project = await store.getProject(id);
    const job = await store.getJob(id, number);
    const { settings } = project;
    const keys = (await store.getMeta('keys')) || {};
    const base = sceneName(settings, number);
    if (engine === 'flow') {
      const result = await flowImage({ text: job.text, model: settings.flowModel, ratio: settings.ratio,
        save: settings.flowDownloads, folder: `Image Batch Studio/${project.folder}`, filename: base });
      outcome.blob = result.blob;
      outcome.original = result.original;
    } else if (engine === 'gemini') {
      const refs = (await store.getMeta('refs')) || {};
      const references = [settings.characterOn && refs.character, settings.styleOn && refs.style].filter(item => item instanceof Blob);
      outcome.blob = await gemini({ key: keys.gemini, model: settings.geminiModel, ratio: settings.ratio, text: job.text, references });
    } else {
      outcome.blob = await pollinations({ key: pollinationsKey(keys), model: settings.pollinationsModel, ratio: settings.ratio, text: job.text });
    }
    outcome.thumb = await thumbnail(outcome.blob);
    outcome.filename = `${base}.${imageExtension(outcome.blob.type)}`;
    try { outcome.inFolder = await writeImage(project.folder, outcome.filename, outcome.blob); }
    catch { outcome.inFolder = false; }
  } catch (error) {
    outcome.error = error;
  }
  try { await serial(() => finish(id, number, attempt, engine, outcome)); }
  catch (error) { console.error(error); }
  finally {
    inflight.delete(flightKey(id, number));
    kick();
  }
}

async function finish(id, number, attempt, engine, { blob, thumb, filename, inFolder, original, error }) {
  const job = await store.getJob(id, number);
  if (!job || job.attempt !== attempt || job.status !== 'generating') return;
  if (blob) {
    await store.putImage({ projectId: id, number, blob, thumb, type: blob.type, filename });
    await store.editJob(id, number, (record, item) => {
      Object.assign(item, { filename, bytes: blob.size, inFolder, original, duration: Date.now() - item.startedAt, finishedAt: Date.now() });
      delete item.error;
      jobState(record, item, 'completed');
      record.rateHits = 0;
      record.recentFinishes = [...(record.recentFinishes || []), Date.now()].slice(-15);
      if (record.reason?.startsWith('Rate limit')) record.reason = '';
      if (record.preview && !record.previewNumber) { record.previewNumber = number; record.previewFile = true; }
    });
    changed({ image: { id, number } });
    return;
  }
  let code = error?.code || 'generation';
  const reason = String(error?.message || 'The image could not be generated.').slice(0, 400);
  await store.editJob(id, number, (record, item) => {
    const switchOver = () => {
      record.settings.engine = 'pollinations';
      record.rateHits = 0;
      record.fallbackNote = `${ENGINES[engine].name} reached its limit during this batch, so the remaining scenes used Pollinations.`;
      record.reason = `${ENGINES[engine].name} reached its limit, so the batch continued with Pollinations. (${reason})`.slice(0, 400);
    };
    const halt = message => {
      if (ACTIVE.has(record.status)) record.status = 'paused';
      record.reason = message;
    };
    if (code === 'rate' && engine !== 'flow') {
      record.rateHits = (record.rateHits || 0) + 1;
      if (record.rateHits > 8) code = 'quota';
      else {
        const wait = error.retryAfter || 30_000;
        cooldownUntil = Math.max(cooldownUntil, Date.now() + wait);
        jobState(record, item, 'pending');
        record.reason = `Rate limit: waiting ${Math.ceil(wait / 1000)} seconds before continuing.`;
        return;
      }
    }
    if (LIMIT.has(code)) {
      jobState(record, item, 'pending');
      if (record.settings.engine !== engine) return;
      if (record.settings.fallback && engine !== 'pollinations') { switchOver(); return; }
      halt(`${reason} Switch the engine or wait for the limit to reset, then select Resume.`);
      return;
    }
    if (HALT.has(code)) {
      jobState(record, item, 'pending');
      if (record.settings.engine === engine) halt(`${reason} Fix this, then select Resume.`);
      return;
    }
    item.tries = (item.tries || 0) + 1;
    if (TRANSIENT.has(code) && item.tries < 3) {
      item.error = `${reason} Trying again automatically (${item.tries} of 2).`;
      jobState(record, item, 'pending');
    } else {
      item.error = reason;
      jobState(record, item, 'failed');
    }
  });
  changed();
}
