import { useEffect, useState, type CSSProperties } from 'react';
import type { PublicState, RoundResult } from '@zhol/protocol';
import { formatScore } from '../lib/i18n';
import { TileFace } from './Tile';

const nameOf = (s: PublicState, seat: number) => s.seats[seat]?.name ?? `Vendi ${seat + 1}`;

export function winnersText(s: PublicState): string | null {
  if (!s.winners) return null;
  const names = s.winners.map((w) => nameOf(s, w));
  if (names.length === 1) return `Fitues i turneut: ${names[0]} (${formatScore(s.totals[s.winners[0]!]!)})`;
  return `Fitues të përbashkët: ${names.join(', ')} (${formatScore(s.totals[s.winners[0]!]!)})`;
}

const inGame = (state: PublicState) => state.seats.filter((x) => (state.players.length ? state.players.includes(x.seat) : x.name));

/** Full score table: players × rounds + totals. */
export function ScoreTable({ state, mySeat }: { state: PublicState; mySeat: number | null }) {
  const rounds = Array.from({ length: state.totalRounds }, (_, i) => i + 1);
  const last = state.results.at(-1);
  return (
    <div className="score">
      {state.winners ? (
        <p className="score-headline">{winnersText(state)}</p>
      ) : last ? (
        <p className="score-headline">
          Raundi {last.roundNumber}: {nameOf(state, last.winner)} mbylli
          {last.finishType === 'zhol' ? ' duke hedhur Zhol (−40)' : ' (−20)'}.
        </p>
      ) : (
        <p className="score-headline">Asnjë raund nuk është mbyllur ende.</p>
      )}
      <div className="score-scroll">
        <table className="score-table">
          <caption className="sr-only">Pikët sipas raundeve. Më pak pikë është më mirë.</caption>
          <thead>
            <tr>
              <th scope="col">Lojtari</th>
              {rounds.map((r) => (
                <th scope="col" key={r}>
                  R{r}
                </th>
              ))}
              <th scope="col">Totali</th>
            </tr>
          </thead>
          <tbody>
            {inGame(state).map((seat) => {
              const isWinner = state.winners?.includes(seat.seat);
              return (
                <tr key={seat.seat} className={seat.seat === mySeat ? 'is-me' : ''}>
                  <th scope="row">
                    <span className="score-name">{seat.name ?? `Vendi ${seat.seat + 1}`}</span>
                    {seat.bot && <span className="score-you score-bot"> · bot</span>}
                    {seat.seat === mySeat && <span className="score-you"> (ti)</span>}
                    {isWinner && (
                      <span className="badge badge-gold" title="Fitues">
                        Fitues
                      </span>
                    )}
                  </th>
                  {rounds.map((r) => {
                    const res = state.results.find((x) => x.roundNumber === r);
                    if (!res) {
                      return (
                        <td key={r} className="score-unplayed">
                          <span aria-hidden="true">·</span>
                          <span className="sr-only">pa luajtur</span>
                        </td>
                      );
                    }
                    const won = res.winner === seat.seat;
                    return (
                      <td key={r} className={won ? 'score-won' : ''}>
                        {formatScore(res.deltas[seat.seat]!)}
                        {won && (
                          <span className="score-mark" title={res.finishType === 'zhol' ? 'Mbylli me Zhol' : 'Mbylli raundin'}>
                            {res.finishType === 'zhol' ? ' Z★' : ' ★'}
                          </span>
                        )}
                        {won && <span className="sr-only">{res.finishType === 'zhol' ? ', mbylli me Zhol' : ', mbylli raundin'}</span>}
                      </td>
                    );
                  })}
                  <td className="score-total">{formatScore(state.totals[seat.seat]!)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="score-legend">
        ★ mbylli raundin. Z★ mbylli duke hedhur Zhol. Pika e zbehtë: raund që nuk është luajtur ende.
      </p>
    </div>
  );
}

/**
 * Every player's hand as it was scored: links side by side, then the tiles that stayed loose
 * (the ones that cost points). Shown for one closed round at a time.
 */
export function RoundHands({ state, mySeat }: { state: PublicState; mySeat: number | null }) {
  const withHands = state.results.filter((r) => r.hands);
  const latest = withHands.at(-1)?.roundNumber ?? null;
  const [round, setRound] = useState<number | null>(latest);
  // A newly closed round takes over the view.
  useEffect(() => setRound(latest), [latest, state.gameNumber]);
  const result: RoundResult | undefined = withHands.find((r) => r.roundNumber === round) ?? withHands.at(-1);
  if (!result?.hands) return null;
  return (
    <section className="hands" aria-label={`Duart e raundit ${result.roundNumber}`}>
      <div className="hands-head">
        <h3 className="hands-title">Duart e raundit {result.roundNumber}</h3>
        {withHands.length > 1 && (
          <div className="hands-rounds" role="group" aria-label="Zgjidh raundin">
            {withHands.map((r) => (
              <button key={r.roundNumber} type="button" className={r.roundNumber === result.roundNumber ? 'is-on' : ''} aria-pressed={r.roundNumber === result.roundNumber} onClick={() => setRound(r.roundNumber)}>
                R{r.roundNumber}
              </button>
            ))}
          </div>
        )}
      </div>
      <ul className="hands-list">
        {inGame(state).map((seat, i) => {
          const hand = result.hands![seat.seat];
          if (!hand) return null;
          const won = result.winner === seat.seat;
          const delta = result.deltas[seat.seat]!;
          return (
            <li key={`${result.roundNumber}-${seat.seat}`} className={`hand ${won ? 'is-winner' : ''}`} style={{ '--i': i } as CSSProperties}>
              <div className="hand-who">
                <span className="hand-name">
                  {seat.name ?? `Vendi ${seat.seat + 1}`}
                  {seat.seat === mySeat && <span className="score-you"> (ti)</span>}
                </span>
                <span className={`hand-delta ${delta < 0 ? 'is-good' : delta > 0 ? 'is-bad' : ''}`}>
                  {won ? `mbylli ${formatScore(delta)}` : hand.unlinked.length ? `${hand.unlinked.length} pa lidhje ${formatScore(delta)}` : 'të gjithë të lidhur 0'}
                </span>
              </div>
              <div className="hand-tiles">
                {hand.links.map((link, k) => (
                  <span key={k} className="hand-group">
                    {link.map((id) => (
                      <TileFace key={id} id={id} size="table" />
                    ))}
                  </span>
                ))}
                {hand.unlinked.length > 0 && (
                  <span className="hand-group hand-loose">
                    {hand.unlinked.map((id) => (
                      <TileFace key={id} id={id} size="table" />
                    ))}
                  </span>
                )}
                {won && (
                  <span className="hand-group hand-final" title="Guri i hedhur për të mbyllur">
                    <TileFace id={result.finalDiscard} size="table" />
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="score-legend">Gurët me kornizë të kuqe mbetën pa lidhje dhe japin pikë. Guri i rrethuar me të artë mbylli raundin.</p>
    </section>
  );
}

/** Tournaments won at this table, shown once there has been a rematch. */
export function SeriesTally({ state }: { state: PublicState }) {
  const wins = state.seriesWins;
  if (!wins || (state.gameNumber ?? 1) < 2) return null;
  return (
    <p className="series">
      <span className="series-label">Seria · loja {state.gameNumber}</span>
      {inGame(state).map((s) => (
        <span key={s.seat} className="series-item">
          {s.name} <b>{wins[s.seat] ?? 0}</b>
        </span>
      ))}
    </p>
  );
}

/** Compact summary for the top bar, ordered by seat. */
export function ScoreSummary({ state, mySeat }: { state: PublicState; mySeat: number | null }) {
  return (
    <ul className="summary" aria-label="Pikët totale">
      {inGame(state).map((s) => (
        <li key={s.seat} className={s.seat === mySeat ? 'is-me' : ''}>
          <span className="summary-name">{s.name}</span>
          <span className="summary-score">{formatScore(state.totals[s.seat]!)}</span>
        </li>
      ))}
    </ul>
  );
}
