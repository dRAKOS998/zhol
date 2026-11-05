/**
 * Shared Socket.IO contract for Zhol: event names, runtime payload validation,
 * error codes, acknowledgments, and the public/private state shapes.
 */
import { z } from 'zod';
import {
  type DrawSource,
  type EngineErrorCode,
  type GameEvent,
  type Phase,
  type RackEntry,
  type RoundResult,
  type TileId,
  RACK_SLOTS,
  isValidTileId,
} from '@zhol/engine';

export type { DrawSource, GameEvent, Phase, RackEntry, RoundResult, TileId };

// ---------------------------------------------------------------------------
// Limits & formats
// ---------------------------------------------------------------------------

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 8;
export const NICKNAME_MAX = 20;
export const MAX_PAYLOAD_BYTES = 8 * 1024;

export const roomCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`), 'Invalid room code');

export const nicknameSchema = z
  .string()
  .transform((s) => s.normalize('NFC').replace(/\s+/g, ' ').trim())
  .pipe(
    z
      .string()
      .min(1, 'Nickname is required')
      .max(NICKNAME_MAX, `Nickname must be at most ${NICKNAME_MAX} characters`)
      // Letters, marks, digits, space and a few punctuation marks; no control or markup characters.
      .regex(/^[\p{L}\p{M}\p{N} ._'-]+$/u, 'Nickname contains unsupported characters'),
  );

export const requestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'Invalid requestId');
export const sessionTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/, 'Invalid session token');
export const tileIdSchema = z.string().refine(isValidTileId, 'Invalid tile id');
export const dealIdSchema = z.string().regex(/^d\d{1,9}$/, 'Invalid dealId');
export const turnIdSchema = z.number().int().min(0).max(1_000_000);

// ---------------------------------------------------------------------------
// Client → server payloads
// ---------------------------------------------------------------------------

export const createRoomPayload = z.object({ requestId: requestIdSchema, nickname: nicknameSchema }).strict();

export const joinRoomPayload = z
  .object({
    requestId: requestIdSchema,
    code: roomCodeSchema,
    nickname: nicknameSchema.optional(),
    sessionToken: sessionTokenSchema.optional(),
  })
  .strict()
  .refine((p) => p.nickname !== undefined || p.sessionToken !== undefined, {
    message: 'Provide a nickname to take a seat or a session token to reclaim one',
  });

export const playerReadyPayload = z.object({ requestId: requestIdSchema, ready: z.boolean() }).strict();

export const drawTilePayload = z
  .object({
    requestId: requestIdSchema,
    dealId: dealIdSchema,
    turnId: turnIdSchema,
    source: z.enum(['stock', 'previous_discard']),
  })
  .strict();

export const discardTilePayload = z
  .object({ requestId: requestIdSchema, dealId: dealIdSchema, turnId: turnIdSchema, tileId: tileIdSchema })
  .strict();

export const declareWinPayload = discardTilePayload;

export const sortRackPayload = z
  .object({
    requestId: requestIdSchema,
    dealId: dealIdSchema,
    placements: z
      .array(z.object({ id: tileIdSchema, slot: z.number().int().min(0).max(RACK_SLOTS - 1) }).strict())
      .min(1)
      .max(15),
  })
  .strict();

export type CreateRoomPayload = z.input<typeof createRoomPayload>;
export type JoinRoomPayload = z.input<typeof joinRoomPayload>;
export type PlayerReadyPayload = z.input<typeof playerReadyPayload>;
export type DrawTilePayload = z.input<typeof drawTilePayload>;
export type DiscardTilePayload = z.input<typeof discardTilePayload>;
export type DeclareWinPayload = z.input<typeof declareWinPayload>;
export type SortRackPayload = z.input<typeof sortRackPayload>;

// ---------------------------------------------------------------------------
// Errors & acknowledgments
// ---------------------------------------------------------------------------

export type ServerErrorCode =
  | 'INVALID_PAYLOAD'
  | 'RATE_LIMITED'
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'GAME_IN_PROGRESS'
  | 'NAME_TAKEN'
  | 'INVALID_SESSION'
  | 'NOT_IN_ROOM'
  | 'SESSION_REPLACED'
  | 'INTERNAL_ERROR';

export type ErrorCode = EngineErrorCode | ServerErrorCode;

export interface ProtocolError {
  code: ErrorCode;
  /** English, developer-facing. Clients map `code` to localized text. */
  message: string;
  details?: Record<string, unknown>;
}

export type Ack<T = Record<string, never>> = { ok: true; data: T } | { ok: false; error: ProtocolError };

export interface RoomJoined {
  code: string;
  seat: number;
  /** Private credential for reclaiming this seat. Only returned when a new seat is issued. */
  sessionToken: string | null;
  invitePath: string;
  inviteUrl: string | null;
  reclaimed: boolean;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface PublicSeat {
  seat: number;
  name: string | null;
  connected: boolean;
  ready: boolean;
  rackCount: number;
  discardTop: TileId | null;
  discardCount: number;
}

/** Everything every seat may see. Never contains racks or stock contents. */
export interface PublicState {
  code: string;
  version: number;
  phase: Phase;
  roundNumber: number;
  totalRounds: number;
  seats: PublicSeat[];
  activeSeat: number | null;
  starter: number | null;
  dealId: string | null;
  turnId: number | null;
  indicator: TileId | null;
  stockCount: number;
  blockedDeals: number;
  /** Full scored history — enough to rebuild the scoreboard after a reconnect. */
  results: RoundResult[];
  totals: number[];
  /** Set once the tournament is complete. */
  winners: number[] | null;
  lastEvent: GameEvent | null;
}

export interface PlayerView {
  you: { seat: number; rack: RackEntry[] };
  state: PublicState;
}

export interface TournamentResult {
  results: RoundResult[];
  totals: number[];
  winners: number[];
}

// ---------------------------------------------------------------------------
// Socket.IO event maps
// ---------------------------------------------------------------------------

type AckFn<T = Record<string, never>> = (ack: Ack<T>) => void;

export interface ClientToServerEvents {
  create_room: (payload: CreateRoomPayload, ack: AckFn<RoomJoined>) => void;
  join_room: (payload: JoinRoomPayload, ack: AckFn<RoomJoined>) => void;
  player_ready: (payload: PlayerReadyPayload, ack: AckFn) => void;
  draw_tile: (payload: DrawTilePayload, ack: AckFn) => void;
  discard_tile: (payload: DiscardTilePayload, ack: AckFn) => void;
  sort_rack: (payload: SortRackPayload, ack: AckFn) => void;
  declare_win: (payload: DeclareWinPayload, ack: AckFn) => void;
}

export interface ServerToClientEvents {
  state_update: (view: PlayerView) => void;
  round_result: (payload: { result: RoundResult }) => void;
  tournament_result: (payload: TournamentResult) => void;
  session_replaced: () => void;
}

export const CLIENT_EVENTS = [
  'create_room',
  'join_room',
  'player_ready',
  'draw_tile',
  'discard_tile',
  'sort_rack',
  'declare_win',
] as const satisfies readonly (keyof ClientToServerEvents)[];

export function invitePathFor(code: string): string {
  return `/room/${code}`;
}

/** Format zod issues into a compact developer message. */
export function describeZodError(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || 'payload'}: ${i.message}`).join('; ');
}

export { z };
