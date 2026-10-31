import { expect, test } from "bun:test";
import { fitBox } from "../public/js/geom.js";
import { pickSpot } from "../public/js/hud.js";

const toScreen = (f, p) => ({ x: f.x + p.x * f.scale, y: f.y + p.y * f.scale });
const toVideo = (f, p) => ({ x: (p.x - f.x) / f.scale, y: (p.y - f.y) / f.scale });

test("contain shows the whole picture inside the stage", () => {
  const f = fitBox(374, 402, 1280, 720);
  expect(f.x).toBeCloseTo(0);
  expect(f.y).toBeCloseTo((402 - 210.375) / 2);
  expect(f.w).toBeCloseTo(374);
});

test("cover fills the stage and runs past its edges", () => {
  const f = fitBox(374, 402, 1280, 720, true);
  expect(f.h).toBeCloseTo(402);
  expect(f.w).toBeGreaterThan(374);
  expect(f.x).toBeLessThan(0);
});

test("a video point survives screen and back in both fits", () => {
  const point = { x: 355, y: 634 };
  for (const cover of [false, true]) {
    const f = fitBox(374, 402, 1920, 1080, cover);
    const back = toVideo(f, toScreen(f, point));
    expect(back.x).toBeCloseTo(point.x);
    expect(back.y).toBeCloseTo(point.y);
  }
});

test("a label takes the first free spot, and null when every spot is taken", () => {
  const taken = [{ x: 0, y: 0, w: 50, h: 20 }];
  expect(pickSpot([{ x: 10, y: 5 }, { x: 60, y: 5 }], 40, 20, taken)).toEqual({ x: 60, y: 5 });
  expect(pickSpot([{ x: 10, y: 5 }], 40, 20, taken)).toBeNull();
});
