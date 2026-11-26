// src/db.js
import Dexie from "dexie";

// CHANGED: database v2 adds persistent extracted image Blobs.
// Dexie upgrades v1 data in place; existing questions and papers are retained.
export const db = new Dexie("rrb-je-tracker");

db.version(1).stores({
  questions: "id, paperId, subject, topic, questionNumber",
  papers: "id, date",
});
db.version(2).stores({
  questions: "id, paperId, subject, topic, questionNumber",
  papers: "id, date",
  // CHANGED: image path is unique per paper so two ZIPs can both contain image/img1.png.
  images: "[paperId+path], paperId, path",
});
// Version 3: persistent subject/topic master list.
// Existing questions, papers, and images are retained.
db.version(3).stores({
  questions: "id, paperId, subject, topic, questionNumber",
  papers: "id, date",
  images: "[paperId+path], paperId, path",
  categories: "++id, type, parentId, name",
});
// Version 4: persistent submitted exam history and per-question responses.
// Analytics intentionally resolves question metadata/answer keys from the live
// question bank; answer rows retain the response and scoring inputs at submission.
db.version(4).stores({
  questions: "id, paperId, subject, topic, questionNumber",
  papers: "id, date",
  images: "[paperId+path], paperId, path",
  categories: "++id, type, parentId, name",
  testAttempts: "id, type, paperId, startedAt, submittedAt, status",
  testAttemptAnswers: "id, attemptId, questionId, paperId, [attemptId+questionId], isAttempted",
});
// Keep subject/topic names consistent across all papers.
// Topics are scoped to their parent subject.
async function ensureCategoryRecord(type, name, parentId = "") {
  const cleanName = String(name || "").trim();
  const parent = type === "topic" ? String(parentId || "").trim() : "";

  if (!cleanName || !["subject", "topic"].includes(type)) return;
  if (type === "topic" && !parent) return;

  const records = await db.categories.toArray();

  const exists = records.some(
    (item) =>
      item.type === type &&
      (item.parentId || "") === parent &&
      item.name.trim().toLowerCase() === cleanName.toLowerCase(),
  );

  if (!exists) {
    await db.categories.add({
      type,
      parentId: parent,
      name: cleanName,
    });
  }
}
// Add missing subjects/topics in batches.
// Reads the category table once, even when importing thousands of questions.
async function ensureQuestionCategories(questions) {
  const existing = await db.categories.toArray();

  const knownKeys = new Set(
    existing.map(
      (item) =>
        `${item.type}::${(item.parentId || "").toLowerCase()}::${item.name
          .trim()
          .toLowerCase()}`,
    ),
  );

  const additions = [];

  function collect(type, name, parentId = "") {
    const cleanName = String(name || "").trim();
    const parent = type === "topic" ? String(parentId || "").trim() : "";

    if (!cleanName || (type === "topic" && !parent)) return;

    const key = `${type}::${parent.toLowerCase()}::${cleanName.toLowerCase()}`;

    if (knownKeys.has(key)) return;

    // Add the key immediately so duplicates within the same import
    // are also prevented.
    knownKeys.add(key);

    additions.push({
      type,
      parentId: parent,
      name: cleanName,
    });
  }

  for (const question of questions) {
    collect("subject", question.subject);
    collect("topic", question.topic, question.subject);
  }

  if (additions.length) {
    await db.categories.bulkAdd(additions);
  }
}
// Public helper used by the category manager.
export async function addCategory(type, name, parentId = "") {
  const cleanName = String(name || "").trim();
  const parent = type === "topic" ? String(parentId || "").trim() : "";

  if (!["subject", "topic"].includes(type)) {
    throw new Error("Invalid category type.");
  }

  if (!cleanName) {
    throw new Error("Enter a category name.");
  }

  if (type === "topic" && !parent) {
    throw new Error("Select a subject before adding a topic.");
  }

  return db.transaction("rw", db.categories, async () => {
    const records = await db.categories.toArray();

    const existing = records.find(
      (item) =>
        item.type === type &&
        (item.parentId || "") === parent &&
        item.name.trim().toLowerCase() === cleanName.toLowerCase(),
    );

    // A case-insensitive duplicate is reused rather than added again.
    if (existing) {
      return { category: existing, created: false };
    }

    const id = await db.categories.add({
      type,
      parentId: parent,
      name: cleanName,
    });

    return {
      category: { id, type, parentId: parent, name: cleanName },
      created: true,
    };
  });
}

export async function initializeDatabase() {
  await db.open();

  const questions = await db.questions.orderBy("paperId").toArray();

  // Populate categories from existing questions.
  // This also migrates older question banks into the category master list.
  await db.transaction("rw", db.categories, async () => {
    await ensureQuestionCategories(questions);
  });

  return questions;
}

export async function saveQuestion(question) {
  await db.questions.put(question);
  // Keep the subject/topic master list updated when a question is saved or edited.
  await ensureCategoryRecord("subject", question.subject);
  await ensureCategoryRecord("topic", question.topic, question.subject);

  // Keep the paper's question count accurate.
  // Also supports saving a question if its paper record does not exist yet.
  const questionCount = await db.questions
    .where("paperId")
    .equals(question.paperId)
    .count();

  const existingPaper = await db.papers.get(question.paperId);

  await db.papers.put({
    ...(existingPaper || {}),
    id: question.paperId,
    date: existingPaper?.date || question.date || "",
    shift: existingPaper?.shift || question.shift || "",
    paperFile: existingPaper?.paperFile || question.paperFile || "",
    questionCount,
  });
}

export async function saveQuestionWithImages(question, imageEntries = []) {
  await db.transaction(
    "rw",
    db.questions,
    db.images,
    db.papers,
    db.categories,
    async () => {
      await db.questions.put(question);
      // Ensure the subject and topic exist in the reusable category master list.
      await ensureQuestionCategories([question]);
      for (const item of imageEntries) {
        const path = normalizeImagePath(item.path);
        if (!path || !item.blob) continue;
        await db.images.put({
          paperId: question.paperId,
          path,
          blob: item.blob,
          updatedAt: new Date().toISOString(),
        });
      }

      // Remove stored blobs that are no longer referenced by any question in this paper.
      // If multiple questions share a path, keep the blob until the last reference is removed.
      const paperQuestions = await db.questions.where("paperId").equals(question.paperId).toArray();
      const referenced = new Set();
      for (const item of paperQuestions) {
        if (item.questionImage) referenced.add(normalizeImagePath(item.questionImage));
        for (const imagePath of item.questionImages || []) {
          if (imagePath) {
            referenced.add(normalizeImagePath(imagePath));
          }
        }
        for (const option of item.options || []) {
          if (typeof option === "string" && /\.(png|jpe?g|webp|gif|svg|avif|bmp)(?:[?#].*)?$/i.test(option)) {
            referenced.add(normalizeImagePath(option));
          }
        }
        // Keep optional images attached to text-bearing options in the same paper image store.
        for (const source of item.optionImageSources || []) {
          if (typeof source === "string" && source && !/^https?:\/\//i.test(source)) {
            referenced.add(normalizeImagePath(source));
          }
        }
      }
      const storedImages = await db.images.where("paperId").equals(question.paperId).toArray();
      for (const stored of storedImages) {
        if (!referenced.has(normalizeImagePath(stored.path))) {
          await db.images.delete([question.paperId, stored.path]);
        }
      }
    });
}

export async function getImageBlob(path, paperId) {
  const normalized = normalizeImagePath(path);
  if (!normalized || !paperId) return null;
  const record = await db.images.get([paperId, normalized]);
  return record?.blob || null;
}

function normalizeImagePath(path) {
  return String(path || "").replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
}

export async function importQuestionBank(questions, imageEntries = []) {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error("The upload contains no questions.");
  }

  // All validation should happen in App.jsx before this call. The DB layer repeats
  // critical uniqueness checks to protect integrity if another caller is added later.
  const incomingIds = new Set();
  const incomingQuestionNumbers = new Set();
  for (const q of questions) {
    if (!q?.id || !q?.paperId || !Number.isInteger(q.questionNumber)) {
      throw new Error("Every question needs id, paperId, and integer questionNumber.");
    }
    if (incomingIds.has(q.id)) throw new Error(`Duplicate question id "${q.id}".`);
    incomingIds.add(q.id);
    const composite = `${q.paperId}\u0000${q.questionNumber}`;
    if (incomingQuestionNumbers.has(composite)) {
      throw new Error(`Duplicate questionNumber ${q.questionNumber} in paper "${q.paperId}".`);
    }
    incomingQuestionNumbers.add(composite);
  }

  await db.transaction(
    "rw",
    db.questions,
    db.papers,
    db.images,
    db.categories,
    async () => {
      const existingQuestions = await db.questions.toArray();
      const existingIds = new Set(existingQuestions.map(q => q.id));
      for (const q of questions) {
        if (existingIds.has(q.id)) throw new Error(`Question id "${q.id}" already exists.`);
      }

      const incomingPapers = [...new Set(questions.map(q => q.paperId))];
      for (const paperId of incomingPapers) {
        if (await db.papers.get(paperId)) {
          throw new Error(`Paper "${paperId}" already exists. Delete it before re-importing.`);
        }
        const currentNumbers = new Set(
          existingQuestions.filter(q => q.paperId === paperId).map(q => q.questionNumber)
        );
        for (const q of questions.filter(item => item.paperId === paperId)) {
          if (currentNumbers.has(q.questionNumber)) {
            throw new Error(`Question number ${q.questionNumber} already exists in paper "${paperId}".`);
          }
        }
      }

      // CHANGED: atomic transaction means a failed question/paper/image write rolls back the whole import.
      await db.questions.bulkAdd(questions);
      // Imported questions also populate the reusable subject/topic master list.
      await ensureQuestionCategories(questions);
      const papers = incomingPapers.map(id => {
        const qs = questions.filter(q => q.paperId === id);
        const first = qs[0];
        return {
          id,
          date: first.date || "",
          shift: first.shift || "",
          paperFile: first.paperFile || "",
          questionCount: qs.length,
        };
      });
      await db.papers.bulkAdd(papers);

      // Store image bytes, not temporary object URLs. They survive page reloads.
      for (const item of imageEntries) {
        const path = normalizeImagePath(item.path);
        if (!path || !item.blob) continue;
        // Each archive's image names are scoped to its paper(s), preventing same-name collisions.
        for (const paperId of incomingPapers) {
          const isReferencedByPaper = questions.some((q) =>
            q.paperId === paperId &&
            (
              normalizeImagePath(q.questionImage) === path ||

              (q.questionImages || []).some(
                (imagePath) => normalizeImagePath(imagePath) === path
              ) ||

              (q.options || []).some(
                (option) =>
                  typeof option === "string" &&
                  /\.(png|jpe?g|webp|gif|svg|avif|bmp)(?:[?#].*)?$/i.test(option) &&
                  normalizeImagePath(option) === path
              ) ||

              (q.optionImageSources || []).some(
                (source) =>
                  typeof source === "string" &&
                  !/^https?:\/\//i.test(source) &&
                  normalizeImagePath(source) === path
              )
            )
          );
          if (isReferencedByPaper) {
            await db.images.put({ paperId, path, blob: item.blob, updatedAt: new Date().toISOString() });
          }
        }
      }
    });
}

/**
 * Persist one submitted exam and all its question responses atomically.
 * Idempotent by attempt id: repeated submit/restore effects cannot duplicate it.
 */
export async function saveExamAttempt(attempt, questions) {
  if (!attempt?.id || attempt.status !== "submitted") {
    throw new Error("Only a submitted exam can be saved to analytics.");
  }
  if (!Array.isArray(questions) || !questions.length) {
    throw new Error("The submitted exam has no questions to save.");
  }

  const sectionByQuestion = new Map();
  (attempt.sections || []).forEach((section) => {
    (section.questionIds || []).forEach((questionId) => sectionByQuestion.set(questionId, section.name || "General"));
  });
  const answers = questions.map((question, questionIndex) => {
    const response = attempt.answers?.[question.id] || {};
    const attempted = Number.isInteger(response.answerIndex);
    const correctAtSubmission = attempted && response.answerIndex === question.correctAnswerIndex;
    const marksAwardedAtSubmission = correctAtSubmission
      ? Number(attempt.config?.positiveMarks || 0)
      : attempted
        ? -Number(attempt.config?.negativeMarks || 0)
        : 0;
    return {
      id: `${attempt.id}::${question.id}`,
      attemptId: attempt.id,
      questionId: question.id,
      questionIndex,
      sectionName: sectionByQuestion.get(question.id) || question.subject || "General",
      paperId: attempt.paperId,
      selectedAnswerIndex: attempted ? response.answerIndex : null,
      isAttempted: attempted,
      visited: Boolean(response.visited),
      visitCount: Math.max(0, Number(response.visitCount) || 0),
      marked: Boolean(response.marked),
      timeSpentMs: Math.max(0, Math.floor(Number(response.timeSpentMs) || 0)),
      answerChangeCount: Math.max(0, Number(response.answerChangeCount) || 0),
      answerChanges: Array.isArray(response.answerChanges) ? response.answerChanges : [],
      // Fallback values preserve the submitted result if its question is later deleted.
      correctAtSubmission: attempted ? correctAtSubmission : null,
      marksAwardedAtSubmission,
    };
  });

  const startedAt = Number(attempt.startedAt) || Date.now();
  const submittedAt = Number(attempt.submittedAt) || Date.now();

  const record = {
    id: attempt.id,
    type: "exam",
    source: "pypa",
    paperId: attempt.paperId,
    status: "submitted",
    startedAt,
    submittedAt,
    durationMs: Math.max(0, submittedAt - startedAt),
    totalQuestions: answers.length,
    attemptedAtSubmission: answers.filter((answer) => answer.isAttempted).length,
    correctAtSubmission: answers.filter((answer) => answer.correctAtSubmission === true).length,
    incorrectAtSubmission: answers.filter((answer) => answer.correctAtSubmission === false).length,
    unansweredAtSubmission: answers.filter((answer) => !answer.isAttempted).length,
    scoreAtSubmission: answers.reduce((total, answer) => total + answer.marksAwardedAtSubmission, 0),
    positiveMarks: Number(attempt.config?.positiveMarks || 0),
    negativeMarks: Number(attempt.config?.negativeMarks || 0),
    finishReason: attempt.finishReason || "manual",
    config: {
      sectionNavigation: attempt.config?.sectionNavigation || "free",
      sectionalTiming: Boolean(attempt.config?.sectionalTiming),
      overallDurationSeconds: attempt.config?.overallDurationSeconds ?? null,
      totalDurationSeconds: attempt.config?.totalDurationSeconds ?? null,
      sections: (attempt.sections || []).map((section) => ({
        name: section.name,
        questionIds: [...(section.questionIds || [])],
        durationSeconds: section.durationSeconds ?? null,
      })),
    },
    savedAt: Date.now(),
  };

  return db.transaction("rw", db.testAttempts, db.testAttemptAnswers, async () => {
    const existing = await db.testAttempts.get(record.id);
    if (existing) return { saved: false, existing: true, attempt: existing };
    await db.testAttempts.add(record);
    await db.testAttemptAnswers.bulkAdd(answers);
    return { saved: true, existing: false, attempt: record };
  });
}

export async function getExamAttempts() {
  return db.testAttempts.orderBy("submittedAt").reverse().toArray();
}

export async function getExamAttemptAnswers(attemptId) {
  return db.testAttemptAnswers.where("attemptId").equals(attemptId).toArray();
}

/**
 * Read exam history with current question-bank records attached.
 * Existing question metadata/answer keys are deliberately live; if a question
 * was deleted, the response remains available with question: null and its
 * submission-time score fallback fields.
 */
export async function getExamAnalyticsData({ paperId } = {}) {
  const attempts = paperId
    ? await db.testAttempts.where("paperId").equals(paperId).toArray()
    : await db.testAttempts.orderBy("submittedAt").reverse().toArray();
  if (paperId) attempts.sort((a, b) => b.submittedAt - a.submittedAt);
  if (!attempts.length) return { attempts: [], responses: [] };

  const attemptIds = attempts.map((attempt) => attempt.id);
  const responses = await db.testAttemptAnswers
    .where("attemptId")
    .anyOf(attemptIds)
    .toArray();
  const questionIds = [...new Set(responses.map((response) => response.questionId))];
  const currentQuestions = await db.questions.bulkGet(questionIds);
  const questionById = new Map(
    currentQuestions.filter(Boolean).map((question) => [question.id, question]),
  );

  return {
    attempts,
    responses: responses.map((response) => ({
      ...response,
      question: questionById.get(response.questionId) || null,
    })),
  };
}

export async function deletePaper(paperId) {
  // Attempt history is intentionally retained. Analytics can still show the
  // submitted response and submission-time fallback when its live question is gone.
  await db.transaction("rw", db.questions, db.papers, db.images, async () => {
    await db.questions.where("paperId").equals(paperId).delete();
    await db.papers.delete(paperId);
    // CHANGED: images are paper-scoped, so deleting a paper cannot delete another paper's same-named image.
    await db.images.where("paperId").equals(paperId).delete();
  });
}
