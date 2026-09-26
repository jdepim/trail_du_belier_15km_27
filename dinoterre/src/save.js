// localStorage persistence. The terrain is regenerated from the seed; only player-made changes are stored.
import { SAVE_KEY } from './config.js';

export function loadSave(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(SAVE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    return s && s.v === 1 ? s : null;
  } catch { return null; }
}

export function writeSave(data, storage = globalThis.localStorage) {
  try { storage?.setItem(SAVE_KEY, JSON.stringify({ v: 1, ...data })); return true; } catch { return false; }
}

export function clearSave(storage = globalThis.localStorage) {
  try { storage?.removeItem(SAVE_KEY); } catch { /* ignore */ }
}
