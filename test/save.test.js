import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSaveStore, createSetupToken } from "../save-server.js";

const mp4 = (n = 100) => {
  const b = new Uint8Array(n);
  b.set([0x66, 0x74, 0x79, 0x70], 4);
  return new Blob([b], { type: "video/mp4" });
};

let root;
let store;
let key;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "ppv-save-"));
  store = createSaveStore({ dir: join(root, "saves"), keyFile: join(root, "cfg/upload-key"), maxVideoBytes: 1000, maxItems: 2 });
  key = (await Bun.file(join(root, "cfg/upload-key")).text()).trim();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const upload = (k, { record = { shots: 4, durationMs: 3200, bounces: [{ tx: 1, ty: 0.5, side: "far" }] }, video = mp4() } = {}) => {
  const form = new FormData();
  form.set("record", typeof record === "string" ? record : JSON.stringify(record));
  if (video) form.set("video", video, "rally");
  return store.handle(new Request("http://x/api/rallies", { method: "POST", headers: k ? { "x-ppv-key": k } : {}, body: form }), "/api/rallies");
};
const get = (path, headers = {}) => store.handle(new Request(`http://x${path}`, { headers }), path);
const del = (id, k) => store.handle(new Request(`http://x/api/rallies/${id}`, { method: "DELETE", headers: k ? { "x-ppv-key": k } : {} }), `/api/rallies/${id}`);

test("upload with the key -> share page and video by link only -> delete with the key", async () => {
  const res = await upload(key);
  expect(res.status).toBe(201);
  const { id, share } = await res.json();
  expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(share).toBe(`s/${id}`);

  const page = await get(`/s/${id}`);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain(`${id}/video`);
  const video = await get(`/s/${id}/video`, { range: "bytes=0-9" });
  expect(video.status).toBe(206);
  expect(video.headers.get("content-type")).toBe("video/mp4");
  expect((await video.arrayBuffer()).byteLength).toBe(10);

  const d = join(store.dir, id);
  expect(statSync(store.dir).mode & 0o777).toBe(0o700);
  expect(statSync(d).mode & 0o777).toBe(0o700);
  for (const f of readdirSync(d)) expect(statSync(join(d, f)).mode & 0o777).toBe(0o600);

  expect((await del(id, "wrong")).status).toBe(401);
  expect((await del(id, key)).status).toBe(204);
  expect((await get(`/s/${id}`)).status).toBe(404);
  expect((await get(`/s/${id}/video`)).status).toBe(404);
});

test("no key, a wrong key, or a bad body is refused; nothing is listed", async () => {
  expect((await upload(null)).status).toBe(401);
  expect((await upload(`${key}x`)).status).toBe(401);
  expect((await upload(key, { record: "not json" })).status).toBe(400);
  expect((await upload(key, { video: null })).status).toBe(415);
  expect((await upload(key, { video: new Blob(["just text, typed as video"], { type: "video/mp4" }) })).status).toBe(415);
  expect((await upload(key, { video: mp4(2000) })).status).toBe(413);
  expect((await get("/s/")).status).toBe(404);
  expect((await get("/api/rallies")).status).toBe(404);
  expect((await get("/s/short")).status).toBe(404);
  expect((await get("/api/key-check", { "x-ppv-key": key })).status).toBe(204);
  expect((await get("/api/key-check", { "x-ppv-key": "nope" })).status).toBe(401);
  expect(readdirSync(store.dir)).toEqual([]);
});

test("the saved-rally count is capped", async () => {
  expect((await upload(key)).status).toBe(201);
  expect((await upload(key)).status).toBe(201);
  expect((await upload(key)).status).toBe(507);
});

test("paths outside the save API fall through to the static server", async () => {
  expect(await get("/index.html")).toBeNull();
  expect(await get("/js/app.js")).toBeNull();
});

test("a one-time setup link gives the upload key once, then 404; an expired one gives 404", async () => {
  const setupFile = join(root, "cfg/setup-tokens.json");
  const s = createSaveStore({ dir: join(root, "saves2"), keyFile: join(root, "cfg/upload-key"), setupFile });
  const redeem = (token) => s.handle(new Request("http://x/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) }), "/api/setup");
  const { token } = createSetupToken({ tokenFile: setupFile });
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(await Bun.file(setupFile).text()).not.toContain(token);
  expect(statSync(setupFile).mode & 0o777).toBe(0o600);
  const first = await redeem(token);
  expect(first.status).toBe(200);
  expect((await first.json()).key).toBe(key);
  expect((await redeem(token)).status).toBe(404);
  expect((await redeem("x".repeat(43))).status).toBe(404);
  const old = createSetupToken({ tokenFile: setupFile, now: Date.now() - 11 * 60 * 1000 });
  expect((await redeem(old.token)).status).toBe(404);
});

// PC save by tournament PIN. A stand-in for the tournament's /api/pin/verify holds the real rule
// (PIN compare, 5 fails then 429 per client address); tournament.json is the file the live app writes.
function pinRig({ pin = "1234", maxItems = 2, maxVideoBytes = 1000 } = {}) {
  const dataFile = join(root, "tournament.json");
  const setPin = (p) => writeFileSync(dataFile, JSON.stringify({ rev: 7, pin: p }));
  setPin(pin);
  const fails = new Map();
  const seen = [];
  const upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const ip = req.headers.get("x-forwarded-for");
      seen.push(ip);
      if ((fails.get(ip) || 0) >= 5) return Response.json({ error: "locked" }, { status: 429 });
      const body = await req.json();
      if (body.pin === JSON.parse(readFileSync(dataFile, "utf8")).pin) return Response.json({ ok: true });
      fails.set(ip, (fails.get(ip) || 0) + 1);
      return Response.json({ error: "wrong" }, { status: 403 });
    },
  });
  const s = createSaveStore({ dir: join(root, "pin-saves"), keyFile: join(root, "cfg/upload-key"), maxVideoBytes, maxItems, tournamentUrl: `http://127.0.0.1:${upstream.port}`, tournamentData: dataFile });
  const savePin = (p, ip = "198.51.100.1", peer = "127.0.0.1", extra = {}) => s.handle(new Request("http://x/api/pin-save", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip, ...extra }, body: JSON.stringify({ pin: p }) }), "/api/pin-save", peer);
  const check = (k) => s.handle(new Request("http://x/api/key-check", { headers: { "x-ppv-key": k } }), "/api/key-check");
  const post = (k, video = mp4()) => {
    const form = new FormData();
    form.set("record", "{}");
    form.set("video", video, "rally");
    return s.handle(new Request("http://x/api/rallies", { method: "POST", headers: { "x-ppv-key": k }, body: form }), "/api/rallies");
  };
  const remove = (k, id) => s.handle(new Request(`http://x/api/rallies/${id}`, { method: "DELETE", headers: { "x-ppv-key": k } }), `/api/rallies/${id}`);
  return { s, setPin, seen, savePin, check, post, remove, stop: () => upstream.stop(true) };
}

test("the right PIN gives this browser its own save token, never the upload key", async () => {
  const r = pinRig();
  const res = await r.savePin("1234");
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).not.toContain(key);
  const { token } = JSON.parse(text);
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect((await r.check(token)).status).toBe(204);
  const up = await r.post(token);
  expect(up.status).toBe(201);
  expect((await r.remove(token, (await up.json()).id)).status).toBe(204);
  const disk = readFileSync(join(root, "cfg/save-grants.json"), "utf8");
  expect(disk).not.toContain(token);
  expect(disk).not.toContain("1234");
  expect(statSync(join(root, "cfg/save-grants.json")).mode & 0o777).toBe(0o600);
  r.stop();
});

test("a wrong or locked PIN gets 401 and no token, on the caller's own lockout count", async () => {
  const r = pinRig();
  for (let i = 0; i < 5; i++) {
    const res = await r.savePin("0000", "198.51.100.9");
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "pin" });
  }
  const locked = await r.savePin("1234", "198.51.100.9");
  expect(locked.status).toBe(401);
  const body = await locked.json();
  expect(body.code).toBe("locked");
  expect(body.token).toBeUndefined();
  expect(r.seen.at(-1)).toBe("198.51.100.9");
  expect((await r.savePin("1234", "198.51.100.2")).status).toBe(200);
  expect((await r.check("x".repeat(43))).status).toBe(401);
  r.stop();
});

test("the tournament app hears only the address this server saw: tailscale's last hop from 127.0.0.1, else the caller itself", async () => {
  const r = pinRig();
  await r.savePin("0000", "6.6.6.6, 203.0.113.7", "127.0.0.1", { "cf-connecting-ip": "9.9.9.9" });
  expect(r.seen.at(-1)).toBe("203.0.113.7");
  await r.savePin("0000", "203.0.113.8", "203.0.113.50", { "cf-connecting-ip": "9.9.9.9" });
  expect(r.seen.at(-1)).toBe("203.0.113.50");
  await r.s.handle(new Request("http://x/api/pin-save", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "9.9.9.9" }, body: JSON.stringify({ pin: "0000" }) }), "/api/pin-save", "127.0.0.1");
  expect(r.seen.at(-1)).toBe("127.0.0.1");
  r.stop();
});

test("a PIN change cuts tokens from the old PIN but not the upload key; the new PIN works", async () => {
  const r = pinRig();
  const { token } = await (await r.savePin("1234")).json();
  const { id } = await (await r.post(token)).json();
  r.setPin("5678");
  expect((await r.check(token)).status).toBe(401);
  expect((await r.post(token)).status).toBe(401);
  expect((await r.remove(token, id)).status).toBe(401);
  expect((await r.check(key)).status).toBe(204);
  expect((await r.savePin("1234")).status).toBe(401);
  const { token: fresh } = await (await r.savePin("5678")).json();
  expect((await r.check(fresh)).status).toBe(204);
  r.setPin("1234");
  expect((await r.check(fresh)).status).toBe(401);
  r.stop();
});

test("no readable tournament data or no tournament server turns PIN saves off, not on", async () => {
  const r = pinRig();
  const { token } = await (await r.savePin("1234")).json();
  rmSync(join(root, "tournament.json"));
  expect((await r.check(token)).status).toBe(401);
  r.setPin("1234");
  r.stop();
  expect((await r.savePin("1234")).status).toBe(503);
  expect((await r.check(key)).status).toBe(204);
});

test("a PIN token keeps the same size and count caps", async () => {
  const r = pinRig({ maxItems: 1, maxVideoBytes: 1000 });
  const { token } = await (await r.savePin("1234")).json();
  expect((await r.post(token, mp4(2000))).status).toBe(413);
  expect((await r.post(token)).status).toBe(201);
  expect((await r.post(token)).status).toBe(507);
  r.stop();
});


test("a test server with no PPV_TOURNAMENT_URL has PIN save off (503) instead of defaulting to the live tournament", async () => {
  const was = { url: process.env.PPV_TOURNAMENT_URL, qa: process.env.PPV_QA };
  delete process.env.PPV_TOURNAMENT_URL;
  process.env.PPV_QA = "1";
  try {
    const s = createSaveStore({ dir: join(root, "guard"), keyFile: join(root, "cfg/upload-key") });
    const res = await s.handle(new Request("http://x/api/pin-save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: "1234" }) }), "/api/pin-save", "127.0.0.1");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain("PPV_TOURNAMENT_URL is not set");
    expect(body.token).toBeUndefined();
  } finally {
    if (was.url === undefined) delete process.env.PPV_TOURNAMENT_URL; else process.env.PPV_TOURNAMENT_URL = was.url;
    if (was.qa === undefined) delete process.env.PPV_QA; else process.env.PPV_QA = was.qa;
  }
});
