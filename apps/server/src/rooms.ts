import {
  type ApplyContext,
  type DealPlan,
  type GameAction,
  type GameEvent,
  type GameState,
  type Rng,
  ROUND_COUNT,
  SEAT_COUNT,
  applyAction,
  createGame,
  seatPlayer,
  totalsOf,
  tournamentWinners,
} from '@zhol/engine';
import type { ErrorCode, PlayerView, ProtocolError, PublicState } from '@zhol/protocol';
import type { Db, StoredRoom } from './db.js';
import { generateRoomCode, generateSessionToken, hashToken, tokenMatches } from './security.js';

export type MutationOutcome = { ok: true; events: GameEvent[]; replayed: boolean } | { ok: false; error: ProtocolError };

const ENGINE_MESSAGES: Partial<Record<ErrorCode, string>> = {
  WRONG_PHASE: 'That action is not allowed in the current phase',
  NOT_YOUR_TURN: 'It is not your turn',
  STALE_DEAL: 'Command refers to an earlier deal',
  STALE_TURN: 'Command refers to an earlier turn',
  EMPTY_STOCK: 'The stock is empty',
  EMPTY_DISCARD: 'The previous player has no discard to take',
  TILE_NOT_IN_RACK: 'That tile is not on your rack',
  INVALID_PERMUTATION: 'Rack order must be a complete permutation of your current tiles with unique slots',
  INVALID_CLOSE: 'The remaining 14 tiles must all form legal links',
  TOURNAMENT_COMPLETE: 'The tournament is complete',
  NOT_SEATED: 'You are not seated in this room',
};

export function protocolError(code: ErrorCode, message?: string, details?: Record<string, unknown>): ProtocolError {
  return { code, message: message ?? ENGINE_MESSAGES[code] ?? code, ...(details ? { details } : {}) };
}

/**
 * Owns all room state. Every mutation runs synchronously (better-sqlite3 is
 * synchronous), so mutations for a room are naturally serialized on the
 * event loop: validate → apply → commit one SQLite transaction → update the
 * in-memory cache. Callers broadcast only after a mutation returns ok.
 */
export class RoomManager {
  private cache = new Map<string, StoredRoom>();
  /** socket id controlling each seat, per room. Not persisted: nobody is connected after a restart. */
  private controllers = new Map<string, (string | null)[]>();
  private plans = new Map<string, DealPlan[]>();

  constructor(
    private db: Db,
    private rng: Rng,
    private options: { zholPenalty: number },
  ) {}

  get(code: string): StoredRoom | null {
    const cached = this.cache.get(code);
    if (cached) return cached;
    const loaded = this.db.loadRoom(code);
    if (loaded) this.cache.set(code, loaded);
    return loaded;
  }

  /** Load every unfinished room into memory (called at startup). */
  restoreActiveRooms(): number {
    const codes = this.db.activeRoomCodes();
    for (const code of codes) this.get(code);
    return codes.length;
  }

  cachedRoomCount() {
    return this.cache.size;
  }

  // ---- connections -------------------------------------------------------

  controllerOf(code: string, seat: number): string | null {
    return this.controllers.get(code)?.[seat] ?? null;
  }

  setController(code: string, seat: number, socketId: string | null) {
    const list = this.controllers.get(code) ?? [null, null, null, null];
    list[seat] = socketId;
    this.controllers.set(code, list);
  }

  connected(code: string): boolean[] {
    const list = this.controllers.get(code) ?? [null, null, null, null];
    return list.map((s) => s !== null);
  }

  // ---- seats ---------------------------------------------------------------

  createRoom(nickname: string): { room: StoredRoom; seat: number; token: string } {
    let code = generateRoomCode();
    for (let i = 0; this.get(code) || this.db.roomExists(code); i++) {
      if (i > 20) throw new Error('Could not allocate a room code');
      code = generateRoomCode();
    }
    const seated = seatPlayer(createGame({ zholPenalty: this.options.zholPenalty }), 0);
    if (!seated.ok) throw new Error(seated.code);
    const now = Date.now();
    const room: StoredRoom = { code, version: 1, names: [nickname, null, null, null], game: seated.state, createdAt: now, updatedAt: now };
    const token = generateSessionToken();
    this.db.transaction(() => {
      this.db.insertRoom(room);
      this.db.insertSeat(code, 0, hashToken(token));
    });
    this.cache.set(code, room);
    return { room, seat: 0, token };
  }

  /** Find the seat whose credential matches `token`, or null. */
  seatForToken(code: string, token: string): number | null {
    for (const row of this.db.seatHashes(code)) if (tokenMatches(token, row.token_hash)) return row.seat;
    return null;
  }

  takeSeat(code: string, nickname: string): { ok: true; seat: number; token: string } | { ok: false; error: ProtocolError } {
    const room = this.get(code);
    if (!room) return { ok: false, error: protocolError('ROOM_NOT_FOUND', 'Room not found') };
    if (room.game.phase !== 'LOBBY') return { ok: false, error: protocolError('GAME_IN_PROGRESS', 'The game has already started; new players cannot join') };
    const seat = room.game.seated.findIndex((s) => !s);
    if (seat < 0) return { ok: false, error: protocolError('ROOM_FULL', 'All four seats are taken') };
    if (room.names.some((n) => n?.toLocaleLowerCase('sq') === nickname.toLocaleLowerCase('sq'))) {
      return { ok: false, error: protocolError('NAME_TAKEN', 'Another player in this room already uses that nickname') };
    }
    const r = seatPlayer(room.game, seat);
    if (!r.ok) return { ok: false, error: protocolError(r.code) };
    const token = generateSessionToken();
    const next: StoredRoom = { ...room, version: room.version + 1, names: room.names.map((n, i) => (i === seat ? nickname : n)), game: r.state, updatedAt: Date.now() };
    this.db.transaction(() => {
      this.db.updateRoom(next, room.version);
      this.db.insertSeat(code, seat, hashToken(token));
    });
    this.cache.set(code, next);
    return { ok: true, seat, token };
  }

  // ---- gameplay ------------------------------------------------------------

  /** Test harness only: queue rigged deal plans for a room. */
  queueDealPlan(code: string, plan: DealPlan) {
    const list = this.plans.get(code) ?? [];
    list.push(plan);
    this.plans.set(code, list);
  }

  /**
   * Apply one gameplay action atomically and idempotently.
   * A repeated (seat, requestId) returns the stored outcome without mutating.
   */
  mutate(code: string, seat: number, requestId: string, action: GameAction): MutationOutcome {
    const room = this.get(code);
    if (!room) return { ok: false, error: protocolError('ROOM_NOT_FOUND', 'Room not found') };

    const prior = this.db.getRequest(code, seat, requestId) as { ok: true } | { ok: false; error: ProtocolError } | undefined;
    if (prior) return prior.ok ? { ok: true, events: [], replayed: true } : { ok: false, error: prior.error };

    const ctx: ApplyContext = { rng: this.rng, takeDealPlan: () => this.plans.get(code)?.shift() };
    const result = applyAction(room.game, seat, action, ctx);

    if (!result.ok) {
      const error = protocolError(result.code, undefined, result.details);
      // Record the rejection so a retry of the same request gets the same answer.
      this.db.insertRequest(code, seat, requestId, { ok: false, error });
      return { ok: false, error };
    }

    const next: StoredRoom = { ...room, version: room.version + 1, game: result.state, updatedAt: Date.now() };
    this.db.transaction(() => {
      this.db.updateRoom(next, room.version);
      for (const e of result.events) if (e.type === 'round_scored') this.db.insertResult(code, e.result);
      this.db.insertRequest(code, seat, requestId, { ok: true });
    });
    this.cache.set(code, next);
    return { ok: true, events: result.events, replayed: false };
  }

  // ---- views ---------------------------------------------------------------

  publicState(room: StoredRoom): PublicState {
    const g: GameState = room.game;
    const deal = g.deal;
    const connected = this.connected(room.code);
    const inDeal = g.phase === 'AWAITING_DRAW' || g.phase === 'AWAITING_DISCARD';
    const totals = totalsOf(g);
    return {
      code: room.code,
      version: room.version,
      phase: g.phase,
      roundNumber: g.roundNumber,
      totalRounds: ROUND_COUNT,
      seats: Array.from({ length: SEAT_COUNT }, (_, seat) => ({
        seat,
        name: room.names[seat] ?? null,
        connected: connected[seat]!,
        ready: g.ready[seat]!,
        rackCount: deal ? deal.racks[seat]!.length : 0,
        discardTop: deal ? (deal.discards[seat]!.at(-1) ?? null) : null,
        discardCount: deal ? deal.discards[seat]!.length : 0,
      })),
      activeSeat: inDeal && deal ? deal.active : null,
      starter: deal ? deal.starter : null,
      dealId: deal ? deal.dealId : null,
      turnId: deal ? deal.turnId : null,
      indicator: deal ? deal.indicator : null,
      stockCount: deal ? deal.stock.length : 0,
      blockedDeals: g.blockedDeals,
      results: g.results,
      totals,
      winners: g.phase === 'TOURNAMENT_COMPLETE' ? tournamentWinners(totals) : null,
      lastEvent: g.lastEvent,
    };
  }

  viewFor(room: StoredRoom, seat: number): PlayerView {
    return {
      you: { seat, rack: room.game.deal ? room.game.deal.racks[seat]!.map((e) => ({ ...e })) : [] },
      state: this.publicState(room),
    };
  }
}
