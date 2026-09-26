# Dérive

Exploration spatiale en pixel art, vue de dessus, en apesanteur, avec une boucle rogue-lite. Le jeu est pensé pour
**iPhone en paysage** (Safari ou application sur l'écran d'accueil) et se joue aussi au clavier ou à la manette sur
ordinateur.

Ton vaisseau, l'**Albatros**, a explosé. Tu te réveilles dans son épave, au centre d'un grand secteur spatial, avec
ta combinaison et tes rétro-fusées. Tu pars dans une direction, tu dérives, tu découvres une navette abandonnée, une
station, une lune, des satellites, un observatoire coincé entre deux soleils… Il faut éviter les trous noirs qui
aspirent tout, les soleils qui brûlent et les astéroïdes. Ton but : **rentrer sur Terre** à bord du **Module de
retour Ulysse**, garé tout au nord, au bord du Maelström.

Tout est écrit en JavaScript (modules ES), sans dépendance, sans CDN et sans étape de compilation. Les graphismes
sont dessinés dans le code et les sons synthétisés. Une fois chargé, le jeu marche hors ligne.

---

## Jouer sur iPhone

1. **Héberger le dossier `derive/`** sur un hébergement statique en **HTTPS** (le service worker, qui permet le jeu
   hors ligne, exige HTTPS). Le plus simple est GitHub Pages depuis ce dépôt : *Settings → Pages → Deploy from a
   branch*, branche voulue, dossier `/ (root)`. Le jeu est alors à l'adresse
   `https://<utilisateur>.github.io/<dépôt>/derive/`.
   (Le `index.html` à la racine du dépôt est un autre projet, et `gouffre/` un autre jeu : Dérive est bien dans
   `derive/`.)
2. Ouvrir cette adresse dans **Safari**.
3. **Partager → « Sur l'écran d'accueil »** : Dérive s'installe comme une application, en plein écran et sans les
   barres de Safari. L'écran titre le rappelle tant que tu joues dans un onglet Safari.
4. Jouer **en paysage** (en portrait, un écran te demande de tourner le téléphone et le jeu se met en pause).
5. **Hors ligne** : après un premier chargement complet avec du réseau, le jeu démarre sans connexion. Quand tu
   publies une nouvelle version (pense à changer `VERSION` dans `sw.js`), le jeu la télécharge en arrière-plan lors
   d'un lancement avec du réseau et l'utilise au lancement suivant.

**Sauvegarde.** Ta progression (équipement, ferraille déposée, améliorations, carte explorée, portes ouvertes,
journaux lus, statistiques) reste sur l'appareil, dans le stockage du navigateur. Elle est écrite à chaque événement
important et toutes les 20 secondes. Sur iOS, l'onglet Safari et l'application de l'écran d'accueil ont **chacun leur
propre stockage**, et Safari peut effacer les données d'un site après 7 jours sans visite : mieux vaut jouer depuis
l'écran d'accueil. Pour passer ta progression de l'un à l'autre : **Réglages → Transférer** (tu copies le code d'un
côté et tu le colles de l'autre). La sortie en cours (ta position, la ferraille transportée) n'est pas sauvegardée :
recharger la page te ramène à l'Albatros, sans compter de mort.

## Commandes

| Action | Tactile (paysage) | Clavier | Manette |
|---|---|---|---|
| Pousser (direction et force) | joystick flottant sur la moitié gauche | flèches, ZQSD (AZERTY) ou WASD (QWERTY) | stick gauche / croix |
| Freiner (rétro-fusées) | bouton **Frein** | Maj ou X | B ou LT |
| Boost (impulsion) | bouton **Boost** | Espace | A |
| Poser une charge | bouton **Charge** (après les Explosifs) | C | X |
| Ouvrir, Lire, Activer, Établi, Embarquer… | bouton **Action** qui apparaît près d'un élément | E | Y |
| Carte du secteur | bouton en haut à droite | Tab ou M | Select |
| Pause | bouton en haut à droite | Échap ou P | Start |

- Le joystick donne la **direction de poussée dans l'espace** : l'astronaute se tourne tout seul. Plus tu pousses
  le pouce loin, plus la poussée est forte. Au-delà de la vitesse de croisière, pousser ne t'accélère plus, mais la
  gravité, le Boost et les explosions, si.
- **Assistance inertielle** (activée par défaut, Réglages) : sans poussée ni frein, tu ralentis doucement jusqu'à
  l'arrêt. Désactivée, tu dérives comme dans le vrai vide.
- Menus : au doigt, au clavier (flèches, Entrée, Échap) ou à la manette (croix, A, B). Le panneau **Commandes** (Pause
  ou Réglages) récapitule tout.

## Boucle de jeu

1. **L'épave de l'Albatros** est ta base. Dans son **dock**, ta combinaison se recharge (coque, oxygène, carburant,
   charges) et ta ferraille est **déposée**. À côté, l'**Établi** vend les améliorations.
2. **Sortir** : l'oxygène baisse dès que tu quittes le dock, le carburant brûle quand tu pousses ou freines (il se
   recharge seul au soleil après un moment sans poussée). Tu ramasses la ferraille des champs de débris et des
   caisses, des bonbonnes d'O2, des cellules de carburant et des kits de réparation.
3. **Découvrir** : les **satellites** dévoilent la carte autour d'eux, les **terminaux** racontent ce qui est arrivé
   au secteur (9 journaux), et chaque **équipement** ouvre de nouveaux endroits.
4. **Mourir** (asphyxie, choc, soleil, trou noir, laser, tourelle, ta propre charge, tempête ionique…) : la balise de
   rappel te ramène à l'Albatros. Tu gardes ton équipement, tes améliorations, ta ferraille déposée et tout ce que tu
   as ouvert ou activé ; tu perds seulement la ferraille **transportée**. Les astéroïdes mobiles et les débris sont
   tirés au sort à chaque vie. En cas de besoin, **Pause → Balise de rappel** te ramène volontairement (c'est une mort).
5. **Rentrer** : embarque dans le Module Ulysse, regarde la rentrée sur Terre, puis consulte tes statistiques (temps,
   morts, carte explorée, journaux). Tu peux ensuite continuer à explorer.

### Équipement

| Équipement | Où le trouver | Ce qu'il ouvre |
|---|---|---|
| Carte d'accès | cockpit de la navette Colibri | les portes de la station Orion |
| Charges explosives | armurerie d'Orion | bouton Charge : éboulis, petits astéroïdes, tourelles (la galerie de la lune Séléné) |
| Bouclier thermique | cœur de la galerie de Séléné | chaleur des soleils fortement réduite, sans l'annuler (l'observatoire Hélios) |
| Ancre gravitationnelle | observatoire Hélios | attraction des trous noirs ÷ 4, **indispensable pour embarquer** |

### Améliorations (Établi)

Réservoir d'O2, Réservoir de carburant, Propulseurs, Blindage, Radar (portée de détection des lieux), Aimant (rayon
de ramassage) et Soute à charges (après les Explosifs). Aucune n'est obligatoire pour gagner, mais les premières
rendent les sorties bien plus confortables.

### Conseils

- Premières sorties : ramasse les débris autour de l'Albatros, reviens au dock, puis achète le **Réservoir d'O2** ou
  l'**Aimant**.
- Pousser dans le sens de ta course une fois à la vitesse de croisière ne coûte rien : seuls les changements de
  vitesse brûlent du carburant.
- Garde un œil sur l'oxygène : le retour prend autant de temps que l'aller. Le **Frein** évite les chocs à grande
  vitesse, qui percent la coque.
- Active les **satellites** : ils révèlent une grande partie de la carte et rapportent de la ferraille.
- Les **éruptions** des soleils sont annoncées : le soleil pulse avant de cracher. Abrite-toi derrière un rocher ou
  une coque.
- Près d'un trou noir, l'avertissement **GRAVITÉ CRITIQUE** veut dire que l'attraction dépasse ta poussée : fais
  demi-tour tant qu'il est temps.
- Une charge dérive avec ta vitesse et explose au bout de 2,5 s : pose-la, puis éloigne-toi.
- Des **astuces** s'affichent une seule fois pendant les premières parties ; tu peux les couper ou les réactiver dans
  Réglages → Astuces.

## Lancer en local

Il faut **Node.js 20 ou plus récent**, sans rien installer d'autre.

```sh
cd derive
npm run serve          # http://localhost:8080/index.html
```

Le service worker est désactivé en local, pour que chaque modification soit visible tout de suite.
Paramètres d'URL utiles pour le développement :

| Paramètre | Effet |
|---|---|
| `?debug` | touches G (mode dieu) et R (révèle la carte), pas de service worker |
| `?god` | invulnérable (sauf la Balise de rappel) |
| `?seed=123` | graine de la sauvegarde (remplissage du secteur) |
| `?at=orion` | démarre près d'un lieu ou d'un élément (`colibri`, `selene`, `helios`, `capsule`, `rubble`, `orion:door0`, `sat3`… ; `maelstrom` et `charybde` : à distance prudente du trou noir) |
| `?x=1500&y=-900` | démarre à une position (px, relative au centre du secteur) |
| `?items=all` ou `?items=keycard,explosives` | donne des équipements |
| `?salvage=40` / `?bank=500` | ferraille transportée / déposée |
| `?reveal` | révèle toute la carte |
| `?autostart`, `?mute`, `?nosw` | saute l'écran titre, coupe le son, pas de service worker |

## Tests

```sh
npm test               # tests unitaires de la simulation (node --test)
npm run test:e2e       # parcours complet dans Chromium, profil « iPhone 13 paysage » tactile
npm run solver         # preuve de la progression (quels équipements ouvrent quels lieux)
npm run feel           # chiffres de pilotage : croisière, frein, dérive, ceinture, approche d'Hélios
npm run tour -- /tmp/tour   # captures de chaque lieu dans le vrai jeu (voir plus bas)
```

Les tests de bout en bout utilisent **Playwright installé globalement**, résolu par `npm root -g`, avec son
Chromium. Ils ne téléchargent rien. Ils touchent l'écran pour de vrai (joystick et boutons), ramassent et déposent
de la ferraille, achètent à l'Établi, meurent dans un soleil, par asphyxie et dans le Maelström, vérifient le
bouclier thermique et l'ancre, ouvrent une porte d'Orion, font sauter l'éboulis, lisent un journal, rentrent sur
Terre, rechargent la page et jouent au clavier sur un écran d'ordinateur. Les captures d'écran vont dans
`tests/e2e/screenshots/`, ignoré par git.

`npm run tour -- /tmp/tour` fait le tour du secteur dans le vrai jeu (profil iPhone 13 paysage) et enregistre une
capture par lieu, plus la carte, la pause et l'Établi.

## Structure

```
derive/
├── index.html              page unique : canvas, calques tactiles et menus, styles « console de vaisseau »
├── manifest.webmanifest    PWA (plein écran, paysage, icônes)
├── sw.js                   service worker : cache versionné, jeu hors ligne
├── icons/                  icônes de l'application
├── DESIGN.md               contrat de conception (règles, architecture, amendements)
├── NOTES.md                référence développeur (APIs, réglages, niveaux, shell)
├── src/
│   ├── main.js             démarrage, boucle à pas fixe 60 Hz, états, vies, dépôt, mort, victoire
│   ├── config.js           constantes de la simulation ; render-config.js : celles de la présentation
│   ├── worldgen.js · structures.js   secteur, lieux dessinés en ASCII, ceinture, lune
│   ├── world.js · tiles.js · physics.js   grille de tuiles, collisions, gravité, chaleur
│   ├── player.js           astronaute, rétro-fusées, ressources
│   ├── hazards.js          soleils, trous noirs, astéroïdes, tourelles, lasers, évents, charges
│   ├── entities.js         ferraille, consommables, équipements, portes, caisses, terminaux, satellites
│   ├── meta.js             sauvegarde, Établi, journaux, brouillard de la carte, transfert
│   ├── render.js · sprites.js · particles.js · hud.js · mapview.js   rendu, pixel art, effets, HUD, carte
│   ├── audio.js            sons et ambiances synthétisés
│   ├── ui.js               menus DOM et cinématique de rentrée
│   ├── input.js · tips.js  tactile / clavier / manette, astuces des premières parties
│   └── debug.js            paramètres d'URL et poignée de test window.__derive
├── tests/unit/             tests unitaires
├── tests/e2e/              test de bout en bout + petit serveur statique
└── tools/                  solveur de progression, planche de sprites, captures, tour visuel
```

## Limites connues

- **Jamais testé sur un vrai iPhone, ni dans WebKit** : les tests tournent dans Chromium. L'affichage agrandit un
  petit canvas par CSS (`image-rendering: pixelated`), méthode déjà utilisée par Gouffre.
- **Audio entièrement synthétisé** (WebAudio). Sur iOS, le son se débloque au premier toucher, et le mode silencieux
  du téléphone peut le couper.
- Sauvegarde **locale uniquement** (voir « Sauvegarde ») : ni compte ni synchronisation.
- Manette : correspondance standard seulement.
