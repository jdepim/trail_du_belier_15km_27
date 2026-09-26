// Playable dinosaur types. Each entry is self-contained: add a new object to SPECIES to add a playable dino.
//
// Stats (units in brackets):
//   hp            max health
//   size          hitbox {w, h} [px]
//   walkSpeed     [px/s]
//   jumpHeight    peak height of a full jump [tiles]; the physics derives the take-off speed from it
//   climbSpeed    [px/s] up or down a wall
//   climbDrain    stamina lost per second while climbing (stamina max 100)
//   swimSpeed     [px/s]
//   buoyancy      0 = sinks like a stone, 1 = floats; controls idle sinking speed
//   breath        seconds underwater before drowning
//   attack        damage per bite
//   attackRate    seconds between bites
//   attackReach   bite hitbox length in front of the body [px]
//   resist        share of incoming damage absorbed (0..0.9)
//   knockback     push applied to bitten enemies [px/s]
//   metabolism    hunger drain multiplier
//   look          parameters for the procedural pixel-art generator (sprites.js)
// `ratings` are only shown on the selection screen (1..5).

export const SPECIES = {
  costaud: {
    id: 'costaud',
    name: 'Tricéros',
    title: 'le costaud',
    blurb: 'Énorme et puissant. Saute très haut, mais grimpe lentement et s\'épuise vite sur les parois.',
    hp: 26,
    size: { w: 20, h: 14 },
    walkSpeed: 62,
    jumpHeight: 6.2,
    climbSpeed: 13,
    climbDrain: 34,
    swimSpeed: 38,
    buoyancy: 0.25,
    breath: 12,
    attack: 4,
    attackRate: 0.55,
    attackReach: 12,
    resist: 0.25,
    knockback: 220,
    metabolism: 1.3,
    ratings: { saut: 5, escalade: 1, nage: 2, vitesse: 3, combat: 3, defense: 3 },
    look: {
      plan: 'quad', w: 32, h: 19,
      body: { x: 8, y: 4, w: 17, h: 10 },
      head: { w: 8, h: 7, dy: 0 }, neck: 2,
      tail: { len: 8, thick: 4, rise: 0 },
      legs: { len: 5, thick: 3 },
      features: ['frill', 'horns'],
      colors: { base: '#6f8f4a', belly: '#b9c07a', dark: '#243018', accent: '#c96c3a', horn: '#f2ead0' },
    },
  },

  agile: {
    id: 'agile',
    name: 'Vif',
    title: 'le petit agile',
    blurb: 'Minuscule et léger. Saute peu haut, mais grimpe partout très vite et nage avec aisance.',
    hp: 12,
    size: { w: 8, h: 8 },
    walkSpeed: 88,
    jumpHeight: 2.3,
    climbSpeed: 72,
    climbDrain: 7,
    swimSpeed: 58,
    buoyancy: 0.7,
    breath: 9,
    attack: 1.6,
    attackRate: 0.28,
    attackReach: 7,
    resist: 0.05,
    knockback: 90,
    metabolism: 0.7,
    ratings: { saut: 1, escalade: 5, nage: 4, vitesse: 5, combat: 1, defense: 1 },
    look: {
      plan: 'biped', w: 16, h: 12,
      body: { x: 5, y: 4, w: 6, h: 4 },
      head: { w: 4, h: 3, dy: -3 }, neck: 1,
      tail: { len: 5, thick: 2, rise: -1 },
      legs: { len: 3, thick: 1 },
      features: ['crest', 'stripes'],
      colors: { base: '#d9a63a', belly: '#f3dc92', dark: '#3a2410', accent: '#3fa0c8' },
    },
  },

  robuste: {
    id: 'robuste',
    name: 'Allo',
    title: 'le robuste',
    blurb: 'Taillé pour le combat : morsure féroce et cuir épais. Moyen pour sauter, grimper et nager.',
    hp: 32,
    size: { w: 14, h: 13 },
    walkSpeed: 72,
    jumpHeight: 3.6,
    climbSpeed: 34,
    climbDrain: 22,
    swimSpeed: 46,
    buoyancy: 0.45,
    breath: 10,
    attack: 6.5,
    attackRate: 0.42,
    attackReach: 11,
    resist: 0.45,
    knockback: 200,
    metabolism: 1,
    ratings: { saut: 3, escalade: 3, nage: 3, vitesse: 3, combat: 5, defense: 5 },
    look: {
      plan: 'biped', w: 26, h: 18,
      body: { x: 8, y: 5, w: 10, h: 7 },
      head: { w: 8, h: 6, dy: -4 }, neck: 2,
      tail: { len: 8, thick: 3, rise: -1 },
      legs: { len: 5, thick: 2 },
      features: ['brow', 'spots'],
      colors: { base: '#8a4b3a', belly: '#d8b08a', dark: '#2a130e', accent: '#e0c040' },
    },
  },
};

export const SPECIES_ORDER = ['costaud', 'agile', 'robuste'];

/** Initial vertical speed [px/s] needed to reach `jumpHeight` tiles under `gravity`. */
export function jumpVelocity(species, gravity, tile) {
  return Math.sqrt(2 * gravity * species.jumpHeight * tile);
}
