import { useEffect, useMemo, useRef, useState } from "react";
import "./pdfWorker.js";
import { extractPaper } from "./extractPaper.js";
import "./PaperImport.css";

function Pic({ img, alt }) {
  const url = useMemo(
    () => (img ? URL.createObjectURL(img.blob) : null),
    [img],
  );
  useEffect(() => () => url && URL.revokeObjectURL(url), [url]);
  if (!url) return null;
  return (
    <img
      className="pi-img"
      src={url}
      alt={alt}
      style={{ width: Math.round((img.width / img.scale) * 1.25) }}
    />
  );
}

/**
 * <PaperImport onImport={async (paper) => { …save to IndexedDB… }} onCancel={…} />
 * `paper` has the shape documented in README (images are Blobs).
 */
export default function PaperImport({ onImport, onCancel }) {
  const [phase, setPhase] = useState("idle"); // idle | working | review | saving | error
  const [progress, setProgress] = useState(null);
  const [paper, setPaper] = useState(null);
  const [error, setError] = useState("");
  const [over, setOver] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const abort = useRef(null);
  const input = useRef(null);

  async function start(file) {
    if (!file) return;
    if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) {
      setError("Please choose a PDF file.");
      setPhase("error");
      return;
    }
    abort.current = new AbortController();
    setPhase("working");
    setError("");
    setProgress({ page: 0, pages: 0, questions: 0 });
    try {
      const p = await extractPaper(file, {
        onProgress: setProgress,
        signal: abort.current.signal,
      });
      if (!p.questions.length)
        throw new Error(
          "No questions were found. Is this a response-sheet style PDF?",
        );
      setPaper(p);
      setPhase("review");
    } catch (e) {
      if (e.name === "AbortError") setPhase("idle");
      else {
        setError(e.message || String(e));
        setPhase("error");
      }
    }
  }

  const setCorrect = (qi, label) =>
    setPaper((p) => ({
      ...p,
      questions: p.questions.map((q, i) =>
        i !== qi
          ? q
          : {
              ...q,
              correct: label,
              options: q.options.map((o) => ({
                ...o,
                isCorrect: o.label === label,
              })),
              flags: q.flags.filter((f) => !f.endsWith("correct-marked")),
              answerEditedByUser: true,
            },
      ),
    }));

  async function save() {
    setPhase("saving");
    try {
      await onImport?.(paper);
    } catch (e) {
      setError(e.message || String(e));
      setPhase("error");
      return;
    }
    setPhase("idle");
    setPaper(null);
  }

  const stats = useMemo(
    () =>
      paper && {
        total: paper.questions.length,
        answered: paper.questions.filter((q) => q.correct).length,
        withImages: paper.questions.filter(
          (q) => q.images.length || q.options.some((o) => o.image),
        ).length,
        flagged: paper.questions.filter((q) => q.flags.length).length,
      },
    [paper],
  );

  if (phase === "idle" || phase === "error") {
    return (
      <div className="pi">
        <div
          className={`pi-drop${over ? " over" : ""}`}
          onClick={() => input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            start(e.dataTransfer.files?.[0]);
          }}
        >
          Drop a previous-year paper PDF here, or click to choose
          <small>
            Processed entirely in your browser — nothing is uploaded.
          </small>
        </div>
        <input
          ref={input}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={(e) => {
            start(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        {phase === "error" && <p className="pi-err">{error}</p>}
        {onCancel && (
          <div className="pi-actions">
            <button className="pi-btn" onClick={onCancel}>
              Cancel
            </button>
          </div>
        )}
      </div>
    );
  }

  if (phase === "working") {
    const pct = progress?.pages
      ? Math.round((progress.page / progress.pages) * 100)
      : 0;
    return (
      <div className="pi">
        <div>
          Reading page {progress?.page || "…"} of {progress?.pages || "…"} ·{" "}
          {progress?.questions ?? 0} questions found
        </div>
        <div className="pi-bar">
          <div style={{ width: `${pct}%` }} />
        </div>
        <button className="pi-btn" onClick={() => abort.current?.abort()}>
          Cancel
        </button>
      </div>
    );
  }

  const shown = showAll ? paper.questions : paper.questions.slice(0, 25);
  return (
    <div className="pi">
      <input
        className="pi-title"
        value={paper.title}
        onChange={(e) => setPaper({ ...paper, title: e.target.value })}
        aria-label="Paper title"
      />
      <div className="pi-chips">
        <span className="pi-chip">{stats.total} questions</span>
        <span
          className={`pi-chip${stats.answered < stats.total ? " warn" : ""}`}
        >
          {stats.answered} answers found
        </span>
        <span className="pi-chip">{stats.withImages} with images</span>
        {paper.sections.map((s) => (
          <span key={s.name} className="pi-chip">
            {s.name}: {s.questionCount}
          </span>
        ))}
        {paper.meta.marking?.correct != null && (
          <span className="pi-chip">
            +{paper.meta.marking.correct} / −
            {paper.meta.marking.negativeRaw ?? 0}
          </span>
        )}
        {stats.flagged > 0 && (
          <span className="pi-chip warn">{stats.flagged} need a look</span>
        )}
      </div>
      {paper.warnings.map((w) => (
        <div key={w} className="pi-flag">
          {w}
        </div>
      ))}
      <div className="pi-actions">
        <button
          className="pi-btn primary"
          disabled={phase === "saving"}
          onClick={save}
        >
          <span>
            {phase === "saving" ? "Saving…" : `Import ${stats.total} questions`}
          </span>
        </button>
        <button
          className="pi-btn"
          disabled={phase === "saving"}
          onClick={() => {
            setPaper(null);
            setPhase("idle");
          }}
        >
          Choose another PDF
        </button>
      </div>
      <div className="pi-list">
        {shown.map(
          (q, qi) => (
            console.log(q),
            (
              <div
                key={q.id}
                className={`pi-q${q.flags.length ? " flagged" : ""}`}
              >
                <div className="pi-qh">
                  <strong>Q.{q.number}</strong>
                  {q.section && <span>{q.section}</span>}
                </div>
                {q.passage && (
                  <p className="pi-text">
                    <em>{q.passage}</em>
                  </p>
                )}
                {q.text && <p className="pi-text">{q.text}</p>}
                {q.images.map((im, i) => (
                  <Pic key={i} img={im} alt={`Question ${q.number} figure`} />
                ))}
                {q.options.map((o) => (
                  <button
                    key={o.label}
                    type="button"
                    className={`pi-opt${o.isCorrect ? " ok" : ""}`}
                    onClick={() => setCorrect(qi, o.label)}
                    title="Click to mark as the correct answer"
                  >
                    <b>{o.label}.</b>
                    <span>{o.text}</span>
                    <Pic img={o.image} alt={`Option ${o.label}`} />
                    {o.isCorrect && (
                      <span style={{ marginLeft: "auto" }}>✓</span>
                    )}
                  </button>
                ))}
                {q.flags.length > 0 && (
                  <div className="pi-flag">⚠ {q.flags.join(", ")}</div>
                )}
              </div>
            )
          ),
        )}
      </div>
      {!showAll && paper.questions.length > shown.length && (
        <div className="pi-actions">
          <button className="pi-btn" onClick={() => setShowAll(true)}>
            Show all {paper.questions.length} questions
          </button>
        </div>
      )}
    </div>
  );
}
