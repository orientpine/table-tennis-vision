// Download a few files with a real progress count: bytes received over bytes expected, summed over
// all files. The total comes from each response's Content-Length, or the known size when a proxy
// drops it. A download that receives nothing for `stallMs` is aborted and reported as stalled, so the
// screen can say so and offer 다시 받기 instead of a bar that sits still.
export class DownloadError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

export async function downloadAll(files, { onProgress = () => {}, stallMs = 20000, fetchImpl = fetch } = {}) {
  const ctrl = new AbortController();
  const got = files.map(() => 0);
  const size = files.map((f) => f.size || 0);
  let last = Date.now();
  let stalled = false;
  const report = () => onProgress({ received: got.reduce((a, b) => a + b, 0), total: size.reduce((a, b) => a + b, 0) });
  const timer = setInterval(() => {
    if (Date.now() - last > stallMs) {
      stalled = true;
      ctrl.abort();
    }
  }, Math.min(1000, stallMs / 4));
  try {
    report();
    return await Promise.all(files.map(async (f, i) => {
      const res = await fetchImpl(f.url, { signal: ctrl.signal });
      if (!res.ok) throw new DownloadError("failed", `${f.name || f.url}: 서버 응답 ${res.status}`);
      const length = Number(res.headers.get("content-length") || 0);
      if (length > 0 && !res.headers.get("content-encoding")) size[i] = length;
      report();
      const reader = res.body.getReader();
      ctrl.signal.addEventListener("abort", () => reader.cancel().catch(() => {}), { once: true });
      const parts = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got[i] += value.byteLength;
        if (got[i] > size[i]) size[i] = got[i];
        last = Date.now();
        report();
      }
      if (ctrl.signal.aborted) throw new DownloadError("failed", "받기가 끊겼어요");
      size[i] = got[i];
      report();
      const out = new Uint8Array(got[i]);
      let at = 0;
      for (const p of parts) {
        out.set(p, at);
        at += p.byteLength;
      }
      return out;
    }));
  } catch (err) {
    ctrl.abort();
    if (stalled) throw new DownloadError("stalled", `${Math.round(stallMs / 1000)}초 동안 받은 게 없어요`);
    if (err instanceof DownloadError) throw err;
    throw new DownloadError("failed", "네트워크가 끊겼어요");
  } finally {
    clearInterval(timer);
  }
}
