# HexFront

A simultaneous-turn hex strategy game for a group of friends — Twilight Imperium's
scheming and Diplomacy's "everyone writes orders in secret, then they all resolve
at once", on a hex-and-counter map.

This is the **ultra-simple v0**: one 24×24 map, six factions, a city and a troop
each, fog of war, and a turn that resolves when everyone has submitted (or after
48 hours, whichever comes first).

Runs as a single Cloudflare Worker: static frontend + JSON API, with game state
in D1 (Cloudflare's SQLite). No build step, no framework, no npm install needed
to deploy from GitHub.

---

## Deploying (no local tooling required)

Everything below can be done from the Cloudflare dashboard.

**1. Create the database**

Cloudflare dashboard → **Storage & Databases → D1** → *Create database*.
Name it `hexfront`. Copy the **Database ID** it shows you.

**2. Paste the ID into `wrangler.jsonc`**

Replace `PASTE_YOUR_D1_DATABASE_ID_HERE` with that ID and commit the change.

**3. Create the tables**

Still in D1, open your `hexfront` database → **Console** tab → paste the entire
contents of [`schema.sql`](schema.sql) → run it.

**4. Connect the repo**

Push this folder to GitHub, then in the Cloudflare dashboard go to
**Compute (Workers) → Create → Import a repository**, pick the repo, and deploy.
Cloudflare reads `wrangler.jsonc`, so the D1 binding and the cron trigger are set
up for you. Every push to `main` redeploys.

**5. (Optional) Lock signups to your friends**

In the Worker's **Settings → Variables and Secrets**, add a secret named
`SIGNUP_CODE`. When it is set, creating an account requires that code. Without
it, anyone who finds the URL can register.

### Or, if you have Node installed

```bash
npm install
npx wrangler d1 create hexfront          # paste the id into wrangler.jsonc
npx wrangler d1 execute hexfront --remote --file=./schema.sql
npx wrangler deploy
```

Local development with a local database:

```bash
npx wrangler d1 execute hexfront --local --file=./schema.sql
npx wrangler dev
```

---

## How a game runs

1. Sign in on the landing page (create an account first — it's just a name and a
   password).
2. **Create lobby**, or **Join** someone else's from the games list.
3. Everyone claims one of the six factions and hits **Ready up**. When all
   players in the lobby are ready (minimum 2), the game starts immediately.
4. Each player sees only their own faction's view: hexes within sight of their
   units, and enemy units only while they stand in that sight. The fog is applied
   on the server, so it can't be peeled off by reading the network tab.
5. Click your troop, click a hex within 2 to order a move, then **Submit turn**.
6. When every player has submitted, all moves happen simultaneously and the next
   turn opens. If someone goes quiet, the turn resolves on its own after 48 hours
   and their units hold position.

### Current rules

| | |
|---|---|
| Map | 24×24 hexes, no terrain yet |
| Units | 1 city (never moves) and 1 troop per faction |
| Movement | 2 hexes per turn, any direction |
| Sight | 4 hexes from a city, 3 from a troop |
| Contested hex | If two factions try to enter the same hex, both bounce back |
| Enemy city | Can't be entered (no combat yet) |
| Turn length | 48 hours, or as soon as everyone submits |

Those numbers all live at the top of [`src/game.js`](src/game.js) —
`MOVE_POINTS`, `VISION`, `TURN_HOURS`, and the `FACTIONS` table with each
faction's name, colour and starting position.

---

## Layout

```
wrangler.jsonc     Worker config: D1 binding, static assets, cron trigger
schema.sql         Database tables
src/index.js       HTTP layer: accounts, sessions, lobby and order endpoints
src/game.js        Rules: setup, fog of war, simultaneous turn resolution
src/hex.js         Odd-r offset hex coordinates and distance
public/index.html  Landing page, lobby and game shell
public/app.js      Client: SVG map, order entry, polling
public/style.css   Styling
```

`public/app.js` keeps its own copy of the hex distance function so it can
highlight legal moves. It must stay in step with `src/hex.js` — the server
re-checks every order anyway, so a mismatch shows up as moves the UI offers but
the server rejects.

---

## Things to add next

Roughly in order of "most game for the least code":

- **Combat.** Right now contested hexes bounce. Give troops a strength value and
  resolve a clash instead — the loser is removed, or both take damage.
- **Taking cities.** Let a troop that ends its turn on an enemy city capture it,
  and add a victory condition.
- **More units.** Cities produce a troop every N turns; add a second unit type.
- **Terrain.** Add a terrain column to the map and make movement cost vary. This
  is where real hex-and-counter feel comes from, and it needs pathfinding rather
  than the current "any hex within range".
- **Diplomacy.** Private messages between players, and formal alliances that
  make units stop bouncing off each other.
- **Notifications.** Email or Discord webhook when a turn resolves or a deadline
  approaches — this is what keeps a slow game alive.
- **Turn history.** Store each turn's resolved positions so players can replay
  what happened.
