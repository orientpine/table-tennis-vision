// The production shape for UI checks: the tournament app at "/" and this app at "/vision/" behind
// one origin (WebSocket included), each with throwaway data. Prints ONE_ORIGIN_READY <url> and runs
// until killed.
//   bun qa/one-origin.mjs --vision=<checkout> --tournament=<checkout> [--port=8960] [--data=<dir>]
// (--data keeps the servers' files in a known folder: upload-key, setup.json for setup-link-e2e)
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const P = Number(args.port || 8960);
const ports = { proxy: P, tour: P + 1, vision: P + 2 };
const tmp = args.data || mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ppv-origin-"));
mkdirSync(tmp, { recursive: true });
const procs = [
  spawn("bun", [join(args.tournament, "server.js")], { cwd: args.tournament, env: { ...process.env, PORT: String(ports.tour), DATA_DIR: join(tmp, "tour") }, stdio: ["ignore", "ignore", "inherit"] }),
  spawn("bun", [join(args.vision, "server.js")], {
    cwd: args.vision,
    env: { ...process.env, PORT: String(ports.vision), PPV_QA: "1", PPV_SAVE_DIR: join(tmp, "saves"), PPV_KEY_FILE: join(tmp, "upload-key"), PPV_SETUP_FILE: join(tmp, "setup.json"), PPV_TOURNAMENT_URL: `http://127.0.0.1:${ports.tour}`, PPV_TOURNAMENT_DATA: join(tmp, "tour/tournament.json") },
    stdio: ["ignore", "ignore", "inherit"],
  }),
];
const stop = () => {
  for (const p of procs) p.kill();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

for (const [port, path] of [[ports.tour, "/api/state"], [ports.vision, "/healthz"]]) {
  for (let i = 0; ; i++) {
    const ok = await fetch(`http://127.0.0.1:${port}${path}`).then((r) => r.status < 500, () => false);
    if (ok) break;
    if (i > 100) {
      console.error(`server ${port} did not start`);
      stop();
    }
    await Bun.sleep(100);
  }
}

const target = (path) => (path === "/vision" || path.startsWith("/vision/") ? ports.vision : ports.tour);
Bun.serve({
  port: ports.proxy,
  hostname: "127.0.0.1",
  async fetch(req, server) {
    const url = new URL(req.url);
    if (req.headers.get("upgrade") === "websocket") return server.upgrade(req, { data: { path: url.pathname + url.search } }) ? undefined : new Response("no", { status: 400 });
    const headers = new Headers(req.headers);
    headers.delete("host");
    headers.delete("accept-encoding");
    const res = await fetch(`http://127.0.0.1:${target(url.pathname)}${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
      redirect: "manual",
    });
    return new Response(res.body, { status: res.status, headers: res.headers });
  },
  websocket: {
    open(ws) {
      const back = new WebSocket(`ws://127.0.0.1:${ports.tour}${ws.data.path}`);
      ws.data.back = back;
      ws.data.queue = [];
      back.onopen = () => ws.data.queue.splice(0).forEach((m) => back.send(m));
      back.onmessage = (e) => ws.send(e.data);
      back.onclose = () => ws.close();
    },
    message(ws, m) {
      if (ws.data.back.readyState === 1) ws.data.back.send(m);
      else ws.data.queue.push(m);
    },
    close(ws) {
      ws.data.back?.close();
    },
  },
});
console.log(`ONE_ORIGIN_READY http://127.0.0.1:${ports.proxy}/vision/`);
