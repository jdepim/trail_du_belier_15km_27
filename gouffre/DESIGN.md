# GOUFFRE — Design & contrat d'architecture

> Rogue-lite de minage en 2D pixel art, side-scroller gothique façon *Castlevania: Symphony of the Night*,
> jouable sur iPhone (Safari / écran d'accueil) en paysage.
> Ce document est le **contrat** partagé par tous les modules : noms de fichiers, APIs, constantes.
> Toute divergence doit être répercutée ici.

---

## 1. Plateforme & contraintes

- **Jeu web** : HTML5 Canvas 2D + JavaScript ES modules natifs. **Aucune dépendance runtime, aucun CDN,
  aucune étape de build.** Tout doit fonctionner hors-ligne une fois chargé.
- Cible : **iPhone Safari iOS 16+**, en **paysage**, installable sur l'écran d'accueil (PWA plein écran).
  Doit aussi tourner sur desktop (Chrome/Safari/Firefox) au clavier pour le développement.
- Dossier : `gouffre/` à la racine du dépôt. Entrée : `gouffre/index.html`.
  **Ne jamais modifier le `index.html` racine** (c'est un autre projet : un plan d'entraînement trail).
- Textes joueur **en français**. Identifiants et commentaires de code **en anglais**.
- Boucle à **pas fixe 60 Hz** (accumulateur, dt plafonné à 0,25 s), rendu à chaque `requestAnimationFrame`
  (ProMotion 120 Hz OK). Vitesses en px/s, temps en secondes.
- Budget perf : < 4 ms de mise à jour + rendu par frame sur un iPhone récent. Pas d'allocation dans
  les boucles chaudes (pools pour particules/projectiles), cache de rendu des tuiles par chunks.

## 2. Boucle de jeu (rogue-lite)

1. **Camp** (surface) : le joueur apparaît au camp, en haut de la mine. On y trouve **la Forge**
   (PNJ forgeron) où l'on dépense l'**or** en améliorations permanentes.
2. **Descente** : la mine sous le camp est **procédurale** (seed). Plus on descend, plus les minerais
   valent cher… et plus les ennemis sont forts. Tous les blocs (sauf la roche-mère) sont destructibles.
3. **Sac à dos** : les minerais ramassés vont dans le sac (capacité limitée). Ils ne valent rien tant
   qu'ils ne sont pas **rapportés à la surface** : remonter dans la zone du camp (`y < SURFACE_Y`)
   **met le butin à l'abri** (converti en or banqué). Le **grappin** est l'outil clé de la remontée.
4. **Mort** : on perd le contenu du sac (sauf % conservé via l'amélioration *Bourse de secours*) et les
   reliques de la run. **La mine est régénérée** (nouvelle seed) et on repart du camp, PV pleins.
   Tant qu'on est vivant, la mine persiste (les tunnels creusés restent — ils aident aux allers-retours).
5. **Objectif long terme** : atteindre le fond (**Le Cœur**, ~-260 m) et vaincre **le Gardien de l'Abysse**.
   Victoire → écran de fin + statistiques, puis on peut continuer (NG+ : ennemis ×1,5).

## 3. Monde

- Grille `WORLD_W = 72` colonnes × `WORLD_H = 300` lignes, tuiles de `TILE = 16` px.
- Colonnes 0-1 et `W-2..W-1` : roche-mère (indestructible). Lignes `H-12..H-1` : roche-mère.
- `SURFACE_Y = 14` : première ligne de sol. Au-dessus : ciel (air), parallaxe montagnes + silhouette de
  château gothique. Le camp est posé sur la surface : sol plat, Forge (bâtiment + forgeron) à gauche du
  puits, un **puits d'entrée** pré-creusé de quelques tuiles au centre.
- Profondeur affichée : `depth_m = max(0, tileY - SURFACE_Y)` (1 tuile = 1 m).

### Couches (par profondeur d)

| Couche | d | Blocs | Minerais (valeur or) | Ennemis |
|---|---|---|---|---|
| 1. Terre meuble | 0–39 | terre, argile, pierre (poches) | charbon (1), cuivre (2) | gelée, chauve-souris |
| 2. Catacombes | 40–99 | pierre, briques (salles en ruine), os | fer (4), argent (7) | squelette, chauve-souris, gelée |
| 3. Grottes cristallines | 100–179 | granit, roche cristalline | or (12), améthyste (18) | araignée, spectre, chauve-souris |
| 4. Abysse ardente | 180–259 | basalte, obsidienne, **lave** (dégâts) | rubis (30), mithril (50) | diablotin de feu, golem, spectre |
| 5. Le Cœur | 260–273¹ | arène pré-construite | — | **Le Gardien** (boss) |

¹ La roche-mère commence à la ligne `H-12 = 288` (d = 274) : le Cœur couvre donc d 260–273 (lignes 274–287).

- Grottes : bruit + automate cellulaire, plus ouvertes en profondeur ; tunnels « vers » ; salles de
  catacombes (couche 2) ; géodes de cristal (couche 3) ; lacs de lave (couche 4).
- **Coffres** dans les grottes : donnent une **relique** (bonus de run) ou de l'or.
- **Cristaux de vie** rares : restaurent des PV.
- Invariants de génération (testés) : bords en roche-mère, spawn au camp non bloqué, puits d'entrée
  ouvert, chaque couche contient ses minerais, pas d'ennemi dans un bloc solide, arène du boss présente.

### Tuiles (`tiles.js`)

Chaque type : `{ id, key, name, solid, hp, tier, value, light, hazard, drop, colors }`.
- `hp` : points de minage ; `tier` : niveau de pioche minimum (sinon « Trop dur ! », aucun dégât).
- Ordres de grandeur : terre hp1 t0, argile hp2 t0, pierre hp4 t0, brique hp5 t1, granit hp8 t2,
  roche cristalline hp9 t2, basalte hp12 t3, obsidienne hp16 t3, roche-mère ∞.
  Minerai = hp de la roche hôte + 1, même tier que l'hôte.
- Les tuiles endommagées affichent des fissures (3 stades). Les dégâts non terminés se résorbent après 3 s.
- `light` > 0 : la tuile émet de la lumière (lave, cristal, améthyste…).

## 4. Joueur

- Hitbox **10 × 22 px** (tunnels de 2 tuiles de haut), sprite dessiné dans un cadre 32 × 32.
- Déplacement : vitesse max ~95 px/s (améliorable), accélération/friction, saut ~3,2 tuiles,
  **hauteur variable** (relâcher coupe le saut), **coyote time** 0,1 s, **buffer de saut** 0,12 s,
  gravité ~950 px/s², chute max 380 px/s, **correction de coin** au plafond (glisse de ≤ 4 px).
  Pas de dégâts de chute.
- **Frapper / Creuser** (un seul bouton, la pioche est l'arme) : direction = stick (haut / bas / côté ;
  bas au sol = creuser dessous). Touche les ennemis dans un arc devant et **endommage les tuiles** visées
  (en horizontal : les 2 tuiles devant, niveau tête et pieds ; en haut : au-dessus de la tête ; en bas :
  sous les pieds). Cadence ~0,28 s (améliorable). Maintenir = répétition automatique.
- **Grappin** : voir §5.
- PV numériques (base 60) affichés en barre ; **i-frames** 1 s + recul quand touché ; clignotement.
- **Lanterne** : rayon de lumière (améliorable). **Sac** : capacité en unités de minerai (améliorable).
- Ramassage : les minerais jaillissent du bloc cassé et sont **aimantés** vers le joueur.

## 5. Grappin (`grapple.js`)

- Tir dans la direction de visée du stick (analogique, 360°). Stick neutre → **vers le haut, légèrement
  vers l'avant** (≈ 70° au-dessus de l'horizontale côté regard).
- **Aide à la visée** : si le rayon ne touche rien dans la portée, on essaie ±12°, ±24° et on prend
  la touche la plus proche de l'angle voulu.
- Le crochet voyage (~650 px/s) jusqu'à la portée max (base 96 px, améliorable jusqu'à ~220 px).
  S'il touche une tuile solide → **accroché** ; sinon il revient.
- Accroché : contrainte de distance `|p - ancre| <= longueur` (pendule, intégration Verlet ou
  projection de vitesse). Gauche/droite = pousser le balancier ; **haut = enrouler** (remonter,
  ~130 px/s, améliorable), **bas = dérouler**. **Saut = lâcher avec impulsion** (+ boost vertical).
  Re-appui Grappin = lâcher. Si la tuile d'ancrage est détruite → lâché.
- La corde ne s'enroule pas autour des coins (simplification assumée). Le joueur reste soumis aux
  collisions avec les tuiles pendant le balancier.

## 6. Ennemis (`enemies.js`)

Toutes les stats de base sont multipliées par la profondeur : `hp × (1 + d/60)`, `dmg × (1 + d/80)`
(× 1,5 en NG+). Mise à jour seulement dans un rayon ~1,5 écran autour de la caméra.

| key | Nom | Comportement |
|---|---|---|
| `slime` | Gelée | saute vers le joueur quand il est proche |
| `bat` | Chauve-souris | dort au plafond, se réveille à proximité, vol sinusoïdal vers le joueur |
| `skeleton` | Squelette | patrouille (demi-tour aux bords/murs), lance des os en cloche |
| `spider` | Araignée | pend au plafond sur un fil, tombe quand le joueur passe dessous, puis court |
| `ghost` | Spectre | flotte **à travers les murs** vers le joueur, semi-transparent |
| `imp` | Diablotin de feu | vole, tire des boules de feu |
| `golem` | Golem | lent, très résistant, charge quand aligné |
| `guardian` | Le Gardien de l'Abysse | boss en 3 phases dans l'arène du Cœur |

- Apparition : placés à la génération (densité par couche) + réapparition hors-écran périodique.
- Butin : pièces d'or (valeur ∝ profondeur, **ramassées directement en or de run**, perdues à la mort
  comme le sac), parfois un cœur (soin).

## 7. Méta-progression (`meta.js`, sauvegarde `localStorage` clé `gouffre.save.v1`)

- **Or banqué** = monnaie. Stats : profondeur record, morts, or total, victoires.
- **Forge** (chaque amélioration a plusieurs niveaux, coût croissant) :
  - `pick` **Pioche** : dégâts + tier (le tier débloque granit → t2, basalte/obsidienne → t3)
  - `vitality` **Vitalité** : PV max
  - `armor` **Armure** : réduction de dégâts
  - `grapple` **Grappin** : portée + vitesse d'enroulement
  - `bag` **Sac** : capacité
  - `lantern` **Lanterne** : rayon de lumière
  - `boots` **Bottes** : vitesse + saut
  - `insurance` **Bourse de secours** : % du sac conservé à la mort (0 → 25 → 50 %)
- **Reliques** (bonus de run, trouvées dans les coffres, perdues à la mort) : double saut, aimant,
  vampirisme, pioche ardente, peau de pierre, plume (chute lente), crochet éclair… (icônes dans le HUD).
- Sauvegarde versionnée avec migration ; tolérante aux erreurs (`try/catch`, stockage indisponible).

## 8. Contrôles

**Tactile (paysage)** — multi-touch par `identifier`, réaction sur `touchstart` :
- Moitié gauche : **stick virtuel flottant** (apparaît sous le pouce, rayon ~44 px CSS, zone morte 0,22).
  Horizontal = déplacement ; vecteur complet = visée (frappe / creusage / grappin).
- En bas à droite : 3 gros boutons ronds (~66 px CSS) : **Saut**, **Frapper**, **Grappin**.
- Bouton contextuel **Forge** près du forgeron. Bouton **Pause** en haut à droite.
- Respect des `safe-area-inset-*` (encoche / Dynamic Island).

**Clavier** : ←→↑↓ / WASD (déplacement + visée), Espace / Z = saut, X / J = frapper,
C / K = grappin, E = interagir, Échap / P = pause. **Manette** (Gamepad API) : bonus.

## 9. Rendu

- **Résolution interne à échelle entière** : `s = max(1, round(hauteurPixelsDevice / 216))`,
  interne = `floor(dimsDevice / s)`. On dessine dans un canvas interne puis on l'agrandit ×s sans
  lissage dans le canvas d'affichage (taille en pixels device) → pixels nets, plein écran.
- Caméra : suit le joueur avec anticipation + lissage, bornée au monde, **alignée au pixel**.
- Tuiles pré-rendues (variantes + bords assombris côté air), cache par chunks de 16×16 tuiles invalidé
  sur modification. Mur de fond sombre visible derrière les tuiles creusées.
- **Éclairage** par tuile : carte de lumière (BFS depuis lanterne, lave, cristaux, ciel à la surface),
  dessinée comme un petit canvas d'obscurité agrandi **avec** lissage (halo doux). L'obscurité ambiante
  augmente avec la profondeur.
- Particules (débris de la couleur du bloc, étincelles, poussière), **tremblement d'écran**,
  **hit-stop** (~50 ms) sur les coups.
- Pixel art défini **dans le code** (tableaux de chaînes + palettes) et rastérisé au chargement.
- HUD sur canvas avec **police bitmap** (chiffres, majuscules, accents É È Ê À Ç, ponctuation).
  Menus (titre, pause, forge, mort, victoire) en **overlays DOM** stylés gothique.

## 10. Audio (`audio.js`)

WebAudio **synthétisé** (aucun fichier) : saut, coup de pioche, impact par matériau, ramassage,
blessure, mort d'ennemi, tir/accroche du grappin, banque (« cha-ching »), mort, achat.
Ambiance musicale procédurale par couche (bonus). `AudioContext` débloqué au premier toucher (iOS).
Muet réglable, sauvegardé.

## 11. iOS / PWA

- `viewport-fit=cover`, `user-scalable=no`, `apple-mobile-web-app-capable`,
  `apple-mobile-web-app-status-bar-style=black-translucent`, `apple-touch-icon` 180×180,
  `manifest.webmanifest` (`display: fullscreen`, `orientation: landscape`, icônes 192/512).
- CSS : `touch-action: none`, `user-select: none`, `-webkit-touch-callout: none`,
  `overscroll-behavior: none`, `body { position: fixed }`. `preventDefault` sur `touchmove`,
  `gesturestart`, `dblclick`.
- Portrait → overlay « Tourne ton iPhone ». `visibilitychange` → pause auto + reprise audio.
- **Service worker** cache-first versionné pour tous les fichiers du jeu (jeu hors-ligne).

## 12. Architecture du code (`gouffre/src/`)

Un objet **`game`** (contexte) est passé aux systèmes ; pas de singletons mutables cachés.

| Fichier | Rôle / API principale |
|---|---|
| `main.js` | boot, resize, boucle à pas fixe, machine d'états `TITLE / PLAYING / PAUSED / SHOP / DEAD / VICTORY` |
| `config.js` | **toutes** les constantes de tuning (équilibrage centralisé) |
| `rng.js` | PRNG seedé (`mulberry32`), `createRng(seed)`, bruit de valeur 2D |
| `input.js` | `input.moveX`, `input.aimX/aimY`, `input.pressed(a)`, `input.held(a)`, `input.released(a)` ; actions `jump attack grapple interact pause` ; sources clavier / tactile / manette ; `input.inject(...)` pour les tests |
| `tiles.js` | registre des types de tuiles (`TILES`, `TILE_ID`, `tileDef(id)`) |
| `world.js` | `World` : `types: Uint8Array`, `damage: Float32Array`, `get/set`, `isSolid(tx,ty)`, `damageTile(tx,ty,dmg,tier) → {broken, tooHard, tileId}`, `version` / régions sales |
| `worldgen.js` | `generateWorld(seed) → { world, spawns, chests, camp }` |
| `physics.js` | `moveAndCollide(body, dt, world) → { onGround, hitCeiling, hitLeft, hitRight }` (AABB séparé par axe) |
| `player.js` | `Player` : mouvement, frappe/creusage, dégâts, animation, intégration grappin |
| `grapple.js` | `Grapple` : crochet, accroche, contrainte de corde |
| `enemies.js` | définitions + comportements + fabrique, projectiles ennemis |
| `entities.js` | pickups (minerais, pièces, cœurs), coffres |
| `lighting.js` | calcul de la carte de lumière + overlay d'obscurité |
| `render.js` | caméra, fonds, tuiles (cache chunks), entités, appel du HUD |
| `sprites.js` | données pixel art + rastérisation : `getSprite(name)`, `drawSprite(ctx, name, frame, x, y, flipX)` |
| `particles.js` | pool de particules : `particles.spawn(kind, x, y, opts)` |
| `audio.js` | `audio.play(name, opts)`, `audio.setMuted(b)`, `audio.unlock()`, musique par couche |
| `hud.js` | HUD canvas + police bitmap `drawText(ctx, str, x, y, color)` |
| `ui.js` | overlays DOM : titre, pause, forge, mort, victoire, réglages |
| `meta.js` | sauvegarde/chargement/migration, définitions & coûts des améliorations, reliques, `applyUpgrades(player, save)` |
| `debug.js` | drapeaux `?debug` (FPS, god mode, téléport profondeur, or) ; expose `window.__gouffre` pour les tests |

**Hooks obligatoires** (pour que l'audio, les particules et le « juice » soient branchables sans toucher
à la logique) : les systèmes de jeu appellent toujours `game.audio.play(...)`, `game.particles.spawn(...)`,
`game.camera.shake(intensity, duration)` et `game.hitStop(seconds)` aux événements (saut, frappe, bloc
cassé, ramassage, dégâts, mort, grappin tiré/accroché, banque, achat).

## 13. Tests

- `gouffre/tests/unit/*.test.mjs` exécutés avec `node --test` : rng, invariants de worldgen, collisions,
  dégâts de tuiles, coûts & application des améliorations, migration de sauvegarde.
- `gouffre/tests/e2e/*.mjs` : Playwright (installé globalement, résolu via `npm root -g`), serveur
  statique Node intégré, viewport iPhone paysage avec `hasTouch`. Démarre une partie, injecte des
  entrées via `window.__gouffre`, vérifie : zéro erreur console, déplacement, creusage, grappin,
  ramassage, banque, mort/régénération, achat à la Forge. Captures dans `tests/e2e/screenshots/`
  (ignorées par git).
- `gouffre/package.json` : scripts `test`, `test:e2e`, `serve` (aucune dépendance obligatoire).

## 14. Notes d'implémentation (étape 1 — moteur)

Précisions et ajouts compatibles avec le contrat ci-dessus (détails : `NOTES-core.md`).
- `World.back: Uint8Array` : style de mur de fond par tuile (`tiles.BACK`), 0 = ciel. `World.chunkVersion`
  (une version par chunk 16×16), `World.damaged` (liste des tuiles entamées), `World.skyTop` (ciel ouvert par colonne).
- Tuiles supplémentaires : `grass`, `beam` (poutre du chevalement, ancrage du grappin au camp), `arena`
  (briques du Cœur, hp 40 t3), `crystal` (amas lumineux des géodes), `life_crystal` (cristal de vie, `drop: 'heal'`),
  décors non solides `torch`, `bones_deco`, `cobweb`, `stalactite`, `stalagmite`, `roots`, `mushroom`, `post`.
- Pioche de base : **tier 0** (les briques t1 demandent la 1ʳᵉ amélioration de pioche). Argent : hôte brique (hp 6, t1).
- `generateWorld(seed)` renvoie aussi `arena` (intérieur, entrée, position du boss) et `seed`. Points d'apparition :
  `{ key, tx, ty, x, y, anchor: 'floor'|'ceiling'|'air', w, h, layer, depth }` (règles dans `config.ENEMY_SPAWN_RULES`).
- `input.moveY` (−1 haut … 1 bas), `input.aimActive`, `input.setContextAction(label|null)`, `input.tap(a)`,
  `input.clearInjected()`. Entrée « Entrée » non mappée (réservée aux boutons DOM).
- Hooks de jeu supplémentaires : `game.tileBroken(tx, ty, id, cause)`, `game.onPlayerDeath(cause)`, `game.toast(text, opts)`.
- `EnemyManager.damageInBox(box, dmg, fromX, opts) → nb touchés` est appelé par la frappe du joueur.
- Lumières dynamiques : `lighting.addLight(...)` se fait pendant le pas fixe (liste vidée au début de chaque
  pas par `lighting.clearDynamic()`, conservée entre les images, pendant le hit-stop et la pause).
  `game.hitStop(s)` gèle un nombre entier de pas fixes (≥ 1). `game.tileBroken` retire aussi les décors
  privés de support (`World.clearDetachedDeco`). Invariant de génération : la lave ne touche jamais le vide
  sur les côtés ni dessous.

## 14 bis. Notes d'implémentation (étape 2a — ennemis, combat, boss)

Détails et APIs : `NOTES-core.md`, section « Enemies & combat ».
- Réglages centralisés dans `config.js` : `ENEMY_STATS` (stats de base, hitbox, or, résistance au recul),
  `ENEMY_AI` (comportements), `ENEMY_SPAWNING` (réapparition : intervalle et plafond local par couche, plafond
  global 72), `ENEMY_ACTIVE` (zone active ≈ 1,25 largeur × 1,5 hauteur d'écran autour de la caméra), `DROPS`, `BOSS`.
  Équilibrage : couche 1 douce (gelée 2-3 coups, ~6 dégâts), chaque couche ≈ ×1,5-2 en PV et dégâts moyens ;
  le Gardien ≈ 2650 PV (480 de base × profondeur, ≈ 1 min de combat avec la pioche niveau 4 ; hitbox 34 × 56 px
  jusqu'à la tête). NG+ lu dans `run.ngPlus` (copié de `save.ngPlus`).
- Nouvelle tuile `gate` (« Herse du Cœur », indestructible) : scelle l'entrée de l'arène pendant le combat.
- Les pièces vont **directement** dans l'or de run (`run.gold`) ; les cœurs ne sont ramassés (et aimantés) que si
  le joueur est blessé ; le cristal de vie libère un cœur (20 PV) au lieu de soigner instantanément.
- Ajouts de « juice » : chiffres de dégâts flottants, rebond (*pogo*) quand une frappe vers le bas touche un
  ennemi en l'air, flash blanc à l'impact, télégraphes rouges clignotants avant chaque attaque ennemie.
- Les ennemis volants ne remontent pas dans le camp (zone sûre). Les boules de feu brûlent la terre / l'herbe.
- Boss : 3 phases (66 % / 33 %), transitions invulnérables ; phase 1 griffe + onde de choc au sol, phase 2
  double onde + invocation de chauves-souris, phase 3 (enragé) pluie de feu signalée + charge + squelettes.
  Dans toutes les phases, une **griffe montante** répond au joueur placé au-dessus de ses épaules (corde, plateforme,
  rebond sur sa tête) et chaque coup du Gardien fait lâcher la corde ; chaque phase s'ouvre sur son attaque signature
  (invocation, puis pluie de feu + charge) et un coup ne fait jamais sauter une phase. Sa mort impose une trêve :
  serviteurs et projectiles disparaissent aussitôt.
  La caméra cadre toute l'arène pendant le combat (en tactile, le sol reste au-dessus des boutons du pouce ; l'arène
  occupe les colonnes 9 à 62) ; la barre de vie (nom + crans de phase) est en haut au centre.
  À sa mort : séquence d'explosions, trésor, herses rouvertes, puis `game.onBossDefeated()` (l'étape 2b y
  branche l'écran de victoire ; pour l'instant bannière + toast).

## 14 ter. Notes d'implémentation (étape 2b — économie & boucle méta)

Détails, tableaux et APIs : `NOTES-core.md`, section « Economy & meta loop ». Écarts et précisions :
- **Sauvegarde** : la clé reste `gouffre.save.v1`, le format interne passe en `version: 2` (migration depuis la v1).
  `ngPlus` devient un **niveau** (NG+ n : ennemis × (1 + 0,5 n), donc × 1,5 en NG+1 comme prévu) ; statistiques
  ajoutées (`trips`, `kills`, `spent`, `playTime`, `bestTrip`) ; réglages `muted` (l'ancienne clé `gouffre.muted`
  n'est lue qu'au premier lancement) et `shake` (secousses de l'écran). Une sauvegarde illisible est copiée dans
  `gouffre.save.v1.corrupt` avant d'être remplacée. L'expédition en cours (mine, sac, position) n'est pas
  sauvegardée : recharger la page en démarre une nouvelle (butin non banqué perdu, aucune mort comptée).
- **Banque** : déclenchée quand les pieds du joueur sont au niveau de la surface ou au-dessus
  (`feetY <= camp.bankY`), donc dès qu'on remonte sur le sol du camp. Le butin qui arrive juste après (pièces
  aimantées) s'ajoute au même voyage et au même décompte. **Au camp, les PV remontent vite** (35 % par seconde).
- **Minerais** : 1 bloc de minerai = 1 éclat = 1 unité de sac (valeur du minerai). Sac plein : l'éclat n'est plus
  aimanté et reste au sol (300 s), toast « Sac plein ! ».
- **Bourse de secours** : s'applique à tout le butin non banqué (sac **et** or de run), et la part conservée est
  **banquée immédiatement** à la mort ; la nouvelle expédition repart donc toujours avec un sac vide.
- **Abandon** (« Recommencer l'expédition », menu pause) = une mort (même règlement, écran de résumé). La
  confirmation place « Annuler » d'abord et arme le bouton rouge après 0,55 s (idem pour « Effacer la sauvegarde »).
  Mettre en pause pendant l'animation de mort ouvre directement le résumé.
- **Forge** : niveaux max pioche 5, vitalité 5, armure 5, grappin 4, sac 5, lanterne 4, bottes 3, bourse 2.
  Pioche : tiers 0/1/2/2/3/3 (la 1ʳᵉ amélioration débloque les briques), dégâts d'attaque 10 + 4 × niveau.
  Coûts équilibrés par `tools/economy.mjs` (1ʳᵉ amélioration après une courte descente, dureté 1 vers la 3ᵉ,
  dureté 2 vers la 10ᵉ, dureté 3 vers la 20ᵉ, Gardien atteignable vers 2 h de jeu) ; un test unitaire vérifie ces cibles.
  (Coûts et cibles révisés au §14 quater.)
- **Reliques** : 11 (les 7 prévues + Lanterne spectrale, Frénésie, Avarice, Cœur de troll), rareté commune /
  peu commune / rare, tirage pondéré par couche (plus profond = plus rare), jamais de doublon. Coffres « or » :
  16 × (1 + d/25) pièces ; un coffre à relique donne de l'or si toutes sont possédées. Un coup de pioche ouvre aussi un coffre.
- **Victoire** : 3,2 s après la mort du Gardien, les pièces au sol sont ramassées et tout le butin est banqué, puis
  l'écran de victoire. « Continuer (NG+ n) » monte le niveau NG+ et régénère la mine ; « Retour au titre » garde le niveau.
- **Menus** : le titre affiche « Continuer » (reprend l'expédition en mémoire, ou en commence une avec l'or banqué
  affiché) et « Réglages » (son, secousses, effacer la sauvegarde avec confirmation ; les réglages survivent à
  l'effacement). Navigation clavier : flèches / ZQSD, Entrée / Espace, Échap ; E ferme la Forge.

## 14 quater. Notes d'implémentation (audit final : WebKit, performances, premier joueur, économie)

Détails, mesures et APIs : `NOTES-core.md`, section « Final audit round ». Écarts au contrat :
- **Rendu (§9)** : le canvas d'affichage n'est plus en pixels device. Il contient l'image interne (W × H) et le CSS
  l'agrandit ×s (`image-rendering: pixelated`) ; `?canvasscale` rétablit l'ancien agrandissement dans le canvas.
  Un bloc cassé redessine seulement ses 3 × 3 cases dans les chunks en cache (`World.dirtyLog`), un anneau d'un chunk
  autour de la vue est préparé à l'avance ; libellés du HUD mis en cache ; éclairage allégé.
- **Camp (§2, §3)** : une **trappe** en planches (`trapdoor`, 1 coup de pioche) couvre le puits ; un coup l'ouvre en
  entier, elle se referme quand le héros est revenu sur le sol du camp, à l'écart du puits. **Le sol du camp (ligne de
  surface, colonnes 15-56 hors trappe) et la poutre du chevalement sont indestructibles** (`World.locked`, toast
  « Impossible ici ») : la Forge, le point de départ et l'ancrage du camp restent toujours utilisables.
- **Grappin (§5)** : « Re-appui Grappin = lâcher » devient : accroché, un appui **hisse** le héros (saut avec l'élan de
  Saut, puis le crochet repart au sommet du saut) quand il est au sol, sur une corde courte (≤ 40 px), en tenant haut
  ou presque immobile ; pendant un vrai balancier, l'appui lâche comme avant. **Aide au rebord** : en l'air, poussant
  vers un mur dont le haut est au plus 10 px au-dessus des pieds, le héros s'y hisse.
- **Premiers pas** (nouveau `tips.js`) : astuces contextuelles, une seule fois chacune (mémorisées dans `save.tips`),
  désactivables (Réglages → Astuces) ; panneau « Commandes » (Pause et Réglages) ; ligne de commandes tactiles et conseil
  d'installation (« Partager → Sur l'écran d'accueil ») sur l'écran titre.
- **Coincé** : sous le camp, sans progrès vers le haut pendant 45 s malgré des sauts / grappins, le menu Pause propose la
  **Corde de secours** : retour au camp vivant, le butin non banqué reste au fond (Bourse de secours appliquée), reliques
  et mine conservées, pas de mort (`stats.rescues`). Pas pendant le combat du Gardien.
- **Sauvegarde (§7)** : champs `tips`, `settings.tips`, `stats.rescues` (migration automatique) ; Réglages →
  **Transférer** : code texte `GOUFFRE1:…` pour passer la progression entre Safari et l'app de l'écran d'accueil.
- **Économie** : coffres « or » 7 × (1 + d/30) pièces (un coffre ≈ une minute de minage : régénérer la mine pour les
  rouvrir ne rapporte plus 3-4× le minage) ; Abysse plus riche (24 filons de rubis de 3-5 et 15 de mithril de 2-4, rubis
  dans la croûte des lacs de lave ; **rubis 36, mithril 60** au lieu de 30 / 50) ; 1ᵉʳ niveau Sac 10 et Lanterne 8 ;
  coûts du milieu et de la fin ×1,4 environ (Pioche 45 / 300 / 1150 / 2500 / 5400). Mesure avec un bot de jeu légal
  (12 mines) : dureté 1 vers la 3ᵉ expédition, dureté 2 vers la 12ᵉ, dureté 3 vers la 32ᵉ, **Gardien prêt vers 1 h 50,
  vaincu vers 2 h 10** ; `tools/economy.mjs` est recalé sur ces mesures et son test vérifie ces cibles.
- **Overlays** : ils défilent quand un panneau dépasse l'écran (encoche + indicateur d'accueil), le titre n'est jamais coupé.
- **PWA (§11)** : `sw.js` (`gouffre-v5`) ne supprime et ne lit que ses propres caches (`gouffre-*`).
