// Image engines that run without a Flow tab: Gemini API (user's key) and Pollinations.
import { RATIO_SIZES, StudioError } from './model.js?v=3';

const TIMEOUT = 150_000;
export const POLLINATIONS_ANON_GAP = 46_000;

function apiError(code, message, retryAfter) {
  const error = new StudioError(code, message);
  if (retryAfter) error.retryAfter = retryAfter;
  return error;
}

export async function base64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let text = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(text);
}

export async function dataUrl(blob) {
  return `data:${blob.type || 'image/jpeg'};base64,${await base64(blob)}`;
}

export async function thumbnail(blob, width = 360) {
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, width / bitmap.width);
    const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
  } catch {
    return null;
  }
}

async function send(url, init) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
  } catch (error) {
    if (error?.name === 'TimeoutError') throw apiError('timeout', 'The image service took too long to answer.');
    throw apiError('network', 'Could not reach the image service. Check the internet connection.');
  }
}

const seconds = value => {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) && number > 0 ? Math.ceil(number * 1000) : 0;
};

export async function gemini({ key, model, ratio, text, references = [] }) {
  if (!key) throw apiError('auth', 'Add your Gemini API key in the Dashboard (from aistudio.google.com).');
  const parts = [{ text }];
  for (const reference of references) {
    parts.push({ inline_data: { mime_type: reference.type || 'image/png', data: await base64(reference) } });
  }
  const response = await send(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: ratio } }
    })
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = String(body?.error?.message || `Gemini answered ${response.status}.`).slice(0, 350);
    if (response.status === 429) {
      const retry = body?.error?.details?.find(detail => String(detail['@type']).endsWith('RetryInfo'))?.retryDelay;
      if (/limit:\s*0|per ?day|free_tier/i.test(message) || !retry) {
        throw apiError('quota', 'Gemini quota reached for this key and model. ' + message);
      }
      throw apiError('rate', message, seconds(retry) || 30_000);
    }
    if ([401, 403].includes(response.status) || /api key/i.test(message)) throw apiError('auth', 'Gemini rejected the API key. ' + message);
    if (response.status === 404) throw apiError('settings', `Gemini does not offer the model "${model}" for this key.`);
    if (response.status >= 500) throw apiError('network', 'Gemini is busy right now. ' + message);
    throw apiError('generation', message);
  }
  const candidate = body?.candidates?.[0];
  const image = candidate?.content?.parts?.find(part => (part.inlineData || part.inline_data)?.data);
  if (!image) {
    const reason = body?.promptFeedback?.blockReason || candidate?.finishReason || '';
    if (/SAFETY|PROHIBITED|BLOCK|RECITATION/i.test(reason)) {
      throw apiError('policy', `Gemini blocked this prompt (${reason}). Edit the wording and retry.`);
    }
    throw apiError('generation', 'Gemini returned no image for this prompt.');
  }
  const data = image.inlineData || image.inline_data;
  const binary = atob(data.data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: data.mimeType || data.mime_type || 'image/png' });
}

export async function pollinations({ key, model, ratio, text }) {
  const [width, height] = RATIO_SIZES[ratio] || RATIO_SIZES['16:9'];
  const seed = Math.floor(Math.random() * 2_147_483_000);
  const prompt = encodeURIComponent(text.replace(/\s+/g, ' ').trim());
  const query = new URLSearchParams({ width, height, seed, nologo: 'true' });
  let url;
  const headers = {};
  if (key) {
    query.set('model', model);
    url = `https://gen.pollinations.ai/image/${prompt}?${query}`;
    headers.Authorization = 'Bearer ' + key;
  } else {
    query.set('model', 'flux');
    url = `https://image.pollinations.ai/prompt/${prompt}?${query}`;
  }
  const response = await send(url, { headers, credentials: 'omit' });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 250);
    const wait = seconds(response.headers.get('Retry-After'));
    if (response.status === 429 || response.status === 402) {
      if (key && response.status === 402 && !wait) throw apiError('quota', 'Your Pollinations key is out of pollen. ' + detail);
      throw apiError('rate', 'Pollinations asked us to slow down.', wait || POLLINATIONS_ANON_GAP);
    }
    if ([401, 403].includes(response.status)) throw apiError('auth', 'Pollinations rejected the API key. ' + detail);
    if (response.status >= 500) throw apiError('network', `Pollinations is busy (${response.status}).`);
    throw apiError('generation', `Pollinations could not make this image (${response.status}). ${detail}`);
  }
  const blob = await response.blob();
  if (!/^image\//.test(blob.type) || blob.size < 1000) throw apiError('generation', 'Pollinations did not return an image.');
  return blob;
}
