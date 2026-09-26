// Resources the player can carry. Add an entry to add a resource; `food` makes it edible.
//   icon   8×8 pixel map; each character indexes `palette` ('.' = transparent)

export const RESOURCES = {
  skin: {
    id: 'skin', name: 'Peau', plural: 'Peaux',
    palette: { a: '#8a5a32', b: '#c08a52', c: '#e0b27a', d: '#3a220e' },
    icon: [
      '.dd..dd.',
      'dbbddbbd',
      'dbcbbcbd',
      '.dbbbbd.',
      '.dbcbbd.',
      'dbbbbcbd',
      'dbbddbbd',
      '.dd..dd.',
    ],
  },
  bone: {
    id: 'bone', name: 'Os', plural: 'Os',
    palette: { a: '#f2ead0', b: '#c8bc98', d: '#4a4030' },
    icon: [
      '.dd.....',
      'daad....',
      'dabad...',
      '.dbaad..',
      '..daabd.',
      '...daabd',
      '....dbad',
      '.....dd.',
    ],
  },
  meat: {
    id: 'meat', name: 'Viande crue', plural: 'Viandes crues',
    food: { hunger: 20, heal: 1 },
    palette: { a: '#c8384a', b: '#f07080', c: '#f2ead0', d: '#3a0c14' },
    icon: [
      '..dddd..',
      '.dabbad.',
      'dabaaaad',
      'daaabaad',
      'daaaaad.',
      '.dddcd..',
      '....dcd.',
      '.....dd.',
    ],
  },
  cooked: {
    id: 'cooked', name: 'Viande grillée', plural: 'Viandes grillées',
    food: { hunger: 42, heal: 5 },
    palette: { a: '#8a4a22', b: '#c07a3a', c: '#f2ead0', d: '#2a1408' },
    icon: [
      '..dddd..',
      '.dabbad.',
      'dabaaaad',
      'daaabaad',
      'daaaaad.',
      '.dddcd..',
      '....dcd.',
      '.....dd.',
    ],
  },
};

export const RESOURCE_ORDER = ['skin', 'bone', 'meat', 'cooked'];
/** Food eaten first when the player taps "Manger": the best first. */
export const FOOD_ORDER = ['cooked', 'meat'];
