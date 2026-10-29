// Who won the point, read from one rally's bounces (sides "near" / "far") and shots.
// In a legal rally the table bounces alternate sides: serve on the server's side, then the
// receiver's, then each return lands on the other side. Whatever ends the rally, the player on
// the side of the last bounce is the one who failed: they let it bounce twice, missed it, or hit
// it into the net or out (then no further bounce comes). So:
//   two bounces in a row on one side -> that side loses at the second bounce (double_bounce)
//                                       (later "shots" are the ball rolling and are ignored)
//   otherwise                        -> the side of the last bounce loses (no_return)
// The tracker misses some bounces. A shot from the other side between two same-side bounces
// means the other side's bounce was missed (that player could only hit a ball that reached
// them), so the alternation goes on. A rally with no bounce has nothing to judge: null means
// "do not score". sure marks the calls that held up on OpenTTGames game_1 (REPORT-3): a double
// bounce, or a rally with at least three bounces; a short rally that ends with the ball lost
// is often missing its deciding bounce, so it is only a suggestion.
export const REASONS = {
  double_bounce: "두 번 튐",
  no_return: "못 받음",
};

const other = (side) => (side === "near" ? "far" : "near");

export function judgePoint({ shots = [], bounces = [] } = {}) {
  if (!bounces.length) return null;
  const byT = (a, b) => a.t - b.t;
  const bs = [...bounces].sort(byT);
  const ss = [...shots].sort(byT);
  let loser = bs[0].side;
  let reason = "no_return";
  for (let i = 1; i < bs.length; i++) {
    const prev = bs[i - 1];
    const cur = bs[i];
    loser = cur.side;
    const missedBounce = ss.some((s) => s.t > prev.t && s.t < cur.t && s.side === other(cur.side));
    if (cur.side === prev.side && !missedBounce) {
      reason = "double_bounce";
      break;
    }
  }
  const sure = reason === "double_bounce" || bs.length >= 3;
  return { winner: other(loser), loser, reason, label: REASONS[reason], sure, bounces: bs.length, shots: ss.length };
}
