import React, { useEffect, useMemo, useState } from "react";
import JSZip from "jszip";
import {
  db,
  initializeDatabase,
  importQuestionBank,
  saveQuestionWithImages,
  deletePaper,
  getImageBlob,
} from "./db";
import {
  Download,
  Upload,
  FileJson,
  RotateCcw,
  Shuffle,
  CheckCircle2,
  CircleHelp,
  Bookmark,
  ChevronLeft,
  ChevronRight,
  Search,
  AlertTriangle,
  Eye,
  X,
  Menu,
} from "lucide-react";

const PROGRESS_KEY = "rrb-je-pyq-progress-v1";
const LABELS = ["A", "B", "C", "D"];
const MAX_IMPORT_BYTES = 100 * 1024 * 1024; // CHANGED: prevent unexpectedly huge uploads.
const MAX_QUESTIONS = 20000; // CHANGED: configurable import safety limit.
const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif|svg|avif|bmp)$/i;

function loadProgress() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PROGRESS_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}
function getState(progress, q) {
  const state = progress[q.id];
  if (!state || typeof state !== "object")
    return { attempts: [], marked: false, note: "" };
  return {
    attempts: Array.isArray(state.attempts)
      ? state.attempts.filter((a) => a && typeof a.correct === "boolean")
      : [],
    marked: Boolean(state.marked),
    note: typeof state.note === "string" ? state.note : "",
  };
}
function shuffleArray(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
function isImagePath(value) {
  return (
    typeof value === "string" &&
    IMAGE_EXTENSIONS.test(value.trim().split(/[?#]/)[0])
  );
}
function normalizePath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "");
}
function isPracticeReady(q) {
  return (
    q.practiceReady === true &&
    !q.visualReviewNeeded &&
    typeof q.question === "string" &&
    q.question.trim().length > 0 &&
    Array.isArray(q.options) &&
    q.options.length === 4 &&
    q.options.every((o) => typeof o === "string" && o.trim().length > 0) &&
    Number.isInteger(q.correctAnswerIndex) &&
    q.correctAnswerIndex >= 0 &&
    q.correctAnswerIndex < 4
  );
}
function questionStatus(q, progress) {
  const s = getState(progress, q);
  if (s.marked) return "Review";
  if (s.attempts.some((a) => !a.correct)) return "Has errors";
  if (s.attempts.length) return "Covered";
  if (q.visualReviewNeeded || !isPracticeReady(q)) return "Needs review";
  return "Uncovered";
}
function validateProgressImport(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(
    (state) =>
      state &&
      typeof state === "object" &&
      (state.attempts === undefined || Array.isArray(state.attempts)) &&
      (state.marked === undefined || typeof state.marked === "boolean") &&
      (state.note === undefined || typeof state.note === "string") &&
      (!Array.isArray(state.attempts) ||
        state.attempts.every(
          (a) =>
            a &&
            typeof a.correct === "boolean" &&
            Number.isInteger(a.answerIndex) &&
            a.answerIndex >= 0 &&
            a.answerIndex < 4,
        )),
  );
}

/**
 * CHANGED: normalize incomplete records instead of silently treating them as practice-ready.
 * Structural identity fields are mandatory; content defects are retained and flagged for review.
 * Duplicate IDs / question numbers and invalid answer indices are rejected separately.
 */
function normalizeQuestion(raw, index, archivePaths = null) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Question at array index ${index} must be an object.`);
  }
  const q = { ...raw };
  const suppliedCorrectAnswer =
    typeof q.correctAnswer === "string" ? q.correctAnswer.trim() : "";
  if (typeof q.id !== "string" || !q.id.trim()) {
    throw new Error(
      `Question at array index ${index} is missing a non-empty id.`,
    );
  }
  if (typeof q.paperId !== "string" || !q.paperId.trim()) {
    throw new Error(`Question "${q.id}" is missing paperId.`);
  }
  if (!Number.isInteger(q.questionNumber) || q.questionNumber < 1) {
    throw new Error(
      `Question "${q.id}" must have a positive integer questionNumber.`,
    );
  }

  // CHANGED: support only four-option MCQs in this version; incomplete options are retained as blanks.
  let options = Array.isArray(q.options) ? [...q.options] : [];
  if (options.length > 4) {
    throw new Error(
      `Question "${q.id}" has ${options.length} options; expected at most four.`,
    );
  }
  options = [...options, ...Array(Math.max(0, 4 - options.length)).fill("")];
  options = options.map((value) => (typeof value === "string" ? value : ""));

  // CHANGED: reject malformed/out-of-range answer indices; derive index only from a matching correctAnswer.
  let answerIndex = q.correctAnswerIndex;
  if (answerIndex === undefined || answerIndex === null || answerIndex === "") {
    const answerText =
      typeof q.correctAnswer === "string" ? q.correctAnswer.trim() : "";
    const matchIndex = answerText
      ? options.findIndex((o) => o.trim() === answerText)
      : -1;
    answerIndex = matchIndex >= 0 ? matchIndex : null;
  } else if (
    !Number.isInteger(answerIndex) ||
    answerIndex < 0 ||
    answerIndex > 3
  ) {
    throw new Error(
      `Question "${q.id}" has an invalid correctAnswerIndex; expected an integer from 0 to 3.`,
    );
  }
  if (answerIndex !== null && answerIndex >= options.length) {
    throw new Error(
      `Question "${q.id}" has a correctAnswerIndex outside its options.`,
    );
  }

  const referencedPaths = [];
  if (typeof q.questionImage === "string" && q.questionImage.trim())
    referencedPaths.push(normalizePath(q.questionImage));
  options.forEach((o) => {
    if (isImagePath(o)) referencedPaths.push(normalizePath(o));
  });

  // CHANGED: ZIP paths are checked against extracted archive entries before import.
  // A standalone JSON cannot carry image bytes. Under the agreed workflow, image-bearing
  // banks must be ZIPs, so mark every referenced image as missing for JSON-only imports.
  const missingImages =
    archivePaths === null
      ? [] // null means this is an edit operation; the existing image store is not revalidated here.
      : referencedPaths.filter((path) => !archivePaths.has(path));
  const hasImageReference = referencedPaths.length > 0;
  const questionMissing = typeof q.question !== "string" || !q.question.trim();
  const optionMissing = options.some((o) => !o.trim());
  const invalidAnswerMissing = answerIndex === null;
  const sourceImageMissing = missingImages.length > 0;
  const answerMismatch =
    Number.isInteger(answerIndex) &&
    suppliedCorrectAnswer.length > 0 &&
    typeof options[answerIndex] === "string" &&
    options[answerIndex].trim().length > 0 &&
    !isImagePath(options[answerIndex]) &&
    suppliedCorrectAnswer !== options[answerIndex].trim();

  q.options = options;
  q.correctAnswerIndex = answerIndex;
  q.correctAnswer = Number.isInteger(answerIndex)
    ? options[answerIndex] || ""
    : q.correctAnswer || "";
  q.question = typeof q.question === "string" ? q.question : "";
  q.questionImage =
    typeof q.questionImage === "string" && q.questionImage.trim()
      ? normalizePath(q.questionImage)
      : null;

  const needsReview = Boolean(
    q.visualReviewNeeded ||
    questionMissing ||
    optionMissing ||
    invalidAnswerMissing ||
    sourceImageMissing ||
    answerMismatch ||
    q.practiceReady === false,
  );
  // CHANGED: all content gaps are explicit and retained for the coverage/review screen.
  q.visualReviewNeeded = needsReview;
  q.practiceReady = !needsReview && Number.isInteger(answerIndex);
  q.reviewReasons = [
    ...(questionMissing ? ["Question text is missing"] : []),
    ...(optionMissing ? ["One or more options are missing"] : []),
    ...(invalidAnswerMissing
      ? ["Correct answer is missing or cannot be resolved"]
      : []),
    ...(answerMismatch
      ? ["correctAnswer does not match the selected option"]
      : []),
    ...missingImages.map((path) => `Missing image: ${path}`),
  ];
  return q;
}

function validateAndNormalizeBank(
  rawQuestions,
  existingQuestions = [],
  archivePaths = null,
) {
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    throw new Error(
      "The upload must contain a non-empty JSON array of questions.",
    );
  }
  if (rawQuestions.length > MAX_QUESTIONS) {
    throw new Error(
      `This import exceeds the ${MAX_QUESTIONS.toLocaleString()} question limit.`,
    );
  }
  const existingIds = new Set(existingQuestions.map((q) => q.id));
  const ids = new Set();
  const numberByPaper = new Set();
  const normalized = rawQuestions.map((raw, i) =>
    normalizeQuestion(raw, i, archivePaths),
  );

  for (const q of normalized) {
    if (existingIds.has(q.id) || ids.has(q.id)) {
      throw new Error(
        `Duplicate question id "${q.id}". IDs must be globally unique.`,
      );
    }
    ids.add(q.id);
    const composite = `${q.paperId}\u0000${q.questionNumber}`;
    if (numberByPaper.has(composite)) {
      throw new Error(
        `Duplicate questionNumber ${q.questionNumber} in paper "${q.paperId}".`,
      );
    }
    numberByPaper.add(composite);
  }
  // CHANGED: questionNumber may repeat across different papers; uniqueness is per paperId only.
  return normalized;
}

function App() {
  const [bank, setBank] = useState([]);
  const [progress, setProgress] = useState(loadProgress);
  const [subject, setSubject] = useState("Focus");
  const [paper, setPaper] = useState("All");
  const [topic, setTopic] = useState("All");
  const [mode, setMode] = useState("unseen");
  const [size, setSize] = useState("20");
  const [session, setSession] = useState([]);
  const [idx, setIdx] = useState(0);
  const [selected, setSelected] = useState(null);
  const [checked, setChecked] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [sessionError, setSessionError] = useState("");
  const [completedSession, setCompletedSession] = useState(null);
  const [sessionResults, setSessionResults] = useState({});
  const [noteDraft, setNoteDraft] = useState("");
  const [coveragePaper, setCoveragePaper] = useState("");
  const [coverageStatus, setCoverageStatus] = useState("All");
  const [coverageSearch, setCoverageSearch] = useState("");
  // New: independent filters for the questions in the selected paper.
  const [coverageSubject, setCoverageSubject] = useState("All");
  const [coverageTopic, setCoverageTopic] = useState("All");
  const [coverageOpen, setCoverageOpen] = useState(false);
  // Mobile sidebar starts closed; desktop visibility is controlled by CSS.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [importMessage, setImportMessage] = useState("");
  const [editingQuestionId, setEditingQuestionId] = useState(null);
  const [editDraft, setEditDraft] = useState(null);
  const [dbBusy, setDbBusy] = useState(false);
  const [dbMessage, setDbMessage] = useState("");
  const [imageUrls, setImageUrls] = useState({});
  const [editImagePreviewUrls, setEditImagePreviewUrls] = useState({});

  // CHANGED: fresh installs start empty; initializeDatabase no longer fetches public/questions.json.
  useEffect(() => {
    let cancelled = false;
    initializeDatabase()
      .then((questions) => {
        if (cancelled) return;
        setBank(questions);
        setCoveragePaper(questions[0]?.paperId || "");
        // Reset coverage filters after importing a new set of questions.
        setCoverageSubject("All");
        setCoverageTopic("All");
      })
      .catch((error) => {
        if (!cancelled)
          setLoadError(error.message || "Could not initialize local database.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // CHANGED: resolve persisted image Blobs into temporary object URLs after load/reload.
  useEffect(() => {
    let cancelled = false;
    const refs = new Map();
    bank.forEach((q) => {
      if (q.questionImage)
        refs.set(`${q.paperId}::${normalizePath(q.questionImage)}`, {
          path: normalizePath(q.questionImage),
          paperId: q.paperId,
        });
      (q.options || []).forEach((option) => {
        if (isImagePath(option))
          refs.set(`${q.paperId}::${normalizePath(option)}`, {
            path: normalizePath(option),
            paperId: q.paperId,
          });
      });
    });
    (async () => {
      const next = {};
      for (const [key, ref] of refs) {
        const blob = await getImageBlob(ref.path, ref.paperId);
        if (blob) next[key] = URL.createObjectURL(blob);
      }
      if (cancelled) {
        Object.values(next).forEach(URL.revokeObjectURL);
      } else {
        setImageUrls((previous) => {
          Object.values(previous).forEach(URL.revokeObjectURL);
          return next;
        });
      }
    })().catch((error) =>
      setDbMessage(`Could not load stored images: ${error.message}`),
    );
    return () => {
      cancelled = true;
    };
  }, [bank]);

  // Temporary previews for files selected in the editor; revoke URLs when files change.
  useEffect(() => {
    const next = {};
    const files = [];
    if (editDraft?.questionImageFile) {
      files.push(["question", editDraft.questionImageFile]);
    }
    Object.entries(editDraft?.optionImageFiles || {}).forEach(
      ([index, file]) => {
        if (file) files.push([`option-${index}`, file]);
      },
    );
    files.forEach(([key, file]) => {
      next[key] = URL.createObjectURL(file);
    });
    setEditImagePreviewUrls(next);
    return () => Object.values(next).forEach((url) => URL.revokeObjectURL(url));
  }, [editDraft?.questionImageFile, editDraft?.optionImageFiles]);

  useEffect(() => {
    try {
      localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
    } catch {
      setImportMessage(
        "Progress could not be saved. Export a backup and check browser storage settings.",
      );
    }
  }, [progress]);

  useEffect(
    () => () => Object.values(imageUrls).forEach(URL.revokeObjectURL),
    [imageUrls],
  );

  const subjects = useMemo(
    () => [...new Set(bank.map((q) => q.subject).filter(Boolean))].sort(),
    [bank],
  );
  const papers = useMemo(
    () => [...new Set(bank.map((q) => q.paperId).filter(Boolean))].sort(),
    [bank],
  );
  const availableTopics = useMemo(() => {
    const list = bank.filter(
      (q) =>
        (subject === "All" ||
          (subject === "Focus"
            ? ["Mathematics", "Reasoning", "General Science"].includes(
                q.subject,
              )
            : q.subject === subject)) &&
        (paper === "All" || q.paperId === paper),
    );
    return [...new Set(list.map((q) => q.topic).filter(Boolean))].sort();
  }, [bank, subject, paper]);
  const baseFiltered = useMemo(
    () =>
      bank.filter(
        (q) =>
          (subject === "All" ||
            (subject === "Focus"
              ? ["Mathematics", "Reasoning", "General Science"].includes(
                  q.subject,
                )
              : q.subject === subject)) &&
          (paper === "All" || q.paperId === paper) &&
          (topic === "All" || q.topic === topic),
      ),
    [bank, subject, paper, topic],
  );

  const filtered = useMemo(() => {
    const ready = baseFiltered.filter(isPracticeReady);
    if (mode === "all") {
      const unseen = ready.filter(
        (q) => getState(progress, q).attempts.length === 0,
      );
      return unseen.length ? unseen : ready;
    }
    if (mode === "unseen")
      return ready.filter((q) => getState(progress, q).attempts.length === 0);
    if (mode === "wrong")
      return ready.filter((q) =>
        getState(progress, q).attempts.some((a) => !a.correct),
      );
    return ready.filter((q) => getState(progress, q).marked);
  }, [baseFiltered, progress, mode]);

  const current = session[idx] || null;
  const currentState = current ? getState(progress, current) : null;
  const editTopics = [
    ...new Set(
      bank
        .filter((q) => q.subject === editDraft?.subject)
        .map((q) => q.topic)
        .filter(Boolean),
    ),
  ].sort();

  useEffect(() => {
    setNoteDraft(currentState?.note || current?.notes || "");
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function startSession(forceShuffle = false) {
    setSessionError("");
    setCompletedSession(null);
    const notReadyCount = baseFiltered.filter(
      (q) => !isPracticeReady(q),
    ).length;
    let list = [...filtered];
    if (forceShuffle || mode === "unseen" || mode === "all")
      list = shuffleArray(list);
    list = list.slice(0, Number(size));
    if (!list.length) {
      setSession([]);
      setIdx(0);
      setSelected(null);
      setChecked(false);
      setSessionResults({});
      setSessionError(
        !bank.length
          ? "Upload a JSON question bank or ZIP archive to begin."
          : notReadyCount && !baseFiltered.some(isPracticeReady)
            ? `${notReadyCount} question(s) need review before they can be practised. Open Paper coverage to inspect them.`
            : mode === "wrong"
              ? "No incorrect attempts in this filtered set yet."
              : mode === "review"
                ? "No questions are marked for review in this filtered set."
                : "No questions match these filters. Change a filter or switch practice mode.",
      );
      return;
    }
    setSession(list);
    setIdx(0);
    setSelected(null);
    setChecked(false);
    setSessionResults({});
    if (notReadyCount)
      setSessionError(
        `${notReadyCount} incomplete question(s) were excluded from practice and remain in coverage for review.`,
      );
  }

  function updateQuestionState(q, mutator) {
    if (!q) return;
    setProgress((prev) => ({
      ...prev,
      [q.id]: mutator({
        ...getState(prev, q),
        attempts: [...getState(prev, q).attempts],
      }),
    }));
  }
  function checkAnswer() {
    if (!current || selected === null || checked) return;
    const correct = selected === current.correctAnswerIndex;
    updateQuestionState(current, (s) => ({
      ...s,
      attempts: [
        ...s.attempts,
        {
          answerIndex: selected,
          correct,
          at: new Date().toISOString(),
          // CHANGED: retain the answer key version used for this attempt.
          answerKey: current.correctAnswerIndex,
        },
      ],
    }));
    setSessionResults((prev) => ({
      ...prev,
      [current.id]: { correct, answerIndex: selected },
    }));
    setChecked(true);
  }
  function next() {
    if (idx < session.length - 1) {
      setIdx(idx + 1);
      // CHANGED: Previous/Next revisits retain a prior in-session answer rather than silently creating another attempt.
      const prior = sessionResults[session[idx + 1]?.id];
      setSelected(prior?.answerIndex ?? null);
      setChecked(Boolean(prior));
    } else {
      const answered = Object.values(sessionResults);
      setCompletedSession({
        total: session.length,
        answered: answered.length,
        correct: answered.filter((r) => r.correct).length,
        incorrect: answered.filter((r) => !r.correct).length,
      });
      setSession([]);
      setIdx(0);
      setSelected(null);
      setChecked(false);
      setSessionResults({});
    }
  }
  function previous() {
    if (idx <= 0) return;
    const prior = sessionResults[session[idx - 1]?.id];
    setIdx(idx - 1);
    setSelected(prior?.answerIndex ?? null);
    setChecked(Boolean(prior));
  }
  function toggleMark(q = current) {
    updateQuestionState(q, (s) => ({ ...s, marked: !s.marked }));
  }
  function saveNote(q = current, value = noteDraft) {
    updateQuestionState(q, (s) => ({ ...s, note: value }));
    setImportMessage("Note saved.");
  }

  function exportFile(name, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    // CHANGED: defer URL revocation to avoid racing the browser's download start.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function exportQuestionBank(scope = "all") {
    if (!bank.length) {
      setDbMessage("There are no questions to export.");
      return;
    }

    const questionsToExport =
      scope === "paper"
        ? bank.filter((q) => q.paperId === coveragePaper)
        : bank;

    if (!questionsToExport.length) {
      setDbMessage("Select a paper containing questions first.");
      return;
    }

    setDbBusy(true);
    setDbMessage("");

    try {
      const zip = new JSZip();
      const exportedQuestions = [];
      const exportedImages = new Map();
      const missingImages = [];

      // Give each paper its own image directory to prevent filename collisions.
      const safeFolderName = (value) =>
        String(value || "paper")
          .trim()
          .replace(/[^a-zA-Z0-9_-]+/g, "-")
          .replace(/^-+|-+$/g, "") || "paper";

      for (const question of questionsToExport) {
        // Prefer the latest saved progress note, including an intentionally cleared note.
        // Fall back to the note already stored on the question object.
        const savedState = progress[question.id];

        const exportedNote =
          savedState && Object.prototype.hasOwnProperty.call(savedState, "note")
            ? getState(progress, question).note
            : question.notes || "";

        const exportedQuestion = {
          ...question,
          notes: exportedNote,
        };

        const paperFolder = safeFolderName(question.paperId);

        const imageFields = [
          {
            field: "questionImage",
            value: question.questionImage,
          },
          ...(question.options || []).map((value, index) => ({
            field: "options",
            index,
            value: isImagePath(value) ? value : null,
          })),
        ];

        for (const imageRef of imageFields) {
          if (typeof imageRef.value !== "string" || !imageRef.value.trim()) {
            continue;
          }

          const originalPath = normalizePath(imageRef.value);
          if (!isImagePath(originalPath)) continue;

          const imageKey = `${question.paperId}::${originalPath}`;

          // Preserve the same exported path for repeated references to an image.
          let exportedPath = exportedImages.get(imageKey) || null;

          if (!exportedPath) {
            const blob = await getImageBlob(originalPath, question.paperId);

            if (!blob) {
              missingImages.push(`${question.id}: ${originalPath}`);
              continue;
            }

            const filename = originalPath.split("/").pop();
            exportedPath = `images/${paperFolder}/${filename}`;

            // If two source paths in this paper share a filename,
            // retain their relative directories to avoid overwriting.
            const alreadyUsed =
              Object.values(exportedImages).includes(exportedPath);

            if (alreadyUsed) {
              const relativePath = originalPath
                .replace(/^images\//i, "")
                .replace(/^\/+/, "");
              exportedPath = `images/${paperFolder}/${relativePath}`;
            }
            // After determining the path:
            exportedImages.set(imageKey, exportedPath);

            zip.file(exportedPath, blob);
          }

          if (imageRef.field === "questionImage") {
            exportedQuestion.questionImage = exportedPath;
          } else {
            exportedQuestion.options[imageRef.index] = exportedPath;
          }

          // If the correct option is image-valued, keep correctAnswer aligned.
          if (
            Number.isInteger(exportedQuestion.correctAnswerIndex) &&
            exportedQuestion.correctAnswerIndex === imageRef.index &&
            imageRef.field === "options"
          ) {
            exportedQuestion.correctAnswer = exportedPath;
          }
        }

        exportedQuestions.push(exportedQuestion);
      }

      if (missingImages.length) {
        const sample = missingImages.slice(0, 8).join("\n");
        const remaining =
          missingImages.length > 8
            ? `\n…and ${missingImages.length - 8} more`
            : "";

        throw new Error(
          `Export cancelled because ${missingImages.length} referenced image(s) are missing:\n${sample}${remaining}`,
        );
      }

      zip.file("questions.json", JSON.stringify(exportedQuestions, null, 2));

      const blob = await zip.generateAsync({
        type: "blob",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
      });

      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const date = new Date().toISOString().slice(0, 10);
      const filename =
        scope === "paper"
          ? `rrb-je-${safeFolderName(coveragePaper)}-${date}.zip`
          : `rrb-je-question-bank-${date}.zip`;

      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);

      setDbMessage(
        `Exported ${exportedQuestions.length} question(s) from ${
          new Set(exportedQuestions.map((q) => q.paperId)).size
        } paper(s), including ${exportedImages.size} referenced image(s).`,
      );
    } catch (error) {
      setDbMessage(
        `Export failed: ${error.message || "Could not create ZIP."}`,
      );
    } finally {
      setDbBusy(false);
    }
  }

  async function importProgress(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (file.size > MAX_IMPORT_BYTES)
        throw new Error("Progress backup is too large.");
      const parsed = JSON.parse(await file.text());
      if (!validateProgressImport(parsed))
        throw new Error("Invalid progress-backup structure.");
      const knownIds = new Set(bank.map((q) => q.id));
      const unknown = Object.keys(parsed).filter((id) => !knownIds.has(id));
      if (unknown.length)
        throw new Error(
          `Backup contains ${unknown.length} question ID(s) not in this bank.`,
        );
      if (
        !window.confirm(
          "Replace current progress with this backup? Export current progress first if needed.",
        )
      )
        return;
      setProgress(parsed);
      setImportMessage("Progress backup imported.");
    } catch (error) {
      setImportMessage(
        `Progress import failed: ${error.message || "Invalid file."}`,
      );
    } finally {
      event.target.value = "";
    }
  }

  async function readImportFile(file) {
    if (file.size > MAX_IMPORT_BYTES)
      throw new Error("Import exceeds the 100 MB upload limit.");
    let rawQuestions;
    let imageEntries = [];
    let archivePaths = null;
    let isZipImport = false;
    let questionsJsonAtRoot = true;

    if (
      /\.zip$/i.test(file.name) ||
      file.type === "application/zip" ||
      file.type === "application/x-zip-compressed"
    ) {
      // CHANGED: ZIP workflow: require one questions.json at archive root; image paths are relative to archive root.
      isZipImport = true;
      const zip = await JSZip.loadAsync(file, { checkCRC32: true });
      const jsonEntries = Object.values(zip.files).filter(
        (entry) =>
          !entry.dir &&
          entry.name.split("/").pop().toLowerCase() === "questions.json",
      );
      if (jsonEntries.length !== 1)
        throw new Error("ZIP must contain exactly one questions.json file.");
      const jsonEntry = jsonEntries[0];
      questionsJsonAtRoot = jsonEntry.name === "questions.json";
      const jsonText = await jsonEntry.async("text");
      rawQuestions = JSON.parse(jsonText);
      archivePaths = new Set();
      let uncompressedTotal = 0;
      for (const entry of Object.values(zip.files)) {
        if (entry.dir) continue;
        // CHANGED: guard against ZIP bombs using JSZip's declared uncompressed entry size.
        const declaredSize = entry._data?.uncompressedSize || 0;
        uncompressedTotal += declaredSize;
        if (uncompressedTotal > MAX_IMPORT_BYTES) {
          throw new Error("ZIP expands beyond the 100 MB uncompressed limit.");
        }
        const path = normalizePath(entry.name);
        // CHANGED: reject path traversal and ignore metadata files.
        if (path.split("/").some((part) => part === ".."))
          throw new Error(`Unsafe path in ZIP: ${entry.name}`);
        if (path.startsWith("__MACOSX/") || path.endsWith(".DS_Store"))
          continue;
        if (IMAGE_EXTENSIONS.test(path)) {
          const rawBlob = await entry.async("blob");
          const extension = path.split(".").pop().toLowerCase();

          const mimeTypes = {
            svg: "image/svg+xml",
            png: "image/png",
            webp: "image/webp",
            gif: "image/gif",
            avif: "image/avif",
            bmp: "image/bmp",
            jpg: "image/jpeg",
            jpeg: "image/jpeg",
          };

          const mime = mimeTypes[extension] || "application/octet-stream";
          const blob = rawBlob.type
            ? rawBlob
            : new Blob([rawBlob], { type: mime });

          imageEntries.push({ path, blob });
          archivePaths.add(path);
        }
      }
    } else {
      // CHANGED: JSON-only uploads contain no image bytes; image references are therefore flagged missing.
      // Under the agreed workflow, image-bearing imports should use ZIP.
      rawQuestions = JSON.parse(await file.text());
      archivePaths = new Set();
    }

    // CHANGED: avoid ambiguous relative paths; archive paths are relative to questions.json at ZIP root.
    if (isZipImport && !questionsJsonAtRoot) {
      throw new Error(
        "Place questions.json at the ZIP root; keep referenced files under image/.",
      );
    }
    const existing = await db.questions.toArray();
    const normalized = validateAndNormalizeBank(
      rawQuestions,
      existing,
      archivePaths,
    );
    return { questions: normalized, imageEntries };
  }

  async function handleImport(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setDbBusy(true);
    setDbMessage("");
    try {
      const { questions, imageEntries } = await readImportFile(file);
      // CHANGED: the DB layer commits questions, papers, and images atomically; failures preserve the old bank.
      await importQuestionBank(questions, imageEntries);
      const updated = await db.questions.orderBy("paperId").toArray();
      setBank(updated);
      setCoveragePaper(questions[0]?.paperId || "");
      setCoverageStatus("All");
      setCoverageSearch("");
      setCoverageOpen(true);
      const reviewCount = questions.filter((q) => !isPracticeReady(q)).length;
      setDbMessage(
        `Imported ${questions.length} question(s) across ${new Set(questions.map((q) => q.paperId)).size} paper(s). ${reviewCount ? `${reviewCount} need review.` : "All imported questions are practice-ready."}`,
      );
    } catch (error) {
      setDbMessage(`Import failed: ${error.message || "Invalid file."}`);
    } finally {
      setDbBusy(false);
      event.target.value = "";
    }
  }

  function startEditingQuestion(q) {
    const savedState = getState(progress, q);

    setEditingQuestionId(q.id);
    setEditDraft({
      question: q.question || "",
      subject: q.subject || "",
      topic: q.topic || "",

      options: [...(q.options || ["", "", "", ""])],
      correctAnswerIndex: Number.isInteger(q.correctAnswerIndex)
        ? q.correctAnswerIndex
        : "",

      // Existing image path or a suggested path for a new image.
      questionImagePath:
        q.questionImage || `images/q${q.questionNumber}-question.png`,

      questionImageFile: null,
      questionImageRemoved: false,
      questionImageNotRequired: Boolean(q.questionImageNotRequired),
      optionImageFiles: {},

      // Reuse the existing saved memory trick / explanation note.
      note: savedState.note || q.notes || "",

      verified: false,
    });
  }
  async function saveQuestionEdits(q) {
    if (!editDraft) return;

    const options = [...editDraft.options].slice(0, 4);
    while (options.length < 4) options.push("");

    const answerIndex =
      editDraft.correctAnswerIndex === "" ||
      editDraft.correctAnswerIndex === null
        ? null
        : Number(editDraft.correctAnswerIndex);

    if (
      answerIndex !== null &&
      (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex > 3)
    ) {
      setDbMessage("Correct answer must be A, B, C, or D.");
      return;
    }

    const imageEntries = [];

    // Question image can be added, replaced, removed, or explicitly marked unnecessary.
    let questionImage = editDraft.questionImageRemoved
      ? null
      : q.questionImage || null;
    const questionImagePath = normalizePath(editDraft.questionImagePath);

    if (editDraft.questionImageFile) {
      if (!questionImagePath || !isImagePath(questionImagePath)) {
        setDbMessage(
          "Use a valid image filename, such as images/q12-question.png.",
        );
        return;
      }
      questionImage = questionImagePath;
      imageEntries.push({
        path: questionImagePath,
        blob: editDraft.questionImageFile,
      });
    } else if (editDraft.questionImageNotRequired || !questionImagePath) {
      questionImage = null;
    } else if (questionImage) {
      // A path-only change is allowed, but validation below confirms that the image exists.
      questionImage = questionImagePath;
    }

    // Option image files replace the corresponding option text or image path.
    for (let i = 0; i < 4; i++) {
      const file = editDraft.optionImageFiles[i];
      if (!file) continue;
      const path = normalizePath(options[i]);
      if (!path || !isImagePath(path)) {
        setDbMessage(
          `Option ${LABELS[i]} needs a valid image path, such as images/q${q.questionNumber}-option-${LABELS[i].toLowerCase()}.png.`,
        );
        return;
      }
      imageEntries.push({ path, blob: file });
      options[i] = path;
    }

    const priorReasons = Array.isArray(q.reviewReasons) ? q.reviewReasons : [];
    const oldQuestionImagePath = normalizePath(q.questionImage);
    const questionImageReason = (reason) =>
      /question image|source image contains|visual.*question/i.test(reason) ||
      Boolean(
        oldQuestionImagePath &&
        reason === `Missing image: ${oldQuestionImagePath}`,
      );
    const onlyQuestionImageReviewReasons =
      priorReasons.length > 0 && priorReasons.every(questionImageReason);
    const imageReviewResolved = Boolean(
      editDraft.questionImageNotRequired && onlyQuestionImageReviewReasons,
    );

    const candidate = {
      ...q,
      notes: editDraft.note,
      question: editDraft.question,
      subject: editDraft.subject.trim(),
      topic: editDraft.topic.trim(),
      options,
      questionImage,
      questionImageNotRequired: Boolean(
        editDraft.questionImageNotRequired && !questionImage,
      ),
      correctAnswerIndex: answerIndex,
      correctAnswer: Number.isInteger(answerIndex) ? options[answerIndex] : "",
      // Track whether the answer was explicitly verified by the user.
      answerValidation: editDraft.verified
        ? "source-key-verified"
        : "source-key-unverified",
      // A user can resolve image-only review without silently clearing unrelated review flags.
      visualReviewNeeded:
        editDraft.verified || imageReviewResolved
          ? false
          : q.visualReviewNeeded,
      practiceReady:
        editDraft.verified || imageReviewResolved ? true : q.practiceReady,
    };

    // Validate against images already stored for this paper and new uploads.
    const imagePrefix = `${q.paperId}::`;
    const knownImagePaths = new Set(
      Object.keys(imageUrls)
        .filter((key) => key.startsWith(imagePrefix))
        .map((key) => key.slice(imagePrefix.length)),
    );

    imageEntries.forEach((item) => {
      knownImagePaths.add(normalizePath(item.path));
    });

    let normalized;

    try {
      normalized = normalizeQuestion(candidate, 0, knownImagePaths);
    } catch (error) {
      setDbMessage(error.message || "Question validation failed.");
      return;
    }

    // Removing a previously referenced question image is a review event unless the user
    // explicitly confirms that this question does not require an image.
    const removedRequiredImage = Boolean(
      editDraft.questionImageRemoved &&
      !editDraft.questionImageNotRequired &&
      q.questionImage,
    );
    if (removedRequiredImage) {
      normalized.visualReviewNeeded = true;
      normalized.practiceReady = false;
      normalized.reviewReasons = [
        ...(normalized.reviewReasons || []),
        "Question image removed; verify whether an image is required",
      ];
    }

    // Do not allow verification to bypass missing images or incomplete fields.
    if (editDraft.verified && !normalized.practiceReady) {
      setDbMessage(
        `Cannot verify this question yet: ${
          normalized.reviewReasons.join("; ") ||
          "Complete all required fields and resolve missing images."
        }`,
      );
      return;
    }

    setDbBusy(true);
    setDbMessage("");

    try {
      await saveQuestionWithImages(normalized, imageEntries);

      // Persist the note alongside the existing practice history.
      setProgress((previous) => ({
        ...previous,
        [q.id]: {
          ...getState(previous, q),
          note: editDraft.note,
        },
      }));

      const updated = await db.questions.orderBy("paperId").toArray();

      setBank(updated);
      setSession((previous) =>
        previous.map((item) => (item.id === q.id ? normalized : item)),
      );

      setEditingQuestionId(null);
      setEditDraft(null);

      setDbMessage(
        `${q.id} updated. ${
          normalized.practiceReady
            ? "Question is practice-ready."
            : "It remains flagged for review."
        }`,
      );
    } catch (error) {
      setDbMessage(error.message || "Could not save the question.");
    } finally {
      setDbBusy(false);
    }
  }
  async function handleDeletePaper(paperId) {
    const count = bank.filter((q) => q.paperId === paperId).length;
    if (
      !window.confirm(
        `Delete ${paperId} and all ${count} questions? This cannot be undone.`,
      )
    )
      return;
    setDbBusy(true);
    try {
      const deletedIds = new Set(
        bank.filter((q) => q.paperId === paperId).map((q) => q.id),
      );
      await deletePaper(paperId);
      const updated = await db.questions.orderBy("paperId").toArray();
      setBank(updated);
      setProgress((prev) => {
        const next = { ...prev };
        deletedIds.forEach((id) => delete next[id]);
        return next;
      });
      setSession((prev) => prev.filter((q) => q.paperId !== paperId));
      setCoveragePaper((prev) =>
        prev === paperId ? updated[0]?.paperId || "" : prev,
      );
      setDbMessage(
        `${paperId} and its associated questions/images were deleted.`,
      );
    } catch (error) {
      setDbMessage(error.message || "Could not delete paper.");
    } finally {
      setDbBusy(false);
    }
  }

  function openCoverageQuestion(q) {
    // On mobile, close the sidebar when the user navigates to a question.
    setSidebarOpen(false);

    if (!isPracticeReady(q)) {
      setSessionError(
        `${q.id} needs review: ${
          (q.reviewReasons || []).join("; ") ||
          "Check its question, options, answer key, and images."
        }`,
      );

      // Review warnings are shown above the question panel.
      // Scroll to the warning instead of returning to the import module.
      requestAnimationFrame(() => {
        document
          .getElementById("main-content")
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      return;
    }

    setSessionError("");
    setCompletedSession(null);
    setSession([q]);
    setIdx(0);
    setSelected(null);
    setChecked(false);
    setSessionResults({});

    // Scroll directly to the question panel, not the top of the page.
    // The panel already exists in the DOM, so this target is stable.
    requestAnimationFrame(() => {
      document
        .getElementById("quiz-panel")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  const attemptedQuestions = bank.filter(
    (q) => getState(progress, q).attempts.length > 0,
  );
  const allTries = attemptedQuestions.reduce(
    (n, q) => n + getState(progress, q).attempts.length,
    0,
  );
  const correctTries = attemptedQuestions.reduce(
    (n, q) =>
      n + getState(progress, q).attempts.filter((a) => a.correct).length,
    0,
  );
  const statsByTopic = useMemo(() => {
    const map = {};
    bank.forEach((q) => {
      const key = `${q.subject || "Unclassified"} — ${q.topic || "Unclassified"}`;
      map[key] ||= { total: 0, attempted: 0, wrong: 0, marked: 0 };
      map[key].total++;
      const s = getState(progress, q);
      if (s.attempts.length) map[key].attempted++;
      if (s.attempts.some((a) => !a.correct)) map[key].wrong++;
      if (s.marked) map[key].marked++;
    });
    return Object.entries(map).sort((a, b) => b[1].total - a[1].total);
  }, [bank, progress]);

  // New: subjects available only in the currently selected paper.
  const coverageSubjects = useMemo(
    () =>
      [
        ...new Set(
          bank
            .filter((q) => q.paperId === coveragePaper)
            .map((q) => q.subject)
            .filter(Boolean),
        ),
      ].sort(),
    [bank, coveragePaper],
  );

  // New: topics are limited to the selected subject within the selected paper.
  const coverageTopics = useMemo(
    () =>
      [
        ...new Set(
          bank
            .filter(
              (q) =>
                q.paperId === coveragePaper &&
                (coverageSubject === "All" || q.subject === coverageSubject),
            )
            .map((q) => q.topic)
            .filter(Boolean),
        ),
      ].sort(),
    [bank, coveragePaper, coverageSubject],
  );

  const coverageQuestions = useMemo(
    () =>
      bank
        .filter(
          (q) =>
            q.paperId === coveragePaper &&
            (coverageSubject === "All" || q.subject === coverageSubject) &&
            (coverageTopic === "All" || q.topic === coverageTopic),
        )
        .filter((q) => {
          const state = getState(progress, q);
          const status = questionStatus(q, progress);
          const statusMatch =
            coverageStatus === "All" ||
            (coverageStatus === "Covered" && state.attempts.length > 0) ||
            (coverageStatus === "Uncovered" &&
              state.attempts.length === 0 &&
              isPracticeReady(q)) ||
            (coverageStatus === "Has errors" &&
              state.attempts.some((a) => !a.correct)) ||
            (coverageStatus === "Review" && state.marked) ||
            (coverageStatus === "Needs review" &&
              (!isPracticeReady(q) || q.visualReviewNeeded));
          const search = coverageSearch.trim().toLowerCase();
          const searchMatch =
            !search ||
            `${q.id} ${q.question || ""} ${q.topic || ""} ${q.subject || ""} ${(q.reviewReasons || []).join(" ")}`
              .toLowerCase()
              .includes(search);
          return statusMatch && searchMatch;
        })
        .sort((a, b) => a.questionNumber - b.questionNumber),
    [
      bank,
      coveragePaper,
      coverageSubject,
      coverageTopic,
      coverageStatus,
      coverageSearch,
      progress,
    ],
  );

  const paperStats = useMemo(
    () =>
      papers.map((id) => {
        const qs = bank.filter((q) => q.paperId === id);
        return {
          id,
          total: qs.length,
          covered: qs.filter((q) => getState(progress, q).attempts.length > 0)
            .length,
          ready: qs.filter(isPracticeReady).length,
        };
      }),
    [papers, bank, progress],
  );

  function renderImage(path, alt, className, paperId) {
    const normalized = normalizePath(path);
    const src = imageUrls[`${paperId}::${normalized}`];
    if (!src)
      return (
        <span className="tag-warning" role="status">
          Missing image: {normalized}
        </span>
      );
    return <img className={className} src={src} alt={alt} />;
  }

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <div className="eyebrow">
            LOCAL QUESTION BANK · {papers.length} PAPER(S)
          </div>
          <h1>PYQ Tracker</h1>
          <p>
            Question coverage, practice, and error review — stored locally in
            this browser
          </p>
        </div>
        {/* <div className="button-row">
           <button
             className="button light"
             onClick={() => exportFile("rrb-je-progress.json", progress)}
             disabled={!bank.length}
           >
             <Download size={16} /> Export progress
           </button>
         </div> */}
      </header>

      <main className="layout">
        {/* Mobile-only toggle; hidden on desktop by index.css. */}
        <button
          type="button"
          className="button outline sidebar-toggle"
          onClick={() => setSidebarOpen((open) => !open)}
          aria-expanded={sidebarOpen}
          aria-controls="app-sidebar"
        >
          {sidebarOpen ? <X size={16} /> : <Menu size={16} />}
          {sidebarOpen ? "Hide sidebar" : "Import / Practice menu"}
        </button>

        {/* Desktop sidebar remains visible; mobile visibility follows sidebarOpen. */}
        <aside
          id="app-sidebar"
          className={`sidebar panel ${sidebarOpen ? "sidebar-open" : "sidebar-closed"}`}
        >
          <h2>Import question bank</h2>
          <p className="section-subtitle">
            Start empty. Import one JSON question array or a ZIP containing
            questions.json and its image folder.
          </p>
          <label className="file-label">
            <span className="button primary full">
              <Upload size={16} /> Choose JSON or ZIP
            </span>
            <input
              type="file"
              accept=".json,.zip,application/json,application/zip"
              onChange={handleImport}
              disabled={dbBusy}
            />
          </label>
          {dbBusy && (
            <p role="status" className="inline-message">
              Validating and importing…
            </p>
          )}
          {dbMessage && (
            <div className="alert" role="status">
              <AlertTriangle size={16} />
              <span>{dbMessage}</span>
              <button
                className="icon-button"
                onClick={() => setDbMessage("")}
                aria-label="Dismiss error"
              >
                <X size={15} />
              </button>
            </div>
          )}
          {loadError && (
            <div className="alert" role="alert">
              <AlertTriangle size={16} />
              <span>{loadError}</span>
              <button
                className="icon-button"
                onClick={() => setLoadError("")}
                aria-label="Dismiss error"
              >
                <X size={15} />
              </button>
            </div>
          )}
          <div className="separator" />
          <h2>Practice setup</h2>
          <label>
            Subject
            <select
              value={subject}
              onChange={(e) => {
                setSubject(e.target.value);
                setTopic("All");
              }}
            >
              {/* <option value="Focus">Maths + Reasoning + Science</option> */}
              <option value="All">All subjects</option>
              {subjects.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label>
            Paper
            <select
              value={paper}
              onChange={(e) => {
                setPaper(e.target.value);
                setTopic("All");
              }}
            >
              <option value="All">All papers</option>
              {papers.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
          <label>
            Topic
            <select value={topic} onChange={(e) => setTopic(e.target.value)}>
              <option value="All">All topics</option>
              {availableTopics.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label>
            Mode
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="unseen">Unseen first</option>
              <option value="wrong">Wrong answers</option>
              <option value="all">All · unseen then repeats</option>
              <option value="review">Marked for review</option>
            </select>
          </label>
          <label>
            Session size
            <select value={size} onChange={(e) => setSize(e.target.value)}>
              {["10", "20", "30", "50", "100"].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
          <div className="button-row">
            <button
              className="button primary"
              onClick={() => startSession(false)}
              disabled={!bank.length || dbBusy}
            >
              Start session
            </button>
            <button
              className="button outline"
              title="Shuffle questions"
              onClick={() => startSession(true)}
              disabled={!bank.length || dbBusy}
            >
              <Shuffle size={16} />
            </button>
          </div>
          <div className="separator" />
          <h2>Overall coverage</h2>
          <div className="stats">
            <div>
              <small>Questions</small>
              <b>{bank.length}</b>
            </div>
            <div>
              <small>Covered</small>
              <b>{attemptedQuestions.length}</b>
            </div>
            <div>
              <small>Accuracy</small>
              <b>
                {allTries
                  ? `${Math.round((correctTries / allTries) * 100)}%`
                  : "—"}
              </b>
            </div>
          </div>
          <div className="overall-progress">
            <span
              style={{
                width: `${bank.length ? (attemptedQuestions.length / bank.length) * 100 : 0}%`,
              }}
            />
          </div>
          <label className="file-label">
            Import progress backup
            <input
              type="file"
              accept=".json,application/json"
              onChange={importProgress}
              disabled={dbBusy || !bank.length}
            />
          </label>
          {importMessage && (
            <p className="inline-message" role="status">
              {importMessage}
            </p>
          )}

          <button
            className="button outline full"
            onClick={() => exportQuestionBank("all")}
            disabled={!bank.length || dbBusy}
          >
            <Download size={14} /> Export all papers (ZIP)
          </button>

          <button
            className="button outline full"
            onClick={() => exportQuestionBank("paper")}
            disabled={!bank.some((q) => q.paperId === coveragePaper) || dbBusy}
          >
            <Download size={14} /> Export selected paper (ZIP)
          </button>

          <button
            className="button ghost full"
            onClick={() => {
              if (
                window.confirm(
                  "Reset all saved attempts, review marks, and notes?",
                )
              ) {
                setProgress({});
                localStorage.removeItem(PROGRESS_KEY);
              }
            }}
            disabled={!bank.length}
          >
            <RotateCcw size={14} /> Reset progress
          </button>
          <p className="fineprint">
            Questions and extracted images persist in this browser. Export
            backups before clearing browser data. This app does not sync between
            devices.
          </p>
        </aside>

        {/* Target for scrolling to question-review warnings. */}
        <section className="main-column" id="main-content">
          {sessionError && (
            <div className="alert" role="status">
              <AlertTriangle size={16} />
              <span>{sessionError}</span>
              <button
                className="icon-button"
                onClick={() => setSessionError("")}
                aria-label="Dismiss error"
              >
                <X size={15} />
              </button>
            </div>
          )}
          {/* Target for scrolling directly to the opened question. */}
          <section className="panel quiz-panel" id="quiz-panel">
            {!current ? (
              completedSession ? (
                <div className="completion">
                  <CheckCircle2 size={38} />
                  <h2>Session complete</h2>
                  <p>
                    You answered {completedSession.answered} of{" "}
                    {completedSession.total} questions.
                  </p>
                  <div className="completion-stats">
                    <div>
                      <b>{completedSession.correct}</b>
                      <small>Correct</small>
                    </div>
                    <div>
                      <b>{completedSession.incorrect}</b>
                      <small>Incorrect</small>
                    </div>
                    <div>
                      <b>
                        {completedSession.answered
                          ? `${Math.round((completedSession.correct / completedSession.answered) * 100)}%`
                          : "—"}
                      </b>
                      <small>Accuracy</small>
                    </div>
                  </div>
                  <button
                    className="button primary"
                    onClick={() => startSession(false)}
                  >
                    Start another session
                  </button>
                </div>
              ) : (
                <div className="empty">
                  {bank.length ? (
                    <CircleHelp size={34} />
                  ) : (
                    <FileJson size={36} />
                  )}
                  <h2>
                    {bank.length
                      ? "Ready to practise"
                      : "Your question bank is empty"}
                  </h2>
                  <p>
                    {bank.length
                      ? "Choose filters and start a session. Incomplete questions remain in Paper coverage for review."
                      : "Upload a JSON array of questions, or a ZIP containing questions.json and all referenced images. Nothing is seeded automatically."}
                  </p>
                  {!bank.length && (
                    <p>
                      <strong>Accepted:</strong> .json or .zip
                    </p>
                  )}
                  {bank.length > 0 && (
                    <button
                      className="button primary"
                      onClick={() => startSession(false)}
                    >
                      Start session
                    </button>
                  )}
                </div>
              )
            ) : (
              <>
                <div className="question-meta">
                  <span>
                    {idx + 1} / {session.length} · {current.id}
                  </span>
                  <span>
                    {current.paperId} · Q{current.questionNumber}
                  </span>
                </div>
                <div className="overall-progress">
                  <span
                    style={{ width: `${((idx + 1) / session.length) * 100}%` }}
                  />
                </div>
                <div className="tags">
                  <span>{current.subject || "Unclassified"}</span>
                  <span>{current.topic || "Unclassified"}</span>
                  <span
                    className={
                      getState(progress, current).attempts.length
                        ? "tag-covered"
                        : "tag-uncovered"
                    }
                  >
                    {getState(progress, current).attempts.length
                      ? "Covered"
                      : "Uncovered"}
                  </span>
                  {current.answerValidation === "source-key-unverified" && (
                    <span className="tag-warning">Key unverified</span>
                  )}
                </div>
                <div className="question-text">
                  {current.question ||
                    "Question text missing — review the source."}
                </div>
                {current.questionImage && (
                  <div className="source-image-wrap">
                    {renderImage(
                      current.questionImage,
                      `Question ${current.questionNumber}`,
                      "question-image",
                      current.paperId,
                    )}
                  </div>
                )}
                {current.reviewReasons?.length > 0 && (
                  <div className="alert">
                    <AlertTriangle size={16} />
                    <span>
                      Review required: {current.reviewReasons.join("; ")}
                    </span>
                  </div>
                )}
                <div className="options">
                  {(current.options || []).map((option, i) => {
                    const imageOption = isImagePath(option);
                    let cls = "option";
                    if (selected === i) cls += " selected";
                    if (checked && i === current.correctAnswerIndex)
                      cls += " correct";
                    else if (checked && selected === i) cls += " incorrect";
                    return (
                      <button
                        key={`${current.id}-${i}`}
                        className={cls}
                        onClick={() => !checked && setSelected(i)}
                        disabled={checked}
                      >
                        <span className="option-label">{LABELS[i]}</span>
                        {imageOption ? (
                          renderImage(
                            option,
                            `Option ${LABELS[i]}`,
                            "option-image",
                            current.paperId,
                          )
                        ) : (
                          <span>
                            {option || (
                              <em>Option text missing — review required</em>
                            )}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
                {checked && (
                  <div
                    className={`feedback ${selected === current.correctAnswerIndex ? "success" : "error"}`}
                  >
                    <strong>
                      {selected === current.correctAnswerIndex
                        ? "Correct"
                        : "Incorrect"}
                    </strong>
                    <span>
                      Answer:{" "}
                      {Number.isInteger(current.correctAnswerIndex)
                        ? isImagePath(
                            current.options[current.correctAnswerIndex],
                          )
                          ? `Option ${LABELS[current.correctAnswerIndex]}`
                          : current.correctAnswer ||
                            current.options[current.correctAnswerIndex]
                        : "Answer key unavailable"}
                    </span>
                    {current.notes && <small>{current.notes}</small>}
                    {current.answerValidation === "source-key-unverified" && (
                      <small>
                        Answer key has not been independently verified.
                      </small>
                    )}
                  </div>
                )}
                {/* <label className="note-label">
                   Memory trick / explanation note
                   <textarea
                     value={noteDraft}
                     onChange={(e) => {
                       const value = e.target.value;
                       setNoteDraft(value);
                       updateQuestionState(current, (s) => ({
                         ...s,
                         note: value,
                       }));
                     }}
                     rows={2}
                     placeholder="Shortcut, mnemonic, or explanation…"
                   />
                 </label> */}
                <div className="button-row question-controls">
                  <button
                    className="button outline"
                    onClick={previous}
                    disabled={idx === 0}
                  >
                    <ChevronLeft size={16} /> Previous
                  </button>
                  <button
                    className="button outline"
                    onClick={() => toggleMark()}
                  >
                    <Bookmark size={16} />
                    {currentState?.marked ? "Unmark" : "Review"}
                  </button>
                  {/* <button className="button outline" onClick={() => saveNote()}>
                    <Save size={15} /> Save note
                  </button> */}
                  {!checked ? (
                    <button
                      className="button primary"
                      onClick={checkAnswer}
                      disabled={selected === null}
                    >
                      Check answer
                    </button>
                  ) : (
                    <button className="button primary" onClick={next}>
                      {idx === session.length - 1 ? "Finish" : "Next"}{" "}
                      <ChevronRight size={16} />
                    </button>
                  )}
                </div>
              </>
            )}
          </section>

          <section className="panel coverage-panel">
            <div className="section-heading">
              <div>
                <h2>Paper-wise coverage</h2>
                <p className="section-subtitle">
                  Incomplete records are retained and flagged; only
                  practice-ready questions enter sessions.
                </p>
              </div>
              <button
                className="button ghost"
                onClick={() => {
                  if (
                    window.confirm(
                      "Reset all saved attempts, review marks, and notes?",
                    )
                  )
                    setProgress({});
                }}
                disabled={!bank.length}
              >
                <RotateCcw size={14} /> Reset progress
              </button>
            </div>
            {paperStats.length === 0 ? (
              <div className="empty-list">
                No papers yet. Import a JSON file or ZIP to populate this
                section.
              </div>
            ) : (
              <div className="paper-cards">
                {paperStats.map((p) => (
                  <div
                    key={p.id}
                    className={`paper-card ${coveragePaper === p.id ? "active" : ""}`}
                  >
                    <button
                      className="paper-card-select"
                      onClick={() => {
                        setCoveragePaper(p.id);
                        setCoverageSubject("All"); // Reset subject for the new paper.
                        setCoverageTopic("All"); // Reset topic for the new paper.
                        setCoverageOpen(true);
                      }}
                    >
                      <span className="paper-card-title">{p.id}</span>
                      <strong>
                        {p.covered}/{p.total}
                      </strong>
                      <small>covered · {p.ready} practice-ready</small>
                      <span className="mini-progress">
                        <span
                          style={{
                            width: `${p.total ? (p.covered / p.total) * 100 : 0}%`,
                          }}
                        />
                      </span>
                    </button>
                    <button
                      className="button delete-paper-button"
                      disabled={dbBusy}
                      onClick={() => handleDeletePaper(p.id)}
                    >
                      Delete paper
                    </button>
                  </div>
                ))}
              </div>
            )}
            {coveragePaper && (
              <>
                <div className="coverage-browser-head">
                  <h3>{coveragePaper} · Questions</h3>
                  <button
                    className="button ghost"
                    onClick={() => setCoverageOpen((v) => !v)}
                  >
                    {coverageOpen ? "Hide list" : "Show list"} <Eye size={14} />
                  </button>
                </div>
                {coverageOpen && (
                  <>
                    <div className="coverage-filters">
                      <label className="search-box">
                        <Search size={15} />
                        <input
                          value={coverageSearch}
                          onChange={(e) => setCoverageSearch(e.target.value)}
                          placeholder="Search question, topic, ID…"
                        />
                      </label>
                      <select
                        value={coverageStatus}
                        onChange={(e) => setCoverageStatus(e.target.value)}
                        aria-label="Filter question status"
                      >
                        {[
                          "All",
                          "Covered",
                          "Uncovered",
                          "Has errors",
                          "Review",
                          "Needs review",
                        ].map((s) => (
                          <option key={s}>{s}</option>
                        ))}
                      </select>
                      {/* New: filter questions by subject within the selected paper. */}
                      <select
                        value={coverageSubject}
                        onChange={(e) => {
                          setCoverageSubject(e.target.value);

                          // Reset topic because it may not belong to the newly selected subject.
                          setCoverageTopic("All");
                        }}
                        aria-label="Filter questions by subject"
                      >
                        <option value="All">All subjects</option>
                        {coverageSubjects.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>

                      {/* New: available topics depend on the selected subject. */}
                      <select
                        value={coverageTopic}
                        onChange={(e) => setCoverageTopic(e.target.value)}
                        aria-label="Filter questions by topic"
                      >
                        <option value="All">All topics</option>
                        {coverageTopics.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </div>
                    <p className="coverage-count">
                      Showing {coverageQuestions.length} of{" "}
                      {bank.filter((q) => q.paperId === coveragePaper).length}{" "}
                      questions
                    </p>
                    <div className="coverage-question-list">
                      {coverageQuestions.map((q) => {
                        const state = getState(progress, q);
                        const ready = isPracticeReady(q);
                        const editing = editingQuestionId === q.id;
                        return (
                          <div className="coverage-question" key={q.id}>
                            {editing && editDraft ? (
                              <div className="question-edit-form">
                                <label>
                                  Question {q.questionNumber} Text
                                  <textarea
                                    rows={4}
                                    value={editDraft.question}
                                    onChange={(e) =>
                                      setEditDraft((p) => ({
                                        ...p,
                                        question: e.target.value,
                                      }))
                                    }
                                  />
                                </label>

                                {/* <label>
                                  Subject
                                  <input
                                    value={editDraft.subject}
                                    onChange={(e) =>
                                      setEditDraft((p) => ({
                                        ...p,
                                        subject: e.target.value,
                                      }))
                                    }
                                  />
                                </label>

                                <label>
                                  Topic
                                  <input
                                    value={editDraft.topic}
                                    onChange={(e) =>
                                      setEditDraft((p) => ({
                                        ...p,
                                        topic: e.target.value,
                                      }))
                                    }
                                  />
                                </label> */}

                                <label>
                                  Subject
                                  <select
                                    value={editDraft.subject}
                                    onChange={(e) =>
                                      setEditDraft((previous) => ({
                                        ...previous,
                                        subject: e.target.value,
                                        topic: "",
                                      }))
                                    }
                                  >
                                    <option value="">Select subject</option>
                                    {subjects.map((value) => (
                                      <option key={value} value={value}>
                                        {value}
                                      </option>
                                    ))}
                                    {/* <option value="__new__">
                                      + Create new subject…
                                    </option> */}
                                  </select>
                                </label>

                                <label>
                                  Topic / tag
                                  <select
                                    value={editDraft.topic}
                                    onChange={(e) => {
                                      const value = e.target.value;

                                      if (value === "__new__") {
                                        const newTopic = window.prompt(
                                          "Enter a new topic name:",
                                        );
                                        if (!newTopic?.trim()) return;

                                        const normalized = newTopic.trim();
                                        const existing = availableTopics.find(
                                          (t) =>
                                            t.toLowerCase() ===
                                            normalized.toLowerCase(),
                                        );

                                        setEditDraft((previous) => ({
                                          ...previous,
                                          topic: existing || normalized,
                                        }));
                                        return;
                                      }

                                      setEditDraft((previous) => ({
                                        ...previous,
                                        topic: value,
                                      }));
                                    }}
                                  >
                                    <option value="">Select topic</option>

                                    {editTopics.map((value) => (
                                      <option key={value} value={value}>
                                        {value}
                                      </option>
                                    ))}

                                    {/* <option value="__new__">
                                      + Create new topic…
                                    </option> */}
                                  </select>
                                </label>
                                {/* Question image: add, replace, remove, or mark as not required */}
                                {(() => {
                                  const currentPath = q.questionImage
                                    ? normalizePath(q.questionImage)
                                    : "";
                                  const currentSrc = currentPath
                                    ? imageUrls[`${q.paperId}::${currentPath}`]
                                    : null;
                                  const previewSrc =
                                    editImagePreviewUrls.question || currentSrc;
                                  const imageRemoved =
                                    editDraft.questionImageRemoved ||
                                    editDraft.questionImageNotRequired;

                                  return (
                                    <div className="edit-image-section">
                                      <h4>
                                        Question image{" "}
                                        <span className="edit-image-hint">
                                          (optional when not needed)
                                        </span>
                                      </h4>
                                      {previewSrc && !imageRemoved && (
                                        <img
                                          className="edit-image-preview"
                                          src={previewSrc}
                                          alt={`Question ${q.questionNumber} image preview`}
                                        />
                                      )}
                                      {currentPath &&
                                        !currentSrc &&
                                        !editDraft.questionImageFile &&
                                        !imageRemoved && (
                                          <p
                                            className="edit-image-warning"
                                            role="status"
                                          >
                                            Stored image is missing. Upload a
                                            replacement or remove the reference.
                                          </p>
                                        )}
                                      <label>
                                        Image path / filename
                                        <input
                                          value={editDraft.questionImagePath}
                                          disabled={imageRemoved}
                                          onChange={(e) =>
                                            setEditDraft((p) => ({
                                              ...p,
                                              questionImagePath: e.target.value,
                                              questionImageRemoved: false,
                                            }))
                                          }
                                          placeholder={`images/q${q.questionNumber}-question.png`}
                                        />
                                      </label>
                                      <label>
                                        {currentPath && !imageRemoved
                                          ? "Add / replace question image"
                                          : "Add question image (optional)"}
                                        <input
                                          type="file"
                                          accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp,image/svg+xml"
                                          onChange={(e) => {
                                            const file =
                                              e.target.files?.[0] || null;
                                            setEditDraft((p) => ({
                                              ...p,
                                              questionImageFile: file,
                                              questionImageRemoved: false,
                                              questionImageNotRequired: file
                                                ? false
                                                : p.questionImageNotRequired,
                                            }));
                                            e.target.value = "";
                                          }}
                                        />
                                      </label>
                                      {editDraft.questionImageFile && (
                                        <small>
                                          Selected:{" "}
                                          {editDraft.questionImageFile.name}
                                        </small>
                                      )}
                                      <div className="button-row edit-image-actions">
                                        {(currentPath ||
                                          editDraft.questionImageFile) &&
                                          !imageRemoved && (
                                            <button
                                              type="button"
                                              className="button outline"
                                              disabled={dbBusy}
                                              onClick={() =>
                                                setEditDraft((p) => ({
                                                  ...p,
                                                  questionImagePath: "",
                                                  questionImageFile: null,
                                                  questionImageRemoved: true,
                                                }))
                                              }
                                            >
                                              Remove image
                                            </button>
                                          )}
                                        <label className="edit-image-optional">
                                          <input
                                            type="checkbox"
                                            checked={Boolean(
                                              editDraft.questionImageNotRequired,
                                            )}
                                            onChange={(e) =>
                                              setEditDraft((p) => ({
                                                ...p,
                                                questionImageNotRequired:
                                                  e.target.checked,
                                                questionImageRemoved:
                                                  e.target.checked,
                                                questionImagePath: e.target
                                                  .checked
                                                  ? p.questionImagePath
                                                  : p.questionImagePath ||
                                                    q.questionImage ||
                                                    `images/q${q.questionNumber}-question.png`,
                                                questionImageFile: e.target
                                                  .checked
                                                  ? null
                                                  : p.questionImageFile,
                                              }))
                                            }
                                          />
                                          This question does not require an
                                          image
                                        </label>
                                      </div>
                                    </div>
                                  );
                                })()}

                                {/* Every option can remain text or be changed to an image, and vice versa. */}
                                <div className="question-edit-options">
                                  {editDraft.options.map((option, i) => {
                                    const imageOption = isImagePath(option);
                                    const path = imageOption
                                      ? normalizePath(option)
                                      : "";
                                    const src = path
                                      ? imageUrls[`${q.paperId}::${path}`]
                                      : null;
                                    const selectedPreview =
                                      editImagePreviewUrls[`option-${i}`];
                                    const previewSrc = selectedPreview || src;
                                    const defaultPath = `images/q${q.questionNumber}-option-${LABELS[i].toLowerCase()}.png`;

                                    return (
                                      <div
                                        className="edit-option-field"
                                        key={i}
                                      >
                                        <h4>Option {LABELS[i]}</h4>
                                        {!imageOption ? (
                                          <>
                                            <label>
                                              Option text
                                              <input
                                                value={option}
                                                onChange={(e) =>
                                                  setEditDraft((p) => ({
                                                    ...p,
                                                    options: p.options.map(
                                                      (v, j) =>
                                                        j === i
                                                          ? e.target.value
                                                          : v,
                                                    ),
                                                  }))
                                                }
                                                placeholder={`Enter option ${LABELS[i]} text`}
                                              />
                                            </label>
                                            <label>
                                              Replace text with an image
                                              (optional)
                                              <input
                                                type="file"
                                                accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp,image/svg+xml"
                                                onChange={(e) => {
                                                  const file =
                                                    e.target.files?.[0] || null;
                                                  setEditDraft((p) => ({
                                                    ...p,
                                                    options: p.options.map(
                                                      (v, j) =>
                                                        j === i
                                                          ? file
                                                            ? isImagePath(v)
                                                              ? normalizePath(v)
                                                              : defaultPath
                                                            : v
                                                          : v,
                                                    ),
                                                    optionImageFiles: {
                                                      ...p.optionImageFiles,
                                                      [i]: file,
                                                    },
                                                  }));
                                                  e.target.value = "";
                                                }}
                                              />
                                            </label>
                                          </>
                                        ) : (
                                          <>
                                            {previewSrc ? (
                                              <img
                                                className="edit-image-preview option-image-preview"
                                                src={previewSrc}
                                                alt={`Option ${LABELS[i]} image preview`}
                                              />
                                            ) : (
                                              <p
                                                className="edit-image-warning"
                                                role="status"
                                              >
                                                Missing image: {path}
                                              </p>
                                            )}
                                            <label>
                                              Image path / filename
                                              <input
                                                value={option}
                                                onChange={(e) =>
                                                  setEditDraft((p) => ({
                                                    ...p,
                                                    options: p.options.map(
                                                      (v, j) =>
                                                        j === i
                                                          ? e.target.value
                                                          : v,
                                                    ),
                                                  }))
                                                }
                                                placeholder={defaultPath}
                                              />
                                            </label>
                                            <label>
                                              Replace image
                                              <input
                                                type="file"
                                                accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp,image/svg+xml"
                                                onChange={(e) => {
                                                  const file =
                                                    e.target.files?.[0] || null;
                                                  setEditDraft((p) => ({
                                                    ...p,
                                                    optionImageFiles: {
                                                      ...p.optionImageFiles,
                                                      [i]: file,
                                                    },
                                                  }));
                                                  e.target.value = "";
                                                }}
                                              />
                                            </label>
                                          </>
                                        )}
                                        {editDraft.optionImageFiles[i] && (
                                          <small>
                                            Selected:{" "}
                                            {editDraft.optionImageFiles[i].name}
                                          </small>
                                        )}
                                        {imageOption && (
                                          <button
                                            type="button"
                                            className="button outline"
                                            disabled={dbBusy}
                                            onClick={() =>
                                              setEditDraft((p) => ({
                                                ...p,
                                                options: p.options.map(
                                                  (v, j) => (j === i ? "" : v),
                                                ),
                                                optionImageFiles: {
                                                  ...p.optionImageFiles,
                                                  [i]: null,
                                                },
                                              }))
                                            }
                                          >
                                            Remove image / switch to text
                                          </button>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>

                                <label>
                                  Correct answer
                                  <select
                                    value={editDraft.correctAnswerIndex ?? ""}
                                    onChange={(e) =>
                                      setEditDraft((p) => ({
                                        ...p,
                                        correctAnswerIndex:
                                          e.target.value === ""
                                            ? null
                                            : Number(e.target.value),
                                      }))
                                    }
                                  >
                                    <option value="">
                                      Unknown / needs review
                                    </option>
                                    {LABELS.map((label, i) => (
                                      <option key={label} value={i}>
                                        {label}
                                      </option>
                                    ))}
                                  </select>
                                </label>

                                {/* Memory trick / explanation note */}
                                <label>
                                  Memory trick / explanation note
                                  <textarea
                                    rows={3}
                                    value={editDraft.note}
                                    onChange={(e) =>
                                      setEditDraft((p) => ({
                                        ...p,
                                        note: e.target.value,
                                      }))
                                    }
                                    placeholder="Shortcut, mnemonic, explanation, or formula..."
                                  />
                                </label>

                                {/* Verification is explicit and validation still runs before saving. */}
                                <label className="edit-verify-row">
                                  <input
                                    type="checkbox"
                                    checked={editDraft.verified}
                                    onChange={(e) =>
                                      setEditDraft((p) => ({
                                        ...p,
                                        verified: e.target.checked,
                                      }))
                                    }
                                  />
                                  I verified the question, all four options, the
                                  correct answer, and any required images.
                                </label>

                                <div className="button-row">
                                  <button
                                    className="button primary"
                                    disabled={dbBusy}
                                    onClick={() => saveQuestionEdits(q)}
                                  >
                                    Save changes
                                  </button>

                                  <button
                                    className="button outline"
                                    disabled={dbBusy}
                                    onClick={() => {
                                      setEditingQuestionId(null);
                                      setEditDraft(null);
                                    }}
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <>
                                <div className="coverage-question-main">
                                  <span className="coverage-q-number">
                                    Q{q.questionNumber}
                                  </span>
                                  <div className="coverage-q-copy">
                                    <strong>
                                      {(
                                        q.question ||
                                        `Question text missing — ${q.id}`
                                      )
                                        .replace(/\s+/g, " ")
                                        .slice(0, 450)}
                                      {(q.question || "").length > 450 && "…"}
                                    </strong>
                                    {q.questionImage && (
                                      <div className="source-image-wrap">
                                        {renderImage(
                                          q.questionImage,
                                          `Question ${q.questionNumber}`,
                                          "question-image",
                                          q.paperId,
                                        )}
                                      </div>
                                    )}
                                    <small>
                                      {q.subject || "Unclassified"} ·{" "}
                                      {q.topic || "Unclassified"}
                                    </small>
                                    <div className="tags compact">
                                      <span
                                        className={
                                          state.attempts.length
                                            ? "tag-covered"
                                            : "tag-uncovered"
                                        }
                                      >
                                        {questionStatus(q, progress)}
                                      </span>
                                      {q.visualReviewNeeded && (
                                        <span className="tag-warning">
                                          Visual/source review
                                        </span>
                                      )}
                                      {!ready && (
                                        <span className="tag-warning">
                                          Not practice-ready
                                        </span>
                                      )}
                                      {state.marked && (
                                        <span>Marked for review</span>
                                      )}
                                      {state.attempts.some(
                                        (a) => !a.correct,
                                      ) && (
                                        <span className="tag-error">
                                          Wrong attempt
                                        </span>
                                      )}
                                      {q.answerValidation ===
                                        "source-key-unverified" && (
                                        <span className="tag-warning">
                                          Key unverified
                                        </span>
                                      )}
                                    </div>
                                    {q.reviewReasons?.length > 0 && (
                                      <small className="source-small">
                                        {q.reviewReasons.join("; ")}
                                      </small>
                                    )}
                                    {q.notes && (
                                      <small className="saved-note">
                                        {q.notes}
                                      </small>
                                    )}
                                  </div>
                                </div>
                                <button
                                  className="button outline coverage-open-button"
                                  onClick={() => startEditingQuestion(q)}
                                  disabled={dbBusy}
                                >
                                  Edit
                                </button>
                                <button
                                  className="button outline coverage-open-button"
                                  onClick={() => openCoverageQuestion(q)}
                                >
                                  {ready ? "Open" : "Review info"}
                                </button>
                              </>
                            )}
                          </div>
                        );
                      })}
                      {coverageQuestions.length === 0 && (
                        <div className="empty-list">
                          No questions match this paper, status, and search.
                        </div>
                      )}
                    </div>
                  </>
                )}
              </>
            )}
          </section>

          <section className="panel coverage-panel">
            <h2>Topic coverage</h2>
            {!statsByTopic.length ? (
              <p className="section-subtitle">
                Topic statistics will appear after importing questions.
              </p>
            ) : (
              <div className="topic-list">
                {statsByTopic.map(([name, s]) => (
                  <div className="topic-row" key={name}>
                    <div>
                      <span>{name}</span>
                      <small>
                        {s.attempted}/{s.total} covered · {s.wrong} with errors
                        · {s.marked} marked
                      </small>
                    </div>
                    <div className="mini-progress">
                      <span
                        style={{
                          width: `${s.total ? (s.attempted / s.total) * 100 : 0}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </section>
      </main>
      <footer>
        PYQ Tracker · Local-first · Missing or incomplete questions remain
        visible for review and are excluded from practice.
      </footer>
    </div>
  );
}
export default App;
