import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Flag,
  X,
} from "lucide-react";
import { sanitizeQuestionHtml } from "./responseSheetParser.js";
import { saveExamAttempt } from "./db.js";

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
function stopQuestionClock(answers, questionId, at = Date.now()) {
  if (!questionId || !answers?.[questionId]) return answers;
  const answer = answers[questionId];
  const elapsed = answer.activeSince
    ? Math.max(0, at - Number(answer.activeSince))
    : 0;
  return {
    ...answers,
    [questionId]: {
      ...answer,
      timeSpentMs: Math.max(0, Number(answer.timeSpentMs) || 0) + elapsed,
      activeSince: null,
    },
  };
}

function applyAnswerChange(answers, questionId, nextAnswerIndex, at = Date.now()) {
  const previous = answers[questionId] || {};
  if (previous.answerIndex === nextAnswerIndex) return answers;
  const changes = previous.answerChanges || [];
  return {
    ...answers,
    [questionId]: {
      ...previous,
      answerIndex: nextAnswerIndex,
      answerChangeCount: (Number(previous.answerChangeCount) || 0) + 1,
      answerChanges: [...changes, {
        from: Number.isInteger(previous.answerIndex) ? previous.answerIndex : null,
        to: Number.isInteger(nextAnswerIndex) ? nextAnswerIndex : null,
        at,
      }],
    },
  };
}

function statusOf(answer) {
  if (!answer?.visited) return "not-visited";
  if (Number.isInteger(answer.answerIndex) && answer.marked)
    return "answered-marked";
  if (Number.isInteger(answer.answerIndex)) return "answered";
  if (answer.marked) return "marked";
  return "not-answered";
}
function renderQuestionHtmlWithImages(html, question, imageUrls) {
  const imagePaths =
    question.questionImages?.length > 0
      ? question.questionImages
      : question.questionImage
        ? [question.questionImage]
        : [];
  // console.log("Question:", question.id);
  // console.log("Stored image paths:", imagePaths);
  // console.log(
  //   "HTML placeholders:",
  //   question.questionHtml?.match(/\[\[QUESTION_IMAGE_\d+\]\]/g),
  // );
  const renderedImageIndices = new Set();

  // function getImageSrc(imageIndex) {
  //   const imagePath = imagePaths[imageIndex];

  //   if (!imagePath) return null;

  //   return /^https?:\/\//i.test(imagePath)
  //     ? imagePath
  //     : imageUrls[`${question.paperId}::${imagePath}`] || null;
  // }
  function getImageSrc(imageIndex) {
    const imagePath = imagePaths[imageIndex];

    if (!imagePath) {
      console.warn("Missing image path:", imageIndex);
      return null;
    }

    const imageKey = `${question.paperId}::${imagePath}`;

    const imageSrc = /^https?:\/\//i.test(imagePath)
      ? imagePath
      : imageUrls[imageKey] || null;

    console.log("Image resolution:", {
      imageIndex,
      imagePath,
      imageKey,
      imageSrc,
      availableKeys: Object.keys(imageUrls).filter((key) =>
        key.includes(imagePath),
      ),
    });

    return imageSrc;
  }

  function renderImage(imageIndex, key) {
    const imageSrc = getImageSrc(imageIndex);

    if (!imageSrc) return null;

    renderedImageIndices.add(imageIndex);

    return (
      <img
        key={key}
        className="exam-question-image"
        src={imageSrc}
        alt={`Question illustration ${imageIndex + 1}`}
      />
    );
  }

  // Render text nodes and replace placeholders wherever they occur,
  // including inside nested elements such as <sup>, <span>, etc.
  function renderText(text, keyPrefix) {
    const parts = text.split(/(\[\[QUESTION_IMAGE_\d+\]\])/g);

    return parts.map((part, index) => {
      const match = part.match(/^\[\[QUESTION_IMAGE_(\d+)\]\]$/);

      if (match) {
        const imageIndex = Number(match[1]);

        return renderImage(imageIndex, `${keyPrefix}-image-${imageIndex}`);
      }

      return part ? (
        <React.Fragment key={`${keyPrefix}-text-${index}`}>
          {part}
        </React.Fragment>
      ) : null;
    });
  }

  // Convert the sanitized HTML DOM into React elements.
  function renderNode(node, key) {
    if (node.nodeType === 3) {
      return renderText(node.nodeValue || "", key);
    }

    if (node.nodeType !== 1) return null;

    const tag = node.tagName.toLowerCase();

    const props = {};

    if (tag === "td" || tag === "th") {
      if (node.hasAttribute("colspan")) {
        props.colSpan = Number(node.getAttribute("colspan"));
      }

      if (node.hasAttribute("rowspan")) {
        props.rowSpan = Number(node.getAttribute("rowspan"));
      }

      if (node.hasAttribute("align")) {
        props.align = node.getAttribute("align");
      }
    }

    const children = Array.from(node.childNodes).map((child, index) =>
      renderNode(child, `${key}-${index}`),
    );

    return React.createElement(tag, { key, ...props }, ...children);
  }

  // Sanitize before converting the HTML into React elements.
  const safeHtml = sanitizeQuestionHtml(html || "");
  const parsed = new DOMParser().parseFromString(safeHtml, "text/html");

  const htmlContent = Array.from(parsed.body.childNodes).map((node, index) =>
    renderNode(node, `question-node-${index}`),
  );

  // Render stored images that have no corresponding HTML placeholder.
  // This prevents missing images without duplicating already-rendered ones.
  const remainingImages = imagePaths
    .map((_, index) => index)
    .filter((index) => !renderedImageIndices.has(index))
    .map((index) => (
      <div key={`fallback-question-image-${index}`}>
        {renderImage(index, `fallback-image-${index}`)}
      </div>
    ));

  return (
    <>
      {htmlContent}
      {remainingImages}
    </>
  );
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
    savedSettings.sectionNavigation === "timed"
      ? "free"
      : savedSettings.sectionNavigation || "free",
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
  const [attemptSaveError, setAttemptSaveError] = useState("");
  const paletteGridRef = useRef(null);
  const examRef = useRef(null);
  examRef.current = exam;
  useEffect(() => {
    const savedExam = loadSavedExam();
    if (savedExam && ["running", "submitted"].includes(savedExam.status)) {
      const savedQuestionIds =
        savedExam.questionIds || savedExam.questions?.map((q) => q.id) || [];
      const restoredQuestions = savedQuestionIds
        .map((id) => questions.find((item) => item.id === id))
        .filter(Boolean);

      if (
        restoredQuestions.length &&
        restoredQuestions.length === savedQuestionIds.length
      ) {
        const restored = {
          ...savedExam,
          questions: restoredQuestions,
          currentQuestionId: restoredQuestions.some(
            (q) => q.id === savedExam.currentQuestionId,
          )
            ? savedExam.currentQuestionId
            : restoredQuestions[0].id,
          answers: { ...(savedExam.answers || {}) },
        };
        // Do not count time while the app was closed or the exam was suspended.
        const restoredActiveId = restored.currentQuestionId;
        if (restored.answers[restoredActiveId]) {
          restored.answers[restoredActiveId] = {
            ...restored.answers[restoredActiveId],
            activeSince: Date.now(),
          };
        }

        // Migrate sessions created before strict sectional timing existed.
        // A legacy session with every section timed becomes strict timed mode;
        // a partially timed legacy session is normalized to overall-only mode.
        if (typeof restored.config?.sectionalTiming !== "boolean") {
          const legacySections = restored.sections || [];
          const allLegacySectionsTimed =
            legacySections.length > 0 &&
            legacySections.every(
              (section) => Number(section.durationSeconds) > 0,
            );

          if (allLegacySectionsTimed) {
            let elapsedSeconds = 0;
            const migratedSections = legacySections.map((section) => {
              const durationSeconds = Number(section.durationSeconds);
              const startedAt = restored.startedAt + elapsedSeconds * 1000;
              elapsedSeconds += durationSeconds;
              const deadline = restored.startedAt + elapsedSeconds * 1000;
              return {
                ...section,
                startedAt,
                deadline,
                locked: deadline <= Date.now(),
              };
            });
            const activeIndex = migratedSections.findIndex(
              (section) => section.deadline > Date.now(),
            );
            const activeSection = migratedSections[activeIndex];
            const activeQuestionId = activeSection?.questionIds?.includes(
              restored.currentQuestionId,
            )
              ? restored.currentQuestionId
              : activeSection?.questionIds?.[0];

            restored.sections = migratedSections;
            restored.config = {
              ...restored.config,
              sectionalTiming: true,
              sectionNavigation: "timed",
              overallDurationSeconds: elapsedSeconds,
              totalDurationSeconds: elapsedSeconds,
            };
            restored.overallDeadline = null;
            if (activeQuestionId) {
              restored.currentQuestionId = activeQuestionId;
              restored.answers[activeQuestionId] = {
                ...restored.answers[activeQuestionId],
                visited: true,
              };
            } else {
              restored.status = "submitted";
              restored.submittedAt = Date.now();
              restored.finishReason = "section-time";
            }
          } else {
            restored.sections = legacySections.map((section) => ({
              ...section,
              durationSeconds: null,
              startedAt: null,
              deadline: null,
              locked: false,
            }));
            restored.config = {
              ...restored.config,
              sectionalTiming: false,
              sectionNavigation: restored.config?.sectionNavigation || "free",
            };
          }
        }

        restored.answers = Object.fromEntries(
          restoredQuestions.map((question) => {
            const answer = restored.answers[question.id] || {};
            return [question.id, {
              answerIndex: Number.isInteger(answer.answerIndex) ? answer.answerIndex : null,
              visited: Boolean(answer.visited),
              marked: Boolean(answer.marked),
              timeSpentMs: Math.max(0, Number(answer.timeSpentMs) || 0),
              visitCount: Math.max(0, Number(answer.visitCount) || (answer.visited ? 1 : 0)),
              answerChangeCount: Math.max(0, Number(answer.answerChangeCount) || 0),
              answerChanges: Array.isArray(answer.answerChanges) ? answer.answerChanges : [],
              activeSince: question.id === restored.currentQuestionId && restored.status === "running"
                ? (document.hidden ? null : Date.now())
                : null,
            }];
          }),
        );
        setPaperId(savedExam.paperId);
        setExam(restored);
      }
    }
  }, []);

  useEffect(() => {
    setNavigation(
      savedSettings.sectionNavigation === "timed"
        ? "free"
        : savedSettings.sectionNavigation || "free",
    );
    setOverallMinutes(asMinutes(savedSettings.overallDurationMinutes));
    setPositive(savedSettings.positiveMarks ?? 1);
    setNegative(savedSettings.negativeMarks ?? 0.25);
    setSections(makeSections(paperQuestions, savedSettings.sections));
    setSaveDefaults(false);
    setSetupError("");
  }, [paperId]); // intentionally reset setup when paper changes

  useEffect(() => {
    if (!exam || exam.status !== "running") return undefined;
    const id = window.setInterval(() => {
      const tickAt = Date.now();
      setNow(tickAt);
      // Persist active-question time at one-second granularity. Besides making
      // timing accurate across revisits, this limits crash/reload loss to ~1s.
      if (!document.hidden) {
        setExam((prev) => {
          if (!prev || prev.status !== "running") return prev;
          const activeId = prev.currentQuestionId;
          const answer = prev.answers[activeId];
          if (!answer?.activeSince) return prev;
          const elapsed = Math.max(0, tickAt - Number(answer.activeSince));
          if (!elapsed) return prev;
          return {
            ...prev,
            answers: {
              ...prev.answers,
              [activeId]: {
                ...answer,
                timeSpentMs: Math.max(0, Number(answer.timeSpentMs) || 0) + elapsed,
                activeSince: tickAt,
              },
            },
          };
        });
      }
    }, 1000);
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

  // Pause the active question clock while the tab is hidden, and resume only
  // when it becomes visible again. This avoids counting background time.
  useEffect(() => {
    if (exam?.status !== "running") return undefined;
    const handleVisibility = () => {
      const at = Date.now();
      setExam((prev) => {
        if (!prev || prev.status !== "running") return prev;
        const activeId = prev.currentQuestionId;
        if (document.hidden) {
          return { ...prev, answers: stopQuestionClock(prev.answers, activeId, at) };
        }
        const answer = prev.answers[activeId];
        if (!answer || answer.activeSince) return prev;
        return {
          ...prev,
          answers: { ...prev.answers, [activeId]: { ...answer, activeSince: at } },
        };
      });
    };
    const handlePageHide = () => {
      const current = examRef.current;
      if (!current || current.status !== "running") return;
      const at = Date.now();
      const paused = {
        ...current,
        answers: stopQuestionClock(current.answers, current.currentQuestionId, at),
      };
      const { questions: examQuestions, ...persisted } = paused;
      localStorage.setItem(ACTIVE_EXAM_KEY, JSON.stringify({
        ...persisted,
        questionIds: examQuestions.map((question) => question.id),
      }));
      setExam(paused);
    };
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("pageshow", handleVisibility);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("pageshow", handleVisibility);
    };
  }, [exam?.status]);

  // Save submitted attempts once. The database transaction is idempotent by
  // attempt id, so repeated effects or recovery cannot create duplicates.
  useEffect(() => {
    if (exam?.status !== "submitted") return undefined;
    let cancelled = false;
    setAttemptSaveError("");
    saveExamAttempt(exam, exam.questions)
      .then(() => {
        if (!cancelled) setAttemptSaveError("");
      })
      .catch((error) => {
        if (!cancelled) {
          setAttemptSaveError(error?.message || "Could not save this exam to analytics.");
        }
      });
    return () => { cancelled = true; };
  }, [exam?.id, exam?.status, exam?.submittedAt]);

  const activeSections = exam?.sections || sections;
  const setupHasAnySectionTime = sections.some(
    (section) => asMinutes(section.durationMinutes) !== "",
  );
  const setupHasAllSectionTimes =
    sections.length > 0 &&
    sections.every((section) => asMinutes(section.durationMinutes) !== "");
  const setupSectionTotalMinutes = setupHasAllSectionTimes
    ? sections.reduce(
        (total, section) => total + Number(section.durationMinutes),
        0,
      )
    : null;

  const sectionByQuestion = useMemo(() => {
    const map = {};
    activeSections.forEach((section, index) =>
      section.questionIds.forEach((id) => {
        map[id] = index;
      }),
    );
    return map;
  }, [activeSections]);

  const currentQuestion =
    exam?.questions.find((q) => q.id === exam.currentQuestionId) || null;
  const currentQuestionIndex = exam
    ? exam.questions.findIndex((q) => q.id === exam.currentQuestionId)
    : -1;
  const currentSectionIndex = currentQuestion
    ? (sectionByQuestion[currentQuestion.id] ?? 0)
    : 0;
  const currentSection = exam?.sections[currentSectionIndex];
  const sectionalTiming = Boolean(exam?.config?.sectionalTiming);
  const currentSectionExpired = Boolean(
    sectionalTiming &&
    currentSection?.deadline &&
    currentSection.deadline <= Date.now(),
  );
  const currentSectionQuestionIds = currentSection?.questionIds || [];
  const currentSectionQuestionPosition = currentQuestion
    ? currentSectionQuestionIds.indexOf(currentQuestion.id)
    : -1;
  const previousQuestionId = sectionalTiming
    ? currentSectionQuestionIds[currentSectionQuestionPosition - 1]
    : exam?.questions[currentQuestionIndex - 1]?.id;
  const nextQuestionId = sectionalTiming
    ? currentSectionQuestionIds[currentSectionQuestionPosition + 1]
    : exam?.questions[currentQuestionIndex + 1]?.id;

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

    // Overall-only mode: reaching the overall deadline submits the exam.
    if (!exam.config?.sectionalTiming && overallRemaining === 0) {
      finishExam("time");
      return;
    }

    // Sectional mode: section deadlines are cumulative and absolute. If the
    // browser was suspended, skip every section whose deadline has passed.
    if (
      exam.config?.sectionalTiming &&
      currentSection &&
      !currentSection.locked &&
      currentSection.deadline &&
      now >= currentSection.deadline
    ) {
      setExam((prev) => {
        if (!prev || prev.status !== "running") return prev;

        const nextIndex = prev.sections.findIndex(
          (section, index) =>
            index > currentSectionIndex && section.deadline > now,
        );
        const expiredSections = prev.sections.map((section) =>
          section.deadline && section.deadline <= now
            ? { ...section, locked: true }
            : section,
        );

        // The final timed section has expired: submit automatically.
        const stoppedAnswers = stopQuestionClock(prev.answers, prev.currentQuestionId, now);
        if (nextIndex < 0) {
          return {
            ...prev,
            answers: stoppedAnswers,
            sections: expiredSections,
            status: "submitted",
            submittedAt: now,
            finishReason: "section-time",
          };
        }

        const nextQuestionId = expiredSections[nextIndex].questionIds[0];
        if (!nextQuestionId) {
          return {
            ...prev,
            answers: stoppedAnswers,
            sections: expiredSections,
            status: "submitted",
            submittedAt: now,
            finishReason: "section-time",
          };
        }

        return {
          ...prev,
          sections: expiredSections,
          currentQuestionId: nextQuestionId,
          answers: {
            ...stoppedAnswers,
            [nextQuestionId]: {
              ...stoppedAnswers[nextQuestionId],
              visited: true,
              visitCount: (Number(stoppedAnswers[nextQuestionId]?.visitCount) || 0) + 1,
              activeSince: document.hidden ? null : now,
            },
          },
        };
      });
    }
  }, [
    now,
    exam?.status,
    exam?.config?.sectionalTiming,
    currentSectionIndex,
    currentSection?.deadline,
    currentSection?.locked,
    overallRemaining,
  ]);

  async function startExam() {
    if (!paperQuestions.length) return;

    const hasAnySectionTime = sections.some(
      (section) => asMinutes(section.durationMinutes) !== "",
    );
    const hasAllSectionTimes =
      sections.length > 0 &&
      sections.every((section) => asMinutes(section.durationMinutes) !== "");

    if (hasAnySectionTime && !hasAllSectionTimes) {
      setSetupError(
        "Sectional timing must be configured for every section, or cleared from every section.",
      );
      return;
    }

    if (
      hasAllSectionTimes &&
      sections.some(
        (section) =>
          Number(section.durationMinutes) < 1 ||
          Number(section.durationMinutes) > 1440 ||
          !Number.isInteger(Number(section.durationMinutes)),
      )
    ) {
      setSetupError(
        "Each section duration must be a whole number between 1 and 1440 minutes.",
      );
      return;
    }

    const positiveMarks = Number(positive);
    const negativeMarks = Number(negative);
    if (
      !Number.isFinite(positiveMarks) ||
      positiveMarks < 0 ||
      !Number.isFinite(negativeMarks) ||
      negativeMarks < 0
    ) {
      setSetupError("Marks and penalties must be valid non-negative numbers.");
      return;
    }

    if (
      !hasAnySectionTime &&
      overallMinutes &&
      (!Number.isFinite(Number(overallMinutes)) ||
        Number(overallMinutes) < 1 ||
        Number(overallMinutes) > 1440)
    ) {
      setSetupError("Overall duration must be between 1 and 1440 minutes.");
      return;
    }

    const sectionalTotalMinutes = hasAllSectionTimes
      ? sections.reduce(
          (total, section) => total + Number(section.durationMinutes),
          0,
        )
      : 0;
    const sectionalTotalSeconds = sectionalTotalMinutes * 60;

    // Save settings before starting the clock so a slow IndexedDB write does
    // not consume the user's first section time.
    if (saveDefaults) {
      try {
        await onSavePaperSettings?.(paperId, {
          // Keep the user's non-timed preference for the case where they later
          // clear all section timers. Timed mode itself is derived at runtime.
          sectionNavigation: navigation,
          overallDurationMinutes: hasAllSectionTimes
            ? null
            : overallMinutes || null,
          positiveMarks,
          negativeMarks,
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

    const start = Date.now();
    let cumulativeSeconds = 0;
    const configuredSections = sections.map((section) => {
      const durationSeconds = hasAllSectionTimes
        ? Number(section.durationMinutes) * 60
        : null;
      const sectionStart = hasAllSectionTimes
        ? start + cumulativeSeconds * 1000
        : null;
      cumulativeSeconds += durationSeconds || 0;
      return {
        ...section,
        durationSeconds,
        startedAt: sectionStart,
        deadline: hasAllSectionTimes ? start + cumulativeSeconds * 1000 : null,
        locked: false,
      };
    });

    const first = paperQuestions[0];
    const next = {
      id: `exam-${start}-${Math.random().toString(36).slice(2, 8)}`,
      paperId,
      status: "running",
      startedAt: start,
      submittedAt: null,
      questions: paperQuestions,
      answers: Object.fromEntries(
        paperQuestions.map((q) => [
          q.id,
          { answerIndex: null, visited: q.id === first.id, marked: false, timeSpentMs: 0, visitCount: q.id === first.id ? 1 : 0, answerChangeCount: 0, answerChanges: [], activeSince: q.id === first.id ? start : null },
        ]),
      ),
      sections: configuredSections,
      currentQuestionId: first.id,
      config: {
        sectionNavigation: hasAllSectionTimes ? "timed" : navigation,
        sectionalTiming: hasAllSectionTimes,
        positiveMarks,
        negativeMarks,
        overallDurationSeconds: hasAllSectionTimes
          ? sectionalTotalSeconds
          : overallMinutes
            ? Number(overallMinutes) * 60
            : null,
        totalDurationSeconds: hasAllSectionTimes ? sectionalTotalSeconds : null,
      },
      // Section deadlines collectively define the total duration in sectional
      // mode, so no second overall deadline is created.
      overallDeadline:
        !hasAllSectionTimes && overallMinutes
          ? start + Number(overallMinutes) * 60000
          : null,
    };

    setSetupError("");
    setNow(start);
    setExam(next);
  }

  function navigateTo(questionId) {
    if (!exam || exam.status !== "running" || questionId === exam.currentQuestionId) return;

    const targetIndex = sectionByQuestion[questionId];
    const activeIndex = sectionByQuestion[exam.currentQuestionId] ?? 0;
    const targetSection = exam.sections[targetIndex];
    if (!targetSection || targetSection.locked) return;

    // Sectional timing is strict: no early entry to future sections and no
    // return to an earlier section, even through the palette or tabs.
    if (exam.config?.sectionalTiming && targetIndex !== activeIndex) return;

    if (targetSection.deadline && targetSection.deadline <= Date.now()) {
      // The timer effect performs the lock + automatic transition. Trigger a
      // clock refresh so a delayed interval cannot leave an expired section open.
      setNow(Date.now());
      return;
    }

    if (
      !exam.config?.sectionalTiming &&
      exam.config.sectionNavigation === "sequential" &&
      targetIndex !== activeIndex &&
      targetIndex !== activeIndex + 1 &&
      targetIndex !== activeIndex - 1
    ) {
      return;
    }

    setExam((prev) => {
      if (!prev || prev.status !== "running") return prev;
      const target = prev.sections[targetIndex];
      if (!target || target.locked) return prev;
      if (prev.config?.sectionalTiming && targetIndex !== activeIndex)
        return prev;
      const at = Date.now();
      const stoppedAnswers = stopQuestionClock(prev.answers, prev.currentQuestionId, at);
      return {
        ...prev,
        currentQuestionId: questionId,
        answers: {
          ...stoppedAnswers,
          [questionId]: {
            ...stoppedAnswers[questionId],
            visited: true,
            visitCount: (Number(stoppedAnswers[questionId]?.visitCount) || 0) + 1,
            activeSince: at,
          },
        },
      };
    });
  }
  function updateAnswer(answerIndex) {
    if (!currentQuestion || currentSection?.locked) return;
    if (sectionalTiming && currentSection?.deadline <= Date.now()) {
      setNow(Date.now());
      return;
    }
    setExam((prev) => ({
      ...prev,
      answers: applyAnswerChange(prev.answers, currentQuestion.id, answerIndex),
    }));
  }
  function clearAnswer() {
    if (!currentQuestion || currentSection?.locked) return;
    if (sectionalTiming && currentSection?.deadline <= Date.now()) {
      setNow(Date.now());
      return;
    }
    setExam((prev) => ({
      ...prev,
      answers: applyAnswerChange(prev.answers, currentQuestion.id, null),
    }));
  }
  function toggleReview() {
    if (!currentQuestion || currentSection?.locked) return;
    if (sectionalTiming && currentSection?.deadline <= Date.now()) {
      setNow(Date.now());
      return;
    }
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
    const submittedAt = Date.now();
    setExam((prev) => {
      if (!prev || prev.status !== "running") return prev;
      return {
        ...prev,
        answers: stopQuestionClock(prev.answers, prev.currentQuestionId, submittedAt),
        status: "submitted",
        submittedAt,
        finishReason: reason,
      };
    });
    setConfirmSubmit(false);
  }
  function pauseExamAndClose() {
    if (exam?.status === "running") {
      const at = Date.now();
      const paused = {
        ...exam,
        answers: stopQuestionClock(exam.answers, exam.currentQuestionId, at),
      };
      const { questions: examQuestions, ...persisted } = paused;
      localStorage.setItem(ACTIVE_EXAM_KEY, JSON.stringify({
        ...persisted,
        questionIds: examQuestions.map((question) => question.id),
      }));
      setExam(paused);
    }
    onClose?.();
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
            onClick={pauseExamAndClose}
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
                  value={setupHasAnySectionTime ? "timed" : navigation}
                  disabled={setupHasAnySectionTime}
                  onChange={(e) => setNavigation(e.target.value)}
                >
                  {setupHasAnySectionTime ? (
                    <option value="timed">
                      Automatic · section-by-section
                    </option>
                  ) : (
                    <>
                      <option value="free">Free navigation</option>
                      <option value="sequential">Adjacent sections only</option>
                    </>
                  )}
                </select>
                <small>
                  {setupHasAnySectionTime
                    ? "Section timers automatically control progression. Switching sections is disabled."
                    : "Choose how you can move between sections."}
                </small>
              </label>
              <label>
                {setupHasAnySectionTime
                  ? "Total exam duration (minutes)"
                  : "Overall duration (minutes)"}
                <input
                  type="number"
                  min="1"
                  max="1440"
                  placeholder={
                    setupHasAnySectionTime
                      ? "Complete all section timers"
                      : "No overall timer"
                  }
                  value={
                    setupHasAnySectionTime
                      ? setupHasAllSectionTimes
                        ? setupSectionTotalMinutes
                        : ""
                      : overallMinutes
                  }
                  disabled={setupHasAnySectionTime}
                  onChange={(e) => setOverallMinutes(asMinutes(e.target.value))}
                />
                <small>
                  {setupHasAnySectionTime
                    ? setupHasAllSectionTimes
                      ? "Automatically calculated as the sum of all section time limits."
                      : "Set a time limit for every section, or clear all section limits to use an overall timer."
                    : "Manual setting. Leave blank for no overall timer."}
                </small>
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
                <span>
                  {setupHasAnySectionTime
                    ? "Timed mode · automatic progression · lock on expiry"
                    : "Optional · configure every section or none"}
                </span>
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
                      step="1"
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
              {sectionalTiming ? (
                <div className="exam-timer">
                  <Clock3 size={17} />
                  {/* <span>
                    {currentSection?.name || "Section"} · {currentSectionIndex + 1}/{exam.sections.length}
                  </span> */}
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
              ) : (
                <div className="exam-timer">
                  <Clock3 size={17} />
                  {/* <span>Overall</span> */}
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
              )}
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
                  disabled={sectionalTiming || section.locked}
                  onClick={() => {
                    const qid = section.questionIds[0];
                    if (qid && !section.locked) navigateTo(qid);
                  }}
                >
                  {section.name}
                  {/* {section.locked ? " · Locked" : ""} */}
                </button>
              ))}
            </nav>
            <div className="exam-workspace">
              <section className="exam-question-area">
                {/* <div className="exam-question-meta">
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
                </div> */}
                {currentSection?.locked && (
                  <div className="exam-locked-notice">
                    <AlertTriangle size={16} /> This section has expired and is
                    locked. Your saved answers are retained.
                  </div>
                )}
                <div className="exam-question-copy">
                  {currentQuestion?.questionHtml ? (
                    renderQuestionHtmlWithImages(
                      currentQuestion.questionHtml,
                      currentQuestion,
                      imageUrls,
                    )
                  ) : (
                    <>
                      <p>{currentQuestion?.question}</p>

                      {renderQuestionHtmlWithImages(
                        "",
                        currentQuestion,
                        imageUrls,
                      )}
                    </>
                  )}
                </div>
                <div className="exam-options">
                  {(currentQuestion?.options || []).map((option, index) => (
                    <button
                      key={index}
                      disabled={currentSection?.locked || currentSectionExpired}
                      className={`exam-option ${exam.answers[currentQuestion.id]?.answerIndex === index ? "selected" : ""}`}
                      onClick={() => updateAnswer(index)}
                    >
                      <span>{LETTERS[index]}</span>
                      <div>
                        {currentQuestion.optionHtml?.[index] ? (
                          <span
                            dangerouslySetInnerHTML={{
                              __html: sanitizeQuestionHtml(
                                currentQuestion.optionHtml[index],
                              ),
                            }}
                          />
                        ) : /\.(png|jpe?g|webp|gif|svg|avif|bmp)(?:[?#].*)?$/i.test(
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
                    disabled={currentSection?.locked || currentSectionExpired}
                    onClick={clearAnswer}
                  >
                    Clear response
                  </button>
                  <button
                    className={`button ${exam.answers[currentQuestion.id]?.marked ? "light" : "outline"}`}
                    disabled={currentSection?.locked || currentSectionExpired}
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
                    onClick={() =>
                      previousQuestionId && navigateTo(previousQuestionId)
                    }
                    disabled={
                      !previousQuestionId ||
                      currentSection?.locked ||
                      currentSectionExpired
                    }
                  >
                    <ChevronLeft size={15} />Previous
                  </button>
                  {!nextQuestionId ? (
                    <button
                      className="button primary"
                      onClick={() => setConfirmSubmit(true)}
                    >
                      Submit exam
                    </button>
                  ) : (
                    <button
                      className="button primary"
                      onClick={() =>
                        nextQuestionId && navigateTo(nextQuestionId)
                      }
                      disabled={
                        !nextQuestionId ||
                        currentSection?.locked ||
                        currentSectionExpired
                      }
                    >
                      Save & Next <ChevronRight size={15} />
                    </button>
                  )}
                </div>
              </section>
              <aside className="exam-palette">
                <h3>Question palette</h3>
                <div className="exam-palette-grid" ref={paletteGridRef}>
                  {exam.questions.map((q, index) => {
                    const status = statusOf(exam.answers[q.id]);
                    const locked =
                      exam.sections[sectionByQuestion[q.id]]?.locked;

                    const targetSectionIndex = sectionByQuestion[q.id] ?? 0;
                    const allowed = sectionalTiming
                      ? targetSectionIndex === currentSectionIndex
                      : exam.config.sectionNavigation === "free" ||
                        Math.abs(targetSectionIndex - currentSectionIndex) <= 1;

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
                : exam.finishReason === "section-time"
                  ? "The final section timer expired. The exam was submitted automatically."
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
            {attemptSaveError && (
              <p className="exam-warning" role="alert">
                Analytics save failed: {attemptSaveError}. Keep this result open and retry by reloading the app before closing it.
              </p>
            )}
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
