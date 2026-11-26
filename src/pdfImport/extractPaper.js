/**
 * extractPaper.js — public API.
 *
 *   const paper = await extractPaper(file, { onProgress });
 *
 * Works for the "response sheet" PDFs (Adda247 / RRB style): Q.n label, question cell, "Ans" row,
 * one row per option, correct option drawn in green (+ tick icon), wrong ones in red (+ cross icon).
 * Everything runs in the browser; nothing is uploaded anywhere.
 */
import { readTextRuns } from './pdfRuns.js';
import { renderPage, findInk, colourCensus, cropToBlob, findHLines, findVLine } from './imageCrop.js';
import { splitHiddenText, buildLines, linesToText, parseHeader, factorOutPassages, isGreen, isRed } from './parsePaper.js';

const Q_LABEL = /^Q\.?\s*(\d+)$/;
const OPT_LABEL = /^\s*\(?([A-Ea-e])[.)]\s?/;
const EXTRACTOR_VERSION = 1;

const runBox = (r, padX = 0.7, padY = 1.0) => ({
  x0: r.x - padX, x1: r.x2 + padX, y0: r.y - 0.95 * r.fs - padY, y1: r.y + 0.3 * r.fs + padY,
});
const overlaps = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

/** "Q.11" can be split into several text runs ("Q.1" + "1"), so join the left-column runs of each line first. */
function findQLabels(runs) {
  const rows = [];
  for (const r of runs.filter((q) => q.x < 55).sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = rows.find((w) => Math.abs(w.y - r.y) < 2);
    if (row) row.parts.push(r); else rows.push({ y: r.y, parts: [r] });
  }
  return rows
    .map((w) => ({ y: w.y, x: w.parts[0].x, text: w.parts.sort((a, b) => a.x - b.x).map((p) => p.text).join('').trim() }))
    .filter((w) => Q_LABEL.test(w.text));
}

async function toBytes(src) {
  if (typeof src === 'string') return new Uint8Array(await (await fetch(src)).arrayBuffer());
  if (src instanceof Uint8Array) return src;
  if (src instanceof ArrayBuffer) return new Uint8Array(src);
  return new Uint8Array(await src.arrayBuffer()); // File | Blob
}

export async function extractPaper(source, opts = {}) {
  const { scale = 3, onProgress, signal, fileName = source?.name ?? null } = opts;
  const lib = opts.pdfjsLib ?? (await import('pdfjs-dist'));
  const doc = await lib.getDocument({ data: await toBytes(source) }).promise;

  const raw = [];            // per question, text still as lines
  const sectionBars = [];    // {page, y, name}
  const warnings = [];
  let header = null;

  for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
    if (signal?.aborted) throw new DOMException('Import cancelled', 'AbortError');
    onProgress?.({ page: pageNo, pages: doc.numPages, questions: raw.length });
    const page = await doc.getPage(pageNo);
    const { visible: runs, sections } = splitHiddenText(await readTextRuns(page, lib));
    sections.forEach((s) => sectionBars.push({ page: pageNo, ...s }));

    const qLabels = findQLabels(runs);
    if (!qLabels.length) { page.cleanup(); continue; }   // ads, cover pages …

    const R = await renderPage(page, scale);
    const pageH = R.canvas.height / scale;
    const hl = findHLines(R, 80, 400);
    const above = (y, d, min = -Infinity) => hl.filter((v) => v <= y - d && v >= min).pop();
    const below = (y, d, max = Infinity) => hl.find((v) => v >= y + d && v <= max);

    if (!header) header = buildLines(runs.filter((r) => r.y < qLabels[0].y - 14));

    for (let k = 0; k < qLabels.length; k++) {
      const q = qLabels[k];
      const num = +q.text.trim().match(Q_LABEL)[1];
      const nextY = qLabels[k + 1]?.y ?? Infinity;
      const ans = runs.find((r) => r.x < 50 && r.text.trim() === 'Ans' && r.y > q.y && r.y < nextY);
      if (!ans) { warnings.push(`Q.${num}: "Ans" row not found, skipped`); continue; }
      const blockEnd = Number.isFinite(nextY) ? nextY - 14 : pageH;

      // ---- question cell -------------------------------------------------------------------------
      const qTop = above(q.y, 6) ?? q.y - 12;
      const qBottom = hl.filter((v) => v > q.y + 4 && v <= ans.y - 3).pop() ?? ans.y - 8;
      const qRight = findVLine(R, 350, 590, qTop + 2, qBottom - 2) ?? 428;
      const qRuns = runs.filter((r) => r.x >= 55 && r.x < qRight && r.y >= q.y - 4 && r.y < qBottom);
      const rzRuns = runs.filter((r) => r.x >= qRight && r.y >= qTop && r.y < qBottom);
      const qLines = buildLines(qRuns);

      const flags = [];
      const qRegion = { x0: 58.6, x1: qRight - 1, y0: qTop + 1.2, y1: qBottom - 1.2 };
      const qInk = findInk(R, qRegion, qRuns.map((r) => runBox(r)));
      const images = [];
      if (qInk) {
        let rect = qInk;
        const inline = qLines.some((ln) =>
          ln.y - 0.95 * ln.fs < qInk.y1 && ln.y + 0.3 * ln.fs > qInk.y0 && (ln.x0 < qInk.x0 - 1 || ln.x2 > qInk.x1 + 1));
        if (inline) {   // picture sits inside a sentence → keep sentence + picture together
          const boxes = qRuns.map((r) => runBox(r));
          rect = {
            x0: Math.min(qInk.x0, ...boxes.map((b) => b.x0)), y0: Math.min(qInk.y0, ...boxes.map((b) => b.y0)),
            x1: Math.max(qInk.x1, ...boxes.map((b) => b.x1)), y1: Math.max(qInk.y1, ...boxes.map((b) => b.y1)),
          };
          flags.push('mixed-content');
        }
        images.push(await cropToBlob(R, rect, { pad: 3, clip: qRegion, avoid: inline ? [] : qRuns.map((r) => runBox(r)) }));
      }

      // ---- option rows ---------------------------------------------------------------------------
      const cand = runs
        .filter((r) => r.x > 68 && r.x < 100 && r.y >= ans.y - 3 && r.y < blockEnd && OPT_LABEL.test(r.text))
        .sort((a, b) => a.y - b.y);
      const labels = [];
      for (const r of cand) {
        const L = r.text.match(OPT_LABEL)[1].toUpperCase();
        if (L === String.fromCharCode(65 + labels.length)) labels.push(r);
      }
      const options = [];
      for (let j = 0; j < labels.length; j++) {
        const lab = labels[j], b = lab.y, nextB = labels[j + 1]?.y ?? Infinity;
        const prevBottom = j ? options[j - 1]._bottom : qBottom;
        const top = above(b, 6, prevBottom - 1) ?? prevBottom;
        const bottom = below(b, 2.5, Math.min(nextB - 6, blockEnd)) ?? b + 9;
        const rowRuns = runs.filter((r) => r.x >= lab.x - 2 && r.y > top && r.y < bottom);
        const text = linesToText(buildLines(rowRuns), -Infinity).replace(OPT_LABEL, '').trim();

        const region = { x0: lab.x, x1: 575, y0: top + 1.2, y1: bottom - 1.2 };
        const ink = findInk(R, region, rowRuns.map((r) => runBox(r)));
        const image = ink ? await cropToBlob(R, ink, { pad: 2, clip: region, avoid: rowRuns.map((r) => runBox(r)) }) : null;

        const icon = colourCensus(R, { x0: 57, x1: lab.x - 1, y0: top + 1.2, y1: bottom - 1.2 });
        const greenMark = rowRuns.some((r) => isGreen(r.color)) || (icon.green >= 50 && icon.green > icon.red);
        const redMark = rowRuns.some((r) => isRed(r.color)) || icon.red >= 50;
        options.push({ label: String.fromCharCode(65 + j), text, image, isCorrect: greenMark, _wrong: redMark, _bottom: bottom });
      }

      // ---- candidate's own choice (only present on attempted sheets; right of the question) --------
      // UNVERIFIED on real attempted sheets (the sample PDF has none): accept "Chosen Option : 2" or a lone A–E / 1–5 token.
      const rz = rzRuns.map((r) => r.text).join(' ').replace(/\s+/g, ' ').trim();
      const cm = rz.match(/chosen\s*option\s*:?\s*([A-Ea-e1-5])\b/i) ?? rz.match(/^([A-Ea-e1-5])$/);
      const candidateChoice = cm ? (/\d/.test(cm[1]) ? String.fromCharCode(64 + +cm[1]) : cm[1].toUpperCase()) : null;

      raw.push({
        number: num, pageNo, y: q.y, qLines, images, options, candidateChoice, flags,
      });
    }
    R.canvas.width = R.canvas.height = 0;   // free the bitmap right away
    page.cleanup();
  }

  // ---- assemble ---------------------------------------------------------------------------------
  const rightLimit = Math.max(...raw.flatMap((r) => r.qLines.filter((l) => !l.isTable).map((l) => l.x2)), 0);
  sectionBars.sort((a, b) => a.page - b.page || a.y - b.y);
  const meta = parseHeader(header ?? []);

  const questions = raw.map((r, idx) => {
    const correct = r.options.filter((o) => o.isCorrect);
    const flags = [...r.flags];
    const text = linesToText(r.qLines, rightLimit);
    if (!text && !r.images.length) flags.push('empty-question');
    if (r.options.length < 2) flags.push('options-not-found');
    if (correct.length === 0) flags.push('no-correct-marked');
    if (correct.length > 1) flags.push('multiple-correct-marked');
    r.options.forEach((o) => { if (!o.text && !o.image) flags.push(`empty-option-${o.label}`); });
    const bar = [...sectionBars].reverse().find((s) => s.page < r.pageNo || (s.page === r.pageNo && s.y < r.y));
    return {
      id: `q${idx + 1}`,            // unique even if the sheet restarts numbering per section
      number: r.number,
      section: bar?.name ?? meta.subject ?? null,
      passage: null,
      text,
      images: r.images,
      options: r.options.map(({ label, text: t, image, isCorrect }) => ({ label, text: t, image, isCorrect })),
      correct: correct.length === 1 ? correct[0].label : null,
      candidateChoice: r.candidateChoice,
      flags,
    };
  });
  factorOutPassages(questions);

  const sections = [];
  for (const q of questions) {
    let s = sections[sections.length - 1];
    if (!s || s.name !== q.section) { s = { name: q.section, startQuestion: q.number, questionCount: 0 }; sections.push(s); }
    s.questionCount++;
  }

  return {
    schemaVersion: 1,
    source: { fileName, pageCount: doc.numPages, extractedAt: new Date().toISOString(), extractorVersion: EXTRACTOR_VERSION },
    title: [meta.subject, meta.testDate, meta.testTime].filter(Boolean).join(' · ') || fileName || 'Imported paper',
    meta,
    sections,
    questions,
    warnings,
  };
}
