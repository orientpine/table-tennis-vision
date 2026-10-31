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

// Signals that the serve may have been a fault or a let. They only raise a one-tap question
// ("폴트?" / "렛?"); nothing changes unless the referee taps.
//   fault: the first bounce after the serve is on the receiver's side, and the ball was tracked
//          well over the server's own half (measured for FAULT_MIN_SPAN_S, no gap longer than
//          FAULT_MAX_GAP_S), so a real own-side bounce would have been seen. Without the coverage
//          check it fired on 8 of 31 game_1 points (26%), nearly all missed own bounces; with it,
//          0 of 31 at 60 fps and 1 of 31 at 30 fps. The span is time, not a point count, so 30
//          and 60 fps use the same rule. A serve faster than this over its own half is not asked.
//   let:   the serve's along-table speed drops sharply across the net line (serveNet.ratio, from
//          rally.js netKink) and it still lands in
export const LET_RATIO = 0.55;
export const FAULT_MIN_SPAN_S = 0.25;
export const FAULT_MAX_GAP_S = 0.07;
export function suspects({ shots = [], bounces = [], serveNet = null, serveSeen = null } = {}) {
  const serve = [...shots].sort((a, b) => a.t - b.t)[0];
  if (!serve) return { fault: false, let: false, server: null };
  const first = [...bounces].sort((a, b) => a.t - b.t).find((b) => b.t > serve.t);
  const landed = !!first && first.side !== serve.side;
  const seen = !!serveSeen && serveSeen.spanS >= FAULT_MIN_SPAN_S && serveSeen.maxGapS <= FAULT_MAX_GAP_S;
  return { fault: landed && seen, let: landed && !!serveNet && serveNet.ratio < LET_RATIO, server: serve.side };
}
