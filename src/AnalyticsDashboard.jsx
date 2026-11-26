import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  Clock3,
  RefreshCw,
  Target,
  Trophy,
} from "lucide-react";
import { getExamAnalyticsData } from "./db";

const formatDuration = (milliseconds) => {
  const seconds = Math.max(0, Math.round((Number(milliseconds) || 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
};
const formatDate = (value) =>
  value
    ? new Date(value).toLocaleString([], {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "—";
const percent = (value, total) =>
  total ? Math.round((value / total) * 100) : 0;
const average = (values) =>
  values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;

function StatCard({ label, value, detail, icon: Icon }) {
  return (
    <article className="analytics-stat-card">
      <div className="analytics-stat-top">
        <span>{label}</span>
        <Icon size={17} />
      </div>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </article>
  );
}

function BarRows({
  rows,
  valueKey,
  maxValue,
  suffix = "",
  emptyText = "No data yet.",
}) {
  if (!rows.length)
    return <p className="analytics-empty-inline">{emptyText}</p>;
  return (
    <div className="analytics-bars">
      {rows.map((row) => {
        const value = Number(row[valueKey]) || 0;
        return (
          <div className="analytics-bar-row" key={row.name}>
            <div className="analytics-bar-label">
              <span title={row.name}>{row.name}</span>
              <b>
                {value.toFixed(value % 1 ? 1 : 0)}
                {suffix}
              </b>
            </div>
            <div className="analytics-bar-track">
              <span
                style={{
                  width: `${maxValue ? Math.max(value > 0 ? 2 : 0, (value / maxValue) * 100) : 0}%`,
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function AnalyticsDashboard({ papers = [], onBack, onRevisit }) {
  const [data, setData] = useState({ attempts: [], responses: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [paperFilter, setPaperFilter] = useState("All");
  const [selectedAttemptId, setSelectedAttemptId] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await getExamAnalyticsData(
        paperFilter === "All" ? {} : { paperId: paperFilter },
      );
      setData(result);
      setSelectedAttemptId((current) =>
        result.attempts.some((item) => item.id === current)
          ? current
          : result.attempts[0]?.id || "",
      );
    } catch (cause) {
      setError(cause?.message || "Could not load exam analytics.");
    } finally {
      setLoading(false);
    }
  }, [paperFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const responseByAttempt = useMemo(() => {
    const map = new Map();
    data.responses.forEach((response) => {
      if (!map.has(response.attemptId)) map.set(response.attemptId, []);
      map.get(response.attemptId).push(response);
    });
    return map;
  }, [data.responses]);

  const enrichedAttempts = useMemo(
    () =>
      data.attempts.map((attempt) => {
        const responses = responseByAttempt.get(attempt.id) || [];
        const evaluated = responses.map((response) => {
          const question = response.question;
          const hasLiveKey = Number.isInteger(question?.correctAnswerIndex);
          const correct = response.isAttempted
            ? hasLiveKey
              ? response.selectedAnswerIndex === question.correctAnswerIndex
              : response.correctAtSubmission
            : false;
          const subject = question?.subject?.trim() || "Uncategorized";
          const topic = question?.topic?.trim() || "Uncategorized";
          const marks = response.isAttempted
            ? correct
              ? Number(attempt.positiveMarks)
              : -Number(attempt.negativeMarks)
            : 0;
          return {
            ...response,
            correct: response.isAttempted ? Boolean(correct) : false,
            subject,
            topic,
            marks,
            hasLiveKey,
          };
        });
        const attempted = evaluated.filter((item) => item.isAttempted).length;
        const correct = evaluated.filter(
          (item) => item.isAttempted && item.correct,
        ).length;
        const incorrect = evaluated.filter(
          (item) => item.isAttempted && !item.correct,
        ).length;
        const unanswered = evaluated.length - attempted;
        const score = evaluated.reduce((sum, item) => sum + item.marks, 0);
        const maximumMarks =
          evaluated.length * Number(attempt.positiveMarks || 0);
        return {
          ...attempt,
          responses: evaluated,
          attempted,
          correct,
          incorrect,
          unanswered,
          score,
          maximumMarks,
          accuracy: percent(correct, attempted),
        };
      }),
    [data.attempts, responseByAttempt],
  );

  const totals = useMemo(() => {
    const all = enrichedAttempts.flatMap((attempt) => attempt.responses);
    const attempted = all.filter((item) => item.isAttempted).length;
    const correct = all.filter(
      (item) => item.isAttempted && item.correct,
    ).length;
    const time = all.reduce(
      (sum, item) => sum + (Number(item.timeSpentMs) || 0),
      0,
    );
    return {
      exams: enrichedAttempts.length,
      questions: all.length,
      attempted,
      correct,
      accuracy: percent(correct, attempted),
      avgExamTime: average(enrichedAttempts.map((item) => item.durationMs)),
      scoreRate: (() => {
        const maximum = enrichedAttempts.reduce(
          (sum, item) => sum + item.maximumMarks,
          0,
        );
        const score = enrichedAttempts.reduce(
          (sum, item) => sum + item.score,
          0,
        );
        return maximum > 0 ? Math.round((score / maximum) * 100) : 0;
      })(),
      totalTime: time,
      avgQuestionTime: average(
        all.map((item) => Number(item.timeSpentMs) || 0),
      ),
    };
  }, [enrichedAttempts]);

  const subjectRows = useMemo(() => {
    const groups = new Map();
    enrichedAttempts.forEach((attempt) =>
      attempt.responses.forEach((response) => {
        const row = groups.get(response.subject) || {
          name: response.subject,
          attempted: 0,
          correct: 0,
          time: 0,
          count: 0,
        };
        row.count += 1;
        row.time += Number(response.timeSpentMs) || 0;
        if (response.isAttempted) {
          row.attempted += 1;
          if (response.correct) row.correct += 1;
        }
        groups.set(response.subject, row);
      }),
    );
    return [...groups.values()]
      .map((row) => ({
        ...row,
        accuracy: percent(row.correct, row.attempted),
        avgTime: row.count ? row.time / row.count : 0,
      }))
      .sort((a, b) => b.count - a.count);
  }, [enrichedAttempts]);

  const topicRows = useMemo(() => {
    const groups = new Map();
    enrichedAttempts.forEach((attempt) =>
      attempt.responses.forEach((response) => {
        const name = `${response.subject} · ${response.topic}`;
        const row = groups.get(name) || {
          name,
          attempted: 0,
          correct: 0,
          time: 0,
          count: 0,
        };
        row.count += 1;
        row.time += Number(response.timeSpentMs) || 0;
        if (response.isAttempted) {
          row.attempted += 1;
          if (response.correct) row.correct += 1;
        }
        groups.set(name, row);
      }),
    );
    return [...groups.values()]
      .map((row) => ({
        ...row,
        accuracy: percent(row.correct, row.attempted),
        avgTime: row.count ? row.time / row.count : 0,
      }))
      .sort((a, b) => a.accuracy - b.accuracy || b.count - a.count)
      .slice(0, 10);
  }, [enrichedAttempts]);

  const selectedAttempt =
    enrichedAttempts.find((attempt) => attempt.id === selectedAttemptId) ||
    null;
  const slowQuestions = useMemo(
    () =>
      selectedAttempt
        ? [...selectedAttempt.responses]
            .sort((a, b) => b.timeSpentMs - a.timeSpentMs)
            .slice(0, 8)
        : [],
    [selectedAttempt],
  );
  const paperNames = [
    ...new Set(
      [
        ...papers.map((paper) => paper.id),
        ...data.attempts.map((attempt) => attempt.paperId),
      ].filter(Boolean),
    ),
  ].sort();

  return (
    <main className="analytics-page">
      <div className="analytics-heading">
        <div>
          <div className="eyebrow analytics-eyebrow">PERFORMANCE OVERVIEW</div>
          <h2>Exam analytics</h2>
          <p>
            Performance is recalculated using the current question bank. Editing
            a question can change historical subject, topic, and correctness
            analysis.
          </p>
        </div>
        <div className="analytics-heading-actions">
          <button className="button outline" onClick={load} disabled={loading}>
            <RefreshCw size={15} /> Refresh
          </button>
          <button className="button primary" onClick={onBack}>
            <ArrowLeft size={15} /> Back to question bank
          </button>
        </div>
      </div>

      <div className="analytics-filter-row">
        <label>
          Paper
          <select
            value={paperFilter}
            onChange={(event) => setPaperFilter(event.target.value)}
          >
            <option value="All">All papers</option>
            {paperNames.map((paper) => (
              <option key={paper} value={paper}>
                {paper}
              </option>
            ))}
          </select>
        </label>
        <span>
          {enrichedAttempts.length} submitted exam
          {enrichedAttempts.length === 1 ? "" : "s"}
        </span>
      </div>

      {error && (
        <div className="analytics-error">
          <AlertTriangle size={17} /> {error}
        </div>
      )}
      {loading ? (
        <div className="panel analytics-loading">Loading exam history…</div>
      ) : !enrichedAttempts.length ? (
        <section className="panel analytics-empty">
          <BarChart3 size={34} />
          <h3>No completed exams yet</h3>
          <p>
            Submit an exam simulation to start building your performance
            history. Practice-question attempts and imported response-sheet
            summaries are intentionally excluded.
          </p>
          <button className="button primary" onClick={onBack}>
            Return to question bank
          </button>
        </section>
      ) : (
        <>
          <section className="analytics-stat-grid">
            <StatCard
              label="Submitted exams"
              value={totals.exams}
              detail="Saved exam attempts"
              icon={Trophy}
            />
            <StatCard
              label="Overall accuracy"
              value={`${totals.accuracy}%`}
              detail={`${totals.correct} correct / ${totals.attempted} attempted`}
              icon={Target}
            />
            <StatCard
              label="Score rate"
              value={`${totals.scoreRate}%`}
              detail="Marks earned / maximum marks"
              icon={Trophy}
            />
            <StatCard
              label="Questions attempted"
              value={`${totals.attempted}/${totals.questions}`}
              detail={`${totals.questions - totals.attempted} unanswered`}
              icon={BarChart3}
            />
            <StatCard
              label="Time in questions"
              value={formatDuration(totals.totalTime)}
              detail={`Avg ${formatDuration(totals.avgQuestionTime)} per question`}
              icon={Clock3}
            />
          </section>

          <section className="analytics-two-column">
            <article className="panel analytics-panel">
              <div className="analytics-section-heading">
                <div>
                  <h3>Subject performance</h3>
                  <p>Accuracy based on attempted questions</p>
                </div>
              </div>
              {subjectRows.length ? (
                <div className="analytics-subject-list">
                  {subjectRows.map((row) => (
                    <div className="analytics-subject-row" key={row.name}>
                      <div className="analytics-subject-meta">
                        <b>{row.name}</b>
                        <span>
                          {row.correct}/{row.attempted} correct ·{" "}
                          {formatDuration(row.avgTime)} avg/question
                        </span>
                      </div>
                      <div className="analytics-subject-score">
                        <strong>{row.accuracy}%</strong>
                        <div className="analytics-bar-track">
                          <span style={{ width: `${row.accuracy}%` }} />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="analytics-empty-inline">
                  No subject metadata available.
                </p>
              )}
            </article>
            <article className="panel analytics-panel">
              <div className="analytics-section-heading">
                <div>
                  <h3>Topics needing attention</h3>
                  <p>Lowest accuracy first; requires current topic labels</p>
                </div>
              </div>
              <BarRows
                rows={topicRows.filter((row) => row.attempted > 0)}
                valueKey="accuracy"
                maxValue={100}
                suffix="%"
                emptyText="Topic-level analysis appears when questions have topic labels."
              />
            </article>
          </section>

          <section className="panel analytics-panel">
            <div className="analytics-section-heading">
              <div>
                <h3>Exam history</h3>
                <p>
                  Select an exam to inspect its question-level timing and
                  responses.
                </p>
              </div>
            </div>
            <div className="analytics-history-table-wrap">
              <table className="analytics-history-table">
                <thead>
                  <tr>
                    <th>Submitted</th>
                    <th>Paper</th>
                    <th>Score</th>
                    <th>Accuracy</th>
                    <th>Attempted</th>
                    <th>Duration</th>
                    <th>Finish</th>
                    <th>Review</th>
                  </tr>
                </thead>
                <tbody>
                  {enrichedAttempts.map((attempt) => {
                    const uniqueQuestionIds = new Set(
                      attempt.responses.map((response) => response.questionId),
                    );
                    const canRevisit =
                      attempt.responses.length === attempt.totalQuestions &&
                      uniqueQuestionIds.size === attempt.totalQuestions &&
                      attempt.responses.every((response) =>
                        Boolean(response.question),
                      );
                    return (
                      <tr
                        key={attempt.id}
                        className={
                          selectedAttemptId === attempt.id ? "selected" : ""
                        }
                        onClick={() => setSelectedAttemptId(attempt.id)}
                        tabIndex={0}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ")
                            setSelectedAttemptId(attempt.id);
                        }}
                      >
                        <td>{formatDate(attempt.submittedAt)}</td>
                        <td>{attempt.paperId}</td>
                        <td>
                          {attempt.score.toFixed(2)} /{" "}
                          {attempt.maximumMarks.toFixed(2)}
                        </td>
                        <td>{attempt.accuracy}%</td>
                        <td>
                          {attempt.attempted}/{attempt.totalQuestions}
                        </td>
                        <td>{formatDuration(attempt.durationMs)}</td>
                        <td>
                          {String(attempt.finishReason || "manual").replaceAll(
                            "-",
                            " ",
                          )}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="button outline analytics-review-button"
                            disabled={!canRevisit}
                            title={
                              canRevisit
                                ? "Revisit this submitted exam"
                                : "Some questions from this exam are no longer available"
                            }
                            onClick={(event) => {
                              event.stopPropagation();
                              if (canRevisit) onRevisit?.(attempt);
                            }}
                          >
                            Revisit
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {selectedAttempt && (
            <section className="analytics-two-column analytics-detail-grid">
              <article className="panel analytics-panel">
                <div className="analytics-section-heading">
                  <div>
                    <h3>Question time analysis</h3>
                    <p>
                      {selectedAttempt.paperId} ·{" "}
                      {formatDate(selectedAttempt.submittedAt)}
                    </p>
                  </div>
                </div>
                <div className="analytics-timing-summary">
                  <div>
                    <small>Total exam time</small>
                    <b>{formatDuration(selectedAttempt.durationMs)}</b>
                  </div>
                  <div>
                    <small>Tracked question time</small>
                    <b>
                      {formatDuration(
                        selectedAttempt.responses.reduce(
                          (sum, item) => sum + item.timeSpentMs,
                          0,
                        ),
                      )}
                    </b>
                  </div>
                </div>
                <div className="analytics-question-list">
                  {slowQuestions.map((response, index) => (
                    <div className="analytics-question-row" key={response.id}>
                      <span className="analytics-rank">{index + 1}</span>
                      <div className="analytics-question-copy">
                        <b>
                          Q
                          {response.question?.questionNumber ??
                            response.questionId}
                        </b>
                        <small>
                          {response.subject} · {response.topic} ·{" "}
                          {response.visitCount} visit
                          {response.visitCount === 1 ? "" : "s"}
                        </small>
                      </div>
                      <div className="analytics-question-metrics">
                        <b>{formatDuration(response.timeSpentMs)}</b>
                        <small>
                          {response.answerChangeCount} answer change
                          {response.answerChangeCount === 1 ? "" : "s"}
                        </small>
                      </div>
                    </div>
                  ))}
                </div>
              </article>
              <article className="panel analytics-panel">
                <div className="analytics-section-heading">
                  <div>
                    <h3>Selected exam breakdown</h3>
                    <p>
                      Live answer-key evaluation where the question still exists
                    </p>
                  </div>
                </div>
                <div className="analytics-result-grid">
                  <div>
                    <small>Correct</small>
                    <b>{selectedAttempt.correct}</b>
                  </div>
                  <div>
                    <small>Incorrect</small>
                    <b>{selectedAttempt.incorrect}</b>
                  </div>
                  <div>
                    <small>Unanswered</small>
                    <b>{selectedAttempt.unanswered}</b>
                  </div>
                  <div>
                    <small>Marked for review</small>
                    <b>
                      {
                        selectedAttempt.responses.filter((item) => item.marked)
                          .length
                      }
                    </b>
                  </div>
                </div>
                <div className="analytics-question-list analytics-response-list">
                  {selectedAttempt.responses.map((response) => (
                    <div className="analytics-question-row" key={response.id}>
                      <span
                        className={`analytics-answer-dot ${response.isAttempted ? (response.correct ? "correct" : "incorrect") : "unanswered"}`}
                      />
                      <div className="analytics-question-copy">
                        <b>
                          Q
                          {response.question?.questionNumber ??
                            response.questionId}
                        </b>
                        <small>
                          {response.subject} · {response.topic}
                        </small>
                      </div>
                      <div className="analytics-question-metrics">
                        <b>
                          {response.isAttempted
                            ? response.correct
                              ? "Correct"
                              : "Incorrect"
                            : "Unanswered"}
                        </b>
                        <small>{formatDuration(response.timeSpentMs)}</small>
                      </div>
                    </div>
                  ))}
                </div>
                {selectedAttempt.responses.some((item) => !item.question) && (
                  <p className="analytics-note">
                    Some questions were deleted from the question bank. Their
                    original response and submission-time scoring fallback
                    remain available, but live topic analysis is unavailable.
                  </p>
                )}
              </article>
            </section>
          )}
        </>
      )}
    </main>
  );
}
