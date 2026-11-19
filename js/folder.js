// Optional: write each finished image straight into a folder the user picks (Chrome and Edge).
import { getMeta, putMeta, deleteMeta } from './store.js?v=3';
import { safeSegment } from './model.js?v=3';

export const folderSupported = () => typeof window.showDirectoryPicker === 'function';

export async function chooseFolder() {
  const handle = await window.showDirectoryPicker({ id: 'image-batch-studio', mode: 'readwrite' });
  await putMeta('folder', handle);
  return handle;
}

export const savedFolder = () => getMeta('folder');
export const forgetFolder = () => deleteMeta('folder');

// Call from a click so the browser can ask again after a reload.
export async function ensureFolderAccess() {
  const handle = await savedFolder();
  if (!handle) return null;
  if (await handle.queryPermission({ mode: 'readwrite' }) === 'granted') return handle;
  return await handle.requestPermission({ mode: 'readwrite' }) === 'granted' ? handle : null;
}

export async function writeImage(projectFolder, filename, blob) {
  const handle = await savedFolder();
  if (!handle || await handle.queryPermission({ mode: 'readwrite' }) !== 'granted') return false;
  const directory = await handle.getDirectoryHandle(safeSegment(projectFolder, 'Project'), { create: true });
  const file = await directory.getFileHandle(filename, { create: true });
  const writable = await file.createWritable();
  await writable.write(blob);
  await writable.close();
  return true;
}
