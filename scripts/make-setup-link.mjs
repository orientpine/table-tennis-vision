#!/usr/bin/env bun
// Makes a fresh one-time setup link for the owner's phone and writes it ONLY to
// ~/.config/pingpong-vision/setup-link.txt (0600). The link is never printed, so it stays out of
// terminals, chats and logs. It expires after 10 minutes and works once.
//   bun scripts/make-setup-link.mjs
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createSetupToken } from "../save-server.js";

const cfg = join(homedir(), ".config/pingpong-vision");
const tokenFile = process.env.PPV_SETUP_FILE || join(cfg, "setup-tokens.json");
const out = process.env.PPV_SETUP_LINK_FILE || join(cfg, "setup-link.txt");
const base = (process.env.PPV_PUBLIC_URL || readFileSync(new URL("../public-url.txt", import.meta.url), "utf8")).trim();
const { token, expiresAt } = createSetupToken({ tokenFile });
writeFileSync(out, `${base}#setup=${token}\n`, { mode: 0o600 });
chmodSync(out, 0o600);
const kst = new Date(expiresAt).toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit" });
console.log(`setup link written to ${out} (0600), one use, expires ${kst} KST`);
