import { expect, test } from "bun:test";
import { DownloadError, downloadAll } from "../public/js/download.js";

const body = (chunks, { gapMs = 0, hangAfter = Infinity } = {}) =>
  new ReadableStream({
    async start(c) {
      for (let i = 0; i < chunks.length; i++) {
        if (i >= hangAfter) return; // never closes: a stalled connection
        if (gapMs) await Bun.sleep(gapMs);
        c.enqueue(new Uint8Array(chunks[i]));
      }
      c.close();
    },
  });
const respond = (chunks, headers = {}, opts) => new Response(body(chunks, opts), { headers });

test("progress is bytes received over the summed Content-Length of every file", async () => {
  const seen = [];
  const fetchImpl = async (url) => (url === "a" ? respond([3, 3], { "content-length": "6" }) : respond([4], { "content-length": "4" }));
  const [a, b] = await downloadAll([{ url: "a" }, { url: "b" }], { fetchImpl, onProgress: (p) => seen.push(p) });
  expect(a.byteLength).toBe(6);
  expect(b.byteLength).toBe(4);
  expect(seen.at(-1)).toEqual({ received: 10, total: 10 });
  expect(seen.every((p) => p.received <= p.total)).toBe(true);
  expect(seen.some((p) => p.received > 0 && p.received < 10)).toBe(true);
});

test("without Content-Length the known size is the total, and the total never ends below what arrived", async () => {
  const seen = [];
  const fetchImpl = async () => respond([5, 5]);
  await downloadAll([{ url: "m", size: 8 }], { fetchImpl, onProgress: (p) => seen.push(p) });
  expect(seen[0]).toEqual({ received: 0, total: 8 });
  expect(seen.at(-1)).toEqual({ received: 10, total: 10 });
});

test("a download that receives nothing for stallMs is aborted as stalled", async () => {
  const fetchImpl = async (url, { signal }) => {
    void signal;
    return respond([1, 1], { "content-length": "9" }, { hangAfter: 1 });
  };
  const err = await downloadAll([{ url: "x" }], { fetchImpl, stallMs: 200 }).catch((e) => e);
  expect(err).toBeInstanceOf(DownloadError);
  expect(err.kind).toBe("stalled");
});

test("a server error or a dropped connection is a failed download, not a frozen bar", async () => {
  const notFound = await downloadAll([{ url: "x", name: "모델" }], { fetchImpl: async () => new Response("no", { status: 404 }) }).catch((e) => e);
  expect(notFound.kind).toBe("failed");
  expect(notFound.message).toContain("404");
  const dropped = await downloadAll([{ url: "x" }], { fetchImpl: async () => { throw new TypeError("Load failed"); } }).catch((e) => e);
  expect(dropped.kind).toBe("failed");
});
