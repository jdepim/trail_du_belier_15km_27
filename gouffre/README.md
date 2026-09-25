# Gouffre

Rogue-lite de minage en pixel art, dans une ambiance gothique à la *Castlevania*, pensé pour **iPhone en
paysage** (Safari ou application sur l'écran d'accueil). Il se joue aussi au clavier ou à la manette sur ordinateur.

Tu pars d'un camp à la surface et tu creuses une mine générée au hasard. Tu ramasses des minerais, tu
affrontes ce qui vit dans le noir et tu remontes ton butin au camp avant de mourir. L'or rapporté paie des améliorations
permanentes à la Forge. Tout au fond, à environ −260 m, t'attend **le Gardien de l'Abysse**.

Tout est écrit en JavaScript (modules ES), sans dépendance, sans CDN et sans étape de compilation. Les graphismes
sont dessinés dans le code et les sons synthétisés. Une fois chargé, le jeu marche hors ligne.

---

## Jouer sur iPhone

1. **Héberger le dossier `gouffre/`** sur n'importe quel hébergement statique en **HTTPS** (le service worker,
   qui permet le jeu hors ligne, exige HTTPS). Le plus simple est GitHub Pages depuis ce dépôt :
   *Settings → Pages → Deploy from a branch*, branche voulue, dossier `/ (root)`. Le jeu est alors à l'adresse
   `https://<utilisateur>.github.io/<dépôt>/gouffre/`.
   (Le `index.html` à la racine du dépôt est un autre projet : le jeu est bien dans `gouffre/`.)
2. Ouvrir cette adresse dans **Safari**.
3. **Partager → « Sur l'écran d'accueil »** : Gouffre s'installe comme une application, en plein écran et sans les
   barres de Safari. L'écran titre le rappelle tant que tu joues dans un onglet Safari.
4. Jouer **en paysage** (en portrait, un écran demande de tourner le téléphone).
5. **Hors ligne** : après un premier chargement complet avec du réseau, le jeu démarre sans connexion.
   Quand tu publies une nouvelle version (pense à changer `VERSION` dans `sw.js`), le jeu la télécharge en
   arrière-plan lors d'un lancement avec du réseau et l'utilise au lancement suivant.

**Sauvegarde.** La progression (or banqué, améliorations, statistiques) reste sur l'appareil, dans le stockage du
navigateur. Sur iOS, l'onglet Safari et l'application de l'écran d'accueil ont **chacun leur propre stockage**, et
Safari peut effacer les données d'un site après 7 jours sans visite. Mieux vaut donc jouer depuis l'écran d'accueil.
Pour passer la progression de l'un à l'autre : **Réglages → Transférer**. Tu copies le code d'un côté et tu le colles
de l'autre. L'expédition en cours (la mine, le sac) n'est pas sauvegardée : recharger la page en démarre une nouvelle.

## Commandes

| Action | Tactile (paysage) | Clavier | Manette |
|---|---|---|---|
| Marcher, viser | joystick flottant (moitié gauche de l'écran) | ← → ↑ ↓ ou WASD | stick gauche / croix |
| Sauter | bouton **Saut** | Espace ou Z | A |
| Frapper / creuser | bouton **Frapper** (direction du joystick ; bas = sous tes pieds) | X ou J | X ou RT |
| Grappin | bouton **Grappin** | C ou K | B, RB ou LT |
| Forge, ouvrir un coffre | bouton contextuel qui apparaît | E | Y |
| Pause | bouton en haut à droite | Échap ou P | Start |
| Son | Pause / Réglages | M | — |

- **Grappin** : il part dans la direction du joystick (vers le haut, légèrement en avant, si le joystick est au
  repos) avec une petite aide à la visée. Une fois accroché : haut = enrouler, bas = dérouler, gauche/droite =
  se balancer, **Saut = lâcher avec élan**. **Appuyer de nouveau sur Grappin te hisse** : le héros saute et relance
  le crochet plus haut. Pour sortir d'un puits, enchaîne les appuis puis pousse vers le bord. Pendant un vrai
  balancier, le même appui lâche la corde.
- Le panneau **Commandes** (menu Pause ou Réglages) récapitule tout. Des **astuces** s'affichent une seule fois
  pendant les premières expéditions. Tu peux les couper ou les réactiver dans Réglages → Astuces.
- Menus : au doigt, ou au clavier avec les flèches, Entrée et Échap, ou à la manette avec la croix, A et B.

## Boucle de jeu

1. **Le camp.** Tu y trouves la Forge et le forgeron, à gauche, puis le chevalement au-dessus du puits de la mine.
   Le puits est fermé par une **trappe** : un coup de pioche vers le bas l'ouvre, et elle se referme quand tu reviens
   au camp. Le sol du camp ne se creuse pas.
2. **Descendre.** Tu creuses dans toutes les directions et tu ramasses les **minerais** dans ton **sac**, dont la
   capacité est limitée. Les ennemis lâchent des **pièces**. Plus tu descends, plus c'est riche, et dangereux.
3. **Remonter.** Le butin ne compte qu'une fois **à l'abri** : remets les pieds sur le sol du camp et il devient de
   l'**or banqué**. Au camp, tes PV remontent vite.
4. **La Forge.** L'or banqué achète des améliorations permanentes : Pioche (dégâts, et la dureté qui ouvre de
   nouvelles roches), Vitalité, Armure, Grappin (portée), Sac, Lanterne, Bottes et Bourse de secours (part du butin
   gardée à la mort).
5. **La mort.** Tu perds le sac, l'or non banqué et les reliques. La mine est régénérée et tu repars du camp avec tes
   améliorations. Tant que tu restes en vie, la mine et tes tunnels persistent.

| Couche | Profondeur | Minerais | Il faut… |
|---|---|---|---|
| Terre meuble | 0 à −39 m | charbon, cuivre | la pioche de départ |
| Catacombes | −40 à −99 m | fer, argent | la pioche niv. 1 pour les briques (le fer se mine déjà) |
| Grottes cristallines | −100 à −179 m | or, améthyste | la pioche niv. 2 (granit, cristal) |
| Abysse ardente | −180 à −259 m | rubis, mithril (et de la lave) | la pioche niv. 4 (basalte, obsidienne) |
| Le Cœur | −260 m | l'arène du Gardien | être bien équipé |

- **Coffres** : une **relique** (bonus valable jusqu'à la mort : double saut, aimant, vampirisme, pioche ardente,
  peau de pierre, plume, crochet éclair, lanterne spectrale, frénésie, avarice, cœur de troll) ou de l'or.
- **Le Gardien** combat en 3 phases. Une fois vaincu, tu peux continuer en **NG+** : nouvelle mine, ennemis plus forts,
  améliorations conservées.
- **Coincé ?** Si tu ne gagnes plus de hauteur pendant un long moment sous le camp, le menu Pause propose la **Corde de
  secours** : tu remontes au camp vivant, mais ton butin non banqué reste au fond. Ce n'est pas une mort : la mine et
  tes reliques sont conservées. « Recommencer l'expédition » compte, lui, comme une mort.

### Conseils

- Premier voyage : remplis ton sac de charbon et de cuivre dans les 20 premiers mètres, remonte, puis achète le
  **Sac** (10 or) ou la **Lanterne** (8 or).
- La **Pioche** est l'amélioration clé : chaque nouvelle dureté ouvre une couche plus riche.
- Remonte avant d'être à court de PV : un voyage sûr rapporte plus qu'une mort.
- Les tunnels restent tant que tu es en vie : les voyages suivants dans la même mine vont plus vite.
- Les coffres « or » valent à peu près une minute de minage. Ne régénère pas la mine juste pour les rouvrir.
- Compte environ 2 heures de jeu pour être prêt à affronter le Gardien.

## Lancer en local

Il faut **Node.js 20 ou plus récent**, sans rien installer d'autre.

```sh
cd gouffre
npm run serve          # http://localhost:8080/index.html
```

Le service worker est désactivé en local, pour que chaque modification soit visible tout de suite.
Paramètres d'URL utiles pour le développement : `?debug` (FPS, touches G = mode dieu, N / B = ±40 m), `?seed=123`,
`?depth=120`, `?bank=5000` (or banqué), `?gold=` (or de l'expédition), `?god`, `?mute`, `?autostart`,
`?canvasscale` (ancien mode d'affichage, voir « Limites connues »).

## Tests

```sh
npm test               # tests unitaires (node --test)
npm run test:e2e       # parcours complet dans Chromium, profil « iPhone 13 paysage » tactile
npm run economy        # modèle d'économie (progression simulée face aux coûts de la Forge)
```

Les tests de bout en bout utilisent **Playwright installé globalement**, résolu par `npm root -g`, avec son
Chromium. Ils ne téléchargent rien. Les captures d'écran vont dans `tests/e2e/screenshots/`, ignoré par git.

## Structure

```
gouffre/
├── index.html              page unique : canvas, calques tactiles et menus, styles
├── manifest.webmanifest    PWA (plein écran, paysage, icônes)
├── sw.js                   service worker : cache versionné, jeu hors ligne
├── icons/                  icônes 180 / 192 / 512 (générées par tools/make-icons.mjs)
├── DESIGN.md               contrat de conception (règles, architecture, amendements §14…)
├── NOTES-core.md           référence développeur (APIs, équilibrage, mesures, limites)
├── src/
│   ├── main.js             démarrage, boucle à pas fixe 60 Hz, états, banque / mort / victoire, trappe, corde de secours
│   ├── config.js           toutes les constantes d'équilibrage
│   ├── worldgen.js         génération de la mine (couches, grottes, catacombes, géodes, lave, arène, camp)
│   ├── world.js · tiles.js grille de tuiles, minage, types de blocs
│   ├── player.js · grapple.js · physics.js   héros, pioche, grappin, collisions
│   ├── enemies.js          7 ennemis, projectiles, le Gardien
│   ├── entities.js         minerais, pièces, cœurs, coffres
│   ├── meta.js             sauvegarde, Forge, reliques, banque, transfert
│   ├── tips.js             astuces des premières parties, détection « coincé »
│   ├── render.js · lighting.js · particles.js · sprites.js   rendu, lumière, effets, pixel art
│   ├── hud.js · ui.js      HUD (police bitmap) et menus
│   ├── input.js · audio.js tactile / clavier / manette, sons synthétisés
│   └── debug.js            paramètres ?debug et poignée de test window.__gouffre
├── tests/unit/             tests unitaires
├── tests/e2e/              test de bout en bout + petit serveur statique
└── tools/                  outils de développement (économie, carte, captures, planche de sprites, icônes)
```

## Limites connues

- **Jamais testé sur un vrai iPhone, ni dans WebKit.** Les tests et les mesures de performance tournent dans
  Chromium. L'affichage agrandit un petit canvas par CSS (`image-rendering: pixelated`). Si une image floue apparaît
  sur un appareil, `?canvasscale` rétablit l'ancien mode, plus coûteux. Les marges de l'encoche ne sont simulées
  que dans un seul test.
- **Audio entièrement synthétisé** (WebAudio) : pas de musique enregistrée, seulement des bruitages et une ambiance
  discrète. Sur iOS, le son se débloque au premier toucher, et le mode silencieux du téléphone peut le couper.
- Sauvegarde **locale uniquement** (voir « Sauvegarde ») : ni compte ni synchronisation, et l'expédition en cours
  n'est pas conservée au rechargement.
- L'équilibrage vient d'un modèle et d'un robot de test qui joue avec les vraies règles. De vrais joueurs
  progresseront à un rythme différent, surtout dans l'Abysse, où le robot meurt beaucoup.
- Manette : correspondance standard seulement. Sur les tout petits écrans (iPhone SE), certains libellés de la
  Forge sont abrégés.
- La corde ne s'enroule pas autour des coins. Un ennemi sorti de la zone active s'arrête là où il est.
