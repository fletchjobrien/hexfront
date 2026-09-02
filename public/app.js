'use strict';

// ---------------------------------------------------------------- state

const el = (id) => document.getElementById(id);

const HEX = 20;                        // hex "radius" in svg units
const HW = Math.sqrt(3) * HEX;         // column spacing
const HH = 1.5 * HEX;                  // row spacing
const PAD = 6;

const ZOOM_MIN = 0.35;
const ZOOM_MAX = 3;

const TERRAIN_FILL = { f: '#33503a', h: '#6b5a37', w: '#1d3f66', m: '#575761' };
const NEUTRAL_COLOR = '#9aa7b4';

let CONFIG = null;
let ME = null;
let STATE = null;
let selected = null;                   // id of the selected army
let poll = null;
let ticker = null;
let authMode = 'login';
let homeSignature = null;              // so polling doesn't rebuild an unchanged list
let viewAs = 'all';                    // solo test games only
let suppressClick = false;             // set while dragging, so a pan isn't a click
let showLast = localStorage.getItem('hexfront.lastTurn') !== 'off';

// 0 means "fit to the panel"; any other value is a fixed scale factor.
let zoom = Number(localStorage.getItem('hexfront.zoom')) || 0;

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
  if (id === -1) return { name: 'Free peoples', color: NEUTRAL_COLOR };
  return (CONFIG && CONFIG.factions[id]) || { name: 'Unknown', color: '#666' };
}

// ---------------------------------------------------------------- hex maths
// Mirrors src/hex.js: odd-r offset coordinates and terrain-aware routing.

function toCube(cx, cy) {
  const x = cx - (cy - (cy & 1)) / 2;
  return [x, -x - cy, cy];
}

function toOffset(x, z) {
  return [x + (z - (z & 1)) / 2, z];
}

function dist(ax, ay, bx, by) {
  const a = toCube(ax, ay), b = toCube(bx, by);
  return (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / 2;
}

const CUBE_DIRS = [[1, -1, 0], [1, 0, -1], [0, 1, -1], [-1, 1, 0], [-1, 0, 1], [0, -1, 1]];

function neighbors(cx, cy) {
  const [x, , z] = toCube(cx, cy);
  return CUBE_DIRS.map((d) => toOffset(x + d[0], z + d[2]));
}

function cubeRound(x, y, z) {
  let rx = Math.round(x), ry = Math.round(y), rz = Math.round(z);
  const dx = Math.abs(rx - x), dy = Math.abs(ry - y), dz = Math.abs(rz - z);
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (dy > dz) ry = -rx - rz;
  else rz = -rx - ry;
  return [rx, ry, rz];
}

function line(ax, ay, bx, by) {
  const steps = dist(ax, ay, bx, by);
  const a = toCube(ax, ay), b = toCube(bx, by);
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

function inBounds(cx, cy, s) {
  return cx >= 0 && cx < s.game.mapW && cy >= 0 && cy < s.game.mapH;
}

function terrainAt(s, cx, cy) {
  const t = s.game.terrain;
  if (!t) return 'f';
  return t[cy * s.game.mapW + cx] || 'f';
}

function moveCost(s, cx, cy) {
  const def = CONFIG.terrain[terrainAt(s, cx, cy)];
  return def ? def.cost : 1;
}

function passable(s, cx, cy) {
  return inBounds(cx, cy, s) && moveCost(s, cx, cy) !== null;
}

function reachable(s, ax, ay, budget) {
  const best = new Map([[ax + ',' + ay, { cost: 0, prev: null }]]);
  const buckets = [[[ax, ay]]];

  for (let cost = 0; cost <= budget; cost++) {
    const bucket = buckets[cost];
    if (!bucket) continue;
    for (const [cx, cy] of bucket) {
      const here = best.get(cx + ',' + cy);
      if (!here || here.cost !== cost) continue;
      for (const [nx, ny] of neighbors(cx, cy)) {
        if (!passable(s, nx, ny)) continue;
        const next = cost + moveCost(s, nx, ny);
        if (next > budget) continue;
        const k = nx + ',' + ny;
        const seen = best.get(k);
        if (seen && seen.cost <= next) continue;
        best.set(k, { cost: next, prev: [cx, cy] });
        (buckets[next] || (buckets[next] = [])).push([nx, ny]);
      }
    }
  }
  return best;
}

function walkPath(s, ax, ay, bx, by, budget) {
  if (ax === bx && ay === by) return [];
  if (!passable(s, bx, by)) return [];

  const straight = line(ax, ay, bx, by).slice(1);
  if (straight.length && straight.every(([cx, cy]) => passable(s, cx, cy))) {
    const cost = straight.reduce((n, [cx, cy]) => n + moveCost(s, cx, cy), 0);
    if (cost <= budget) return straight;
  }

  const best = reachable(s, ax, ay, budget);
  if (!best.has(bx + ',' + by)) return [];

  const steps = [];
  let at = [bx, by];
  for (;;) {
    const node = best.get(at[0] + ',' + at[1]);
    if (!node || !node.prev) break;
    steps.push(at);
    at = node.prev;
  }
  return steps.reverse();
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

// Polled, so a lobby someone else opens shows up without a refresh. The list is
// only rebuilt when it actually changed, so it never eats a half-typed name.
async function renderHome() {
  const { ok, data } = await api('/games');
  if (!ok || !data.games) return;

  const signature = JSON.stringify(data.games);
  if (signature === homeSignature) return;
  homeSignature = signature;

  const list = el('game-list');
  if (!data.games.length) {
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
      (g.solo ? '<span class="tag">test</span>' : '') +
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
  const solo = el('create-solo').checked;
  const { ok, data } = await api('/games', 'POST', { name: el('create-name').value, solo });
  if (ok) {
    el('create-name').value = '';
    el('create-solo').checked = false;
    viewAs = 'all';
    location.hash = '#/g/' + data.id;
  }
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
  const picked = Number(btn.dataset.faction);
  const path = '/games/' + STATE.game.id + (STATE.you ? '/faction' : '/join');
  const { ok, data } = await api(path, 'POST', { faction: picked });
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
  renderSeatPicker(s);

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
    : s.game.solo
      ? 'Test game - you command every faction. Submitting resolves the turn.'
      : you.submitted
        ? (waiting.length ? 'Waiting on: ' + waiting.join(', ') : 'Resolving...')
        : 'Move your armies, then submit. Orders resolve once everyone submits.';

  // With no fog, everyone can see everyone's holdings - so show the scoreboard.
  el('game-players').innerHTML = s.players.map((p) => {
    const f = faction(p.faction);
    const own = s.units.filter((u) => u.faction === p.faction);
    const strength = own.filter((u) => u.kind === 'troop').reduce((n, u) => n + u.size, 0);
    const towns = own.filter((u) => u.kind !== 'troop').length;
    return '<div class="list-row">' +
      '<span class="swatch" style="background:' + f.color + '"></span>' +
      '<strong>' + esc(p.username) + '</strong>' +
      (p.isYou && !s.game.solo ? '<span class="tag">you</span>' : '') +
      '<span class="spacer"></span>' +
      '<span class="muted small">' + towns + ' held &middot; ' + strength + ' str</span>' +
      '<span class="tag ' + (p.submitted ? 'ok' : 'wait') + '">' + (p.submitted ? 'in' : 'thinking') + '</span></div>';
  }).join('');

  el('game-log').innerHTML = s.log.length
    ? s.log.map((e) => '<div class="list-row">' + esc(e.text) + '</div>').join('')
    : '<div class="list-row">No events yet.</div>';

  renderMap(s);
}

function renderSeatPicker(s) {
  const picker = el('view-as');
  picker.hidden = !s.game.solo;
  if (!s.game.solo) return;

  const wanted = String(s.game.viewAs);
  const options = ['<option value="all">Commanding: all factions</option>'].concat(
    (s.game.factionsInPlay || []).map((f) =>
      '<option value="' + f + '">Commanding: ' + esc(faction(f).name) + '</option>'));
  const markup = options.join('');
  if (picker.dataset.built !== markup) {
    picker.innerHTML = markup;
    picker.dataset.built = markup;
  }
  picker.value = wanted;
}

el('view-as').addEventListener('change', (e) => {
  viewAs = e.target.value;
  selected = null;
  refreshGame();
});

function renderDeadline() {
  if (!STATE || !STATE.game.deadlineAt) { el('deadline').textContent = ''; return; }
  const ms = STATE.game.deadlineAt - Date.now();
  if (ms <= 0) { el('deadline').textContent = 'auto-resolving now'; return; }
  const mins = Math.floor(ms / 60000);
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  const parts = d ? d + 'd ' + h + 'h' : (h ? h + 'h ' + m + 'm' : m + 'm');
  el('deadline').textContent = 'auto-resolves in ' + parts;
}

// ---------------------------------------------------------------- zoom and pan

function baseWidth(s) {
  return HW * ((s ? s.game.mapW : 24) + 0.5) + PAD * 2;
}

function clampZoom(z) {
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
}

// Recomputed every time rather than cached, so "fit" survives a window resize
// and a first paint that happens before the board has been laid out.
function fitZoom(base) {
  const box = el('map-scroll').clientWidth;
  return box ? clampZoom(box / base) : 1;
}

function currentZoom() {
  return zoom || fitZoom(baseWidth(STATE));
}

function applyZoom() {
  const svg = document.querySelector('#map svg');
  if (!svg) return;
  const base = baseWidth(STATE);
  const z = zoom || fitZoom(base);
  svg.style.width = Math.round(base * z) + 'px';
  el('zoom-level').textContent = Math.round(z * 100) + '%';
}

function setZoom(next) {
  zoom = clampZoom(next);
  localStorage.setItem('hexfront.zoom', String(zoom));
  applyZoom();
}

el('zoom-in').addEventListener('click', () => setZoom(currentZoom() * 1.25));
el('zoom-out').addEventListener('click', () => setZoom(currentZoom() / 1.25));
el('zoom-fit').addEventListener('click', () => {
  zoom = 0;
  localStorage.setItem('hexfront.zoom', 'fit');
  applyZoom();
});
window.addEventListener('resize', () => { if (!zoom) applyZoom(); });

el('show-last').addEventListener('change', (e) => {
  showLast = e.target.checked;
  localStorage.setItem('hexfront.lastTurn', showLast ? 'on' : 'off');
  if (STATE) renderMap(STATE);
});

// Ctrl/cmd + wheel zooms; a plain wheel still scrolls the board.
el('map-scroll').addEventListener('wheel', (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  setZoom(currentZoom() * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
}, { passive: false });

// Drag to pan. Only for the mouse - touch already scrolls the panel natively.
// A drag that actually moved swallows the click, so panning never gives orders.
(function enablePan() {
  const scroller = el('map-scroll');
  let pan = null;

  // Any fresh press clears the flag, so a swallowed click can never linger.
  scroller.addEventListener('mousedown', () => { suppressClick = false; });

  scroller.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    suppressClick = false;
    pan = { x: e.clientX, y: e.clientY, left: scroller.scrollLeft, top: scroller.scrollTop, moved: false };
  });

  window.addEventListener('pointermove', (e) => {
    if (!pan) return;
    const dx = e.clientX - pan.x;
    const dy = e.clientY - pan.y;
    if (!pan.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    pan.moved = true;
    scroller.classList.add('grabbing');
    scroller.scrollLeft = pan.left - dx;
    scroller.scrollTop = pan.top - dy;
    e.preventDefault();
  });

  window.addEventListener('pointerup', () => {
    if (!pan) return;
    suppressClick = pan.moved;
    pan = null;
    scroller.classList.remove('grabbing');
  });
})();

// ---------------------------------------------------------------- map

// A capital is a skyline; a village is a hamlet. Both are drawn in the colour of
// whoever holds them, so the map reads as territory at a glance.
function settlementSvg(u, x, y, color) {
  const capital = u.kind === 'city';
  const bars = capital
    ? [[-10, 9], [-5.5, 15], [-1, 11], [3.5, 17], [8, 8]]
    : [[-7, 6], [-2.5, 9], [2, 6]];
  const ground = y + 9;

  let g = '<g class="unit settlement">';
  for (const [bx, bh] of bars) {
    g += '<rect class="building" x="' + (x + bx) + '" y="' + (ground - bh) +
         '" width="4" height="' + bh + '" fill="' + color + '"></rect>';
  }
  g += '<rect class="building base" x="' + (x - 12) + '" y="' + ground +
       '" width="24" height="3" fill="' + color + '"></rect>';
  return g + '</g>';
}

// What happened when the last turn resolved: where armies walked, where they
// fought, what changed hands. Deliberately faint - it is a footnote, not the
// current position.
function lastTurnSvg(s) {
  const last = s.lastTurn;
  if (!last || !showLast) return '';
  const out = ['<g class="replay">'];

  for (const m of last.moves || []) {
    const [x1, y1] = center(m.from[0], m.from[1]);
    const [x2, y2] = center(m.to[0], m.to[1]);
    const color = faction(m.faction).color;
    out.push('<line class="trace" x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 +
      '" stroke="' + color + '"></line>');
    out.push('<circle class="trace-from" cx="' + x1 + '" cy="' + y1 + '" r="2.5" fill="' + color + '"></circle>');
  }

  // A fight is a small starburst; an army lost is a cross. Different shapes, so
  // the two never read as the same thing.
  for (const f of last.fights || []) {
    const [x, y] = center(f.cx, f.cy);
    const rays = [0, 60, 120].map((deg) => {
      const a = (Math.PI / 180) * deg;
      const dx = Math.cos(a) * 6, dy = Math.sin(a) * 6;
      return 'M' + (x - dx).toFixed(1) + ' ' + (y - dy).toFixed(1) +
             ' L' + (x + dx).toFixed(1) + ' ' + (y + dy).toFixed(1);
    }).join(' ');
    out.push('<g class="clash"><path d="' + rays + '"></path></g>');
  }

  for (const c of last.captures || []) {
    const [x, y] = center(c.cx, c.cy);
    out.push('<circle class="taken" cx="' + x + '" cy="' + y + '" r="13" stroke="' +
      faction(c.by).color + '"></circle>');
  }

  for (const l of last.losses || []) {
    const [x, y] = center(l.cx, l.cy);
    out.push('<g class="wiped" stroke="' + faction(l.faction).color + '"><path d="M' + (x - 6) + ' ' + (y - 6) +
      ' L' + (x + 6) + ' ' + (y + 6) + ' M' + (x + 6) + ' ' + (y - 6) + ' L' + (x - 6) + ' ' + (y + 6) + '"></path></g>');
  }

  return out.join('') + '</g>';
}

function renderMap(s) {
  const sel = s.units.find((u) => u.id === selected && u.mine && u.kind === 'troop') || null;
  if (!sel) selected = null;

  let reach = null;
  if (sel && s.you && !s.you.submitted) {
    reach = reachable(s, sel.cx, sel.cy, sel.moves);
    reach.delete(sel.cx + ',' + sel.cy);
  }

  const w = baseWidth(s);
  const h = HH * (s.game.mapH - 1) + HEX * 2 + PAD * 2;
  const out = ['<svg viewBox="0 0 ' + w.toFixed(0) + ' ' + h.toFixed(0) + '" xmlns="http://www.w3.org/2000/svg">'];

  // 1. terrain - the click targets
  for (let cy = 0; cy < s.game.mapH; cy++) {
    for (let cx = 0; cx < s.game.mapW; cx++) {
      const [x, y] = center(cx, cy);
      const fill = TERRAIN_FILL[terrainAt(s, cx, cy)] || TERRAIN_FILL.f;
      out.push('<polygon class="hex" fill="' + fill + '" points="' + hexPath(x, y) +
        '" data-cx="' + cx + '" data-cy="' + cy + '"></polygon>');
    }
  }

  // 2. where the selected army could go
  if (reach) {
    for (const spot of reach.keys()) {
      const [cx, cy] = spot.split(',').map(Number);
      const [x, y] = center(cx, cy);
      out.push('<polygon class="overlay reach" points="' + hexPath(x, y) + '"></polygon>');
    }
  }
  if (sel) {
    const [x, y] = center(sel.cx, sel.cy);
    out.push('<polygon class="overlay sel" points="' + hexPath(x, y) + '"></polygon>');
  }

  // 3. what happened last turn, under everything current
  out.push(lastTurnSvg(s));

  // 4. ordered marches, drawn along the hexes the army actually walks
  for (const [unitId, target] of Object.entries(s.orders || {})) {
    const u = s.units.find((n) => String(n.id) === String(unitId));
    if (!u) continue;
    const steps = walkPath(s, u.cx, u.cy, target[0], target[1], u.moves);
    if (!steps.length) continue;
    const pts = [[u.cx, u.cy], ...steps]
      .map(([cx, cy]) => center(cx, cy).map((n) => n.toFixed(1)).join(',')).join(' ');
    const [tx, ty] = center(steps[steps.length - 1][0], steps[steps.length - 1][1]);
    out.push('<polyline class="order-line" points="' + pts + '" fill="none"></polyline>');
    out.push('<circle class="order-dot" cx="' + tx + '" cy="' + ty + '" r="8"></circle>');
  }

  // 5. settlements first, then armies on top of them
  for (const u of s.units) {
    if (u.kind === 'troop') continue;
    const [x, y] = center(u.cx, u.cy);
    out.push(settlementSvg(u, x, y, faction(u.faction).color));
  }
  for (const u of s.units) {
    if (u.kind !== 'troop') continue;
    const [x, y] = center(u.cx, u.cy);
    out.push('<g class="unit">' +
      '<rect class="unit-troop" x="' + (x - 11) + '" y="' + (y - 9) + '" width="22" height="18" rx="2" fill="' +
      faction(u.faction).color + '"></rect>' +
      '<text class="unit-size" x="' + x + '" y="' + (y + 4.5) + '">' + u.size + '</text></g>');
  }

  out.push('</svg>');
  el('map').innerHTML = out.join('');
  applyZoom();

  el('map-hint').textContent = !s.you
    ? 'Spectating - you have no armies here.'
    : s.you.submitted
      ? 'Orders are locked in. Un-submit if you want to change them.'
      : sel
        ? 'Selected army: size ' + sel.size + ', moves ' + sel.moves + ', damage ' + sel.damage +
          '. Hills cost 2; water and mountains are impassable.'
        : 'Click an army to give it orders. Move onto a village or city to take it. Drag to pan.';
}

el('map').addEventListener('click', async (e) => {
  if (suppressClick) { suppressClick = false; return; }
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
  if (!walkPath(STATE, unit.cx, unit.cy, cx, cy, unit.moves).length) {
    selected = null;
    renderMap(STATE);
    return;
  }

  // Optimistic: draw the order and drop the selection, then persist it.
  STATE.orders[unit.id] = [cx, cy];
  selected = null;
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
  const { ok, data } = await api('/games/' + id + '/state?as=' + encodeURIComponent(viewAs));
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
  if (id === null) {
    STATE = null;
    homeSignature = null;
    show('view-home');
    await renderHome();
    poll = setInterval(renderHome, 5000);
    return;
  }

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
