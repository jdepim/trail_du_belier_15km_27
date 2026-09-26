// Boot: renderer, input, HUD, title screen and the fixed-step main loop.
import { STEP, MAX_STEPS } from './config.js';
import { Game } from './game.js';
import { Renderer } from './render.js';
import { Input } from './input.js';
import { Hud } from './hud.js';
import { Audio } from './audio.js';
import { loadSave, writeSave, clearSave } from './save.js';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('game');
const renderer = new Renderer(canvas);
const input = new Input();
input.attachKeyboard(window);
input.attachTouch({
  zone: document.getElementById('stickzone'),
  base: document.getElementById('stickbase'),
  knob: document.getElementById('stickknob'),
  buttons: document.querySelectorAll('[data-btn]'),
});
const audio = new Audio({ muted: params.has('mute') });
let game = null;

function start(opts) {
  game = new Game({ ...opts, input, audio, onSave: (d) => writeSave(d) });
  game.viewW = renderer.W; game.viewH = renderer.H;
  game.camera.follow(game.player, renderer.W, renderer.H, game.world, 0, true);
  input.clear();
  hud.bind(game);
  window.__dino.game = game;
  game.save();
}

const hud = new Hud({
  audio,
  onPick: (species) => { clearSave(); start({ species, seed: params.has('seed') ? +params.get('seed') : undefined }); },
  onContinue: () => { const s = loadSave(); if (s) start({ save: s }); },
  onNew: () => { clearSave(); game = null; hud.showTitle(null); },
});

window.__dino = { game: null, input, renderer, hud, start, loadSave, clearSave };

function resize() {
  renderer.resize();
  if (game) { game.viewW = renderer.W; game.viewH = renderer.H; }
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 200));
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());
document.addEventListener('visibilitychange', () => { if (document.hidden && game) game.save(); });
window.addEventListener('pagehide', () => game?.save());

let last = performance.now(), acc = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  if (game) {
    acc += dt;
    let n = 0;
    while (acc >= STEP && n < MAX_STEPS) { game.update(STEP); acc -= STEP; n++; }
    if (n === MAX_STEPS) acc = 0;
    renderer.draw(game);
    hud.update(dt);
  } else {
    drawTitleBackdrop(now / 1000);
  }
}

// a slowly scrolling world behind the title screen
let backdrop = null;
function drawTitleBackdrop(t) {
  if (!backdrop) { backdrop = new Game({ seed: 7, species: 'robuste', spawnCreatures: false }); }
  backdrop.viewW = renderer.W; backdrop.viewH = renderer.H;
  backdrop.camera.x = backdrop.player.cx - renderer.W / 2 + Math.sin(t * 0.05) * 300;
  backdrop.camera.y = backdrop.player.cy - renderer.H * 0.55;
  backdrop.clock = 60;
  renderer.draw(backdrop);
}

const existing = loadSave();
if (params.has('autostart')) start({ species: params.get('species') || 'robuste', seed: params.has('seed') ? +params.get('seed') : 1 });
else hud.showTitle(existing);
requestAnimationFrame(frame);
