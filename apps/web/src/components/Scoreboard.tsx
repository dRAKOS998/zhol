import type { PublicState } from '@zhol/protocol';
import { formatScore } from '../lib/i18n';

const nameOf = (s: PublicState, seat: number) => s.seats[seat]?.name ?? `Vendi ${seat + 1}`;

export function winnersText(s: PublicState): string | null {
  if (!s.winners) return null;
  const names = s.winners.map((w) => nameOf(s, w));
  if (names.length === 1) return `Fitues i turneut: ${names[0]} (${formatScore(s.totals[s.winners[0]!]!)})`;
  return `Fitues të përbashkët: ${names.join(', ')} (${formatScore(s.totals[s.winners[0]!]!)})`;
}

/** Full score table: four players × four rounds + totals. */
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
            {state.seats.map((seat) => {
              const isWinner = state.winners?.includes(seat.seat);
              return (
                <tr key={seat.seat} className={seat.seat === mySeat ? 'is-me' : ''}>
                  <th scope="row">
                    <span className="score-name">{seat.name ?? `Vendi ${seat.seat + 1}`}</span>
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

/** Compact summary for the top bar, ordered by seat. */
export function ScoreSummary({ state, mySeat }: { state: PublicState; mySeat: number | null }) {
  return (
    <ul className="summary" aria-label="Pikët totale">
      {state.seats.map((s) => (
        <li key={s.seat} className={s.seat === mySeat ? 'is-me' : ''}>
          <span className="summary-name">{s.name}</span>
          <span className="summary-score">{formatScore(state.totals[s.seat]!)}</span>
        </li>
      ))}
    </ul>
  );
}
