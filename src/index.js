// HexFront - JSON API + static site, on one Cloudflare Worker.
//
// Anything matching a file in ./public is served by the assets binding before
// the Worker runs, so only /api/* (and unknown paths) reach this code.

import { inBounds, distance } from './hex.js';
import {
  FACTIONS, MAX_PLAYERS, MIN_PLAYERS, START, DICE, SIZE_PER_BONUS, TURN_HOURS,
  startGame, maybeResolve, buildState, resolveExpiredGames,
} from './game.js';

const SESSION_COOKIE = 'hf_session';
const SESSION_DAYS = 30;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        console.error(err);
        return json({ error: 'server_error', detail: String(err && err.message || err) }, 500);
      }
    }

    const res = await env.ASSETS.fetch(request);
    // Unknown paths fall back to the single-page app (it uses hash routing).
    if (res.status === 404 && request.method === 'GET') {
      return env.ASSETS.fetch(new Request(new URL('/', request.url), request));
    }
    return res;
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(resolveExpiredGames(env));
  },
};

// ---------------------------------------------------------------- helpers

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? body : {};
  } catch {
    return {};
  }
}

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function randomHex(bytes = 32) {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations: 100000, hash: 'SHA-256' }, key, 256
  );
  return bytesToHex(new Uint8Array(bits));
}

// Constant-time-ish compare so a wrong password doesn't leak by timing.
function sameHash(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function sessionCookie(token, maxAgeSeconds) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${maxAgeSeconds}`;
}

function readCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

async function currentUser(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  return env.DB.prepare(
    'SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?'
  ).bind(token).first();
}

async function newSession(env, userId) {
  const token = randomHex(32);
  await env.DB.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)')
    .bind(token, userId, Date.now()).run();
  return token;
}

// ---------------------------------------------------------------- routes

async function handleApi(request, env, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "api"
  const method = request.method;
  const head = parts[0];

  if (head === 'config' && method === 'GET') {
    return json({
      factions: FACTIONS.map((f) => ({ id: f.id, name: f.name, color: f.color })),
      defaultMoves: START.moves,
      startSize: START.size,
      dice: DICE,
      sizePerBonus: SIZE_PER_BONUS,
      turnHours: TURN_HOURS,
      maxPlayers: MAX_PLAYERS,
      minPlayers: MIN_PLAYERS,
      signupCodeRequired: !!env.SIGNUP_CODE,
    });
  }

  if (head === 'register' && method === 'POST') return register(request, env);
  if (head === 'login' && method === 'POST') return login(request, env);
  if (head === 'logout' && method === 'POST') {
    const token = readCookie(request, SESSION_COOKIE);
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token=?').bind(token).run();
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
  }

  const user = await currentUser(request, env);
  if (head === 'me' && method === 'GET') return json({ user });
  if (!user) return json({ error: 'not_logged_in' }, 401);

  if (head === 'games') {
    if (parts.length === 1 && method === 'GET') return listGames(env, user);
    if (parts.length === 1 && method === 'POST') return createGame(request, env, user);

    const gameId = Number(parts[1]);
    if (!Number.isInteger(gameId)) return json({ error: 'bad_game_id' }, 400);
    const game = await env.DB.prepare('SELECT * FROM games WHERE id=?').bind(gameId).first();
    if (!game) return json({ error: 'no_such_game' }, 404);

    const action = parts[2];
    if (action === 'state' && method === 'GET') {
      if (await maybeResolve(env, game)) {
        return json(await buildState(env, await refresh(env, gameId), user.id));
      }
      return json(await buildState(env, game, user.id));
    }
    if (action === 'join' && method === 'POST') return joinGame(request, env, user, game);
    if (action === 'faction' && method === 'POST') return pickFaction(request, env, user, game);
    if (action === 'ready' && method === 'POST') return setReady(request, env, user, game);
    if (action === 'leave' && method === 'POST') return leaveGame(env, user, game);
    if (action === 'orders' && method === 'POST') return setOrders(request, env, user, game);
    if (action === 'submit' && method === 'POST') return setSubmitted(request, env, user, game);
  }

  return json({ error: 'not_found' }, 404);
}

function refresh(env, gameId) {
  return env.DB.prepare('SELECT * FROM games WHERE id=?').bind(gameId).first();
}

// ---------------------------------------------------------------- accounts

async function register(request, env) {
  const { username, password, code } = await readJson(request);
  const name = String(username || '').trim();

  if (env.SIGNUP_CODE && String(code || '') !== env.SIGNUP_CODE) {
    return json({ error: 'bad_signup_code', message: 'Wrong invite code.' }, 403);
  }
  if (!/^[A-Za-z0-9_. -]{2,20}$/.test(name)) {
    return json({ error: 'bad_username', message: 'Name: 2-20 letters, numbers, spaces, _ . -' }, 400);
  }
  if (String(password || '').length < 6) {
    return json({ error: 'bad_password', message: 'Password must be at least 6 characters.' }, 400);
  }

  const existing = await env.DB.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE')
    .bind(name).first();
  if (existing) return json({ error: 'name_taken', message: 'That name is taken.' }, 409);

  const salt = randomHex(16);
  const hash = await hashPassword(password, salt);
  const result = await env.DB.prepare(
    'INSERT INTO users (username, pw_salt, pw_hash, created_at) VALUES (?,?,?,?)'
  ).bind(name, salt, hash, Date.now()).run();

  const userId = result.meta.last_row_id;
  const token = await newSession(env, userId);
  return json({ user: { id: userId, username: name } }, 200,
    { 'set-cookie': sessionCookie(token, SESSION_DAYS * 86400) });
}

async function login(request, env) {
  const { username, password } = await readJson(request);
  const name = String(username || '').trim();
  const row = await env.DB.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE')
    .bind(name).first();

  const salt = row ? row.pw_salt : randomHex(16);   // still hash on miss, to keep timing flat
  const hash = await hashPassword(String(password || ''), salt);
  if (!row || !sameHash(hash, row.pw_hash)) {
    return json({ error: 'bad_login', message: 'Wrong name or password.' }, 401);
  }

  const token = await newSession(env, row.id);
  return json({ user: { id: row.id, username: row.username } }, 200,
    { 'set-cookie': sessionCookie(token, SESSION_DAYS * 86400) });
}

// ---------------------------------------------------------------- lobby

async function listGames(env, user) {
  const games = (await env.DB.prepare(
    'SELECT * FROM games ORDER BY id DESC LIMIT 40'
  ).all()).results;
  const memberships = (await env.DB.prepare(
    'SELECT game_id, faction FROM players WHERE user_id=?'
  ).bind(user.id).all()).results;
  const counts = (await env.DB.prepare(
    'SELECT game_id, COUNT(*) AS n FROM players GROUP BY game_id'
  ).all()).results;

  const mine = new Map(memberships.map((m) => [m.game_id, m.faction]));
  const size = new Map(counts.map((c) => [c.game_id, c.n]));

  return json({
    games: games.map((g) => ({
      id: g.id,
      name: g.name,
      status: g.status,
      turn: g.turn,
      players: size.get(g.id) || 0,
      yourFaction: mine.has(g.id) ? mine.get(g.id) : null,
      joined: mine.has(g.id),
    })),
  });
}

async function createGame(request, env, user) {
  const { name } = await readJson(request);
  const title = String(name || '').trim().slice(0, 40) || `${user.username}'s game`;
  const result = await env.DB.prepare(
    "INSERT INTO games (name, status, turn, host_id, created_at) VALUES (?, 'lobby', 0, ?, ?)"
  ).bind(title, user.id, Date.now()).run();
  const gameId = result.meta.last_row_id;
  await env.DB.prepare('INSERT INTO players (game_id, user_id, faction) VALUES (?,?,?)')
    .bind(gameId, user.id, 0).run();
  return json({ id: gameId });
}

async function joinGame(request, env, user, game) {
  if (game.status !== 'lobby') return json({ error: 'game_started' }, 409);

  const players = (await env.DB.prepare('SELECT * FROM players WHERE game_id=?')
    .bind(game.id).all()).results;
  if (players.some((p) => p.user_id === user.id)) return json({ ok: true });
  if (players.length >= MAX_PLAYERS) return json({ error: 'game_full' }, 409);

  const body = await readJson(request);
  const taken = new Set(players.map((p) => p.faction));
  let faction = Number.isInteger(body.faction) ? body.faction : -1;
  if (faction < 0 || faction >= FACTIONS.length || taken.has(faction)) {
    faction = FACTIONS.findIndex((f) => !taken.has(f.id));
  }
  if (faction < 0) return json({ error: 'game_full' }, 409);

  await env.DB.prepare('INSERT INTO players (game_id, user_id, faction) VALUES (?,?,?)')
    .bind(game.id, user.id, faction).run();
  return json({ ok: true, faction });
}

async function pickFaction(request, env, user, game) {
  if (game.status !== 'lobby') return json({ error: 'game_started' }, 409);
  const { faction } = await readJson(request);
  if (!Number.isInteger(faction) || faction < 0 || faction >= FACTIONS.length) {
    return json({ error: 'bad_faction' }, 400);
  }
  const holder = await env.DB.prepare('SELECT user_id FROM players WHERE game_id=? AND faction=?')
    .bind(game.id, faction).first();
  if (holder && holder.user_id !== user.id) return json({ error: 'faction_taken' }, 409);

  const res = await env.DB.prepare('UPDATE players SET faction=?, ready=0 WHERE game_id=? AND user_id=?')
    .bind(faction, game.id, user.id).run();
  if (!res.meta.changes) return json({ error: 'not_in_game' }, 403);
  return json({ ok: true });
}

async function setReady(request, env, user, game) {
  if (game.status !== 'lobby') return json({ error: 'game_started' }, 409);
  const { ready } = await readJson(request);
  const res = await env.DB.prepare('UPDATE players SET ready=? WHERE game_id=? AND user_id=?')
    .bind(ready ? 1 : 0, game.id, user.id).run();
  if (!res.meta.changes) return json({ error: 'not_in_game' }, 403);

  const counts = await env.DB.prepare(
    'SELECT COUNT(*) AS total, COALESCE(SUM(ready), 0) AS done FROM players WHERE game_id=?'
  ).bind(game.id).first();

  let started = false;
  if (counts.total >= MIN_PLAYERS && counts.done === counts.total) {
    started = await startGame(env, game);
  }
  return json({ ok: true, started });
}

async function leaveGame(env, user, game) {
  if (game.status !== 'lobby') return json({ error: 'game_started' }, 409);
  await env.DB.prepare('DELETE FROM players WHERE game_id=? AND user_id=?')
    .bind(game.id, user.id).run();
  const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM players WHERE game_id=?')
    .bind(game.id).first();
  if (left.n === 0) {
    await env.DB.prepare('DELETE FROM games WHERE id=?').bind(game.id).run();
  }
  return json({ ok: true });
}

// ---------------------------------------------------------------- orders

async function setOrders(request, env, user, game) {
  if (game.status !== 'active') return json({ error: 'not_active' }, 409);

  const player = await env.DB.prepare('SELECT * FROM players WHERE game_id=? AND user_id=?')
    .bind(game.id, user.id).first();
  if (!player) return json({ error: 'not_in_game' }, 403);
  if (player.submitted) return json({ error: 'already_submitted', message: 'Un-submit to change orders.' }, 409);

  const { orders } = await readJson(request);
  if (!orders || typeof orders !== 'object') return json({ error: 'bad_orders' }, 400);

  const troops = (await env.DB.prepare(
    "SELECT * FROM units WHERE game_id=? AND faction=? AND kind='troop'"
  ).bind(game.id, player.faction).all()).results;
  const byId = new Map(troops.map((t) => [String(t.id), t]));

  const stmts = [];
  for (const [unitId, target] of Object.entries(orders)) {
    const unit = byId.get(String(unitId));
    if (!unit) return json({ error: 'not_your_unit', unitId }, 403);

    stmts.push(env.DB.prepare('DELETE FROM orders WHERE game_id=? AND turn=? AND unit_id=?')
      .bind(game.id, game.turn, unit.id));
    if (target === null || target === undefined) continue;

    const cx = Number(target[0]);
    const cy = Number(target[1]);
    if (!inBounds(cx, cy)) return json({ error: 'off_map' }, 400);
    if (distance(unit.cx, unit.cy, cx, cy) > unit.moves) return json({ error: 'too_far' }, 400);

    stmts.push(env.DB.prepare('INSERT INTO orders (game_id, turn, unit_id, cx, cy) VALUES (?,?,?,?,?)')
      .bind(game.id, game.turn, unit.id, cx, cy));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true });
}

async function setSubmitted(request, env, user, game) {
  if (game.status !== 'active') return json({ error: 'not_active' }, 409);
  const { submitted } = await readJson(request);
  const value = submitted === false ? 0 : 1;

  const res = await env.DB.prepare('UPDATE players SET submitted=? WHERE game_id=? AND user_id=?')
    .bind(value, game.id, user.id).run();
  if (!res.meta.changes) return json({ error: 'not_in_game' }, 403);

  const resolved = value === 1 ? await maybeResolve(env, game) : false;
  return json({ ok: true, resolved });
}
