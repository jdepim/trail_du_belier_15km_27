// Presentation tuning (renderer, particles, HUD, map, audio). Simulation numbers live in config.js;
// this file only holds values that change how the game looks and sounds, never how it plays.
//
// Exports: LIGHT_DIR, BACKDROP, NEBULA_REGIONS, DARK, FX, PARTICLES, HUD_LAYOUT, RADAR, MAP_VIEW,
//          AUDIO_MIX

/** Default "distant sun" light direction for baked tile shading (unit vector, points toward the light). */
export const LIGHT_DIR = { x: -0.62, y: -0.78 };

export const BACKDROP = {
  layers: [                        // far -> near; incommensurate tile sizes hide the repetition
    { parallax: 0.04, tile: 512, stars: 640, bright: 0.45, twinklers: 0 },
    { parallax: 0.12, tile: 640, stars: 400, bright: 0.7, twinklers: 60 },
    { parallax: 0.3, tile: 896, stars: 270, bright: 1, twinklers: 120 },
  ],
  nebulaTile: 256,                 // nebula texture size (drawn ×2)
  nebulaParallax: 0.07,
  nebulaAlpha: 150,                // alpha of the densest nebula pixels (0..255)
  nebulaBase: 0.9,                 // alpha of the neutral nebula far from every region
  titleDrift: 14,                  // px/s camera drift on the title screen
};

/**
 * Regional nebula tint (DESIGN §9). Weight = 1 inside r0 of the region centre, fading to 0 at r1.
 * key = nebula colour built by sprites.js. 'storm' is a ring: distance measured from the sector centre.
 */
export const NEBULA_REGIONS = [
  { key: 'blue', poi: 'selene', r0: 500, r1: 1700 },
  { key: 'orange', poi: 'twins', r0: 700, r1: 1900 },
  { key: 'violet', poi: 'maelstrom', r0: 700, r1: 2000 },
  { key: 'green', ring: true, r0: 4700, r1: 3900 },
];

export const DARK = {
  base: 0.82,                      // darkness alpha of an unlit interior cell
  zoneBase: { tycho: 0.62 },       // per-zone override (the gallery floor is dark rock already)
  lampRange: 15,                   // headlamp reach (tiles)
  lampHalfAngle: 0.62,             // rad, full-strength cone half angle
  lampSoft: 0.45,                  // rad of soft cone edge
  haloRange: 4.5,                  // omni halo around the astronaut (tiles)
  tileFalloff: 0.11,               // light lost per tile step for tile lights
  glow: 0.42,                      // additive colour strength of lights
  lampTint: 0.2,                   // additive warm tint of the headlamp
  margin: 8,                       // tiles around the view scanned for light sources
};

export const FX = {
  heatTint: 0.12,                  // max flat orange overlay alpha at heatLevel 1
  heatEdge: 0.55,                  // max alpha of the orange edge glow at heatLevel 1
  stormStatic: 0.4,                // max cyan static alpha at stormIntensity 1
  bhVignette: 0.72,                // max vignette alpha at bhProximity 1
  sunFrames: 8, sunFps: 6,
  diskFrames: 16, diskFps: 10,
  bhMotes: 44,                     // bright motes inside the accretion disk area
  bhDust: 700, bhDustR: 900,       // faint dust over the pull radius (scaled by diskR / 130)
  flareRingWidth: 4,
  heatRingAlpha: 0.16,             // dashed ring drawn at heatR
  chargeRingFuse: 1.6,             // s of fuse left when the blast radius ring appears
  interactPulse: 5,                // Hz of the interactable brackets pulse
};

export const PARTICLES = {
  max: 1400,
  drag: 0.9,                       // 1/s velocity damping of floating particles (space: gentle)
};

export const HUD_LAYOUT = {
  margin: 6,
  barW: 54, barH: 5, barGap: 9,
  toastLife: 2.6,
  bannerLife: 4,
  zoneLife: 3,
  tipLife: 7,
  warnBlink: 2.6,                  // Hz
  // CSS px kept clear of radar arrows for the DOM touch controls (input.js layout(): Carte / Pause top-right;
  // Boost, Frein, Charge and the Action pill bottom-right; the stick's resting place bottom-left),
  // converted with game.view.cssToInternal
  topRightCss: { w: 104, h: 58 },
  bottomRightCss: { w: 232, h: 200 },
  bottomLeftCss: { w: 170, h: 150 },
  topGapHalf: 66,                  // half width of the top-centre message column kept free of radar arrows
  hurtFlash: 0.55,                 // red edge alpha right after a hit
  lowHull: 0.25,                   // hull fraction under which the red edge pulses
};

export const RADAR = {
  inset: 13,                       // px from the screen edge to the arrow
  distStep: 5,                     // m: distance labels are rounded to this step
  maxDist: 2400,                   // m: longest precomputed label
  refresh: 0.4,                    // s between discovery checks
  maxArrows: 6,                    // nearest places shown at once (the Albatros always among them)
  slotW: 32, slotH: 22,            // px an arrow + its label occupy along a horizontal / vertical edge
};

export const MAP_VIEW = {
  terrainPx: 320,                  // cached terrain canvas size (1 px = 4 tiles)
  margin: 10,
  pulse: 1.5,                      // Hz of the ring pulsing around the player marker
};

export const AUDIO_MIX = {
  master: 0.8,
  sfx: 0.9,
  music: 0.42,
  loops: { thrust: 0.2, brake: 0.13, heat: 0.22, rumble: 0.5, alarm: 0.07, storm: 0.16 },
  loopSmooth: 0.06,                // s time constant of loop level changes
};
