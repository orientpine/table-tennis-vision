// This phone as the camera of the tournament app on the same origin (one app, a role per device).
// It keeps a WebSocket to the tournament server: every 5 s it says it is here (what it films,
// whether it can write scores, under a public id = sha256 of a secret kept on the phone), and it
// hears which screen took the sound. Write access is the tournament PIN only (typed here, or already
// on this device from the tournament app), as on the referee screen (owner decision, 2026-10-31).
import { speak } from "./voice.js";

const HELLO_MS = 5000;

function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class Venue {
  constructor(store, tour, mode) {
    this.store = store;
    this.tour = tour;
    this.mode = mode;
    this.ws = null;
    this.retry = 0;
    this.id = null;
    this.speaker = null;
  }

  // Only a device that chose the camera role, or holds a tournament PIN, talks to the tournament
  // app; the vision app opened on its own stays quiet.
  wanted() {
    let shared = null;
    try {
      shared = localStorage.getItem("pp-role") === "camera" || !!localStorage.getItem("pp-pin");
    } catch {}
    return shared || this.tour.linked();
  }

  async start() {
    if (this.started || !this.wanted()) return;
    this.started = true;
    this.tour.setWs("connecting");
    let secret = this.store.get("venueSecret", null);
    if (!secret) {
      secret = b64url(crypto.getRandomValues(new Uint8Array(32)));
      this.store.set("venueSecret", secret);
    }
    this.secret = secret;
    this.id = await sha256hex(secret);
    setInterval(() => this.hello(), HELLO_MS);
    await this.whenTournamentApp();
    this.usePinFromTournamentApp();
    this.connect();
  }

  // The vision app can also run on its own (no tournament app on this origin): then do not knock.
  async whenTournamentApp() {
    for (;;) {
      const ok = await fetch("/api/state", { cache: "no-store" }).then((r) => r.ok && (r.headers.get("content-type") || "").includes("json"), () => false);
      if (ok) return;
      this.tour.setWs("none");
      await new Promise((res) => setTimeout(res, 30000));
    }
  }

  // The tournament app keeps its PIN under "pp-pin" on this same origin.
  usePinFromTournamentApp() {
    if (this.tour.linked()) return;
    let pin = null;
    try {
      pin = localStorage.getItem("pp-pin");
    } catch {}
    if (pin) this.tour.connect(pin);
  }

  connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.tour.setWs("online");
      this.hello();
    };
    ws.onmessage = (ev) => {
      if (ev.data === "pong") return;
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === "presence") this.onPresence(msg);
      if (msg.type === "state" && msg.state && msg.state.tournament) {
        try {
          if (!this.tour.pending) this.tour.apply(msg.state);
          this.tour.onChange();
        } catch {}
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.tour.setWs("offline");
      this.retry = Math.min(this.retry + 1, 5);
      setTimeout(() => this.connect(), Math.min(10000, 1000 * 2 ** (this.retry - 1)));
    };
  }

  hello() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.id) return;
    this.ws.send(JSON.stringify({ type: "camera", id: this.id, mode: this.mode(), matchId: this.tour.matchId, linked: this.tour.linked() }));
  }

  async onPresence(msg) {
    this.speaker = msg.speaker || null;
    this.hello();
  }

  // Call-outs go to the screen that took the sound (a viewer TV or pad); with none, or when the
  // tournament app cannot be reached, this phone speaks. Never both.
  async say(text) {
    if (this.speaker && this.tour.linked() && this.tour.ws === "online") {
      try {
        const res = await fetch("/api/vision/say", { method: "POST", headers: { "content-type": "application/json", ...this.tour.auth() }, body: JSON.stringify({ text }) });
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.delivered) return "screen";
      } catch {}
    }
    speak(text);
    return "phone";
  }
}
