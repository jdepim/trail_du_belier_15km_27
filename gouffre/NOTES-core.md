# GOUFFRE — developer notes (engine, combat, economy)

The single developer reference. `DESIGN.md` stays the contract; its §14 / §14 bis / §14 ter / §14 quater
list what steps 1, 2a, 2b and the final audit round added or changed. Everything below is what exists **now**.
Player-facing overview (French): `README.md`.

Run it: `npm run serve` then open `http://localhost:8080/index.html` (add `?debug` for FPS/keys).
Tests: `npm test` (179 unit tests, `node --test`) and `npm run test:e2e` (Playwright smoke, iPhone 13
landscape with touch, 47 steps incl. review / audit regressions, onboarding tips, the trapdoor, climbing, the
"Corde de secours", combat, the boss fight and the whole meta loop, screenshots in `tests/e2e/screenshots/`,
git-ignored). Economy model: `npm run economy`.

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
- **Step 2a**: the 7 regular enemies, combat, coin / heart pickups and the boss (see "Enemies & combat").
- **Step 2b**: the rogue-lite loop (see "Economy & meta loop"): ore chunks → backpack → banking at the
  camp, death summary + mine regeneration, versioned save, the Forge (8 upgrades), chests and 11 relics,
  title / settings / pause / death / victory menus, NG+, HUD polish. No stubs are left.
- **Final audit round** (WebKit, CPU-throttled performance, first-time player, legal playthrough): CSS
  upscale of the internal canvas, per-cell chunk patching, cheaper lighting / HUD text; camp trapdoor and
  locked camp ground; Grappin re-press climbs; ledge assist; onboarding tips (`tips.js`), "Commandes" panel,
  touch controls line and install hint on the title; stuck detector + "Corde de secours"; save transfer code;
  scrolling overlays; chest gold cut, richer Abyss, Forge costs re-based on a legal-play bot; `sw.js` only
  touches its own caches (see "Final audit round" below).

## Dev tools (`tools/`)

- `tools/sprites.html` — sprite / tile / backdrop sheet (`?only=player&z=6` filters and zooms).
- `node tools/mapdump.mjs <seed> out.png` — whole-map PNG (env `SCALE`, `Y0`, `Y1` to crop); spawns and chests marked.
- `node tools/shot.mjs "<path?query>" out.png [w] [h] [waitMs]` — screenshot any page of the game.
- `node tools/make-icons.mjs` — regenerate `icons/icon-{180,192,512}.png` from `tools/icon.html`.
- `node tools/economy.mjs [--seeds 8 --players 400]` (`npm run economy`) — ore per layer from the real
  generator, gold per trip by depth, Monte-Carlo progression against the Forge costs (see "Economy curve").
  `runEconomy({ quiet })` is also imported by a unit test that pins the balance targets.
- `tests/e2e/server.mjs` — zero-dependency static server (used by tests and `npm run serve`).

## Module API summary (`src/`)

| Module | Key API |
|---|---|
| `config.js` | All tuning: `TILE, WORLD_W/H, SURFACE_Y, CHUNK, LAYERS[], layerAtDepth(d), PLAYER, GRAPPLE, CAMERA, LIGHT, TOUCH, ENEMY_SCALING, ENEMY_STATS, ENEMY_AI, ENEMY_SPAWNING, ENEMY_ACTIVE, DROPS, ECONOMY, BOSS, ENEMY_SPAWN_RULES, WORLDGEN, HIT_STOP, SAVE_KEY, MUTE_KEY` (upgrade costs / effects live in `meta.js`) |
| `rng.js` | `mulberry32(seed)`, `createRng(seed)` → `{next,float,int,chance,pick,weighted,shuffle,fork}`, `createNoise2D(seed)`, `fbm2D`, `hash2`, `normalizeSeed` |
| `tiles.js` | `TILES[id]`, `TILE_ID.KEY`, `TILE_BY_KEY`, `tileDef(id)`, lookup tables `SOLID/EMIT/DECO`, `ORE_KEYS`, `BACK` (wall styles). Def fields: `id key name solid hp tier value light hazard drop colors deco liquid sound base host lightColor ore` |
| `world.js` | `new World(w,h)`: `types, back, damage, damaged[], chunkVersion, skyTop, version, locked, dirtyLog / dirtyCount` (ring of the last `DIRTY_LOG` changed tile indices, read by the renderer); `get/set/setRaw`, `lock(tx,ty,on)` / `isLocked` (camp ground, headframe beam), `isSolid(tx,ty)`, `isSolidAt(px,py)`, `damageTile(tx,ty,dmg,tier) → {hit,broken,tooHard,locked,tileId,ratio}`, `crackStage`, `update(dt)` (3 s regen), `rectSolid`, `rectHazard`, `clearDetachedDeco(tx,ty,onCleared?) → n` (called by `game.tileBroken`: roots/stalactites below, stalagmites/mushrooms/skulls above, unsupported cobwebs beside), `decoSupported(tx,ty)` |
| `worldgen.js` | `generateWorld(seed) → { world, spawns, chests, camp, arena, seed }` (see header comment for record shapes; `camp.trapdoor = {x0,x1,y}`, `camp.shaft` is the open part under it). Rubies also replace natural rock touching lava in layer 4 (`WORLDGEN.lavaCrustOre`). Invariant (tested on 40 seeds): lava never has open space beside or below it (`crustExposedLava` runs after the arena vestibule is carved) |
| `physics.js` | `moveAndCollide(body, dt, world) → {onGround,hitCeiling,hitLeft,hitRight}` (body = `{x,y,w,h,vx,vy,cornerCorrection?}`, top-left AABB, sub-stepped), `raycast(world,x,y,dx,dy,max) → {x,y,tx,ty,dist,nx,ny}|null`, `touchingBelow` |
| `input.js` | `moveX/moveY`, `aimX/aimY/aimActive`, `pressed/held/released(a)`; actions `jump attack grapple interact pause`; `beginTick()/endTick()` (edge protocol), `inject({x,y,jump,...})`, `tap(a)`, `clearInjected()`, `setContextAction(label|null)`, `setControlsVisible(b)`, `getLayout()`, `bottomBand()` (CSS px from the screen bottom to the top of Saut / Frapper), `poll()` (gamepad; a disconnected pad releases its stick + buttons). Sliding a finger between action buttons re-points the touch before releasing the old button. After `resetAll()` (pause/blur) a still-held arrow key comes back with its auto-repeat and a thumb still on the left half is adopted as a new stick on its next move; a **pad button held through `resetAll()` (any PLAYING → menu change) is ignored until released** (`padBlock`), so a held A / Start never confirms the menu that just opened. Menus: `navX/navY` (stick / D-pad focus moves, 380 ms then 150 ms auto-repeat) and `takePadBack()` (B), handed to `ui.move()` / `ui.back()` by main |
| `player.js` | `new Player(game)`: `reset(cx,feetY)`, `teleport`, `update(dt)` (incl. `_ledgeAssist`: airborne, pushing into a wall whose top is ≤ `PLAYER.ledgeAssist` px above the feet → popped onto it), `strike()` (enemies, then chests via `entities.hitChests`, then tiles; a locked tile says "Impossible ici"), `strikeBox(dir)`, `takeDamage(amount, sourceX, opts) → bool` (`opts.cause` feeds the death screen), `heal(n)`, `die(cause)`; fields `stats` (see `baseStats()`: upgrade stats + relic stats `airJumps glide killHeal magnetMul oreMul goldMul regen hookSpeed firePick insurance`), `hp, facing, onGround, anim, animFrame, iframes, dead, grapple, airJumpsLeft, gliding`; getters `cx, cy, feetY, tileX, tileY, depth` |
| `grapple.js` | `new Grapple(game, player)` (owned by the player): `state` idle/flying/attached/retracting, `onPress()` (a press while retracting re-fires at once; while attached: `wantsClimb()` → `climb()`, else `release(false)`), `wantsClimb()` (standing, rope ≤ `GRAPPLE.climbMaxLength`, up held, or hanging slower than `climbStillSpeed`), `climb()` (release with the Saut boost, `refireT` re-fires at the top of the hop), `attaches` (count; `game.onGrappleAttach()` hook), `fire()`, `release(jump)`, `preMove/postMove/update`, `predicted` (reticle), `length`, `maxLength` (= max(range × `GRAPPLE.payOutMul`, length at attach)), pure helpers `ropeConstrainVelocity`, `ropeCorrection`, `aimAssist`. Attach keeps the real distance (no yank when catching a fall); the reel-in pull only applies while up is held; positional correction is capped at `GRAPPLE.maxCorrection` px/tick |
| `render.js` | `Renderer` presents by **CSS upscale**: the `#game` canvas is W×H internal px, its CSS size W·scale/dpr × H·scale/dpr (offsets via `left/top`), `image-rendering: pixelated` does the ×scale; `?canvasscale` restores the old device-pixel canvas + per-frame `drawImage` upscale. Chunk cache: `_syncDirty(world)` patches the 3×3 cells around each logged tile change in cached chunks (`_patchCells`, `_drawCell`), a full `_buildChunk` only for new / stale chunks; `_prefetch` keeps a one-chunk ring around the view cached (one build per frame at most, only in frames that built nothing); counters `chunkBuilds`, `cellPatches`. `Camera`: `update(dt)`, `snap()`, `shake(px, s)`, `bottomBand()` (internal px hidden by the thumb buttons, 0 without touch controls; the boss framing lifts the arena floor above it, cropping ≤ `BOSS.cameraMaxCrop` px of ceiling), `renderPos(alpha, out?, anchorX?, anchorY?)` (with an anchor: `round(a) - round(a - cam)`, the renderer anchors on the interpolated player so the hero never shimmers; entities are drawn at `round(x) - camX` as before); `Renderer`: `resize(cssW,cssH,dpr)`, `render(alpha)`, `invalidateAll()` |
| `lighting.js` | `compute(camX,camY,w,h)` (reads lights, never clears them; glow splats use a precomputed 7×7 `KERNEL` and record their box `gx0..gy1`), `draw(ctx,camX,camY)` (additive glow pass only over that box, none when empty; the warm lantern tint is a canvas cached per radius), `clearDynamic()` (called at the start of every fixed tick by `updatePlaying`), `addLight(x,y,intensity,[r,g,b])` (pooled, no allocation; valid until the next tick, so lights stay on in 120 Hz frames without a tick, during hit-stop and pause; call it from any fixed-update code, e.g. `enemies.addLights`), `addStatic(...)`, `clearStatics()` |
| `sprites.js` | `loadSprites()`, `getSprite(name)`, `drawSprite(ctx,name,frame,x,y,flipX)` (x,y = anchor), `getTileTexture`, `getBackTexture`, `makeIcon(name,cssPx)`, `backdrop`. Preview every sprite: `tools/sprites.html` |
| `particles.js` | `spawn(kind,x,y,opts)`: `debris chip dust land spark ember blood poof glint smoke`; `update`, `draw`, `clear` |
| `audio.js` | `play(name,{volume,pitch,material})`, `setMuted/toggleMute`, `unlock()`, `setLayer(i)`, `suspend/resume` (`unlock`/`resume` wake the context from `suspended` and WebKit's iOS `interrupted` state; rejections are swallowed) |
| `hud.js` | `drawText(ctx,str,x,y,color,{align,outline,shadow,alpha})` (outlined / shadowed labels are cached as small canvases: one `drawImage` per label; `labelStats()`), `measureText` (glyphs incl. `≈ × — «» ← → ↑ ↓`); `tip(line1, line2, {key, life})` / `cancelTip(key)` / `tipActive` (onboarding panel under the top HUD row, one at a time, waits for banners and the tally; a newer tip cuts one read for 3 s); `Hud`: `toast(text,{color,sub,life,icon})` (queued: 3 on screen, 8 waiting, duplicates refreshed), `banner(title,sub)`, `tally(bankSummary)` (banking panel, counts up with coin ticks, then `bank` sfx), `tallyActive`, `flash(color,dur)`, `flashDamage()`, `setHint(text)`, `reset()` (new world). Number texts are cached (`TextMemo`): no string building per frame |
| `debug.js` | flags `?debug ?god ?seed= ?depth= ?gold=` (run gold) `?bank=` (banked gold) `?autostart ?mute ?nosw ?canvasscale`; `window.__gouffre` (see "Debug API") |
| `meta.js` | save (`defaultSave`, `migrateSave`, `loadSave`, `loadSaveEx → {save,status}`, `saveGame`, `clearSave`, `storageAvailable`, `exportSave(save) → 'GOUFFRE1:<base64>'`, `importSave(text) → save|null`), `forfeitLoot(save, run, stats)` ("Corde de secours"), Forge (`UPGRADES`, `UPGRADE_KEYS`, `TIER_NAMES`, `upgradeCost`, `canBuy`, `buyUpgrade`), relics (`RELICS`, `RELIC_KEYS`, `rollRelic(rnd, layer, owned)`), `applyUpgrades(player, save, relics?)`, loot (`bagValue`, `bankLoot(save, run, stats, { newTrip = true })`, `settleDeath`, `clearLoot` — also resets `run.bagValue`, the HUD estimate) |
| `entities.js` | `EntityManager`: pickups (coins, hearts, ore chunks), chests, popups — see "Economy & meta loop" |
| `tips.js` | `Coach(game)`: onboarding tips `TIPS` (touch / keyboard / gamepad texts), remembered in `save.tips` (`TIP_KEYS`), off with `save.settings.tips = false`; events `onAttach / onOre / onBank / onDigDown`; `update(dt)` (tips + stuck detector, `STUCK` tuning), `canRescue`, `resetStuck()`, `show(key)`, `markSeen(key)` |
| `ui.js` | `showTitle({…, touch, installHint}) / showSettings / showPause({…, canAbandon, canRescue, onRescue}) / showShop / showDeath / showVictory / showControls(onBack) / showTransfer`, `hide()`, `refresh()`, `notice(text, life)`, `back()`, `activate()`, `move(dx,dy)`, `relayout()`; `causeText(cause)`. Buttons press on the **pointerup of the finger that went down on them** (works while another finger rests on the stick; browsers only turn single-finger taps into clicks) and on click for mouse / keyboard (a click within 700 ms of a touch press is ignored) |
| `main.js` | builds the `game` context (below), loop, resize, states, meta hooks (bank, death, victory, purchases) |

### The `game` context
`game.{world, gen, player, camera, input, audio, particles, lighting, renderer, hud, ui, enemies, entities,
save, saveStatus, run, runActive, deathInfo, victoryInfo, state, time, flags, safe, hitStopTicks}` and hooks
`game.hitStop(s)` (whole fixed ticks, at least 1: 0.05 s = 3 ticks, 0.018 s = 1), `game.toast(text, opts)`,
`game.tileBroken(tx,ty,id,cause)` (FX, drops, then `world.clearDetachedDeco`), `game.onPlayerDeath(cause)`,
`game.onBossDefeated()`, `game.setState(s)`, `game.newWorld(seed)`, `game.newRun(seed)`, `game.startGame(seed)`,
`game.fixedStep(dt)`; step 2b: `game.persist()`, `game.refreshStats()` (base → upgrades → run relics; a larger
max HP heals the gain), `game.buy(key)`, `game.bank()`, `game.abandonRun()`, `game.finishVictory()`,
`game.continueNgPlus()`, `game.toTitle()`, `game.eraseSave()`, `game.setMuted(b)` / `game.toggleMute()`.
Final audit: `game.coach` (tips.js), `game.rescue()`, `game.toggleTips()`, `game.importSave(text)`, hooks
`game.onGrappleAttach()` / `game.onOrePickup(key)`, `game.trapdoorT` (see "Final audit round").
`game.camera.shake` is wrapped by the "Secousses" setting. Review fixes: `game.bank(newTrip = true)`,
`game.requestPause()` (pause button / Échap / app hidden / portrait: during the death animation it opens the
death summary instead of a pause menu), `game.persist()` returns the `saveGame` result and the first failure
shows a notice once (`game.storageWarned`; also at boot when storage is unavailable), `game.onBossDefeated()`
does nothing when the run is over or the hero is dead.

`game.run = { seed, gold, bag: { oreKey: count }, bagCount, bagValue, relics: [], bestDepth, maxLayer, kills,
time, banked, ore, chests, ngPlus, bossDefeated, over, awayFromCamp, tripGold }` (`gold` = coins not yet banked,
`bagValue` = base value of the bag, `banked` = gold banked during this run, `over` = settled by a death / abandon /
victory, `awayFromCamp` = the hero left the camp zone since the last bank, `tripGold` = gold banked this trip).
`newWorld` creates the run **before** `enemies.reset` so enemies read `run.ngPlus` (copied from `save.ngPlus`).

### Fixed-update order (`updatePlaying`)
pause check (`requestPause`) → `lighting.clearDynamic` → `world.update` → `player.update` (input, grapple, move, strike) → `enemies.update` →
`entities.update` → `particles.update` → `camera.update` → `hud.update` → ambient FX → `enemies.addLights`
→ `run.time` / best depth → layer banner / music → Forge / chest proximity (context button, E) → **banking**
(feet ≤ `camp.bankY` with loot; a new trip only if the hero left the camp since the last bank) → **camp rest**
(`ECONOMY.campHealRate` × max HP per second while in the camp zone) → **trapdoor** (closes after 1 s on the camp
ground away from the shaft) → **coach** (tips, stuck detector) → victory timer → death timer.

## Enemies & combat

### `enemies.js`
- `ENEMY_DEFS[key]` = `config.ENEMY_STATS[key]` + `{ key, name, sprite, spr: [normal, flash, tele], alt: [...] }`
  (`alt` = bat hanging asleep / Guardian enraged; names precomputed so drawing never builds strings).
- `scaleStat(base, depth, 'hp'|'dmg', ngPlus)`: hp × (1 + d/60), dmg × (1 + d/80), × 1.5 in NG+.
- Pure helpers (tested): `spawnTileValid(world, key, tx, ty)` (worldgen placement rules), `anchorPoint(key, tx, ty, out)`,
  `findSpawnSpot(world, rnd, px, py, view, out)` (off-screen respawn tile 9–22 tiles away, layer of the tile,
  never camp / Heart / solid / lava), `lineOfSight(world, x0, y0, x1, y1)` (allocation-free DDA).
- `EnemyManager(game)`:
  - `reset(spawns)` instantiates every worldgen spawn (+ the Guardian), resets gates / boss state.
  - `spawn(key, x, y, { anchor, depth, minion, state })` → pooled `Enemy` (anchor semantics = worldgen records).
  - `update(dt)`: only enemies within `ENEMY_ACTIVE` (1.25 view widths × 1.5 view heights of the camera
    centre) think; far *respawned* enemies are recycled; then projectiles, then off-screen respawn
    (`ENEMY_SPAWNING`: interval + local cap per layer, global cap 72).
  - `damageInBox(box, dmg, fromX, { dir })` → hits (player's pickaxe; also deflects bones / fireballs).
    `hurt(e, dmg, fromX, opts)` (flash, knockback × (1 − kbResist), hit-stun, damage number popup, sfx),
    `kill(e)` (0.1 s white flash, hit-stop, then per-type burst + coins / heart).
  - `fire(type, x, y, vx, vy, dmg, life)` pooled projectiles (64): `bone` (ballistic), `fireball` (burns
    dirt/grass it hits), `shock` (runs on the floor), `warn` → `meteor` (boss fire rain).
  - `draw(ctx, camX, camY, alpha)`, `addLights(lighting)` (imps, ghosts, golem magma, boss, fireballs, warnings).
  - Boss: `boss`, `bossBar` (HUD data or null), `bossDefeated`, `gatesSealed`, `setGates(b)`,
    `playerInArena()`, `cameraFocusY` (the camera frames the whole arena while the gates are sealed).
  - `activeCount`, `count`.
- Contact damage: `player.takeDamage(e.dmg × mul, enemyX, { cause })` (i-frames, knockback and the
  armour reduction `stats.armor` live in `player.js`). No contact damage while an enemy is hit-stunned.

### Behaviours (`config.ENEMY_AI`)
| key | behaviour |
|---|---|
| slime | idles, squash telegraph, hops at the player (aggro 120 px), wanders otherwise |
| bat | sleeps on the ceiling (wakes at 76 px + line of sight or when its perch is mined), sine flight, flees after biting |
| skeleton | patrols, turns at ledges / walls, 0.55 s wind-up (red blink) then lobs a bone in an arc (hit it back with the pick to deflect) |
| spider | hangs on a thread, shakes then drops when the player passes below, scuttles in bursts, hops 1-tile steps |
| ghost | floats through walls toward the player, semi-transparent, faint blue light, drifts away after a hit |
| imp | hovers beside / above the player, 0.65 s charge (fireball grows in its hands, light) then fires; hitting it snuffs the shot |
| golem | slow heavy patrol, stomps (telegraph) then charges when level with the player; stunned on walls; resists knockback |

### Le Gardien de l'Abysse (`config.BOSS`)
Box 34 × 56 px (the 64 px sprite up to the head; only the horn tips stick out): contact, strikes and its blows
all use it. ≈ 2650 HP at d 272 (base 480): about a minute of fighting for a floor fighter with the 26-damage
pickaxe (bot: 55–60 s, 3 phases, every signature attack seen). Arena interior columns 9..62 (narrower than
the 72-column world, so the right wall stays left of the thumb buttons at every iPhone size).
Dormant (kneeling, dim) until the player is inside the arena interior → gates (`gate` tiles, rows
`outer.y0..+1` over the entrance) seal, banner, 2.2 s roar (invulnerable), boss bar fills. Attacks, each with
a wind-up pose + red telegraph blink: **every phase** claw swipe (close; sweeps the whole body height and
`swipeReachUp` above the head) and **rising claw** (`claw_wind` → `claw`: against a player above its shoulders
— on a rope, a platform or bouncing on its head — within `clawRange`; reaches `clawReach` above the head, never
a player standing on the floor); a Guardian blow knocks the player off the rope (`_bossHit`); **phase 1**
(100–66 %) ground slam sending a shockwave both ways (jump it; the fists hit anything beside the body);
**phase 2** (66–33 %) double slam, summons bats (skeleton too in phase 3; summons drop a heart 30 % of the time,
never coins); **phase 3** (< 33 %, enraged palette, orange light) fire rain (ceiling sigils + floor marks, a
meteor always above the player, gaps between them) and a charge across the arena (head down: its contact box
is `chargeDuck` px lower, so it can be jumped; stunned on the wall). Each phase **opens with its signature
attack** (`BOSS.signature`: phase 2 summons, phase 3 fire rain then a charge) and a single blow never carries
it past a threshold (HP clamped at 66 % / 33 %). Phase changes are 1.6 s invulnerable roars. Death (`kill`):
**truce** (`enemies.truce`: no contact / projectile / boss damage any more), minions die at once (no drops) and
every hostile projectile (bones included) vanishes; 3 s of explosions / flashes / sinking, white screen flash,
24 coins + 2 big hearts, gates reopen, then **`game.onBossDefeated()`** (once; ignored if the hero is dead).
Camera: `cameraFocusY` + `arenaFloorY` / `arenaTopY` (touch: floor lifted above the thumb buttons).

### Pickups (`entities.js`)
`spawnCoins(x, y, value, { count })` (value split exactly, ≥ 1 per coin), `spawnHeart(x, y, heal)`,
`spawnOre(x, y, key)`, `spawnDrop('heal' | 'ore:<key>')` (life crystal → heart of `DROPS.crystalHeal`; ore tile →
`ECONOMY.oreChunksPerTile` chunks), `popup(text, x, y, color)` (floating "+N" / damage numbers / ore names,
stacked when they would overlap). Pooled (`DROPS.maxPickups`, the oldest is recycled), gravity + bounce + ground
friction via `moveAndCollide`, magnetised within `DROPS.magnetRadius × stats.magnetMul` after `magnetDelay`
(then fly through walls), collected on touch: coins → `run.gold` × `stats.goldMul` (sfx `coin`), hearts heal
(only when hurt; otherwise they wait), ore chunks → backpack (only while it has room). Coins / hearts blink then
vanish after `DROPS.life` (40 s), ore chunks after `DROPS.oreLife` (300 s). Pickups farther than
`DROPS.activeScreens` (1.5 views) from the camera sleep. `pickups` / `pickupCount` for tests.

### Other hooks added
- `player.strike()`: a downward strike that hits an enemy in mid-air bounces the player (`PLAYER.pogoVel`).
- `hud.flash(color, dur)`, boss bar (top centre: name, phase notches at 66/33 %, damage trail, intro fill),
  `?debug` shows active/total enemies. The layer banner is skipped while the arena is sealed.
- `Camera._target` uses `enemies.cameraFocusY`. Flyers are kept below `SURFACE_Y + 2` (the camp is safe).
- Sprites: `enemy_<key>` (+ `_flash`, `_tele`), `enemy_bat_hang`, `enemy_guardian_rage`, `proj_bone`,
  `proj_fireball`, `proj_shock`, `proj_meteor`, `fx_warn`, `coin` (4 frames), `heart` (2), tile `gate`.
  Frame meaning per state: `EnemyManager._frame()`.
- SFX: `coin heal squish bat telegraph throw spider fireball charge fizz roar slam gate boss_hit boss_death`.
- Enemy kills heal the player when `stats.killHeal > 0` (Vampirisme, `EnemyManager._lifeSteal`, not minions).

## Economy & meta loop

### Loop
camp (Forge) → dig down → ore chunks fill the **backpack** (`run.bag`, capacity `stats.bagCapacity` units,
1 chunk = 1 unit worth the tile's `value`), coins fill the **run gold** → back in the camp zone
(`player.feetY <= gen.camp.bankY`, i.e. standing on the surface) with loot → **banking**: `meta.bankLoot`
converts bag value × `stats.oreMul` + run gold into `save.gold`, `game.persist()`, HUD tally ("Butin mis à
l'abri", count-up with coin ticks, then the `bank` "cha-ching") → spend at the **Forge** → repeat. Dying
(or "Recommencer l'expédition" in the pause menu) runs `meta.settleDeath`: the backpack + run gold are lost
except `floor(value × stats.insurance)`, which is banked at once; relics are lost; stats saved; after
`ECONOMY.deathDelay` (1.6 s of death animation) the DOM death summary; "Nouvelle expédition" = `game.newRun()`
(new random seed, full HP, camp, empty bag, no relics). The mine persists while the player lives.
Resting in the camp zone heals quickly (35 % of max HP per second, toast "Repos au camp"), so surviving a trip
always beats dying for a heal. Loot that lands while the hero is still in the camp after a bank (magnetised
coins in flight) is banked with `newTrip = false`: same trip (`stats.trips` once, `stats.bestTrip` = the trip
total), and the HUD tally on screen adds it up instead of restarting. Ore / hearts are re-checked per pickup
(two chunks on the same tick never overfill the bag, a second heart waits if the first one filled the HP).

### Save (`meta.js`, localStorage `gouffre.save.v1`)
`{ version: 2, gold, upgrades: { pick, vitality, armor, grapple, bag, lantern, boots, insurance },
stats: { bestDepth, deaths, totalGold, victories, runs, trips, kills, spent, playTime, bestTrip, rescues },
settings: { muted, shake, tips }, ngPlus, tips: { key: 1 } }` (`ngPlus` = NG+ level; `tips` = onboarding tips already
shown; older saves migrate with every tip unseen and `settings.tips = true`). `migrateSave` accepts anything: v1 (boolean
`ngPlus`), partial or hand-edited saves (numbers clamped / floored, unknown upgrades dropped, wrong types
replaced). `loadSaveEx().status`: `ok | new | corrupt | unavailable`; a corrupt save is copied to
`gouffre.save.v1.corrupt` and the title shows a notice; storage errors never throw (private mode:
the game plays, the settings panel says progress will not be kept). A first launch reads the pre-save
mute key (`gouffre.muted`). Saved on: banking, purchase, death / abandon, victory, settings, erase,
"Retour au titre", `visibilitychange` (hidden). The expedition itself (mine, bag, position) is not saved:
a reload starts a new one (unbanked loot is lost, no death counted).

### Forge (`UPGRADES`, costs re-based on the legal-play bot, see "Economy curve")
| key | name | levels (0 → max) | costs |
|---|---|---|---|
| `pick` | Pioche | tier 0/1/2/2/3/3, mining ×1/1.5/2/2.75/3.5/4.5, attack 10 + 4·lv | 45 / 300 / 1150 / 2500 / 5400 |
| `vitality` | Vitalité | max HP 60/75/95/120/150/185 | 20 / 90 / 360 / 850 / 1800 |
| `armor` | Armure | damage −0/7/14/21/28/35 % (`player.takeDamage`, cap 80 % with relics) | 35 / 150 / 540 / 1200 / 2400 |
| `grapple` | Grappin | range 96/128/160/192/220 px, reel 130/160/190/220/255 px/s | 25 / 110 / 450 / 1050 |
| `bag` | Sac | 10/16/24/34/46/60 ore units | 10 / 60 / 300 / 780 / 1700 |
| `lantern` | Lanterne | radius 6.5/8/9.5/11/12.5 tiles | 8 / 50 / 250 / 670 |
| `boots` | Bottes | speed ×1/1.08/1.16/1.25, jump velocity ×1/1.04/1.08/1.12 | 30 / 260 / 830 |
| `insurance` | Bourse de secours | 0/25/50 % of the unbanked loot kept on death | 90 / 950 |

The first level of Sac (10) and Lanterne (8) is always affordable after the first full bag, even of coal.

`applyUpgrades(player, save, relics)` rebuilds `player.stats` from `baseStats()`; main calls it in
`newWorld` and through `game.refreshStats()` after every purchase / relic. `buyUpgrade(save, key)` →
`{ ok, reason: 'gold'|'max'|null, cost, level }`. Each upgrade also has `effect(lv)` (Forge text), `desc`,
`icon` (`up_<key>` sprite) and the pickaxe `unlock(lv)` (rock unlocked by a new tier, `TIER_NAMES`).

### Chests & relics
Chests come from worldgen (`gen.chests`, `kind: 'relic'` 35 % / `'gold'`). Near a closed chest
`entities.interactionAt(player)` returns `{ label: 'Ouvrir', use }` (context button / E); a pickaxe strike
opens it too (`hitChests`). Gold chest: `ECONOMY.chestGoldBase × (1 + depth × chestGoldPerM)` = 7 × (1 + d/30)
in 8 coins (≈ a minute of mining at that depth: every new mine refills its chests, so looting then abandoning must
not out-earn digging; it was 16 × (1 + d/25), 3-4× mining).
Relic chest: `rollRelic` (weights per layer `ECONOMY.relicWeights` [common, uncommon, rare]: layer 1
6/3/1 … layer 4 3/3/4; never a duplicate; all owned → gold), a relic icon rises from the chest, toast with
icon + description, `run.relics.push(key)` + `game.refreshStats()`. HUD row of relic icons under the gold.

| key | name | rarity | effect (stat → where it is used) |
|---|---|---|---|
| `double_jump` | Double saut | rare | `airJumps` +1 → `player.update` (fresh press after coyote time; refilled on ground / rope) |
| `magnet` | Aimant | common | `magnetMul` ×2.4 → pickup magnet radius |
| `vampire` | Vampirisme | rare | `killHeal` 3 + 4 % max HP → `EnemyManager._lifeSteal` on kills |
| `fire_pick` | Pioche ardente | uncommon | mining and attack damage ×1.4, ember sparks on hits |
| `stone_skin` | Peau de pierre | common | `armor` +0.15 |
| `feather` | Plume | uncommon | `glide` → holding jump while falling caps the fall at `PLAYER.glideFall` (62 px/s) |
| `quick_hook` | Crochet éclair | uncommon | `hookSpeed` ×1.7, range +40 px, reel ×1.4 (`grapple.js`) |
| `spectral_lantern` | Lanterne spectrale | common | lantern radius +4 tiles |
| `frenzy` | Frénésie | uncommon | attack cooldown ×0.75 |
| `greed` | Avarice | common | `oreMul` / `goldMul` ×1.3 (banked ore, collected coins) |
| `troll_heart` | Cœur de troll | rare | `regen` 0.5 HP/s |

### Victory & NG+
`game.onBossDefeated()` → banner + toast, then after `ECONOMY.victoryDelay` (3.2 s) `game.finishVictory()`:
every coin on the ground is collected (`entities.collectAllCoins`), the loot is banked, `stats.victories++`,
saved, VICTORY screen (time, kills, gold brought back, deaths, victories, banked gold, relics).
"Continuer (NG+ n)" → `save.ngPlus = run.ngPlus + 1`, `newRun()`; enemies scale × (1 + 0.5 × level)
(`scaleStat(base, d, kind, level)`, `true` = level 1). "Retour au titre" → a fresh mine at the same level.
The HUD shows `NG+n` under the depth gauge.

### Menus (`ui.js`, DOM overlays, styles in `index.html`)
- **Title**: "Jouer" (fresh save) / "Continuer" (sub-line: "Expédition en cours · −X m" to resume the
  in-memory run, else "Or banqué : N · record −X m" to start a new one), "Réglages", stats line, then the
  controls line (keyboard on desktop, `.keys-touch` "Joystick à gauche…" on touch) and, in a Safari tab on a touch
  device (not `navigator.standalone` / `display-mode: standalone|fullscreen`), the install hint
  "Safari : Partager → « Sur l'écran d'accueil »…". The primary button keeps `data-act=play`.
- **Réglages** (2-column grid): Son, Secousses (camera shake), Astuces (off hides the tips; back on shows them all
  again), Commandes, Transférer, "Effacer la sauvegarde" → confirmation panel ("Effacer définitivement" /
  "Annuler"); settings survive an erase. Storage notice when unavailable.
- **Commandes** (`showControls`, from Réglages and Pause): touch / keyboard / gamepad columns (touch first on
  touch devices), Retour in the header; fits 750×342.
- **Transférer** (`showTransfer`): read-only code `GOUFFRE1:<base64 JSON>` + "Copier le code" (clipboard API, then
  `execCommand('copy')`), a paste field and "Importer" (a first press asks, a second replaces the progress; this
  device's settings are kept; invalid code → "Code invalide."). Keys typed in the fields never reach the game or
  the menu navigation (`ui._onKey` / `input._typing`).
- **Pause**: run line (depth, bag, unbanked gold, relics), Reprendre, **"Corde de secours"** (only when
  `coach.canRescue`; confirmation like abandon → `game.rescue()`), row Son | Commandes, row "Recommencer
  l'expédition" (confirmation, then the abandon death flow; hidden while the beaten Guardian dies) | "Retour au titre"
  (the run stays in memory). A pause request during the death animation opens the death summary instead.
- **Confirmations** ("Effacer la sauvegarde", "Recommencer l'expédition"): "Annuler" (primary, default) above the
  red button, which stays disabled for 550 ms (`CONFIRM_ARM`) and is pushed down if it would sit under the finger
  that opened the panel (`_keepClear`): a double / triple tap can never confirm.
- **Forge**: header (title, banked gold pill, Retour), 2-column grid of 8 cards (icon, level pips, name,
  description when the screen is tall enough, current effect, "→ next effect", buy button with cost:
  disabled when unaffordable or "MAX"), footer feedback ("Sac : niveau 1 ! 16 minerais", "Il te manque N or").
  Fits 750×342 CSS (iPhone 13 landscape in Safari) without scrolling; scrolls on its own if it ever overflows.
  Game paused while open (state SHOP); closes with Retour / Échap / E.
- **Death**: title (or "Expédition abandonnée"), "Mort à −N m · cause" (`causeText`; "au camp" at 0 m), lost ore /
  coins / relics (struck through; 5+ relics show as icons only under 420 px height), insurance share, gold banked
  this run, banked total, run stats,
  "Nouvelle expédition" (`data-act=restart`) / "Retour au titre".
- **Victory**: pixel "VICTOIRE" logo, stats grid, relics, "Continuer (NG+ n)" (`data-act=ngplus`), "Retour au titre".
- Keyboard: arrows / WASD move the focus spatially (wraps around), Entrée / Espace / Z / X press, Échap / P
  back (E closes the Forge). Captured at window level before `input.js` while an overlay is open, so menu
  keys never leak into the game. Gamepad: stick / D-pad move the focus, A / Y press (`ui.activate()`), Start / B
  back. Buttons: ≥ 44 px tall at every size (iOS minimum target), `touch-action: manipulation`; overlays pad
  with `env(safe-area-inset-*)` and **scroll** (`overflow-y: auto`, panel centred by `margin: auto`, so a panel
  taller than the screen, e.g. with the 21 px home-indicator inset of notched iPhones, never loses its title);
  compact sizes under 420 px height, tighter Forge spacing under 360 px so the pickaxe card's two-line "next
  level" (with the rock it unlocks) fits without scrolling (the Forge overlay keeps its own grid scrolling).

### HUD (`hud.js`)
Top left: HP bar; run gold; backpack icon + `n/cap` + fill gauge + `≈value` (× Avarice); relic icons. The boss
bar narrows so it never covers this block (Pro Max: 4-digit estimates).
Top right: depth + layer name + layer gauge (white = you, gold = run best, red = all-time record), or in the
camp "CAMP" + banked gold (counts up after a tally); `NG+n`. Boss bar top centre during the fight. Banner,
tally panel, queued toasts (with optional icon), damage vignette, desktop hint line ("E : FORGE", "E : OUVRIR").

### Economy curve (measured, then modelled)
Ore per mine (worldgen average, `npm run economy`): layer 1 130 tiles × 1.3 g = 169 g; layer 2 72 × 4.8 = 345 g;
layer 3 132 × 16.2 = 2143 g (geodes); layer 4 138 × 42.8 = 5919 g (ruby 36, mithril 60, denser veins + lava-crust
rubies: the Abyss out-earns the crystal caves, DESIGN §2). Chests: ~2 / 6 / 3 / 3 per layer.

**Measurement** (final audit): a headless bot drives the real modules (worldgen, world, player, grapple, enemies,
entities, meta, the tick order of `main.js`) with input injection only: digs, climbs with the grapple, fights, banks,
walks to the Forge and buys with the same policy as the model, dies and rerolls; human-like delays (0.5 s grapple
reaction, 0.33 s before each move, 15 s per Forge visit, 6 s per death screen); it knows the ores in the lantern
radius and ignores chests. 12 mines:

| milestone | median | range |
|---|---|---|
| first upgrade | trip 1, 0 h 01 | 0 h 00 - 0 h 07 |
| pickaxe tier 1 (bricks) | trip 3, 0 h 03 | 0 h 02 - 0 h 07 |
| pickaxe tier 2 (granite) | trip 12, 0 h 28 | 0 h 21 - 0 h 35 |
| pickaxe tier 3 = Guardian-ready (pick 4, vitality 4, armour 3, grapple 2) | trip 32, 1 h 50 | 1 h 36 - 2 h 08 |
| Guardian beaten | trip 37, 2 h 12 | 1 h 41 - 2 h 39 (1-5 tries, fights ~65 s) |

Per trip (bot, buying as it goes): layer 1 86 s / 27 g / 12 ores; layer 2 166 s / 99 g / 12.5 ores (2 % deaths);
layer 3 243 s / 502 g / 22 ores (0 %). At the boss-ready loadout, layer 3 gives ~145 g/min; a surviving layer-4 trip
300-360 g/min, but the bot dies on ~60 % of its layer-4 trips (fireballs, golems, lava), so its layer-4 average is
~120 g/min (240 vs 206 g/min when everything is maxed). Chest farming (open the chests above 100 m, bank, abandon,
repeat) now earns 9-27 g/min with the starting loadout, against 16-23 g/min of plain digging (it was 3-4×).

**Model** (`tools/economy.mjs`, `TRIP` calibrated on those numbers: 0.3 s/m down, 0.9 s/m up with the base
grapple, 2.4-4.8 s to the next ore, + the hit-stop tick per tile hit, 15 s per Forge visit, layer-2 ore 65 %
minable at hardness 0): first upgrade trip 1; tier 1 trip 3 (~4 min); tier 2 trip 10 (~28 min); tier 3 = Guardian
ready trip 27 (~1 h 45); everything maxed trip 35 (~2 h 31). Everything costs 24 463 gold. The unit test
`economy: simulated progression meets the balance targets` pins these targets (tier 1 trips 2-5, tier 2 9-16,
tier 3 24-38, Guardian-ready 1 h 35 - 2 h 45) and checks that layer 4 holds ≥ 1.5× the ore gold of layer 3.

### Debug API (`window.__gouffre`)
Core: `state, start(seed), newRun(seed), pause(), resume(), freeze(b), step(n), input.{set,tap,clear,layout,state},
player(), grapple(), tile(tx,ty), setTile(tx,ty,key), teleport(tx,ty), teleportDepth(d,tx), setGod(b), gen(), info(),
errors`. Combat: `spawnEnemy(key, dx, dy, { state, cd, anchor, y })`, `enemies(all)`, `clearEnemies()`,
`boss()` → `{ enemy, bar, gatesSealed, defeated }`, `hurtBoss(dmg)`, `killBoss()`, `pickups()` (kind
coin / heart / ore), `spawnCoins(dx, value, count)`. Economy: `run()` (seed, gold, bag, bagCount, bagValue,
relics, banked, ngPlus, over…), `save()` (copy), `setBank(n)`, `stats()` (player stats), `ui()` (overlay
name), `spawnOre(dx, key, n)`, `giveOre(key, n)`, `bank()`, `chests()`, `teleportToChest(i)`,
`giveRelic(key)`, `die(cause)`.

### Sprites & sounds added in step 2b
`relic_*` (11, 8×8 + outline), `up_*` (8 Forge icons, 12×12 + outline), `icon_bank`; existing `ore_<key>`,
`chest`, `chest_open`. Sounds reused: `pickup` (ore, pitch by value), `coin`, `bank`, `buy`, `chest`, `clink`
(bag full / cannot afford), `ui`.

## What's next (ideas)

- Persist the expedition in progress (mine diff + bag) so a reload resumes it.
- A bestiary / records page from the saved stats; per-layer music.
- Relic synergies and cursed relics; shop restock of consumables (bombs, ropes) at the camp.

## Final audit round (what changed and why)

- **Rendering**: the display canvas used to be device-resolution (2250×1026 on an iPhone 13) and received a full
  `drawImage` upscale every frame: in a 4×-throttled Chromium that copy alone capped the game at 37-42 fps. Now the
  canvas is the internal image and CSS scales it (WebKit applies nearest filtering to canvas layers for
  `image-rendering: pixelated / crisp-edges`); measured at 4× throttle: camp 59.7 fps (24 with `?canvasscale`),
  digging 59.7 (25.7), lava layer 59.3 (22.8). A broken tile patches 3×3 cells instead of rebuilding its chunk(s);
  lighting splats use a kernel and the glow pass is clipped to its box; the lantern tint is cached; outlined HUD
  labels are cached canvases (one draw call instead of 6 per glyph).
- **Camp**: planks (`trapdoor`, hp 1, tier 0) cover the shaft mouth; one strike opens all of them, and they close
  1 s after the hero stands on the camp ground a tile away from the shaft (never on a pickup or an enemy). The camp
  ground row (columns 15-56 except the trapdoor) and the headframe beam are locked (`World.locked`): the Forge, the
  spawn and the camp anchor always work ("Impossible ici" toast). The mine starts one row below.
- **Climbing**: Grappin pressed while attached climbs (hop with the Saut boost, re-fire at the top of the hop)
  when standing, on a short rope (≤ 40 px), with up held or hanging slower than 90 px/s; a real swing still lets
  go. Mashing Grappin now climbs a 10-deep 1-wide hole or the camp shaft (stick up: ~6-9 s); ledge assist lands
  the last hop when the stick pushes toward the rim.
- **Onboarding** (`tips.js`): controls → dig (on the trapdoor, or after 9 s idle in the camp) → grapple (5 m down)
  → climb (first rope catch) → bank (first ore) → Forge (after the first bank); each shown once, texts for touch /
  keyboard / gamepad, panel under the top HUD row (waits for banners / tallies, never covers the boss bar).
- **Stuck detector** (`STUCK`): below 2 m, no 40 px climb, no 4-tile drop and no 6-tile sideways move for 20 s
  with ≥ 4 jump / grapple presses → climbing reminder; 45 s and ≥ 6 presses → "Corde de secours" in the pause
  menu (camp, alive; unbanked loot lost minus insurance; relics, mine and death count kept; `stats.rescues`).
  A reachability search over thousands of dives found no position without a way up, so it is a safety net for
  players who have not found the climb, not a fix for real traps; it is not offered in the sealed boss arena.
- **Economy**: chest gold 7 × (1 + d/30) (was 16 × (1 + d/25)); layer-4 ore 24 ruby veins × 3-5 and 15 mithril
  veins × 2-4 plus lava-crust rubies (14 %), ruby 36 / mithril 60 (was 30 / 50); Sac 10 and Lanterne 8 for the
  first level; mid / late Forge costs ×~1.4; the economy model re-based on the bot (see "Economy curve").
- **PWA**: `sw.js` (`gouffre-v5`) deletes only `gouffre-*` caches and answers only from its own cache (GitHub
  Pages project sites share one origin).

## Known limitations / notes

- Base grapple range is 96 px (DESIGN value): many anchors are out of reach until upgraded; the reticle
  shows the predicted anchor. Climbing out of a hole is a sequence of short hops (Grappin, Grappin, …).
- Hole assist: an idle player slides into a 1-wide hole only when the body centre is over it (or right
  after digging it); standing on the rim is safe. Running over a 1-wide hole still drops you in
  (10 px body over a 16 px gap; the ledge assist only helps when you push toward the far rim while falling).
- The rope does not wrap around corners (DESIGN simplification). Rope pendulum is lightly damped.
- Nothing was run on a physical iPhone or in WebKit: the e2e suite and the throttled measurements use Chromium
  (software canvas). The CSS upscale relies on WebKit honouring `image-rendering: pixelated` on the canvas (its
  source does, for composited canvases too); if a device ever shows a blurry picture, `?canvasscale` restores
  the old present path. Safe-area insets are emulated in one e2e step only.
- Headless-Chromium timings at 4× CPU throttle: JS per frame p50 3.4-3.9 ms, p95 5.3-7.2 ms; the first frame
  of a new world still builds ~9 chunks (~10 ms unthrottled).
- Lighting is recomputed every frame over the view + 7-tile margin (~1200 cells); the emissive seeding is not
  cached between frames.
- Audio cannot be verified by tests beyond "no errors"; iOS unlock happens on the first tap / "Jouer".
- Unbanked loot is not saved: reloading the page during an expedition starts a new one (no death counted).
- Progress lives in `localStorage` only: iOS Safari may erase it after 7 days without a visit in a Safari tab;
  the home-screen app keeps it but has its own storage (hence the title hint and Réglages → Transférer).
- The economy curve is calibrated on a bot that knows the ores in its lantern radius and ignores chests; real
  players explore more (slower) and loot chests (faster). The bot dies often in layer 4, so the layer-4 balance for
  humans is an estimate.
- On very small landscape screens (iPhone SE, 667×375 CSS) the "Bourse de secours" card title is ellipsised
  (the pickaxe unlock text wraps on two lines and stays readable everywhere).
- Gamepad support is basic (standard mapping only); the Forge's default pad focus is "Retour".
- Enemies that leave the active zone freeze where they are (even mid-air) until the camera comes back.
- The Guardian's arena walls are Heart bricks (hp 40, tier 3): a max-tier pick can dig out of the sealed
  arena; the boss keeps its state and the camera stops framing the arena while the player is outside.
- Headless-Chromium timings with ~20 active enemies: update ≈ 0.05–0.1 ms, enemy drawing ≈ 0.05 ms.
