-- HexFront schema. Safe to re-run.

CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT    NOT NULL UNIQUE,
  pw_salt    TEXT    NOT NULL,
  pw_hash    TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS games (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'lobby',   -- lobby | active
  turn        INTEGER NOT NULL DEFAULT 0,
  deadline_at INTEGER,
  host_id     INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  terrain     TEXT,
  solo        INTEGER NOT NULL DEFAULT 0,
  last_turn   TEXT
);

CREATE TABLE IF NOT EXISTS players (
  game_id   INTEGER NOT NULL,
  user_id   INTEGER NOT NULL,
  faction   INTEGER NOT NULL,
  ready     INTEGER NOT NULL DEFAULT 0,
  submitted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (game_id, user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS players_faction_unique ON players(game_id, faction);

-- cx / cy are odd-r offset hex coordinates (column, row).
CREATE TABLE IF NOT EXISTS units (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL,
  faction INTEGER NOT NULL,                        -- -1 for unclaimed
  kind    TEXT    NOT NULL,                        -- city | village | troop
  cx      INTEGER NOT NULL,
  cy      INTEGER NOT NULL,
  size    INTEGER NOT NULL DEFAULT 10,
  moves   INTEGER NOT NULL DEFAULT 2,
  damage  INTEGER NOT NULL DEFAULT 3
);
CREATE INDEX IF NOT EXISTS units_game ON units(game_id);

CREATE TABLE IF NOT EXISTS orders (
  game_id INTEGER NOT NULL,
  turn    INTEGER NOT NULL,
  unit_id INTEGER NOT NULL,
  cx      INTEGER NOT NULL,
  cy      INTEGER NOT NULL,
  PRIMARY KEY (game_id, turn, unit_id)
);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id    INTEGER NOT NULL,
  turn       INTEGER NOT NULL,
  text       TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_game ON events(game_id, id);
