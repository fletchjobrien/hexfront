// Game rules: setup, fog of war, simultaneous movement and combat.

import { MAP_W, MAP_H, inBounds, distance, key, walkPath, neighbors } from './hex.js';

export const VISION = { city: 4, troop: 3 };
export const TURN_HOURS = 48;              // auto-resolve deadline
export const MAX_PLAYERS = 6;
export const MIN_PLAYERS = 2;

// Army stats. Size doubles as strength and hit points: it adds to the combat
// roll, and it is what damage eats away at.
export const START = { size: 10, moves: 2, damage: 3 };
export const DICE = 6;                     // one dN per side, per fight
export const SIZE_PER_BONUS = 3;           // +1 to the roll per this much size

export const FACTIONS = [
  { id: 0, name: 'Crimson Dominion',  color: '#ef4444', city: [11, 2],  troop: [11, 3]  },
  { id: 1, name: 'Azure Compact',     color: '#3b82f6', city: [20, 7],  troop: [20, 8]  },
  { id: 2, name: 'Verdant Concord',   color: '#22c55e', city: [20, 17], troop: [20, 16] },
  { id: 3, name: 'Golden Ascendancy', color: '#eab308', city: [11, 21], troop: [11, 20] },
  { id: 4, name: 'Violet Syndicate',  color: '#a855f7', city: [3, 17],  troop: [4, 16]  },
  { id: 5, name: 'Amber Coalition',   color: '#f97316', city: [3, 7],   troop: [4, 8]   },
];

export const TURN_MS = TURN_HOURS * 60 * 60 * 1000;

function logStmt(env, gameId, turn, text) {
  return env.DB.prepare('INSERT INTO events (game_id, turn, text, created_at) VALUES (?,?,?,?)')
    .bind(gameId, turn, text, Date.now());
}

// ---------------------------------------------------------------- setup

export async function startGame(env, game) {
  const players = (await env.DB.prepare('SELECT * FROM players WHERE game_id=?')
    .bind(game.id).all()).results;
  if (players.length < MIN_PLAYERS) return false;

  // Claim the transition so two simultaneous "ready" clicks can't both start it.
  const claim = await env.DB.prepare(
    "UPDATE games SET status='active', turn=1, deadline_at=? WHERE id=? AND status='lobby'"
  ).bind(Date.now() + TURN_MS, game.id).run();
  if (!claim.meta.changes) return false;

  const insert = (faction, kind, at, stats) => env.DB.prepare(
    'INSERT INTO units (game_id, faction, kind, cx, cy, size, moves, damage) VALUES (?,?,?,?,?,?,?,?)'
  ).bind(game.id, faction, kind, at[0], at[1], stats.size, stats.moves, stats.damage);

  const stmts = [];
  for (const p of players) {
    const f = FACTIONS[p.faction];
    stmts.push(insert(p.faction, 'city', f.city, { size: START.size, moves: 0, damage: 0 }));
    stmts.push(insert(p.faction, 'troop', f.troop, START));
  }
  stmts.push(env.DB.prepare('UPDATE players SET submitted=0 WHERE game_id=?').bind(game.id));
  stmts.push(logStmt(env, game.id, 1, 'Game started - turn 1 orders are open.'));
  await env.DB.batch(stmts);
  return true;
}

// ---------------------------------------------------------------- combat

function bonus(size) {
  return Math.floor(size / SIZE_PER_BONUS);
}

// A beaten army falls back one hex, as far from the winner as it can get.
function retreat(loser, winner, actors, cityOwner) {
  const options = neighbors(loser.cx, loser.cy).filter(([cx, cy]) => {
    if (!inBounds(cx, cy)) return false;
    const owner = cityOwner.get(key(cx, cy));
    if (owner !== undefined && owner !== loser.faction) return false;
    return !actors.some((a) => !a.dead && a.faction !== loser.faction && a.cx === cx && a.cy === cy);
  });
  if (!options.length) return false;
  options.sort((p, q) =>
    distance(q[0], q[1], winner.cx, winner.cy) - distance(p[0], p[1], winner.cx, winner.cy));
  loser.cx = options[0][0];
  loser.cy = options[0][1];
  return true;
}

// One fight. Everyone rolls; highest total takes the hex and everyone else
// takes damage and falls back. Positions are deliberately left out of the text
// so the shared log doesn't leak anyone's location through the fog.
function fight(group, intent, actors, cityOwner, roll, events) {
  const rolls = group.map((a) => {
    const r = roll();
    return { a, r, score: r + bonus(a.size) };
  });
  rolls.sort((p, q) => q.score - p.score);

  const detail = rolls
    .map((x) => `${x.a.name} (size ${x.a.size}) rolled ${x.r}+${bonus(x.a.size)}=${x.score}`)
    .join(' vs ');

  if (rolls[1] && rolls[0].score === rolls[1].score) {
    for (const x of rolls) x.a.stopped = true;
    events.push(`${detail} - stalemate, both held their ground.`);
    return;
  }

  const winner = rolls[0].a;
  const [wx, wy] = intent.get(winner.id);
  winner.cx = wx;
  winner.cy = wy;

  const outcomes = [];
  for (const { a: loser } of rolls.slice(1)) {
    loser.size -= winner.damage;
    loser.stopped = true;
    if (loser.size <= 0) {
      loser.dead = true;
      outcomes.push(`${loser.name}'s army was wiped out`);
      continue;
    }
    const fellBack = retreat(loser, winner, actors, cityOwner);
    outcomes.push(`${loser.name} lost ${winner.damage} and ${fellBack ? 'retreated' : 'was pinned with nowhere to retreat'} (size ${loser.size})`);
  }
  events.push(`${detail} - ${winner.name} won; ${outcomes.join('; ')}.`);
}

// ---------------------------------------------------------------- movement
//
// Everyone moves one hex at a time, in lockstep. After each step, any hex two
// factions both want, and any pair trying to swap places, becomes a fight. This
// is what stops armies from sliding through each other.

export function simulateTurn(units, orders, rng = Math.random) {
  const roll = () => 1 + Math.floor(rng() * DICE);
  const events = [];
  const ordered = new Map(orders.map((o) => [o.unit_id, o]));

  const cityOwner = new Map();
  for (const u of units) if (u.kind === 'city') cityOwner.set(key(u.cx, u.cy), u.faction);

  const actors = units.map((u) => ({
    id: u.id,
    faction: u.faction,
    kind: u.kind,
    name: (FACTIONS[u.faction] || { name: 'Unknown' }).name,
    cx: u.cx, cy: u.cy,
    startCx: u.cx, startCy: u.cy,
    size: u.size, moves: u.moves, damage: u.damage,
    startSize: u.size,
    path: [],
    stopped: u.kind !== 'troop',
    dead: false,
  }));

  for (const a of actors) {
    if (a.kind !== 'troop') continue;
    const o = ordered.get(a.id);
    if (!o || !inBounds(o.cx, o.cy)) continue;
    if (distance(a.cx, a.cy, o.cx, o.cy) > a.moves) continue;

    // Never more steps than the army has movement, whatever route it takes.
    const path = walkPath(a.cx, a.cy, o.cx, o.cy).slice(0, a.moves);
    // An enemy city is a wall for now - stop the turn before walking into it.
    const blocked = path.findIndex(([cx, cy]) => {
      const owner = cityOwner.get(key(cx, cy));
      return owner !== undefined && owner !== a.faction;
    });
    a.path = blocked === -1 ? path : path.slice(0, blocked);
    a.stopped = a.path.length === 0;
  }

  const maxSteps = actors.reduce((n, a) => Math.max(n, a.path.length), 0);

  for (let step = 0; step < maxSteps; step++) {
    const alive = actors.filter((a) => !a.dead);

    const intent = new Map();
    for (const a of alive) {
      const next = !a.stopped && a.path[step] ? a.path[step] : [a.cx, a.cy];
      intent.set(a.id, next);
    }

    const fighting = new Set();
    const conflicts = [];

    // Two factions want the same hex.
    const groups = new Map();
    for (const a of alive) {
      const [cx, cy] = intent.get(a.id);
      const k = key(cx, cy);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(a);
    }
    for (const group of groups.values()) {
      if (group.length > 1 && new Set(group.map((g) => g.faction)).size > 1) {
        conflicts.push(group);
        for (const g of group) fighting.add(g.id);
      }
    }

    // Head-on swap: each is walking into the hex the other is leaving.
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i], b = alive[j];
        if (a.faction === b.faction) continue;
        if (fighting.has(a.id) || fighting.has(b.id)) continue;
        const ia = intent.get(a.id), ib = intent.get(b.id);
        if (ia[0] === b.cx && ia[1] === b.cy && ib[0] === a.cx && ib[1] === a.cy) {
          conflicts.push([a, b]);
          fighting.add(a.id);
          fighting.add(b.id);
        }
      }
    }

    for (const a of alive) {
      if (fighting.has(a.id)) continue;
      const [cx, cy] = intent.get(a.id);
      a.cx = cx;
      a.cy = cy;
    }

    for (const group of conflicts) fight(group, intent, actors, cityOwner, roll, events);
  }

  return {
    events,
    results: actors.map((a) => ({
      id: a.id,
      cx: a.cx, cy: a.cy,
      size: a.size,
      dead: a.dead,
      changed: a.dead || a.cx !== a.startCx || a.cy !== a.startCy || a.size !== a.startSize,
    })),
  };
}

// ---------------------------------------------------------------- turn resolution

export async function resolveTurn(env, game, reason) {
  const turn = game.turn;
  const units = (await env.DB.prepare('SELECT * FROM units WHERE game_id=?')
    .bind(game.id).all()).results;
  const orders = (await env.DB.prepare('SELECT * FROM orders WHERE game_id=? AND turn=?')
    .bind(game.id, turn).all()).results;

  const { results, events } = simulateTurn(units, orders);

  // Claim the turn advance; if someone else already advanced it, do nothing.
  const claim = await env.DB.prepare(
    "UPDATE games SET turn = turn + 1, deadline_at = ? WHERE id = ? AND turn = ? AND status = 'active'"
  ).bind(Date.now() + TURN_MS, game.id, turn).run();
  if (!claim.meta.changes) return false;

  const stmts = [];
  for (const r of results) {
    if (!r.changed) continue;
    if (r.dead) {
      stmts.push(env.DB.prepare('DELETE FROM units WHERE id=?').bind(r.id));
    } else {
      stmts.push(env.DB.prepare('UPDATE units SET cx=?, cy=?, size=? WHERE id=?')
        .bind(r.cx, r.cy, r.size, r.id));
    }
  }
  stmts.push(env.DB.prepare('UPDATE players SET submitted=0 WHERE game_id=?').bind(game.id));
  stmts.push(env.DB.prepare('DELETE FROM orders WHERE game_id=? AND turn=?').bind(game.id, turn));

  let headline = `Turn ${turn} resolved`;
  if (reason === 'deadline') headline += ' (deadline reached - unsubmitted players held position)';
  stmts.push(logStmt(env, game.id, turn, headline + '.'));
  for (const text of events.slice(0, 20)) stmts.push(logStmt(env, game.id, turn, text));

  await env.DB.batch(stmts);
  return true;
}

// Resolves if everyone has submitted, or if the deadline has passed.
export async function maybeResolve(env, game) {
  if (!game || game.status !== 'active') return false;

  const counts = await env.DB.prepare(
    'SELECT COUNT(*) AS total, COALESCE(SUM(submitted), 0) AS done FROM players WHERE game_id=?'
  ).bind(game.id).first();

  if (counts.total > 0 && counts.done === counts.total) {
    return resolveTurn(env, game, 'all-submitted');
  }
  if (game.deadline_at && Date.now() >= game.deadline_at) {
    return resolveTurn(env, game, 'deadline');
  }
  return false;
}

export async function resolveExpiredGames(env) {
  const games = (await env.DB.prepare(
    "SELECT * FROM games WHERE status='active' AND deadline_at IS NOT NULL AND deadline_at <= ?"
  ).bind(Date.now()).all()).results;
  for (const g of games) await resolveTurn(env, g, 'deadline');
  return games.length;
}

// ---------------------------------------------------------------- fog of war

// Builds the view for one player. Hexes outside their vision are never sent,
// so the fog can't be peeled off by reading the network tab.
export async function buildState(env, game, userId) {
  const players = (await env.DB.prepare(
    'SELECT p.*, u.username FROM players p JOIN users u ON u.id = p.user_id WHERE p.game_id = ? ORDER BY p.faction'
  ).bind(game.id).all()).results;

  const me = players.find((p) => p.user_id === userId) || null;

  const state = {
    game: {
      id: game.id,
      name: game.name,
      status: game.status,
      turn: game.turn,
      deadlineAt: game.deadline_at,
      mapW: MAP_W,
      mapH: MAP_H,
      defaultMoves: START.moves,
      maxPlayers: MAX_PLAYERS,
      minPlayers: MIN_PLAYERS,
    },
    you: me
      ? { faction: me.faction, ready: !!me.ready, submitted: !!me.submitted, isHost: game.host_id === userId }
      : null,
    players: players.map((p) => ({
      username: p.username,
      faction: p.faction,
      ready: !!p.ready,
      submitted: !!p.submitted,
      isYou: p.user_id === userId,
    })),
    units: [],
    visible: [],
    orders: {},
    log: [],
  };

  if (game.status !== 'active') return state;

  const units = (await env.DB.prepare('SELECT * FROM units WHERE game_id=?')
    .bind(game.id).all()).results;

  // Anyone not in this game sees an empty board.
  const mine = me ? units.filter((u) => u.faction === me.faction) : [];
  const visible = new Set();
  for (const u of mine) {
    const r = VISION[u.kind] || 0;
    for (let cy = Math.max(0, u.cy - r); cy <= Math.min(MAP_H - 1, u.cy + r); cy++) {
      for (let cx = Math.max(0, u.cx - r - 1); cx <= Math.min(MAP_W - 1, u.cx + r + 1); cx++) {
        if (distance(u.cx, u.cy, cx, cy) <= r) visible.add(key(cx, cy));
      }
    }
  }
  state.visible = [...visible];

  for (const u of units) {
    const isMine = !!(me && u.faction === me.faction);
    if (!isMine && !visible.has(key(u.cx, u.cy))) continue;
    state.units.push({
      id: u.id, faction: u.faction, kind: u.kind, cx: u.cx, cy: u.cy,
      size: u.size, moves: u.moves, damage: u.damage, mine: isMine,
    });
  }

  if (me) {
    const orders = (await env.DB.prepare(
      'SELECT o.* FROM orders o JOIN units u ON u.id = o.unit_id WHERE o.game_id=? AND o.turn=? AND u.faction=?'
    ).bind(game.id, game.turn, me.faction).all()).results;
    for (const o of orders) state.orders[o.unit_id] = [o.cx, o.cy];
  }

  state.log = (await env.DB.prepare(
    'SELECT turn, text, created_at FROM events WHERE game_id=? ORDER BY id DESC LIMIT 40'
  ).bind(game.id).all()).results;

  return state;
}
