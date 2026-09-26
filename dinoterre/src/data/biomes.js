// Biomes of the open world. Worldgen lays them out left/right of the starting plain.
//   offset     ground raised (+) or lowered (−) relative to SURFACE_BASE [tiles]
//   amp        noise amplitude [tiles]; freq: noise frequency
//   terrace    if set, heights snap to steps of this many tiles → cliffs to climb or jump
//   top/fill   tile keys used for the surface and the ground below it
//   trees      chance per column of a tree; treeH: [min, max] trunk height
//   bones      chance per column of a bone pile (harvestable fossil)
//   density    creatures per spawn zone
//   sky        background tint used by the renderer

export const BIOMES = {
  plaine: {
    id: 'plaine', name: 'Plaine',
    offset: 0, amp: 3, freq: 0.035,
    top: 'grass', fill: 'dirt',
    trees: 0.025, treeH: [5, 8], bones: 0.006,
    density: 3,
    sky: '#8cc8e8', hills: '#6fa06a',
  },
  foret: {
    id: 'foret', name: 'Forêt de fougères',
    offset: 1, amp: 5, freq: 0.04,
    top: 'grass', fill: 'dirt',
    trees: 0.12, treeH: [8, 16], bones: 0.004,
    density: 3.5,
    sky: '#7ab8c8', hills: '#3f7a50',
  },
  marais: {
    id: 'marais', name: 'Lac et marais',
    offset: -9, amp: 4, freq: 0.05,
    top: 'mud', fill: 'dirt',
    trees: 0.04, treeH: [4, 7], bones: 0.01,
    density: 2.5,
    sky: '#9ab8b0', hills: '#5a8070',
  },
  montagne: {
    id: 'montagne', name: 'Montagnes',
    offset: 18, amp: 14, freq: 0.03, terrace: 7,
    top: 'stone', fill: 'stone',
    trees: 0.01, treeH: [4, 6], bones: 0.012,
    density: 2,
    sky: '#a8c0d8', hills: '#7a8498',
  },
  canyon: {
    id: 'canyon', name: 'Canyon rouge',
    offset: 6, amp: 12, freq: 0.05, terrace: 5,
    top: 'sand', fill: 'redrock',
    trees: 0, treeH: [0, 0], bones: 0.02,
    density: 3,
    sky: '#e8b890', hills: '#b0664a',
  },
};

/** Biome sequence heading away from the spawn: index 0 is next to the plain, later ones are farther and harder. */
export const BIOME_RING = ['plaine', 'foret', 'marais', 'foret', 'montagne', 'plaine', 'canyon', 'marais', 'montagne', 'canyon'];
