import { afterEach, beforeEach, expect, test } from "bun:test";
import { TournamentLink, sideLabel } from "../public/js/tournament.js";

// A stand-in for the tournament server's /api: one live match, PIN 1234, the same seq rule.
let points;
let clips;
let endsFlip;
let calls;
const realFetch = globalThis.fetch;
// The same score shape as the tournament's scoreMatch (11 points, win by 2, best of 3).
function scoreOf(pts) {
  const games = [];
  const won = [0, 0];
  let cur = [0, 0];
  let lastGame = null;
  let winner = null;
  let decider = false;
  pts.forEach((p, i) => {
    if (winner !== null) return;
    const top = Math.max(cur[0], cur[1]);
    cur[p]++;
    if (won[0] === 1 && won[1] === 1 && top < 5 && cur[p] >= 5) decider = true;
    if (cur[p] >= 11 && cur[p] - cur[1 - p] >= 2) {
      games.push({ a: cur[0], b: cur[1], winner: p });
      won[p]++;
      if (i === pts.length - 1) lastGame = { no: games.length, a: cur[0], b: cur[1], winner: p };
      cur = [0, 0];
      if (won[p] === 2) winner = p;
    }
  });
  return { games, won, current: { a: cur[0], b: cur[1] }, winner, gameNo: games.length + 1, need: 2, lastGame, endSwitches: games.length - (winner === null ? 0 : 1) + (decider ? 1 : 0) };
}
const state = () => {
  const score = scoreOf(points);
  const blue = ((endsFlip ? 1 : 0) + score.endSwitches) % 2;
  return {
    tournament: { players: ["가", "나"] },
    derived: { matches: [{ id: "m1", no: 1, players: [0, 1], status: score.winner !== null ? "done" : points.length ? "live" : "ready", points: [...points], clips: { ...clips }, score, ends: [blue, 1 - blue] }] },
  };
};
beforeEach(() => {
  points = [];
  clips = {};
  endsFlip = false;
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
      // as the tournament's undoPoint: clips past the end go with the points
      clips = Object.fromEntries(Object.entries(clips).filter(([i]) => Number(i) < points.length));
    } else if (body.type === "clip") clips[body.index] = body.url;
    else if (body.type === "ends") endsFlip = (body.blue + scoreOf(points).endSwitches) % 2 === 1;
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

test("the score is called out after each point, and 취소 is said on cancel", async () => {
  const said = [];
  const link = new TournamentLink(memStore(), () => {}, { say: (t) => said.push(t) });
  await link.connect("1234");
  await link.score({ winner: "near", label: "못 받음", sure: true });
  await link.score({ winner: "far", label: "못 받음", sure: true });
  expect(said).toEqual(["블루 사이드 1, 레드 사이드 0", "블루 사이드 1, 레드 사이드 1"]);
  await link.cancel();
  expect(said[said.length - 1]).toBe("취소");
  link.setVoice(false);
  await link.score({ winner: "near", label: "못 받음", sure: true });
  expect(said.length).toBe(3);
});

test("ends change after a game and at 5 in the deciding game; undo changes them back", async () => {
  const said = [];
  const link = new TournamentLink(memStore(), () => {}, { say: (t) => said.push(t) });
  await link.connect("1234");
  points = Array(10).fill(0);
  link.setNear(0);
  await link.score({ winner: "near", label: "못 받음", sure: true });
  expect(said.at(-1)).toBe("블루 1게임 승리. 게임 1 대 0. 엔드를 바꾸세요");
  expect(link.view().near).toBe(0);
  expect(link.view().match.ends).toEqual([1, 0]);
  await link.cancel();
  expect(link.view().match.ends).toEqual([0, 1]);
  points = [...Array(11).fill(0), ...Array(11).fill(1), 0, 0, 0, 0];
  await link.score({ winner: "near", label: "못 받음", sure: true });
  expect(said.at(-1)).toBe("블루 사이드 5, 레드 사이드 0. 엔드를 바꾸세요");
  expect(link.view().match.ends).toEqual([1, 0]);
  // 가 (5 points) now stands at the red end, the far end from this camera
  await link.score({ winner: "far", label: "못 받음", sure: true });
  expect(points.at(-1)).toBe(0);
  expect(said.at(-1)).toBe("블루 사이드 0, 레드 사이드 6");
});

test("렛? confirmed: the auto-entered point is undone and nothing else is entered", async () => {
  const said = [];
  const link = new TournamentLink(memStore(), () => {}, { say: (t) => said.push(t) });
  await link.connect("1234");
  const entry = await link.score({ winner: "near", label: "못 받음", sure: true }, { fault: true, let: true, server: "near" });
  expect(link.view().pending.suspect).toMatchObject({ let: true, fault: true, server: 0 });
  await link.confirmLet();
  expect(points).toEqual([]);
  expect(said.at(-1)).toBe("렛, 다시 서브");
  await link.attachClip(entry, "/vision/s/clip");
  expect(clips).toEqual({});
});

test("폴트? confirmed: the receiver gets the point and the clip follows the new entry", async () => {
  const said = [];
  const link = new TournamentLink(memStore(), () => {}, { say: (t) => said.push(t) });
  await link.connect("1234");
  const entry = await link.score({ winner: "near", label: "못 받음", sure: true }, { fault: true, let: false, server: "near" });
  expect(points).toEqual([0]);
  await link.confirmFault();
  expect(points).toEqual([1]);
  expect(said.at(-1)).toBe("서브 폴트. 블루 사이드 0, 레드 사이드 1");
  await link.attachClip(entry, "/vision/s/clip");
  expect(clips).toEqual({ 0: "/vision/s/clip" });
});

test("no suspicion buttons unless a signal fired", async () => {
  const link = new TournamentLink(memStore());
  await link.connect("1234");
  await link.score({ winner: "near", label: "못 받음", sure: true }, { fault: false, let: false, server: "near" });
  expect(link.view().pending.suspect).toBeNull();
});

// The owner's one-phone scene: the camera phone (holding the PIN) fixes the score without leaving the camera screen.
test("a point two back goes to the other side in one fix; later points and their clips stay", async () => {
  const link = new TournamentLink(memStore());
  await link.connect("1234");
  points.push(0, 1, 0, 1);
  clips = { 2: "/vision/s/a", 3: "/vision/s/b" };
  await link.refresh();
  expect(link.view().fix).toMatchObject({ can: true, target: { id: "m1", log: [0, 1, 0, 1] } });
  await link.fix("flip", 2);
  expect(points).toEqual([0, 1, 1, 1]);
  expect(clips).toEqual({ 2: "/vision/s/a", 3: "/vision/s/b" });
  expect(link.view().fix.busy).toBe(false);
});

test("+1 and 되돌리기 from the camera screen", async () => {
  const said = [];
  const link = new TournamentLink(memStore(), () => {}, { say: (t) => said.push(t) });
  await link.connect("1234");
  await link.fix("plus", 1);
  expect(points).toEqual([1]);
  expect(said.at(-1)).toBe("점수 고침. 블루 사이드 0, 레드 사이드 1");
  await link.fix("undo");
  expect(points).toEqual([]);
});

test("a game ended by a wrong point is fixed in one tap and the ends change back", async () => {
  const link = new TournamentLink(memStore());
  await link.connect("1234");
  points.push(...Array(9).fill(0), ...Array(9).fill(1), 0, 0);
  await link.refresh();
  expect(link.view().fix.target.ends).toEqual([1, 0]);
  await link.fix("flip", 19);
  expect(points.length).toBe(20);
  expect(scoreOf(points)).toMatchObject({ games: [], current: { a: 10, b: 10 } });
  expect(link.view().match.ends).toEqual([0, 1]);
});

test("a phone without the PIN writes nothing, and a camera token left from the old referee approval is forgotten", async () => {
  const store = memStore();
  store.set("tourToken", "camera-token");
  const link = new TournamentLink(store);
  expect(store.get("tourToken", null)).toBeNull();
  expect(link.view()).toMatchObject({ connected: false, approval: null, fix: { can: false } });
  expect(await link.fix("plus", 0)).toBeNull();
  expect(await link.score({ winner: "near", label: "못 받음", sure: true })).toBeNull();
  expect(calls.filter((c) => c.body && c.body.type)).toEqual([]);
});

test("the PIN typed on the camera is the same device memory as 심판 (pp-pin); a refused PIN is dropped from both", async () => {
  const mem = new Map();
  const was = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  try {
    const link = new TournamentLink(memStore());
    await link.connect("1234");
    expect(mem.get("pp-pin")).toBe("1234");
    link.pin = "9999";
    await link.fix("plus", 0);
    expect(points).toEqual([]);
    expect(link.view().connected).toBe(false);
    expect(mem.has("pp-pin")).toBe(false);
    expect(link.view().error).toContain("PIN");
  } finally {
    globalThis.localStorage = was;
  }
});

test("an auto point judged during a hand fix waits for it, so neither write is lost", async () => {
  const link = new TournamentLink(memStore());
  await link.connect("1234");
  link.setMode("all");
  points.push(0, 1, 0);
  await link.refresh();
  const fixing = link.fix("flip", 0);
  const auto = link.score({ winner: "near", label: "못 받음", sure: true });
  await Promise.all([fixing, auto]);
  expect(points).toEqual([1, 1, 0, 0]);
  expect(link.view().error).toBeNull();
});

test("a recent-point tap that no longer matches the score (it moved since the screen drew) changes nothing", async () => {
  const link = new TournamentLink(memStore());
  await link.connect("1234");
  points.push(0, 1);
  await link.fix("flip", 1, 0);
  expect(points).toEqual([0, 1]);
  expect(link.view().error).toContain("다시 눌러");
});

test("a PIN changed on the tournament app drops the stale one after the first refusal, so a camera does not lock the venue out", async () => {
  const store = memStore();
  const link = new TournamentLink(store);
  await link.connect("1234");
  const inner = globalThis.fetch;
  let refused = 0;
  globalThis.fetch = async (url, opts = {}) => {
    if (url === "/api/action" && opts.headers["x-pin"] === "1234") {
      refused++;
      return new Response(JSON.stringify({ error: "PIN이 맞지 않습니다." }), { status: 403 });
    }
    return inner(url, opts);
  };
  expect(await link.score({ winner: "near", label: "두 번 튐", sure: true })).toBeNull();
  expect(await link.score({ winner: "near", label: "두 번 튐", sure: true })).toBeNull();
  expect(refused).toBe(1);
  expect(points).toEqual([]);
  expect(store.get("tourPin", "unset")).toBeNull();
  expect(link.view().connected).toBe(false);
  expect(link.view().error).toContain("PIN이 바뀌었어요");
  await link.connect("5678");
  expect(link.view().connected).toBe(false);
});

// Owner (2026-10-30): red / blue are the table's two ends and stay put; 자리 교체 and the rules move the players.
test("not linked: the camera names the ends 블루 사이드 / 레드 사이드, never 나 / 상대", () => {
  const link = new TournamentLink(memStore());
  expect([sideLabel(link.view(), "near"), sideLabel(link.view(), "far")]).toEqual(["블루 사이드", "레드 사이드"]);
  link.setNear(1);
  expect([sideLabel(link.view(), "near"), sideLabel(link.view(), "far")]).toEqual(["레드 사이드", "블루 사이드"]);
});

test("linked: each end shows the match player standing there", async () => {
  const link = new TournamentLink(memStore());
  await link.connect("1234");
  link.setNear(1);
  expect([sideLabel(link.view(), "near"), sideLabel(link.view(), "far")]).toEqual(["레드 · 나", "블루 · 가"]);
});

test("자리 교체 trades the players' ends for every screen; the end colours and the near end stay", async () => {
  const told = [];
  const link = new TournamentLink(memStore(), () => {}, { onEnds: (m) => told.push(m.ends) });
  await link.connect("1234");
  expect(await link.swapEnds()).toBe(true);
  expect(endsFlip).toBe(true);
  expect(link.view().near).toBe(0);
  expect(link.colourOf("near")).toBe(0);
  expect([sideLabel(link.view(), "near"), sideLabel(link.view(), "far")]).toEqual(["블루 · 나", "레드 · 가"]);
  expect(told).toEqual([[1, 0]]);
  await link.score({ winner: "near", label: "못 받음", sure: true });
  expect(points).toEqual([1]);
});

test("the rules change ends by themselves: after a game and at 5 in the deciding game, with an 엔드 교체 signal", async () => {
  const told = [];
  const link = new TournamentLink(memStore(), () => {}, { onEnds: (m) => told.push(m.ends) });
  await link.connect("1234");
  points = Array(10).fill(0);
  await link.score({ winner: "near", label: "못 받음", sure: true });
  expect([sideLabel(link.view(), "near"), sideLabel(link.view(), "far")]).toEqual(["블루 · 나", "레드 · 가"]);
  expect(told).toEqual([[1, 0]]);
  expect(link.view().endsAt).toBeGreaterThan(0);
  points = [...Array(11).fill(0), ...Array(11).fill(1), 0, 0, 0, 0];
  await link.refresh();
  expect(sideLabel(link.view(), "near")).toBe("블루 · 가");
  await link.score({ winner: "near", label: "못 받음", sure: true });
  expect(sideLabel(link.view(), "near")).toBe("블루 · 나");
  expect(told.length).toBe(3);
});

test("a hand fix made on another screen (referee, TV) reaches the camera with the next state", async () => {
  const link = new TournamentLink(memStore());
  await link.connect("1234");
  endsFlip = true;
  await link.refresh();
  expect([sideLabel(link.view(), "near"), sideLabel(link.view(), "far")]).toEqual(["블루 · 나", "레드 · 가"]);
  await link.fix("plus", 0);
  expect(points).toEqual([1]);
});
