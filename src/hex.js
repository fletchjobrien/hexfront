// Odd-r offset hex coordinates (pointy-top rows; odd rows shifted half a hex right)
// plus terrain-aware routing. The client mirrors all of this so both sides agree
// on what a legal move is and which hexes an army walks through.

export const MAP_W = 24;
export const MAP_H = 24;

// Movement cost to ENTER a hex. null means impassable.
export const TERRAIN = {
  f: { name: 'Flat',      cost: 1 },
  h: { name: 'Hills',     cost: 2 },
  w: { name: 'Water',     cost: null },
  m: { name: 'Mountains', cost: null },
};
export const DEFAULT_TERRAIN = 'f';

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

const CUBE_DIRS = [[1, -1, 0], [1, 0, -1], [0, 1, -1], [-1, 1, 0], [-1, 0, 1], [0, -1, 1]];

export function neighbors(cx, cy) {
  const [x, , z] = toCube(cx, cy);
  return CUBE_DIRS.map((d) => toOffset(x + d[0], z + d[2]));
}

// ---------------------------------------------------------------- terrain

export function terrainAt(terrain, cx, cy) {
  if (!terrain) return DEFAULT_TERRAIN;
  return terrain[cy * MAP_W + cx] || DEFAULT_TERRAIN;
}

export function moveCost(terrain, cx, cy) {
  const t = TERRAIN[terrainAt(terrain, cx, cy)];
  return t ? t.cost : 1;
}

export function passable(terrain, cx, cy) {
  return inBounds(cx, cy) && moveCost(terrain, cx, cy) !== null;
}

// ---------------------------------------------------------------- routing

function cubeRound(x, y, z) {
  let rx = Math.round(x), ry = Math.round(y), rz = Math.round(z);
  const dx = Math.abs(rx - x), dy = Math.abs(ry - y), dz = Math.abs(rz - z);
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (dy > dz) ry = -rx - rz;
  else rz = -rx - ry;
  return [rx, ry, rz];
}

// Straight hex line, both ends included. The tiny offsets break ties the same
// way everywhere so a line along a hex edge always picks the same hexes.
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

// Every hex an army with `budget` movement can reach, as key -> {cost, prev}.
//
// Dijkstra with one bucket per cost. Costs are small integers and neighbours are
// always visited in the same order, so the result is identical on both sides.
export function reachable(terrain, ax, ay, budget) {
  const best = new Map([[key(ax, ay), { cost: 0, prev: null, cx: ax, cy: ay }]]);
  const buckets = [[[ax, ay]]];

  for (let cost = 0; cost <= budget; cost++) {
    const bucket = buckets[cost];
    if (!bucket) continue;
    for (const [cx, cy] of bucket) {
      const here = best.get(key(cx, cy));
      if (!here || here.cost !== cost) continue;      // superseded by a cheaper route
      for (const [nx, ny] of neighbors(cx, cy)) {
        if (!passable(terrain, nx, ny)) continue;
        const next = cost + moveCost(terrain, nx, ny);
        if (next > budget) continue;
        const k = key(nx, ny);
        const seen = best.get(k);
        if (seen && seen.cost <= next) continue;
        best.set(k, { cost: next, prev: [cx, cy], cx: nx, cy: ny });
        (buckets[next] || (buckets[next] = [])).push([nx, ny]);
      }
    }
  }
  return best;
}

// The hexes an army walks through, origin excluded, or [] if it can't get there
// within its movement. Prefers the straight line when that route is legal and
// affordable, so armies march sensibly across open ground.
export function walkPath(terrain, ax, ay, bx, by, budget) {
  if (ax === bx && ay === by) return [];
  if (!inBounds(ax, ay) || !passable(terrain, bx, by)) return [];

  const straight = line(ax, ay, bx, by).slice(1);
  if (straight.length && straight.every(([cx, cy]) => passable(terrain, cx, cy))) {
    const cost = straight.reduce((n, [cx, cy]) => n + moveCost(terrain, cx, cy), 0);
    if (cost <= budget) return straight;
  }

  const best = reachable(terrain, ax, ay, budget);
  if (!best.has(key(bx, by))) return [];

  const steps = [];
  let at = [bx, by];
  for (;;) {
    const node = best.get(key(at[0], at[1]));
    if (!node || !node.prev) break;
    steps.push(at);
    at = node.prev;
  }
  return steps.reverse();
}
