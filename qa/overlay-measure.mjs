// Overlay pixels in one decoded frame (rgb24, W x H, as seen on screen): name-tag text height, score
// strip height, trail thickness and the share of pixels off the grey test source (rgb 128).
// rec (optional) places the trail: { trailY, trailX0, trailStep, trailN } in clip px, f = W / clip width.
export function measure(px, W, H, rec, f) {
  const at = (x, y) => { const i = (y * W + x) * 3; return [px[i], px[i + 1], px[i + 2]]; };
  const off = (x, y) => { const [r, g, b] = at(x, y); return Math.max(Math.abs(r - 128), Math.abs(g - 128), Math.abs(b - 128)) > 40; };
  const navy = (x, y) => { const [r, g, b] = at(x, y); return b - r > 12 && r + g + b < 200; };
  let ink = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (off(x, y)) ink++;
  // score strip: navy rows from the top, sampled on the right where the RALLY text does not reach
  let strip = 0;
  while (strip < H && Array.from({ length: 20 }, (_, i) => navy(W - 6 - i * 3, strip)).filter(Boolean).length > 14) strip++;
  // name tags: connected navy components below the strip
  const seen = new Uint8Array(W * H);
  let label = 0;
  const boxes = [];
  for (let y = strip + 2; y < H; y++) for (let x = 0; x < W; x++) {
    if (seen[y * W + x] || !navy(x, y)) continue;
    let x0 = x, x1 = x, y0 = y, y1 = y, n = 0;
    const st = [[x, y]];
    seen[y * W + x] = 1;
    while (st.length) {
      const [cx, cy] = st.pop(); n++;
      x0 = Math.min(x0, cx); x1 = Math.max(x1, cx); y0 = Math.min(y0, cy); y1 = Math.max(y1, cy);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny <= strip || nx >= W || ny >= H || seen[ny * W + nx] || !navy(nx, ny)) continue;
        seen[ny * W + nx] = 1; st.push([nx, ny]);
      }
    }
    if (x1 - x0 < 15 || y1 - y0 < 5 || n < 60) continue;
    // text ink inside the box (2 px in from its edge, so the 1 px frame is not counted): pixels far
    // from the panel colour, i.e. the red, blue or white letters
    const pr = at(x0 + 1, Math.round((y0 + y1) / 2));
    let t0 = Infinity, t1 = -Infinity;
    for (let yy = y0 + 2; yy <= y1 - 2; yy++) for (let xx = x0 + 2; xx <= x1 - 2; xx++) {
      const [r, g, b] = at(xx, yy);
      if (Math.abs(r - pr[0]) + Math.abs(g - pr[1]) + Math.abs(b - pr[2]) > 120) { t0 = Math.min(t0, yy); t1 = Math.max(t1, yy); }
    }
    const text = t1 >= t0 ? t1 - t0 + 1 : 0;
    boxes.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, text });
    label = Math.max(label, text);
  }
  // trail line: between two dots, the run of rows off the grey around the line
  if (!rec) return { label, strip, ink: +(ink / (W * H)).toFixed(4), boxes: boxes.length };
  const ty = Math.round(rec.trailY * f);
  const runs = [];
  for (let i = 1; i < rec.trailN; i++) {
    const cx0 = Math.round((rec.trailX0 + rec.trailStep * (i - 0.5)) * f);
    let best = 0;
    for (let cx = cx0 - 4; cx <= cx0 + 4; cx++) {
      let run = 0;
      for (let y = ty - 6; y <= ty + 6; y++) if (off(cx, y)) run++;
      best = Math.max(best, run);
    }
    runs.push(best);
  }
  runs.sort((a, b) => a - b);
  return { label, trail: runs[Math.floor(runs.length / 2)], strip, ink: +(ink / (W * H)).toFixed(4), boxes: boxes.length };
}
