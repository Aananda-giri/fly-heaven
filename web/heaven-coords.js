// Mirrors heaven/world.py's constants (CLEARING, FRUIT_POS, SUNBEAM_POS):
// the server's fly/female positions arrive in that same (x, y) meter frame,
// origin at one corner. We map it onto our scene's XZ ground plane, centered
// at the origin, so it lines up with the forest built in forest.js.
export const CLEARING_W = 1.2;
export const CLEARING_H = 0.8;
export const FRUIT_POS = [0.42, 0.51];
export const SUNBEAM_POS = [0.30, 0.55];
export const SUNBEAM_RADIUS = 0.18;

export function heavenToScene(x, y) {
  return [x - CLEARING_W / 2, y - CLEARING_H / 2];
}
