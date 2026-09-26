// Buildable elements. Add an entry to add a building.
//
// kind 'tiles'      writes solid/platform tiles into the world (pattern rows top → bottom, ' ' = untouched)
// kind 'structure'  a placed object of w×h tiles with effects:
//     respawn     the player respawns here after death (last one rested in)
//     safeRadius  hostile creatures will not hunt inside this radius [tiles]
//     light       light radius at night [px]
//     packBonus   extra pack capacity
//     heal        hp per second restored to the player and allies standing close
//     interact    action key handled in building.js ('rest', 'cook')
// needsGround: every column must stand on solid ground.

export const BUILDINGS = {
  palissade: {
    id: 'palissade', name: 'Palissade d\'os',
    desc: 'Mur de 3 cases. Bloque les prédateurs, s\'escalade.',
    kind: 'tiles', cost: { bone: 3 },
    pattern: ['W', 'W', 'W'], tiles: { W: 'bonewall' },
    needsGround: true,
  },
  plateforme: {
    id: 'plateforme', name: 'Plateforme en peau',
    desc: 'Passerelle de 3 cases. On la traverse par dessous.',
    kind: 'tiles', cost: { skin: 1, bone: 1 },
    pattern: ['PPP'], tiles: { P: 'hideplat' },
    needsGround: false,
  },
  tente: {
    id: 'tente', name: 'Tente en peau',
    desc: 'Abri : repos, soins, sauvegarde et point de réapparition. Les prédateurs l\'évitent.',
    kind: 'structure', w: 4, h: 3, cost: { skin: 5, bone: 4 },
    respawn: true, safeRadius: 8, heal: 0.6, interact: 'rest',
    needsGround: true,
  },
  feu: {
    id: 'feu', name: 'Feu de camp',
    desc: 'Grille la viande crue (bien plus nourrissante). Éclaire la nuit.',
    kind: 'structure', w: 2, h: 2, cost: { bone: 2, skin: 1 },
    light: 56, interact: 'cook',
    needsGround: true,
  },
  nid: {
    id: 'nid', name: 'Nid de meute',
    desc: '+2 places dans la meute. Soigne les alliés à proximité.',
    kind: 'structure', w: 3, h: 1, cost: { skin: 3, bone: 5 },
    packBonus: 2, heal: 0.5,
    needsGround: true,
  },
};

export const BUILDING_ORDER = ['tente', 'feu', 'nid', 'palissade', 'plateforme'];
