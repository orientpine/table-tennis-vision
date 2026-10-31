// What the server does with a write from a spectator device (isolated servers). The role lives only
// on the device, so the PIN is the boundary: without it every write is refused; with it the server
// cannot tell a spectator from a referee. Records status codes and that the state did not move.
//   bun qa/viewer-api.mjs --vision=<checkout> --tournament=<checkout> --clip=<webm> [--port=9660]
import { startOneApp } from "./one-app-harness.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const app = await startOneApp({ vision: args.vision, tournament: args.tournament, clip: args.clip, port: Number(args.port || 9660) });
const send = async (path, body, headers = {}) => (await fetch(app.origin + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })).status;
const state = () => fetch(app.origin + "/api/state").then((r) => r.json());
const rows = [];
try {
  const start = await state();
  const first = start.derived.matches.find((x) => x.id === app.matchId);
  const withPin = await send("/api/action", { type: "point", matchId: first.id, side: 0, seq: first.points.length }, { "x-pin": app.pin });
  const before = await state();
  const m = before.derived.matches.find((x) => x.id === app.matchId);
  const writes = [
    ["point", "/api/action", { type: "point", matchId: m.id, side: 0, seq: m.points.length }],
    ["undo", "/api/action", { type: "undo", matchId: m.id, seq: m.points.length }],
    ["rename", "/api/action", { type: "rename", index: 0, name: "시험" }],
    ["camera approve", "/api/vision/approve", { id: "b".repeat(64) }],
    ["new tournament", "/api/tournament", { name: "시험", players: ["a", "b"], format: "single", bestOf: 3 }],
  ];
  for (const [name, path, body] of writes) rows.push({ name, noPin: await send(path, body), wrongHeader: await send(path, body, { "x-vision-token": "x".repeat(43) }) });
  const after = await state();
  const moved = after.rev !== before.rev;
  const refused = rows.every((r) => r.noPin >= 400 && r.wrongHeader >= 400);
  console.log(JSON.stringify(rows));
  console.log(`VIEWER_API noPinRefused=${refused} revMoved=${moved} samePinFromAnyRole=${withPin}`);
  process.exitCode = refused && !moved ? 0 : 1;
} finally {
  await app.stop();
}
