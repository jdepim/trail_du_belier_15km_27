// Presentation tuning (renderer, particles, HUD, map, audio). Simulation numbers live in config.js;
// this file only holds values that change how the game looks and sounds, never how it plays.
//
// Exports: LIGHT_DIR, BACKDROP, NEBULA_REGIONS, DARK, FX, PARTICLES, HUD_LAYOUT, RADAR, MAP_VIEW,
//          VICTORY_CINE, AUDIO_MIX

/** Default "distant sun" light direction for baked tile shading (unit vector, points toward the light). */
export const LIGHT_DIR = { x: -0.62, y: -0.78 };

export const BACKDROP = {
  tile: 512,                       // star layer tile size (px, repeated)
  layers: [                        // far -> near
    { parallax: 0.04, stars: 640, bright: 0.45 },
    { parallax: 0.12, stars: 260, bright: 0.7 },
    { parallax: 0.3, stars: 90, bright: 1 },
  ],
  twinklers: 40,                   // twinkling stars per mid / near tile
  nebulaTile: 256,                 // nebula texture size (drawn ×2)
  nebulaParallax: 0.07,
  nebulaBase: 0.55,                // alpha of the neutral nebula far from every region
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
  heatTint: 0.34,                  // max orange overlay alpha at heatLevel 1
  stormStatic: 0.5,                // max cyan static alpha at stormIntensity 1
  bhVignette: 0.72,                // max vignette alpha at bhProximity 1
  hurtVignette: 0.45,
  sunFrames: 8, sunFps: 6,
  diskFrames: 16, diskFps: 10,
  bhMotes: 44,
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
  // internal px kept clear for the DOM controls (touch): top-right buttons, bottom thumbs
  topRightW: 96, topRightH: 38,
  bottomRightW: 170, bottomRightH: 128,
  bottomLeftW: 130, bottomLeftH: 100,
};

export const RADAR = {
  inset: 13,                       // px from the screen edge to the arrow
  distStep: 5,                     // m: distance labels are rounded to this step
  maxDist: 2400,                   // m: longest precomputed label
  refresh: 0.4,                    // s between discovery checks
};

export const MAP_VIEW = {
  terrainPx: 320,                  // cached terrain canvas size (1 px = 4 tiles)
  margin: 10,
  blink: 3,                        // Hz of the player marker blink
};

export const VICTORY_CINE = {
  fade: 1.2,                       // s: frozen scene fades to black
  flight: 6.5,                     // s: flight home (starfield streaks, Earth grows)
  reentry: 3,                      // s: re-entry plasma
  total: 11.5,                     // s: then `renderer.victoryDone` becomes true
};

export const AUDIO_MIX = {
  master: 0.8,
  sfx: 0.9,
  music: 0.42,
  loops: { thrust: 0.2, brake: 0.13, heat: 0.22, rumble: 0.5, alarm: 0.07, storm: 0.16 },
  loopSmooth: 0.06,                // s time constant of loop level changes
};
