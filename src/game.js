// Game rules: setup, fog of war, and simultaneous turn resolution.

import { MAP_W, MAP_H, inBounds, distance, key } from './hex.js';

export const MOVE_POINTS = 2;              // hexes a troop may move in one turn
export const VISION = { city: 4, troop: 3 };
export const TURN_HOURS = 48;              // auto-resolve deadline
export const MAX_PLAYERS = 6;
export const MIN_PLAYERS = 2;

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

  const stmts = [];
  for (const p of players) {
    const f = FACTIONS[p.faction];
    stmts.push(env.DB.prepare('INSERT INTO units (game_id, faction, kind, cx, cy) VALUES (?,?,?,?,?)')
      .bind(game.id, p.faction, 'city', f.city[0], f.city[1]));
    stmts.push(env.DB.prepare('INSERT INTO units (game_id, faction, kind, cx, cy) VALUES (?,?,?,?,?)')
      .bind(game.id, p.faction, 'troop', f.troop[0], f.troop[1]));
  }
  stmts.push(env.DB.prepare('UPDATE players SET submitted=0 WHERE game_id=?').bind(game.id));
  stmts.push(logStmt(env, game.id, 1, 'Game started - turn 1 orders are open.'));
  await env.DB.batch(stmts);
  return true;
}

// ---------------------------------------------------------------- turn resolution

// Resolves the current turn: every ordered move happens at once, and any hex
// two factions try to occupy is a standoff - everyone who moved there bounces
// back to where they started.
export async function resolveTurn(env, game, reason) {
  const turn = game.turn;
  const units = (await env.DB.prepare('SELECT * FROM units WHERE game_id=?')
    .bind(game.id).all()).results;
  const orders = (await env.DB.prepare('SELECT * FROM orders WHERE game_id=? AND turn=?')
    .bind(game.id, turn).all()).results;

  const ordered = new Map(orders.map((o) => [o.unit_id, o]));
  const dest = new Map();
  for (const u of units) {
    let d = [u.cx, u.cy];
    if (u.kind === 'troop') {
      const o = ordered.get(u.id);
      if (o && inBounds(o.cx, o.cy) && distance(u.cx, u.cy, o.cx, o.cy) <= MOVE_POINTS) {
        d = [o.cx, o.cy];
      }
    }
    dest.set(u.id, d);
  }

  // Cities hold their hex: a troop cannot walk into a foreign city (no combat yet).
  const cityOwner = new Map();
  for (const u of units) if (u.kind === 'city') cityOwner.set(key(u.cx, u.cy), u.faction);
  for (const u of units) {
    if (u.kind !== 'troop') continue;
    const d = dest.get(u.id);
    const owner = cityOwner.get(key(d[0], d[1]));
    if (owner !== undefined && owner !== u.faction) dest.set(u.id, [u.cx, u.cy]);
  }

  // Bounce contested hexes until the board is stable (a bounce can create a new clash).
  let clashes = 0;
  for (let pass = 0; pass < 6; pass++) {
    const groups = new Map();
    for (const u of units) {
      const d = dest.get(u.id);
      const k = key(d[0], d[1]);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(u);
    }
    let changed = false;
    for (const group of groups.values()) {
      if (new Set(group.map((u) => u.faction)).size < 2) continue;
      if (pass === 0) clashes++;
      for (const u of group) {
        const d = dest.get(u.id);
        if (d[0] !== u.cx || d[1] !== u.cy) {
          dest.set(u.id, [u.cx, u.cy]);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  // Claim the turn advance; if someone else already advanced it, do nothing.
  const claim = await env.DB.prepare(
    "UPDATE games SET turn = turn + 1, deadline_at = ? WHERE id = ? AND turn = ? AND status = 'active'"
  ).bind(Date.now() + TURN_MS, game.id, turn).run();
  if (!claim.meta.changes) return false;

  const stmts = [];
  for (const u of units) {
    const d = dest.get(u.id);
    if (d[0] !== u.cx || d[1] !== u.cy) {
      stmts.push(env.DB.prepare('UPDATE units SET cx=?, cy=? WHERE id=?').bind(d[0], d[1], u.id));
    }
  }
  stmts.push(env.DB.prepare('UPDATE players SET submitted=0 WHERE game_id=?').bind(game.id));
  stmts.push(env.DB.prepare('DELETE FROM orders WHERE game_id=? AND turn=?').bind(game.id, turn));

  let text = 'Turn ' + turn + ' resolved';
  if (reason === 'deadline') text += ' (deadline reached - unsubmitted players held position)';
  text += '.';
  if (clashes > 0) {
    text += ' ' + clashes + ' contested ' + (clashes === 1 ? 'hex' : 'hexes') + ' - forces bounced back.';
  }
  stmts.push(logStmt(env, game.id, turn, text));

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
      movePoints: MOVE_POINTS,
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
    state.units.push({ id: u.id, faction: u.faction, kind: u.kind, cx: u.cx, cy: u.cy, mine: isMine });
  }

  if (me) {
    const orders = (await env.DB.prepare(
      'SELECT o.* FROM orders o JOIN units u ON u.id = o.unit_id WHERE o.game_id=? AND o.turn=? AND u.faction=?'
    ).bind(game.id, game.turn, me.faction).all()).results;
    for (const o of orders) state.orders[o.unit_id] = [o.cx, o.cy];
  }

  state.log = (await env.DB.prepare(
    'SELECT turn, text, created_at FROM events WHERE game_id=? ORDER BY id DESC LIMIT 25'
  ).bind(game.id).all()).results;

  return state;
}
