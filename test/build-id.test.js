import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellBuild } from "../build-id.js";

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ppv-build-"));
  for (const d of ["js", "models", "fonts"]) mkdirSync(join(dir, d));
  writeFileSync(join(dir, "index.html"), "<html>");
  writeFileSync(join(dir, "sw.js"), "sw");
  writeFileSync(join(dir, "js/app.js"), "app v1");
  writeFileSync(join(dir, "models/pose.task"), "model");
  writeFileSync(join(dir, "fonts/a.woff2"), "font");
  writeFileSync(join(dir, "bench.html"), "bench");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("a changed shell file changes the build id; the same tree gives the same id", () => {
  const a = shellBuild(dir);
  expect(shellBuild(dir).id).toBe(a.id);
  writeFileSync(join(dir, "js/app.js"), "app v2");
  expect(shellBuild(dir).id).not.toBe(a.id);
});

test("models, fonts and bench do not change the id and are not precached as shell", () => {
  const a = shellBuild(dir);
  writeFileSync(join(dir, "models/pose.task"), "model v2");
  writeFileSync(join(dir, "fonts/a.woff2"), "font v2");
  writeFileSync(join(dir, "bench.html"), "bench v2");
  expect(shellBuild(dir).id).toBe(a.id);
  expect(a.urls).toEqual(["./", "./js/app.js", "./sw.js"]);
});

test("the served vendor bundle is part of the id and the precache", () => {
  const a = shellBuild(dir, { "./vendor/x.mjs": "v1" });
  expect(shellBuild(dir, { "./vendor/x.mjs": "v2" }).id).not.toBe(a.id);
  expect(a.urls).toContain("./vendor/x.mjs");
});
