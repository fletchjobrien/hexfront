# HexFront

A simultaneous-turn hex strategy game for a group of friends — Twilight Imperium's
scheming and Diplomacy's "everyone writes orders in secret, then they all resolve
at once", on a hex-and-counter map.

A randomly generated, perfectly symmetrical hex board; six factions with a
capital and an army each; villages and a free city to fight over; terrain, dice
combat, and a turn that resolves when everyone has submitted - or after 48
hours, whichever comes first.

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
4. The whole board is visible to everyone - there is no fog. What you cannot see
   is what your rivals have *ordered*, which is where the bluffing lives.
5. Click your army, click a hex within its movement to order a march, then
   **Submit turn**. The dashed line shows the route it will actually walk.
6. When every player has submitted, all moves happen simultaneously and the next
   turn opens. If someone goes quiet, the turn resolves on its own after 48 hours
   and their armies hold position.

### Current rules

| | |
|---|---|
| Board | A hexagon of 397 hexes, randomly generated per game, ringed by open sea |
| Terrain | **Flat** costs 1, **hills** cost 2, **water** and **mountains** are impassable |
| Units | 1 capital (never moves) and 1 army per faction |
| Army stats | **size** 10, **movement** 2, **damage** 3 |
| Settlements | Each player's capital, 18 free villages, and one free city in the middle |
| Capturing | Walk onto a village to take it; a city must be beaten in battle first |
| Turn length | 48 hours, or as soon as everyone submits |

With 2 movement an army crosses two flat hexes, or one hill.

### An even start

The board has **six-fold rotational symmetry**. Whatever terrain one player has,
every other player has exactly the same, turned 60°. That is enforced by
generating the noise per *canonical* hex — the smallest of a hex's six rotations
— so all six copies share one value by construction rather than being nudged
into fairness afterwards.

The playable area is a hexagon of radius 11 inscribed in the square grid, with
open sea beyond it. A square has no six-fold symmetry, so its corners would have
handed some players more room than others.

Villages follow the same rule: two spots are chosen near one capital and one on
the border between two, then each is rotated onto all six positions. Every player
therefore has **two private villages** at identical walking distance, and there
is **one contested village on each of the six borders**, plus the free city in
the middle that everybody can reach equally. The private ones are yours for the
taking; the seven in between are not enough to go round.

The generator also checks that every capital, village and the centre is
reachable on foot, and carves a corridor (in all six rotations) if not.

### How a turn resolves

Every army moves **one hex at a time, in lockstep**. After each step the server
looks for three things:

- two factions ending up on the same hex,
- two armies trying to trade places, and
- an army **moving into contact** — finishing a step next to an enemy.

Any of them is a fight. The first two mean there is no swapping and no walking
through each other; the third means a march stops dead the moment it runs into
somebody, so you cannot slip past an enemy army that is standing in your way.

Armies that were *already* next to each other and both stay put do not fight —
contact has to be made by somebody moving. That also means you can disengage, as
long as you end your move somewhere that isn't still adjacent.

**The fight.** Each side rolls a d6 and adds a bonus of `size ÷ 3`, rounded
down. So a size-10 army adds +3. Highest total wins:

- everyone involved is **finished moving for the turn**, winner included;
- the **winner** takes the hex that was being fought over, if there was one;
- each **loser** takes damage equal to the winner's `damage` and retreats one
  hex, as far from the winner as it can get. An army with nowhere to fall back
  to is pinned and takes the damage where it stands;
- an army reduced to **0 size or less is wiped out**;
- an exact **tie is a stalemate** — everyone holds, nobody takes damage.

Because size feeds the roll *and* soaks the damage, a battered army gets easier
to finish off — but a d6 swing of 5 is worth 15 points of size, so a small army
can still upset a big one.

Fights are written to the shared log with both rolls, so everyone can see how it
went. The board also shows a faint replay of the turn that just resolved - where
armies walked, a starburst where they fought, a dashed ring on anything that
changed hands, a cross where an army was destroyed. Untick **Last turn** above
the board to hide it.

All of these numbers live at the top of [`src/game.js`](src/game.js) — `START`
(size, moves, damage), `CITY`, `VILLAGE`, `DICE`, `SIZE_PER_BONUS`, `TURN_HOURS`
and the `FACTIONS` table. The map's shape and village placement are the
constants at the top of [`src/terrain.js`](src/terrain.js).

---

## Layout

```
wrangler.jsonc     Worker config: D1 binding, static assets, cron trigger
schema.sql         Database tables
src/index.js       HTTP layer: accounts, sessions, lobby and order endpoints
src/game.js        Rules: setup, simultaneous movement, combat and capture
src/hex.js         Hex coordinates, terrain costs and routing
src/terrain.js     Symmetric map generation and settlement placement
public/index.html  Landing page, lobby and game shell
public/app.js      Client: SVG map, order entry, polling
public/style.css   Styling
```

`public/app.js` keeps its own copy of the hex distance and routing functions so
it can highlight legal moves and draw the route an army will walk. They must
stay in step with `src/hex.js` — the server recomputes everything anyway, so a
mismatch shows up as a drawn route that doesn't match what actually happened.

### Test games

Tick **"Test game"** when creating a game and it skips the lobby entirely: you
get a map with all six factions on it and you command every one of them. The
dropdown above the board chooses which faction you are giving orders to, or all
six at once. Submitting resolves the turn immediately, since you are the only
player.

### Upgrading an existing database

Each release so far has added columns. If your D1 database predates them, run
whichever of these it is missing, in the D1 console:

```sql
ALTER TABLE units ADD COLUMN size INTEGER NOT NULL DEFAULT 10;
ALTER TABLE units ADD COLUMN moves INTEGER NOT NULL DEFAULT 2;
ALTER TABLE units ADD COLUMN damage INTEGER NOT NULL DEFAULT 3;
ALTER TABLE games ADD COLUMN terrain TEXT;
ALTER TABLE games ADD COLUMN solo INTEGER NOT NULL DEFAULT 0;
ALTER TABLE games ADD COLUMN last_turn TEXT;
```

SQLite has no `ADD COLUMN IF NOT EXISTS`, so a column you already have will
error — that error is harmless, just run the rest. Games created before terrain
existed have none, and every hex in them behaves as flat.

The D1 console rejects input it can't parse into a statement, and `--` comment
lines are the usual cause — strip them before pasting:

```bash
sed -e 's/[[:space:]]*--.*$//' schema.sql | grep -v '^[[:space:]]*$'
```

---

## Things to add next

Roughly in order of "most game for the least code":

- **A victory condition.** Settlements can be taken but nothing ends the game -
  first to hold N of them, or hold the middle for N turns, is the obvious start.
- **Reinforcements.** Cities produce a new army, or add size to a nearby one,
  every few turns - otherwise attrition just ends the game.
- **Diplomacy.** Private messages between players, and formal alliances whose
  armies share a hex instead of fighting over it.
- **Notifications.** Email or Discord webhook when a turn resolves or a deadline
  approaches — this is what keeps a slow game alive.
- **Turn history.** Store each turn's resolved positions so players can replay
  what happened.
