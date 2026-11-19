// Talks to the Image Batch Studio Helper extension, which runs Google Flow in the user's browser.
import { StudioError } from './model.js';

const pending = new Map();
let helper = null;
const listeners = new Set();

function notify() { for (const listener of listeners) listener(helper); }

window.addEventListener('message', event => {
  const message = event.data;
  if (event.source !== window || event.origin !== location.origin) return;
  if (message?.channel !== 'ibs-helper' || message.dir !== 'from-helper') return;
  if (message.type === 'ready') {
    helper = { ...(helper || {}), version: message.version };
    notify();
    void refreshHelper();
    return;
  }
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  clearTimeout(waiter.timer);
  if (message.ok) waiter.resolve(message.value);
  else waiter.reject(new StudioError(message.code || 'helper', message.error || 'The helper extension did not answer.'));
});

export function callHelper(type, payload = {}, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new StudioError('helper', 'The helper extension did not answer. Check that it is installed and enabled, then reload this page.'));
    }, timeout);
    pending.set(id, { resolve, reject, timer });
    window.postMessage({ channel: 'ibs-helper', dir: 'to-helper', id, type, payload }, location.origin);
  });
}

export async function refreshHelper() {
  try {
    const state = await callHelper('hello', {}, 2500);
    helper = { version: state.version, flow: state.flow, busy: state.busy };
  } catch {
    helper = null;
  }
  notify();
  return helper;
}

export const helperState = () => helper;
export function onHelper(listener) { listeners.add(listener); return () => listeners.delete(listener); }

export async function flowImage(options) {
  const value = await callHelper('generate', options, 300_000);
  const binary = atob(value.base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return { blob: new Blob([bytes], { type: value.type || 'image/jpeg' }), original: value.original };
}
