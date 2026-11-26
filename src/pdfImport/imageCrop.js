/**
 * imageCrop.js  (browser only: needs <canvas>)
 * Renders a pdf.js page and finds / crops graphics that the text layer cannot express:
 * embedded images, vector-drawn maths, figures, tables, image-only options...
 *
 * Idea ("residual ink"): take a region of the rendered page, blank out every rectangle that is
 * explained by real text, and see whether anything dark is left. If so it is a graphic.
 */

export const INK_LUMINANCE = 165; // darker than this counts as ink (box borders are ~#ccc = 204, watermark ~230)

export async function renderPage(page, scale = 3) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, canvas, viewport }).promise;
  return { canvas, ctx, scale };
}

const toPx = (r, scale, canvas) => {
  const x0 = Math.max(0, Math.floor(r.x0 * scale));
  const y0 = Math.max(0, Math.floor(r.y0 * scale));
  const x1 = Math.min(canvas.width, Math.ceil(r.x1 * scale));
  const y1 = Math.min(canvas.height, Math.ceil(r.y1 * scale));
  return { x0, y0, x1, y1, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
};

/**
 * Bounding box (in points) of dark pixels inside `region` that are NOT covered by `maskRects`.
 * Returns null when nothing but text is there.
 */
export function findInk({ canvas, ctx, scale }, region, maskRects = [], { minPixels = 14 } = {}) {
  const p = toPx(region, scale, canvas);
  if (p.w < 2 || p.h < 2) return null;
  const { data } = ctx.getImageData(p.x0, p.y0, p.w, p.h);
  const masks = maskRects.map((m) => toPx(m, scale, canvas));
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, count = 0;
  for (let y = 0; y < p.h; y++) {
    const gy = p.y0 + y;
    for (let x = 0; x < p.w; x++) {
      const i = (y * p.w + x) * 4;
      if (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] >= INK_LUMINANCE) continue;
      const gx = p.x0 + x;
      let covered = false;
      for (const m of masks) if (gx >= m.x0 && gx < m.x1 && gy >= m.y0 && gy < m.y1) { covered = true; break; }
      if (covered) continue;
      count++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (count < minPixels) return null;
  return {
    x0: (p.x0 + minX) / scale, y0: (p.y0 + minY) / scale,
    x1: (p.x0 + maxX + 1) / scale, y1: (p.y0 + maxY + 1) / scale,
  };
}

/** Colour census of a region: how many clearly green / red pixels (used for the tick / cross icons). */
export function colourCensus({ canvas, ctx, scale }, region) {
  const p = toPx(region, scale, canvas);
  if (p.w < 1 || p.h < 1) return { green: 0, red: 0 };
  const { data } = ctx.getImageData(p.x0, p.y0, p.w, p.h);
  let green = 0, red = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (g > r + 40 && g > b + 40) green++;
    else if (r > g + 80 && r > b + 80) red++;
  }
  return { green, red };
}

/**
 * Crop `rect` (points) out of the rendered page as a PNG blob.
 * The pale-pink site watermark is wiped to white; dark/saturated content is left untouched.
 */
export async function cropToBlob({ canvas, scale }, rect, { pad = 2, clip = null, avoid = [], removeWatermark = true } = {}) {
  const r = { x0: rect.x0 - pad, y0: rect.y0 - pad, x1: rect.x1 + pad, y1: rect.y1 + pad };
  // padding must never swallow neighbouring text (e.g. the sentence right above a table)
  for (const a of avoid) {
    const h = a.x0 < rect.x1 && a.x1 > rect.x0, v = a.y0 < rect.y1 && a.y1 > rect.y0;
    if (h && a.y0 < rect.y0 && a.y1 > r.y0) r.y0 = Math.min(rect.y0, Math.max(r.y0, a.y1));
    if (h && a.y1 > rect.y1 && a.y0 < r.y1) r.y1 = Math.max(rect.y1, Math.min(r.y1, a.y0));
    if (v && a.x0 < rect.x0 && a.x1 > r.x0) r.x0 = Math.min(rect.x0, Math.max(r.x0, a.x1));
    if (v && a.x1 > rect.x1 && a.x0 < r.x1) r.x1 = Math.max(rect.x1, Math.min(r.x1, a.x0));
  }
  if (clip) {   // stay inside the cell so its grey border lines are not included
    r.x0 = Math.max(r.x0, Math.min(clip.x0, rect.x0)); r.y0 = Math.max(r.y0, Math.min(clip.y0, rect.y0));
    r.x1 = Math.min(r.x1, Math.max(clip.x1, rect.x1)); r.y1 = Math.min(r.y1, Math.max(clip.y1, rect.y1));
  }
  const p = toPx(r, scale, canvas);
  const out = document.createElement('canvas');
  out.width = p.w; out.height = p.h;
  const octx = out.getContext('2d', { willReadFrequently: true });
  octx.drawImage(canvas, p.x0, p.y0, p.w, p.h, 0, 0, p.w, p.h);
  if (removeWatermark) {
    const img = octx.getImageData(0, 0, p.w, p.h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      // pale reddish tint: light, red clearly above green, green ~ blue
      if (r > 195 && g > 150 && r - g > 3 && r - g < 50 && Math.abs(g - b) < 14) { d[i] = d[i + 1] = d[i + 2] = 255; }
    }
    octx.putImageData(img, 0, 0);
  }
  const blob = await new Promise((res) => out.toBlob(res, 'image/png'));
  return { blob, width: p.w, height: p.h, scale };
}

// A "border" pixel: neutral grey (or grey seen through the pink watermark), clearly darker than paper.
const isBorderPx = (r, g, b) => {
  const l = 0.299 * r + 0.587 * g + 0.114 * b;
  return l >= 90 && l < 222 && Math.abs(g - b) < 12 && r - g < 40 && r - g > -10;
};

/** y positions (points) of long horizontal rules between x0..x1 (cell borders of the response sheet). */
export function findHLines({ canvas, ctx, scale }, x0, x1, minCoverage = 0.8) {
  const px0 = Math.floor(x0 * scale), w = Math.floor((x1 - x0) * scale);
  const { data } = ctx.getImageData(px0, 0, w, canvas.height);
  const hit = [];
  for (let y = 0; y < canvas.height; y++) {
    let n = 0;
    for (let x = 0, i = y * w * 4; x < w; x++, i += 4) if (isBorderPx(data[i], data[i + 1], data[i + 2])) n++;
    hit.push(n / w >= minCoverage);
  }
  const lines = [];
  for (let y = 0; y < hit.length; y++) {
    if (!hit[y]) continue;
    let e = y;
    while (e + 1 < hit.length && hit[e + 1]) e++;
    lines.push((y + e + 1) / 2 / scale);
    y = e;
  }
  return lines;
}

/** x (points) of the first long vertical rule at or after `fromX` inside the y-band; null if none. */
export function findVLine({ canvas, ctx, scale }, fromX, toX, y0, y1, minCoverage = 0.75) {
  const px0 = Math.floor(fromX * scale), w = Math.floor((toX - fromX) * scale);
  const py0 = Math.floor(y0 * scale), h = Math.floor((y1 - y0) * scale);
  if (w < 1 || h < 4) return null;
  const { data } = ctx.getImageData(px0, py0, w, h);
  for (let x = 0; x < w; x++) {
    let n = 0;
    for (let y = 0; y < h; y++) { const i = (y * w + x) * 4; if (isBorderPx(data[i], data[i + 1], data[i + 2])) n++; }
    if (n / h >= minCoverage) return fromX + x / scale;
  }
  return null;
}
