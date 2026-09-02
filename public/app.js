'use strict';

// ---------------------------------------------------------------- state

const el = (id) => document.getElementById(id);

const HEX = 20;                        // hex "radius" in px
const HW = Math.sqrt(3) * HEX;         // column spacing
const HH = 1.5 * HEX;                  // row spacing
const PAD = 6;

let CONFIG = null;
let ME = null;
let STATE = null;
let selected = null;                   // id of the selected troop
let poll = null;
let ticker = null;
let authMode = 'login';

// ---------------------------------------------------------------- plumbing

async function api(path, method = 'GET', body) {
  const res = await fetch('/api' + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = (await res.json()) || {}; } catch { /* empty body */ }
  return { ok: res.ok, status: res.status, data };
}

function show(viewId) {
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== viewId;
  el('topbar').hidden = !ME;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function faction(id) {
  return (CONFIG && CONFIG.factions[id]) || { name: 'Unknown', color: '#666' };
}

// ---------------------------------------------------------------- hex maths
// Mirrors src/hex.js on the server: odd-r offset coordinates.

function toCube(cx, cy) {
  const x = cx - (cy - (cy & 1)) / 2;
  return [x, -x - cy, cy];
}

function dist(ax, ay, bx, by) {
  const a = toCube(ax, ay), b = toCube(bx, by);
  return (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / 2;
}

function center(cx, cy) {
  return [HW * (cx + 0.5 * (cy & 1)) + HW / 2 + PAD, HH * cy + HEX + PAD];
}

function hexPath(x, y) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 90);
    pts.push((x + HEX * Math.cos(a)).toFixed(1) + ',' + (y + HEX * Math.sin(a)).toFixed(1));
  }
  return pts.join(' ');
}

// ---------------------------------------------------------------- auth view

function renderAuth() {
  const isLogin = authMode === 'login';
  el('auth-title').textContent = isLogin ? 'Sign in' : 'Create account';
  el('auth-submit').textContent = isLogin ? 'Sign in' : 'Create account';
  el('auth-switch-text').textContent = isLogin ? 'No account yet?' : 'Already have one?';
  el('auth-switch').textContent = isLogin ? 'Create one' : 'Sign in';
  el('auth-code-row').hidden = isLogin || !(CONFIG && CONFIG.signupCodeRequired);
  el('auth-pass').autocomplete = isLogin ? 'current-password' : 'new-password';
  el('auth-error').hidden = true;
}

el('auth-switch').addEventListener('click', (e) => {
  e.preventDefault();
  authMode = authMode === 'login' ? 'register' : 'login';
  renderAuth();
});

el('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = el('auth-submit');
  btn.disabled = true;
  const body = { username: el('auth-user').value, password: el('auth-pass').value };
  if (authMode === 'register') body.code = el('auth-code').value;

  const { ok, data } = await api('/' + authMode, 'POST', body);
  btn.disabled = false;

  if (!ok) {
    const err = el('auth-error');
    err.textContent = data.message || 'Something went wrong.';
    err.hidden = false;
    return;
  }
  ME = data.user;
  el('whoami').textContent = ME.username;
  location.hash = '#/';
  route();
});

el('logout').addEventListener('click', async () => {
  await api('/logout', 'POST');
  ME = null;
  STATE = null;
  location.hash = '#/';
  route();
});

// ---------------------------------------------------------------- home view

async function renderHome() {
  show('view-home');
  const { data } = await api('/games');
  const list = el('game-list');

  if (!data.games || !data.games.length) {
    list.innerHTML = '<p class="muted small">No games yet. Create the first one.</p>';
    return;
  }

  list.innerHTML = data.games.map((g) => {
    const where = g.status === 'lobby' ? 'In lobby' : 'Turn ' + g.turn;
    const action = g.joined
      ? '<button class="primary" data-open="' + g.id + '">Open</button>'
      : (g.status === 'lobby'
          ? '<button data-join="' + g.id + '">Join</button>'
          : '<button data-open="' + g.id + '">Watch</button>');
    return '<div class="list-row">' +
      '<strong>' + esc(g.name) + '</strong>' +
      '<span class="tag">' + where + '</span>' +
      '<span class="muted small">' + g.players + '/' + CONFIG.maxPlayers + ' players</span>' +
      '<span class="spacer"></span>' + action + '</div>';
  }).join('');
}

el('game-list').addEventListener('click', async (e) => {
  const open = e.target.closest('[data-open]');
  const join = e.target.closest('[data-join]');
  if (open) location.hash = '#/g/' + open.dataset.open;
  if (join) {
    const { ok, data } = await api('/games/' + join.dataset.join + '/join', 'POST', {});
    if (ok) location.hash = '#/g/' + join.dataset.join;
    else alert(data.message || data.error);
  }
});

el('create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { ok, data } = await api('/games', 'POST', { name: el('create-name').value });
  if (ok) { el('create-name').value = ''; location.hash = '#/g/' + data.id; }
});

// ---------------------------------------------------------------- lobby view

function renderLobby(s) {
  show('view-lobby');
  el('lobby-name').textContent = s.game.name;

  const taken = new Map(s.players.map((p) => [p.faction, p]));
  el('faction-grid').innerHTML = CONFIG.factions.map((f) => {
    const holder = taken.get(f.id);
    const yours = holder && holder.isYou;
    const label = holder ? esc(holder.username) : 'open';
    const disabled = holder && !yours ? 'disabled' : '';
    return '<button class="faction-btn ' + (yours ? 'on' : '') + '" data-faction="' + f.id + '" ' + disabled + '>' +
      '<span class="swatch" style="background:' + f.color + '"></span>' +
      '<span><strong>' + esc(f.name) + '</strong><br><span class="muted small">' + label + '</span></span>' +
      '</button>';
  }).join('');

  const readyBtn = el('ready-btn');
  const you = s.you;
  readyBtn.hidden = !you;
  el('lobby-leave').hidden = !you;
  readyBtn.textContent = you && you.ready ? 'Not ready' : 'Ready up';
  readyBtn.className = you && you.ready ? 'ghost' : 'primary';

  const readyCount = s.players.filter((p) => p.ready).length;
  el('lobby-status').textContent = you
    ? readyCount + ' of ' + s.players.length + ' ready' +
      (s.players.length < s.game.minPlayers ? ' - need at least ' + s.game.minPlayers + ' players' : '')
    : 'Pick an open faction to join.';
  el('lobby-hint').textContent = you
    ? 'Pick a faction, then ready up. The game starts when everyone is ready.'
    : 'This lobby is open - claim a faction to join.';

  el('lobby-players').innerHTML = s.players.map((p) => {
    const f = faction(p.faction);
    return '<div class="list-row">' +
      '<span class="swatch" style="background:' + f.color + '"></span>' +
      '<strong>' + esc(p.username) + '</strong>' +
      (p.isYou ? '<span class="tag">you</span>' : '') +
      '<span class="muted small">' + esc(f.name) + '</span><span class="spacer"></span>' +
      '<span class="tag ' + (p.ready ? 'ok' : 'wait') + '">' + (p.ready ? 'ready' : 'not ready') + '</span></div>';
  }).join('');
}

el('faction-grid').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-faction]');
  if (!btn || !STATE) return;
  const faction = Number(btn.dataset.faction);
  const path = '/games/' + STATE.game.id + (STATE.you ? '/faction' : '/join');
  const { ok, data } = await api(path, 'POST', { faction });
  if (!ok) alert(data.message || data.error);
  refreshGame();
});

el('ready-btn').addEventListener('click', async () => {
  if (!STATE || !STATE.you) return;
  await api('/games/' + STATE.game.id + '/ready', 'POST', { ready: !STATE.you.ready });
  refreshGame();
});

el('lobby-leave').addEventListener('click', async () => {
  if (!STATE) return;
  await api('/games/' + STATE.game.id + '/leave', 'POST', {});
  location.hash = '#/';
});

// ---------------------------------------------------------------- game view

function renderGame(s) {
  show('view-game');
  el('game-name').textContent = s.game.name;
  el('turn-no').textContent = 'Turn ' + s.game.turn;
  renderDeadline();

  const you = s.you;
  const btn = el('submit-btn');
  btn.hidden = !you;
  if (you) {
    btn.textContent = you.submitted ? 'Un-submit' : 'Submit turn';
    btn.className = you.submitted ? 'ghost wide-btn' : 'primary wide-btn';
  }

  const waiting = s.players.filter((p) => !p.submitted).map((p) => p.username);
  el('submit-hint').textContent = !you
    ? 'You are watching this game.'
    : you.submitted
      ? (waiting.length ? 'Waiting on: ' + waiting.join(', ') : 'Resolving...')
      : 'Move your troop, then submit. Orders resolve once everyone submits.';

  el('game-players').innerHTML = s.players.map((p) => {
    const f = faction(p.faction);
    return '<div class="list-row">' +
      '<span class="swatch" style="background:' + f.color + '"></span>' +
      '<strong>' + esc(p.username) + '</strong>' +
      (p.isYou ? '<span class="tag">you</span>' : '') +
      '<span class="spacer"></span>' +
      '<span class="tag ' + (p.submitted ? 'ok' : 'wait') + '">' + (p.submitted ? 'in' : 'thinking') + '</span></div>';
  }).join('');

  el('game-log').innerHTML = s.log.length
    ? s.log.map((e) => '<div class="list-row">' + esc(e.text) + '</div>').join('')
    : '<div class="list-row">No events yet.</div>';

  renderMap(s);
}

function renderDeadline() {
  if (!STATE || !STATE.game.deadlineAt) { el('deadline').textContent = ''; return; }
  const ms = STATE.game.deadlineAt - Date.now();
  if (ms <= 0) { el('deadline').textContent = 'auto-resolving now'; return; }
  const mins = Math.floor(ms / 60000);
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  const parts = d ? d + 'd ' + h + 'h' : (h ? h + 'h ' + m + 'm' : m + 'm');
  el('deadline').textContent = 'auto-resolves in ' + parts;
}

function renderMap(s) {
  const visible = new Set(s.visible);
  const unitAt = new Map();
  for (const u of s.units) unitAt.set(u.cx + ',' + u.cy, u);

  const sel = s.units.find((u) => u.id === selected && u.mine && u.kind === 'troop') || null;
  if (!sel) selected = null;

  const reach = new Set();
  if (sel && s.you && !s.you.submitted) {
    for (let cy = 0; cy < s.game.mapH; cy++) {
      for (let cx = 0; cx < s.game.mapW; cx++) {
        if (dist(sel.cx, sel.cy, cx, cy) <= s.game.movePoints) reach.add(cx + ',' + cy);
      }
    }
  }

  const w = HW * (s.game.mapW + 0.5) + PAD * 2;
  const h = HH * (s.game.mapH - 1) + HEX * 2 + PAD * 2;
  const out = ['<svg viewBox="0 0 ' + w.toFixed(0) + ' ' + h.toFixed(0) + '" xmlns="http://www.w3.org/2000/svg">'];

  // 1. terrain
  for (let cy = 0; cy < s.game.mapH; cy++) {
    for (let cx = 0; cx < s.game.mapW; cx++) {
      const k = cx + ',' + cy;
      const [x, y] = center(cx, cy);
      let cls = 'hex ' + (visible.has(k) ? 'seen' : 'fog');
      if (reach.has(k)) cls = 'hex reach';
      if (sel && sel.cx === cx && sel.cy === cy) cls += ' sel';
      out.push('<polygon class="' + cls + '" points="' + hexPath(x, y) + '" data-cx="' + cx + '" data-cy="' + cy + '"></polygon>');
    }
  }

  // 2. ordered moves
  for (const [unitId, target] of Object.entries(s.orders || {})) {
    const u = s.units.find((n) => String(n.id) === String(unitId));
    if (!u) continue;
    const [x1, y1] = center(u.cx, u.cy);
    const [x2, y2] = center(target[0], target[1]);
    out.push('<line class="order-line" x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '"></line>');
    out.push('<circle class="order-dot" cx="' + x2 + '" cy="' + y2 + '" r="8"></circle>');
  }

  // 3. counters
  for (const u of s.units) {
    const f = faction(u.faction);
    const [x, y] = center(u.cx, u.cy);
    if (u.kind === 'city') {
      out.push('<g class="unit"><circle class="unit-city" cx="' + x + '" cy="' + y + '" r="11" fill="' + f.color + '"></circle>' +
        '<circle cx="' + x + '" cy="' + y + '" r="4.5" fill="none" stroke="#0b0e13" stroke-width="2"></circle></g>');
    } else {
      out.push('<g class="unit"><rect class="unit-troop" x="' + (x - 10) + '" y="' + (y - 8) + '" width="20" height="16" rx="2" fill="' + f.color + '"></rect>' +
        '<path d="M' + (x - 10) + ' ' + (y - 8) + ' L' + (x + 10) + ' ' + (y + 8) +
        ' M' + (x + 10) + ' ' + (y - 8) + ' L' + (x - 10) + ' ' + (y + 8) + '" stroke="#0b0e13" stroke-width="1.5" fill="none"></path></g>');
    }
  }

  out.push('</svg>');
  el('map').innerHTML = out.join('');

  el('map-hint').textContent = !s.you
    ? 'Spectating - you have no units here.'
    : s.you.submitted
      ? 'Orders are locked in. Un-submit if you want to change them.'
      : sel
        ? 'Click a highlighted hex to move there, or click your troop again to deselect.'
        : 'Click your troop (the square counter) to give it orders. Range: ' + s.game.movePoints + ' hexes.';
}

el('map').addEventListener('click', async (e) => {
  const hex = e.target.closest('polygon[data-cx]');
  if (!hex || !STATE || !STATE.you) return;
  const cx = Number(hex.dataset.cx), cy = Number(hex.dataset.cy);

  const mine = STATE.units.find((u) => u.mine && u.kind === 'troop' && u.cx === cx && u.cy === cy);
  if (mine) {
    selected = selected === mine.id ? null : mine.id;
    renderMap(STATE);
    return;
  }
  if (selected === null) return;

  const unit = STATE.units.find((u) => u.id === selected);
  if (!unit || STATE.you.submitted) return;
  if (dist(unit.cx, unit.cy, cx, cy) > STATE.game.movePoints) { selected = null; renderMap(STATE); return; }

  // Optimistic: draw the order now, then persist it.
  STATE.orders[unit.id] = [cx, cy];
  renderMap(STATE);
  const { ok, data } = await api('/games/' + STATE.game.id + '/orders', 'POST',
    { orders: { [unit.id]: [cx, cy] } });
  if (!ok) alert(data.message || data.error);
  refreshGame();
});

el('submit-btn').addEventListener('click', async () => {
  if (!STATE || !STATE.you) return;
  const btn = el('submit-btn');
  btn.disabled = true;
  await api('/games/' + STATE.game.id + '/submit', 'POST', { submitted: !STATE.you.submitted });
  btn.disabled = false;
  refreshGame();
});

// ---------------------------------------------------------------- routing

function gameIdFromHash() {
  const m = (location.hash || '').match(/^#\/g\/(\d+)/);
  return m ? Number(m[1]) : null;
}

async function refreshGame() {
  const id = gameIdFromHash();
  if (id === null) return;
  const { ok, data } = await api('/games/' + id + '/state');
  if (!ok) { location.hash = '#/'; return; }

  const turnChanged = STATE && STATE.game.turn !== data.game.turn;
  STATE = data;
  if (turnChanged) selected = null;

  if (data.game.status === 'lobby') renderLobby(data);
  else renderGame(data);
}

function stopPolling() {
  if (poll) { clearInterval(poll); poll = null; }
  if (ticker) { clearInterval(ticker); ticker = null; }
}

async function route() {
  stopPolling();
  if (!ME) { show('view-login'); renderAuth(); return; }
  el('whoami').textContent = ME.username;

  const id = gameIdFromHash();
  if (id === null) { STATE = null; renderHome(); return; }

  await refreshGame();
  poll = setInterval(refreshGame, 5000);
  ticker = setInterval(renderDeadline, 30000);
}

window.addEventListener('hashchange', route);

(async function boot() {
  const [cfg, me] = await Promise.all([api('/config'), api('/me')]);
  CONFIG = cfg.data;
  ME = me.data.user || null;
  route();
})();
