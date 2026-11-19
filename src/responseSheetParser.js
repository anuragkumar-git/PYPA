const RESPONSE_SHEET_IMAGE_ORIGIN = "https://rrb.digialm.com/";
const IMAGE_DATA_URL = /^data:image\/(png|jpe?g|webp|gif|avif|bmp|svg\+xml);base64,/i;
const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|webp|gif|avif|bmp|svg)(?:[?#].*)?$/i;

// Keep formatting from imported question cells, but never retain executable HTML.
const SAFE_QUESTION_TAGS = new Set([
  "br", "strong", "b", "em", "i", "u", "s", "del", "sup", "sub",
  "span", "p", "div", "table", "thead", "tbody", "tfoot", "tr", "td",
  "th", "ul", "ol", "li", "blockquote", "pre", "code",
]);
const DROP_QUESTION_TAGS = new Set([
  "script", "style", "iframe", "object", "embed", "form", "input", "button",
  "textarea", "select", "option", "svg", "math", "video", "audio", "link",
  "meta", "base", "canvas",
]);

export function sanitizeQuestionHtml(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  const parsed = new DOMParser().parseFromString(`<body>${value}</body>`, "text/html");
  const clean = (parent) => {
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType === Node.COMMENT_NODE) {
        node.remove();
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = node.tagName.toLowerCase();
      if (tag === "img" || DROP_QUESTION_TAGS.has(tag)) {
        node.remove();
        continue;
      }
      if (!SAFE_QUESTION_TAGS.has(tag)) {
        node.replaceWith(...Array.from(node.childNodes));
        continue;
      }
      for (const attribute of Array.from(node.attributes)) {
        const name = attribute.name.toLowerCase();
        const allowed = (tag === "td" || tag === "th") &&
          ["colspan", "rowspan", "align"].includes(name);
        if (!allowed) node.removeAttribute(attribute.name);
      }
      clean(node);
    }
  };
  clean(parsed.body);
  return parsed.body.innerHTML;
}

function getCellQuestionHtml(cell) {
  if (!cell) return "";
  const clone = cell.cloneNode(true);
  clone.querySelectorAll("img").forEach((img) => img.remove());
  clone.querySelectorAll("span[style*=\"color:#ffffff\"], span[style*=\"color: #ffffff\"], span[style*=\"color:white\"]")
    .forEach((span) => span.remove());
  return sanitizeQuestionHtml(clone.innerHTML);
}

function cleanText(value) {
  return String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function getLabelValue(text, pattern) {
  const match = text.match(pattern);
  return match?.[1] ? cleanText(match[1]) : "";
}

function parseExamDate(value) {
  const match = String(value || "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : "";
}

function dataUrlToBlob(dataUrl) {
  const match = dataUrl.match(/^data:(image\/[^;,]+);base64,([\s\S]+)$/i);
  if (!match) throw new Error("Unsupported embedded image format.");
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: match[1].toLowerCase() });
}

function extensionForMime(mime) {
  return ({ "image/jpeg": "jpg", "image/svg+xml": "svg" })[mime] ||
    (mime.split("/")[1] || "png").replace("jpeg", "jpg");
}

function parseMarkValue(value) {
  const text = String(value || "").trim();
  if (/\b(no|zero|nil)\s+(?:negative\s+)?(?:marking|marks?)\b/i.test(text)) return 0;
  const match = text.match(/(-?\d+(?:\.\d+)?)\s*(?:\/\s*(\d+(?:\.\d+)?))?/);
  if (!match) return null;
  const numerator = Number(match[1]);
  const denominator = match[2] ? Number(match[2]) : 1;
  return denominator ? numerator / denominator : null;
}

// Digialm exports sometimes contain empty/duplicate <tr> tags before the real row.
// Find the Q-number cell itself instead of assuming the first <tr> is the question row.
function getQuestionCells(questionElement) {
  const table = questionElement.querySelector(".questionRowTbl");
  if (!table) return { questionCell: null, optionRows: [] };

  const cells = Array.from(table.querySelectorAll("td"));
  const numberCellIndex = cells.findIndex((cell) => /^Q\.?\s*\d+$/i.test(cleanText(cell.textContent)));
  const questionCell = numberCellIndex >= 0 ? cells[numberCellIndex + 1] || null : null;
  return {
    questionCell,
    numberCell: numberCellIndex >= 0 ? cells[numberCellIndex] : null,
    optionRows: Array.from(table.querySelectorAll(".rightAns, .wrngAns")),
  };
}

function getCellTextWithoutImages(cell, { removeOptionNumber = false } = {}) {
  if (!cell) return "";
  const clone = cell.cloneNode(true);
  clone.querySelectorAll("img").forEach((img) => img.remove());
  // Some image-only questions contain invisible white text used for layout/OCR indexing.
  clone.querySelectorAll("span[style*='color:#ffffff'], span[style*='color: #ffffff'], span[style*='color:white']")
    .forEach((span) => span.remove());
  let value = cleanText(clone.textContent);
  if (removeOptionNumber) value = value.replace(/^\s*\d+\s*[.)]\s*/, "");
  return value;
}

function getNonMarkerImages(cell) {
  if (!cell) return [];
  return Array.from(cell.querySelectorAll("img")).filter((img) => {
    const src = (img.getAttribute("src") || "").toLowerCase();
    const name = (img.getAttribute("name") || "").toLowerCase();
    return !img.classList.contains("tick") &&
      !/(?:tick|cross)\.png(?:[?#]|$)/.test(src) &&
      !/(?:tick|cross)\.png(?:[?#]|$)/.test(name);
  });
}

// Preserve a remote source URL when the response sheet references a server-side image.
// The double slash after the host is intentional: the saved HTML src starts with '/'.
function resolveImageSource(img, imageOrigin = RESPONSE_SHEET_IMAGE_ORIGIN) {
  const src = String(img?.getAttribute("src") || "").trim();
  if (!src) return "";
  if (IMAGE_DATA_URL.test(src)) return src;
  if (/^https:\/\//i.test(src)) return src;
  if (src.startsWith("//")) return `https:${src}`;
  const origin = String(imageOrigin || RESPONSE_SHEET_IMAGE_ORIGIN).replace(/\/?$/, "/");
  if (src.startsWith("/")) return `${origin}${src}`;
  return `${origin}${src}`;
}

/** Parses the common TCS iON / Digialm response-sheet HTML structure. */
export async function parseTcsIonResponseSheet(htmlText, paperId, imageOrigin = RESPONSE_SHEET_IMAGE_ORIGIN) {
  if (typeof htmlText !== "string" || !htmlText.trim()) {
    throw new Error("The selected HTML response sheet is empty.");
  }

  const doc = new DOMParser().parseFromString(htmlText, "text/html");
  const questionElements = Array.from(doc.querySelectorAll(".question-pnl"));
  if (!questionElements.length) {
    throw new Error("This HTML does not look like a supported TCS iON / Digialm response sheet.");
  }
  if (questionElements.length > 20000) {
    throw new Error("The response sheet contains too many questions to import safely.");
  }

  const infoText = cleanText(doc.querySelector(".main-info-pnl")?.textContent || "");
  const examGroup = getLabelValue(infoText, /Subject\s*\/\s*Exam\s*Group\s*([\s\S]*?)(?:Application Photograph|Exam Day Photograph|\* Note|$)/i);
  const dateText = getLabelValue(infoText, /Test\s*Date\s*(\d{2}\/\d{2}\/\d{4})/i);
  const time = getLabelValue(infoText, /Test\s*Time\s*([\d:]+\s*[AP]M\s*-\s*[\d:]+\s*[AP]M)/i);
  const markSchemeText = infoText.match(/Correct Answer will carry\s*([^.]+)\.\s*Incorrect Answer will carry\s*([^.]+)\./i);
  const positiveMarks = markSchemeText ? parseMarkValue(markSchemeText[1]) : 1;
  const parsedNegativeMarks = markSchemeText ? parseMarkValue(markSchemeText[2]) : 0.25;
  const negativeMarks = parsedNegativeMarks === null ? 0.25 : Math.abs(parsedNegativeMarks);
  const parsedDate = parseExamDate(dateText);

  const imageEntries = [];
  const questionIssues = [];
  const questions = [];

  async function storeImage(img, questionNumber, slot) {
    const src = resolveImageSource(img, imageOrigin);
    if (!src) return { path: null, issue: `${slot} image has no usable source` };

    if (IMAGE_DATA_URL.test(src)) {
      const blob = dataUrlToBlob(src);
      const extension = extensionForMime(blob.type);
      const safePaperId = String(paperId).replace(/[^a-zA-Z0-9_-]+/g, "-");
      const path = `images/${safePaperId}/response-q${questionNumber}-${slot}.${extension}`;
      imageEntries.push({ path, blob });
      return { path, issue: "" };
    }

    // Keep the fully-qualified link in the question record. It remains visible/editable
    // even when the remote host is unavailable later.
    return { path: src, issue: "" };
  }

  for (let index = 0; index < questionElements.length; index++) {
    const element = questionElements[index];
    const { questionCell, numberCell, optionRows } = getQuestionCells(element);
    const numberMatch = cleanText(numberCell?.textContent).match(/Q\.?\s*(\d+)/i);
    const questionNumber = numberMatch ? Number(numberMatch[1]) : index + 1;
    const localIssues = [];

    if (optionRows.length !== 4) localIssues.push(`Expected four options but found ${optionRows.length}`);

    const questionText = getCellTextWithoutImages(questionCell);
    const questionHtml = getCellQuestionHtml(questionCell);
    const questionImages = getNonMarkerImages(questionCell);
    let questionImage = null;
    if (questionImages.length > 1) {
      localIssues.push(`Question contains ${questionImages.length} images; the current PYPA question format supports one question image`);
    } else if (questionImages.length === 1) {
      const stored = await storeImage(questionImages[0], questionNumber, "question");
      questionImage = stored.path;
      if (stored.issue) localIssues.push(stored.issue);
    }

    const options = [];
    const optionImageSources = [];
    for (let optionIndex = 0; optionIndex < 4; optionIndex++) {
      const optionRow = optionRows[optionIndex];
      if (!optionRow) {
        options.push("");
        optionImageSources.push("");
        continue;
      }
      const optionText = getCellTextWithoutImages(optionRow, { removeOptionNumber: true });
      const optionImages = getNonMarkerImages(optionRow);
      if (optionImages.length > 1) {
        localIssues.push(`Option ${optionIndex + 1} contains multiple images; the current PYPA option format supports one image`);
        options.push(optionText);
        optionImageSources.push("");
      } else if (optionImages.length === 1 && !optionText) {
        const stored = await storeImage(optionImages[0], questionNumber, `option-${optionIndex + 1}`);
        options.push(stored.path || "");
        optionImageSources.push("");
        if (stored.issue) localIssues.push(`Option ${optionIndex + 1}: ${stored.issue}`);
      } else if (optionImages.length === 1 && optionText) {
        // Existing schema has one string per option. Keep its text and store the image
        // separately as optional source metadata so the view can display both.
        const stored = await storeImage(optionImages[0], questionNumber, `option-${optionIndex + 1}`);
        options.push(optionText);
        optionImageSources.push(stored.path || "");
        if (stored.issue) localIssues.push(`Option ${optionIndex + 1}: ${stored.issue}`);
      } else {
        options.push(optionText);
        optionImageSources.push("");
      }
    }

    const correctAnswerIndex = optionRows.findIndex((row) => row.classList.contains("rightAns"));
    if (correctAnswerIndex < 0 || correctAnswerIndex > 3) {
      localIssues.push("Official correct answer could not be identified from the green right-answer marker");
    }

    const menuText = cleanText(element.querySelector(".menu-tbl")?.textContent || "");
    const questionId = menuText.match(/Question\s*ID\s*:\s*(\d+)/i)?.[1] || "";
    const chosenOptionMatch = menuText.match(/Chosen\s*Option\s*:\s*(\d+)/i);
    const chosenOptionNumber = chosenOptionMatch ? Number(chosenOptionMatch[1]) : null;
    const originalChosenOptionIndex = Number.isInteger(chosenOptionNumber) && chosenOptionNumber >= 1 && chosenOptionNumber <= 4
      ? chosenOptionNumber - 1
      : null;
    const status = menuText.match(/Status\s*:\s*([\s\S]*?)(?:Chosen\s*Option\s*:|$)/i)?.[1] || "";

    // Image-only prompts still need a non-empty stem in PYPA's current text-first schema.
    const question = questionText || (questionImage ? "Image-based question — inspect the attached image." : "");
    const subject = examGroup || "General";
    const topic = "Mixed topics (section-wide; source has no per-question topic)";

    questions.push({
      id: `${paperId}-Q${String(questionNumber).padStart(3, "0")}`,
      paperId,
      paperFile: "",
      date: parsedDate,
      shift: time,
      questionNumber,
      question,
      questionHtml,
      subject,
      topic,
      options,
      optionImageSources,
      correctAnswerIndex: correctAnswerIndex >= 0 ? correctAnswerIndex : null,
      correctAnswer: correctAnswerIndex >= 0 ? options[correctAnswerIndex] || "" : "",
      questionImage,
      questionImageNotRequired: !questionImage,
      notes: "",
      // A green rightAns marker is the response sheet's official answer key.
      answerValidation: correctAnswerIndex >= 0 ? "source-key-verified" : "source-key-unverified",
      verified: correctAnswerIndex >= 0,
      visualReviewNeeded: localIssues.length > 0,
      practiceReady: localIssues.length === 0 && Boolean(question) && options.length === 4 && options.every(Boolean) && correctAnswerIndex >= 0,
      reviewReasons: localIssues,
      source: {
        provider: "TCS iON / Digialm",
        questionId,
        originalStatus: cleanText(status),
        originalChosenOptionIndex,
      },
    });

    if (localIssues.length) questionIssues.push({ questionNumber, reasons: localIssues });
  }

  const responseAnalytics = questions.reduce((stats, question) => {
    const chosen = question.source?.originalChosenOptionIndex;
    if (!Number.isInteger(chosen) || chosen < 0 || chosen > 3) {
      stats.unattempted += 1;
      return stats;
    }

    stats.attempted += 1;
    if (!Number.isInteger(question.correctAnswerIndex) || question.correctAnswerIndex < 0 || question.correctAnswerIndex > 3) {
      stats.notEvaluable += 1;
    } else if (chosen === question.correctAnswerIndex) {
      stats.correct += 1;
    } else {
      stats.wrong += 1;
    }
    return stats;
  }, { total: questions.length, attempted: 0, correct: 0, wrong: 0, unattempted: 0, notEvaluable: 0 });

  const scoreAvailable = Number.isFinite(positiveMarks) && Number.isFinite(negativeMarks);
  const marksAwarded = scoreAvailable
    ? responseAnalytics.correct * positiveMarks - responseAnalytics.wrong * negativeMarks
    : null;
  const maximumMarks = Number.isFinite(positiveMarks)
    ? questions.length * positiveMarks
    : null;

  return {
    questions,
    imageEntries,
    metadata: {
      examGroup,
      date: parsedDate,
      dateText,
      shift: time,
      positiveMarks: Number.isFinite(positiveMarks) ? positiveMarks : null,
      negativeMarks: Number.isFinite(negativeMarks) ? negativeMarks : null,
      totalQuestions: questions.length,
      responseAnalytics: {
        ...responseAnalytics,
        positiveMarks: Number.isFinite(positiveMarks) ? positiveMarks : null,
        negativeMarks: Number.isFinite(negativeMarks) ? negativeMarks : null,
        marksAwarded,
        maximumMarks,
        scoreAvailable,
        scoreComplete: scoreAvailable && responseAnalytics.notEvaluable === 0,
      },
    },
    questionIssues,
  };
}
