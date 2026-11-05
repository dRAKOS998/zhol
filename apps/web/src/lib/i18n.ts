import type { Color, TileId } from '@zhol/engine';
import { parseTile } from '@zhol/engine';
import type { ProtocolError } from '@zhol/protocol';

/** Albanian interface text. Code and identifiers stay in English. */
export const COLOR_NAME: Record<Color, string> = {
  red: 'e kuqe',
  black: 'e zezë',
  blue: 'blu',
  yellow: 'e verdhë',
};

export function tileLabel(id: TileId): string {
  const t = parseTile(id);
  return t.kind === 'zhol' ? 'Zhol (gur i lirë)' : `${t.rank} ${COLOR_NAME[t.color]}`;
}

const ERRORS: Record<string, string> = {
  INVALID_PAYLOAD: 'Të dhënat nuk janë të vlefshme. Kontrollo emrin ose kodin e dhomës.',
  RATE_LIMITED: 'Shumë përpjekje njëra pas tjetrës. Provo sërish pas një minute.',
  ROOM_NOT_FOUND: 'Kjo dhomë nuk ekziston. Kontrollo kodin ose lidhjen.',
  ROOM_FULL: 'Dhoma është plot: të katër vendet janë zënë.',
  GAME_IN_PROGRESS: 'Loja ka nisur, prandaj dhoma nuk pranon lojtarë të rinj.',
  NAME_TAKEN: 'Ky emër përdoret tashmë në këtë dhomë. Zgjidh një emër tjetër.',
  INVALID_SESSION: 'Vendi yt në këtë dhomë nuk u njoh nga kjo pajisje. Hyr me emrin tënd.',
  NOT_IN_ROOM: 'Nuk je i lidhur me dhomën. Hap sërish lidhjen e dhomës.',
  SESSION_REPLACED: 'Ky vend po kontrollohet nga një skedë ose pajisje tjetër.',
  INTERNAL_ERROR: 'Ndodhi një gabim në server. Provo sërish.',
  TIMEOUT: 'Serveri nuk u përgjigj. Kontrollo lidhjen me internetin dhe provo sërish.',
  WRONG_PHASE: 'Ky veprim nuk lejohet në këtë moment të lojës.',
  NOT_YOUR_TURN: 'Nuk është radha jote.',
  STALE_DEAL: 'Loja ndryshoi ndërkohë. Pamja u përditësua.',
  STALE_TURN: 'Loja ndryshoi ndërkohë. Pamja u përditësua.',
  EMPTY_STOCK: 'Nuk ka më gurë në stok.',
  EMPTY_DISCARD: 'Lojtari para teje nuk ka gur të hedhur për të marrë.',
  TILE_NOT_IN_RACK: 'Ky gur nuk është në raftin tënd.',
  INVALID_PERMUTATION: 'Renditja nuk u ruajt. U rikthye renditja e fundit e ruajtur.',
  INVALID_CLOSE:
    'Mbyllja nuk vlen. Pasi të hedhësh gurin e zgjedhur, të 14 gurët e mbetur duhet të formojnë vetëm vargje ose grupe të vlefshme.',
  TOURNAMENT_COMPLETE: 'Turneu ka përfunduar.',
  NOT_SEATED: 'Nuk je i ulur në këtë dhomë.',
  SEAT_TAKEN: 'Ky vend është zënë.',
  INVALID_SEAT: 'Vend i pavlefshëm.',
};

export function errorText(err: Pick<ProtocolError, 'code' | 'details'> | null | undefined): string {
  if (!err) return '';
  if (err.details?.timeout === true) return ERRORS.TIMEOUT!;
  let text = ERRORS[err.code] ?? 'Veprimi nuk u krye. Provo sërish.';
  if (err.code === 'INVALID_CLOSE' && typeof err.details?.unlinkedCount === 'number' && err.details.unlinkedCount > 0) {
    const n = err.details.unlinkedCount;
    text += ` Tani mbeten ${n} ${n === 1 ? 'gur' : 'gurë'} pa lidhje.`;
  }
  return text;
}

export const formatScore = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0');
