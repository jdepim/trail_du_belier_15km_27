# DÉRIVE — developer notes

`DESIGN.md` is the contract; this file documents what exists **now**, module by module. Each stage owns its
section. Tests: `npm test` (unit, `node --test`), `npm run test:e2e` (Playwright smoke), `npm run solver [seed]`
(progression proof, see below).

## Simulation

Everything that runs without a browser: `src/config.js, rng.js, tiles.js, world.js, structures.js, worldgen.js,
physics.js, player.js, hazards.js, entities.js, meta.js`, the unit tests (`tests/unit/`) and `tools/solver.mjs`.
No simulation module draws, touches the DOM or keeps hidden mutable singletons: everything goes through the
`game` context. Units: world px (1 tile = 8 px, 1 m on screen = 8 px), px/s, px/s², seconds. Y grows downward
(north = smaller y). Angles in radians, 0 = east, π/2 = south (canvas convention).

### Boot / life cycle (what main.js must do)

```js
import { generateWorld } from './worldgen.js';
import * as meta from './meta.js';
const { save, status } = meta.loadSaveEx();          // status: ok | new | corrupt | unavailable
game.save = save;
game.gen = generateWorld(save.seed);                 // ~50 ms; once per session (again after erase / import)
game.world = game.gen.world;
game.world.applyMods(save.world.mods);               // opened doors, blasted rubble / rocks
game.fog = meta.decodeFog(save.fog);
game.player = new Player(game); game.hazards = new Hazards(game); game.entities = new Entities(game);
// every life (boot, respawn after death):
game.run = meta.createRun(save, game.run);           // run.lifeSeed re-rolls asteroids + debris
meta.applyUpgrades(game.player, save);               // BEFORE player.reset (reset fills to stats)
game.hazards.reset(game.gen, game.run.lifeSeed);
game.entities.reset(game.gen, game.run.lifeSeed);
game.player.reset(game.gen.spawn.x, game.gen.spawn.y);
```

`game.persist()` must write the live state into the save before `meta.saveGame(save)`:
`save.world.mods = world.exportMods(); save.fog = meta.encodeFog(game.fog); meta.flushRunStats(save, run)`.
After a purchase call `meta.applyUpgrades(player, save)` again (it clamps the current gauges, never refills).

Fixed step (DESIGN §13), one tick = `FIXED_DT` (1/60 s):
`input.beginTick()` → `player.update(dt)` → `hazards.update(dt)` → `entities.update(dt)` → particles / camera /
hud → fog (`meta.fogReveal(game.fog, player.x, player.y, FOG.revealR)`) → coach → timers → `input.endTick()`.
**The dock is handled by `entities.update`** (deposit + refill), main must not duplicate it.
The world itself is never regenerated on death: doors, rubble and broken rocks stay as they are in memory.

### The `game` context members the simulation reads

`game.world, gen, player, hazards, entities, input, save, run, flags (flags.god), time (only by tests)`.
`game.input` must offer `moveX, moveY` (thrust vector, norm 0..1, the player clamps above 1),
`held(a)`, `pressed(a)` (one-tick edge) for actions `boost brake action charge` (`map` / `pause` are main's).
`game.save.settings.assist === false` disables the inertia assist (anything else = on).
`game.run = { salvage, lifeSeed, time, distance, startedAt, deathsThisSession, flushedTime, flushedDistance }`
(`player.update` adds `time` and `distance` while alive; entities add `salvage`).

### Hooks called (all optional: the simulation checks they exist)

| Hook | Called by | When / args | What main should do |
|---|---|---|---|
| `game.audio.play(name, opts)` | all | one-shot sounds, table below; `opts = { volume 0..1, pitch, material }` | play it |
| `game.particles.spawn(kind, x, y, opts)` | all | table below; `opts = { vx, vy, nx, ny, count, power, r, material, color }` | spawn |
| `game.camera.shake(px, s)` | player, hazards | impacts > `PLAYER.impactShake`, boosts (1.5 px), flares hitting (3), explosions (≤ 7), death (6) | shake (respect the setting) |
| `game.hitStop(s)` | player, hazards | `HIT_STOP.impact` 0.05 / `explosion` 0.06 (only within 300 px) / `death` 0.1 | freeze whole ticks |
| `game.toast(text, opts)` | player, entities | explanatory messages (French), `opts.color` | queue a toast |
| `game.onPlayerDeath(cause)` | player.die | once per death; cause keys below | `meta.settleDeath`, persist, death screen after the drift |
| `game.onItem(key)` | entities | key item taken (`save.items[key]` already true, already persisted) | banner `ITEMS[key].name` / `.desc` |
| `game.onSatellite(id)` | entities | satellite activated (saved, salvage burst spawned, `reveal` called) | toast / tip |
| `game.onLog(key)` | entities | terminal read (every time; salvage + save only the first time) | open the `LOGS[key]` overlay (state `LOG`) |
| `game.reveal(x, y, r)` | entities | satellite: `r = FOG.satelliteR` (1600) | `meta.fogReveal(game.fog, x, y, r)` |
| `game.deposit()` | entities | every tick in the dock while `run.salvage > 0` | `meta.depositSalvage(save, run)` + persist + tally + `deposit` sound. Absent → the simulation deposits + persists itself |
| `game.persist()` | entities | after item, door, crate, satellite, first log read | save (see above) |
| `game.setState('SHOP')` | entities | Établi used | open the workbench |
| `game.victory()` | entities | Embarquer with the anchor | victory sequence, `meta.recordVictory(save, run, fogExplored)` |
| `game.tileBroken(tx, ty, id, cause)` | hazards.explode | every fragile tile broken (`id` = tile before, cause `'self'`) | debris FX (`TILES[id].colors`), tips |

The simulation never calls `game.banner`, `game.explosion` or `game.respawn`: main may implement
`game.explosion = (x, y, r, power, cause) => hazards.explode(x, y, r, power, cause)` for debug tools.
**The `opts` objects passed to `audio.play` / `particles.spawn` are reused buffers: read them synchronously, never keep them.**
Sounds the simulation emits must not be played again by the hooks (e.g. `onItem` must not replay `item`).

### Sounds emitted (`audio.play(name, { volume, pitch, material })`)

`boost`, `brake` (brake pressed), `deny` (boost on cooldown / not enough fuel, no charge left, locked door,
capsule without anchor), `fuel_empty` (tank just ran dry), `bump` (soft contact 25–95 px/s, material),
`impact` (hurting impact, volume ∝ speed, material `metal | rock | ice | glass`), `hurt` (i-framed damage),
`death`, `pickup_salvage` (pitch rises with value), `pickup_o2`, `pickup_fuel`, `pickup_repair`, `item` (fanfare),
`dock` (entering the dock), `door`, `crate`, `terminal`, `satellite`, `refill` (station / locker), `capsule`
(hatch), `charge_drop`, `charge_beep` (every 0.5 s, 0.25 s and pitch 1.4 in the last second), `charge_bounce`,
`explosion`, `rock_break`, `laser_on` (a barrier turns on near you), `vent` (a jet starts near you),
`turret_lock` (telegraph starts), `turret_fire`, `bolt_hit`, `turret_destroyed`, `flare_warn` (sun starts
pulsing, near), `flare` (ring leaves the core). Distance-attenuated ones already carry `volume`.
**Loops are presentation-driven** from state (the simulation never calls `setLoop`): thrust ∝ `player.thrust`,
brake while `player.braking`, heat crackle ∝ `hazards.heatLevel`, black-hole rumble ∝ `hazards.bhProximity`,
O2 alarm while `player.o2Low`, storm ∝ `hazards.stormIntensity`. `deposit`, `buy`, UI sounds: main / ui.

### Particles emitted (`particles.spawn(kind, x, y, opts)`)

| kind | where | opts used |
|---|---|---|
| `exhaust` | nozzle, ~40/s × throttle while thrusting | `vx, vy` particle velocity, `power` throttle |
| `brake` | front, every 3rd tick while braking | `vx, vy` |
| `boost` | nozzle | `vx, vy`, `count` 10 |
| `spark` | impact point (tiles, asteroids, lasers, bolts) | `nx, ny` surface normal, `count`, `power`, `material` (tile impacts) |
| `death` | astronaut | `vx, vy` corpse velocity, `count` 24 |
| `pickup` | collected pickup | `material` = pickup kind (`salvage o2 fuel repair`), `count` 5 |
| `item` | key item pad | `material` = item key, `count` 20 |
| `door` / `crate` | door centre / crate | `count` |
| `satellite` | satellite | `r` = reveal radius (radar ping wave) |
| `gas` | vent mouth, every other tick while blowing | `vx, vy` jet velocity, `nx, ny` direction, `r` jet half-width |
| `gas_warn` | vent mouth, sputter while warning | same as `gas` |
| `shelter` | obstacle hit point when a flare is blocked | `nx, ny` toward the sun, `count` 8 |
| `muzzle` | turret muzzle | `vx, vy` bolt velocity |
| `debris` | destroyed turret | `r`, `count` 14 |
| `rock` | split asteroid | `vx, vy`, `r` asteroid radius, `count` |
| `explosion` | blast centre | `r` blast radius, `power` (1 = a charge), `count` 30 |

### Player (`player.js`)

`new Player(game)`: `reset(x, y)`, `teleport(x, y)`, `update(dt)`, `damage(amount, cause, opts)` (→ bool;
`opts.continuous` for heat / asphyxia / storm: ignores and grants no i-frames, no hurt sound), `heal(n)`,
`refill(dt?)` (no dt = all full; with dt = dock rates `ECONOMY.dock`; charges always full if Explosives owned),
`impulse(ix, iy)`, `die(cause, { force })` (force = Balise de rappel even with `?god`), `hasItem(key)`.
`baseStats()` (exported) → `meta.applyUpgrades` builds `player.stats`.

| Field | Meaning |
|---|---|
| `x, y, prevX, prevY` | centre (interpolate with alpha) |
| `vx, vy, speed` | velocity px/s, `speed` = its norm (after the tick) |
| `r` | 5 px radius (sprite 16×16) |
| `angle` / `dir16` | facing (turns toward the stick at 12 rad/s) / `round(angle / (2π/16)) mod 16`, 0 = east, 4 = south, 12 = north |
| `thrust` | 0..1 throttle applied this tick (0 without fuel); `thrustX, thrustY` unit thrust direction (last one) |
| `braking` | retro-rockets firing this tick |
| `boostT` | > 0 during 0.3 s after a boost (big flame); `boostCd` > 0 = boost recharging (1.2 s) |
| `hull, o2, fuel, charges` | gauges; maxima in `stats.maxHull / o2Max / fuelMax / maxCharges` |
| `stats` | `{ maxHull, o2Max, fuelMax, rechargeRate, thrustAccel, cruiseSpeed, radarRange, magnetR, maxCharges }` |
| `iframes` | > 0 = invulnerable to shocks (blink); `hurtT` > 0 = hurt flash (0.25 s) |
| `dead, deadT, deathCause` | the corpse drifts (damped) after death |
| `gravX, gravY, gravMag` | gravity acceleration at the player (after the anchor multiplier) |
| `inDock` | inside the Albatros dock (no O2 drain, refill) |
| `fuelEmpty` | HUD « CARBURANT VIDE »; `o2Low` HUD « O2 BAS » (< 25 %) |

Controls: thrust = `thrustAccel × |stick|` toward the stick; thrust can never raise the speed above
`max(cruiseSpeed, current speed)` (it can still brake or steer above cruise). Fuel pays only for the velocity change
actually applied: holding the stick along the motion at cruise shows a pilot flame (`thrust = PLAYER.cruiseFlame`
0.25) and burns nothing, so the solar recharge keeps running (integration change, see Integration). Brake = 260 px/s² against the
velocity until the stop (12 u/s). Boost = +170 px/s toward the stick (or the facing if neutral), 22 u,
cooldown 1.2 s. Inertia assist (on by default): ×e^(−0.35 dt) without stick nor brake. Hard cap 420 px/s.
Tile bounces: restitution 0.35, 12 % of tangential speed lost; normal speed above 95 px/s hurts
`(v − 95) × 0.3` hull (cruise head-on ≈ 13, 300 px/s ≈ 61). O2 −1/s outside the dock; at 0 the hull loses 12/s.
Solar recharge 3 u/s (× Réservoir) after 1.5 s without burning fuel, × 3 within 1.15 × heatR of a sun.
Action (`pressed('action')`) → `entities.interact()`; Charge (`pressed('charge')`) → `hazards.dropCharge` just
behind the astronaut with its velocity (toast « Plus de charges… » when empty; nothing without Explosives).

Death causes (keys → `meta.DEATH_CAUSES` / `causeText(cause)`): `asphyxia`, `sun_a`, `sun_b` (core contact or a
fatal flare), `heat` (Brûlé vif), `bh_maelstrom`, `bh_charybde`, `impact` (tiles and asteroids), `laser`, `turret`,
`self` (own explosion), `storm`, `recall` (Balise de rappel: main calls `player.die('recall', { force: true })`).

### Hazards (`hazards.js`)

`new Hazards(game)`: `reset(gen, lifeSeed)`, `update(dt)`, `gravityAt(x, y, out)` (black holes × 0.25 with the
Ancre), `heatAt(x, y, shielded = owns heatshield)` (hull/s), `sunRechargeAt(x, y)`, `dropCharge(x, y, vx, vy)`,
`spawnAsteroid(mode, x, y, vx, vy, size)`, `explode(x, y, r, power, cause)` → broken tile count.
Exports `heatField(world, suns, x, y)` (unshielded, with zone insulation) and `ASTEROID_MODE { BELT 1, SPIRAL 2, FREE 3 }`.

HUD / FX flags (updated every tick): `heatAtPlayer` (hull/s actually applied, shield included; > 0 →
« SURCHAUFFE »), `heatLevel` 0..1 (= heatAtPlayer / 30: orange tint, crackle), `nearSun` (fuel recharge × 3),
`gravCritical` (« GRAVITÉ CRITIQUE »: gravity > `stats.thrustAccel`), `bhProximity` 0..1 (rumble, distortion;
from 900 px to the horizon), `stormIntensity` 0..1 (ramps over BOUNDARY.r ± 300: visual jamming),
`inStorm` (beyond BOUNDARY.r: « TEMPÊTE IONIQUE », 8 hull/s + push to the centre), `time`.

| Array | Record fields (renderer) |
|---|---|
| `suns[]` | `key name x y coreR heatR cause`, flare: `flareState` `'idle' \| 'warn' \| 'ring'`, `flareT` (s in the state; warn lasts `SUNS.flare.warn` = 1.5 s → pulse), `ringR` (current ring radius, from coreR to `ringMaxR` = 1.5 × heatR at 500 px/s; draw only in `'ring'`), `nextFlare` |
| `blackHoles[]` | `key name x y horizon diskR cause` (animate the accretion disk with `game.time`) |
| `moon` | `{ x, y, r }` (the rock itself is tiles) |
| `asteroids[]` (pool 64, check `active`) | `x y prevX prevY vx vy r size (0 S 6 px, 1 M 11 px, 2 L 18 px) angle spin variant (0..3) mode` |
| `bolts[]` (pool 32) | `active x y prevX prevY vx vy angle life` (slow turret shots, radius 3) |
| `turrets[]` | `id x y r angle alive deadT state ('scan' \| 'aim') telegraph (0..1 during the aim: laser sight / blink) sees cooldown` |
| `lasers[]` | `id x0 y0 x1 y1 vertical state ('off' \| 'warn' \| 'on') stateT (0..1 progress in the state) t`; the beam is the segment (x0,y0)–(x1,y1) between the emitter faces; warn = blink, on = deadly |
| `vents[]` | `id x y dirX dirY length halfWidth state ('off' \| 'warn' \| 'on') stateT t`; (x, y) = middle of the vent mouth on the tunnel wall, the jet is the rectangle `length × 2·halfWidth` along (dirX, dirY) |
| `charges[]` (pool 6) | `active x y prevX prevY vx vy r fuse fuseMax` (blink faster as `fuse` drops) |
| `explosions[]` (8) | `active x y r power t life` (FX: flash + shock ring, `t / life` progress) |

Rules: heat per sun `heatMax × ((heatR − d) / (heatR − coreR))^2` (840 at the core surface, 0 at 650 px), the two
suns add up, × 0.01 inside insulated zones (`ZONES[].sheltered`), × 0.06 with the shield (both retuned at
integration, see Integration). Core contact = death.
Flares every 12–20 s per sun (first after 4–12 s): 1.5 s warn, then a ring hits once for 25 (× 0.2 shield) unless
a solid tile lies on the segment sun → player. Black holes: horizon (+ half the player radius) = death.
Moving asteroids: kept around the player (window 1000 px, spawned ≥ 520 px away, recycled beyond 1250 px);
belt ones follow a counter-clockwise orbit around the centre (~30 px/s), spiral ones circle the Maelström and are
swallowed by it; split fragments are free and feel real gravity. Player collisions: mass-weighted bounce, damage
with the impact formula on the relative normal speed (per-asteroid 0.4 s cooldown). Explosions split L → 2 M,
M → 2 S, S → 2–6 salvage. Turrets (range 190 px, line of sight checked every 6 ticks): turn toward you, 0.7 s
telegraph, bolt 110 px/s for 14, cooldown 1.8 s, solid body; destroyed by a blast, back every life. Lasers:
off 1.6 s / warn 0.6 s / on 1.4 s, phases staggered by a third; a touch = 40 (i-frames) + push out. Vents: off
2.2 / warn 0.7 / on 1.6 s, 480 px/s² along the jet (player and charges), harmless by themselves. Charges:
2.5 s fuse, drift with the dropping velocity, bounce (0.5), feel gravity and vents; explosion `r` 40 px,
power 45 (damage `power × (1 − d/(r + 5))`), push up to 300 px/s within 64 px, chain other charges, push pickups.

### Entities (`entities.js`)

`new Entities(game)`: `reset(gen, lifeSeed)`, `update(dt)`, `interact()` → bool, `spawnSalvage(x, y, value)`
(burst of 1–3 pieces), `spawnPickup(kind, x, y, value, vx, vy, opts)`, `blastPush(x, y, r, power)`.

| Field | Record fields |
|---|---|
| `pickups[]` (pool 160) | `active kind ('salvage' \| 'o2' \| 'fuel' \| 'repair') value x y prevX prevY vx vy r (3) magnet loose t variant (0..3) spin cacheId` (a `cacheId` piece = a one-time cache: draw it bigger) |
| `items[]` | `id key x y taken` (pad glows while not taken; key = `keycard explosives heatshield anchor`, icons `ITEMS[key].icon`) |
| `satellites[]` | `id name x y active` |
| `terminals[]` | `id log x y read` |
| `doors[]` | `id x y tiles vertical tx0 ty0 tx1 ty1 open` (the tiles themselves switch `door_locked` → `door_open`) |
| `crates[]` | `id x y value opened` |
| `refills[]`, `lockers[]` | `id x y` |
| `workbench`, `capsule`, `dock` | `{ x, y }`, `{ x, y }` (hatch), `{ x0, y0, x1, y1 }` |
| `inDock` | player centre inside the dock rectangle |
| `interactable` | `null` or `{ kind, label, x, y, ref }` — the nearest usable thing in range; main calls `input.setContextAction(interactable ? interactable.label : null)` |

Labels: door / crate `Ouvrir`, terminal `Lire`, satellite `Activer`, refill `Ravitailler` (only when O2 or fuel
is not full), locker `Recharger` (only with Explosives and missing charges), workbench `Établi`, capsule
`Embarquer`. Ranges: 24 px (30 for doors and satellites). Key items are taken by **touching** their pad (12 px).
Pickups: magnetised within `stats.magnetR` (burst salvage from crates / satellites / logs / rocks homes in from
120 px after 0.45 s), fly through walls to the astronaut; consumables (O2 +40 s, fuel +50, repair +30) are only
taken when at least a quarter of their value is missing (otherwise they wait). Loose pieces drift with drag,
bounce on tiles, feel gravity and are swallowed by black holes. Debris fields (around Albatros, Colibri, Mistral,
Orion) are re-rolled from `lifeSeed` every life; consumables placed in the plans come back every life; caches
(`$`) and crates only once. Door without the keycard → toast « Porte verrouillée : il te faut une carte
d'accès. »; capsule without the anchor → « Trop de gravité pour s'arrimer : il te faut l'Ancre gravitationnelle. ».

### World, tiles, worldgen

- `World` (see header of `world.js`): `types`, `interior` (zone ids, `config.ZONES`: 0 space, 1 albatros,
  2 colibri, 3 orion, 4 helios, 5 ulysse, 6 mistral, 7 tycho; `ZONES[z].name` = place name, `.dark` = interior
  darkness layer, `.sheltered` = heat insulation), `get / set / isSolid / isSolidAt / zone / zoneAt /
  circleSolid / blast / applyMods / exportMods`, renderer tracking `version`, `chunkVersion[cy * chunksX + cx]`
  (chunks of 32 tiles), `dirtyLog` ring (512) + `dirtyCount` (same protocol as Gouffre: patch the 3×3 cells
  around each logged index). Out of bounds reads as hull.
- `tiles.js`: `TILES[id] { key name solid fragile floor door window breaksTo light lightColor sound colors deco }`,
  `TILE_ID.KEY`, lookup tables `SOLID FRAGILE FLOOR LIGHT`. Keys: `space hull hull_dark window floor grate wreck
  shuttle moon_rock moon_crater moon_dust moon_floor rubble asteroid asteroid_small ice door_locked door_open pad
  panel light solar_panel plating emitter vent hazard_floor`. Lights (`light > 0`): door_locked (amber),
  door_open (green), pad (cyan), panel (teal), light (white), emitter (red). Windows are solid but see-through.
- `generateWorld(seed)` → see the header of `worldgen.js` for every record shape. Extras beyond DESIGN §13:
  `structures` (px bounds per stamped plan), `gravitySources`, `caches`, `workbench`, `debrisFields`, `rubble`
  (the Tycho plug bounds), `pois[].{icon, radar, always, label}` (`poi_*` icon names, the Albatros is `always`
  shown with label `⌂`; `tycho` = the gallery mouth, `twins` / `tycho` have `radar: false`).

### Meta (`meta.js`)

Save (`derive.save.v1`): `{ version: 1, seed, items { keycard explosives heatshield anchor }, upgrades { o2 fuel
thrust hull radar magnet charges }, salvage, world { mods [[i, id]], crates [ids], satellites [ids], logs [keys],
taken [cache ids] }, fog '<base64>', stats { deaths time distance salvageTotal victories bestTime logsRead },
settings { muted assist shake tips }, tips {} }`. `loadSaveEx()` statuses as in Gouffre (corrupt text kept under
`derive.save.v1.corrupt`), `migrateSave` accepts anything, `exportSave → 'DERIVE1:…'`, `importSave(text) → save | null`.
Workbench: `UPGRADES[key] { name, icon ('up_<key>'), desc, max, costs, requires ('explosives' for charges), effect(lv) }`,
`canBuy(save, key) → { ok, reason: 'max' | 'salvage' | 'locked' | null, cost }`, `buyUpgrade` (mutates, caller
persists + `applyUpgrades`). Run: `createRun`, `lifeSeedFor`, `depositSalvage(save, run) → { amount, total }`,
`settleDeath(save, run, cause) → { cause, causeText, lost, time, distance, deaths, salvage }` (increments deaths,
flushes time / distance, zeroes `run.salvage`), `flushRunStats`, `recordVictory(save, run, explored) → { time,
deaths, explored, logs, logsTotal, salvageTotal, victories }`. Story: `LOGS[key] { title, text }` (9 logs),
`ITEMS[key] { name, desc, icon }`, `DEATH_CAUSES`, `causeText`, `POI_NAMES`. Fog: `createFog, fogReveal(fog, x, y, r)
→ new cells, fogRevealed(fog, x, y), fogCellRevealed(fog, cx, cy), encodeFog, decodeFog, fogExplored(fog) → %
of the sector disc, poiDiscovered(fog, poi)` (160 × 160 cells of 64 px).

### Tuning rationale

- **Gravity** `a = mu / max(r, rSoft)²` (linear inside rSoft), each source faded out between 75 % and 100 % of
  its influence radius. Maelström `mu = 63e6`: 175 px/s² at 600 px (≈ base thrust 170); the capsule hatch is
  at **336 px** (DESIGN said ~380) because a pure inverse square cannot give "= base thrust at 600 px" and
  "> max thrust + brake (272 + 260) at the module" at 380 px: at 336 px it is 558 px/s², and 139 px/s² with the
  Ancre (< 170). Suns 60 px/s² at 300 px; moon 25 px/s² at the surface (orbit speed ≈ 105 px/s).
- **Heat / thermal lock** (DESIGN §6.4): exponent 2, `heatMax` 840, observatory insulation × 0.01 (was 0.05),
  shield × 0.06 (was 0.1). The solver measures the damage-minimising route to the anchor at 420 px/s: **331 hull
  without the shield** (≥ 300 = 1.5 × the 200 max hull) and **19 with it** (≤ 40). With the original × 0.1 a
  shielded player at cruise lost ~65 hull on the way in and ~3 hull/s inside; `node tools/feel.mjs` now reports
  11–43 hull for a braking approach depending on the brake point. Heat reaches 10 hull/s only ~65 px inside
  the heat radius, so « SURCHAUFFE » warns early.
- **Economy**: one-time salvage ≈ 545 (33 crates ≈ 370 incl. ~160 in the Mistral, 5 caches ≈ 40, satellites
  6 × 15, logs 9 × 5) + debris ≈ 84 pieces × 2 per life + rock fragments; every upgrade costs 1565 in total.
- **Assist / impacts**: gentle assist so a new player stops by letting go; impacts only hurt above 95 px/s so
  cruising bumps (≤ 140) cost ~13 hull at worst, a 420 px/s crash ~100.

### Progression proof (`tools/solver.mjs`)

`node tools/solver.mjs [seed]` prints every §6.4 rule; `tests/unit/progression.test.mjs` runs it on two seeds.
Two grids bracket the real physics: *loose* (8 px cells, a non-solid tile is open, diagonals allowed — more
permissive than the 10 px astronaut, so "unreachable" proves a lock) and *strict* (16 px cells, 2 × 2 free tiles,
4 neighbours — the astronaut surely fits, so "reachable" proves a route; it also blocks any heat, gravity above
the base thrust and the storm). Exports: `solveProgression(gen)`, `reachable(gen, items, mode, x, y)`,
`thermalCost(gen, items, mode, x, y, { speed, mul })`, `buildGrid`, `flood`, `MAX_HULL`.

### Level design

Plans live in `structures.js` (one char = one 8 px tile; `STRUCTURES[key].rows`); `worldgen` stamps them with
the plan `anchor` (or centre) on the POI. Legend (`LEGEND`, also enforced by the tests):
` ` untouched (space, or moon rock inside the moon) · `~` forced open space · `.` floor · `:` grate · `_` plating
· `!` hazard-striped floor · `#` hull · `H` dark hull · `=` window · `W` wreck hull · `S` shuttle hull · `O` solar
panel · `D` keycard door (connected D = one door) · `E` laser emitter · `l` laser beam path · `U` turret ·
`P` equipment pad · `T` terminal · `C` crate · `R` refill station · `L` supply locker · `B` workbench · `K` dock
floor · `X` spawn · `A` capsule hatch · `*` ceiling light · `%` console · `o` O2 canister · `f` fuel cell ·
`+` repair kit · `$` salvage cache · `m` moon rock · `,` gallery floor · `r` rubble · `V` gas vent.
Corridors and openings are at least 3 tiles wide; every record is reachable on the strict solver grid (tested).

| Structure | Where | Content |
|---|---|---|
| **Albatros** (38 × 17, wreck hull) | centre | dock room (11 × 6 grate, spawn in it: deposit + refill), workbench east of the dock, captain's terminal (log `albatros`) on the north wall, consoles, an O2 canister, torn cargo room to the south-east (grate doorway, a cache and a crate), torn openings west (4 tall), east (4 tall) and south (two 4-wide gaps, one into the cargo room) |
| **Colibri** (52 × 15, white shuttle) | (+1450, −950) | open airlock at the stern (west, 3 tall), cargo bay with 5 crates, crew cabin north (O2), galley south (terminal `colibri`, fuel), long central corridor to the cockpit in the nose: **keycard pad** behind the windows, consoles |
| **Orion** (64 × 40, station) | (+3000, +1100) | **3 keycard doors** (north `orion:door0`, west `door1`, south `door2`) are the only openings; west corridor → hub (turret in the centre, lights, repair kit) → east corridor with a vertical laser → laser shaft (2 more barriers) → **armory** (explosives pad inside hazard stripes, 3 crates, cache, turret facing the shaft exit); NW control room (terminal `orion_command`, turret, windows, consoles) with a server room (crate) on its access corridor; SW crew quarters (terminal `orion_crew`, 3 crates, O2, windows); SE supply bay (**refill station**, **supply locker**, fuel, 2 crates) with an east storage room (2 crates, cache); north / south entry halls with windows |
| **Hélios** (23 × 13, observatory) | between the suns (+400, +3350) | openings north and south (4 wide, perpendicular to the sun axis), telescope windows facing each sun, **anchor pad** in the centre between two lights, terminal `helios`, crate, 2 repair kits, consoles; insulated (heat × 0.05 inside) |
| **Ulysse** (17 × 11, platform) | 336 px south of the Maelström | capsule (solid, windows on the nose, facing the hole) with its **hatch** on the deck, plating deck with railings open to the south, terminal `ulysse`, console |
| **Mistral** (53 × 13, cargo wreck) | (−3300, −2600) | bridge west (terminal `mistral`, windows, consoles), three cargo holds with **15 crates** (8–12 each), a torn gap in the middle of the hull (space), engine room east (cache, fuel), open stern |
| **Satellite** (7 × 5, ×6) | `sat1..sat6` | dark hull body + two solar wings; **Activer** within 30 px |
| **Tycho** (in Séléné, anchor = moon centre) | (−2900, +500), mouth on the east face | entrance tunnel from the east rim (4 tall) → **rubble plug** (3 × 4, 44–46 tiles from the centre) → antechamber (fuel) → tunnel north with a dogleg (vent blowing east) → long tunnel west (vents from the north and the south walls) with a side gallery north (terminal `tycho_miners`, cache, O2) → tunnel south (vent blowing east) → **central chamber** (heat-shield pad, terminal `tycho_chief`) → south pocket (O2, fuel, repair kit). The moon rim is bumpy (noise), with 16 craters (dust rims, dark floors) and crater-noise texture |

Belt (seeded): 26 static clusters (asteroid / ice cores with fragile `asteroid_small` fringes, some all-fragile)
in r 1980–2270 px, kept ≥ 220 px from structures and satellites; 8 shelter rocks around the twin suns (never on
the observatory's north / south approach lanes).

### Amendments to DESIGN.md (simulation)

- Capsule hatch 336 px from the Maelström (not ~380), see tuning rationale. (All amendments are collected in
  DESIGN.md §15.)
- The dock (deposit + refill + charges) is run by `entities.update`, not by main.
- Key items are taken by touch; consumables only when useful (≥ 25 % of their value missing).
- Turrets come back every life (not saved). `save.world.taken` holds the one-time cache ids.
- Belt asteroids follow guided orbits (not free gravity); fragments of split asteroids feel real gravity.
- Laser touch: 40 hull with i-frames and a push out of the beam (not continuous).
- Orion is 64 × 40 tiles. Extra POI record `tycho` (gallery mouth, not on the radar).
- `settleDeath(save, run, cause)` takes the cause and zeroes `run.salvage`.

## Presentation

Files: `src/sprites.js, render.js, render-config.js, particles.js, hud.js, mapview.js, audio.js`, `tools/sprites.html,
render-preview.html, shot.mjs, mapdump.mjs, icon.html, make-icons.mjs`, `icons/*.png`,
`tests/unit/presentation.test.mjs`. No module touches the DOM at import time (Node imports them in the tests);
everything is drawn in code and rasterised once by `loadSprites()` (~0.4 s in headless Chromium). Presentation
tuning lives in `src/render-config.js` (`config.js` stays the simulation's): light direction, backdrop, nebula
regions, darkness, FX strengths, particle pool, HUD layout, radar, map, audio mix.

### Rendering (`render.js`)

- `Renderer.resize(cssW, cssH, dpr)`: `scale = max(1, floor(deviceH / VIEW.targetHeight))`, internal
  `floor(device / scale)` (iPhone 13 landscape 750 × 342 CSS @3 → 562 × 256; 844 × 390 @3 → 633 × 292); the canvas is
  CSS-upscaled and centred (Gouffre method). Sets `game.view = { w, h, scale, cssToInternal, camX, camY }`
  (`camX / camY` = top-left of the last drawn frame, read by the HUD radar).
- `render(alpha)`: `TITLE` (or no world yet) → drifting starfield; `MAP` → `drawMap`; every other state → the world
  (frozen behind the DOM overlays when not ticking), with the HUD except in `VICTORY` (ui.js's opaque cinematic
  canvas covers it). It also **drives the audio**: loops from state (`thrust` = max(throttle, boost), `brake`,
  `heat` = `heatLevel`, `rumble` = `bhProximity`, `alarm` = `o2Low`, `storm` = `stormIntensity`, all 0 outside a
  live `PLAYING`) and the ambience zone (`title`, `victory`, `interior` in a dark zone, `selene` in Tycho or near the
  moon, `storm`, `maelstrom`, `twins`, `space`) + `audio.tick()` for its distant notes.
- Layer order: backdrop (3 star layers with incommensurate tiles 512 / 640 / 896, twinklers, regional nebulae
  cross-faded by distance to Séléné / the twins / the Maelström / the storm ring, neutral elsewhere) → tile chunks →
  panel LEDs + dock brackets → celestial bodies (below everything that moves, so the astronaut and asteroids stay
  visible over a corona or an accretion disk) → props, pickups, key items bobbing over their pads, turrets, charges,
  asteroids, gas jets → astronaut → lit particles → **interior darkness** → emissive layer (item glows and light
  shafts, satellite beacons, pickup glints, lasers, vent warnings, turret laser sights, bolts, charge LEDs + blast
  radius ring, MMU flames) → emissive particles → screen overlays (black-hole vignette, heat tint + orange edge glow,
  ion-storm static and glitch bands) → interaction brackets (+ `E : Ouvrir` / `Y : …` label without touch; the DOM
  pill names it on touch) → HUD.
- **Tile cache**: 32 × 32-tile chunks (256 px canvases, LRU of 48), built with the baked light direction (nearest sun
  within 1500 px, else `LIGHT_DIR`); `world.dirtyLog` patched cell by cell (3 × 3 around each change, same protocol
  as Gouffre, log overflow → full rebuild through `chunkVersion`); at most one prefetch build per frame, only in
  frames that built nothing. Every cell draws inside its own 8 × 8 square. Solid tiles get autotiled edges (outline,
  lit lip or shade by the light, rounded outer corners); floors get contact shadows; hazard stripes along doors;
  doors are drawn from 3-part sprites (red locked, green open) by orientation.
- **Darkness** (zones with `ZONES[].dark`): a tile-resolution light grid around the view — headlamp flood (path
  distance, cone `DARK.lampHalfAngle` ± soft edge + halo), tile lights (`TILES[].light / lightColor`) flooded with
  falloff, dynamic lights (lasers, bolts, charges, explosions, aiming turrets, warning vents, key items, MMU flame) →
  one `ImageData` darkness layer + one additive colour layer, smoothed ×8. Hull tiles facing space stay unlit; the
  per-zone base darkness is `DARK.zoneBase` (Tycho 0.62, others 0.82).
- Celestial: suns = 8 animated pixel frames (granulation noise circling, limb darkening) + additive dithered corona,
  white pulse during `'warn'`, the flare ring (glow + core) while `'ring'`, a faint dashed ring at `heatR`; black
  holes = 16 accretion-disk frames (black horizon, photon ring, differential rotation, orange → violet), bright motes
  in the disk area and faint dust spiralling in from 900 px (both stateless functions of time, R2 sequence).
- `Camera`: look-ahead `CAMERA.lookAheadVel × v` capped at `CAMERA.lookAhead`, exponential smoothing, shake (a weaker
  shake never overrides a stronger one), `renderPos(alpha, out, anchorX, anchorY)` pixel-snaps relative to the
  interpolated player so the astronaut never shimmers.
- Stats for tests / debug: `renderer.chunkBuilds`, `cellPatches`.

### Sprites (`sprites.js`)

API: `loadSprites()`, `getSprite(name) → { canvas, w, h, frames, ax, ay }`, `hasSprite`, `spriteNames`,
`drawSprite(ctx, name, frame, x, y, { flipX })` (anchor = centre unless set), `makeIcon(name, cssPx)` (PNG data URL,
integer-upscaled for the device pixel ratio, cached; `null` before `loadSprites` / without a DOM),
`getTileTexture(id, variant)`, `tileVariant(id, tx, ty)`, `tileVariantCount`, `getGlow(color, r)` (`GLOW_COLORS` ×
`GLOW_RADII`), `backdrop { layers, twinklers, starCols, nebula{neutral blue orange violet green}, staticNoise,
vignette, heatVignette }`, `celestial { sun{key: frames}, corona, disk{key: frames}, earth }` (ui.js uses
`celestial.earth` and `capsule_ship`).
Names: `astro` / `astro_hurt` / `astro_dim` (16 directions from a lit analytic model: white suit, orange visor, MMU
pack and hand controllers), `ast_<size 0..2>_<variant 0..3>` (16 rotation frames), `pk_salvage` (4) `pk_cache`
`pk_o2` `pk_fuel` `pk_repair`, `item_<key>` (+ alias `<key>`), `up_<key>` (+ alias `upg_<key>`), touch icons `brake
boost charge action map pause`, HUD minis `hud_hull hud_o2 hud_fuel hud_salvage hud_charge hud_charge_off` (+ aliases
`hull o2 fuel salvage`), `poi_*` (home shuttle station moon gallery sun observatory blackhole capsule wreck
satellite), `radar_arrow` (16), `crate` (closed / open), `terminal` (unread ×2, read), `refill`, `locker`,
`workbench`, `hatch` (locked / ready), `turret_base`, `turret_gun` (32), `turret_dead`, `charge_bomb` (LED off / on),
`bolt`, `door_h door_v door_open_h door_open_v` (3 parts), `capsule_ship`.
Tiles: textures cut from 8 / 16 / 32 / 64 px seamless blocks so surfaces read continuous (riveted hull plates with
vent / panel / weld variants, scorched wreck, white shuttle, tread plating, grates, faceted ice, boulder rubble,
cracked small-rock fringe). The moon uses its own calm 5-tone regolith palettes (64 px blocks sharing one base field,
per-variant craterlets kept inside the block); the gallery floor is darker than the rock.

### Particles (`particles.js`)

`new Particles(game?)` (struct of arrays, `PARTICLES.max` = 1400 slots, ring reuse when full; with `game`, debris
chunks bounce off solid tiles), `spawn(kind, x, y, opts)` (opts read synchronously), `update(dt)`,
`draw(ctx, camX, camY, pass)` (`'lit'` under the darkness, `'emissive'` additive over it, `'all'`), `clear()`,
`alive`. Kinds: every simulation kind (`exhaust brake boost spark death pickup item door crate satellite gas gas_warn
shelter muzzle debris rock explosion`; `spark.material` picks metal sparks / rock chips / ice or glass shards) plus
`tile` (broken-tile chunks, `material` = tile key), `smoke embers dust shards glint flash ring`. Styles: dot, streak,
smoke (grows), ring, flash (glow sprite), glint (cross), shard, chunk.

### HUD (`hud.js`)

`drawText(ctx, str, x, y, color, { align, outline, shadow, alpha, scale })` → width; `measureText(str)`. 5 × 7 bitmap
font from Gouffre (capitals, digits, French accents incl. Œ Ç, punctuation, arrows, ⌂); outlined / shadowed labels
cached as canvases per (style, colour, string). Pure helpers: `TextMemo`, `distLabel(px)` (precomputed `'125 m'`
strings, 1 m = 8 px, 5 m steps), `edgePoint(cx, cy, dx, dy, lim, out)`.
`Hud`: `update(dt)` (timers, toast queue, discovery cache every 0.4 s via `poiDiscovered`, zone names on entering an
interior zone, a `warning` chirp when a warning starts), `draw(ctx)`, `toast(text, { color, life, icon })` (3 on
screen, 8 queued, duplicates refreshed), `banner(title, sub, { icon })`, `tip(line1, line2, { key, life })` (one at a
time, waits for banners), `cancelTip(key)`, `tipActive`, `zoneName(name)`, `reset()`.
Layout: top-left hull / O2 / fuel bars with icons (width grows with upgrades, lagging hull trail, low values blink),
charges beside them once the Explosives are owned, `FERRAILLE 120 (+14)` (banked counts up after a deposit);
top-centre column: zone name / banner, blinking warnings (`O2 BAS`, `SURCHAUFFE`, `GRAVITÉ CRITIQUE`, `CARBURANT
VIDE`, `TEMPÊTE IONIQUE`), onboarding tip panel, toasts; red edge on hits and under 25 % hull. Radar arrows on the
screen border toward discovered or in-range POIs (`radar: true`, activated satellites dropped, the Albatros always),
with icon and distance, only the `RADAR.maxArrows` (6) nearest; they keep out of the top-centre column while it holds
text (its width follows the banner / zone name / warnings, `HUD_LAYOUT.topGapHalf` minimum) and, on touch screens,
out of the DOM controls (`HUD_LAYOUT.*Css`, CSS px × `view.cssToInternal`); an overlapping arrow slides along its
edge to the nearest free slot (`RADAR.slotW / slotH`) inside the edge limits, or is dropped.

### Map (`mapview.js`)

`drawMap(ctx, game, w, h)`, `invalidateMap()`, pure `mapLayout(w, h, safe)` / `worldToMap(layout, x, y)`. Square map
of the sector (terrain canvas 320² rebuilt when `world.version` changes) under the fog bitset (canvas 160², rebuilt
when the revealed-cell count changes; explored = lit navy, unexplored = near black), 1000 px grid, storm boundary,
belt ring once any belt cell is known, suns (heat disc) and black holes once discovered, discovered POIs with icons
and names (satellites: green dot once activated), the astronaut (pulsing ring + heading), legend (explored %,
satellites, logs, equipment owned / `???`, key).

### Audio (`audio.js`)

`createAudio()` → `{ play(name, { volume, pitch, material }), setLoop(name, level), setZone(key), setMuted, toggleMute,
muted, unlock, suspend, resume, tick }` + exports `SOUND_NAMES`, `LOOP_NAMES`, `ZONE_KEYS`. Copied from Gouffre's
audited unlock (context created in the first gesture, silent buffer, `_wake()` also resumes WebKit's `interrupted`
state, promise rejections swallowed). Every simulation sound has a recipe (`impact` / `bump` by material); shell
sounds `deposit buy ui ui_back map pause respawn victory tip warning log`. Loops: thrust (low-passed noise, brightness
∝ throttle), brake (high hiss), heat (crackle), rumble (sub sines + wobbling dark noise, ∝ level²), alarm (gated
880 Hz), storm (fluttering band-passed static). Ambience: detuned drone per zone (root, chord, filter, noise) + sparse
pentatonic notes. Repeats of one sound + material within 30 ms are dropped. The mute state is main's (save).

### Tools

- `tools/render-preview.html`: real worldgen + player / hazards / entities ticking with a scripted input, the
  Renderer, Particles and Hud, no shell. `?at=albatros|colibri|belt|orion|orion_in|selene|gallery|twins|helios|
  maelstrom|ulysse|satellite|mistral`, `dx dy seed t face move brake items touch hud explode dead state map
  reveal=all freeze dpr`.
- `node tools/shot.mjs "<page?query>" out.png [cssW cssH waitMs dpr clip]` (global Playwright; also exports
  `startStatic`, `launchBrowser`). Reference: `844 390 … 3` = 633 × 292 internal, `750 342 … 3` = iPhone 13.
- `tools/sprites.html?z=4&only=<prefix>`: every sprite frame, tile texture, glow, backdrop and celestial asset.
- `node tools/mapdump.mjs [seed] [out.png] [poiKey radiusPx]`: sector / POI crop PNG without a browser, records marked.
- `node tools/make-icons.mjs` (renders `tools/icon.html`): `icons/icon-180.png`, `icon-192.png`, `icon-512.png`,
  `icon-maskable-512.png` (astronaut fleeing the Maelström).

### Amendments (presentation)

- The renderer has no victory cinematic of its own: ui.js owns it (opaque canvas), the frozen world is drawn under.
- `Particles.draw` takes a 4th `pass` argument; `new Particles(game)` enables chunk bounces (main passes `game`).
- Reserved HUD areas are in CSS px (`HUD_LAYOUT.topRightCss / bottomRightCss / bottomLeftCss`), mirroring
  `input.js layout()`; change both together.

## Shell

Files: `index.html`, `manifest.webmanifest`, `sw.js`, `src/main.js`, `src/input.js`, `src/ui.js`, `src/tips.js`,
`src/debug.js`, `tests/e2e/server.mjs`, `tests/e2e/smoke.mjs`, `README.md`. Patterns copied from Gouffre (audited on
WebKit): CSS-upscaled canvas, safe-area probe, overlay scrolling, pointerup menu buttons, pad blocking, SW prefix.

### Boot and lives (`main.js`)

Boot: `loadSprites()` → systems (`Input`, `createAudio`, `Particles(game)`, `Camera`, `Hud`, `Player`, `Hazards`,
`Entities`, `Renderer`, `Coach`) → `loadSaveEx()` (+ `?seed` / `?bank` / `?items`) → mute setting → shake wrapper
(Réglages → Secousses wraps `camera.shake`) → `createUI` → `input.attach` → `resize()` → `installDebug` →
`game.newWorld()` → state `TITLE` (+ storage / corrupt notices) → `requestAnimationFrame`. The service worker is
registered only off localhost, not on `file:`, not with `?nosw` / `?debug`.

- `game.newWorld()`: `generateWorld(save.seed)`, `world.applyMods(save.world.mods)`, `decodeFog(save.fog)`
  (`?reveal` lifts it all), POI discovery flags, `renderer.invalidateAll()`, then `startLife()`. Called at boot and
  after Effacer / Transférer (never on death).
- `game.startLife()`: `createRun(save, run)` → `applyUpgrades` → `hazards.reset` / `entities.reset(gen,
  run.lifeSeed)` → `player.reset(spawn)` → particles / HUD / coach reset, Charge button visibility, `camera.snap()`.
- `game.startGame()` (title Jouer / Continuer): first time in the session `?at` / `?x&y` / `?salvage`
  (`debug.applyStartFlags`, true when it teleported), then the Albatros banner unless it teleported. It never
  unlocks the audio itself: the title button does it inside its gesture (`?autostart` has no gesture, so the
  context waits for the first touch / key instead of raising autoplay warnings).

### Game context and hooks

`game = { flags, state, time, fps, frozen, world, gen, player, camera, input, audio, particles, renderer, hud, ui,
hazards, entities, coach, save, run, fog, view, safe, hitStopTicks, deathT, deathInfo, victoryInfo, logKey,
mapReturn, lifeStarted, saveStatus, storageWarned }`. `game.safe` = safe-area insets in **internal** px
(`css × dpr / view.scale`); `input.setSafeArea` gets the CSS values.

| Hook | What main does |
|---|---|
| `hitStop(s)` | freezes `max(1, round(s / FIXED_DT))` whole ticks (input edges stay latched) |
| `toast / banner` | → `hud.toast / hud.banner` |
| `persist()` | `save.world.mods = world.exportMods()`, `save.fog = encodeFog(fog)`, `flushRunStats`, `saveGame`; first failure → notice « Stockage indisponible… »; resets the 20 s autosave timer |
| `deposit()` | `depositSalvage` + persist every call; the toast « Ferraille déposée : +N (total T) » and the `deposit` sound come once, 1 s after the last deposit of a trip (magnet pieces trickle in); then `coach.onDeposit()` |
| `reveal(x, y, r)` | `fogReveal(fog, …)` |
| `onItem(key)` | banner `ITEMS[key].name` / `.desc`; Explosives → Charge button shown + charge tip |
| `onSatellite` | toast + satellite tip |
| `onLog(key)` | state `LOG` (typewriter overlay), back to `PLAYING` on close |
| `onPlayerDeath(cause)` | `settleDeath` → `deathInfo`, persist, `deathT = 1.8 s` of corpse drift, then state `DEAD` |
| `victory()` | carried salvage deposited, `recordVictory(save, run, fogExplored(fog))` (+ `salvage`), persist, `victory` sound, state `VICTORY` |
| `setState(s)` | see below; `setState('SHOP')` from the workbench |
| `respawn()` | death overlay Repartir: `startLife()`, `PLAYING`, `respawn` sound, banner « BALISE DE RAPPEL » |
| `explosion(...)` | → `hazards.explode` (debug) |
| `tileBroken(tx, ty, id)` | `tile` particles (`material` = tile key: chunks in the tile's colours), `coach.onTileBroken` (rubble → « Passage dégagé » tip) |

Shell actions: `startGame, requestPause` (during the death drift → straight to `DEAD`), `recall` (Pause → Balise de
rappel: `player.die('recall', { force: true })`), `buy(key)` (`buyUpgrade` → persist → `applyUpgrades` → `buy`
sound; failure → `deny`), `setMuted / toggleMute / toggleAssist / toggleShake / toggleTips` (tips back on clears
`save.tips`), `importSave(text)`, `eraseSave()` (settings kept; both rebuild the sector and go to the title with a
notice), `fixedStep(dt)`.

### Loop and states

rAF frame: `input.poll()` (gamepad) → `PLAYING`: accumulator, up to 20 fixed ticks of `FIXED_DT`; other states:
menu input (pad D-pad → `ui.move`, B / Start / Échap → `ui.back`, A / Y → `ui.activate`, Select closes the map)
and `ui.update(dt)` (typewriter, cinematic) → `renderer.render(alpha)` (alpha = acc / FIXED_DT while playing, 1
otherwise). `frozen` (tests) stops the real-time loop; `__derive.step(n)` advances ticks.

Fixed tick (`updatePlaying`): `input.beginTick` → Pause / Carte buttons → `player.update` → `hazards.update` →
`entities.update` (runs the dock) → `particles.update` → `camera.update` → `hud.update` → every 4 ticks
`fogReveal(player, FOG.revealR)`, every 15 ticks place / ambience, every 30 ticks POI discovery toasts
(« Découvert : … ») → `input.setContextAction(entities.interactable.label)` → `coach.update` → deposit toast timer →
autosave (20 s) → death timer → `input.endTick`.

States: `TITLE` (starfield + title overlay), `PLAYING` (touch controls shown), `PAUSED`, `MAP` (renderer draws the
map, the DOM overlay only has Fermer; returns to the state it was opened from: Carte button → game, Pause → Carte →
pause), `SHOP`, `LOG`, `DEAD`, `VICTORY`. Leaving `PLAYING` hides the controls, clears the context button and
`input.resetAll()`. Saves: every event hook above, every 20 s while alive, on `visibilitychange` (hidden → pause +
persist + `audio.suspend`) and `pagehide`.

Audio: `Renderer.render()` drives the loops and the ambience zone from the state (NOTES "Presentation"), so main
never calls `setLoop` / `setZone`; main plays `deposit`, `buy`, `deny`, `respawn`, `victory`, `pause` / `map` (on
leaving the game for them), tips play `tip`, ui plays `ui` on every button press and `ui_back` on back.
Place names: interior zones are announced by the HUD; main names the open-space regions with `hud.zoneName`
(Le Maelström < 1100 px, Charybde < 600 px, Les Jumelles < heatR + 350 px of their middle, Lune Séléné < r + 350 px,
Ceinture de Charon r 1820–2430, Tempête ionique beyond BOUNDARY.r − 150), once per entry.

Shell timings live in `SHELL` at the top of `main.js` (autosave 20 s, death drift 1.8 s, deposit merge 1 s, fog /
place / discovery polling periods) because `config.js` belongs to the simulation.

### Input (`input.js`)

Actions `boost brake action charge map pause`; `moveX / moveY` = thrust vector, norm 0..1. Sources (priority):
injected stick > touch stick > gamepad stick > keyboard (diagonals normalised). Analog sources get a radial dead zone
(`TOUCH.deadZone` 0.18, full thrust at `fullTilt` 0.85).
- Touch: floating stick on the left half (radius 48 CSS px, the base follows a thumb pulled past 1.25 R, a thumb
  resting through `resetAll()` is adopted); round buttons Boost (bottom-right), Frein (left of it), Charge (above
  Boost, hidden until the Explosives: `setButtonVisible`), pill Action (`setContextAction(label | null)`, 124 × 46 CSS px, above
  Frein), square Carte and Pause top-right. Hit test with a 12 px pad (8 for the small buttons). Sliding a finger
  between round buttons switches them (never onto / off Carte or Pause); a button hidden under a finger is released.
- Keyboard by `event.code` (physical key, so WASD = ZQSD on AZERTY): arrows / WASD thrust, Shift / X brake, Space
  boost, E action, C charge, Tab / M (and the typed `m`, AZERTY) map, Échap / P pause. Directions are
  level-triggered (auto-repeat re-asserts them after a pause), actions edge-triggered; keys typed in text fields are
  ignored.
- Gamepad (standard mapping): stick / D-pad thrust, A boost, B / LT brake, X charge, Y action, Select map, Start
  pause; B also = menu back; buttons held through a state change are blocked until released (`padBlock`).
- Tests: `inject({ x, y, stick, <action>: bool })`, `tap(a)` (one tick), `clearInjected()`, `getLayout()`.

### Menus (`ui.js`, styles in `index.html`)

"Ship console" look: translucent night-blue panels with a cyan edge, sans-serif labels, monospace titles, ≥ 44 px
buttons (`data-act` attributes are the test hooks). Title (bitmap « DÉRIVE » logo from `hud.drawText`, Jouer /
Continuer with the salvage and equipment line, Réglages, stats, controls line, install hint in a Safari tab);
Réglages (Son, Assistance inertielle, Secousses, Astuces, Commandes, Transférer, Effacer → armed confirmation);
Commandes (touch / keyboard / gamepad); Transférer (`DERIVE1:` code, copy, import asks twice); Pause (status chips:
salvage carried / deposited, O2, equipment icons; Reprendre, Carte, Journaux x/9, Commandes, Réglages, Balise de
rappel → armed confirmation); Carte (Fermer, and on desktop a Tab / M / Échap hint in the bottom-right corner); Établi (salvage pill, 2-column cards: icon, level pips, current →
next effect (the next value drops the words it shares with the current one: « Coque 100 → 125 »), cost / MAX; Soute à charges hidden until the Explosives; fits 750 × 342 without scrolling); Journal
(terminal, typewriter at 70 char/s, a tap on the text or Passer completes it, then Fermer); Journaux (9 slots,
unread ones disabled); Mort (« Signal perdu », cause, beacon line, lost / kept columns, life stats, Repartir);
Victoire (canvas cinematic at the game's internal resolution, 13.6 s, skippable: the capsule leaves the Maelström,
Earth grows (`celestial.earth`), re-entry plasma, parachute over the ocean; then the stats panel: play time, deaths,
map %, logs x/9, salvage, returns; Continuer l'exploration (new life at the Albatros) / Titre). The overlay canvas
is opaque; the renderer draws only the frozen world under it (no second cinematic).
Buttons fire on pointerup of the finger that pressed them (a resting stick thumb never blocks a menu); destructive
confirmations put Annuler first, stay disabled 550 ms and move away from the finger. Keyboard focus navigation
(arrows, Entrée / Espace, Échap / P back, E closes the Établi, Tab / M close the map) is captured before `input.js`.

### Onboarding (`tips.js`)

`Coach` shows each tip once through `hud.tip(line1, line2, { key })` (remembered in `save.tips`, off with Réglages →
Astuces), with touch / keyboard / gamepad texts, only when no other tip is on screen: `move` (1.2 s after the start),
`brake` (2.5 s above 90 px/s or after 25 s; skipped if the player brakes first), `action` (first interactable),
`door` (locked door without the keycard), `salvage`, `deposit`, `o2`, `fuel`, `satellite`, `belt`, `rubble` (near the
plug without explosives), `charge` (Explosives found), `blast` (rubble destroyed), `heat` (without the shield) / `heatShield` (with it: « sans l’annuler », shelter in the
observatory), `flare` (a sun pulsing
nearby), `gravity` (critical gravity), `storm`.

### Debug (`debug.js`)

Flags: `?debug` (G god mode, R reveal map; no SW) `?god` `?seed=` `?at=<POI | item | dock | workbench | capsule |
rubble | record id>` `?x=&y=` (px from the centre) `?items=all|keycard,…` `?salvage=` (carried) `?bank=`
(deposited) `?reveal` `?autostart` `?mute` `?nosw`. `window.__derive`: `game, errors, state(), start(), pause(),
resume(), freeze(b), step(n), player(), setPlayer(fields), teleport(x, y), teleportTo(target)` (free spot next to
it; doors and the rubble from outside), `spotNear(x, y, dx, dy), give(item | 'all'), setSalvage(n), setBank(n),
die(cause), hazards(), entities(), save(), run(), gen(), world.get(tx, ty) / world.at(x, y), ui(), info(), input: {
set, clear, tap, layout, state }`. `teleportTo('maelstrom' | 'charybde')` stands off toward the sector centre where
the hole pulls with half the base thrust (861 / 497 px), never next to the horizon.

### PWA, e2e

`sw.js`: `derive-v1`, cache-first, only touches `derive-*` caches (Gouffre shares the GitHub Pages origin), each
CORE file pre-cached on its own so a missing icon never aborts the install. `manifest.webmanifest`: fullscreen,
landscape, icons 192 / 512 / maskable 512 (`icons/`, generated by the presentation stage; `index.html` also links
`icons/icon-180.png` as the apple-touch-icon).
`tests/e2e/smoke.mjs` (Playwright from `npm root -g`, iPhone 13 landscape = 750 × 342 CSS at 3×, internal 562 × 256
at ×4): title, real CDP touches for the stick (2D, analog), Frein, Boost, button slides, keyboard codes, pickup +
dock deposit, Établi purchase by the context button, Orion door without / with the keycard, Charge on the Tycho
rubble, sun death → death overlay → respawn (equipment kept, carried salvage lost), map, log + Journaux, Balise de
rappel (double tap never confirms), asphyxia death, O2 canister magnet (waits while the tank is full), Maelström
death without the Ancre, heat shield / Ancre multipliers, portrait overlay, hit-stop ticks, menus under a resting thumb, gamepad blocking,
victory (refused without the anchor, cinematic, stats, continue), settings / transfer round trip, reload keeps the
save, armed erase, blocked storage notice, portrait boot logo, desktop 1280 × 720 keyboard session (no touch
controls, WASD, Tab, Échap), zero console errors or warnings. Screenshots:
`tests/e2e/screenshots/`.

## Integration

Owner: the integration stage (it owns every file in `derive/` from here on). This section says what works now, how
to run and check it, the order of updates, what integration changed, and what is still unproven.

### State

The game is playable end to end in Chromium: title → Albatros → debris, dock deposit, Établi → Colibri keycard →
Orion (locked doors, lasers, turrets, armory explosives, refill station, locker) → Tycho rubble blasted → heat
shield → Hélios anchor → Ulysse → re-entry cinematic → stats → keep exploring. Death by sun, heat, black hole,
asphyxia, impact, laser, turret, own charge, storm and the Balise de rappel all go through the same death overlay
and respawn (equipment kept, carried salvage lost). Saves survive a reload; the `DERIVE1:` code round-trips.
Boot has zero console errors or warnings at iPhone 13 landscape (touch) and at 1280 × 720 (keyboard).

### How to run and check

| Command | What it proves |
|---|---|
| `npm run serve` → `http://localhost:8080/index.html` | manual play (SW off on localhost) |
| `npm test` | 89 unit tests: simulation, progression solver on 2 seeds, presentation helpers, font coverage |
| `npm run test:e2e` | 31 real-browser steps (DESIGN §14 and more, see Shell → PWA, e2e) |
| `npm run solver [seed]` | every §6.4 rule, thermal cost with / without the shield |
| `npm run feel [seed]` (`tools/feel.mjs`) | flight numbers: time to cruise, brake, coast, fuel at cruise, belt crossings at 80 / 140 / 250 px/s, shielded Hélios approach by brake point |
| `npm run tour -- <outDir> [stops] [cssW cssH]` (`tools/tour.mjs`) | the real game at iPhone 13 landscape, one PNG per place (19 stops incl. frozen close-ups of the Maelström and a sun) + map, pause, Établi; fails on any console error or warning |

### Update order (one fixed tick, `main.js updatePlaying`)

`input.beginTick` → Pause / Carte → `player.update` → `hazards.update` → `entities.update` (dock: deposit through
`game.deposit`, refill, charges) → `particles.update` → `camera.update` → `hud.update` → fog / place names /
discoveries (polled) → context button → `coach.update` → deposit toast timer → autosave → death timer →
`input.endTick`. Rendering (`renderer.render(alpha)`) runs every rAF and drives the audio loops and ambience.

### What integration changed

- **Fuel at cruise** (player.js, config `PLAYER.cruiseFlame`): holding the stick along the motion at cruise used to
  burn 6 u/s for nothing (a beginner holding the stick to Orion emptied the tank halfway, 23 s at cruise vs 16.7 s
  of fuel). Fuel now pays for the velocity change actually applied; a 0.25 pilot flame keeps the feedback.
- **Heat** (config `SUNS.shieldMul` 0.1 → 0.06, `shelteredMul` 0.05 → 0.01): the shielded approach to Hélios cost
  ~63 hull at cruise and the observatory itself burnt 3 hull/s with the shield; now 11–43 hull for a braking
  approach and a near-safe interior (0.4 hull/s shielded). Solver: 331 hull without the shield (≥ 300), 19 with it
  (≤ 40). Item text and README no longer say « ÷ 10 »; a `heatShield` tip explains the shield does not cancel heat.
- **Rendering order**: celestial bodies are drawn before entities and the astronaut (the accretion disk used to
  hide the astronaut and the asteroids within ~110 px of the Maelström).
- **Radar**: at most 6 arrows (nearest first, the Albatros always), a top-column gap that follows the banner / zone
  name / warnings, slot search that never pushes an arrow into the touch controls (one used to sit under Charge) and
  drops an arrow rather than overlapping labels.
- **Font**: `Ö` / `Ä` glyphs (« LE MAELSTR M » on the HUD and the map); a readable comma; `hasGlyphs()` and a unit
  test over every HUD / map string (POI and zone names, items, tips, toasts).
- **Map labels**: Mistral below its icon, Charybde above the Maelström, a wider gap after the Albatros (they collided).
- **Touch pill**: 124 CSS px, 12 px text, no wrap (« RAVITAILLER » overflowed); `HUD_LAYOUT.bottomRightCss.w` 232.
- **Établi texts**: « Poussée 100 % → 115 % », « Capacité 100 u → 125 u ».
- **Wiring**: `new Particles(game)` (debris chunks bounce), `tileBroken` spawns `tile` chunks in the tile's colours.
- **e2e**: asphyxia, magnet, Maelström death, shield / anchor multipliers, desktop keyboard session.

### Feel check (numbers from `tools/feel.mjs`, seed 12345)

Cruise (140 px/s) in 0.83 s; brake stop from cruise in 0.55 s over 37 px; the assist coasts from cruise to 5 px/s in
8.8 s over ~330 px (a drift, as intended; Frein is the precise stop). Belt, straight radial lines without steering:
at 80 px/s 1 hull on average, 46/48 crossings unhurt; at 140 px/s 3 hull, 35/48 unhurt; at 250 px/s 11 hull (worst
45). O2 150 s vs 12 s to Colibri and 23 s to Orion at cruise: ring 1 plus a first Orion trip fits, and Orion has a
refill station. Shielded Hélios approach from the north: braking between y = 3200 and 3260 arrives with 57–89
hull; braking at 3180 leaves 27; a boosted dash overshoots through the south opening into heat (the tip says not to
linger outside, not to boost). Headless Chromium (software canvas): simulation 0.03–0.07 ms per tick, render 1.0–3.6 ms
per frame (Hélios and the dock are the heaviest).

### Known limits

- Never run on a real iPhone or in WebKit: every check is Chromium. Safe areas were checked by forcing 47 / 21 px
  insets on the probe (HUD, buttons and menus move correctly), not on a device.
- `loadSprites()` ~0.4 s in headless Chromium; unmeasured on a phone.
- Level feel is proven by the strict solver grid, scripted flights and screenshots, not by a human playtest: turret
  placement, vent timing and laser cycles in the 3–5-tile corridors have not been played by hand.
- The Hélios observatory is only 13 tiles tall with openings north and south on the approach axis: arriving fast
  means overshooting into the heat on the far side. Tuned to be fair for a braking pilot, still the hardest spot.
- Interiors are a top-down cutaway (visible from outside, dimmed by the darkness layer).
- The moon rock texture shows its tile-stepped light / dark patches at close range (craters as 8 px blocks).
