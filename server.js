// Static server for the pingpong-vision web app.
// Serves public/ (and qa/ when PPV_QA=1), /healthz, and the owner's rally saves (save-server.js):
// a finished rally's record and its highlight clip, uploaded only with the owner's upload key.
// The live camera stream itself is never uploaded.
import { join, normalize } from "node:path";
import { createSaveStore } from "./save-server.js";
import { shellBuild } from "./build-id.js";

const ROOT = import.meta.dir;
const PORT = Number(process.env.PORT || 8791);
const QA = process.env.PPV_QA === "1";
const VENDOR = join(ROOT, "node_modules/@mediapipe/tasks-vision");

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: mediastream:",
  "connect-src 'self' blob:",
  "worker-src 'self' blob:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
].join("; ");

// MediaPipe's bundle always starts a usage logger that POSTs task timing stats to
// odml.pa.googleapis.com every 60 s and has no off switch. CSP would block it anyway, but the
// phone should not even try, so serve the bundle with flush() turned into a no-op. Fail loudly
// if a MediaPipe upgrade changes the code this relies on.
const LOGGER_FLUSH = 'flush(t,e){if(this.error)e?.("net-send-failed")';
const BUNDLE_PATH = join(VENDOR, "vision_bundle.mjs");
const bundleSource = await Bun.file(BUNDLE_PATH).text();
if (bundleSource.split(LOGGER_FLUSH).length !== 2) throw new Error("MediaPipe logger patch target not found exactly once");
const PATCHED_BUNDLE = bundleSource.replace(LOGGER_FLUSH, `flush(t,e){this.i=[];return void t?.();${LOGGER_FLUSH.slice("flush(t,e){".length)}`);

// sw.js and index.html carry __PPV_BUILD__ / __PPV_SHELL__; each start computes them from the
// shell bytes, so a deploy that changes any shell file gets a new service worker and cache name.
const BUILD = shellBuild(join(ROOT, "public"), { "./vendor/mediapipe/vision_bundle.mjs": PATCHED_BUNDLE });
const STAMPED = new Set([join(ROOT, "public/sw.js"), join(ROOT, "public/index.html")]);
const stamp = (text) => text.replaceAll("__PPV_BUILD__", BUILD.id).replace('"__PPV_SHELL__"', JSON.stringify(BUILD.urls));

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
  ".task": "application/octet-stream",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
};

function resolve(pathname) {
  // Tailscale serve strips the /vision mount; accept both forms so local QA works too.
  if (pathname === "/vision") return null;
  if (pathname.startsWith("/vision/")) pathname = pathname.slice("/vision".length);
  if (pathname.endsWith("/")) pathname += "index.html";
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  if (rel.startsWith("/vendor/mediapipe/")) return join(VENDOR, rel.slice("/vendor/mediapipe/".length));
  if (rel.startsWith("/vendor/ort/")) return join(ROOT, "node_modules/onnxruntime-web/dist", rel.slice("/vendor/ort/".length));
  if (rel.startsWith("/qa/")) return QA ? join(ROOT, rel) : null;
  return join(ROOT, "public", rel);
}

const saves = createSaveStore();
console.log(`rally saves in ${saves.dir} (upload key file ${saves.keyFile})`);

// at most 30 lines a minute from all phones together, so a stuck page cannot flood the journal
const stableSeen = [];
async function stableLog(req) {
  const now = Date.now();
  while (stableSeen.length && now - stableSeen[0] > 60000) stableSeen.shift();
  if (stableSeen.length >= 30) return new Response(null, { status: 429 });
  let b;
  try { b = JSON.parse((await req.text()).slice(0, 2000)); } catch { return new Response(null, { status: 400 }); }
  const ACTIONS = ["compact", "full", "stay", "dismiss"];
  if (!b || !ACTIONS.includes(b.action)) return new Response(null, { status: 400 });
  const num = (v) => (Number.isFinite(v) ? Math.round(Math.max(-1, Math.min(10000, v))) : null);
  stableSeen.push(now);
  console.log(`stable-mode ${b.action} fps=${num(b.fps)} repeat=${num(b.repeatPct)}% base=${num(b.basePct)}% bad=${num(b.badWindows)} phoneAt=${new Date(Number.isFinite(b.at) && Math.abs(b.at - now) < 864e5 ? b.at : now).toISOString()} serverAt=${new Date(now).toISOString()}`);
  return new Response(null, { status: 204 });
}

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  maxRequestBodySize: 210 * 1024 * 1024,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok\n");
    // 판정 안정 모드 switches from a camera phone: numbers only, one journal line each, never stored with
    // the tournament (lead, 2026-10-31: so we can see why a real phone switched)
    if (url.pathname === "/vision/api/stable-log" && req.method === "POST") return stableLog(req);
    const savePath = url.pathname.startsWith("/vision/") ? url.pathname.slice("/vision".length) : url.pathname;
    const saved = await saves.handle(req, savePath, srv.requestIP(req)?.address);
    if (saved) {
      saved.headers.set("content-security-policy", CSP);
      saved.headers.set("referrer-policy", "no-referrer");
      saved.headers.set("x-content-type-options", "nosniff");
      return saved;
    }
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed\n", { status: 405 });
    if (url.pathname === "/vision") return new Response(null, { status: 301, headers: { location: "/vision/" } });
    const path = resolve(url.pathname);
    if (!path || path.includes("..")) return new Response("not found\n", { status: 404 });
    const isBundle = path === BUNDLE_PATH;
    const file = isBundle ? new Blob([PATCHED_BUNDLE]) : STAMPED.has(path) ? new Blob([stamp(await Bun.file(path).text())]) : Bun.file(path);
    if (!isBundle && !STAMPED.has(path) && !(await file.exists())) return new Response("not found\n", { status: 404 });
    const ext = path.slice(path.lastIndexOf("."));
    const immutable = ext === ".wasm" || ext === ".task" || ext === ".woff2";
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") || "");
    let body = file;
    let status = 200;
    const extra = { "accept-ranges": "bytes" };
    if (range && (range[1] || range[2])) {
      const size = file.size;
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
      body = file.slice(start, end + 1);
      status = 206;
      extra["content-range"] = `bytes ${start}-${end}/${size}`;
    }
    return new Response(body, {
      status,
      headers: {
        ...extra,
        "content-type": TYPES[ext] || "application/octet-stream",
        "cache-control": immutable ? "public, max-age=604800" : "no-cache",
        "content-security-policy": CSP,
        "permissions-policy": "camera=(self), microphone=(), geolocation=()",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    });
  },
});

console.log(`pingpong-vision on http://127.0.0.1:${server.port}/vision/ (qa=${QA}, build ${BUILD.id})`);
