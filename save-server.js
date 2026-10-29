// Owner-only rally saves on this PC (docs/save-to-pc.md). The phone uploads a finished rally's
// record and a highlight clip (that rally only, HUD drawn in) with a secret upload key; each saved
// rally gets an unguessable share link. There is no listing endpoint: a rally can be reached only
// through its own link, and deleted only with the upload key.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const ID_RE = /^[A-Za-z0-9_-]{43}$/;
const VIDEO_TYPES = { "video/mp4": "mp4", "video/webm": "webm" };

export function loadOrCreateKey(keyFile) {
  if (existsSync(keyFile)) return readFileSync(keyFile, "utf8").trim();
  mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
  const key = randomBytes(24).toString("base64url");
  writeFileSync(keyFile, `${key}\n`, { mode: 0o600 });
  chmodSync(keyFile, 0o600);
  return key;
}

// The part's declared type is not trusted (and Bun's form parser can drop it): read the container
// signature instead. MP4 has "ftyp" at byte 4; WebM starts with the EBML magic 1A 45 DF A3.
export function sniffVideo(b) {
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return "video/mp4";
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  return null;
}

// One-time setup links: https://<host>/vision/#setup=<token>. The token rides in the URL
// fragment, which browsers never send in the page request, so it reaches no access log; the
// app trades it once through POST /api/setup for the upload key. Only sha256(token) and its
// expiry are kept on disk, and a token is deleted the moment it is used.
const sha = (s) => createHash("sha256").update(s).digest("hex");

function readTokens(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

function writeTokens(file, tokens) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(tokens), { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function createSetupToken({ tokenFile, ttlMs = 10 * 60 * 1000, now = Date.now() } = {}) {
  const token = randomBytes(32).toString("base64url");
  const tokens = readTokens(tokenFile).filter((t) => t.exp > now);
  tokens.push({ h: sha(token), exp: now + ttlMs });
  writeTokens(tokenFile, tokens);
  return { token, expiresAt: now + ttlMs };
}

export function redeemSetupToken({ tokenFile, token, now = Date.now() }) {
  if (typeof token !== "string" || !ID_RE.test(token)) return false;
  const tokens = readTokens(tokenFile);
  const h = sha(token);
  const hit = tokens.find((t) => t.h === h);
  writeTokens(tokenFile, tokens.filter((t) => t.h !== h && t.exp > now));
  return !!hit && hit.exp > now;
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function fmtDuration(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 10) / 100);
  return `${Math.floor(s / 60).toString().padStart(2, "0")}:${(s % 60).toFixed(2).padStart(5, "0")}`;
}

export function createSaveStore({
  dir = process.env.PPV_SAVE_DIR || join(homedir(), "pingpong-vision-saves"),
  keyFile = process.env.PPV_KEY_FILE || join(homedir(), ".config/pingpong-vision/upload-key"),
  setupFile = process.env.PPV_SETUP_FILE || join(homedir(), ".config/pingpong-vision/setup-tokens.json"),
  maxVideoBytes = 200 * 1024 * 1024,
  maxRecordBytes = 1024 * 1024,
  maxItems = 300,
  maxTotalBytes = 5 * 1024 * 1024 * 1024,
  maxPerHour = 60,
  now = () => Date.now(),
} = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const key = Buffer.from(loadOrCreateKey(keyFile));
  const recent = [];

  const authorized = (req) => {
    const got = Buffer.from(req.headers.get("x-ppv-key") || "");
    return got.length === key.length && timingSafeEqual(got, key);
  };
  const items = () => readdirSync(dir).filter((n) => ID_RE.test(n));
  const usage = () => {
    let bytes = 0;
    for (const id of items()) for (const f of readdirSync(join(dir, id))) bytes += statSync(join(dir, id, f)).size;
    return bytes;
  };
  const videoFile = (id) => {
    const d = join(dir, id);
    const f = existsSync(d) ? readdirSync(d).find((n) => n.startsWith("video.")) : null;
    return f ? join(d, f) : null;
  };

  async function upload(req) {
    if (!authorized(req)) return json(401, { error: "upload key" });
    const t = now();
    while (recent.length && t - recent[0] > 3600_000) recent.shift();
    if (recent.length >= maxPerHour) return json(429, { error: "too many uploads this hour" });
    if (items().length >= maxItems) return json(507, { error: "too many saved rallies; delete some" });
    const length = Number(req.headers.get("content-length") || 0);
    if (length > maxVideoBytes + maxRecordBytes + 64 * 1024) return json(413, { error: "too large" });
    let form;
    try {
      form = await req.formData();
    } catch {
      return json(400, { error: "multipart form expected" });
    }
    const recordText = form.get("record");
    const video = form.get("video");
    if (typeof recordText !== "string" || recordText.length > maxRecordBytes) return json(400, { error: "record" });
    let record;
    try {
      record = JSON.parse(recordText);
    } catch {
      return json(400, { error: "record is not JSON" });
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) return json(400, { error: "record" });
    if (!video || typeof video === "string") return json(415, { error: "video must be video/mp4 or video/webm" });
    if (video.size > maxVideoBytes) return json(413, { error: "video size" });
    const bytes = new Uint8Array(await video.arrayBuffer());
    const type = sniffVideo(bytes);
    if (!type) return json(415, { error: "video must be video/mp4 or video/webm" });
    if (usage() + video.size > maxTotalBytes) return json(507, { error: "storage full; delete some" });
    const id = randomBytes(32).toString("base64url");
    const d = join(dir, id);
    mkdirSync(d, { mode: 0o700 });
    chmodSync(d, 0o700);
    const saved = { ...record, savedAt: new Date(t).toISOString(), videoType: type, videoBytes: video.size };
    writeFileSync(join(d, "record.json"), JSON.stringify(saved), { mode: 0o600 });
    writeFileSync(join(d, `video.${VIDEO_TYPES[type]}`), bytes, { mode: 0o600 });
    recent.push(t);
    return json(201, { id, share: `s/${id}` });
  }

  function remove(req, id) {
    if (!authorized(req)) return json(401, { error: "upload key" });
    const d = join(dir, id);
    if (!existsSync(d)) return json(404, { error: "not found" });
    rmSync(d, { recursive: true, force: true });
    return new Response(null, { status: 204 });
  }

  function sharePage(id) {
    const d = join(dir, id);
    if (!existsSync(join(d, "record.json"))) return null;
    const r = JSON.parse(readFileSync(join(d, "record.json"), "utf8"));
    const stat = (k, v) => `<div class="s"><span>${k}</span><b>${escapeHtml(v)}</b></div>`;
    const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>핑퐁 비전 랠리</title><link rel="preload" href="../../fonts/Galmuri11.woff2" as="font" type="font/woff2" crossorigin>
<style>@font-face{font-family:G;src:url(../../fonts/Galmuri11.woff2) format("woff2")}body{margin:0;background:#0b1634;color:#f2f6ff;font:16px G,monospace}
main{max-width:960px;margin:0 auto;padding:16px}video{width:100%;background:#000;border:3px solid #000;box-shadow:4px 4px 0 #000}
.row{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.s{background:#13224d;border:2px solid #000;box-shadow:3px 3px 0 #000;padding:8px 12px}
.s span{display:block;color:#a3afcb;font-size:11px}.s b{font-size:22px}h1{font-size:22px;margin:4px 0 12px}p{color:#a3afcb;font-size:11px}</style></head>
<body><main><h1>RALLY ${escapeHtml(new Date(r.startedAt || r.savedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }))}</h1>
<video src="${id}/video" controls playsinline preload="metadata"></video>
<div class="row">${stat("RALLY TIME", fmtDuration(r.durationMs))}${stat("SHOTS", r.shots ?? "--")}${stat("MAX SPEED", r.maxSpeedKmh == null ? "--" : `~${r.maxSpeedKmh} km/h`)}${stat("BOUNCES", (r.bounces || []).length)}</div>
<p>속도·거리는 화면 기반 추정치예요. 이 링크를 아는 사람만 볼 수 있어요.</p></main></body></html>`;
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
  }

  function videoResponse(req, id) {
    const f = videoFile(id);
    if (!f) return null;
    const file = Bun.file(f);
    const size = file.size;
    const type = f.endsWith(".mp4") ? "video/mp4" : "video/webm";
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") || "");
    if (m && (m[1] || m[2])) {
      const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
      const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start >= size || start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
      return new Response(file.slice(start, end + 1), { status: 206, headers: { "content-type": type, "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${size}`, "cache-control": "no-store" } });
    }
    return new Response(file, { headers: { "content-type": type, "accept-ranges": "bytes", "cache-control": "no-store" } });
  }

  // path is the request path without the /vision mount. Returns null when the path is not ours.
  async function handle(req, path) {
    if (path === "/api/key-check" && req.method === "GET") return authorized(req) ? new Response(null, { status: 204 }) : json(401, { error: "upload key" });
    if (path === "/api/setup" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (!redeemSetupToken({ tokenFile: setupFile, token: body && body.token, now: now() })) return json(404, { error: "setup link used or expired" });
      return new Response(JSON.stringify({ key: key.toString() }), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
    }
    if (path === "/api/rallies" && req.method === "POST") return upload(req);
    let m = /^\/api\/rallies\/([^/]+)$/.exec(path);
    if (m && req.method === "DELETE") return ID_RE.test(m[1]) ? remove(req, m[1]) : json(404, { error: "not found" });
    m = /^\/s\/([^/]+)(\/video)?$/.exec(path);
    if (m && (req.method === "GET" || req.method === "HEAD")) {
      const res = ID_RE.test(m[1]) ? (m[2] ? videoResponse(req, m[1]) : sharePage(m[1])) : null;
      return res || new Response("not found\n", { status: 404 });
    }
    if (path.startsWith("/api/") || path.startsWith("/s/")) return new Response("not found\n", { status: 404 });
    return null;
  }

  return { handle, dir, keyFile, setupFile };
}
