// Wild creatures (enemies, prey, tamable critters). Add an entry to CREATURES to add a new creature.
//
//   ai          behaviour key in creature.js: 'passive' (flees), 'neutral' (fights back),
//               'hostile' (hunts the player and allies), 'aquatic' (hostile, lives in water)
//   hp, size, speed, jump [tiles], attack, attackRate [s], reach [px], resist, aggro [tiles]
//   drops       resources left in the carcass when killed (resources.js ids)
//   tame        present if the creature can join the pack: { cost: {resource: n}, ally: {...stat overrides} }
//   spawn       { biomes: [...], weight, group: [min, max], minDanger, night } used by the spawner
//   look        procedural pixel-art parameters (sprites.js)

export const CREATURES = {
  compy: {
    id: 'compy', name: 'Compy',
    ai: 'passive', skittish: true,
    hp: 4, size: { w: 6, h: 6 }, speed: 70, jump: 2, attack: 0.8, attackRate: 0.5, reach: 5, resist: 0, aggro: 4,
    drops: { skin: 0, bone: 1, meat: 1 },
    tame: {
      cost: { meat: 1 },
      ally: { hp: 12, attack: 1.8, speed: 95, jump: 3, resist: 0.1 },
    },
    spawn: { biomes: ['plaine', 'foret', 'marais'], weight: 3, group: [2, 4], minDanger: 0 },
    look: {
      plan: 'biped', w: 12, h: 9,
      body: { x: 4, y: 3, w: 4, h: 3 },
      head: { w: 3, h: 2, dy: -2 }, neck: 1,
      tail: { len: 4, thick: 1, rise: -1 },
      legs: { len: 2, thick: 1 },
      features: ['stripes'],
      colors: { base: '#7fb44a', belly: '#dfe8a0', dark: '#1f3310', accent: '#3d6e22' },
    },
  },

  dryo: {
    id: 'dryo', name: 'Dryosaure',
    ai: 'passive', skittish: true,
    hp: 9, size: { w: 9, h: 10 }, speed: 80, jump: 2.5, attack: 0, attackRate: 1, reach: 0, resist: 0, aggro: 6,
    drops: { skin: 1, bone: 1, meat: 2 },
    spawn: { biomes: ['plaine', 'foret'], weight: 3, group: [1, 3], minDanger: 0 },
    look: {
      plan: 'biped', w: 16, h: 14,
      body: { x: 5, y: 5, w: 6, h: 4 },
      head: { w: 4, h: 3, dy: -4 }, neck: 1,
      tail: { len: 6, thick: 2, rise: -1 },
      legs: { len: 4, thick: 1 },
      features: ['spots'],
      colors: { base: '#c4a672', belly: '#efe0bb', dark: '#3e2d17', accent: '#8a6a3a' },
    },
  },

  stego: {
    id: 'stego', name: 'Stégosaure',
    ai: 'neutral',
    hp: 34, size: { w: 22, h: 13 }, speed: 34, jump: 1, attack: 4, attackRate: 1.2, reach: 10, resist: 0.3, aggro: 7,
    drops: { skin: 3, bone: 3, meat: 4 },
    spawn: { biomes: ['plaine', 'foret', 'montagne'], weight: 1.4, group: [1, 2], minDanger: 0.15 },
    look: {
      plan: 'quad', w: 34, h: 20,
      body: { x: 9, y: 5, w: 17, h: 9 },
      head: { w: 5, h: 4, dy: 4 }, neck: 2,
      tail: { len: 9, thick: 4, rise: -1 },
      legs: { len: 5, thick: 3 },
      features: ['plates', 'tailspikes'],
      colors: { base: '#5d7b8a', belly: '#b7c4b0', dark: '#1a262c', accent: '#c9583a' },
    },
  },

  raptor: {
    id: 'raptor', name: 'Raptor',
    ai: 'hostile',
    hp: 9, size: { w: 11, h: 10 }, speed: 92, jump: 3.2, attack: 2.5, attackRate: 0.8, reach: 7, resist: 0, aggro: 12,
    drops: { skin: 1, bone: 1, meat: 1 },
    spawn: { biomes: ['plaine', 'foret', 'marais', 'canyon'], weight: 2.2, group: [2, 3], minDanger: 0.1, night: 1.8 },
    look: {
      plan: 'biped', w: 20, h: 14,
      body: { x: 6, y: 5, w: 7, h: 4 },
      head: { w: 5, h: 3, dy: -3 }, neck: 1,
      tail: { len: 7, thick: 2, rise: -2 },
      legs: { len: 4, thick: 1 },
      features: ['crest', 'stripes', 'claws'],
      colors: { base: '#7a5a8e', belly: '#d8c4d8', dark: '#211528', accent: '#e05050' },
    },
  },

  carno: {
    id: 'carno', name: 'Carnotaure',
    ai: 'hostile',
    hp: 40, size: { w: 18, h: 18 }, speed: 64, jump: 2.6, attack: 6, attackRate: 1.1, reach: 12, resist: 0.3, aggro: 14,
    drops: { skin: 3, bone: 4, meat: 3 },
    spawn: { biomes: ['montagne', 'canyon', 'foret'], weight: 1, group: [1, 1], minDanger: 0.45, night: 1.5 },
    look: {
      plan: 'biped', w: 30, h: 24,
      body: { x: 9, y: 7, w: 12, h: 8 },
      head: { w: 8, h: 6, dy: -5 }, neck: 2,
      tail: { len: 9, thick: 4, rise: -1 },
      legs: { len: 7, thick: 3 },
      features: ['horns-small', 'spots'],
      colors: { base: '#a8402e', belly: '#e0b890', dark: '#2e0c08', accent: '#f0d060', horn: '#f2ead0' },
    },
  },

  plesio: {
    id: 'plesio', name: 'Plésiosaure',
    ai: 'aquatic',
    hp: 16, size: { w: 18, h: 8 }, speed: 50, jump: 0, attack: 3, attackRate: 1, reach: 9, resist: 0.1, aggro: 10,
    drops: { skin: 2, bone: 2, meat: 2 },
    spawn: { biomes: ['marais', 'plaine'], weight: 1, group: [1, 1], minDanger: 0.05, water: true },
    look: {
      plan: 'swimmer', w: 30, h: 12,
      body: { x: 7, y: 4, w: 12, h: 6 },
      head: { w: 4, h: 3, dy: -3 }, neck: 5,
      tail: { len: 6, thick: 2, rise: 0 },
      legs: { len: 3, thick: 2 },
      features: ['spots'],
      colors: { base: '#3e6f86', belly: '#a8d0d8', dark: '#0e2530', accent: '#2a4e60' },
    },
  },
};

/** Stats of a tamed creature: base creature stats with its `tame.ally` overrides. */
export function allyStats(def) {
  return { ...def, ...(def.tame ? def.tame.ally : {}) };
}
