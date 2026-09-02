// Procedural map generation.
//
// Smoothed noise gives blobby continents rather than television static, then the
// heights are cut at quantiles so every map has roughly the same mix of terrain
// whatever the noise happened to produce.

import { MAP_W, MAP_H, inBounds, neighbors, key, line, passable } from './hex.js';

const MIX = [
  { ch: 'w', share: 0.18 },   // water      - impassable
  { ch: 'f', share: 0.50 },   // flat       - costs 1
  { ch: 'h', share: 0.22 },   // hills      - costs 2
  { ch: 'm', share: 0.10 },   // mountains  - impassable
];

const SMOOTHING = 3;
const HOME_RADIUS = 2;        // hexes around each city forced to open ground

const at = (cx, cy) => cy * MAP_W + cx;

export function generateTerrain(starts, rng = Math.random) {
  let height = Array.from({ length: MAP_W * MAP_H }, () => rng());

  for (let pass = 0; pass < SMOOTHING; pass++) {
    const next = height.slice();
    for (let cy = 0; cy < MAP_H; cy++) {
      for (let cx = 0; cx < MAP_W; cx++) {
        let sum = height[at(cx, cy)];
        let n = 1;
        for (const [nx, ny] of neighbors(cx, cy)) {
          if (!inBounds(nx, ny)) continue;
          sum += height[at(nx, ny)];
          n++;
        }
        next[at(cx, cy)] = sum / n;
      }
    }
    height = next;
  }

  // Cut at quantiles so the mix is stable even though smoothing squashes the range.
  const sorted = [...height].sort((a, b) => a - b);
  const cuts = [];
  let running = 0;
  for (const band of MIX) {
    running += band.share;
    cuts.push({ ch: band.ch, limit: sorted[Math.min(sorted.length - 1, Math.floor(running * sorted.length))] });
  }

  const map = height.map((h) => (cuts.find((c) => h <= c.limit) || cuts[cuts.length - 1]).ch);

  // Nobody starts walled in.
  for (const [sx, sy] of starts) {
    for (let cy = 0; cy < MAP_H; cy++) {
      for (let cx = 0; cx < MAP_W; cx++) {
        if (hexDistance(sx, sy, cx, cy) <= HOME_RADIUS) map[at(cx, cy)] = 'f';
      }
    }
  }

  connectStarts(map, starts);
  return map.join('');
}

function hexDistance(ax, ay, bx, by) {
  const ax3 = ax - (ay - (ay & 1)) / 2;
  const bx3 = bx - (by - (by & 1)) / 2;
  const ay3 = -ax3 - ay;
  const by3 = -bx3 - by;
  return (Math.abs(ax3 - bx3) + Math.abs(ay3 - by3) + Math.abs(ay - by)) / 2;
}

// Every faction has to be able to reach every other one, or the game is a
// stalemate by geography. Any start cut off from the first one gets a corridor
// carved to it.
function connectStarts(map, starts) {
  if (!starts.length) return;
  const terrain = () => map.join('');

  for (let attempt = 0; attempt < starts.length; attempt++) {
    const seen = flood(terrain(), starts[0]);
    const stranded = starts.find((s) => !seen.has(key(s[0], s[1])));
    if (!stranded) return;
    for (const [cx, cy] of line(stranded[0], stranded[1], starts[0][0], starts[0][1])) {
      if (inBounds(cx, cy)) map[at(cx, cy)] = 'f';
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
