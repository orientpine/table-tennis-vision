// The server stamps the build id and the shell list below on every start (build-id.js), so each
// deploy that changes the shell ships a different sw.js and a new shell cache. No hand edits.
// Shell files (html, js, css) come from the network first and from the cache only when offline.
// Models, fonts and wasm are cache first and live in a cache that survives deploys.
const BUILD = "__PPV_BUILD__";
const SHELL_URLS = "__PPV_SHELL__";
const SHELL = `ppv-shell-${BUILD}`;
const HEAVY_CACHE = "ppv-heavy";
const HEAVY = /\.(wasm|task|onnx|woff2)$/;
const PRECACHE_HEAVY = ["./models/pose_landmarker_lite.task"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const shell = await caches.open(SHELL);
      await shell.addAll(SHELL_URLS.map((u) => new Request(u, { cache: "no-store" })));
      const heavy = await caches.open(HEAVY_CACHE);
      for (const u of PRECACHE_HEAVY) if (!(await caches.match(u))) await heavy.add(u);
      await self.skipWaiting();
    })(),
  );
});

// Older caches (ppv-v1, earlier builds): keep their models, fonts and wasm, drop the rest.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const heavy = await caches.open(HEAVY_CACHE);
      for (const name of await caches.keys()) {
        if (name === SHELL || name === HEAVY_CACHE) continue;
        const old = await caches.open(name);
        for (const req of await old.keys()) {
          if (HEAVY.test(req.url) && !(await heavy.match(req))) await heavy.put(req, await old.match(req));
        }
        await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin || req.headers.has("range")) return;
  if (HEAVY.test(new URL(req.url).pathname)) {
    event.respondWith(
      (async () => {
        const hit = await caches.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok && res.status === 200) (await caches.open(HEAVY_CACHE)).put(req, res.clone());
        return res;
      })(),
    );
    return;
  }
  event.respondWith(
    (async () => {
      try {
        const res = await fetch(req, { cache: "no-store" });
        if (res.ok && res.status === 200) (await caches.open(SHELL)).put(req, res.clone());
        return res;
      } catch (err) {
        const hit = (await (await caches.open(SHELL)).match(req)) || (await caches.match(req));
        if (hit) return hit;
        throw err;
      }
    })(),
  );
});
