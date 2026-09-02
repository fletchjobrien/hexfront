// Map generation.
//
// The board has six-fold rotational symmetry about its centre: whatever terrain
// one player has, every other player has exactly the same, turned 60 degrees.
// That is what makes the starts even in the Civ/Twilight Imperium sense - no
// player wakes up walled in by mountains while another has open plains.
//
// Symmetry is achieved by generating noise per *canonical* hex - the smallest of
// a hex's six rotations - so all six copies of a position share one value by
// construction, rather than being averaged into fairness afterwards.

import {
  MAP_W, MAP_H, inBounds, distance, key, neighbors, line, passable,
  toCube, toOffset, rotate60, rotateAround,
} from './hex.js';

export const CENTRE = [11, 11];
export const RING = 9;                 // how far each capital sits from the centre

// The board is a hexagon inscribed in the square grid, not the square itself.
// A square has no six-fold symmetry, so its corners would give some players more
// room than others; everything outside this radius is open sea.
export const PLAY_RADIUS = 11;

export function playable(cx, cy) {
  return inBounds(cx, cy) && distance(CENTRE[0], CENTRE[1], cx, cy) <= PLAY_RADIUS;
}

const MIX = [
  { ch: 'w', share: 0.16 },            // water     - impassable
  { ch: 'f', share: 0.42 },            // flat      - costs 1
  { ch: 'h', share: 0.33 },            // hills     - costs 2
  { ch: 'm', share: 0.09 },            // mountains - impassable
];

const SMOOTHING = 3;
const HOME_CLEAR = 1;                  // open ground around every capital
const HOME_VILLAGES = 2;               // private villages per player
const HOME_BAND = [2, 4];              // how far those sit from the capital
const CONTESTED_BAND = [4, 8];         // how far the shared ones sit

const at = (cx, cy) => cy * MAP_W + cx;

// ---------------------------------------------------------------- symmetry

const CENTRE_CUBE = toCube(CENTRE[0], CENTRE[1]);

function offsetFromCentre(cx, cy) {
  const p = toCube(cx, cy);
  return [p[0] - CENTRE_CUBE[0], p[1] - CENTRE_CUBE[1], p[2] - CENTRE_CUBE[2]];
}

function place(d) {
  return toOffset(CENTRE_CUBE[0] + d[0], CENTRE_CUBE[2] + d[2]);
}

// The representative of a hex's six rotations, so every copy shares one value.
function canonical(cx, cy) {
  const d = offsetFromCentre(cx, cy);
  let best = null;
  for (let k = 0; k < 6; k++) {
    const r = rotate60(d, k);
    const s = r[0] + ':' + r[1] + ':' + r[2];
    if (best === null || s < best) best = s;
  }
  return best;
}

// The six capitals: one vector, turned 60 degrees at a time.
export function factionStarts() {
  return [0, 1, 2, 3, 4, 5].map((k) => place(rotate60([RING, -RING, 0], k)));
}

// Each army musters beside its capital, facing the middle of the board.
export function troopStarts() {
  return factionStarts().map(([cx, cy]) => {
    const options = neighbors(cx, cy).filter(([nx, ny]) => inBounds(nx, ny));
    options.sort((a, b) =>
      distance(a[0], a[1], CENTRE[0], CENTRE[1]) - distance(b[0], b[1], CENTRE[0], CENTRE[1]));
    return options[0] || [cx, cy];
  });
}

// ---------------------------------------------------------------- terrain

function symmetricHeights(rng) {
  // One value per canonical hex - symmetric before it is even smoothed. Only
  // playable hexes take part, so no hex is ever smoothed against a neighbour
  // that its rotated twin does not also have.
  const cells = new Map();
  for (let cy = 0; cy < MAP_H; cy++) {
    for (let cx = 0; cx < MAP_W; cx++) {
      if (!playable(cx, cy)) continue;
      const k = canonical(cx, cy);
      if (!cells.has(k)) cells.set(k, { height: rng(), sample: [cx, cy] });
    }
  }

  // Smoothing runs in canonical space too, so it cannot break the symmetry.
  for (let pass = 0; pass < SMOOTHING; pass++) {
    const next = new Map();
    for (const [k, cell] of cells) {
      let sum = cell.height;
      let n = 1;
      for (const [nx, ny] of neighbors(cell.sample[0], cell.sample[1])) {
        const near = cells.get(canonical(nx, ny));
        if (!near) continue;
        sum += near.height;
        n++;
      }
      next.set(k, { height: sum / n, sample: cell.sample });
    }
    for (const [k, cell] of next) cells.set(k, cell);
  }
  return cells;
}

function cutPoints(cells) {
  const sorted = [...cells.values()].map((c) => c.height).sort((a, b) => a - b);
  const cuts = [];
  let running = 0;
  for (const band of MIX) {
    running += band.share;
    cuts.push({ ch: band.ch, limit: sorted[Math.min(sorted.length - 1, Math.floor(running * sorted.length))] });
  }
  cuts[cuts.length - 1].limit = Infinity;
  return cuts;
}

// ---------------------------------------------------------------- settlements

// Villages are placed once for one player and then rotated onto the other five,
// so the count and the walking distance are identical for everybody.
function chooseSettlements(rng) {
  const cities = factionStarts();
  const home = cities[0];
  const rival = cities[1];

  const nearest = (cx, cy) => cities
    .map((c, i) => ({ i, d: distance(cx, cy, c[0], c[1]) }))
    .sort((a, b) => a.d - b.d);

  const everyRotationFits = (cx, cy) =>
    [0, 1, 2, 3, 4, 5].every((k) => {
      const [rx, ry] = rotateAround(cx, cy, CENTRE, k);
      return inBounds(rx, ry);
    });

  const taken = new Set(cities.map(([cx, cy]) => key(cx, cy)));
  taken.add(key(CENTRE[0], CENTRE[1]));

  const candidates = [];
  for (let cy = 0; cy < MAP_H; cy++) {
    for (let cx = 0; cx < MAP_W; cx++) {
      if (!playable(cx, cy) || taken.has(key(cx, cy)) || !everyRotationFits(cx, cy)) continue;
      candidates.push({ cx, cy, rank: nearest(cx, cy) });
    }
  }

  // Private: comfortably closer to its own capital than to anyone else's.
  const privateSpots = candidates.filter((c) =>
    c.rank[0].i === 0 &&
    c.rank[0].d >= HOME_BAND[0] && c.rank[0].d <= HOME_BAND[1] &&
    c.rank[1].d >= c.rank[0].d + 3);

  // Contested: as close to a neighbour's capital as to your own, and clearly
  // further from everybody else, so it is a prize for exactly two players.
  const contestedSpots = candidates.filter((c) =>
    ((c.rank[0].i === 0 && c.rank[1].i === 1) || (c.rank[0].i === 1 && c.rank[1].i === 0)) &&
    Math.abs(c.rank[0].d - c.rank[1].d) <= 1 &&
    c.rank[2].d >= c.rank[1].d + 2 &&
    c.rank[0].d >= CONTESTED_BAND[0] && c.rank[0].d <= CONTESTED_BAND[1]);

  const settlements = [];
  const used = new Set(taken);

  // All six copies of a spot go down together or not at all, otherwise a
  // collision would quietly leave one player a village short.
  const spread = (pool, count, minGap) => {
    const bag = [...pool];
    let placed = 0;
    while (placed < count && bag.length) {
      const spot = bag.splice(Math.floor(rng() * bag.length), 1)[0];
      const copies = [];
      let usable = true;
      for (let k = 0; k < 6 && usable; k++) {
        const [cx, cy] = rotateAround(spot.cx, spot.cy, CENTRE, k);
        if (!playable(cx, cy) || used.has(key(cx, cy))) usable = false;
        else if (copies.some((c) => c[0] === cx && c[1] === cy)) usable = false;
        else if (settlements.some((s) => distance(s.cx, s.cy, cx, cy) < minGap)) usable = false;
        else copies.push([cx, cy]);
      }
      if (!usable || copies.length !== 6) continue;
      for (const [cx, cy] of copies) {
        used.add(key(cx, cy));
        settlements.push({ kind: 'village', faction: -1, cx, cy });
      }
      placed++;
    }
    return placed;
  };

  spread(privateSpots, HOME_VILLAGES, 2);
  spread(contestedSpots, 1, 2);

  return { cities, villages: settlements };
}

// ---------------------------------------------------------------- entry point

export function generateMap(rng = Math.random) {
  const cells = symmetricHeights(rng);
  const cuts = cutPoints(cells);

  // Everything outside the hexagon is open sea, which frames the board.
  const map = new Array(MAP_W * MAP_H).fill('w');
  for (let cy = 0; cy < MAP_H; cy++) {
    for (let cx = 0; cx < MAP_W; cx++) {
      if (!playable(cx, cy)) continue;
      const cell = cells.get(canonical(cx, cy));
      map[at(cx, cy)] = (cuts.find((c) => cell.height <= c.limit) || cuts[cuts.length - 1]).ch;
    }
  }

  const { cities, villages } = chooseSettlements(rng);
  const troops = troopStarts();
  const neutralCity = { kind: 'city', faction: -1, cx: CENTRE[0], cy: CENTRE[1] };

  // Nobody starts walled in, and no settlement sits on ground you cannot stand on.
  for (const [sx, sy] of cities) {
    for (let cy = 0; cy < MAP_H; cy++) {
      for (let cx = 0; cx < MAP_W; cx++) {
        if (playable(cx, cy) && distance(sx, sy, cx, cy) <= HOME_CLEAR) map[at(cx, cy)] = 'f';
      }
    }
  }
  for (const s of [...villages, neutralCity]) map[at(s.cx, s.cy)] = 'f';
  for (const [cx, cy] of troops) map[at(cx, cy)] = 'f';

  connect(map, [...cities, [CENTRE[0], CENTRE[1]], ...villages.map((v) => [v.cx, v.cy])]);

  return {
    terrain: map.join(''),
    cities,
    troops,
    settlements: [...villages, neutralCity],
  };
}

// Every capital, village and the middle have to be walkable from every other, or
// the map decides the game before anyone moves.
function connect(map, spots) {
  for (let attempt = 0; attempt < spots.length + 2; attempt++) {
    const seen = flood(map.join(''), spots[0]);
    const stranded = spots.find((s) => !seen.has(key(s[0], s[1])));
    if (!stranded) return;
    // Carve all six rotations of the corridor, so rescuing one player from a
    // lake does not hand them a road nobody else got.
    for (const [cx, cy] of line(stranded[0], stranded[1], spots[0][0], spots[0][1])) {
      for (let k = 0; k < 6; k++) {
        const [rx, ry] = rotateAround(cx, cy, CENTRE, k);
        if (playable(rx, ry)) map[at(rx, ry)] = 'f';
      }
    }
  }
}

function flood(terrain, from) {
  const seen = new Set([key(from[0], from[1])]);
  let frontier = [from];
  while (frontier.length) {
    const next = [];
    for (const [cx, cy] of frontier) {
      for (const [nx, ny] of neighbors(cx, cy)) {
        if (!passable(terrain, nx, ny) || seen.has(key(nx, ny))) continue;
        seen.add(key(nx, ny));
        next.push([nx, ny]);
      }
    }
    frontier = next;
  }
  return seen;
}
