import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Clock3,
  Flag,
  X,
} from "lucide-react";
import { sanitizeQuestionHtml } from "./responseSheetParser.js";

const ACTIVE_EXAM_KEY = "pypa-active-exam-v1";
const LETTERS = ["A", "B", "C", "D"];

function asMinutes(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : "";
}
function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h
    ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`
    : `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}
function makeSections(questions, saved = []) {
  const grouped = new Map();
  questions.forEach((q) => {
    const name = q.subject || "General";
    if (!grouped.has(name)) grouped.set(name, []);
    grouped.get(name).push(q);
  });
  return [...grouped.entries()].map(([name, qs]) => {
    const previous = saved.find((s) => s.name === name) || {};
    return {
      name,
      questionIds: qs.map((q) => q.id),
      durationMinutes: asMinutes(previous.durationMinutes),
    };
  });
}
function loadSavedExam() {
  try {
    return JSON.parse(localStorage.getItem(ACTIVE_EXAM_KEY) || "null");
  } catch {
    return null;
  }
}
function statusOf(answer) {
  if (!answer?.visited) return "not-visited";
  if (Number.isInteger(answer.answerIndex) && answer.marked)
    return "answered-marked";
  if (Number.isInteger(answer.answerIndex)) return "answered";
  if (answer.marked) return "marked";
  return "not-answered";
}

export default function ExamExperience({
  questions,
  papers,
  imageUrls = {},
  onSavePaperSettings,
  onClose,
}) {
  const paperIds = useMemo(
    () => [...new Set(questions.map((q) => q.paperId))].sort(),
    [questions],
  );
  const [paperId, setPaperId] = useState(paperIds[0] || "");
  const selectedPaper = papers.find((p) => p.id === paperId) || {};
  const paperQuestions = useMemo(
    () =>
      questions.filter(
        (q) =>
          q.paperId === paperId &&
          q.practiceReady !== false &&
          !q.visualReviewNeeded &&
          Number.isInteger(q.correctAnswerIndex),
      ),
    [questions, paperId],
  );
  const savedSettings = selectedPaper.examSettings || {};
  const [navigation, setNavigation] = useState(
    savedSettings.sectionNavigation || "free",
  );
  const [overallMinutes, setOverallMinutes] = useState(
    asMinutes(savedSettings.overallDurationMinutes),
  );
  const [positive, setPositive] = useState(savedSettings.positiveMarks ?? 1);
  const [negative, setNegative] = useState(savedSettings.negativeMarks ?? 0.25);
  const [saveDefaults, setSaveDefaults] = useState(false);
  const [sections, setSections] = useState(() =>
    makeSections(paperQuestions, savedSettings.sections),
  );
  const [exam, setExam] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [setupError, setSetupError] = useState("");
  const paletteGridRef = useRef(null);
  useEffect(() => {
    const savedExam = loadSavedExam();
    if (savedExam?.status === "running") {
      const restoredQuestions = (
        savedExam.questionIds ||
        savedExam.questions?.map((q) => q.id) ||
        []
      )
        .map((id) => questions.find((item) => item.id === id))
        .filter(Boolean);
      if (
        restoredQuestions.length &&
        restoredQuestions.length ===
          (savedExam.questionIds || savedExam.questions || []).length
      ) {
        setPaperId(savedExam.paperId);
        setExam({
          ...savedExam,
          questions: restoredQuestions,
          currentQuestionId: restoredQuestions.some(
            (q) => q.id === savedExam.currentQuestionId,
          )
            ? savedExam.currentQuestionId
            : restoredQuestions[0].id,
        });
      }
    }
  }, []);

  useEffect(() => {
    setNavigation(savedSettings.sectionNavigation || "free");
    setOverallMinutes(asMinutes(savedSettings.overallDurationMinutes));
    setPositive(savedSettings.positiveMarks ?? 1);
    setNegative(savedSettings.negativeMarks ?? 0.25);
    setSections(makeSections(paperQuestions, savedSettings.sections));
    setSaveDefaults(false);
    setSetupError("");
  }, [paperId]); // intentionally reset setup when paper changes

  useEffect(() => {
    if (!exam || exam.status !== "running") return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [exam?.status]);

  useEffect(() => {
    if (exam) {
      const { questions: examQuestions, ...persisted } = exam;
      localStorage.setItem(
        ACTIVE_EXAM_KEY,
        JSON.stringify({
          ...persisted,
          questionIds: examQuestions.map((question) => question.id),
        }),
      );
    }
  }, [exam]);

  const sectionByQuestion = useMemo(() => {
    const map = {};
    sections.forEach((section, index) =>
      section.questionIds.forEach((id) => {
        map[id] = index;
      }),
    );
    return map;
  }, [sections]);

  const currentQuestion =
    exam?.questions.find((q) => q.id === exam.currentQuestionId) || null;
  const currentQuestionIndex = exam
    ? exam.questions.findIndex((q) => q.id === exam.currentQuestionId)
    : -1;
  const currentSectionIndex = currentQuestion
    ? (sectionByQuestion[currentQuestion.id] ?? 0)
    : 0;
  const currentSection = exam?.sections[currentSectionIndex];

  const overallRemaining = exam?.overallDeadline
    ? Math.max(0, Math.ceil((exam.overallDeadline - now) / 1000))
    : null;
  const sectionRemaining = currentSection?.deadline
    ? Math.max(0, Math.ceil((currentSection.deadline - now) / 1000))
    : null;

  // Keep the active question visible inside the palette.
  // Scroll only the palette, never the entire page.
  useEffect(() => {
    if (exam?.status !== "running" || currentQuestionIndex < 0) return;

    const grid = paletteGridRef.current;
    const item = grid?.querySelector(
      `[data-palette-index="${currentQuestionIndex}"]`,
    );

    if (!grid || !item) return;

    const gridRect = grid.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();

    if (itemRect.top < gridRect.top) {
      grid.scrollTop -= gridRect.top - itemRect.top;
    } else if (itemRect.bottom > gridRect.bottom) {
      grid.scrollTop += itemRect.bottom - gridRect.bottom;
    }
  }, [currentQuestionIndex, exam?.status]);

  useEffect(() => {
    if (!exam || exam.status !== "running") return;
    if (overallRemaining === 0) {
      finishExam("time");
      return;
    }
    if (sectionRemaining === 0 && currentSection && !currentSection.locked) {
      setExam((prev) => ({
        ...prev,
        sections: prev.sections.map((s, i) =>
          i === currentSectionIndex ? { ...s, locked: true } : s,
        ),
      }));
    }
  }, [overallRemaining, sectionRemaining, exam?.status, currentSectionIndex]);

  async function startExam() {
    if (!paperQuestions.length) return;
    const configuredSections = sections.map((s) => ({
      ...s,
      durationSeconds: s.durationMinutes
        ? Number(s.durationMinutes) * 60
        : null,
      deadline: null,
      locked: false,
    }));
    const first = paperQuestions[0];
    const start = Date.now();
    if (configuredSections[0]?.durationSeconds)
      configuredSections[0].deadline =
        start + configuredSections[0].durationSeconds * 1000;
    const next = {
      id: `exam-${start}`,
      paperId,
      status: "running",
      startedAt: start,
      submittedAt: null,
      questions: paperQuestions,
      answers: Object.fromEntries(
        paperQuestions.map((q) => [
          q.id,
          { answerIndex: null, visited: q.id === first.id, marked: false },
        ]),
      ),
      sections: configuredSections,
      currentQuestionId: first.id,
      config: {
        sectionNavigation: navigation,
        positiveMarks: Number(positive),
        negativeMarks: Number(negative),
        overallDurationSeconds: overallMinutes
          ? Number(overallMinutes) * 60
          : null,
      },
      overallDeadline: overallMinutes
        ? start + Number(overallMinutes) * 60000
        : null,
    };
    if (saveDefaults) {
      try {
        await onSavePaperSettings?.(paperId, {
          sectionNavigation: navigation,
          overallDurationMinutes: overallMinutes || null,
          positiveMarks: Number(positive),
          negativeMarks: Number(negative),
          sections: sections.map(({ name, durationMinutes }) => ({
            name,
            durationMinutes: durationMinutes || null,
          })),
        });
      } catch (error) {
        setSetupError(error?.message || "Could not save paper settings.");
        return;
      }
    }
    setNow(start);
    setExam(next);
  }

  function navigateTo(questionId) {
    if (!exam || exam.status !== "running") return;
    const targetSection = exam.sections[sectionByQuestion[questionId] ?? 0];
    const activeSection =
      exam.sections[sectionByQuestion[exam.currentQuestionId] ?? 0];
    if (!targetSection || targetSection.locked) return;
    if (targetSection.deadline && targetSection.deadline <= Date.now()) {
      setExam((prev) => ({
        ...prev,
        sections: prev.sections.map((section, index) =>
          index === (sectionByQuestion[questionId] ?? 0)
            ? { ...section, locked: true }
            : section,
        ),
      }));
      return;
    }
    if (
      exam.config.sectionNavigation === "sequential" &&
      targetSection.name !== activeSection?.name
    ) {
      const activeIndex = sectionByQuestion[exam.currentQuestionId] ?? 0;
      const targetIndex = sectionByQuestion[questionId] ?? 0;
      if (targetIndex !== activeIndex + 1 && targetIndex !== activeIndex - 1)
        return;
    }
    setExam((prev) => {
      const targetIndex = sectionByQuestion[questionId] ?? 0;
      const target = prev.sections[targetIndex];
      const nextSections = prev.sections.map((section, index) =>
        index === targetIndex && !section.deadline && section.durationSeconds
          ? {
              ...section,
              deadline: Date.now() + section.durationSeconds * 1000,
            }
          : section,
      );
      return {
        ...prev,
        sections: nextSections,
        currentQuestionId: questionId,
        answers: {
          ...prev.answers,
          [questionId]: { ...prev.answers[questionId], visited: true },
        },
      };
    });
  }
  function updateAnswer(answerIndex) {
    if (!currentQuestion || currentSection?.locked) return;
    setExam((prev) => ({
      ...prev,
      answers: {
        ...prev.answers,
        [currentQuestion.id]: {
          ...prev.answers[currentQuestion.id],
          visited: true,
          answerIndex,
        },
      },
    }));
  }
  function clearAnswer() {
    if (!currentQuestion || currentSection?.locked) return;
    setExam((prev) => ({
      ...prev,
      answers: {
        ...prev.answers,
        [currentQuestion.id]: {
          ...prev.answers[currentQuestion.id],
          answerIndex: null,
        },
      },
    }));
  }
  function toggleReview() {
    if (!currentQuestion || currentSection?.locked) return;
    setExam((prev) => ({
      ...prev,
      answers: {
        ...prev.answers,
        [currentQuestion.id]: {
          ...prev.answers[currentQuestion.id],
          visited: true,
          marked: !prev.answers[currentQuestion.id].marked,
        },
      },
    }));
  }
  function finishExam(reason = "manual") {
    setExam((prev) =>
      prev
        ? {
            ...prev,
            status: "submitted",
            submittedAt: Date.now(),
            finishReason: reason,
          }
        : prev,
    );
    setConfirmSubmit(false);
  }
  function closeAndClear() {
    localStorage.removeItem(ACTIVE_EXAM_KEY);
    setExam(null);
    onClose?.();
  }
  const result = useMemo(() => {
    if (!exam || exam.status !== "submitted") return null;
    let correct = 0,
      incorrect = 0,
      unanswered = 0;
    for (const q of exam.questions) {
      const a = exam.answers[q.id];
      if (!Number.isInteger(a?.answerIndex)) unanswered++;
      else if (a.answerIndex === q.correctAnswerIndex) correct++;
      else incorrect++;
    }
    return {
      correct,
      incorrect,
      unanswered,
      attempted: correct + incorrect,
      score:
        correct * exam.config.positiveMarks -
        incorrect * exam.config.negativeMarks,
      max: exam.questions.length * exam.config.positiveMarks,
    };
  }, [exam]);

  return (
    <div
      className="exam-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Exam simulation"
    >
      <div className="exam-shell">
        <header className="exam-header">
          <div>
            <span className="exam-eyebrow">PYPA · EXAM SIMULATION</span>
            <h2>{exam ? exam.paperId : "Configure your exam"}</h2>
          </div>
          <button
            className="exam-icon-button"
            onClick={onClose}
            aria-label="Close exam"
          >
            <X size={20} />
          </button>
        </header>

        {!exam && (
          <div className="exam-setup">
            <div className="exam-setup-intro">
              <h3>Build an exam session</h3>
              <p>
                Choose a paper, confirm its sections and marking scheme, then
                start. Exam answers stay separate from practice progress.
              </p>
            </div>
            <div className="exam-config-grid">
              <label>
                Paper
                <select
                  value={paperId}
                  onChange={(e) => setPaperId(e.target.value)}
                >
                  {paperIds.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Section navigation
                <select
                  value={navigation}
                  onChange={(e) => setNavigation(e.target.value)}
                >
                  <option value="free">Free navigation</option>
                  <option value="sequential">Adjacent sections only</option>
                </select>
              </label>
              <label>
                Overall duration (minutes)
                <input
                  type="number"
                  min="1"
                  max="1440"
                  placeholder="No overall timer"
                  value={overallMinutes}
                  onChange={(e) => setOverallMinutes(asMinutes(e.target.value))}
                />
                <small>Manual setting. Leave blank for no overall timer.</small>
              </label>
              <label>
                Correct answer marks
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={positive}
                  onChange={(e) => setPositive(e.target.value)}
                />
              </label>
              <label>
                Incorrect answer penalty
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={negative}
                  onChange={(e) => setNegative(e.target.value)}
                />
              </label>
            </div>
            <div className="exam-section-settings">
              <div className="exam-section-settings-head">
                <h4>Section settings</h4>
                <span>Expiry action: lock section</span>
              </div>
              {sections.map((section, index) => (
                <div className="exam-section-setting" key={section.name}>
                  <div>
                    <strong>{section.name}</strong>
                    <small>{section.questionIds.length} questions</small>
                  </div>
                  <label>
                    Time limit (minutes)
                    <input
                      type="number"
                      min="1"
                      max="1440"
                      placeholder="No section timer"
                      value={section.durationMinutes}
                      onChange={(e) =>
                        setSections((prev) =>
                          prev.map((s, i) =>
                            i === index
                              ? {
                                  ...s,
                                  durationMinutes: asMinutes(e.target.value),
                                }
                              : s,
                          ),
                        )
                      }
                    />
                  </label>
                </div>
              ))}
              {!sections.length && (
                <p className="exam-muted">
                  No eligible sections found in this paper.
                </p>
              )}
            </div>
            <label className="exam-save-defaults">
              <input
                type="checkbox"
                checked={saveDefaults}
                onChange={(e) => setSaveDefaults(e.target.checked)}
              />{" "}
              Save these settings as this paper’s defaults
            </label>
            {setupError && (
              <p className="exam-warning" role="alert">
                <AlertTriangle size={15} />
                {setupError}
              </p>
            )}
            <div className="exam-setup-actions">
              <button className="button outline" onClick={onClose}>
                Cancel
              </button>
              <button
                className="button primary"
                disabled={!paperQuestions.length}
                onClick={startExam}
              >
                Start exam · {paperQuestions.length} questions
              </button>
            </div>
            {!paperQuestions.length && (
              <p className="exam-warning">
                <AlertTriangle size={15} /> This paper has no practice-ready
                questions with a verified answer key.
              </p>
            )}
          </div>
        )}

        {exam?.status === "running" && (
          <div className="exam-running">
            <div className="exam-toolbar">
              <div className="exam-timer">
                <Clock3 size={17} />
                <span>Overall</span>
                <strong
                  className={
                    overallRemaining !== null && overallRemaining < 300
                      ? "urgent"
                      : ""
                  }
                >
                  {overallRemaining === null
                    ? "No limit"
                    : formatTime(overallRemaining)}
                </strong>
              </div>
              <div className="exam-timer">
                <Clock3 size={17} />
                <span>{currentSection?.name || "Section"}</span>
                <strong
                  className={
                    sectionRemaining !== null && sectionRemaining < 120
                      ? "urgent"
                      : ""
                  }
                >
                  {sectionRemaining === null
                    ? "No limit"
                    : formatTime(sectionRemaining)}
                </strong>
              </div>
              <button
                className="button outline"
                onClick={() => setConfirmSubmit(true)}
              >
                Submit exam
              </button>
            </div>
            <nav className="exam-section-tabs" aria-label="Exam sections">
              {exam.sections.map((section, index) => (
                <button
                  type="button"
                  key={section.name}
                  aria-current={
                    index === currentSectionIndex ? "page" : undefined
                  }
                  className={`
        ${index === currentSectionIndex ? "active" : ""}
        ${section.locked ? "locked" : ""}
      `}
                  onClick={() => {
                    const qid = section.questionIds[0];
                    if (qid && !section.locked) navigateTo(qid);
                  }}
                >
                  {section.name}
                  {section.locked ? " · Locked" : ""}
                </button>
              ))}
            </nav>
            <div className="exam-workspace">
              <section className="exam-question-area">
                <div className="exam-question-meta">
                  <span>
                    Question{" "}
                    {exam.questions.findIndex(
                      (q) => q.id === currentQuestion?.id,
                    ) + 1}{" "}
                    of {exam.questions.length}
                  </span>
                  <span>
                    {currentQuestion?.subject || "General"} ·{" "}
                    {currentQuestion?.topic || "Mixed topics"}
                  </span>
                </div>
                {currentSection?.locked && (
                  <div className="exam-locked-notice">
                    <AlertTriangle size={16} /> This section has expired and is
                    locked. Your saved answers are retained.
                  </div>
                )}
                <div className="exam-question-copy">
                  {currentQuestion?.questionHtml ? (
                    <div
                      dangerouslySetInnerHTML={{
                        __html: sanitizeQuestionHtml(
                          currentQuestion.questionHtml,
                        ),
                      }}
                    />
                  ) : (
                    <p>{currentQuestion?.question}</p>
                  )}
                </div>
                {currentQuestion?.questionImage && (
                  <img
                    className="exam-question-image"
                    src={
                      /^https?:\/\//i.test(currentQuestion.questionImage)
                        ? currentQuestion.questionImage
                        : imageUrls[
                            `${currentQuestion.paperId}::${currentQuestion.questionImage}`
                          ]
                    }
                    alt="Question"
                  />
                )}
                <div className="exam-options">
                  {(currentQuestion?.options || []).map((option, index) => (
                    <button
                      key={index}
                      disabled={currentSection?.locked}
                      className={`exam-option ${exam.answers[currentQuestion.id]?.answerIndex === index ? "selected" : ""}`}
                      onClick={() => updateAnswer(index)}
                    >
                      <span>{LETTERS[index]}</span>
                      <div>
                        {/\.(png|jpe?g|webp|gif|svg|avif|bmp)(?:[?#].*)?$/i.test(
                          option,
                        ) ? (
                          <img
                            src={
                              imageUrls[
                                `${currentQuestion.paperId}::${option}`
                              ] || option
                            }
                            alt={`Option ${LETTERS[index]}`}
                          />
                        ) : (
                          option
                        )}
                        {currentQuestion.optionImageSources?.[index] && (
                          <img
                            src={
                              imageUrls[
                                `${currentQuestion.paperId}::${currentQuestion.optionImageSources[index]}`
                              ] || currentQuestion.optionImageSources[index]
                            }
                            alt="Option illustration"
                          />
                        )}
                      </div>
                    </button>
                  ))}
                </div>
                <div className="exam-question-actions">
                  <button
                    className="button outline"
                    disabled={currentSection?.locked}
                    onClick={clearAnswer}
                  >
                    Clear response
                  </button>
                  <button
                    className={`button ${exam.answers[currentQuestion.id]?.marked ? "light" : "outline"}`}
                    disabled={currentSection?.locked}
                    onClick={toggleReview}
                  >
                    <Flag size={14} />{" "}
                    {exam.answers[currentQuestion.id]?.marked
                      ? "Unmark review"
                      : "Mark for review"}
                  </button>
                  <div className="exam-spacer" />
                  <button
                    className="button outline"
                    onClick={() => {
                      const i = exam.questions.findIndex(
                        (q) => q.id === currentQuestion.id,
                      );
                      if (i > 0) navigateTo(exam.questions[i - 1].id);
                    }}
                    disabled={exam.questions[0]?.id === currentQuestion?.id}
                  >
                    Previous
                  </button>
                  <button
                    className="button primary"
                    onClick={() => {
                      const i = exam.questions.findIndex(
                        (q) => q.id === currentQuestion.id,
                      );
                      if (i < exam.questions.length - 1)
                        navigateTo(exam.questions[i + 1].id);
                    }}
                    disabled={exam.questions.at(-1)?.id === currentQuestion?.id}
                  >
                    Save & Next <ChevronRight size={15} />
                  </button>
                </div>
              </section>
              <aside className="exam-palette">
                <h3>Question palette</h3>
                {/* <div className="exam-section-tabs">
                  {exam.sections.map((section, index) => (
                    <button
                      key={section.name}
                      className={`${index === currentSectionIndex ? "active" : ""} ${section.locked ? "locked" : ""}`}
                      onClick={() => {
                        const qid = section.questionIds[0];
                        if (qid && !section.locked) navigateTo(qid);
                      }}
                    >
                      {section.name}
                      {section.locked ? " · Locked" : ""}
                    </button>
                  ))}
                </div> */}
                <div className="exam-palette-grid" ref={paletteGridRef}>
                  {exam.questions.map((q, index) => {
                    const status = statusOf(exam.answers[q.id]);
                    const locked =
                      exam.sections[sectionByQuestion[q.id]]?.locked;

                    const allowed =
                      exam.config.sectionNavigation === "free" ||
                      Math.abs(
                        (sectionByQuestion[q.id] ?? 0) - currentSectionIndex,
                      ) <= 1;

                    return (
                      <button
                        key={q.id}
                        data-palette-index={index}
                        disabled={locked || !allowed}
                        title={`${q.subject} · ${status}`}
                        className={`
                            palette-${status}
                            ${q.id === currentQuestion.id ? "current" : ""}
                          `}
                        onClick={() => navigateTo(q.id)}
                      >
                        {index + 1}
                      </button>
                    );
                  })}
                </div>
                <div className="exam-legend">
                  <span>
                    <i className="palette-not-visited" /> Not visited
                  </span>
                  <span>
                    <i className="palette-answered" /> Answered
                  </span>
                  <span>
                    <i className="palette-marked" /> Marked
                  </span>
                  <span>
                    <i className="palette-answered-marked" /> Answered + marked
                  </span>
                  <span>
                    <i className="palette-not-answered" /> Visited, unanswered
                  </span>
                </div>
                <div className="exam-palette-summary">
                  <strong>
                    {
                      Object.values(exam.answers).filter((a) =>
                        Number.isInteger(a.answerIndex),
                      ).length
                    }
                  </strong>{" "}
                  answered <span>·</span>{" "}
                  <strong>
                    {Object.values(exam.answers).filter((a) => a.marked).length}
                  </strong>{" "}
                  marked
                </div>
              </aside>
            </div>
          </div>
        )}

        {exam?.status === "submitted" && result && (
          <div className="exam-result">
            <div className="exam-result-icon">
              <Check size={28} />
            </div>
            <h3>Exam submitted</h3>
            <p>
              {exam.finishReason === "time"
                ? "The overall timer expired. The exam was submitted automatically."
                : "Your responses have been evaluated."}
            </p>
            <div className="exam-result-score">
              <strong>{result.score.toFixed(2)}</strong>
              <span> / {result.max.toFixed(2)} marks</span>
            </div>
            <div className="exam-result-grid">
              <div>
                <strong>{result.correct}</strong>
                <small>Correct</small>
              </div>
              <div>
                <strong>{result.incorrect}</strong>
                <small>Incorrect</small>
              </div>
              <div>
                <strong>{result.unanswered}</strong>
                <small>Unanswered</small>
              </div>
              <div>
                <strong>
                  {result.attempted
                    ? `${Math.round((result.correct / result.attempted) * 100)}%`
                    : "—"}
                </strong>
                <small>Accuracy</small>
              </div>
            </div>
            <div className="exam-result-actions">
              <button className="button outline" onClick={closeAndClear}>
                Close result
              </button>
              <button className="button primary" onClick={closeAndClear}>
                Done
              </button>
            </div>
          </div>
        )}

        {confirmSubmit && (
          <div className="exam-confirm-backdrop">
            <div className="exam-confirm">
              <h3>Submit this exam?</h3>
              <p>You will not be able to change answers after submission.</p>
              <div>
                <button
                  className="button outline"
                  onClick={() => setConfirmSubmit(false)}
                >
                  Continue exam
                </button>
                <button
                  className="button primary"
                  onClick={() => finishExam("manual")}
                >
                  Submit now
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
