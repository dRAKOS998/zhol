import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { GameState, RoundResult } from '@zhol/engine';

export interface StoredRoom {
  code: string;
  version: number;
  names: (string | null)[];
  /** Seats played by the computer. */
  bots: boolean[];
  game: GameState;
  createdAt: number;
  updatedAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  code        TEXT PRIMARY KEY,
  version     INTEGER NOT NULL,
  names_json  TEXT NOT NULL,
  state_json  TEXT NOT NULL,
  phase       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS seats (
  room_code   TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
  seat        INTEGER NOT NULL CHECK (seat BETWEEN 0 AND 3),
  token_hash  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (room_code, seat)
);
-- Immutable ledger: one row per scored round of each tournament played in the room.
-- The primary key makes double scoring impossible.
CREATE TABLE IF NOT EXISTS round_results (
  room_code    TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
  game_number  INTEGER NOT NULL DEFAULT 1,
  round_number INTEGER NOT NULL CHECK (round_number BETWEEN 1 AND 4),
  deal_id      TEXT NOT NULL,
  result_json  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (room_code, game_number, round_number)
);
-- Idempotency ledger for gameplay commands (no credentials stored here).
CREATE TABLE IF NOT EXISTS requests (
  room_code     TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
  seat          INTEGER NOT NULL,
  request_id    TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (room_code, seat, request_id)
);
CREATE INDEX IF NOT EXISTS requests_created ON requests(created_at);
CREATE INDEX IF NOT EXISTS rooms_updated ON rooms(updated_at);
PRAGMA user_version = 1;
`;

const RESULTS_IMMUTABLE = `
CREATE TRIGGER IF NOT EXISTS round_results_immutable
  BEFORE UPDATE ON round_results
  BEGIN SELECT RAISE(ABORT, 'round results are immutable'); END;
`;

export type Db = ReturnType<typeof openDatabase>;

export function openDatabase(file: string) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  // Migration: bot seats (added with 2–4 player tables).
  const cols = db.prepare<[], { name: string }>('PRAGMA table_info(rooms)').all();
  if (!cols.some((c) => c.name === 'bots_json')) {
    db.exec("ALTER TABLE rooms ADD COLUMN bots_json TEXT NOT NULL DEFAULT '[false,false,false,false]'");
  }
  // Migration: rematches. A room can hold several tournaments, so the ledger key gains the game number.
  // SQLite cannot change a primary key in place: rebuild the table, keeping every existing row as game 1.
  const ledger = db.prepare<[], { name: string }>('PRAGMA table_info(round_results)').all();
  if (!ledger.some((c) => c.name === 'game_number')) {
    db.transaction(() => {
      db.exec(`
        DROP TRIGGER IF EXISTS round_results_immutable;
        ALTER TABLE round_results RENAME TO round_results_v1;
        CREATE TABLE round_results (
          room_code    TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
          game_number  INTEGER NOT NULL DEFAULT 1,
          round_number INTEGER NOT NULL CHECK (round_number BETWEEN 1 AND 4),
          deal_id      TEXT NOT NULL,
          result_json  TEXT NOT NULL,
          created_at   INTEGER NOT NULL,
          PRIMARY KEY (room_code, game_number, round_number)
        );
        INSERT INTO round_results (room_code, game_number, round_number, deal_id, result_json, created_at)
          SELECT room_code, 1, round_number, deal_id, result_json, created_at FROM round_results_v1;
        DROP TABLE round_results_v1;
      `);
    })();
  }
  db.exec(RESULTS_IMMUTABLE);

  const q = {
    getRoom: db.prepare<[string], { code: string; version: number; names_json: string; bots_json: string; state_json: string; created_at: number; updated_at: number }>(
      'SELECT code, version, names_json, bots_json, state_json, created_at, updated_at FROM rooms WHERE code = ?',
    ),
    roomExists: db.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM rooms WHERE code = ?'),
    insertRoom: db.prepare(
      'INSERT INTO rooms (code, version, names_json, bots_json, state_json, phase, created_at, updated_at) VALUES (@code, @version, @names, @bots, @state, @phase, @now, @now)',
    ),
    updateRoom: db.prepare(
      'UPDATE rooms SET version = @version, names_json = @names, bots_json = @bots, state_json = @state, phase = @phase, updated_at = @now WHERE code = @code AND version = @expected',
    ),
    insertSeat: db.prepare('INSERT INTO seats (room_code, seat, token_hash, created_at) VALUES (?, ?, ?, ?)'),
    getSeatHashes: db.prepare<[string], { seat: number; token_hash: string }>('SELECT seat, token_hash FROM seats WHERE room_code = ?'),
    insertResult: db.prepare('INSERT INTO round_results (room_code, game_number, round_number, deal_id, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    getResults: db.prepare<[string], { result_json: string }>('SELECT result_json FROM round_results WHERE room_code = ? ORDER BY game_number, round_number'),
    getRequest: db.prepare<[string, number, string], { response_json: string }>(
      'SELECT response_json FROM requests WHERE room_code = ? AND seat = ? AND request_id = ?',
    ),
    insertRequest: db.prepare('INSERT INTO requests (room_code, seat, request_id, response_json, created_at) VALUES (?, ?, ?, ?, ?)'),
    pruneRequests: db.prepare('DELETE FROM requests WHERE created_at < ?'),
    pruneRooms: db.prepare('DELETE FROM rooms WHERE updated_at < ?'),
    activeRoomCodes: db.prepare<[], { code: string }>("SELECT code FROM rooms WHERE phase <> 'TOURNAMENT_COMPLETE'"),
  };

  return {
    raw: db,
    transaction: <T>(fn: () => T): T => db.transaction(fn)(),
    loadRoom(code: string): StoredRoom | null {
      const row = q.getRoom.get(code);
      if (!row) return null;
      return {
        code: row.code,
        version: row.version,
        names: JSON.parse(row.names_json),
        bots: JSON.parse(row.bots_json),
        game: JSON.parse(row.state_json),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    },
    roomExists: (code: string) => q.roomExists.get(code)!.n > 0,
    insertRoom(room: StoredRoom) {
      q.insertRoom.run({
        code: room.code,
        version: room.version,
        names: JSON.stringify(room.names),
        bots: JSON.stringify(room.bots),
        state: JSON.stringify(room.game),
        phase: room.game.phase,
        now: room.updatedAt,
      });
    },
    /** Optimistic-concurrency update; throws if the stored version moved. */
    updateRoom(room: StoredRoom, expectedVersion: number) {
      const info = q.updateRoom.run({
        code: room.code,
        version: room.version,
        names: JSON.stringify(room.names),
        bots: JSON.stringify(room.bots),
        state: JSON.stringify(room.game),
        phase: room.game.phase,
        now: room.updatedAt,
        expected: expectedVersion,
      });
      if (info.changes !== 1) throw new Error(`Concurrent modification of room ${room.code}`);
    },
    insertSeat: (code: string, seat: number, tokenHash: string) => q.insertSeat.run(code, seat, tokenHash, Date.now()),
    seatHashes: (code: string) => q.getSeatHashes.all(code),
    insertResult: (code: string, gameNumber: number, result: RoundResult) =>
      q.insertResult.run(code, gameNumber, result.roundNumber, result.dealId, JSON.stringify(result), Date.now()),
    /** Every scored round in the room, across rematches, oldest first. */
    results: (code: string): RoundResult[] => q.getResults.all(code).map((r) => JSON.parse(r.result_json)),
    getRequest(code: string, seat: number, requestId: string): unknown | undefined {
      const row = q.getRequest.get(code, seat, requestId);
      return row ? JSON.parse(row.response_json) : undefined;
    },
    insertRequest: (code: string, seat: number, requestId: string, response: unknown) =>
      q.insertRequest.run(code, seat, requestId, JSON.stringify(response), Date.now()),
    prune(now = Date.now(), requestTtlMs = 24 * 3600_000, roomTtlMs = 30 * 24 * 3600_000) {
      q.pruneRequests.run(now - requestTtlMs);
      q.pruneRooms.run(now - roomTtlMs);
    },
    activeRoomCodes: () => q.activeRoomCodes.all().map((r) => r.code),
    close: () => db.close(),
  };
}
