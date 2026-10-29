import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
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
