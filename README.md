# pdfImport — turn a response-sheet PDF into a re-attemptable paper

100 % client-side (pdf.js + canvas). No backend, nothing uploaded. Drop the `src/pdfImport/` folder into your Vite + React app.

## Install

```bash
npm i pdfjs-dist
```

Tested with pdfjs-dist **6.2.108** and Chromium. If Vite complains about top-level `await` in pdf.js, add to `vite.config.js`:

```js
build: { target: 'esnext' }, optimizeDeps: { exclude: ['pdfjs-dist'] }
```

## Use

**Ready-made UI** (upload → progress → review/fix answers → import):

```jsx
import { PaperImport } from './pdfImport';

<PaperImport
  onImport={async (paper) => { await savePaperToIndexedDB(paper); }}
  onCancel={() => navigate(-1)}
/>
```

**Or headless:**

```js
import './pdfImport/pdfWorker.js';              // once: registers the pdf.js worker
import { extractPaper } from './pdfImport';

const paper = await extractPaper(file, {
  onProgress: ({ page, pages, questions }) => {},
  signal: abortController.signal,               // optional
  scale: 3,                                      // render scale for image crops (3 ≈ 216 dpi)
});
```

## Output shape

```js
{
  schemaVersion: 1,
  title: 'RRB NTPC GRADUATE CBT 1 · 27/03/2026 · 4:30 PM - 6:00 PM',   // editable
  source: { fileName, pageCount, extractedAt, extractorVersion },
  meta: { testDate, testTime, subject, marking: { correct: 1, negative: 0.3333, negativeRaw: '1/3' }, headerLines: [...] },
  sections: [{ name, startQuestion, questionCount }],
  questions: [{
    id: 'q1',                    // unique, sequential
    number: 1,                   // number printed on the sheet
    section: 'RRB NTPC GRADUATE CBT 1',
    passage: null,               // shared comprehension text, if consecutive questions repeat one
    text: '…',                   // '' when the whole question is an image
    images: [{ blob, width, height, scale }],        // figures / formula images / tables
    options: [{ label: 'A', text: '…', image: {blob,…} | null, isCorrect: true|false }],
    correct: 'D' | null,         // null => couldn't tell, ask the user (flags says why)
    candidateChoice: null | 'B', // see "not verified" below
    flags: []                    // 'no-correct-marked' | 'multiple-correct-marked' | 'mixed-content' | 'empty-question' | …
  }],
  warnings: []
}
```

Images are **Blobs** — IndexedDB stores them natively. `paperToJSON()/paperFromJSON()` convert to/from data-URLs if you need plain JSON.
To render: `const url = URL.createObjectURL(img.blob)` (revoke when done). Display size ≈ `img.width / img.scale` points.

### Mapping to your existing store

Your current URL-parser output is not known to me, so `onImport` receives the neutral shape above. Typical adapter:

```js
const toMyFormat = (p) => ({
  name: p.title,
  questions: p.questions.map((q) => ({
    q: q.text, qImages: q.images.map((i) => i.blob), passage: q.passage,
    options: q.options.map((o) => ({ text: o.text, image: o.image?.blob ?? null })),
    answerIndex: q.options.findIndex((o) => o.isCorrect),
    section: q.section,
  })),
});
```

## How it works

| Need | Technique |
|---|---|
| Question / option text | Walks the pdf.js operator list → every text run with exact position **and fill colour** |
| Correct answer | Option drawn **green** (+ tick icon, double-checked from rendered pixels). Red = wrong |
| Hidden "tracking" digits glued to questions (`…cluster)8865`) | They are **white** text → dropped. White "Section :" bar text is kept as the section label |
| Images, formulas, vector-drawn maths, figures, tables | Renders the page, blanks every rectangle explained by real text, and crops whatever dark "ink" is left inside that cell (so it works for embedded images **and** vector drawings) |
| Row boundaries (tall fraction options) | Detected from the cell borders in the render, not fixed offsets |
| Watermark | Pale-pink watermark wiped to white in crops |
| Wrapped lines vs real line breaks | A break is "soft" if the next word would have fitted on the line |
| Superscripts | `cm²`, `24th`, … |

## Verified on the sample (CBT-I-27-03-2026_S3.pdf, 17 pages, 100 Q)

* 100/100 questions found, numbered 1–100, **100/100 answers match** the green ticks (checked against a hand-read key)
* Exactly the 8 questions that contain graphics got images (Q17, 21, 32, 34, 38, 64, 78, 79); zero false positives on the other 92
* Header metadata, section name and marking scheme (+1 / −1/3) parsed; runtime ≈ 2.5 s in headless Chromium

## Not verified (no sample available) — please test and send me a PDF if something is off

* **Candidate's chosen option** (`candidateChoice`): the sample has no attempted answers. The code looks in the area right of the question for `Chosen Option : N` or a lone A–E/1–5 token. Format is a guess.
* **Comprehension passages**: detected only as an identical long opening shared by consecutive questions. A passage that is an *image* is repeated per question.
* **Multi-section papers**: reads "Section : …" bars; not tried with several.
* **Questions split across a page break** are not stitched together.
* **Hindi / bilingual sheets** and other sheet layouts (different providers) — layout constants (cell borders, label column at x < 55 pt) are tuned to this format.
* Answers are always editable in the review screen; questions with `flags` are outlined in the UI.
