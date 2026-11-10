import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { Server, type Socket } from 'socket.io';
import { type DealPlan, type GameAction, type GameEvent, type Rng, assertValidDealPlan } from '@zhol/engine';
import {
  type Ack,
  type ClientToServerEvents,
  type ProtocolError,
  type RoomJoined,
  type ServerToClientEvents,
  MAX_PAYLOAD_BYTES,
  addBotPayload,
  createRoomPayload,
  declareWinPayload,
  describeZodError,
  discardTilePayload,
  drawTilePayload,
  invitePathFor,
  joinRoomPayload,
  playerBackPayload,
  playerReadyPayload,
  removeBotPayload,
  sortRackPayload,
  startGamePayload,
  z,
} from '@zhol/protocol';
import type { ServerConfig } from './config.js';
import { type Db, openDatabase } from './db.js';
import { type AutoTiming, RoomManager, hostOf, protocolError } from './rooms.js';
import { RateLimiter, TtlCache, generateSessionToken, secureRng } from './security.js';

interface SocketData {
  code?: string;
  seat?: number;
  ip: string;
}

type ZholSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type ZholServerIo = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

export interface ZholServerOptions {
  config: ServerConfig;
  /** Override the secure RNG (tests only). */
  rng?: Rng;
  /** How long bots "think" before each move, in ms [min, max]. Tests use small values. */
  botDelayMs?: { ready: [number, number]; draw: [number, number]; discard: [number, number] };
  /** Override the waiting times for away players, in ms (tests only; normally from the config). */
  autoplayMs?: Partial<AutoTiming>;
}

const DEFAULT_BOT_DELAY = { ready: [700, 1200], draw: [650, 1100], discard: [900, 1700] } as const;

export interface ZholServer {
  httpServer: http.Server;
  io: ZholServerIo;
  rooms: RoomManager;
  db: Db;
  listen(port?: number): Promise<number>;
  close(): Promise<void>;
  /** Present only when the test harness is enabled. Never reachable from production clients. */
  testApi?: { queueDealPlan(code: string, plan: DealPlan): void };
}

function log(config: ServerConfig, event: string, fields: Record<string, unknown> = {}) {
  // Never log payloads: they can contain session credentials.
  if (config.logRequests) console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
}

export function createZholServer({ config, rng = secureRng, botDelayMs = DEFAULT_BOT_DELAY as ZholServerOptions['botDelayMs'], autoplayMs }: ZholServerOptions): ZholServer {
  const db = openDatabase(config.databasePath);
  const timing: AutoTiming = { turnMs: config.turnSeconds * 1000, awayMs: config.awaySeconds * 1000, fastMs: 2500, ...autoplayMs };
  const rooms = new RoomManager(db, rng, { zholPenalty: config.zholPenalty, timing });
  const restored = rooms.restoreActiveRooms();
  log(config, 'rooms_restored', { count: restored });
  const restoredCodes = db.activeRoomCodes();

  const allowed = new Set(config.allowedOrigins);
  const isAllowedOrigin = (origin: string | undefined) => !!origin && allowed.has(origin.replace(/\/$/, ''));

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.get('/health', (_req, res) => {
    let dbOk = true;
    try {
      db.raw.prepare('SELECT 1').get();
    } catch {
      dbOk = false;
    }
    res.status(dbOk ? 200 : 503).json({ ok: dbOk, uptimeSeconds: Math.round(process.uptime()), activeRooms: rooms.cachedRoomCount() });
  });

  let testApi: ZholServer['testApi'];
  if (config.testHarness) {
    testApi = {
      queueDealPlan(code, plan) {
        assertValidDealPlan(plan);
        rooms.queueDealPlan(code, plan);
      },
    };
    // HTTP hook for the browser smoke test. Registered only when NODE_ENV=test and ZHOL_TEST_HARNESS=1.
    app.post('/__test/deal-plan/:code', express.json({ limit: '16kb' }), (req, res) => {
      try {
        testApi!.queueDealPlan(String(req.params.code), req.body as DealPlan);
        res.json({ ok: true });
      } catch (e) {
        res.status(400).json({ ok: false, error: (e as Error).message });
      }
    });
    log(config, 'test_harness_enabled');
  }

  // Optional single-service mode: serve the built web app with an SPA fallback for invite routes.
  if (config.webDistDir) {
    const indexFile = path.join(config.webDistDir, 'index.html');
    if (!fs.existsSync(indexFile)) throw new Error(`WEB_DIST_DIR has no index.html: ${config.webDistDir}`);
    app.use(
      express.static(config.webDistDir, {
        index: false,
        setHeaders: (res, file) => {
          if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        },
      }),
    );
    app.get(/^\/(?!socket\.io\/|health$|__test\/).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(indexFile);
    });
    log(config, 'serving_web', { dir: config.webDistDir });
  }

  const httpServer = http.createServer(app);
  const io: ZholServerIo = new Server(httpServer, {
    cors: { origin: (origin, cb) => cb(null, isAllowedOrigin(origin)), methods: ['GET', 'POST'] },
    allowRequest: (req, cb) => cb(isAllowedOrigin(req.headers.origin) ? null : 'Origin not allowed', isAllowedOrigin(req.headers.origin)),
    maxHttpBufferSize: MAX_PAYLOAD_BYTES,
    pingInterval: 20_000,
    pingTimeout: 20_000,
  });

  const createLimiter = new RateLimiter(5, 5 / 60); // 5 burst, 5 per minute per IP
  const joinLimiter = new RateLimiter(20, 20 / 60); // 20 burst, 20 per minute per IP
  const actionLimiter = new RateLimiter(60, 20); // per socket: 60 burst, 20/s sustained
  const entryCache = new TtlCache<{ ack: Ack<RoomJoined>; code: string; seat: number }>(2 * 60_000);

  const roomChannel = (code: string) => `room:${code}`;

  // ---- automatic moves: bots, and humans who are away or out of time ----------------------
  // One pending timer per room, set for whichever job is due first. It is recomputed whenever
  // the room changes; what to play is decided only when the timer fires.
  const autoTimers = new Map<string, NodeJS.Timeout>();
  /** A bot's "thinking" time, kept for as long as the same move is pending. */
  const botDue = new Map<string, { key: string; dueAt: number }>();
  let closing = false;
  function scheduleAuto(code: string) {
    if (closing) return;
    clearTimeout(autoTimers.get(code));
    autoTimers.delete(code);
    const now = Date.now();
    let next: { key: string; dueAt: number } | null = null;
    let botPending = false;
    for (const job of rooms.autoJobs(code, now)) {
      let dueAt = job.dueAt;
      if (dueAt === null) {
        botPending = true;
        const kept = botDue.get(code);
        if (kept?.key === job.key) dueAt = kept.dueAt;
        else {
          const [min, max] = botDelayMs![job.kind];
          dueAt = now + min + Math.floor(Math.random() * (max - min + 1));
          botDue.set(code, { key: job.key, dueAt });
        }
      }
      if (!next || dueAt < next.dueAt) next = { key: job.key, dueAt };
    }
    if (!botPending) botDue.delete(code);
    if (!next) return;
    const target = next;
    const timer = setTimeout(() => {
      autoTimers.delete(code);
      try {
        const at = Date.now();
        const job = rooms.autoJobs(code, at).find((j) => j.key === target.key);
        // The game moved on, or the player came back and has their full time again.
        if (!job || (job.dueAt !== null && job.dueAt > at + 25)) return scheduleAuto(code);
        if (job.bot) botDue.delete(code);
        const outcome = rooms.mutate(code, job.seat, `auto_${generateSessionToken().slice(0, 24)}`, job.resolve());
        if (outcome.ok) {
          if (!job.bot) {
            // From here on the computer keeps their seat moving until they act again.
            if (job.kind !== 'ready') rooms.setAway(code, job.seat, true);
            log(config, 'played_for_away_player', { code, seat: job.seat, kind: job.kind });
          }
          broadcast(code, outcome.events);
        } else {
          log(config, 'auto_move_rejected', { code, seat: job.seat, error: outcome.error.code });
          const retry = setTimeout(() => {
            if (autoTimers.get(code) === retry) autoTimers.delete(code);
            scheduleAuto(code);
          }, 1000);
          retry.unref?.();
          autoTimers.set(code, retry);
        }
      } catch (e) {
        log(config, 'auto_move_error', { code, message: (e as Error).message });
      }
    }, Math.max(0, target.dueAt - now));
    timer.unref?.();
    autoTimers.set(code, timer);
  }

  function broadcast(code: string, events: GameEvent[] = []) {
    const room = rooms.get(code);
    if (!room) return;
    for (let seat = 0; seat < 4; seat++) {
      const sid = rooms.controllerOf(code, seat);
      if (sid) io.to(sid).emit('state_update', rooms.viewFor(room, seat));
    }
    for (const e of events) {
      if (e.type === 'round_scored') io.to(roomChannel(code)).emit('round_result', { result: e.result });
      if (e.type === 'tournament_complete') {
        io.to(roomChannel(code)).emit('tournament_result', { results: room.game.results, totals: e.totals, winners: e.winners });
      }
    }
    scheduleAuto(code);
  }

  function sendSnapshot(socket: ZholSocket) {
    const { code, seat } = socket.data;
    if (code === undefined || seat === undefined) return;
    const room = rooms.get(code);
    if (room) socket.emit('state_update', rooms.viewFor(room, seat));
  }

  /** Bind a socket to a seat; any previous controller of that seat is disconnected. */
  function bind(socket: ZholSocket, code: string, seat: number) {
    if (socket.data.code && (socket.data.code !== code || socket.data.seat !== seat)) unbind(socket, true);
    const previous = rooms.controllerOf(code, seat);
    if (previous && previous !== socket.id) {
      const old = io.sockets.sockets.get(previous) as ZholSocket | undefined;
      if (old) {
        old.data.code = undefined;
        old.data.seat = undefined;
        old.leave(roomChannel(code));
        old.emit('session_replaced');
        setTimeout(() => old.disconnect(true), 50);
      }
      log(config, 'seat_replaced', { code, seat });
    }
    rooms.setController(code, seat, socket.id);
    socket.data.code = code;
    socket.data.seat = seat;
    void socket.join(roomChannel(code));
  }

  function unbind(socket: ZholSocket, notify: boolean) {
    const { code, seat } = socket.data;
    if (code === undefined || seat === undefined) return;
    if (rooms.controllerOf(code, seat) === socket.id) rooms.setController(code, seat, null);
    void socket.leave(roomChannel(code));
    socket.data.code = undefined;
    socket.data.seat = undefined;
    if (notify) broadcast(code);
  }

  const fail = (code: ProtocolError['code'], message?: string, details?: Record<string, unknown>) => ({
    ok: false as const,
    error: protocolError(code, message, details),
  });

  function parse<T extends z.ZodTypeAny>(schema: T, raw: unknown): { ok: true; data: z.output<T> } | ReturnType<typeof fail> {
    const r = schema.safeParse(raw);
    return r.success ? { ok: true, data: r.data } : fail('INVALID_PAYLOAD', describeZodError(r.error));
  }

  function safeAck<T>(ack: unknown, value: Ack<T>) {
    if (typeof ack === 'function') (ack as (v: Ack<T>) => void)(value);
  }

  function joinedAck(code: string, seat: number, token: string | null, reclaimed: boolean): Ack<RoomJoined> {
    const invitePath = invitePathFor(code);
    return {
      ok: true,
      data: { code, seat, sessionToken: token, invitePath, inviteUrl: config.publicWebUrl ? `${config.publicWebUrl}${invitePath}` : null, reclaimed },
    };
  }

  io.on('connection', (rawSocket) => {
    const socket = rawSocket as ZholSocket;
    const fwd = config.trustProxy ? String(socket.handshake.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() : '';
    socket.data.ip = fwd || socket.handshake.address;

    const guard = (handler: (raw: unknown, ack: unknown) => void) => (raw: unknown, ack: unknown) => {
      if (typeof ack !== 'function') return; // every command requires an acknowledgment callback
      if (!actionLimiter.take(socket.id)) return safeAck(ack, fail('RATE_LIMITED', 'Too many requests; slow down'));
      try {
        handler(raw, ack);
      } catch (e) {
        log(config, 'internal_error', { message: (e as Error).message });
        safeAck(ack, fail('INTERNAL_ERROR', 'Unexpected server error'));
      }
    };

    socket.on(
      'create_room',
      guard((raw, ack) => {
        const p = parse(createRoomPayload, raw);
        if (!p.ok) return safeAck(ack, p);
        const cached = entryCache.get(`create:${p.data.requestId}`);
        if (cached) {
          bind(socket, cached.code, cached.seat);
          safeAck(ack, cached.ack);
          return broadcast(cached.code);
        }
        if (!createLimiter.take(socket.data.ip)) return safeAck(ack, fail('RATE_LIMITED', 'Too many rooms created; try again in a minute'));
        const { room, seat, token } = rooms.createRoom(p.data.nickname, p.data.mode);
        const result = joinedAck(room.code, seat, token, false);
        entryCache.set(`create:${p.data.requestId}`, { ack: result, code: room.code, seat });
        bind(socket, room.code, seat);
        log(config, 'room_created', { code: room.code, mode: room.game.mode });
        safeAck(ack, result);
        broadcast(room.code);
      }),
    );

    socket.on(
      'join_room',
      guard((raw, ack) => {
        const p = parse(joinRoomPayload, raw);
        if (!p.ok) return safeAck(ack, p);
        const { code, requestId } = p.data;
        const cached = entryCache.get(`join:${requestId}`);
        if (cached && cached.code === code) {
          bind(socket, cached.code, cached.seat);
          safeAck(ack, cached.ack);
          return broadcast(code);
        }
        if (!joinLimiter.take(socket.data.ip)) return safeAck(ack, fail('RATE_LIMITED', 'Too many join attempts; try again in a minute'));
        const room = rooms.get(code);
        if (!room) return safeAck(ack, fail('ROOM_NOT_FOUND', 'Room not found'));

        if (p.data.sessionToken) {
          const seat = rooms.seatForToken(code, p.data.sessionToken);
          if (seat === null) return safeAck(ack, fail('INVALID_SESSION', 'Session credential does not match a seat in this room'));
          const result = joinedAck(code, seat, null, true);
          entryCache.set(`join:${requestId}`, { ack: result, code, seat });
          bind(socket, code, seat);
          log(config, 'seat_reclaimed', { code, seat });
          safeAck(ack, result);
          return broadcast(code);
        }

        const taken = rooms.takeSeat(code, p.data.nickname!);
        if (!taken.ok) return safeAck(ack, taken);
        const result = joinedAck(code, taken.seat, taken.token, false);
        entryCache.set(`join:${requestId}`, { ack: result, code, seat: taken.seat });
        bind(socket, code, taken.seat);
        log(config, 'seat_taken', { code, seat: taken.seat });
        safeAck(ack, result);
        broadcast(code);
      }),
    );

    /** Common path for authenticated gameplay commands. */
    const gameplay = <T extends z.ZodTypeAny>(schema: T, toAction: (d: z.output<T>) => GameAction) =>
      guard((raw, ack) => {
        const p = parse(schema, raw);
        if (!p.ok) return safeAck(ack, p);
        const { code, seat } = socket.data;
        if (code === undefined || seat === undefined) return safeAck(ack, fail('NOT_IN_ROOM', 'Join a room first'));
        if (rooms.controllerOf(code, seat) !== socket.id) {
          return safeAck(ack, fail('SESSION_REPLACED', 'This seat is controlled by another connection'));
        }
        const data = p.data as z.output<T> & { requestId: string };
        // Any command from a player takes their seat back from the computer.
        const cameBack = rooms.setAway(code, seat, false);
        const outcome = rooms.mutate(code, seat, data.requestId, toAction(data));
        if (!outcome.ok) {
          safeAck(ack, outcome);
          if (cameBack) broadcast(code);
          // Help a client that acted on stale state catch up.
          if (outcome.error.code === 'STALE_TURN' || outcome.error.code === 'STALE_DEAL' || outcome.error.code === 'WRONG_PHASE') sendSnapshot(socket);
          return;
        }
        safeAck(ack, { ok: true, data: {} });
        if (outcome.replayed) return cameBack ? broadcast(code) : sendSnapshot(socket);
        broadcast(code, outcome.events);
      });

    socket.on(
      'player_back',
      guard((raw, ack) => {
        const p = parse(playerBackPayload, raw);
        if (!p.ok) return safeAck(ack, p);
        const { code, seat } = socket.data;
        if (code === undefined || seat === undefined) return safeAck(ack, fail('NOT_IN_ROOM', 'Join a room first'));
        if (rooms.controllerOf(code, seat) !== socket.id) return safeAck(ack, fail('SESSION_REPLACED', 'This seat is controlled by another connection'));
        rooms.setAway(code, seat, false);
        safeAck(ack, { ok: true, data: {} });
        broadcast(code);
      }),
    );

    socket.on('player_ready', gameplay(playerReadyPayload, (d) => ({ type: 'ready', ready: d.ready })));

    /** Host-only lobby commands. */
    const hostCommand = <T extends z.ZodTypeAny>(schema: T, run: (code: string, seat: number, d: z.output<T>) => { ok: true } | { ok: false; error: ProtocolError }) =>
      guard((raw, ack) => {
        const p = parse(schema, raw);
        if (!p.ok) return safeAck(ack, p);
        const { code, seat } = socket.data;
        if (code === undefined || seat === undefined) return safeAck(ack, fail('NOT_IN_ROOM', 'Join a room first'));
        if (rooms.controllerOf(code, seat) !== socket.id) return safeAck(ack, fail('SESSION_REPLACED', 'This seat is controlled by another connection'));
        const room = rooms.get(code);
        if (!room) return safeAck(ack, fail('ROOM_NOT_FOUND', 'Room not found'));
        if (hostOf(room) !== seat) return safeAck(ack, fail('NOT_HOST', 'Only the host can do that'));
        const out = run(code, seat, p.data);
        if (!out.ok) return safeAck(ack, out);
        safeAck(ack, { ok: true, data: {} });
        broadcast(code, 'events' in out ? (out as { events: GameEvent[] }).events : []);
      });

    socket.on('add_bot', hostCommand(addBotPayload, (code, seat, d) => rooms.addBot(code, seat, d.seat)));
    socket.on('remove_bot', hostCommand(removeBotPayload, (code, seat, d) => rooms.removeBot(code, seat, d.seat)));
    socket.on(
      'start_game',
      hostCommand(startGamePayload, (code, seat, d) => {
        const out = rooms.mutate(code, seat, d.requestId, { type: 'start' });
        return out.ok ? { ok: true, events: out.events } : out;
      }),
    );
    socket.on('draw_tile', gameplay(drawTilePayload, (d) => ({ type: 'draw', source: d.source, dealId: d.dealId, turnId: d.turnId })));
    socket.on('discard_tile', gameplay(discardTilePayload, (d) => ({ type: 'discard', tileId: d.tileId, dealId: d.dealId, turnId: d.turnId })));
    socket.on('declare_win', gameplay(declareWinPayload, (d) => ({ type: 'declare_win', tileId: d.tileId, dealId: d.dealId, turnId: d.turnId })));
    socket.on('sort_rack', gameplay(sortRackPayload, (d) => ({ type: 'sort', dealId: d.dealId, placements: d.placements })));

    socket.on('disconnect', () => unbind(socket, true));
  });

  // Bots in rooms restored after a restart pick up where they left off.
  for (const code of restoredCodes) scheduleAuto(code);

  const pruneTimer = setInterval(() => {
    try {
      db.prune();
    } catch (e) {
      log(config, 'prune_failed', { message: (e as Error).message });
    }
  }, 60 * 60_000);
  pruneTimer.unref();

  return {
    httpServer,
    io,
    rooms,
    db,
    testApi,
    listen(port = config.port) {
      return new Promise((resolve) => {
        httpServer.listen(port, config.host, () => {
          const addr = httpServer.address();
          resolve(typeof addr === 'object' && addr ? addr.port : port);
        });
      });
    },
    async close() {
      closing = true;
      clearInterval(pruneTimer);
      for (const t of autoTimers.values()) clearTimeout(t);
      autoTimers.clear();
      await new Promise<void>((resolve) => io.close(() => resolve()));
      if (httpServer.listening) await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      db.close();
    },
  };
}

