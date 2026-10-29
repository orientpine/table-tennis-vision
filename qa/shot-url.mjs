
import { webkit, devices } from "playwright";
const [url, out] = process.argv.slice(2);
const b = await webkit.launch(process.env.PPV_WEBKIT ? { executablePath: process.env.PPV_WEBKIT } : {}); const ctx = await b.newContext({ ...devices["iPhone 15"] }); const p = await ctx.newPage();
const resp = await p.goto(url, { waitUntil: "networkidle" }); await p.waitForTimeout(1500);
await p.screenshot({ path: out }); console.log("SHOT", resp.status(), out, await p.title()); await b.close();
