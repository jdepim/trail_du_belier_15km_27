// Damage resolution between the player and creatures (both directions).

export class Combat {
  constructor(game) { this.game = game; }

  /** attacker hits target for `amount` with horizontal knockback `kx`. */
  hit(attacker, target, amount, kx) {
    const g = this.game;
    if (target === g.player) return g.player.takeHit(amount, kx, g);
    if (!target.alive || target.kind !== 'creature') return false;
    if (attacker !== g.player && attacker.ally === target.ally) return false;   // no friendly fire
    const dmg = target.takeHit(amount * (0.9 + Math.random() * 0.2), kx, attacker, g);
    g.particles.spawn('blood', target.cx, target.cy, { n: 4 });
    g.float(dmg >= 10 ? dmg.toFixed(0) : dmg.toFixed(1), target.cx, target.y - 2, target.ally ? '#ff9a9a' : '#ffffff');
    g.audio.play(target.alive ? 'hit' : 'kill');
    if (attacker === g.player) {
      g.camera.shake(target.alive ? 1 : 2);
      g.hitStop(target.alive ? 0.03 : 0.07);
      g.pack.onPlayerAttack(target);
    }
    return true;
  }
}
