// Build id for the app shell, so each deploy gets a new service worker cache without a hand
// edited cache name. The id is a hash of every shell file's bytes (html, css, js, manifest,
// icons, the service worker itself, and the served MediaPipe bundle). Models, fonts and wasm are
// not part of it: they are large, change rarely and keep their own cache across deploys.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export const HEAVY = /\.(wasm|task|onnx|woff2)$/;

// Shell URLs relative to the app root, in a stable order. "./" stands for index.html.
// bench.html and its files are a separate page and stay out of the precache.
export function shellBuild(publicDir, extra = {}) {
  const files = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else files.push(relative(publicDir, p).split("\\").join("/"));
    }
  };
  walk(publicDir);
  const shell = files
    .filter((f) => !HEAVY.test(f) && !f.startsWith("bench") && !f.startsWith("models/") && !f.endsWith(".txt"))
    .sort();
  const hash = createHash("sha256");
  for (const f of shell) hash.update(f).update("\0").update(readFileSync(join(publicDir, f))).update("\0");
  for (const name of Object.keys(extra).sort()) hash.update(name).update("\0").update(extra[name]).update("\0");
  const urls = shell.map((f) => (f === "index.html" ? "./" : `./${f}`)).concat(Object.keys(extra).sort());
  return { id: hash.digest("hex").slice(0, 12), urls };
}
