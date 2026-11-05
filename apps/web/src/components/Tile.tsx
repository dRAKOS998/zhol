import { memo } from 'react';
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
          <svg viewBox="0 0 20 20" className="tile-zhol-star">
            <path d="M10 1 L12.4 7.6 L19 10 L12.4 12.4 L10 19 L7.6 12.4 L1 10 L7.6 7.6 Z" fill="currentColor" />
          </svg>
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

/** Face-down tile (the stock). */
export function TileBack({ className = '' }: { className?: string }) {
  return <span className={`tile tile-table tile-back ${className}`} aria-hidden="true" />;
}
