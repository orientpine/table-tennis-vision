// Link to the tournament scoring app, which owns the root of the same origin (/api/..., /ws).
// The referee types the tournament PIN once (checked by /api/pin/verify, kept only on this
// phone) and picks the match and which colour stands at the near end. After each point the
// vision app enters the judged winner through the tournament's normal /api/action (same PIN
// rules, lockout and seq check as a tap), shows a 3 s cancel (= the tournament's undo), and
// once the point's clip is uploaded attaches its share path to that point.
const API = "/api";
export const SIDE_NAMES = ["블루", "레드"];
export const CANCEL_MS = 3000;
export const CHOICE_MS = 15000;

export class TournamentLink {
  constructor(store, onChange = () => {}) {
    this.store = store;
    this.onChange = onChange;
    this.pin = store.get("tourPin", null);
    this.matchId = store.get("tourMatch", null);
    this.near = store.get("tourNear", 0);
    this.mode = store.get("tourMode", "sure");
    this.matches = [];
    this.error = null;
    this.errorAt = 0;
    this.notice = null;
    this.pending = null;
  }

  view() {
    const match = this.matches.find((m) => m.id === this.matchId) || null;
    const errorFresh = !!this.error && Date.now() - this.errorAt < 5000;
    return { connected: !!this.pin, matchId: this.matchId, near: this.near, mode: this.mode, matches: this.matches, match, error: this.error, errorFresh, notice: this.notice, pending: this.pending };
  }

  async call(path, body) {
    const res = await fetch(API + path, {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json", ...(this.pin ? { "x-pin": this.pin } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `대회 앱 응답 ${res.status}`);
    return data;
  }

  async run(task) {
    try {
      this.error = null;
      return await task();
    } catch (err) {
      this.error = String(err.message || err);
      this.errorAt = Date.now();
      return null;
    } finally {
      this.onChange();
    }
  }

  connect(pin) {
    return this.run(async () => {
      const p = String(pin || "").trim();
      await this.call("/pin/verify", { pin: p });
      this.pin = p;
      this.store.set("tourPin", p);
      this.notice = "대회 앱에 연결했어요";
      this.apply(await this.call("/state"));
    });
  }

  disconnect() {
    this.pin = null;
    this.matches = [];
    this.pending = null;
    this.notice = "대회 앱 연동을 껐어요";
    this.store.set("tourPin", null);
    this.onChange();
  }

  refresh() {
    return this.run(async () => this.apply(await this.call("/state")));
  }

  apply(state) {
    const t = state && state.tournament;
    const d = state && state.derived;
    if (!t || !d) {
      this.matches = [];
      throw new Error("진행 중인 대회가 없어요");
    }
    this.matches = d.matches
      .filter((m) => m.status === "live" || m.status === "ready")
      .map((m) => ({ id: m.id, no: m.no, names: m.players.map((i) => t.players[i]), points: m.points.length, score: m.score }));
    if (!this.matches.some((m) => m.id === this.matchId)) {
      const pick = this.matches.find((m) => m.points > 0) || this.matches[0];
      this.setMatch(pick ? pick.id : null);
    }
  }

  setMatch(id) {
    this.matchId = id;
    this.store.set("tourMatch", id);
    this.onChange();
  }

  setNear(side) {
    this.near = side === 1 ? 1 : 0;
    this.store.set("tourNear", this.near);
    this.onChange();
  }

  setMode(mode) {
    this.mode = mode === "all" ? "all" : "sure";
    this.store.set("tourMode", this.mode);
    this.onChange();
  }

  // Enter one judged point ({ winner: "near" | "far", label, sure }). In "sure" mode an unsure
  // call is not entered: the bar offers one-tap [블루 득점] / [레드 득점] until the next rally
  // starts (or CHOICE_MS), and the tapped side is entered the same way, clip included.
  // Resolves to the entry the clip is attached to, or null when nothing was entered.
  score(judged) {
    if (!this.pin || !this.matchId || !judged) return Promise.resolve(null);
    if (this.mode === "sure" && !judged.sure) {
      return new Promise((resolve) => {
        const choice = { choice: true, reason: judged.label, until: Date.now() + CHOICE_MS, resolve };
        this.dropChoice();
        this.pending = choice;
        setTimeout(() => this.pending === choice && this.dropChoice(), CHOICE_MS);
        this.onChange();
      });
    }
    return this.enter(judged.winner === "near" ? this.near : 1 - this.near, judged.label);
  }

  // The referee picked the winner of an unsure point.
  pick(side) {
    const choice = this.pending && this.pending.choice ? this.pending : null;
    if (!choice) return Promise.resolve(null);
    this.pending = null;
    return this.enter(side === 1 ? 1 : 0, "직접 고름").then((entry) => {
      choice.resolve(entry);
      return entry;
    });
  }

  dropChoice() {
    const choice = this.pending && this.pending.choice ? this.pending : null;
    if (!choice) return;
    this.pending = null;
    choice.resolve(null);
    this.onChange();
  }

  enter(side, reason) {
    return this.run(async () => {
      this.apply(await this.call("/state"));
      const m = this.matches.find((x) => x.id === this.matchId);
      if (!m) throw new Error("고른 경기가 끝났거나 없어요. 설정에서 경기를 다시 골라 주세요");
      const res = await this.call("/action", { type: "point", matchId: m.id, side, seq: m.points });
      this.apply(res.state);
      const after = res.state.derived.matches.find((x) => x.id === m.id);
      const s = after && after.score;
      const g = s && (s.lastGame || s.current);
      const entry = {
        matchId: m.id,
        index: m.points,
        seq: m.points + 1,
        side,
        name: m.names[side],
        reason,
        score: g ? [g.a, g.b] : null,
        gameEnded: !!(s && s.lastGame),
        until: Date.now() + CANCEL_MS,
        cancelled: false,
      };
      this.pending = entry;
      setTimeout(() => {
        if (this.pending === entry) {
          this.pending = null;
          this.onChange();
        }
      }, CANCEL_MS);
      return entry;
    });
  }

  cancel() {
    const p = this.pending;
    if (!p || p.choice) return Promise.resolve(null);
    p.cancelled = true;
    this.pending = null;
    return this.run(async () => {
      const res = await this.call("/action", { type: "undo", matchId: p.matchId, seq: p.seq });
      this.apply(res.state);
      this.notice = `${SIDE_NAMES[p.side]} 득점을 취소했어요`;
    });
  }

  attachClip(entry, sharePath) {
    if (!entry || entry.cancelled || !this.pin) return Promise.resolve(null);
    return this.run(() => this.call("/action", { type: "clip", matchId: entry.matchId, index: entry.index, url: sharePath }));
  }
}
