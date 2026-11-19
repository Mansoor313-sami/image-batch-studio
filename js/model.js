// Prompts, settings and naming shared by the Image Batch Studio website.
export const FLOW_MODELS = ['Nano Banana 2.1', 'Nano Banana 2 Lite', 'Nano Banana Pro'];
export const GEMINI_MODELS = ['gemini-3.1-flash-image-preview', 'gemini-3.1-flash-lite-image', 'gemini-2.5-flash-image', 'gemini-3-pro-image-preview'];
export const POLLINATIONS_MODELS = ['flux', 'zimage', 'klein', 'gptimage', 'turbo'];
export const RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4'];
export const RATIO_SIZES = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1024, 1024], '4:3': [1440, 1080], '3:4': [1080, 1440] };
export const ENGINES = {
  flow: { name: 'Google Flow', short: 'Flow', note: 'Nano Banana on your Google account. Free at 0 credits. Needs the helper extension.' },
  gemini: { name: 'Gemini API', short: 'Gemini', note: 'Nano Banana through your own Gemini API key. Usually needs billing.' },
  pollinations: { name: 'Pollinations', short: 'Pollinations', note: 'Free FLUX images. Faster and larger with a free key.' }
};
export const JOB_STATES = ['pending', 'generating', 'completed', 'failed', 'skipped'];
export const ACTIVE = new Set(['running', 'pausing', 'stopping']);

export class StudioError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function initialDraft() {
  return {
    text: '', name: '', engine: 'pollinations', flowModel: FLOW_MODELS[0], geminiModel: GEMINI_MODELS[0],
    pollinationsModel: POLLINATIONS_MODELS[0], ratio: RATIOS[0], workers: 3, startFrom: '', fallback: true,
    characterOn: false, character: '', styleOn: false, style: '', prefix: 'Image', flowDownloads: true
  };
}

export function parsePrompts(input) {
  const text = String(input ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const visible = lines.filter(line => line.trim());
  if (!visible.length) return [];
  const heading = /^\s*(?:Image|Scene|Prompt|Shot|Frame)\s+(\d+)(?:\s+Prompt)?\s*[:.)-]\s?(.*)$/i;
  const numbered = /^\s*(\d+)[.)]\s+(.*)$/;
  const prompts = [];
  if (heading.test(visible[0])) {
    let job;
    for (const line of lines) {
      const match = line.match(heading);
      if (match) {
        job = { number: Number(match[1]), text: match[2] };
        prompts.push(job);
      } else if (job) job.text += (job.text ? '\n' : '') + line;
    }
  } else if (visible.every(line => numbered.test(line))) {
    for (const line of visible) {
      const [, number, content] = line.match(numbered);
      prompts.push({ number: Number(number), text: content });
    }
  } else {
    for (const [index, line] of visible.entries()) prompts.push({ number: index + 1, text: line });
  }
  const numbers = new Set();
  for (const job of prompts) {
    job.text = job.text.trim();
    if (!Number.isSafeInteger(job.number) || job.number < 1 || !job.text) {
      throw new StudioError('prompts', `Scene ${job.number || '?'} needs a positive number and a prompt.`);
    }
    if (numbers.has(job.number)) throw new StudioError('prompts', `Scene ${job.number} appears twice. Give each scene its own number.`);
    numbers.add(job.number);
  }
  return prompts.sort((first, second) => first.number - second.number);
}

export function safeSegment(value, fallback, length = 60) {
  let text = String(value ?? '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim().replace(/[. ]+$/g, '');
  text = [...text].slice(0, length).join('').replace(/[. ]+$/g, '') || fallback;
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\s*\.|$)/i.test(text)) return '_' + text;
  return text;
}

export function composePrompt(text, { characterOn, character, styleOn, style } = {}) {
  const sentence = value => {
    const clean = String(value ?? '').replace(/\s+/g, ' ').trim();
    return clean && !/[.!?]$/.test(clean) ? clean + '.' : clean;
  };
  const parts = [String(text ?? '').trim()];
  if (characterOn && sentence(character)) parts.push('Character (keep consistent): ' + sentence(character));
  if (styleOn && sentence(style)) parts.push('Style: ' + sentence(style));
  return parts.filter(Boolean).join(parts[0].includes('\n') ? '\n' : ' ');
}

export function validateDraft(draft) {
  const all = parsePrompts(draft.text);
  if (!all.length) throw new StudioError('prompts', 'Add at least one prompt.');
  const name = String(draft.name ?? '').trim();
  if (!name) throw new StudioError('output', 'Give the project a name.');
  const engine = draft.engine;
  if (!ENGINES[engine]) throw new StudioError('settings', 'Choose an image engine.');
  if (!RATIOS.includes(draft.ratio)) throw new StudioError('settings', 'Choose an aspect ratio.');
  if (engine === 'flow' && !FLOW_MODELS.includes(draft.flowModel)) throw new StudioError('settings', 'Choose a Flow model.');
  const geminiModel = String(draft.geminiModel || GEMINI_MODELS[0]).trim();
  const pollinationsModel = String(draft.pollinationsModel || POLLINATIONS_MODELS[0]).trim();
  if (!/^[\w.-]+$/.test(geminiModel) || !/^[\w.-]+$/.test(pollinationsModel)) {
    throw new StudioError('settings', 'Model names can only use letters, numbers, dots and dashes.');
  }
  let startFrom = 1;
  if (String(draft.startFrom ?? '').trim()) {
    startFrom = Number(draft.startFrom);
    if (!Number.isSafeInteger(startFrom) || startFrom < 1) throw new StudioError('settings', 'Start from must be a positive scene number.');
  }
  const prompts = all.filter(prompt => prompt.number >= startFrom);
  if (!prompts.length) throw new StudioError('settings', `No scenes are numbered ${startFrom} or higher.`);
  const consistency = {
    characterOn: Boolean(draft.characterOn), character: String(draft.character ?? '').trim(),
    styleOn: Boolean(draft.styleOn), style: String(draft.style ?? '').trim()
  };
  return {
    prompts: prompts.map(({ number, text }) => ({ number, prompt: text, text: composePrompt(text, consistency) })),
    settings: {
      name, engine, ratio: draft.ratio, flowModel: draft.flowModel, geminiModel, pollinationsModel, startFrom,
      total: prompts.length, digits: Math.max(3, String(all.at(-1).number).length), prefix: safeSegment(draft.prefix, 'Image', 30),
      workers: Math.min(5, Math.max(1, Math.round(Number(draft.workers) || 1))), fallback: draft.fallback !== false,
      flowDownloads: draft.flowDownloads !== false, ...consistency
    }
  };
}

export function modelOf(settings, engine = settings.engine) {
  if (engine === 'gemini') return settings.geminiModel;
  if (engine === 'pollinations') return settings.pollinationsModel;
  return settings.flowModel;
}

export function sceneName(settings, number) {
  return `${settings.prefix} ${String(number).padStart(settings.digits, '0')}`;
}

export function imageExtension(type) {
  return { 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg' }[String(type).split(';')[0]] || 'jpg';
}

export function csv(rows) {
  return rows.map(row => row.map(cell => {
    const value = String(cell ?? '');
    const safe = /^\s*[=+@\-]/.test(value) ? "'" + value : value;
    return '"' + safe.replaceAll('"', '""') + '"';
  }).join(',')).join('\r\n') + '\r\n';
}

export const labelStatus = status => ({
  pending: 'Waiting', generating: 'Generating', completed: 'Done', failed: 'Failed', skipped: 'Skipped',
  running: 'Running', pausing: 'Pausing', stopping: 'Stopping', paused: 'Paused', stopped: 'Stopped'
})[status] || status;
