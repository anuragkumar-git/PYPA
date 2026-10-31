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
        for (const option of item.options || []) {
          if (typeof option === "string" && /\.(png|jpe?g|webp|gif|svg|avif|bmp)$/i.test(option)) {
            referenced.add(normalizeImagePath(option));
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
          const isReferencedByPaper = questions.some(q =>
            q.paperId === paperId &&
            (normalizeImagePath(q.questionImage) === path ||
              (q.options || []).some(option =>
                typeof option === "string" &&
                /\.(png|jpe?g|webp|gif|svg|avif|bmp)$/i.test(option) &&
                normalizeImagePath(option) === path
              ))
          );
          if (isReferencedByPaper) {
            await db.images.put({ paperId, path, blob: item.blob, updatedAt: new Date().toISOString() });
          }
        }
      }
    });
}

export async function deletePaper(paperId) {
  await db.transaction("rw", db.questions, db.papers, db.images, async () => {
    await db.questions.where("paperId").equals(paperId).delete();
    await db.papers.delete(paperId);
    // CHANGED: images are paper-scoped, so deleting a paper cannot delete another paper's same-named image.
    await db.images.where("paperId").equals(paperId).delete();
  });
}
