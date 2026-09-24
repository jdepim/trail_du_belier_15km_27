# GOUFFRE — core engine notes (step 1 of 2)

Hand-off document for the next agent. `DESIGN.md` stays the contract; its §14 lists the small
additions made in step 1. Everything below is what exists **now** and where step 2 plugs in.

Run it: `npm run serve` then open `http://localhost:8080/index.html` (add `?debug` for FPS/keys).
Tests: `npm test` (109 unit tests, `node --test`) and `npm run test:e2e` (Playwright smoke, iPhone 13
landscape with touch, 25 steps incl. review regressions, screenshots in `tests/e2e/screenshots/`, git-ignored).

## What exists

- Complete vertical slice: title → camp (Forge building + blacksmith, headframe, shaft) → procedural
  300-row mine with 5 layers → dig, jump, grapple, swing, reel, lava damage, death → restart.
- Fixed 60 Hz loop with accumulator (dt clamped to 0.25 s), render interpolation, hit-stop, state machine
  `TITLE / PLAYING / PAUSED / SHOP / DEAD / VICTORY`, visibilitychange auto-pause, portrait overlay.
- Integer-scaled pixel rendering (iPhone 13 landscape: ×5, internal 450×205), chunk-cached tiles,
  parallax night sky + gothic castle, per-tile BFS lighting with coloured bloom, particles, crack overlays.
- Touch controls (floating stick, Saut / Frapper / Grappin, pause, contextual button), keyboard, gamepad.
- Synthesized WebAudio SFX for every event in DESIGN §10 + quiet per-layer drone with distant bells.
- PWA: `manifest.webmanifest`, generated icons (`icons/`, `node tools/make-icons.mjs`), `sw.js` cache-first
  (registered only off-localhost; bump `VERSION` in `sw.js` on each release).
- Stubs with final APIs: `enemies.js`, `entities.js`, `meta.js` (functional save/upgrade math), `ui.js`
  (title + pause functional; forge / death / victory are placeholders).

## Dev tools (`tools/`)

- `tools/sprites.html` — sprite / tile / backdrop sheet (`?only=player&z=6` filters and zooms).
- `node tools/mapdump.mjs <seed> out.png` — whole-map PNG (env `SCALE`, `Y0`, `Y1` to crop); spawns and chests marked.
- `node tools/shot.mjs "<path?query>" out.png [w] [h] [waitMs]` — screenshot any page of the game.
- `node tools/make-icons.mjs` — regenerate `icons/icon-{180,192,512}.png` from `tools/icon.html`.
- `tests/e2e/server.mjs` — zero-dependency static server (used by tests and `npm run serve`).

## Module API summary (`src/`)

| Module | Key API |
|---|---|
| `config.js` | All tuning: `TILE, WORLD_W/H, SURFACE_Y, CHUNK, LAYERS[], layerAtDepth(d), PLAYER, GRAPPLE, CAMERA, LIGHT, TOUCH, ENEMY_SCALING, ENEMY_SPAWN_RULES, WORLDGEN, HIT_STOP, SAVE_KEY` |
| `rng.js` | `mulberry32(seed)`, `createRng(seed)` → `{next,float,int,chance,pick,weighted,shuffle,fork}`, `createNoise2D(seed)`, `fbm2D`, `hash2`, `normalizeSeed` |
| `tiles.js` | `TILES[id]`, `TILE_ID.KEY`, `TILE_BY_KEY`, `tileDef(id)`, lookup tables `SOLID/EMIT/DECO`, `ORE_KEYS`, `BACK` (wall styles). Def fields: `id key name solid hp tier value light hazard drop colors deco liquid sound base host lightColor ore` |
| `world.js` | `new World(w,h)`: `types, back, damage, damaged[], chunkVersion, skyTop, version`; `get/set/setRaw`, `isSolid(tx,ty)`, `isSolidAt(px,py)`, `damageTile(tx,ty,dmg,tier) → {hit,broken,tooHard,tileId,ratio}`, `crackStage`, `update(dt)` (3 s regen), `rectSolid`, `rectHazard`, `clearDetachedDeco(tx,ty,onCleared?) → n` (called by `game.tileBroken`: roots/stalactites below, stalagmites/mushrooms/skulls above, unsupported cobwebs beside), `decoSupported(tx,ty)` |
| `worldgen.js` | `generateWorld(seed) → { world, spawns, chests, camp, arena, seed }` (see header comment for record shapes). Invariant (tested on 40 seeds): lava never has open space beside or below it (`crustExposedLava` runs after the arena vestibule is carved) |
| `physics.js` | `moveAndCollide(body, dt, world) → {onGround,hitCeiling,hitLeft,hitRight}` (body = `{x,y,w,h,vx,vy,cornerCorrection?}`, top-left AABB, sub-stepped), `raycast(world,x,y,dx,dy,max) → {x,y,tx,ty,dist,nx,ny}|null`, `touchingBelow` |
| `input.js` | `moveX/moveY`, `aimX/aimY/aimActive`, `pressed/held/released(a)`; actions `jump attack grapple interact pause`; `beginTick()/endTick()` (edge protocol), `inject({x,y,jump,...})`, `tap(a)`, `clearInjected()`, `setContextAction(label|null)`, `setControlsVisible(b)`, `getLayout()`, `poll()` (gamepad; a disconnected pad releases its stick + buttons). Sliding a finger between action buttons re-points the touch before releasing the old button. After `resetAll()` (pause/blur) a still-held arrow key comes back with its auto-repeat and a thumb still on the left half is adopted as a new stick on its next move |
| `player.js` | `new Player(game)`: `reset(cx,feetY)`, `teleport`, `update(dt)`, `strike()`, `strikeBox(dir)`, `takeDamage(amount, sourceX, opts) → bool`, `heal(n)`, `die(cause)`; fields `stats` (see `baseStats()`), `hp, facing, onGround, anim, animFrame, iframes, dead, grapple`; getters `cx, cy, feetY, tileX, tileY, depth` |
| `grapple.js` | `new Grapple(game, player)` (owned by the player): `state` idle/flying/attached/retracting, `onPress()` (a press while retracting re-fires at once), `fire()`, `release(jump)`, `preMove/postMove/update`, `predicted` (reticle), `length`, `maxLength` (= max(range × `GRAPPLE.payOutMul`, length at attach)), pure helpers `ropeConstrainVelocity`, `ropeCorrection`, `aimAssist`. Attach keeps the real distance (no yank when catching a fall); the reel-in pull only applies while up is held; positional correction is capped at `GRAPPLE.maxCorrection` px/tick |
| `render.js` | `Camera`: `update(dt)`, `snap()`, `shake(px, s)`, `renderPos(alpha, out?, anchorX?, anchorY?)` (with an anchor: `round(a) - round(a - cam)`, the renderer anchors on the interpolated player so the hero never shimmers; entities are drawn at `round(x) - camX` as before); `Renderer`: `resize(cssW,cssH,dpr)`, `render(alpha)`, `invalidateAll()` |
| `lighting.js` | `compute(camX,camY,w,h)` (reads lights, never clears them), `draw(ctx,camX,camY)`, `clearDynamic()` (called at the start of every fixed tick by `updatePlaying`), `addLight(x,y,intensity,[r,g,b])` (pooled, no allocation; valid until the next tick, so lights stay on in 120 Hz frames without a tick, during hit-stop and pause; call it from any fixed-update code, e.g. `enemies.addLights`), `addStatic(...)`, `clearStatics()` |
| `sprites.js` | `loadSprites()`, `getSprite(name)`, `drawSprite(ctx,name,frame,x,y,flipX)` (x,y = anchor), `getTileTexture`, `getBackTexture`, `makeIcon(name,cssPx)`, `backdrop`. Preview every sprite: `tools/sprites.html` |
| `particles.js` | `spawn(kind,x,y,opts)`: `debris chip dust land spark ember blood poof glint smoke`; `update`, `draw`, `clear` |
| `audio.js` | `play(name,{volume,pitch,material})`, `setMuted/toggleMute`, `unlock()`, `setLayer(i)`, `suspend/resume` (`unlock`/`resume` wake the context from `suspended` and WebKit's iOS `interrupted` state; rejections are swallowed) |
| `hud.js` | `drawText(ctx,str,x,y,color,{align,outline,shadow,alpha})`, `measureText`; `Hud`: `toast(text,{color,sub,life})`, `banner(title,sub)`, `flashDamage()`, `setHint(text)` |
| `debug.js` | flags `?debug ?god ?seed= ?depth= ?gold= ?autostart ?mute ?nosw`; `window.__gouffre` (state, start, freeze/step, input.set/tap/clear/layout, player(), grapple(), tile/setTile, teleport/teleportDepth, setGod, gen(), info()) |
| `ui.js` | `showTitle/showPause/showShop/showDeath/showVictory`, `hide()`, `relayout()` (called on resize: re-fits the title logo after a portrait boot + rotation) |
| `main.js` | builds the `game` context (below), loop, resize, states |

### The `game` context
`game.{world, gen, player, camera, input, audio, particles, lighting, renderer, hud, ui, enemies, entities,
save, run, state, time, flags, safe, hitStopTicks}` and hooks `game.hitStop(s)` (converted to whole fixed
ticks, at least 1: 0.05 s = 3 ticks, 0.018 s = 1), `game.toast(text, opts)`,
`game.tileBroken(tx,ty,id,cause)` (FX, drops, then `world.clearDetachedDeco`), `game.onPlayerDeath(cause)`,
`game.setState(s)`, `game.newWorld(seed)`, `game.newRun(seed)`, `game.startGame(seed)`, `game.fixedStep(dt)`.
`game.run = { seed, gold, bag: [], bagCount, relics: [], bestDepth, maxLayer, kills, startTime }` (HUD reads
`gold`, `bagCount ?? bag.length`, `bestDepth`).

### Fixed-update order (`updatePlaying`)
pause check → `lighting.clearDynamic` → `world.update` → `player.update` (input, grapple, move, strike) → `enemies.update` →
`entities.update` → `particles.update` → `camera.update` → `hud.update` → ambient FX → `enemies.addLights`
→ layer banner / music → Forge proximity (context button) → **[banking TODO]** → death timer.

## What step 2 must plug in

1. **Enemies** (`enemies.js`): instantiate from `this.spawns` in `reset(spawns)` (anchor semantics in the
   worldgen header; skip spawns far from the camera and re-spawn off-screen), implement `update(dt)`
   (only within ~1.5 screens of `game.camera`), `draw(ctx,camX,camY,alpha)` with sprites
   `enemy_slime|bat|skeleton|spider|ghost|imp|golem|guardian`, projectiles `proj_bone|proj_fireball`,
   `damageInBox()` (return hits; the player already triggers hit-stop + shake), contact damage via
   `game.player.takeDamage(dmg, enemyX)`, depth scaling with `scaleStat()`, lights via
   `lighting.addLight` in `addLights()`, death → `particles.spawn('poof')`, `audio.play('enemy_death')`,
   `entities.spawnCoins()`, sometimes `spawnHeart()`. Ghosts ignore tiles; others use `moveAndCollide`.
2. **Pickups / bag / chests** (`entities.js`): `spawnDrop('ore:<key>', x, y, def)` is already called by
   `game.tileBroken` → pooled nuggets (`ore_<key>` sprites) that pop out and are magnetised to the player;
   add to `game.run.bag` up to `player.stats.bagCapacity` (toast "Sac plein !"); coins go to `run.gold`;
   `'heal'` currently heals 20 directly (replace with a heart pickup). Chests: `interactionAt(player)` must
   return `{ label: 'Ouvrir', use() }` near a closed chest (main.js already shows the button and calls
   `use()`), then relic or gold, `audio.play('chest')`.
3. **Banking**: in `main.js` at the `TODO step 2` marker, when `player.feetY <= gen.camp.bankY` and the bag is
   not empty → convert bag value (`TILES[...].value`) into `save.gold`, `audio.play('bank')`, toast, save.
4. **Death flow**: `game.onPlayerDeath` → apply `insurance` (% of bag kept), lose relics/run gold, update
   stats; `setState('DEAD')` shows `ui.showDeath(stats, { onRestart })`; `newRun()` regenerates the mine.
5. **Meta / Forge**: `meta.js` has save load/migrate, `UPGRADES` (costs/effects are placeholders) and
   `applyUpgrades(player, save)` (called in `newWorld`). Build the shop in `ui.showShop()` (buy →
   `audio.play('buy')`, `applyUpgrades`, `saveGame`). Relic effects (`RELICS`) need hooks in `player.js`
   (double jump, feather fall, etc.).
6. **Menus**: restyle/extend `ui.js` (death, victory + NG+, settings with mute; mute is stored under
   `gouffre.muted` by `audio.js` — move it into the save if you prefer).
7. **Victory**: when the Guardian dies → `setState('VICTORY')`.

## Known limitations / notes

- Base grapple range is 96 px (DESIGN value): many anchors are out of reach until upgraded; the reticle
  shows the predicted anchor. Climbing a deep 1-wide hole takes several grapples (by design).
- Hole assist: an idle player slides into a 1-wide hole only when the body centre is over it (or right
  after digging it); standing on the rim is safe. Running over a 1-wide hole still drops you in
  (10 px body over a 16 px gap, no ledge forgiveness).
- The rope does not wrap around corners (DESIGN simplification). Rope pendulum is lightly damped.
- Chunk rebuild after a tile breaks costs ~1–2 ms (whole 16×16 chunk redrawn); the first frame of a new
  world builds ~9 chunks (~10 ms in headless Chromium).
- Headless-Chromium timings: update ≈ 0.04 ms, render ≈ 3.5 ms per frame (software canvas incl. the
  full-resolution upscale); a real iPhone GPU canvas should be well under the 4 ms budget.
- Lighting is recomputed every frame over the view + 7-tile margin (~1200 cells).
- Audio cannot be verified by tests beyond "no errors"; iOS unlock happens on the first tap / "Jouer".
- Placeholder art for enemies / relics / guardian is intentionally simple.
- Enemy and chest positions are data only; nothing attacks the player yet (only lava hurts).
