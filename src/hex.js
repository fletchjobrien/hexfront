// Odd-r offset hex coordinates (pointy-top rows; odd rows shifted half a hex right).
// The client uses the identical maths so both sides agree on distance and paths.

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

export function toOffset(x, z) {
  return [x + (z - (z & 1)) / 2, z];
}

export function distance(ax, ay, bx, by) {
  const a = toCube(ax, ay);
  const b = toCube(bx, by);
  return (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / 2;
}

export function key(cx, cy) {
  return cx + ',' + cy;
}

function cubeRound(x, y, z) {
  let rx = Math.round(x), ry = Math.round(y), rz = Math.round(z);
  const dx = Math.abs(rx - x), dy = Math.abs(ry - y), dz = Math.abs(rz - z);
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (dy > dz) ry = -rx - rz;
  else rz = -rx - ry;
  return [rx, ry, rz];
}

// The hexes a unit walks through, from origin to target inclusive. The tiny
// offsets break ties consistently so the server and the client always pick the
// same route when a line runs exactly along a hex edge.
export function line(ax, ay, bx, by) {
  const steps = distance(ax, ay, bx, by);
  const a = toCube(ax, ay);
  const b = toCube(bx, by);
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = steps === 0 ? 0 : i / steps;
    const [rx, , rz] = cubeRound(
      a[0] + (b[0] - a[0]) * t + 1e-6,
      a[1] + (b[1] - a[1]) * t + 2e-6,
      a[2] + (b[2] - a[2]) * t - 3e-6,
    );
    out.push(toOffset(rx, rz));
  }
  return out;
}

const CUBE_DIRS = [[1, -1, 0], [1, 0, -1], [0, 1, -1], [-1, 1, 0], [-1, 0, 1], [0, -1, 1]];

export function neighbors(cx, cy) {
  const [x, , z] = toCube(cx, cy);
  return CUBE_DIRS.map((d) => toOffset(x + d[0], z + d[2]));
}

// The hexes an army walks through, origin excluded.
//
// A straight hex line between two on-map hexes can bulge past the edge of a
// rectangular map, so this is a breadth-first search that stays on the board and
// prefers the straight route where it is legal. Neighbours are always visited in
// the same order, so the client and the server derive the same route. When
// terrain arrives, this is the one function that has to learn about it.
export function walkPath(ax, ay, bx, by) {
  if (ax === bx && ay === by) return [];
  if (!inBounds(ax, ay) || !inBounds(bx, by)) return [];

  const straight = line(ax, ay, bx, by).slice(1);
  if (straight.every(([cx, cy]) => inBounds(cx, cy))) return straight;

  const from = new Map([[key(ax, ay), null]]);
  let frontier = [[ax, ay]];
  while (frontier.length) {
    const next = [];
    for (const [cx, cy] of frontier) {
      for (const [nx, ny] of neighbors(cx, cy)) {
        if (!inBounds(nx, ny) || from.has(key(nx, ny))) continue;
        from.set(key(nx, ny), [cx, cy]);
        if (nx === bx && ny === by) {
          const steps = [];
          for (let at = [bx, by]; at; at = from.get(key(at[0], at[1]))) steps.push(at);
          return steps.reverse().slice(1);
        }
        next.push([nx, ny]);
      }
    }
    frontier = next;
  }
  return [];
}
