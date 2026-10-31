// Every long list in the one app: head with name and count (44 px+), fold, unfold, remembered after a
// reload, Enter on the focused head (keyboard, TV remote), over 10 rows shows 5 until 전체 n개 보기.
//   bun qa/list-fold.mjs --vision=<checkout> --tournament=<checkout> --clip=<webm> --out=<dir> [--port=9990] [--engine=chromium]
import { chromium, devices, webkit } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { startCamera, startOneApp, fakeCamera } from "./one-app-harness.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const out = args.out || "evidence/list-fold";
mkdirSync(out, { recursive: true });
const app = await startOneApp({ vision: args.vision, tournament: args.tournament, clip: args.clip, port: Number(args.port || 9990) });
const players = Array.from({ length: 8 }, (_, i) => `선수${i + 1}`);
let pin = app.pin;
const create = async (body) => { const r = await app.api("/api/tournament", body, { "x-pin": pin }); if (!r.state) throw new Error(JSON.stringify(r)); pin = r.pin || pin; };
const state = () => app.api("/api/state");
const playMatches = async (count) => {
  for (let k = 0; k < count; k++) {
    const st = await state();
    const m = st.derived.matches.find((x) => x.status === "ready" || x.status === "live");
    if (!m) throw new Error(`no playable match at ${k}: ${JSON.stringify(st.derived.matches.map((x) => x.status))} ${st.tournament?.name}`);
    for (let seq = m.points?.length || 0; ; seq++) {
      const res = await app.api("/api/action", { type: "point", matchId: m.id, side: 0, seq }, { "x-pin": pin });
      const now = res.state?.derived.matches.find((x) => x.id === m.id) || (await state()).derived.matches.find((x) => x.id === m.id);
      if (now.status === "done") break;
    }
  }
};
await create({ name: "긴 대회", players, format: "double", bestOf: 3 });
await playMatches(12);
for (let i = 0; i < 11; i++) await create({ name: `지난 ${i}`, players: ["가", "나", "다", "라"], format: "double", bestOf: 3 });
await create({ name: "지금 대회", players, format: "double", bestOf: 3 });
await playMatches(3);
const live = (await state()).derived.matches.find((x) => x.status === "ready");
for (let seq = 0; seq < 12; seq++) await app.api("/api/action", { type: "point", matchId: live.id, side: seq % 2 ? 0 : 1, seq }, { "x-pin": pin });

const browser = args.engine === "webkit" ? await webkit.launch(process.env.PPV_WEBKIT ? { executablePath: process.env.PPV_WEBKIT } : {}) : await chromium.launch();
const fails = [];
let checks = 0;
const check = (name, ok, detail) => { checks++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : " " + JSON.stringify(detail)}`); if (!ok) fails.push(name); };
const rowsTable = [];
const openPage = async () => {
  const ctx = await browser.newContext({ ...devices["iPhone 15"], viewport: { width: 393, height: 852 } });
  await ctx.addInitScript(fakeCamera, app.origin + "/__qa/cam.webm");
  await ctx.addInitScript((p) => { if (location.origin === "null") return; sessionStorage.setItem("pp-started", "1"); if (!localStorage.getItem("pp-role")) { localStorage.setItem("pp-role", "referee"); localStorage.setItem("pp-pin", p); localStorage.setItem("pp-sound", "0"); } }, pin);
  const page = await ctx.newPage();
  await page.goto(app.origin + "/");
  await page.waitForSelector("nav.nav button");
  return { ctx, page };
};
const tab = (page, t) => page.locator("nav.nav button", { hasText: t }).click();
// the oldest tournament sits past the short window of the record list
const openLong = async (p) => {
  const more = p.locator('[data-act="fold-all"][data-key="history"]', { hasText: "전체" });
  if (await more.count()) await more.click();
  await p.locator('[data-act="hist-open"]', { hasText: "긴 대회" }).click();
  await p.waitForSelector(".hist-bar");
};
const LONG = new Set(["rallies", "history", "hist-matches"]);
const LISTS = [
  ["랠리 다시 보기", "rallies", "경기", ".clip-list li", async () => {}],
  ["대진 승자조", "bracket-W", "대진", ".group:has([data-key='bracket-W']) .mcard", async () => {}],
  ["순위", "standings", "순위", ".standing", async () => {}],
  ["기록 목록", "history", "기록", ".hcard", async () => {}],
  ["기록 상세 순위", "hist-rank", "기록", ".card:has([data-key='hist-rank']) .kv > span:nth-child(odd)", openLong],
  ["기록 상세 경기 결과", "hist-matches", "기록", ".group:has([data-key='hist-matches']) .mcard", openLong],
  ["참가자 이름 수정", "rename", "설정", "[data-rename]", async () => {}],
  ["새 대회 참가자", "seeds", "설정", ".seed", async (p) => { await p.locator('[data-act="setup-new"]').click(); await p.locator('dialog [data-ask="1"]').click(); await p.waitForSelector("[data-act='seed-add']"); }],
];
try {
  const { ctx, page } = await openPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  for (const [name, key, t, rowSel, reach] of LISTS) {
    const head = `[data-act="fold"][data-key="${key}"]`;
    const role = key === "rallies" ? "viewer" : "referee"; // the rally list is the spectator's
    await page.evaluate((r) => localStorage.setItem("pp-role", r), role);
    await page.reload();
    await page.waitForSelector("nav.nav button");
    const go = async () => { await tab(page, "경기"); await tab(page, t); await reach(page); await page.waitForSelector(head); };
    await go();
    const box = await page.locator(head).boundingBox();
    const text = (await page.locator(head).innerText()).replace(/\s+/g, " ");
    check(`${name}: 머리줄 44px+ 이름과 개수`, box.height >= 44 && box.width >= 44 && /\d/.test(text), { box, text });
    const n0 = await page.locator(rowSel).count();
    const more = page.locator(`[data-act="fold-all"][data-key="${key}"]`);
    const isLong = (await more.count()) > 0;
    let total = n0;
    if (LONG.has(key)) {
      check(`${name}: 10줄 넘으면 5줄과 전체 n개 보기`, isLong && n0 === 5 && /전체 \d+개 보기/.test(await more.innerText().catch(() => "")), { n0 });
      total = Number((await more.innerText()).match(/\d+/)[0]);
      await more.click();
      check(`${name}: 전체 ${total}개로 펼침`, total > 10 && (await page.locator(rowSel).count()) === total, { got: await page.locator(rowSel).count() });
    } else check(`${name}: 10줄 이하는 전부 보임`, !isLong && n0 > 0 && n0 <= 10, { n0 });
    await page.locator(head).click();
    check(`${name}: 접힘`, (await page.locator(rowSel).count()) === 0 && (await page.locator(head).getAttribute("aria-expanded")) === "false", {});
    await page.reload(); await page.waitForSelector("nav.nav button"); await go();
    check(`${name}: 새로고침 뒤 접힘 기억`, (await page.locator(rowSel).count()) === 0, {});
    await page.locator(head).focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction((h) => document.querySelector(h)?.getAttribute("aria-expanded") === "true", head);
    check(`${name}: 키보드 Enter로 펼침, 포커스 유지`, (await page.locator(rowSel).count()) > 0 && await page.evaluate((h) => document.activeElement === document.querySelector(h), head), {});
    await page.screenshot({ path: `${out}/${key}.png` });
    rowsTable.push({ name, key, total });
  }
  // the camera's own 랠리 기록 sheet
  await page.evaluate(() => { localStorage.setItem("pp-role", "camera"); });
  await page.goto(app.origin + "/vision/");
  await page.waitForFunction(() => window.__ppv, null, { timeout: 20000 });
  await startCamera(page);
  const seedRallies = () => page.evaluate(() => { const s = window.__ppv.state; s.history = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, startedAt: Date.now() - i * 60000, durationMs: 4000, shots: 5, bounces: [] })); });
  const openSheet = async () => { await seedRallies(); await page.getByRole("button", { name: /^기록/ }).click(); await page.waitForSelector(".sheet:not([hidden]) .fold-head"); };
  await openSheet();
  const sh = page.locator(".sheet .fold-head");
  check("비전 랠리 기록: 머리줄 44px+ 개수", (await sh.boundingBox()).height >= 44 && /12개/.test(await sh.innerText()), {});
  check("비전 랠리 기록: 5줄과 전체 12개 보기", (await page.locator(".rally").count()) === 5 && /전체 12개 보기/.test(await page.locator(".fold-more").innerText()), {});
  await page.locator(".fold-more").click();
  check("비전 랠리 기록: 12줄 펼침", (await page.locator(".rally").count()) === 12, {});
  await sh.click();
  check("비전 랠리 기록: 접힘", (await page.locator(".rally").count()) === 0, {});
  await page.reload();
  await page.waitForFunction(() => window.__ppv, null, { timeout: 20000 });
  await startCamera(page);
  await openSheet();
  check("비전 랠리 기록: 새로고침 뒤 접힘 기억", (await page.locator(".rally").count()) === 0, {});
  await sh.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".sheet .fold-head")?.getAttribute("aria-expanded") === "true");
  check("비전 랠리 기록: 키보드 Enter로 펼침, 포커스 유지", (await page.locator(".rally").count()) > 0 && await page.evaluate(() => document.activeElement?.classList.contains("fold-head")), {});
  await page.screenshot({ path: `${out}/vision-rallies.png` });
  check("페이지 오류 0", errors.length === 0, errors);
  await ctx.close();
} finally {
  await browser.close().catch(() => {});
  await app.stop();
}
writeFileSync(`${out}/lists.json`, JSON.stringify(rowsTable, null, 2));
console.log(`LIST_FOLD checks=${checks} fails=${fails.length}`);
process.exit(fails.length ? 1 : 0);
