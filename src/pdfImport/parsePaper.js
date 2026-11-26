/**
 * parsePaper.js — pure helpers (no DOM, no pdf.js): turn text runs into lines / text / metadata.
 */

export const isWhite = (c) => c[0] >= 250 && c[1] >= 250 && c[2] >= 250;
export const isGreen = (c) => c[1] > c[0] + 40 && c[1] > c[2] + 40;
export const isRed = (c) => c[0] > c[1] + 80 && c[0] > c[2] + 80;

const SUP_MAP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻', '−': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ' };
const ORDINAL = /^(st|nd|rd|th)$/i;
const toSup = (t) => (ORDINAL.test(t.trim()) ? t : [...t].every((ch) => SUP_MAP[ch]) ? [...t].map((ch) => SUP_MAP[ch]).join('') : `^(${t})`);

/** White text is invisible tracking junk, except the white-on-grey "Section : …" bar. Splits the two apart. */
export function splitHiddenText(runs) {
  const visible = [], white = [];
  for (const r of runs) (isWhite(r.color) ? white : visible).push(r);
  white.sort((a, b) => a.y - b.y || a.x - b.x);
  const bars = [];
  let cur = null;
  for (const r of white) {
    if (cur && Math.abs(r.y - cur.y) < 2) cur.parts.push(r);
    else { cur = { y: r.y, parts: [r] }; bars.push(cur); }
  }
  const sections = bars
    .map((b) => ({ y: b.y, text: b.parts.sort((p, q) => p.x - q.x).map((p) => p.text).join('').replace(/\s+/g, ' ').trim() }))
    .filter((b) => /^Section\s*:/i.test(b.text))
    .map((b) => ({ y: b.y, name: b.text.replace(/^Section\s*:\s*/i, '').trim() }));
  return { visible, sections };
}

/** Group runs into visual lines (handles superscripts and table-cell gaps). */
export function buildLines(runs) {
  if (!runs.length) return [];
  const sizes = runs.map((r) => r.fs).sort((a, b) => a - b);
  const dom = sizes[Math.floor(sizes.length / 2)];
  const normal = runs.filter((r) => r.fs >= dom * 0.9).sort((a, b) => a.y - b.y || a.x - b.x);
  const small = runs.filter((r) => r.fs < dom * 0.9);
  const lines = [];
  for (const r of normal) {
    const l = lines.find((ln) => Math.abs(ln.y - r.y) < Math.max(2, 0.3 * r.fs));
    if (l) l.runs.push(r); else lines.push({ y: r.y, fs: r.fs, runs: [r] });
  }
  for (const r of small) {
    const l = lines.find((ln) => ln.y - r.y > 0.2 * ln.fs && ln.y - r.y < 0.9 * ln.fs && r.x >= Math.min(...ln.runs.map((q) => q.x)) - 2);
    if (l) l.runs.push({ ...r, sup: true });
    else lines.push({ y: r.y, fs: r.fs, runs: [r] });
  }
  for (const ln of lines) {
    ln.runs.sort((a, b) => a.x - b.x);
    let text = '', prev = null;
    for (const r of ln.runs) {
      const piece = r.sup ? toSup(r.text) : r.text;
      if (prev) {
        const gap = r.x - prev.x2;
        if (gap > 0.9 * ln.fs && !/\s$/.test(text)) text += ' | ';
        else if (gap > 0.2 * ln.fs && !/\s$/.test(text) && !/^\s/.test(piece)) text += ' ';
      }
      text += piece;
      prev = r;
    }
    const body = ln.runs.filter((r) => !r.sup);
    ln.text = text.replace(/[ \t\u00a0]+/g, ' ').trim();
    ln.x0 = Math.min(...body.map((r) => r.x));
    ln.x2 = Math.max(...body.map((r) => r.x2));
    ln.isTable = ln.text.includes(' | ');
    ln.firstWordW = firstWordWidth(body);
  }
  return lines.sort((a, b) => a.y - b.y);
}

function firstWordWidth(runs) {
  let w = 0, started = false, prevEnd = null;
  for (const r of runs) {
    if (started && prevEnd !== null && r.x - prevEnd > 0.2 * r.fs) break;
    for (let i = 0; i < r.chars.length; i++) {
      const ch = r.chars[i];
      if (/\s/.test(ch)) { if (started) return w; continue; }
      started = true; w += r.adv[i];
    }
    prevEnd = r.x2;
  }
  return w;
}

/**
 * Join lines. Lines that were only wrapped by the page layout are merged with a space; real line breaks
 * (statements, number series, blank lines) are kept. A break is "soft" when the next word would have fitted
 * on the current line, i.e. the line stopped short on purpose.
 */
export function linesToText(lines, rightLimit) {
  let out = '';
  lines.forEach((ln, i) => {
    out += ln.text;
    const next = lines[i + 1];
    if (!next) return;
    if (next.y - ln.y > 1.7 * 1.17 * ln.fs) { out += '\n\n'; return; }
    const spaceW = 0.278 * ln.fs;
    const soft = !ln.isTable && !next.isTable && ln.x2 + spaceW + next.firstWordW > rightLimit - 1;
    out += soft ? ' ' : '\n';
  });
  return out.replace(/ +\n/g, '\n').replace(/\n +/g, '\n').trim();
}

/** "Test Date | 27/03/2026" style header → metadata. */
export function parseHeader(lines) {
  const meta = { headerLines: lines.map((l) => l.text).filter(Boolean) };
  const kv = (label) => {
    const re = new RegExp(`^${label}\\s*\\|?\\s*:?\\s*(.+)$`, 'i');
    for (const t of meta.headerLines) { const m = t.match(re); if (m) return m[1].replace(/^\|\s*/, '').trim(); }
    return null;
  };
  meta.testDate = kv('Test Date');
  meta.testTime = kv('Test Time');
  meta.subject = kv('Subject');
  const all = meta.headerLines.join(' ');
  const pos = all.match(/Correct Answer will carry\s+([\d.]+)\s+marks?/i);
  const neg = all.match(/Incorrect Answer will carry\s+([\d./]+)\s+Negative/i);
  const frac = (s) => (s.includes('/') ? s.split('/').reduce((a, b) => a / b) : parseFloat(s));
  meta.marking = {
    correct: pos ? parseFloat(pos[1]) : null,
    negative: neg ? +frac(neg[1]).toFixed(4) : null,
    negativeRaw: neg ? neg[1] : null,
  };
  return meta;
}

/**
 * Comprehension / data-interpretation sets repeat the same passage in front of every sub-question.
 * Find long identical openings on consecutive questions and move them to `passage`.
 */
export function factorOutPassages(questions, minChars = 160) {
  let i = 0;
  while (i < questions.length - 1) {
    const a = questions[i].text, b = questions[i + 1].text;
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    const cut = Math.max(a.lastIndexOf('\n', n - 1), a.lastIndexOf('. ', n - 1) + 1);
    if (cut >= minChars) {
      const passage = a.slice(0, cut).trim();
      let j = i;
      while (j < questions.length && questions[j].text.startsWith(passage)) {
        questions[j].passage = passage;
        questions[j].text = questions[j].text.slice(passage.length).trim();
        j++;
      }
      i = j;
    } else i++;
  }
}
