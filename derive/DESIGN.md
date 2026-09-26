# DÉRIVE — Design & contrat d'architecture

> Exploration spatiale en 2D pixel art **vue de dessus**, en apesanteur, avec une boucle rogue-lite, pour iPhone
> (Safari / écran d'accueil) en paysage.
> Ce document est le **contrat** partagé par tous les modules : noms de fichiers, APIs, constantes, règles.
> Toute divergence doit y être répercutée (section « Amendements » en fin de document).
> Les nombres donnés ici sont des **cibles** : la source de vérité des valeurs est `src/config.js`.

---

## 1. Plateforme & contraintes

- **Jeu web** : HTML5 Canvas 2D + JavaScript ES modules natifs. **Aucune dépendance runtime, aucun CDN, aucune
  étape de build.** Tout fonctionne hors ligne une fois chargé (service worker).
- Cible : **iPhone Safari iOS 16+**, en **paysage**, installable sur l'écran d'accueil (PWA plein écran).
  Doit aussi tourner sur ordinateur (Chrome / Safari / Firefox) au clavier ou à la manette.
- Dossier : `derive/` à la racine du dépôt. Entrée : `derive/index.html`.
  **Ne jamais modifier le `index.html` racine** (autre projet : plan d'entraînement trail) **ni le dossier `gouffre/`**
  (autre jeu, terminé). On peut **copier puis adapter** des modules de `gouffre/` (rng, input, police bitmap du HUD,
  synthèse audio, serveur de test, patterns d'overlays DOM et de sauvegarde) : ils ont déjà été audités sur WebKit.
- Textes joueur **en français** (tutoiement). Identifiants et commentaires de code **en anglais**.
- Boucle à **pas fixe 60 Hz** (accumulateur, dt plafonné à 0,25 s), rendu interpolé à chaque
  `requestAnimationFrame` (ProMotion 120 Hz OK). Distances en px monde, vitesses en px/s, temps en secondes.
- Budget perf : < 4 ms mise à jour + rendu par image sur un iPhone récent. Pas d'allocation dans les boucles chaudes
  (pools pour particules, astéroïdes, projectiles), cache de rendu des tuiles par chunks.

## 2. Pitch & boucle de jeu

Ton vaisseau, l'**Albatros**, a explosé. Tu te réveilles dans ce qu'il en reste, au **centre** d'un grand secteur
spatial, avec ta combinaison et ton **MMU** (rétro-fusées). Objectif : **rentrer sur Terre** en atteignant le
**Module de retour**, garé tout au nord, près d'un trou noir.

1. **L'épave de l'Albatros** (centre) est ta base : tu y réapparais, tu y refais le plein (O2, carburant, coque,
   charges) et tu y dépenses ta **ferraille** à l'**Établi** (améliorations permanentes).
2. **Sortie** : tu pars dans une direction, tu dérives, tu découvres des lieux (navette abandonnée, station, lune,
   satellites, observatoire…), tu ramasses de la ferraille, des journaux de bord et des **équipements**.
3. **Équipements = clés** (métroidvania) : chaque équipement ouvre de nouveaux endroits
   (carte d'accès → station ; explosifs → galerie de la lune ; bouclier thermique → abords des soleils ;
   ancre gravitationnelle → abords du trou noir → Module de retour).
4. **Mort** (asphyxie, brûlure, trou noir, coque percée…) : la **balise de rappel** te ramène à l'Albatros.
   Tu **gardes** tes équipements, tes améliorations et ta ferraille **déposée** ; tu **perds** la ferraille
   **transportée** (non déposée). Les portes ouvertes, éboulis détruits, satellites activés, journaux lus et objets
   pris restent acquis. Les champs d'astéroïdes mobiles et la ferraille des champs de débris sont retirés au sort à
   chaque vie (graine de vie).
5. **Victoire** : embarquer dans le Module de retour → séquence de rentrée sur Terre → écran de statistiques
   (temps, morts, % de carte explorée, journaux trouvés). On peut ensuite continuer à explorer.

Durée visée : **35–60 min** pour un premier joueur jusqu'à la victoire, **~75 min** pour 100 %.

## 3. Monde

### 3.1 Géométrie
- Monde carré `WORLD_PX = 10240` px, grille de tuiles `TILE = 8` px → `WORLD_TILES = 1280` × 1280
  (`Uint8Array` de 1,6 Mo). Origine en haut à gauche, **y vers le bas** (nord = y négatif).
- Centre `CENTER = (5120, 5120)`. Toutes les positions ci-dessous sont **relatives au centre**.
- Chunks de rendu `CHUNK = 32` tuiles (256 px).
- **La géométrie statique est en tuiles** : coques des structures (épave, navette, station, observatoire, satellites,
  plateforme du module), lune (disque de roche rastérisé + galerie creusée), gros astéroïdes statiques, éboulis.
  Les sols intérieurs sont des tuiles **non solides** dessinées (le joueur flotte au-dessus).
- **Dynamique hors tuiles** : astéroïdes mobiles (cercles), débris, projectiles, charges explosives, soleils et
  trous noirs (corps analytiques : rayon, masse).
- **Limite du secteur** : cercle de rayon `BOUNDARY_R ≈ 4900` px. Au-delà : **tempête ionique** (dégâts de coque
  ~8/s, poussée vers le centre ~60 px/s², brouillage visuel). Mort possible : cause « Tempête ionique ».

### 3.2 Plan du secteur (macro-layout **fixe**, identique pour toutes les sauvegardes)

| Clé | Nom joueur | Position (px, rel. centre) | Taille | Contenu / rôle |
|---|---|---|---|---|
| `albatros` | Épave de l'Albatros | (0, 0) | ~22×16 tuiles | base : réapparition, **dock** (dépôt ferraille + plein), Établi, 1 journal |
| `colibri` | Navette Colibri (abandonnée) | (+1450, −950) | ~32×14 | **Carte d'accès** (cockpit), caisses de ferraille, 1 journal |
| `belt` | Ceinture de Charon | anneau r ≈ 1900–2350 | — | astéroïdes mobiles en orbite lente + amas statiques ; premier « contrôle de pilotage » |
| `orion` | Station Orion | (+3000, +1100) | ~64×44 | porte à **carte d'accès** ; couloirs, **barrières laser** à cycle, **tourelles** ; **Explosifs** (armurerie) ; **Ravitaillement** (O2 + carburant) ; **Casier** (recharge les charges) ; 2 journaux |
| `selene` | Lune Séléné | centre (−2900, +500), r ≈ 440 | disque | entrée de galerie **bouchée par un éboulis** (face est, vers le centre) ; galerie **Base Tycho** : tunnels, **évents de gaz** (poussée) ; **Bouclier thermique** au cœur ; 1 journal ; gravité faible |
| `twins` | Les Jumelles (Hélios A et B) | A (+100, +3350), B (+700, +3350) (à régler) | cœurs r ≈ 70 | deux soleils : chaleur mortelle, gravité, **éruptions** ; recharge solaire du carburant |
| `helios` | Observatoire Hélios | entre les deux soleils | ~20×14 | **Ancre gravitationnelle** ; 1 journal. Inaccessible sans bouclier (chaleur, §6.2) |
| `maelstrom` | Le Maelström (trou noir) + Charybde (petit compagnon) | M (−300, −3500), C (+1000, −3950) | horizon r ≈ 40 / 24 | gravité écrasante, disque d'accrétion ; attire astéroïdes et débris |
| `ulysse` | Module de retour (plateforme Ulysse) | orbite fixe à ~380 px du Maelström | ~14×10 | **victoire** : Embarquer (exige l'ancre, §6.3) ; 1 journal |
| `mistral` | Cargo Mistral (épave) | (−3300, −2600) | ~40×18 | optionnel : grosse réserve de ferraille, 1 journal |
| `sat1..sat6` | Satellites (6) | (−1500,−1700) (+2300,−2200) (+3900,−300) (+2200,+2800) (−2100,+2600) (−3600,−1500) | ~5×5 | **Activer** : révèle la carte dans un rayon ~1600 px, +15 ferraille |
| `debris` | Champs de débris | autour de l'Albatros, de Colibri, de Mistral | — | ferraille à ramasser (retirée au sort à chaque vie) |

La **graine de sauvegarde** (`save.seed`) ne décide que du remplissage : forme des amas d'astéroïdes statiques,
positions fines des débris et caisses « libres ». La graine de vie (`seed ^ deaths`) décide des astéroïdes mobiles
et de la ferraille des champs de débris.

### 3.3 Tuiles (`tiles.js`)
Chaque type : `{ id, key, name, solid, fragile, interior, door, colors, deco }`. Au minimum :
`space` (0), `hull` (coque métal, solide), `hull_dark`, `window` (solide, laisse voir), `floor` (intérieur, non
solide), `grate`, `wreck` (coque tordue de l'Albatros), `shuttle` (coque blanche de Colibri), `moon_rock`,
`moon_dust` (bord), `moon_floor` (sol de galerie, non solide), `rubble` (éboulis, **fragile** : détruit par
explosion), `asteroid` (gros astéroïde statique, solide, fragile pour les petits blocs `asteroid_small`), `ice`,
`door_locked` (solide tant qu'elle n'est pas ouverte, `door: 'keycard'`), `door_open` (non solide), `pad`
(emplacement d'objet, non solide), `panel`/`light` (décors lumineux non solides), `solar_panel` (solide),
`plating` (plateforme Ulysse).
- `interior` (identifiant de zone) : sert à l'obscurité intérieure (§9), à la musique et au nom de lieu affiché.
- Les éboulis détruits, portes ouvertes, etc. sont des **modifications persistantes** (§7).

### 3.4 Invariants de génération (testés)
Tous les POI existent aux bonnes positions ; le point de réapparition est libre ; chaque objet-clé est sur une case
non solide ; les portes à carte ferment la station (aucune autre entrée) ; l'éboulis ferme la galerie (aucune autre
entrée) ; aucune tuile solide dans l'horizon d'un trou noir ni dans un cœur de soleil ; les satellites sont hors des
zones mortelles ; **le graphe de progression est respecté** (§6.4).

## 4. Joueur (astronaute + MMU)

- Corps **cercle de rayon ~5 px**, sprite 16×16 orienté (**16 directions** pré-rastérisées depuis le pixel art, pas de
  rotation du canvas).
- **Contrôle absolu** (façon twin-stick, pas « tourner + pousser » à la *Asteroids*) : le stick donne la **direction
  de poussée dans le monde** ; l'astronaute pivote vers elle (vitesse angulaire ~12 rad/s) et les tuyères s'allument.
  Poussée analogique : accélération `thrustAccel × |stick|` (base ~170 px/s²).
- **Inertie** : aucune friction en apesanteur pure. Au-dessus de la vitesse de croisière `cruiseSpeed` (~140 px/s)
  la poussée dans le sens du mouvement n'ajoute plus rien (elle peut toujours freiner / dévier). La gravité, le
  Boost et les explosions peuvent dépasser la croisière ; plafond dur `hardMaxSpeed` ~420 px/s.
- **Assistance inertielle** (réglage, **activée par défaut**) : sans stick ni frein, un amortissement doux
  (~0,35 /s, gratuit) finit par t'immobiliser. Désactivée = Newton pur.
- **Frein** (rétro-fusées) : décélération ~260 px/s² opposée à la vitesse jusqu'à l'arrêt ; consomme du carburant.
- **Boost** : impulsion ~+170 px/s dans la direction du stick (ou du regard si stick neutre), recharge 1,2 s,
  coûte du carburant.
- **Collision tuiles** : rebond (restitution ~0,35, frottement tangentiel léger). Si la vitesse normale à l'impact
  dépasse `impactSafeSpeed` (~95 px/s) : dégâts ∝ (v − seuil), secousse, étincelles.
- **Ressources** (barres du HUD) :
  - **Coque** (PV) : base 100. À 0 → mort.
  - **Oxygène** : base ~150 s d'autonomie, se vide en continu hors du dock. À 0 → la coque perd ~12/s
    (« Asphyxie »). Alarme sous 25 %.
  - **Carburant** : base 100 u. Poussée ~6 u/s à fond, frein ~12 u/s, boost 22 u. **Recharge solaire** ~3 u/s après
    1,5 s sans poussée, ×3 près d'un soleil. À 0 : plus de poussée ni de frein (tu dérives).
  - **Charges explosives** (une fois les Explosifs trouvés) : 3, rechargées au dock et au Casier d'Orion.
- **Invulnérabilité** 0,6 s après un choc (pas contre la chaleur, l'asphyxie ni l'horizon).
- **Aimant** : la ferraille et les recharges sont attirées dans un rayon (base 24 px, améliorable).

## 5. Équipements (objets-clés, **conservés à la mort**)

| Clé | Nom | Où | Effet |
|---|---|---|---|
| `keycard` | Carte d'accès | cockpit de Colibri | ouvre les **portes verrouillées** de la station Orion (bouton Action devant la porte) |
| `explosives` | Charges explosives | armurerie d'Orion | bouton **Charge** : pose une charge qui dérive avec ta vitesse, explose après 2,5 s (rayon ~40 px) : détruit éboulis, petits astéroïdes, tourelles ; souffle qui te projette (et te blesse si tu es trop près) |
| `heatshield` | Bouclier thermique | cœur de la galerie de Séléné | chaleur des soleils × 0,06 (amendé, §15), éruptions × 0,2 |
| `anchor` | Ancre gravitationnelle | Observatoire Hélios | gravité des trous noirs × 0,25 (celle des soleils et de la lune n'est pas modifiée) ; **exigée pour embarquer** dans le module |

Ramasser un équipement : bannière + fanfare + explication d'une ligne (« La carte d'accès ouvre les portes d'Orion »),
sauvegarde immédiate.

## 6. Dangers & gating

### 6.1 Gravité (`physics.gravityAt`)
Sources : trous noirs, soleils, lune. `a = G·M / max(r, rSoft)²`, limitée à un rayon d'influence par source (espace
vide ailleurs). Cibles : **Maelström** — à 600 px l'attraction égale la poussée de base ; à 380 px (module) elle
dépasse la poussée maximale améliorée **plus** le frein ; horizon = mort (« Spaghettifié »). Soleils : ~60 px/s² à
300 px. Lune : ~25 px/s² en surface (on peut s'y mettre en orbite). La gravité attire aussi les astéroïdes mobiles et
les débris. Aide visuelle : distorsion et poussières spiralées près des trous noirs, avertissement HUD
« GRAVITÉ CRITIQUE » quand l'attraction dépasse la poussée disponible.

### 6.2 Soleils
- **Cœur** (r ~70 px) : contact = mort (« Carbonisé »).
- **Chaleur** jusqu'au rayon `heatR` (~650 px) : dégâts de coque croissants en s'approchant (courbe raide, à régler),
  × 0,06 avec le bouclier (amendé, §15). Écran qui vire à l'orangé, grésillement, avertissement « SURCHAUFFE ».
- **Éruptions** : toutes les 12–20 s par soleil, télégraphiées (le soleil pulse 1,5 s), un anneau s'étend
  (~500 px/s) jusqu'à ~1,5 × `heatR` : ~25 dégâts si l'anneau te touche **sans obstacle solide** entre toi et le
  soleil (s'abriter derrière un astéroïde ou une coque protège). × 0,2 avec le bouclier.
- Près d'un soleil, le carburant se recharge plus vite (risque / récompense).

### 6.3 Autres dangers
- **Astéroïdes mobiles** (pool, tailles S / M / L) : ceinture de Charon (orbite lente autour du centre) et abords du
  Maelström (spirale). Choc : rebond des deux corps + dégâts si la vitesse relative dépasse le seuil. Une charge
  brise un L en M, un M en S, un S en ferraille.
- **Tourelles** (station) : pivotent vers toi si ligne de vue, tirent des traits lents télégraphiés ; détruites par
  une charge.
- **Barrières laser** (station) : faisceaux à cycle (allumé / éteint, avec clignotement d'avertissement), dégâts
  forts au contact (« Désintégré »).
- **Évents de gaz** (galerie de Séléné) : jets intermittents qui poussent (zone de force), dégâts nuls ou faibles.
- **Tempête ionique** (bord du secteur) : §3.1.
- **Ta propre charge** : explosion proche = dégâts (« Pris dans ta propre explosion »).

Causes de mort (textes) : Asphyxie · Carbonisé par Hélios A/B · Brûlé vif · Spaghettifié par le Maelström /
Charybde · Coque percée (choc) · Désintégré (laser) · Abattu par une tourelle · Pris dans ta propre explosion ·
Emporté par la tempête ionique.

### 6.4 Graphe de progression (vérifié par un test de résolution)
Règle d'or : **puisque les équipements sont conservés à la mort, un verrou doit tuer À L'ALLER, pas au retour**
(sinon un aller-simple suicidaire suffit).
- `keycard` atteignable avec `{}` (aucune porte, aucune chaleur, aucune gravité bloquante sur le chemin).
- `explosives` atteignable avec `{keycard}`, **pas** avec `{}` (portes d'Orion : verrou dur).
- `heatshield` atteignable avec `{keycard, explosives}`, **pas** sans `explosives` (éboulis : verrou dur).
- `anchor` atteignable avec `{keycard, explosives, heatshield}`, **pas** sans `heatshield` : verrou **thermique**.
  Critère : sans bouclier, le chemin qui minimise les dégâts depuis n'importe quel point sûr jusqu'à l'objet, parcouru
  à la vitesse maximale atteignable (propulseurs au maximum + boosts enchaînés), inflige **≥ 1,5 × la coque maximale**
  possible ; avec le bouclier, **≤ 40 %** de la coque de base.
- `ulysse` (victoire) : **Embarquer exige `anchor`** (verrou dur, message : « Trop de gravité pour s'arrimer : il te
  faut l'Ancre gravitationnelle »). En plus, sans ancre, l'attraction au module dépasse poussée max + frein.
- Solveur (`tests/unit/progression.test.mjs`, réutilisable par `tools/`) : BFS sur une grille grossière (cases de
  16 px, dégagement du rayon joueur) depuis le point de réapparition ; bloquant = tuiles solides, portes sans carte,
  éboulis sans explosifs, cœurs et horizons, zones où la chaleur (sans bouclier) ou l'attraction (sans ancre) dépasse
  les seuils ci-dessus.

## 7. Méta-progression & sauvegarde (`meta.js`)

- **Ferraille** = monnaie. Transportée (`run.salvage`) → **déposée** en entrant dans le dock de l'Albatros
  (`save.salvage`). Perdue si tu meurs avant de la déposer.
- **Établi** (au dock, bouton contextuel) — améliorations permanentes (coûts en ferraille, cibles) :
  | Clé | Nom | Niveaux | Effet par niveau | Coûts (cible) |
  |---|---|---|---|---|
  | `o2` | Réservoir d'O2 | 4 | +45 s | 20 / 45 / 90 / 160 |
  | `fuel` | Réservoir de carburant | 3 | +25 % capacité et recharge | 15 / 40 / 90 |
  | `thrust` | Propulseurs | 4 | +15 % poussée, +12 % croisière | 25 / 60 / 120 / 200 |
  | `hull` | Blindage | 4 | +25 coque | 20 / 50 / 100 / 170 |
  | `radar` | Radar | 3 | portée de détection des lieux 900 → 1500 → 2200 → 3000 px | 15 / 50 / 110 |
  | `magnet` | Aimant | 2 | rayon d'attraction 24 → 48 → 80 px | 15 / 40 |
  | `charges` | Soute à charges | 2 | +1 charge (visible une fois les Explosifs trouvés) | 40 / 90 |
- Sources de ferraille : débris (1–3), caisses (8–15, une seule fois), satellites (15), astéroïdes brisés (2–6),
  journaux (5), cargo Mistral (~150 au total). Équilibrage : la victoire ne doit exiger aucune amélioration, mais les
  premières rendent le jeu nettement plus confortable ; tout acheter ≈ 100 % d'exploration.
- **Consommables** dans le monde : bonbonnes d'O2 (+40 s), cellules de carburant (+50 u), kits de réparation (+30).
- **Carte / brouillard** : bitset de cases de 64 px (160 × 160) marquées explorées dans un rayon ~260 px autour du
  joueur, et en grand par les satellites.
- **Sauvegarde** `localStorage` clé `derive.save.v1`, versionnée avec migration, tolérante aux erreurs (stockage
  indisponible, JSON corrompu copié dans `derive.save.v1.corrupt`) :
  `{ version, seed, items: {keycard, explosives, heatshield, anchor}, upgrades: {…}, salvage, world: { mods:
  [[tileIndex, tileId]…], crates: [], satellites: [], logs: [], taken: [] }, fog: '<base64>', stats: { deaths, time,
  distance, salvageTotal, victories, bestTime, logsRead }, settings: { muted, assist, shake, tips }, tips: {} }`.
  Sauvegarde à chaque événement (objet, dépôt, achat, porte, satellite, journal, mort, victoire) et toutes les 20 s.
- L'expédition en cours (position, ferraille transportée) n'est **pas** sauvegardée : recharger la page te remet à
  l'Albatros sans la ferraille transportée (pas de mort comptée).
- **Transfert** Safari ↔ écran d'accueil : code texte `DERIVE1:<base64>` (Réglages → Transférer).
- **Journaux de bord** (`LOGS`, ~9, français, 2–5 phrases) : l'histoire de l'équipage de l'Albatros, l'évacuation
  d'Orion, la base minière Tycho, les astronomes d'Hélios, le Maelström et le module Ulysse. Lus via un terminal
  (overlay DOM), relisibles dans le menu Pause → Journaux.

## 8. Contrôles

**Tactile (paysage)** — multi-touch par `identifier`, réaction sur `touchstart` :
- Moitié gauche : **stick flottant** (apparaît sous le pouce, rayon ~48 px CSS, zone morte 0,18) = direction et force
  de poussée.
- En bas à droite, gros boutons ronds (~64 px CSS) : **Frein**, **Boost**, et **Charge** (visible une fois les
  Explosifs trouvés). Au-dessus : bouton contextuel **Action** (libellé : Ouvrir, Activer, Lire, Établi, Embarquer…)
  qui n'apparaît que près d'un élément interactif.
- En haut à droite : **Carte** et **Pause**. Respect des `safe-area-inset-*` (encoche / Dynamic Island).

**Clavier** : flèches / WASD / ZQSD = poussée ; Maj ou X = frein ; Espace = boost ; E = action ; C = charge ;
Tab ou M = carte ; Échap / P = pause. **Manette** : stick gauche = poussée, A = boost, B / LT = frein, X = charge,
Y = action, Select = carte, Start = pause.

## 9. Rendu

- **Résolution interne à échelle entière** : `s = max(1, floor(hauteurPixelsDevice / 250))`, interne =
  `floor(dimsDevice / s)` (iPhone 13 paysage : ×4 → 633 × 292). Le canvas contient l'image interne, le CSS l'agrandit
  ×s avec `image-rendering: pixelated` (méthode de Gouffre).
- **Caméra** : suit le joueur avec anticipation dans le sens de la vitesse (≤ 70 px) + lissage, alignée au pixel
  (ancrage sur la position interpolée du joueur pour éviter le scintillement).
- **Fond** : ciel étoilé en 3 couches de parallaxe (étoiles scintillantes), nébuleuses teintées selon la région
  (bleu près de Séléné, orangé près des Jumelles, violet près du Maelström, vert-cyan à la tempête ionique),
  quelques galaxies lointaines. Tout est dessiné par code et mis en cache (tuiles de fond répétées).
- **Tuiles** pré-rendues par chunks de 32×32 (cache invalidé par chunk, patch 3×3 lors d'une modification). Bords
  ombrés côté vide, éclairage directionnel simple (lumière venant du soleil le plus proche ou d'un « soleil lointain »
  par défaut).
- **Intérieurs sombres** : dans une zone `interior`, un calque d'obscurité percé par la **lampe frontale** (cône dans
  la direction du regard + halo) et par les lumières des panneaux.
- Corps célestes : soleils animés (disque pixel, granulation, couronne, halo additif), trous noirs (disque noir,
  anneau de photons, disque d'accrétion animé, particules spiralées), lune (texture de cratères via les tuiles).
- Particules (flammes de tuyère, étincelles, débris, poussière, fumée, braises, éclats de glace), secousses d'écran,
  hit-stop léger sur les gros chocs.
- Pixel art défini **dans le code** (tableaux de chaînes + palettes), rastérisé au chargement. Planche de
  prévisualisation : `tools/sprites.html`.

## 10. HUD & écrans

- **HUD canvas** (police bitmap avec accents, reprise de Gouffre) : en haut à gauche, trois barres avec icônes
  (Coque rouge, O2 cyan, Carburant orange) + charges ; en dessous « FERRAILLE 120 (+14) » (déposée + transportée).
  En haut au centre : nom du lieu à l'entrée d'une zone, bannières, toasts. Avertissements clignotants
  (O2 BAS, SURCHAUFFE, GRAVITÉ CRITIQUE, CARBURANT VIDE, TEMPÊTE IONIQUE).
- **Radar** : flèches au bord de l'écran vers les lieux **découverts** ou **dans la portée radar** (icône + distance
  en m, 1 m = 8 px), l'Albatros toujours indiqué (« ⌂ »).
- **Carte** (`mapview.js`, état `MAP`, pause le jeu) : secteur entier, brouillard, lieux découverts avec icônes et
  noms, position et cap du joueur, dangers connus (soleils, trous noirs, ceinture), légende des équipements possédés.
- **Overlays DOM** (style « console de vaisseau » : fond bleu nuit translucide, liseré cyan, police monospace) :
  titre (logo pixel « DÉRIVE », Jouer / Continuer, Réglages, conseil d'installation), pause (Reprendre, Carte,
  Journaux, Commandes, Réglages, Balise de rappel = mort volontaire avec confirmation), Établi, journal de bord,
  mort (cause, ferraille perdue, « Balise de rappel activée »), victoire (cinématique canvas puis statistiques),
  réglages (Son, Assistance inertielle, Secousses, Astuces, Transférer, Effacer la sauvegarde avec confirmation),
  commandes, transfert.
- **Astuces** contextuelles une seule fois (première poussée, freiner, O2 bas, première ferraille, dépôt au dock,
  premier satellite, porte verrouillée, éboulis, chaleur, gravité…), désactivables.
- Portrait → overlay « Tourne ton iPhone ». `visibilitychange` → pause auto.

## 11. Audio (`audio.js`)

WebAudio **synthétisé** (aucun fichier). SFX : poussée (souffle filtré en boucle, volume ∝ poussée), frein, boost,
choc (selon vitesse), impact métal / roche, ramassage ferraille, bonbonne, objet-clé (fanfare), porte, satellite
(bips + balayage), journal, dépôt (« cha-ching »), achat, charge posée / bip / explosion, laser, tir de tourelle,
éruption (montée), alarme O2 (bips), surchauffe (grésillement ∝ chaleur), grondement du trou noir (∝ proximité),
mort, réapparition, victoire, UI. **Ambiance** procédurale par zone (nappes lentes, notes lointaines) : espace
profond, intérieur, Séléné, Jumelles, Maelström. `AudioContext` débloqué au premier toucher (iOS). Muet sauvegardé.

## 12. iOS / PWA
Comme Gouffre : `viewport-fit=cover`, `user-scalable=no`, `apple-mobile-web-app-capable`, status bar
`black-translucent`, `apple-touch-icon` 180, `manifest.webmanifest` (`display: fullscreen`, `orientation: landscape`,
icônes 192/512 + maskable). CSS `touch-action: none`, `user-select: none`, `-webkit-touch-callout: none`,
`overscroll-behavior: none`, `body { position: fixed }` ; `preventDefault` sur `touchmove`, `gesturestart`,
`dblclick`. **Service worker** cache-first versionné (`derive-v1`, préfixe `derive-` : ne touche qu'à ses propres
caches), enregistré seulement hors localhost.

## 13. Architecture du code (`derive/src/`)

Un objet **`game`** (contexte) est passé aux systèmes ; pas de singletons mutables cachés.

| Fichier | Rôle / API principale |
|---|---|
| `main.js` | boot, resize, boucle à pas fixe, machine d'états `TITLE / PLAYING / PAUSED / MAP / SHOP / LOG / DEAD / VICTORY`, hooks du jeu |
| `config.js` | **toutes** les constantes de réglage (monde, POI, joueur, dangers, économie, caméra, tactile, clés de sauvegarde) |
| `rng.js` | PRNG seedé (copie de Gouffre) : `createRng(seed)`, bruit 2D, `hash2` |
| `tiles.js` | registre des tuiles : `TILES`, `TILE_ID`, `tileDef(id)`, tables `SOLID`, `FRAGILE` |
| `world.js` | `World` : `types`, `interior`, `get/set` (journalise les modifications → `mods`, `chunkVersion`, `dirtyLog`), `isSolid(tx,ty)`, `isSolidAt(px,py)`, `circleSolid(x,y,r)`, `blast(x,y,r) → tuiles détruites` (fragiles seulement), `applyMods(list)`, `zoneAt(px,py)` |
| `structures.js` | plans ASCII des structures (albatros, colibri, orion, helios, ulysse, mistral, satellite, galerie Tycho) + légende |
| `worldgen.js` | `generateWorld(seed) → { world, spawn, dock, pois, suns, blackHoles, moon, satellites, items, doors, terminals, crates, pickups, refills, lockers, turrets, lasers, vents, belt, capsule, seed }` |
| `physics.js` | `moveCircle(body, dt, world) → { hit, nx, ny, impact }` (cercle balayé contre les tuiles, sous-pas ≤ 3 px), `gravityAt(x, y, sources, out, mulBH)`, `heatAt(x, y, suns)`, `raycast(world, x0, y0, x1, y1)`, `collideCircles(a, b, restitution)` |
| `player.js` | `Player(game)` : `reset(x,y)`, `update(dt)`, `damage(amount, cause, opts)`, `refill()`, `die(cause)`, `impulse(ix,iy)` ; champs `x y vx vy r angle hull o2 fuel charges stats thrust braking dead iframes` |
| `hazards.js` | `Hazards(game)` : soleils (chaleur, éruptions), trous noirs, lune, astéroïdes mobiles (pool), tourelles + projectiles, lasers, évents, tempête ionique, charges & explosions ; `reset(gen, lifeSeed)`, `update(dt)`, `gravityAt(x,y,out)`, `heatAt(x,y)`, `explode(x,y,r,power,cause)` ; **aucun dessin** : état public lu par `render.js` |
| `entities.js` | `Entities(game)` : ferraille & consommables (pool), objets-clés, satellites, terminaux, portes, caisses, ravitaillement, casier, module ; `reset(gen, lifeSeed)`, `update(dt)`, `interactable` (le plus proche, avec libellé), `interact()` ; **aucun dessin** : état public lu par `render.js` |
| `meta.js` | sauvegarde / migration / transfert, `ITEMS`, `UPGRADES`, `upgradeCost`, `buyUpgrade`, `applyUpgrades(player, save)`, `depositSalvage(save, run)`, `settleDeath(save, run)`, `LOGS`, fog (encode / décode) |
| `render.js` (+ `render-*.js` éventuels) | `Camera(game)` : `update(dt)`, `snap()`, `shake(px, s)`, `x/y` ; `Renderer(game, canvas)` : `resize(cssW, cssH, dpr)` (renseigne `game.view = {w, h, scale}`), `render(alpha)`, `invalidateAll()`. Dessine fond, tuiles (cache chunks), dangers, entités, joueur, particules, obscurité intérieure, halos, puis le HUD, ou la carte (`drawMap`) en état `MAP`. **Toute la présentation vit ici** (la simulation n'a aucun code de dessin) |
| `sprites.js` | pixel art en code : `loadSprites()`, `getSprite(name)`, `drawSprite(ctx, name, frame, x, y, opts)`, `getTileTexture(id, variant)`, `makeIcon(name, cssPx)` |
| `particles.js` | pool : `spawn(kind, x, y, opts)`, `update(dt)`, `draw(ctx, cam)`, `clear()` |
| `audio.js` | `play(name, opts)`, `setLoop(name, level)` (poussée, chaleur, grondement, alarme), `setZone(key)`, `setMuted`, `unlock`, `suspend/resume` |
| `hud.js` | `drawText(ctx, str, x, y, color, opts)`, `measureText`, `Hud(game)` : barres, ferraille, radar, avertissements, toasts, bannières, nom de lieu, astuces |
| `mapview.js` | `drawMap(ctx, game, w, h)` : carte plein écran avec brouillard |
| `ui.js` | overlays DOM : `showTitle / showPause / showShop / showLog / showLogs / showDeath / showVictory / showSettings / showControls / showTransfer`, `hide`, `notice`, navigation clavier / manette |
| `input.js` | `moveX/moveY` (vecteur de poussée, norme 0..1), `pressed/held/released(a)` ; actions `boost brake action charge map pause` ; `beginTick/endTick`, `inject(...)`, `tap(a)`, `clearInjected()`, `setContextAction(label\|null)`, `setButtonVisible(action, b)` |
| `tips.js` | `Coach(game)` : astuces contextuelles, mémorisées dans `save.tips` |
| `debug.js` | drapeaux `?debug ?god ?seed= ?at=<clé de POI> ?x=&y= ?items=all\|keycard,explosives… ?salvage= ?bank= ?reveal ?autostart ?mute ?nosw` ; `window.__derive` pour les tests |

La simulation (`config, tiles, world, structures, worldgen, physics, player, hazards, entities, meta`) tourne
**sans navigateur** (tests Node) : elle n'appelle le reste qu'à travers les hooks du contexte.

**Contexte `game`** : `game.{flags, state, time, world, gen, player, camera, input, audio, particles, renderer, hud,
ui, hazards, entities, coach, save, run, safe, hitStopTicks}`.
**Hooks obligatoires** (le juice est branchable sans toucher à la logique) : `game.audio.play(...)`,
`game.particles.spawn(...)`, `game.camera.shake(px, s)`, `game.hitStop(s)`, `game.toast(text, opts)`,
`game.banner(title, sub)`, `game.onPlayerDeath(cause)`, `game.onItem(key)`, `game.onSatellite(id)`,
`game.onLog(key)`, `game.deposit()`, `game.persist()`, `game.reveal(x, y, r)`, `game.explosion(x, y, r, power,
cause)`, `game.victory()`, `game.setState(s)`, `game.respawn()`.
`game.run = { salvage, lifeSeed, time, distance, startedAt, deathsThisSession }`.

**Ordre du pas fixe** (`updatePlaying`) : pause → `input` → `player.update` (poussée, frein, boost, gravité via
`hazards.gravityAt`, déplacement / collisions, ressources) → `hazards.update` → `entities.update` (aimant,
ramassage, interactions) → `particles.update` → `camera.update` → `hud.update` → brouillard → dock (dépôt + plein)
→ `coach.update` → minuteurs (mort, victoire).

## 14. Tests

- `derive/tests/unit/*.test.mjs` avec `node --test` : rng, tuiles / monde (modifs persistantes, blast), physique
  (balayage, rebond, dégâts d'impact, pas de traversée à haute vitesse), gravité et chaleur (valeurs cibles §6),
  joueur (poussée, croisière, frein, boost, carburant, O2, assistance), worldgen (invariants §3.4), **progression
  (§6.4)**, méta (coûts, achats, dépôt, mort, migration, transfert, fog), dangers (éruption bloquée par obstacle,
  explosion, astéroïdes).
- `derive/tests/e2e/smoke.mjs` : Playwright (installé globalement, résolu via `npm root -g`), serveur statique
  intégré, profil **iPhone 13 paysage** tactile. Zéro erreur console ; titre → jeu ; poussée au stick tactile réel
  (CDP) ; frein ; ramassage + dépôt ; achat à l'Établi ; mort (soleil) → réapparition, équipement conservé,
  ferraille transportée perdue ; porte d'Orion (sans puis avec carte) ; charge sur l'éboulis ; carte ; journal ;
  victoire (téléport debug) ; rechargement de page → sauvegarde intacte. Captures dans `tests/e2e/screenshots/`
  (ignoré par git).
- `derive/package.json` : scripts `test`, `test:e2e`, `serve` (aucune dépendance).

## 15. Amendements
Écarts au contrat, décisions de réglage et APIs ajoutées, par étape. Le détail (valeurs, raisons, mesures) est dans
`NOTES.md` ; les valeurs font foi dans `src/config.js` et `src/render-config.js`.

**Simulation**
- Écoutille du module Ulysse à **336 px** du Maelström (et non ~380) : une attraction en 1/r² ne peut pas valoir la
  poussée de base à 600 px et dépasser poussée max + frein à 380 px. À 336 px : 558 px/s² (139 avec l'ancre).
- Chaleur : exposant 2, `heatMax` 840 hull/s à la surface du cœur ; les coques isolées (`ZONES[].sheltered`)
  multiplient la chaleur par 0,01 (voir Intégration).
- Le **dock** (dépôt, plein, charges) est géré par `entities.update`, pas par `main.js`.
- Les objets-clés se prennent en **touchant** leur socle ; les consommables ne sont ramassés que s'il manque au moins
  25 % de leur valeur (sinon ils attendent).
- Les **tourelles** reviennent à chaque vie (non sauvegardées). `save.world.taken` liste les caches ponctuelles.
- Astéroïdes de la ceinture sur orbites guidées (pas de gravité libre) ; les fragments d'astéroïdes brisés subissent
  la vraie gravité.
- Laser : un contact = 40 de coque, invulnérabilité et poussée hors du faisceau (pas de dégâts continus).
- Orion mesure 64 × 40 tuiles. POI supplémentaire `tycho` (bouche de la galerie, absent du radar).
- `settleDeath(save, run, cause)` prend la cause et remet `run.salvage` à zéro.
- Ajouts : `gen.structures, gravitySources, caches, workbench, debrisFields, rubble`, champs `icon / radar / always /
  label` des POI, `hazards.spawnAsteroid`, `ASTEROID_MODE`, `heatField()`, `entities.spawnSalvage / spawnPickup /
  blastPush`, `meta.lifeSeedFor / recordVictory / fogCellRevealed / poiDiscovered / POI_NAMES`, `tools/solver.mjs`.

**Présentation**
- Les réglages de présentation vivent dans `src/render-config.js` (pas dans `config.js`).
- `Renderer.render()` pilote aussi l'audio (boucles et ambiance selon l'état) : `main.js` n'appelle jamais `setLoop`
  ni `setZone`. `game.view` porte en plus `cssToInternal, camX, camY`.
- Pas de cinématique de victoire dans le renderer : celle de `ui.js` (canvas opaque, bouton Passer) est la seule.
- `Particles.draw(ctx, camX, camY, pass)` (`'lit' | 'emissive' | 'all'`) ; `new Particles(game)` fait rebondir les
  débris sur les tuiles. Sortie supplémentaire de `sprites.js` : `celestial, backdrop, getGlow, hasSprite…`.
- Zones réservées du radar en px CSS (`HUD_LAYOUT.*Css`), recopiées de `input.js layout()` : les changer ensemble.

**Coquille**
- Minuteries de la coquille dans `SHELL` en tête de `main.js` (autosauvegarde 20 s, dérive du corps 1,8 s…).
- `game.startGame()` ne débloque pas l'audio (les boutons le font dans leur geste) ; `debug.applyStartFlags` renvoie
  `true` quand il téléporte ; `teleportTo('maelstrom' | 'charybde')` place à distance prudente.
- Noms des régions ouvertes (Maelström, Charybde, Jumelles, Séléné, Ceinture, Tempête) annoncés par `main.js`, ceux
  des intérieurs par le HUD.

**Intégration**
- **Bouclier thermique : chaleur × 0,06** (au lieu de × 0,1) et **coques isolées × 0,01** (au lieu de 0,05) :
  l'approche d'Hélios à vitesse de croisière coûtait ~63 de coque et l'observatoire brûlait 3/s même avec le
  bouclier. Critère §6.4 toujours tenu : 331 sans bouclier (≥ 300), 19 avec (≤ 40). Éruptions toujours × 0,2.
- **Carburant à la croisière** : la poussée ne consomme que la variation de vitesse réellement appliquée. Pousser dans
  le sens de la course à la vitesse de croisière laisse une petite flamme (`PLAYER.cruiseFlame`) et ne brûle rien.
- Rendu : les corps célestes sont dessinés **sous** les entités et l'astronaute.
- Radar : au plus `RADAR.maxArrows` (6) flèches, les plus proches (l'Albatros toujours compté).
- Police bitmap : glyphes `Ö` `Ä`, virgule lisible, `hasGlyphs()` ; astuce `heatShield` (bouclier possédé).
- Bouton contextuel 124 × 46 px CSS. Outils `tools/feel.mjs` (`npm run feel`) et `tools/tour.mjs` (`npm run tour`).
- Tests e2e étendus (asphyxie, aimant, trou noir, bouclier / ancre, session clavier sur ordinateur).
