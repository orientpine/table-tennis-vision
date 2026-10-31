// Spoken score call-outs with the phone's own speech engine (Web Speech, no network). iOS Safari
// speaks only after a first speak() inside a user tap, so unlock() runs on taps that come before
// play starts (camera start, settings).
import { SIDE_NAMES } from "./tournament.js";

export function speak(text) {
  const synth = globalThis.speechSynthesis;
  if (!synth || !text || typeof SpeechSynthesisUtterance === "undefined") return false;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "ko-KR";
  const ko = synth.getVoices().find((v) => (v.lang || "").toLowerCase().startsWith("ko"));
  if (ko) u.voice = ko;
  u.rate = 1.05;
  synth.speak(u);
  return true;
}

let unlocked = false;
export function unlock() {
  if (unlocked) return;
  unlocked = speak(" ");
}

// What to say after a point. side is the winner's end colour, score / won are [blue end, red end].
export function pointCallout({ side, score, gameEnded, gameNo, won, matchOver, endChange }) {
  const who = SIDE_NAMES[side];
  if (matchOver) return `${who} 승리. 경기 끝`;
  if (gameEnded) return `${who} ${gameNo}게임 승리. 게임 ${won[0]} 대 ${won[1]}. 엔드를 바꾸세요`;
  if (!score) return `${who} 득점`;
  const line = `${SIDE_NAMES[0]} 사이드 ${score[0]}, ${SIDE_NAMES[1]} 사이드 ${score[1]}`;
  return endChange ? `${line}. 엔드를 바꾸세요` : line;
}

