import { afterEach, beforeEach, expect, test } from "bun:test";
import { TournamentLink } from "../public/js/tournament.js";

// A stand-in for the tournament server's /api: one live match, PIN 1234, the same seq rule.
let points;
let clips;
let calls;
const realFetch = globalThis.fetch;
const state = () => ({
  tournament: { players: ["가", "나"] },
  derived: { matches: [{ id: "m1", no: 1, players: [0, 1], status: points.length ? "live" : "ready", points: [...points], clips: { ...clips }, score: { current: { a: points.filter((p) => p === 0).length, b: points.filter((p) => p === 1).length }, lastGame: null } }] },
});
beforeEach(() => {
  points = [];
  clips = {};
  calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, body });
    const reply = (data, status = 200) => new Response(JSON.stringify(data), { status });
    if (url === "/api/state") return reply(state());
    if (url === "/api/pin/verify") return body.pin === "1234" ? reply({ ok: true }) : reply({ error: "PIN이 맞지 않습니다." }, 403);
    if (opts.headers["x-pin"] !== "1234") return reply({ error: "PIN이 맞지 않습니다." }, 403);
    if (body.type === "point") {
      if (body.seq !== points.length) return reply({ error: "seq" }, 400);
      points.push(body.side);
    } else if (body.type === "undo") {
      if (body.seq !== points.length) return reply({ error: "seq" }, 400);
      points.pop();
    } else if (body.type === "clip") clips[body.index] = body.url;
    return reply({ ok: true, state: state() });
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
const memStore = () => {
  const m = new Map();
  return { get: (k, d) => (m.has(k) ? m.get(k) : d), set: (k, v) => m.set(k, v) };
};

test("a sure call is entered for the near player's colour and can be cancelled", async () => {
  const link = new TournamentLink(memStore());
  await link.connect("1234");
  link.setNear(1);
  const entry = await link.score({ winner: "near", label: "두 번 튐", sure: true });
  expect(points).toEqual([1]);
  expect(entry).toMatchObject({ matchId: "m1", index: 0, side: 1, name: "나" });
  await link.cancel();
  expect(points).toEqual([]);
  await link.attachClip(entry, "/vision/s/x");
  expect(clips).toEqual({});
});

test("an unsure call in sure mode waits for the referee's tap; the tapped side gets the clip", async () => {
  const link = new TournamentLink(memStore());
  await link.connect("1234");
  const scored = link.score({ winner: "far", label: "못 받음", sure: false });
  await Bun.sleep(0);
  expect(points).toEqual([]);
  expect(link.view().pending).toMatchObject({ choice: true });
  await link.pick(0);
  const entry = await scored;
  expect(points).toEqual([0]);
  await link.attachClip(entry, "/vision/s/clip");
  expect(clips).toEqual({ 0: "/vision/s/clip" });
});

test("an unsure call that nobody taps is dropped when the next rally starts", async () => {
  const link = new TournamentLink(memStore());
  await link.connect("1234");
  const scored = link.score({ winner: "far", label: "못 받음", sure: false });
  link.dropChoice();
  expect(await scored).toBeNull();
  expect(points).toEqual([]);
});

test("all-points mode enters an unsure call at once", async () => {
  const link = new TournamentLink(memStore());
  await link.connect("1234");
  link.setMode("all");
  await link.score({ winner: "far", label: "못 받음", sure: false });
  expect(points).toEqual([1]);
});

test("a wrong PIN is refused and nothing is stored", async () => {
  const store = memStore();
  const link = new TournamentLink(store);
  await link.connect("9999");
  expect(link.view()).toMatchObject({ connected: false });
  expect(link.view().error).toContain("PIN");
  expect(store.get("tourPin", null)).toBeNull();
});
