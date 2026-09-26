# Dino-Terre

Jeu de survie préhistorique en pixel art, vu de côté, dans un **monde ouvert d'un seul tenant** (1 400 × 110 cases, sans
niveaux). Tu incarnes un dinosaure : tu chasses, tu dépèces, tu te nourris, tu construis ton camp et tu apprivoises
une meute. Pensé pour **iPhone en paysage** (Safari), jouable aussi au clavier.

HTML, CSS et JavaScript (modules ES) uniquement : aucune dépendance, aucun CDN, aucune compilation. Tous les
graphismes sont générés par le code (pixel art procédural) et les sons sont synthétisés.

## Jouer

- **En local** : `node tests/e2e/server.mjs 8080` puis ouvrir `http://localhost:8080/index.html`.
  (Ouvrir le fichier directement en `file://` ne marche pas : les modules ES exigent un serveur.)
- **Sur iPhone** : héberger le dossier `dinoterre/` sur n'importe quel hébergement statique (GitHub Pages :
  *Settings → Pages → Deploy from a branch*, puis `https://<utilisateur>.github.io/<dépôt>/dinoterre/`).
  Dans Safari, *Partager → Sur l'écran d'accueil* lance le jeu en plein écran.
- La partie est sauvegardée automatiquement (toutes les 20 s, en quittant l'app, en se reposant sous la tente) dans le
  `localStorage` du navigateur. « Continuer » la reprend sur l'écran titre.

## Les trois dinosaures

| | Tricéros (costaud) | Vif (petit agile) | Allo (robuste) |
|---|---|---|---|
| Saut | **6,2 cases** | 2,3 cases | 3,6 cases |
| Escalade | 13 px/s, s'épuise en ~3 s | **72 px/s**, ~14 s | 34 px/s, ~4,5 s |
| Nage | 38 px/s, coule | **58 px/s**, flotte | 46 px/s |
| Morsure / cadence | 4 / 0,55 s | 1,6 / 0,28 s | **6,5 / 0,42 s** |
| Résistance | 25 % | 5 % | **45 %** |
| Vie | 26 | 12 | **32** |
| Faim | ×1,3 | ×0,7 | ×1 |

Conséquences en jeu : seul le costaud franchit une falaise de 6 cases d'un bond, le petit escalade des parois de plus de
100 cases et passe dans les trous d'une case, le robuste tue un raptor en deux morsures.

## Commandes tactiles

| Action | Contrôle |
|---|---|
| Marcher, viser un mur, se diriger dans l'eau | joystick flottant (moitié gauche de l'écran) |
| Sauter (appui long = plus haut) · bas + Sauter : traverser une plateforme | **Sauter** |
| Grimper (garder appuyé contre une paroi ou un tronc), joystick bas pour descendre, Sauter pour un bond mural | **Grimper** |
| Remonter dans l'eau (garder appuyé) | **Nager** |
| Mordre | **Mordre** |
| Dépecer, ramasser des os, apprivoiser, griller, se reposer, manger | **Interagir** (son libellé change selon le contexte) |
| Manger · Construire · rôle de la meute · pause | boutons du haut |

Clavier : flèches/ZQSD, Espace (sauter), Maj (grimper), N (nager), J (mordre), E (interagir).

## Boucle de jeu

1. **Chasser** : chaque créature tuée laisse une carcasse. *Interagir* la dépèce : peau, os et viande.
   Les gisements d'os fossiles donnent aussi des os (ils repoussent).
2. **Se nourrir** : la faim baisse en continu ; à zéro, tu perds de la vie. La viande crue rend 20 de faim, la viande
   grillée au feu de camp 42 (et soigne davantage).
3. **Construire** (menu *Construire*, un fantôme vert/rouge montre l'emplacement, *Poser* le valide) :
   tente (repos, soins, sauvegarde, réapparition, les prédateurs l'évitent), feu de camp (grille la viande, éclaire la
   nuit), nid (+2 places dans la meute), palissade d'os, plateforme.
4. **Apprivoiser** : approche un Compy avec de la viande crue et *Interagir*. Tes alliés te suivent ; le bouton *Meute*
   alterne entre **Chasse** (ils attaquent les ennemis proches) et **Récolte** (ils dépècent les carcasses et ramassent
   les os, puis te rapportent le butin).
5. **Explorer** : plus tu t'éloignes du départ, plus c'est dangereux (raptors, carnotaures, plésiosaures dans les lacs).
   La nuit, les prédateurs sont plus nombreux et voient plus loin. Mourir fait perdre la moitié des ressources portées.

## Architecture

```
src/
  data/            ← tout le contenu, sans logique
    species.js       dinosaures jouables (statistiques + apparence)
    creatures.js     créatures sauvages (IA, stats, butin, apprivoisement, apparition)
    resources.js     ressources (icône 8×8, valeur nutritive)
    buildings.js     bâtiments (coût, forme, effets)
    biomes.js        biomes (relief, végétation, densité de créatures)
  config.js        constantes globales (physique, survie, jour/nuit…)
  worldgen.js      génération déterministe du monde (seed)
  world.js tiles.js grille de tuiles et requêtes
  physics.js       collisions AABB, montée de marche, plateformes, eau, parois
  player.js        contrôleur du joueur (sol/air, escalade, nage, morsure, survie)
  creature.js      IA des créatures et des alliés
  pack.js          meute : apprivoisement, rôles, butin
  building.js      mode construction (fantôme, validation, pose)
  entities.js      carcasses, gisements d'os, bâtiments posés (+ actions d'interaction)
  spawner.js       apparition/disparition des créatures autour du joueur
  combat.js inventory.js save.js
  game.js          état et pas de simulation (sans DOM : testable dans Node)
  sprites.js       pixel art procédural (dinos, tuiles, bâtiments, icônes)
  render.js camera.js particles.js font.js   rendu canvas basse résolution agrandi sans lissage
  input.js hud.js audio.js main.js           joystick/boutons, interface DOM, sons, boucle
```

### Ajouter du contenu

- **Un dinosaure jouable** : ajouter une entrée dans `SPECIES` (et son id dans `SPECIES_ORDER`). L'apparence est décrite
  par `look` (plan `quad`/`biped`/`swimmer`, tailles, couleurs, `features` : `frill`, `horns`, `plates`, `crest`,
  `stripes`, `spots`, `claws`, `brow`…) ; toutes les poses sont générées automatiquement.
- **Une créature** : entrée dans `CREATURES` avec `ai` (`passive`, `neutral`, `hostile`, `aquatic`), `drops`, `spawn`
  (biomes, poids, danger minimal, bonus de nuit) et éventuellement `tame` pour la rendre apprivoisable.
- **Une ressource** : entrée dans `RESOURCES` (icône 8×8 en caractères) ; `food` la rend comestible.
- **Un bâtiment** : entrée dans `BUILDINGS`, soit `kind: 'tiles'` (motif de tuiles), soit `kind: 'structure'` avec
  des effets déclaratifs (`respawn`, `safeRadius`, `light`, `packBonus`, `heal`, `interact`). Une nouvelle action
  d'interaction s'ajoute dans `STRUCTURE_ACTIONS` (`entities.js`), un sprite dans `bakeProps()` (`sprites.js`).
- **Un biome** : entrée dans `BIOMES` et place dans `BIOME_RING`.

## Tests

```
npm test          # 34 tests unitaires (node:test) : stats des espèces, hauteurs de saut mesurées, escalade,
                  # nage/souffle, chasse → carcasse → récolte, faim, construction, feu, apprivoisement,
                  # alliés chasseurs et récolteurs, monde, sauvegarde
npm run test:e2e  # Chromium en émulation iPhone 13 paysage, vrais événements tactiles, captures dans
                  # tests/e2e/screenshots/ (Playwright global requis)
```

## Limites connues

- Pas encore testé sur un iPhone physique : l'émulation Chromium valide les événements tactiles et la mise en page,
  pas le comportement exact de Safari iOS (audio, barres système).
- Les sprites sont procéduraux (prototype) : ils se remplacent par des images en modifiant `bakeDino` / `bakeProps`.
- Pas de mode hors ligne (service worker) pour l'instant.
