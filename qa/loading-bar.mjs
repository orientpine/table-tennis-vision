// The model loading bar against the bytes that really arrived (WebKit, a throttled link, isolated
// servers). A throttling proxy in front of the one-origin app sends the wasm and model slowly and
// counts what it sent; the test reads the bar while they arrive.
//   slow     2 MB/s: the bar's percent follows sent/total (within 15 points), the MB counter shows,
//            the wasm and the model are each fetched once
//   stall    the model stops after 30%: within stall time + 10 s the screen says why and offers
//            다시 받기; pressing it (link healthy again) reaches calibration
//   bun qa/loading-bar.mjs --vision=<checkout> --tournament=<checkout> --clip=<webm> --tag=before|after --out=<dir> [--port=9700]
import { webkit } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { DEVICES, fakeCamera, startOneApp } from "./one-app-harness.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const out = args.out;
mkdirSync(out, { recursive: true });
const port = Number(args.port || 9700);
const app = await startOneApp({ vision: args.vision, tournament: args.tournament, clip: args.clip, port });

const HEAVY = /\.(wasm|task)$/;
const link = { rate: 2 * 1024 * 1024, stallAt: null, sent: {}, total: {}, requests: {} };
const throttle = Bun.serve({
  port: port + 10,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const headers = new Headers(req.headers);
    headers.delete("host");
    headers.delete("accept-encoding");
    const res = await fetch(app.origin + url.pathname + url.search, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(), redirect: "manual" });
    if (!HEAVY.test(url.pathname) || req.method !== "GET" || !res.ok) return new Response(res.body, { status: res.status, headers: res.headers });
    const name = url.pathname.split("/").pop();
    link.requests[name] = (link.requests[name] || 0) + 1;
    link.log = link.log || [];
    link.log.push(`${name} ${req.headers.get("sec-fetch-dest") || ""} ${req.headers.get("range") || ""}`.trim());
    const bytes = new Uint8Array(await res.arrayBuffer());
    link.total[name] = bytes.byteLength;
    link.sent[name] = 0;
    const stallAt = link.stallAt && name.endsWith(".task") ? Math.floor(bytes.byteLength * link.stallAt) : null;
    const body = new ReadableStream({
      async pull(c) {
        const at = link.sent[name];
        if (at >= bytes.byteLength) return c.close();
        if (stallAt !== null && at >= stallAt) return new Promise(() => {});
        const n = Math.min(64 * 1024, bytes.byteLength - at, stallAt !== null ? stallAt - at : Infinity);
        await Bun.sleep((n / link.rate) * 1000);
        c.enqueue(bytes.subarray(at, at + n));
        link.sent[name] = at + n;
      },
    });
    const h = new Headers(res.headers);
    h.set("content-length", String(bytes.byteLength));
    h.set("cache-control", "max-age=31536000, immutable");
    return new Response(body, { status: 200, headers: h });
  },
});
const origin = `http://127.0.0.1:${port + 10}`;
const browser = await webkit.launch(process.env.PPV_WEBKIT ? { executablePath: process.env.PPV_WEBKIT } : {});
const results = {};
const sentRatio = () => {
  const s = Object.values(link.sent).reduce((a, b) => a + b, 0);
  const t = Object.values(link.total).reduce((a, b) => a + b, 0);
  return t ? s / t : 0;
};
const barState = (page) => page.evaluate(() => {
  const bar = document.querySelector(".screen--loading .progress");
  const fill = bar && bar.querySelector(".progress__fill");
  const vis = !!bar && !bar.closest("[hidden]");
  const pct = vis && fill ? Math.round((fill.getBoundingClientRect().width / bar.getBoundingClientRect().width) * 100) : null;
  return { mode: window.__ppv && window.__ppv.state.mode, pct, count: document.querySelector(".progress__count")?.textContent || null, error: document.querySelector(".screen--error:not([hidden]) .screen__title")?.textContent || null, retry: document.querySelector(".screen--error:not([hidden]) .btn--primary")?.textContent.trim() || null };
});
async function openCamera() {
  const ctx = await browser.newContext(DEVICES.phone);
  await ctx.addInitScript(() => { if (location.origin !== "null") sessionStorage.setItem("pp-started", "1"); });
  await ctx.addInitScript(fakeCamera, `${origin}/__qa/cam.webm`);
  await ctx.addInitScript(() => { localStorage.setItem("pp-role", "camera"); });
  const page = await ctx.newPage();
  await page.goto(origin + "/vision/");
  await page.waitForFunction(() => window.__ppv && window.__ppv.state.mode === "intro", null, { timeout: 20000 });
  await page.getByRole("button", { name: /카메라 시작/ }).click();
  return { ctx, page };
}

try {
  { // slow link: does the bar follow the bytes?
    link.stallAt = null;
    link.sent = {};
    link.total = {};
    link.requests = {};
    link.log = [];
    const { ctx, page } = await openCamera();
    await page.waitForFunction(() => window.__ppv.state.mode !== "intro", null, { timeout: 30000 });
    const samples = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      const b = await barState(page);
      const r = sentRatio();
      if (b.mode !== "loading") break;
      if (b.pct !== null && /MB/.test(b.count || "") && r > 0.05 && r < 0.95) samples.push({ s: Math.round((Date.now() - t0) / 100) / 10, bar: b.pct, sent: Math.round(r * 100), count: b.count });
      if (samples.length === 8) await page.screenshot({ path: `${out}/slow-mid.png` });
      await page.waitForTimeout(500);
    }
    const end = await barState(page);
    const gaps = samples.map((x) => Math.abs(x.bar - x.sent));
    results.slow = {
      samples: samples.length,
      maxGap: gaps.length ? Math.max(...gaps) : null,
      counter: samples.some((x) => /MB/.test(x.count || "")),
      requests: link.requests,
      requestLog: link.log,
      endMode: end.mode,
      pass: samples.length >= 5 && Math.max(...gaps) <= 15 && samples.some((x) => /MB/.test(x.count || "")) && Object.values(link.requests).every((n) => n === 1),
      first: samples.slice(0, 3),
      last: samples.slice(-3),
    };
    await ctx.close();
  }
  { // a stall: does the screen say so, and does 다시 받기 work?
    link.stallAt = 0.3;
    link.sent = {};
    link.total = {};
    const { ctx, page } = await openCamera();
    const t0 = Date.now();
    let seen = null;
    while (Date.now() - t0 < 45000) {
      const b = await barState(page);
      if (b.error) { seen = { ...b, s: Math.round((Date.now() - t0) / 1000) }; break; }
      await page.waitForTimeout(1000);
    }
    await page.screenshot({ path: `${out}/stall.png` });
    let retried = null;
    if (seen) {
      link.stallAt = null;
      await page.locator(".screen--error .btn--primary").click();
      await page.waitForFunction(() => ["calibrating", "running"].includes(window.__ppv.state.mode), null, { timeout: 90000 }).catch(() => {});
      retried = (await barState(page)).mode;
      await page.screenshot({ path: `${out}/after-retry.png` });
    }
    results.stall = { shown: seen, afterRetry: retried, pass: !!(seen && /다시 받기/.test(seen.retry || "") && ["calibrating", "running"].includes(retried)) };
    await ctx.close();
  }
} finally {
  await browser.close().catch(() => {});
  throttle.stop(true);
  await app.stop();
}
writeFileSync(`${out}/loading-bar.json`, JSON.stringify(results, null, 2));
console.log(`LOADBAR ${args.tag} slow=${results.slow?.pass ? "PASS" : "FAIL"} stall=${results.stall?.pass ? "PASS" : "FAIL"} ${JSON.stringify({ slow: { samples: results.slow?.samples, maxGap: results.slow?.maxGap, counter: results.slow?.counter, requests: results.slow?.requests }, stall: results.stall?.shown && { s: results.stall.shown.s, title: results.stall.shown.error, retry: results.stall.shown.retry }, afterRetry: results.stall?.afterRetry })}`);
process.exit(results.slow?.pass && results.stall?.pass ? 0 : 1);
