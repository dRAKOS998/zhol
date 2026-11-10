import {
  type ApplyContext,
  type DealPlan,
  type GameAction,
  type GameEvent,
  type GameMode,
  type GameState,
  type Rng,
  type TileId,
  MIN_PLAYERS,
  SEAT_COUNT,
  applyAction,
  chooseBotMove,
  createGame,
  gameNumberOf,
  gameWinners,
  modeOf,
  playersOf,
  previousSeat,
  roundCountOf,
  seatPlayer,
  seriesWinsOf,
  totalsOf,
  unseatPlayer,
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
  NOT_ENOUGH_PLAYERS: 'At least two players are needed to start',
  NOT_ALL_READY: 'Every seated player must be ready before the start',
};

/** Names for computer players, used in order and skipping any a human already took. */
export const BOT_NAMES = ['Bot Arta', 'Bot Drini', 'Bot Era', 'Bot Leka', 'Bot Teuta', 'Bot Genti'];

/** The room's host: the lowest seat held by a human (the creator, normally seat 0). */
export function hostOf(room: Pick<StoredRoom, 'names' | 'bots'>): number {
  const i = room.names.findIndex((n, seat) => n !== null && !room.bots[seat]);
  return i < 0 ? 0 : i;
}

/**
 * A move the server should make by itself: a bot's, or a human's whose time ran out.
 * `dueAt` is null for bots (the caller picks a "thinking" delay) and a timestamp for humans.
 */
export interface AutoJob {
  seat: number;
  kind: 'ready' | 'draw' | 'discard';
  bot: boolean;
  dueAt: number | null;
  /** Identifies the moment this job belongs to; it changes whenever the game moves on. */
  key: string;
  /** Decide the move (runs the solver, so only call it when the job fires). */
  resolve(): GameAction;
}

/** How long humans are waited for, in ms. 0 switches a limit off. */
export interface AutoTiming {
  /** A connected player's time per move. */
  turnMs: number;
  /** How long a disconnected player is waited for. */
  awayMs: number;
  /** Pause before the computer moves for a player it has already taken over. */
  fastMs: number;
}

interface Presence {
  /** When each seat lost its connection (null while connected). */
  disconnectedAt: (number | null)[];
  /** Seats the computer has taken over until their player acts again. */
  away: boolean[];
  /** The moment the current step of the game began, and the step it was measured for. */
  clockKey: string;
  clockAt: number;
}

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
  /** Not persisted: after a restart everyone counts as having just disconnected. */
  private presence = new Map<string, Presence>();
  private bootAt = Date.now();
  private timing: AutoTiming;

  constructor(
    private db: Db,
    private rng: Rng,
    private options: { zholPenalty: number; timing?: AutoTiming },
  ) {
    this.timing = options.timing ?? { turnMs: 0, awayMs: 0, fastMs: 2500 };
  }

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
    const p = this.presenceOf(code);
    if (socketId) {
      p.disconnectedAt[seat] = null;
      p.away[seat] = false; // whoever (re)connects plays for themselves again
    } else if (list[seat] !== null || p.disconnectedAt[seat] === null) {
      p.disconnectedAt[seat] = Date.now();
    }
    list[seat] = socketId;
    this.controllers.set(code, list);
  }

  private presenceOf(code: string): Presence {
    let p = this.presence.get(code);
    if (!p) {
      const t = this.bootAt;
      p = { disconnectedAt: [t, t, t, t], away: [false, false, false, false], clockKey: '', clockAt: 0 };
      this.presence.set(code, p);
    }
    return p;
  }

  /** Mark or clear "the computer is playing for this seat". Returns true when the flag changed. */
  setAway(code: string, seat: number, away: boolean): boolean {
    const p = this.presenceOf(code);
    if (p.away[seat] === away) return false;
    p.away[seat] = away;
    return true;
  }

  /** When the current step (this turn, or this wait for "ready") began. */
  private clock(code: string, g: GameState, now: number): { key: string; at: number } {
    const p = this.presenceOf(code);
    const key = `${gameNumberOf(g)}|${g.phase}|${g.deal?.dealId ?? '-'}|${g.deal?.turnId ?? 0}|${g.results.length}`;
    if (p.clockKey !== key) {
      p.clockKey = key;
      p.clockAt = now;
    }
    return { key, at: p.clockAt };
  }

  private humans(room: StoredRoom): number[] {
    return [0, 1, 2, 3].filter((s) => room.game.seated[s] && !room.bots[s]);
  }

  /**
   * When the computer should move for a human seat, or null to keep waiting.
   * `idle` says whether a connected player can run out of time at this step.
   */
  private humanDue(code: string, seat: number, clockAt: number, idle: boolean): number | null {
    const p = this.presenceOf(code);
    const t = this.timing;
    if (p.away[seat]) return clockAt + t.fastMs;
    if (this.controllerOf(code, seat) === null) {
      return t.awayMs > 0 ? Math.max(clockAt + t.fastMs, (p.disconnectedAt[seat] ?? clockAt) + t.awayMs) : null;
    }
    return idle && t.turnMs > 0 ? clockAt + t.turnMs : null;
  }

  connected(code: string): boolean[] {
    const list = this.controllers.get(code) ?? [null, null, null, null];
    const room = this.cache.get(code);
    return list.map((s, seat) => s !== null || !!room?.bots[seat]);
  }

  // ---- seats ---------------------------------------------------------------

  createRoom(nickname: string, mode: GameMode = 'klasik'): { room: StoredRoom; seat: number; token: string } {
    let code = generateRoomCode();
    for (let i = 0; this.get(code) || this.db.roomExists(code); i++) {
      if (i > 20) throw new Error('Could not allocate a room code');
      code = generateRoomCode();
    }
    const seated = seatPlayer(createGame({ zholPenalty: this.options.zholPenalty }, mode), 0);
    if (!seated.ok) throw new Error(seated.code);
    const now = Date.now();
    const room: StoredRoom = { code, version: 1, names: [nickname, null, null, null], bots: [false, false, false, false], game: seated.state, createdAt: now, updatedAt: now };
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

  // ---- bots ----------------------------------------------------------------

  private lobbyEdit(code: string, bySeat: number): { ok: true; room: StoredRoom } | { ok: false; error: ProtocolError } {
    const room = this.get(code);
    if (!room) return { ok: false, error: protocolError('ROOM_NOT_FOUND', 'Room not found') };
    if (room.game.phase !== 'LOBBY') return { ok: false, error: protocolError('GAME_IN_PROGRESS', 'Bots can only change before the game starts') };
    if (hostOf(room) !== bySeat) return { ok: false, error: protocolError('NOT_HOST', 'Only the host can do that') };
    return { ok: true, room };
  }

  private save(prev: StoredRoom, next: StoredRoom) {
    this.db.transaction(() => this.db.updateRoom(next, prev.version));
    this.cache.set(next.code, next);
  }

  /** Seat a computer player (ready at once) in `seat`, or the first free seat. */
  addBot(code: string, bySeat: number, seat?: number): { ok: true; seat: number } | { ok: false; error: ProtocolError } {
    const e = this.lobbyEdit(code, bySeat);
    if (!e.ok) return e;
    const room = e.room;
    const target = seat ?? room.game.seated.findIndex((s) => !s);
    if (target < 0) return { ok: false, error: protocolError('ROOM_FULL', 'All four seats are taken') };
    const seated = seatPlayer(room.game, target);
    if (!seated.ok) return { ok: false, error: protocolError(seated.code) };
    const ready = applyAction(seated.state, target, { type: 'ready', ready: true }, { rng: this.rng });
    if (!ready.ok) return { ok: false, error: protocolError(ready.code) };
    const taken = new Set(room.names.filter(Boolean).map((n) => n!.toLocaleLowerCase('sq')));
    const name = BOT_NAMES.find((n) => !taken.has(n.toLocaleLowerCase('sq'))) ?? `Bot ${target + 1}`;
    const next: StoredRoom = {
      ...room,
      version: room.version + 1,
      names: room.names.map((n, i) => (i === target ? name : n)),
      bots: room.bots.map((b, i) => (i === target ? true : b)),
      game: ready.state,
      updatedAt: Date.now(),
    };
    this.save(room, next);
    return { ok: true, seat: target };
  }

  removeBot(code: string, bySeat: number, seat: number): { ok: true } | { ok: false; error: ProtocolError } {
    const e = this.lobbyEdit(code, bySeat);
    if (!e.ok) return e;
    const room = e.room;
    if (!room.bots[seat]) return { ok: false, error: protocolError('INVALID_SEAT', 'That seat is not a bot') };
    const r = unseatPlayer(room.game, seat);
    if (!r.ok) return { ok: false, error: protocolError(r.code) };
    const next: StoredRoom = {
      ...room,
      version: room.version + 1,
      names: room.names.map((n, i) => (i === seat ? null : n)),
      bots: room.bots.map((b, i) => (i === seat ? false : b)),
      game: r.state,
      updatedAt: Date.now(),
    };
    this.save(room, next);
    return { ok: true };
  }

  /**
   * Everything the server may have to do by itself in this room right now: at most one bot move,
   * plus a move for each human who is away or out of time. Humans are only ever played for while
   * at least one person is at the table; an abandoned room simply waits.
   */
  autoJobs(code: string, now = Date.now()): AutoJob[] {
    const room = this.get(code);
    if (!room) return [];
    const g = room.game;
    const { key, at } = this.clock(code, g, now);
    const someoneHere = this.humans(room).some((s) => this.controllerOf(code, s) !== null);
    const jobs: AutoJob[] = [];
    let botQueued = false;
    const push = (seat: number, kind: AutoJob['kind'], idle: boolean, resolve: () => GameAction) => {
      if (room.bots[seat]) {
        if (!botQueued) jobs.push({ seat, kind, bot: true, dueAt: null, key: `${key}|${seat}`, resolve });
        botQueued = true;
      } else if (someoneHere) {
        const dueAt = this.humanDue(code, seat, at, idle);
        if (dueAt !== null) jobs.push({ seat, kind, bot: false, dueAt, key: `${key}|${seat}`, resolve });
      }
    };
    const ready = (): GameAction => ({ type: 'ready', ready: true });

    if (g.phase === 'LOBBY') {
      for (const seat of [0, 1, 2, 3]) if (room.bots[seat] && g.seated[seat] && !g.ready[seat]) push(seat, 'ready', false, ready);
      return jobs;
    }
    if (g.phase === 'ROUND_RESULT') {
      for (const seat of playersOf(g)) if (!g.ready[seat]) push(seat, 'ready', true, ready);
      return jobs;
    }
    if (g.phase === 'TOURNAMENT_COMPLETE') {
      // A rematch is a choice: nothing happens until a person asks for one, and nobody who is
      // sitting at the table is signed up by the clock.
      const players = playersOf(g);
      if (!players.some((p) => !room.bots[p] && g.ready[p])) return jobs;
      for (const seat of players) if (!g.ready[seat]) push(seat, 'ready', false, ready);
      return jobs;
    }
    const deal = g.deal;
    if (!deal) return jobs;
    const seat = deal.active;
    push(seat, g.phase === 'AWAITING_DRAW' ? 'draw' : 'discard', true, () => {
      const prev = previousSeat(seat, playersOf(g));
      const move = chooseBotMove({
        phase: g.phase as 'AWAITING_DRAW' | 'AWAITING_DISCARD',
        rack: deal.racks[seat]!.map((e) => e.id),
        previousDiscard: (deal.discards[prev]!.at(-1) ?? null) as TileId | null,
        config: g.config,
      });
      const base = { dealId: deal.dealId, turnId: deal.turnId };
      if (move.type === 'draw') return { type: 'draw', source: move.source, ...base };
      return { type: move.type, tileId: move.tileId, ...base };
    });
    return jobs;
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
      // Scored before any rematch can begin, so the round belongs to the game the room was in.
      for (const e of result.events) if (e.type === 'round_scored') this.db.insertResult(code, gameNumberOf(room.game), e.result);
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
    const players = g.players ?? (g.phase === 'LOBBY' ? g.seated.flatMap((x, i) => (x ? [i] : [])) : playersOf(g));
    const presence = this.presenceOf(room.code);
    let turnEndsInMs: number | null = null;
    if (inDeal && deal && !room.bots[deal.active] && this.humans(room).some((s) => connected[s])) {
      const now = Date.now();
      const due = this.humanDue(room.code, deal.active, this.clock(room.code, g, now).at, true);
      if (due !== null) turnEndsInMs = Math.max(0, due - now);
    }
    return {
      code: room.code,
      version: room.version,
      phase: g.phase,
      mode: modeOf(g),
      roundNumber: g.roundNumber,
      totalRounds: roundCountOf(g),
      host: hostOf(room),
      players,
      minPlayers: MIN_PLAYERS,
      seats: Array.from({ length: SEAT_COUNT }, (_, seat) => ({
        seat,
        name: room.names[seat] ?? null,
        bot: !!room.bots[seat],
        connected: connected[seat]!,
        away: !room.bots[seat] && presence.away[seat]!,
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
      winners: g.phase === 'TOURNAMENT_COMPLETE' ? gameWinners(g) : null,
      lastEvent: g.lastEvent,
      gameNumber: gameNumberOf(g),
      seriesWins: seriesWinsOf(g),
      turnEndsInMs,
    };
  }

  viewFor(room: StoredRoom, seat: number): PlayerView {
    return {
      you: { seat, rack: room.game.deal ? room.game.deal.racks[seat]!.map((e) => ({ ...e })) : [] },
      state: this.publicState(room),
    };
  }
}
