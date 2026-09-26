// Resource counts carried by the player. Resource ids come from data/resources.js.
import { RESOURCES } from './data/resources.js';

export class Inventory {
  constructor(init = {}) {
    this.items = {};
    for (const id of Object.keys(RESOURCES)) this.items[id] = init[id] | 0;
    this.onChange = null;
  }

  count(id) { return this.items[id] | 0; }

  add(id, n = 1) {
    if (!(id in RESOURCES) || n <= 0) return;
    this.items[id] = this.count(id) + n;
    this.onChange?.(id);
  }

  /** Add every {id: n} of a bundle (carcass drops, ally deliveries). */
  addAll(bundle) { for (const [id, n] of Object.entries(bundle)) this.add(id, n); }

  take(id, n = 1) {
    if (this.count(id) < n) return false;
    this.items[id] -= n;
    this.onChange?.(id);
    return true;
  }

  canAfford(cost) { return Object.entries(cost).every(([id, n]) => this.count(id) >= n); }

  pay(cost) {
    if (!this.canAfford(cost)) return false;
    for (const [id, n] of Object.entries(cost)) this.items[id] -= n;
    this.onChange?.(null);
    return true;
  }

  /** Lose a share of everything (death penalty). Returns what was lost. */
  loseShare(share) {
    const lost = {};
    for (const id of Object.keys(this.items)) {
      const n = Math.floor(this.items[id] * share);
      if (n > 0) { this.items[id] -= n; lost[id] = n; }
    }
    this.onChange?.(null);
    return lost;
  }

  toJSON() { return { ...this.items }; }
}
