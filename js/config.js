// Site-wide settings. Edit this file to change defaults for every visitor.

// Shared Pollinations key used when a visitor has not added their own in Settings.
// Use a PUBLISHABLE key only (starts with pk_), from enter.pollinations.ai.
// Never put a secret key (sk_) here: everyone who opens the website can read this file.
export const DEFAULT_POLLINATIONS_KEY = '';

// The visitor's own key wins; otherwise the shared publishable key, if it is valid.
export function pollinationsKey(keys = {}) {
  if (keys.pollinations) return keys.pollinations;
  const shared = String(DEFAULT_POLLINATIONS_KEY || '').trim();
  return /^pk_[\w-]+$/.test(shared) ? shared : '';
}

export const hasSharedPollinationsKey = () => Boolean(pollinationsKey({}));
