
import { chromium } from "playwright";
const [src, out, w, h] = process.argv.slice(2);
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: +w, height: +h } });
await p.goto("file://" + src); await p.screenshot({ path: out }); await b.close(); console.log("SHOT", out);
