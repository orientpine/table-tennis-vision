// Paints the camera screen's overlay panels (record cells, player panels, VS, court map, notices) into
// a canvas exactly where they sit on screen, for the rally clip (recorder.js). It walks the live DOM
// and draws what each element shows: background, hard drop shadow, borders, text in its computed font
// and colour, and the court map's SVG as an image. Buttons, chips and the settings sheet are never
// walked: only the subtrees given to it are.


function parseColor(c) {
  const m = /rgba?\(([^)]+)\)/.exec(c || "");
  if (!m) return null;
  const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  const a = p.length > 3 ? p[3] : 1;
  return a > 0 ? c : null;
}

// "rgb(0, 0, 0) 3px 3px 0px 0px, ..." -> first non-inset { color, x, y }
function firstShadow(s) {
  if (!s || s === "none") return null;
  for (const part of s.split(/,(?![^(]*\))/)) {
    if (/inset/.test(part)) continue;
    const color = (/rgba?\([^)]*\)/.exec(part) || [])[0];
    const nums = part.replace(/rgba?\([^)]*\)/, "").match(/-?\d+(\.\d+)?px/g) || [];
    if (!color || nums.length < 2 || !parseColor(color)) continue;
    return { color, x: parseFloat(nums[0]), y: parseFloat(nums[1]) };
  }
  return null;
}

// Never in a clip: buttons (the fold chip and anything else tappable), and text hidden for screen readers only
// (a 1 px box with clip: rect(0 0 0 0), as the thin rally-time row does with its labels).
export function leftOut(el, cs = getComputedStyle(el)) {
  if (el.hidden || el.closest("[hidden]") || el.classList.contains("visually-hidden")) return true;
  if (el.closest("button, [role=button]")) return true;
  return /^rect\(0(px)?,? 0(px)?/.test(cs.clip) || (cs.overflow === "hidden" && el.offsetWidth <= 1 && el.offsetHeight <= 1);
}

function shown(el, cs) {
  if (leftOut(el, cs)) return false;
  return cs.display !== "none" && cs.visibility !== "hidden" && Number(cs.opacity) > 0;
}

// The court map's shapes, each in its own on-screen transform and computed paint (no image decode).
function drawSvg(ctx, svg, box, s, alpha) {
  for (const el of svg.querySelectorAll("rect, circle, ellipse, line, path, polyline, polygon, text")) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || el.closest("[hidden]")) continue;
    const m = el.getScreenCTM();
    if (!m) continue;
    ctx.save();
    ctx.globalAlpha = alpha * Number(cs.opacity || 1);
    ctx.setTransform(m.a * s, m.b * s, m.c * s, m.d * s, (m.e - box.left) * s, (m.f - box.top) * s);
    const n = (k) => parseFloat(el.getAttribute(k) || 0);
    const tag = el.tagName.toLowerCase();
    if (tag === "text") {
      ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      ctx.textAlign = { middle: "center", end: "right" }[cs.textAnchor] || "left";
      ctx.fillStyle = cs.fill;
      ctx.fillText(el.textContent, n("x"), n("y"));
      ctx.restore();
      continue;
    }
    const p = new Path2D();
    if (tag === "rect") p.rect(n("x"), n("y"), n("width"), n("height"));
    else if (tag === "circle") p.arc(n("cx"), n("cy"), n("r"), 0, Math.PI * 2);
    else if (tag === "ellipse") p.ellipse(n("cx"), n("cy"), n("rx"), n("ry"), 0, 0, Math.PI * 2);
    else if (tag === "line") { p.moveTo(n("x1"), n("y1")); p.lineTo(n("x2"), n("y2")); }
    else if (tag === "path") p.addPath(new Path2D(el.getAttribute("d") || ""));
    else { const pts = (el.getAttribute("points") || "").trim().split(/[\s,]+/).map(Number); for (let k = 0; k + 1 < pts.length; k += 2) (k ? p.lineTo(pts[k], pts[k + 1]) : p.moveTo(pts[k], pts[k + 1])); if (tag === "polygon") p.closePath(); }
    if (cs.fill && cs.fill !== "none") { ctx.fillStyle = cs.fill; ctx.globalAlpha *= Number(cs.fillOpacity || 1); ctx.fill(p); ctx.globalAlpha = alpha * Number(cs.opacity || 1); }
    if (cs.stroke && cs.stroke !== "none") {
      ctx.strokeStyle = cs.stroke;
      ctx.lineWidth = parseFloat(cs.strokeWidth) || 1;
      const dash = cs.strokeDasharray && cs.strokeDasharray !== "none" ? cs.strokeDasharray.split(/[\s,]+/).map(parseFloat).filter((v) => v >= 0) : [];
      ctx.setLineDash(dash);
      ctx.stroke(p);
    }
    ctx.restore();
  }
}

/**
 * Draw `roots` (elements) into ctx. box = the screen rect (CSS px, viewport) that maps to the canvas,
 * s = canvas px per CSS px.
 */
export function paintPanels(ctx, roots, box, s) {
  const X = (x) => (x - box.left) * s, Y = (y) => (y - box.top) * s;
  for (const root of roots) {
    if (!root) continue;
    const walk = (el, alpha) => {
      const cs = getComputedStyle(el);
      if (!shown(el, cs)) return;
      const a = alpha * Number(cs.opacity || 1);
      if (cs.display === "contents") { for (const c of el.children) walk(c, a); return; }
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) { for (const c of el.children) walk(c, a); return; }
      ctx.globalAlpha = a;
      if (el.tagName.toLowerCase() === "svg") { drawSvg(ctx, el, box, s, a); return; }
      const sh = firstShadow(cs.boxShadow);
      const bg = parseColor(cs.backgroundColor);
      if (sh && bg) { ctx.fillStyle = sh.color; ctx.fillRect(X(r.left + sh.x), Y(r.top + sh.y), r.width * s, r.height * s); }
      if (bg) { ctx.fillStyle = bg; ctx.fillRect(X(r.left), Y(r.top), r.width * s, r.height * s); }
      // the segmented meters (MOVE, 손목, SHOT) are a repeating gradient of --meter-c segments
      if (/repeating-linear-gradient/.test(cs.backgroundImage)) {
        const seg = parseFloat(cs.getPropertyValue("--meter-seg")) || 4, gap = parseFloat(cs.getPropertyValue("--meter-gap")) || 2;
        const mc = cs.getPropertyValue("--meter-c").trim();
        if (mc) {
          ctx.fillStyle = mc;
          for (let x = r.left; x < r.right; x += seg + gap) ctx.fillRect(X(x), Y(r.top), Math.min(seg, r.right - x) * s, r.height * s);
        }
      }
      for (const [side, w, c] of [["top", cs.borderTopWidth, cs.borderTopColor], ["bottom", cs.borderBottomWidth, cs.borderBottomColor], ["left", cs.borderLeftWidth, cs.borderLeftColor], ["right", cs.borderRightWidth, cs.borderRightColor]]) {
        const bw = parseFloat(w);
        if (!(bw > 0) || !parseColor(c) || cs[`border${side[0].toUpperCase()}${side.slice(1)}Style`] === "none") continue;
        ctx.fillStyle = c;
        if (side === "top") ctx.fillRect(X(r.left), Y(r.top), r.width * s, bw * s);
        if (side === "bottom") ctx.fillRect(X(r.left), Y(r.bottom - bw), r.width * s, bw * s);
        if (side === "left") ctx.fillRect(X(r.left), Y(r.top), bw * s, r.height * s);
        if (side === "right") ctx.fillRect(X(r.right - bw), Y(r.top), bw * s, r.height * s);
      }
      for (const node of el.childNodes) {
        if (node.nodeType === 1) { walk(node, a); continue; }
        if (node.nodeType !== 3 || !node.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const tr = range.getBoundingClientRect();
        if (tr.width <= 0) continue;
        ctx.globalAlpha = a;
        ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${parseFloat(cs.fontSize) * s}px ${cs.fontFamily}`;
        if ("letterSpacing" in ctx) ctx.letterSpacing = cs.letterSpacing === "normal" ? "0px" : `${parseFloat(cs.letterSpacing) * s}px`;
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        const text = node.textContent.replace(/\s+/g, " ").trim();
        const tx = X(tr.left), ty = Y(tr.top + tr.height / 2);
        const ts = firstShadow(cs.textShadow);
        if (ts) { ctx.fillStyle = ts.color; ctx.fillText(text, tx + ts.x * s, ty + ts.y * s); }
        ctx.fillStyle = cs.color;
        ctx.fillText(text, tx, ty);
      }
    };
    walk(root, 1);
  }
  ctx.globalAlpha = 1;
  if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
}
