# HexFront

A simultaneous-turn hex strategy game for a group of friends — Twilight Imperium's
scheming and Diplomacy's "everyone writes orders in secret, then they all resolve
at once", on a hex-and-counter map.

One 24×24 map, six factions, a city and an army each, fog of war, dice combat,
and a turn that resolves when everyone has submitted - or after 48 hours,
whichever comes first.

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
5. Click your army, click a hex within its movement to order a march, then
   **Submit turn**. The dashed line shows the route it will actually walk.
6. When every player has submitted, all moves happen simultaneously and the next
   turn opens. If someone goes quiet, the turn resolves on its own after 48 hours
   and their armies hold position.

### Current rules

| | |
|---|---|
| Map | 24×24 hexes, no terrain yet |
| Units | 1 city (never moves) and 1 army per faction |
| Army stats | **size** 10, **movement** 2, **damage** 3 |
| Sight | 4 hexes from a city, 3 from an army |
| Enemy city | Can't be entered — a march stops in front of it |
| Turn length | 48 hours, or as soon as everyone submits |

### How a turn resolves

Every army moves **one hex at a time, in lockstep**. After each step the server
looks for two things:

- two factions ending up on the same hex, and
- two armies trying to trade places.

Either one is a fight, which is what stops armies sliding through each other —
there is no swapping.

**The fight.** Each side rolls a d6 and adds a bonus of `size ÷ 3`, rounded
down. So a size-10 army adds +3. Highest total wins:

- the **winner** keeps going wherever it was headed;
- each **loser** takes damage equal to the winner's `damage` and retreats one
  hex, as far from the winner as it can get. An army with nowhere to fall back
  to is pinned and takes the damage where it stands;
- an army reduced to **0 size or less is wiped out**;
- an exact **tie is a stalemate** — everyone holds, nobody takes damage.

Because size feeds the roll *and* soaks the damage, a battered army gets easier
to finish off — but a d6 swing of 5 is worth 15 points of size, so a small army
can still upset a big one.

Fights are written to the shared log with both rolls, so everyone can see how it
went. Coordinates are deliberately left out so the log doesn't leak positions
through the fog.

All of these numbers live at the top of [`src/game.js`](src/game.js) — `START`
(size, moves, damage), `DICE`, `SIZE_PER_BONUS`, `VISION`, `TURN_HOURS`, and the
`FACTIONS` table with each faction's name, colour and starting position.

---

## Layout

```
wrangler.jsonc     Worker config: D1 binding, static assets, cron trigger
schema.sql         Database tables
src/index.js       HTTP layer: accounts, sessions, lobby and order endpoints
src/game.js        Rules: setup, fog of war, simultaneous movement and combat
src/hex.js         Odd-r offset hex coordinates, distance and routing
public/index.html  Landing page, lobby and game shell
public/app.js      Client: SVG map, order entry, polling
public/style.css   Styling
```

`public/app.js` keeps its own copy of the hex distance and routing functions so
it can highlight legal moves and draw the route an army will walk. They must
stay in step with `src/hex.js` — the server recomputes everything anyway, so a
mismatch shows up as a drawn route that doesn't match what actually happened.

### Upgrading a database made before armies had stats

The `units` table gained `size`, `moves` and `damage`. If your D1 database
predates that, run this once in the D1 console rather than recreating it:

```sql
ALTER TABLE units ADD COLUMN size INTEGER NOT NULL DEFAULT 10;
ALTER TABLE units ADD COLUMN moves INTEGER NOT NULL DEFAULT 2;
ALTER TABLE units ADD COLUMN damage INTEGER NOT NULL DEFAULT 3;
```

The D1 console rejects input it can't parse into a statement, and `--` comment
lines are the usual cause — strip them before pasting:

```bash
sed -e 's/[[:space:]]*--.*$//' schema.sql | grep -v '^[[:space:]]*$'
```

---

## Things to add next

Roughly in order of "most game for the least code":

- **Taking cities.** Cities block entry but never fall. Let an army that beats a
  city besiege and capture it, and add a victory condition.
- **Reinforcements.** Cities produce a new army, or add size to a nearby one,
  every few turns - otherwise attrition just ends the game.
- **Terrain.** Add a terrain column to the map and make movement cost vary.
  `walkPath` in `src/hex.js` is already the single place routing happens, so
  terrain only has to be taught there. This is where real hex-and-counter feel
  comes from.
- **Diplomacy.** Private messages between players, and formal alliances whose
  armies share a hex instead of fighting over it.
- **Notifications.** Email or Discord webhook when a turn resolves or a deadline
  approaches — this is what keeps a slow game alive.
- **Turn history.** Store each turn's resolved positions so players can replay
  what happened.
