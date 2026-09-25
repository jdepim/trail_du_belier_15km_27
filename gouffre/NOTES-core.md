# GOUFFRE — developer notes (engine, combat, economy)

The single developer reference. `DESIGN.md` stays the contract; its §14 / §14 bis / §14 ter list what
steps 1, 2a and 2b added or changed. Everything below is what exists **now**.

Run it: `npm run serve` then open `http://localhost:8080/index.html` (add `?debug` for FPS/keys).
Tests: `npm test` (153 unit tests, `node --test`) and `npm run test:e2e` (Playwright smoke, iPhone 13
landscape with touch, 35 steps incl. review regressions, combat, the boss fight and the whole meta loop,
screenshots in `tests/e2e/screenshots/`, git-ignored). Economy model: `npm run economy`.

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
| `world.js` | `new World(w,h)`: `types, back, damage, damaged[], chunkVersion, skyTop, version`; `get/set/setRaw`, `isSolid(tx,ty)`, `isSolidAt(px,py)`, `damageTile(tx,ty,dmg,tier) → {hit,broken,tooHard,tileId,ratio}`, `crackStage`, `update(dt)` (3 s regen), `rectSolid`, `rectHazard`, `clearDetachedDeco(tx,ty,onCleared?) → n` (called by `game.tileBroken`: roots/stalactites below, stalagmites/mushrooms/skulls above, unsupported cobwebs beside), `decoSupported(tx,ty)` |
| `worldgen.js` | `generateWorld(seed) → { world, spawns, chests, camp, arena, seed }` (see header comment for record shapes). Invariant (tested on 40 seeds): lava never has open space beside or below it (`crustExposedLava` runs after the arena vestibule is carved) |
| `physics.js` | `moveAndCollide(body, dt, world) → {onGround,hitCeiling,hitLeft,hitRight}` (body = `{x,y,w,h,vx,vy,cornerCorrection?}`, top-left AABB, sub-stepped), `raycast(world,x,y,dx,dy,max) → {x,y,tx,ty,dist,nx,ny}|null`, `touchingBelow` |
| `input.js` | `moveX/moveY`, `aimX/aimY/aimActive`, `pressed/held/released(a)`; actions `jump attack grapple interact pause`; `beginTick()/endTick()` (edge protocol), `inject({x,y,jump,...})`, `tap(a)`, `clearInjected()`, `setContextAction(label|null)`, `setControlsVisible(b)`, `getLayout()`, `poll()` (gamepad; a disconnected pad releases its stick + buttons). Sliding a finger between action buttons re-points the touch before releasing the old button. After `resetAll()` (pause/blur) a still-held arrow key comes back with its auto-repeat and a thumb still on the left half is adopted as a new stick on its next move |
| `player.js` | `new Player(game)`: `reset(cx,feetY)`, `teleport`, `update(dt)`, `strike()` (enemies, then chests via `entities.hitChests`, then tiles), `strikeBox(dir)`, `takeDamage(amount, sourceX, opts) → bool` (`opts.cause` feeds the death screen), `heal(n)`, `die(cause)`; fields `stats` (see `baseStats()`: upgrade stats + relic stats `airJumps glide killHeal magnetMul oreMul goldMul regen hookSpeed firePick insurance`), `hp, facing, onGround, anim, animFrame, iframes, dead, grapple, airJumpsLeft, gliding`; getters `cx, cy, feetY, tileX, tileY, depth` |
| `grapple.js` | `new Grapple(game, player)` (owned by the player): `state` idle/flying/attached/retracting, `onPress()` (a press while retracting re-fires at once), `fire()`, `release(jump)`, `preMove/postMove/update`, `predicted` (reticle), `length`, `maxLength` (= max(range × `GRAPPLE.payOutMul`, length at attach)), pure helpers `ropeConstrainVelocity`, `ropeCorrection`, `aimAssist`. Attach keeps the real distance (no yank when catching a fall); the reel-in pull only applies while up is held; positional correction is capped at `GRAPPLE.maxCorrection` px/tick |
| `render.js` | `Camera`: `update(dt)`, `snap()`, `shake(px, s)`, `renderPos(alpha, out?, anchorX?, anchorY?)` (with an anchor: `round(a) - round(a - cam)`, the renderer anchors on the interpolated player so the hero never shimmers; entities are drawn at `round(x) - camX` as before); `Renderer`: `resize(cssW,cssH,dpr)`, `render(alpha)`, `invalidateAll()` |
| `lighting.js` | `compute(camX,camY,w,h)` (reads lights, never clears them), `draw(ctx,camX,camY)`, `clearDynamic()` (called at the start of every fixed tick by `updatePlaying`), `addLight(x,y,intensity,[r,g,b])` (pooled, no allocation; valid until the next tick, so lights stay on in 120 Hz frames without a tick, during hit-stop and pause; call it from any fixed-update code, e.g. `enemies.addLights`), `addStatic(...)`, `clearStatics()` |
| `sprites.js` | `loadSprites()`, `getSprite(name)`, `drawSprite(ctx,name,frame,x,y,flipX)` (x,y = anchor), `getTileTexture`, `getBackTexture`, `makeIcon(name,cssPx)`, `backdrop`. Preview every sprite: `tools/sprites.html` |
| `particles.js` | `spawn(kind,x,y,opts)`: `debris chip dust land spark ember blood poof glint smoke`; `update`, `draw`, `clear` |
| `audio.js` | `play(name,{volume,pitch,material})`, `setMuted/toggleMute`, `unlock()`, `setLayer(i)`, `suspend/resume` (`unlock`/`resume` wake the context from `suspended` and WebKit's iOS `interrupted` state; rejections are swallowed) |
| `hud.js` | `drawText(ctx,str,x,y,color,{align,outline,shadow,alpha})`, `measureText` (glyphs incl. `≈ × — «»`); `Hud`: `toast(text,{color,sub,life,icon})` (queued: 3 on screen, 8 waiting, duplicates refreshed), `banner(title,sub)`, `tally(bankSummary)` (banking panel, counts up with coin ticks, then `bank` sfx), `tallyActive`, `flash(color,dur)`, `flashDamage()`, `setHint(text)`, `reset()` (new world). Number texts are cached (`TextMemo`): no string building per frame |
| `debug.js` | flags `?debug ?god ?seed= ?depth= ?gold=` (run gold) `?bank=` (banked gold) `?autostart ?mute ?nosw`; `window.__gouffre` (see "Debug API") |
| `meta.js` | save (`defaultSave`, `migrateSave`, `loadSave`, `loadSaveEx → {save,status}`, `saveGame`, `clearSave`, `storageAvailable`), Forge (`UPGRADES`, `UPGRADE_KEYS`, `TIER_NAMES`, `upgradeCost`, `canBuy`, `buyUpgrade`), relics (`RELICS`, `RELIC_KEYS`, `rollRelic(rnd, layer, owned)`), `applyUpgrades(player, save, relics?)`, loot (`bagValue`, `bankLoot`, `settleDeath`, `clearLoot`) |
| `entities.js` | `EntityManager`: pickups (coins, hearts, ore chunks), chests, popups — see "Economy & meta loop" |
| `ui.js` | `showTitle / showSettings / showPause / showShop / showDeath / showVictory`, `hide()`, `refresh()`, `notice(text)`, `back()`, `activate()`, `move(dx,dy)`, `relayout()`; `causeText(cause)` |
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
`game.camera.shake` is wrapped by the "Secousses" setting.

`game.run = { seed, gold, bag: { oreKey: count }, bagCount, bagValue, relics: [], bestDepth, maxLayer, kills,
time, banked, ore, chests, ngPlus, bossDefeated, over }` (`gold` = coins not yet banked, `bagValue` = base value
of the bag, `banked` = gold banked during this run, `over` = settled by a death / abandon / victory).
`newWorld` creates the run **before** `enemies.reset` so enemies read `run.ngPlus` (copied from `save.ngPlus`).

### Fixed-update order (`updatePlaying`)
pause check → `lighting.clearDynamic` → `world.update` → `player.update` (input, grapple, move, strike) → `enemies.update` →
`entities.update` → `particles.update` → `camera.update` → `hud.update` → ambient FX → `enemies.addLights`
→ `run.time` / best depth → layer banner / music → Forge / chest proximity (context button, E) → **banking**
(feet ≤ `camp.bankY` with loot) → victory timer → death timer.

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
Dormant (kneeling, dim) until the player is inside the arena interior → gates (`gate` tiles, rows
`outer.y0..+1` over the entrance) seal, banner, 2.2 s roar (invulnerable), boss bar fills. Attacks, each with
a wind-up pose + red telegraph blink: **phase 1** (100–66 %) claw swipe (close) / ground slam sending a
shockwave both ways (jump it); **phase 2** (66–33 %) double slam, summons bats (skeleton too in phase 3);
**phase 3** (< 33 %, enraged palette, orange light) fire rain (ceiling sigils + floor marks, a meteor always
above the player, gaps between them) and a charge across the arena (stunned on the wall). Phase changes are
1.6 s invulnerable roars. Death: 3 s of explosions / flashes / sinking, white screen flash, 24 coins + 2 big
hearts, minions and hazards vanish, gates reopen, then **`game.onBossDefeated()`** (once).

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

### Save (`meta.js`, localStorage `gouffre.save.v1`)
`{ version: 2, gold, upgrades: { pick, vitality, armor, grapple, bag, lantern, boots, insurance },
stats: { bestDepth, deaths, totalGold, victories, runs, trips, kills, spent, playTime, bestTrip },
settings: { muted, shake }, ngPlus }` (`ngPlus` = NG+ level). `migrateSave` accepts anything: v1 (boolean
`ngPlus`), partial or hand-edited saves (numbers clamped / floored, unknown upgrades dropped, wrong types
replaced). `loadSaveEx().status`: `ok | new | corrupt | unavailable`; a corrupt save is copied to
`gouffre.save.v1.corrupt` and the title shows a notice; storage errors never throw (private mode:
the game plays, the settings panel says progress will not be kept). A first launch reads the pre-save
mute key (`gouffre.muted`). Saved on: banking, purchase, death / abandon, victory, settings, erase,
"Retour au titre", `visibilitychange` (hidden). The expedition itself (mine, bag, position) is not saved:
a reload starts a new one (unbanked loot is lost, no death counted).

### Forge (`UPGRADES`, costs from `tools/economy.mjs`)
| key | name | levels (0 → max) | costs |
|---|---|---|---|
| `pick` | Pioche | tier 0/1/2/2/3/3, mining ×1/1.5/2/2.75/3.5/4.5, attack 10 + 4·lv | 45 / 300 / 750 / 1700 / 3600 |
| `vitality` | Vitalité | max HP 60/75/95/120/150/185 | 20 / 80 / 240 / 560 / 1200 |
| `armor` | Armure | damage −0/7/14/21/28/35 % (`player.takeDamage`, cap 80 % with relics) | 35 / 130 / 360 / 800 / 1600 |
| `grapple` | Grappin | range 96/128/160/192/220 px, reel 130/160/190/220/255 px/s | 25 / 100 / 300 / 700 |
| `bag` | Sac | 10/16/24/34/46/60 ore units | 15 / 60 / 200 / 520 / 1100 |
| `lantern` | Lanterne | radius 6.5/8/9.5/11/12.5 tiles | 12 / 50 / 170 / 450 |
| `boots` | Bottes | speed ×1/1.08/1.16/1.25, jump velocity ×1/1.04/1.08/1.12 | 30 / 180 / 550 |
| `insurance` | Bourse de secours | 0/25/50 % of the unbanked loot kept on death | 90 / 650 |

`applyUpgrades(player, save, relics)` rebuilds `player.stats` from `baseStats()`; main calls it in
`newWorld` and through `game.refreshStats()` after every purchase / relic. `buyUpgrade(save, key)` →
`{ ok, reason: 'gold'|'max'|null, cost, level }`. Each upgrade also has `effect(lv)` (Forge text), `desc`,
`icon` (`up_<key>` sprite) and the pickaxe `unlock(lv)` (rock unlocked by a new tier, `TIER_NAMES`).

### Chests & relics
Chests come from worldgen (`gen.chests`, `kind: 'relic'` 35 % / `'gold'`). Near a closed chest
`entities.interactionAt(player)` returns `{ label: 'Ouvrir', use }` (context button / E); a pickaxe strike
opens it too (`hitChests`). Gold chest: `ECONOMY.chestGoldBase × (1 + depth × chestGoldPerM)` in 8 coins.
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
  in-memory run, else "Or banqué : N · record −X m" to start a new one), "Réglages", stats line.
  The primary button keeps `data-act=play`.
- **Réglages**: Son, Secousses (camera shake), "Effacer la sauvegarde" → confirmation panel
  ("Effacer définitivement" / "Annuler"); settings survive an erase. Storage notice when unavailable.
- **Pause**: run line (depth, bag, unbanked gold, relics), Reprendre, Son, "Recommencer l'expédition"
  (confirmation, then the abandon death flow), "Retour au titre" (the run stays in memory).
- **Forge**: header (title, banked gold pill, Retour), 2-column grid of 8 cards (icon, level pips, name,
  description when the screen is tall enough, current effect, "→ next effect", buy button with cost:
  disabled when unaffordable or "MAX"), footer feedback ("Sac : niveau 1 ! 16 minerais", "Il te manque N or").
  Fits 750×342 CSS (iPhone 13 landscape in Safari) without scrolling; scrolls on its own if it ever overflows.
  Game paused while open (state SHOP); closes with Retour / Échap / E.
- **Death**: title (or "Expédition abandonnée"), "Mort à −N m · cause" (`causeText`), lost ore / coins /
  relics (struck through), insurance share, gold banked this run, banked total, run stats,
  "Nouvelle expédition" (`data-act=restart`) / "Retour au titre".
- **Victory**: pixel "VICTOIRE" logo, stats grid, relics, "Continuer (NG+ n)" (`data-act=ngplus`), "Retour au titre".
- Keyboard: arrows / WASD move the focus spatially (wraps around), Entrée / Espace / Z / X press, Échap / P
  back (E closes the Forge). Captured at window level before `input.js` while an overlay is open, so menu
  keys never leak into the game. Gamepad: main calls `ui.activate()` / `ui.back()`. Buttons: ≥ 42 px tall,
  `touch-action: manipulation`; overlays pad with `env(safe-area-inset-*)`; compact sizes under 420 px height.

### HUD (`hud.js`)
Top left: HP bar; run gold; backpack icon + `n/cap` + fill gauge + `≈value` (× Avarice); relic icons.
Top right: depth + layer name + layer gauge (white = you, gold = run best, red = all-time record), or in the
camp "CAMP" + banked gold (counts up after a tally); `NG+n`. Boss bar top centre during the fight. Banner,
tally panel, queued toasts (with optional icon), damage vignette, desktop hint line ("E : FORGE", "E : OUVRIR").

### Economy curve (`npm run economy`, 8 seeds, 400 simulated players)
Ore per mine (worldgen average): layer 1 130 tiles × 1.3 g = 169 g; layer 2 72 × 4.8 = 345 g;
layer 3 132 × 16.2 = 2143 g (geodes); layer 4 45 × 37 = 1671 g. Chests: ~2 / 6 / 3 / 3 per layer.

| stage (typical loadout) | depth | ores | ore gold | coins | total | minutes | gold/min |
|---|---|---|---|---|---|---|---|
| start | −22 m | 10 | 13 | 14 | 27 | 2.8 | 10 |
| sac 1, pioche 1 | −68 m | 16 | 77 | 53 | 130 | 6.0 | 22 |
| sac 2, pioche 2, vita 1 | −138 m | 22 | 357 | 160 | 517 | 8.2 | 63 |
| sac 3, pioche 4, vita 2, armure 1 | −215 m | 15 | 556 | 492 | 1048 | 10.1 | 104 |

Progression (median [10th–90th percentile]): first upgrade after trip 1 (~2 min); pickaxe tier 1 (bricks,
layer 2) trip 3 [1–4] (~8 min); tier 2 (granite, layer 3) trip 9 [8–11] (~41 min); tier 3 (basalt, layer 4)
trip 22 [21–24] (~2 h 01); Guardian reachable (pick 4, vitality 4, armour 3, grapple 2) ~2 h 08 [2 h 01–2 h 17]
plus the attempts it takes; everything maxed trip 31 (~3 h 16). Everything costs 16 622 gold.
Model assumptions (in `TRIP` at the top of the tool): travel 0.75 s/m down + 1.7 s/m up (faster with grapple /
boots, ×0.7 when tunnels are reused), 45 s overhead, search 6/9/6/10 s per ore by layer (lantern helps),
150 s mining budget, 60 % of a layer's ore findable per mine, ~1.1 kills/min, 30 % chance per trip to open a
chest, death risk 8/16/22/28 % per trip by layer (−2.8 % per vitality / armour level), a depleted mine is
rerolled with "Recommencer l'expédition". The unit test `economy: simulated progression meets the balance
targets` fails if a cost change breaks the targets.

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
- Unbanked loot is not saved: reloading the page during an expedition starts a new one (no death counted).
- The economy curve is a model (see "Economy curve"); real players who explore more or die less progress faster.
- On very small landscape screens (iPhone SE, 667×375 CSS) long Forge labels are ellipsised.
- Enemies that leave the active zone freeze where they are (even mid-air) until the camera comes back.
- The Guardian's arena walls are Heart bricks (hp 40, tier 3): a max-tier pick can dig out of the sealed
  arena; the boss keeps its state and the camera stops framing the arena while the player is outside.
- Headless-Chromium timings with ~20 active enemies: update ≈ 0.05–0.1 ms, enemy drawing ≈ 0.05 ms.
