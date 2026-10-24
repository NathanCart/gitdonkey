// Renderer-side avatar cache. URLs come from the main process as data URLs;
// decoded images are kept for the graph canvas.
import { invoke } from './api.js';

const urls = new Map(); // email -> data URL | null
const pending = new Map();
const images = new Map(); // email -> decoded HTMLImageElement
const listeners = new Set();
let enabled = true;
let scheduled = false;

const key = (email) => String(email || '').trim().toLowerCase();

export function setAvatarsEnabled(value) {
  enabled = Boolean(value);
  notify();
}

export function avatarsEnabled() {
  return enabled;
}

/** Called (batched per frame) whenever an avatar finishes loading. */
export function onAvatarChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function notify() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    for (const cb of listeners) cb();
  });
}

function request(k) {
  if (pending.has(k)) return pending.get(k);
  const p = invoke('avatar:get', k)
    .catch(() => null)
    .then((url) => {
      urls.set(k, url || null);
      pending.delete(k);
      if (url) {
        const img = new Image();
        img.onload = () => {
          images.set(k, img);
          notify();
        };
        img.src = url;
      }
      return url || null;
    });
  pending.set(k, p);
  return p;
}

/** Sync lookup: a URL, null (no avatar) or undefined (still loading). */
export function avatarUrl(email) {
  if (!enabled || !email) return null;
  const k = key(email);
  if (urls.has(k)) return urls.get(k);
  request(k);
  return undefined;
}

export function whenAvatar(email) {
  if (!enabled || !email) return Promise.resolve(null);
  const k = key(email);
  if (urls.has(k)) return Promise.resolve(urls.get(k));
  return request(k);
}

/** A decoded image for canvas drawing, or null (requests it if unknown). */
export function avatarImage(email) {
  if (!enabled || !email) return null;
  const k = key(email);
  const img = images.get(k);
  if (img) return img;
  if (!urls.has(k)) request(k);
  return null;
}
