// IndexedDB storage: drafts, keys, projects, scenes and finished images stay in this browser.
const NAME = 'ImageBatchStudioWeb';
let connection;

function database() {
  if (!connection) connection = new Promise((resolve, reject) => {
    const request = indexedDB.open(NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('meta');
      db.createObjectStore('projects', { keyPath: 'id' }).createIndex('updated', 'updatedAt');
      db.createObjectStore('jobs', { keyPath: ['projectId', 'number'] }).createIndex('status', ['projectId', 'status', 'number']);
      db.createObjectStore('images', { keyPath: ['projectId', 'number'] });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); connection = null; };
      resolve(db);
    };
    request.onerror = () => { connection = null; reject(request.error); };
  });
  return connection;
}

const resultOf = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

export async function transact(names, mode, work) {
  const db = await database();
  const tx = db.transaction(names, mode);
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error ?? new Error('Saving was interrupted. Try again.'));
  });
  done.catch(() => {});
  const stores = Object.fromEntries(names.map(name => [name, tx.objectStore(name)]));
  try {
    const value = await work(stores, resultOf);
    await done;
    return value;
  } catch (error) {
    try { tx.abort(); } catch { /* already finished */ }
    throw error;
  }
}

const range = id => IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
const statusRange = (id, status) => IDBKeyRange.bound([id, status, 0], [id, status, Number.MAX_SAFE_INTEGER]);

export const getMeta = key => transact(['meta'], 'readonly', ({ meta }, read) => read(meta.get(key)));
export const putMeta = (key, value) => transact(['meta'], 'readwrite', ({ meta }) => { meta.put(value, key); });
export const deleteMeta = key => transact(['meta'], 'readwrite', ({ meta }) => { meta.delete(key); });
export const getProject = id => id ? transact(['projects'], 'readonly', ({ projects }, read) => read(projects.get(id))) : null;
export const getJob = (id, number) => transact(['jobs'], 'readonly', ({ jobs }, read) => read(jobs.get([id, number])));
export const putImage = record => transact(['images'], 'readwrite', ({ images }) => { images.put(record); });
export const getImage = (id, number) => transact(['images'], 'readonly', ({ images }, read) => read(images.get([id, number])));
export const imageKeys = id => transact(['images'], 'readonly', ({ images }, read) => read(images.getAllKeys(range(id))));
export const allJobs = id => transact(['jobs'], 'readonly', ({ jobs }, read) => read(jobs.getAll(range(id))));
export const jobsWithStatus = (id, status, limit) =>
  transact(['jobs'], 'readonly', ({ jobs }, read) => read(jobs.index('status').getAll(statusRange(id, status), limit)));

export function createProject(project, prompts) {
  return transact(['meta', 'projects', 'jobs'], 'readwrite', ({ meta, projects, jobs }) => {
    projects.add(project);
    for (const { number, text, prompt } of prompts) jobs.add({ projectId: project.id, number, text, prompt, status: 'pending', tries: 0 });
    meta.put(project.id, 'active');
    return project;
  });
}

export function editProject(id, change) {
  return transact(['projects'], 'readwrite', async ({ projects }, read) => {
    const project = await read(projects.get(id));
    if (!project) return null;
    change(project);
    project.updatedAt = Date.now();
    projects.put(project);
    return project;
  });
}

export function editJob(id, number, change) {
  return transact(['projects', 'jobs'], 'readwrite', async ({ projects, jobs }, read) => {
    const project = await read(projects.get(id));
    const job = await read(jobs.get([id, number]));
    if (!project || !job) return null;
    if (change(project, job) === false) return null;
    project.updatedAt = Date.now();
    projects.put(project);
    jobs.put(job);
    return { project, job };
  });
}

export function editJobs(id, numbers, change) {
  return transact(['projects', 'jobs'], 'readwrite', async ({ projects, jobs }, read) => {
    const project = await read(projects.get(id));
    if (!project) return null;
    const changed = [];
    for (const number of numbers) {
      const job = await read(jobs.get([id, number]));
      if (job && change(project, job) !== false) { jobs.put(job); changed.push(number); }
    }
    project.updatedAt = Date.now();
    projects.put(project);
    return { project, changed };
  });
}

export function jobPage(id, offset, limit, status) {
  return transact(['jobs'], 'readonly', ({ jobs }) => new Promise((resolve, reject) => {
    const request = (status ? jobs.index('status') : jobs).openCursor(status ? statusRange(id, status) : range(id));
    const records = [];
    let skip = offset;
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve(records);
      if (skip) { cursor.advance(skip); skip = 0; return; }
      records.push(cursor.value);
      if (records.length >= limit) resolve(records);
      else cursor.continue();
    };
  }));
}

export function projectList() {
  return transact(['projects'], 'readonly', ({ projects }, read) => read(projects.index('updated').getAll()))
    .then(list => list.reverse());
}

export function imageThumbs(id, numbers) {
  return transact(['images'], 'readonly', async ({ images }, read) => {
    const map = new Map();
    for (const number of numbers) {
      const record = await read(images.get([id, number]));
      if (record) map.set(number, record.thumb || record.blob);
    }
    return map;
  });
}

export function deleteProject(id) {
  return transact(['meta', 'projects', 'jobs', 'images'], 'readwrite', async ({ meta, projects, jobs, images }, read) => {
    jobs.delete(range(id));
    images.delete(range(id));
    projects.delete(id);
    if ((await read(meta.get('active'))) === id) meta.delete('active');
  });
}

export function clearEverything() {
  return transact(['meta', 'projects', 'jobs', 'images'], 'readwrite', stores => {
    for (const store of Object.values(stores)) store.clear();
  });
}
