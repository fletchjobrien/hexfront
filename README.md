# HexFront

A simultaneous-turn hex strategy game for a group of friends — Twilight Imperium's
scheming and Diplomacy's "everyone writes orders in secret, then they all resolve
at once", on a hex-and-counter map.

A randomly generated 24×24 map, six factions, a city and an army each, fog of
war, terrain, dice combat, and a turn that resolves when everyone has submitted -
or after 48 hours, whichever comes first.

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
| Map | 24×24 hexes, randomly generated per game |
| Terrain | **Flat** costs 1, **hills** cost 2, **water** and **mountains** are impassable |
| Units | 1 city (never moves) and 1 army per faction |
| Army stats | **size** 10, **movement** 2, **damage** 3 |
| Sight | 4 hexes from a city, 3 from an army |
| Enemy city | Can't be entered — a march stops in front of it |
| Turn length | 48 hours, or as soon as everyone submits |

With 2 movement an army crosses two flat hexes, or one hill. Terrain is public —
everyone sees the whole map; the fog hides armies, not geography.

Each map is generated fresh: smoothed noise cut at fixed quantiles, so the mix
of land and water stays roughly constant. Every faction gets open ground around
its city, and the generator guarantees all six starts can reach each other on
foot — otherwise a game could be decided by an unlucky mountain range.

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
src/hex.js         Hex coordinates, terrain costs and routing
src/terrain.js     Random map generation
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
dropdown above the board switches between *All factions (no fog)* and looking
through any single faction's eyes, which is the only practical way to check that
the fog behaves. Submitting resolves the turn immediately, since you are the
only player.

### Upgrading an existing database

Each release so far has added columns. If your D1 database predates them, run
whichever of these it is missing, in the D1 console:

```sql
ALTER TABLE units ADD COLUMN size INTEGER NOT NULL DEFAULT 10;
ALTER TABLE units ADD COLUMN moves INTEGER NOT NULL DEFAULT 2;
ALTER TABLE units ADD COLUMN damage INTEGER NOT NULL DEFAULT 3;
ALTER TABLE games ADD COLUMN terrain TEXT;
ALTER TABLE games ADD COLUMN solo INTEGER NOT NULL DEFAULT 0;
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

- **Taking cities.** Cities block entry but never fall. Let an army that beats a
  city besiege and capture it, and add a victory condition.
- **Reinforcements.** Cities produce a new army, or add size to a nearby one,
  every few turns - otherwise attrition just ends the game.
- **Diplomacy.** Private messages between players, and formal alliances whose
  armies share a hex instead of fighting over it.
- **Notifications.** Email or Discord webhook when a turn resolves or a deadline
  approaches — this is what keeps a slow game alive.
- **Turn history.** Store each turn's resolved positions so players can replay
  what happened.
