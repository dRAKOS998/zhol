import { memo, type CSSProperties } from 'react';
import { type TileId, parseTile } from '@zhol/engine';
import { tileLabel } from '../lib/i18n';

const INK: Record<string, string> = { red: 'var(--ink-red)', black: 'var(--ink-black)', blue: 'var(--ink-blue)', yellow: 'var(--ink-yellow)' };

/** Secondary shape per color so tiles are distinguishable without color vision. */
function Mark({ color }: { color: string }) {
  const fill = INK[color];
  switch (color) {
    case 'red':
      return <path d="M10 1 L19 10 L10 19 L1 10 Z" fill={fill} />;
    case 'black':
      return <rect x="2.5" y="2.5" width="15" height="15" rx="1.5" fill={fill} />;
    case 'blue':
      return <circle cx="10" cy="10" r="8" fill={fill} />;
    default:
      return <path d="M10 1.5 L19 18 L1 18 Z" fill={fill} />;
  }
}

/** The joker's face: a three-pointed jester's cap with bells, in the tile colours. */
function JokerHat() {
  return (
    <svg viewBox="0 0 40 34" className="tile-zhol-hat">
      <path d="M9 27 C9 18 7 12 3 8 C11 9 16 14 18 22 Z" fill="var(--ink-red)" />
      <path d="M31 27 C31 18 33 12 37 8 C29 9 24 14 22 22 Z" fill="var(--ink-blue)" />
      <path d="M13 26 C13 16 16 9 20 4 C24 9 27 16 27 26 Z" fill="var(--ink-zhol)" />
      <rect x="7" y="24" width="26" height="7" rx="3.5" fill="var(--ink-yellow)" />
      <path d="M11 27.5h18" stroke="#fff6" strokeWidth="1.2" strokeDasharray="2 2.4" />
      <circle cx="3" cy="8" r="2.6" fill="var(--ink-yellow)" />
      <circle cx="20" cy="4" r="2.6" fill="var(--ink-yellow)" />
      <circle cx="37" cy="8" r="2.6" fill="var(--ink-yellow)" />
    </svg>
  );
}

export interface TileFaceProps {
  id: TileId;
  /** Visual size preset; the face always scales with its container width. */
  size?: 'rack' | 'table';
  className?: string;
}

/** Ivory tile face. Purely presentational; interaction lives in the rack. */
export const TileFace = memo(function TileFace({ id, size = 'rack', className = '' }: TileFaceProps) {
  const t = parseTile(id);
  return (
    <span className={`tile tile-${size} ${className}`} data-tile-id={id} aria-label={tileLabel(id)} role="img">
      {t.kind === 'zhol' ? (
        <span className="tile-zhol" aria-hidden="true">
          <JokerHat />
          <span className="tile-zhol-word">Zhol</span>
        </span>
      ) : (
        <span className="tile-body" aria-hidden="true" style={{ color: INK[t.color] }}>
          <span className="tile-num">{t.rank}</span>
          <svg viewBox="0 0 20 20" className="tile-mark">
            <Mark color={t.color} />
          </svg>
        </span>
      )}
    </span>
  );
});

/** Face-down tile (the stock, opponents' racks). */
export function TileBack({ className = '', size = 'table', style }: { className?: string; size?: 'table' | 'mini'; style?: CSSProperties }) {
  return (
    <span className={`tile tile-${size} tile-back ${className}`} style={style} aria-hidden="true">
      <span className="tile-back-mark" />
    </span>
  );
}
