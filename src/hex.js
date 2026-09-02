// Odd-r offset hex coordinates (pointy-top rows; odd rows shifted half a hex right).
// The client uses the identical maths so both sides agree on distance.

export const MAP_W = 24;
export const MAP_H = 24;

export function inBounds(cx, cy) {
  return Number.isInteger(cx) && Number.isInteger(cy) &&
         cx >= 0 && cx < MAP_W && cy >= 0 && cy < MAP_H;
}

export function toCube(cx, cy) {
  const x = cx - (cy - (cy & 1)) / 2;
  const z = cy;
  return [x, -x - z, z];
}

export function distance(ax, ay, bx, by) {
  const a = toCube(ax, ay);
  const b = toCube(bx, by);
  return (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / 2;
}

export function key(cx, cy) {
  return cx + ',' + cy;
}
