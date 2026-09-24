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
| 5. Le Cœur | 260–287 | arène pré-construite | — | **Le Gardien** (boss) |

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
