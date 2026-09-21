import { useCallback, useEffect, useState } from "react";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { apiFetch, apiFetchJson } from "../api";
import { useWorkspace } from "../context/WorkspaceContext";

async function downloadRunReport(runId, flowName) {
  const res = await apiFetch(
    `/api/flows/runs/${runId}/report.html`
  );

  if (!res.ok) {
    throw new Error("Report not found for this run.");
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = `${(flowName || "flow")
    .replace(/\s+/g, "-")
    .toLowerCase()}-report.html`;

  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function DownloadReportButton({ runId, flowName }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleDownload() {
    if (!runId || busy) return;

    setBusy(true);
    setError("");

    try {
      await downloadRunReport(runId, flowName);
    } catch (err) {
      setError(err.message || "Could not download report.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="flow-report-buttons">
      <button
        type="button"
        onClick={handleDownload}
        disabled={busy}
      >
        {busy ? "Downloading…" : "Download report"}
      </button>

      {error && (
        <span className="status error">{error}</span>
      )}
    </span>
  );
}

/**
 * Excel cells cap out at 32,767 characters — a large response body would
 * silently get rejected by SheetJS otherwise. Mirrors the HTML report's
 * own truncation (flowReport.js's safeJsonTruncated) so both outputs
 * agree on "how much is too much to dump inline."
 */
const MAX_CELL_CHARS = 30000;
function cellJson(value) {
  if (value === undefined || value === null) return "";
  let text;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  if (text.length <= MAX_CELL_CHARS) return text;
  return `${text.slice(0, MAX_CELL_CHARS)}\n… truncated (${text.length - MAX_CELL_CHARS} more characters)`;
}

/** One-line, human-readable version of a value for the "quick scan"
 * columns — flattened onto a single line and cut well short of the
 * full-detail columns, so a tester can tell what happened by glancing
 * across a row instead of opening a cell. */
const PREVIEW_CHARS = 180;
function cellPreview(value) {
  if (value === undefined || value === null) return "";
  let text;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length <= PREVIEW_CHARS ? text : `${text.slice(0, PREVIEW_CHARS)}…`;
}

/** Builds the one combined, plain-English reason for a step's outcome —
 * whichever of skip/error/AI-reason actually applies — so there's a
 * single column to read instead of checking three separate ones that
 * are usually empty. */
function stepReason(s) {
  if (s.skipped) return s.skipReason || "Step not applicable to this row";
  if (s.error) return s.error;
  if (s.aiGrade && !s.aiGrade.passed && s.aiGrade.reason) return s.aiGrade.reason;
  if (s.aiGrade?.reason) return s.aiGrade.reason;
  return "";
}

function statusMatch(s) {
  const expected = s.aiGrade?.expectedStatus ?? s.aiGrade?.excelExpected?.status ?? null;
  if (expected == null || typeof s.status !== "number") return "";
  return Number(expected) === s.status ? "Match" : `Mismatch (expected ${expected})`;
}

const STEP_DETAIL_HEADER = [
  "#",
  "Name",
  "Method",
  "Path",
  "Result",
  "Status",
  "Expected Status",
  "Status Check",
  "Duration (ms)",
  "Reason",
  "AI Verdict",
  "Response Preview",
  "AI Check Results",
  "Captured Values",
  "Request Sent (Full)",
  "Response Body (Full)",
];

/** Turns one step into a full-detail row. The first columns are built
 * for scanning at a glance (Result, Status Check, Reason, Response
 * Preview) — a tester can tell what happened without opening anything.
 * The last columns keep the complete raw data for whoever needs to dig
 * into a specific failure. */
function stepDetailRow(s, i) {
  const resultLabel = s.skipped ? "SKIPPED" : s.success ? "PASS" : "FAIL";
  const resultMark = s.skipped ? "⏭" : s.success ? "✓" : "✕";
  return {
    "#": i + 1,
    Name: s.name || s.stepId || "",
    Method: s.method || "",
    Path: s.path || "",
    Result: `${resultMark} ${resultLabel}`,
    Status: typeof s.status === "number" ? s.status : "",
    "Expected Status": s.aiGrade?.expectedStatus ?? s.aiGrade?.excelExpected?.status ?? "",
    "Status Check": statusMatch(s),
    "Duration (ms)": typeof s.durationMs === "number" ? s.durationMs : "",
    Reason: stepReason(s),
    "AI Verdict": s.aiGrade ? (s.aiGrade.passed ? "PASS" : "FAIL") : "",
    "Response Preview": cellPreview(s.responseBody),
    "AI Check Results": cellJson(s.aiGrade?.checkResults),
    "Captured Values": cellJson(s.extracted),
    "Request Sent (Full)": cellJson(s.requestSent),
    "Response Body (Full)": cellJson(s.responseBody),
  };
}

/** Sets sensible column widths (based on header + a sample of content)
 * and turns on Excel's row-1 filter dropdowns, so the sheet is usable
 * the moment it's opened — sort/filter by Result, search a column,
 * widen nothing by hand. */
function finishSheet(sheet, header, rows) {
  sheet["!cols"] = header.map((key) => {
    const sample = rows.slice(0, 200).reduce((max, row) => {
      const len = row[key] != null ? String(row[key]).length : 0;
      return Math.max(max, len);
    }, key.length);
    return { wch: Math.min(Math.max(sample, 10), 60) };
  });
  if (rows.length) {
    sheet["!autofilter"] = {
      ref: XLSX.utils.encode_range(
        { r: 0, c: 0 },
        { r: rows.length, c: header.length - 1 }
      ),
    };
  }
  return sheet;
}

function sheetFromRows(rows, header) {
  return finishSheet(XLSX.utils.json_to_sheet(rows, { header }), header, rows);
}

/**
 * Flattens one FlowRun's steps into an .xlsx workbook — a "Summary"
 * sheet with the pass/fail/skip counts (so a non-technical reader can
 * see the headline numbers without opening the HTML report), and a
 * "Steps" sheet with the full detail per step (request, response,
 * captured values, AI grading) — everything the HTML report shows when
 * a step card is expanded, just laid out as columns instead of
 * collapsible sections, with the readable summary columns first so
 * nothing needs opening to be understood at a glance. Built entirely
 * client-side with the XLSX lib already used for the input-template
 * download above — no server round trip needed since the run's steps
 * are already in memory here.
 */
function buildRunWorkbook(run, flowName) {
  const steps = Array.isArray(run.steps) ? run.steps : [];
  const executed = steps.filter((s) => !s.skipped);
  const passed = executed.filter((s) => s.success).length;
  const failed = executed.filter((s) => !s.success).length;
  const skipped = steps.filter((s) => s.skipped).length;
  const passRate = executed.length ? Math.round((passed / executed.length) * 100) : 0;

  const summaryRows = [
    { Metric: "Flow", Value: flowName || run.flowName || "" },
    { Metric: "Run date", Value: run.createdAt ? new Date(run.createdAt).toLocaleString() : "" },
    { Metric: "Ran by", Value: run.ranBy || run.createdBy || "" },
    { Metric: "Total steps", Value: steps.length },
    { Metric: "Passed", Value: passed },
    { Metric: "Failed", Value: failed },
    { Metric: "Skipped", Value: skipped },
    { Metric: "Pass rate", Value: `${passRate}%` },
  ];

  const stepRows = steps.map((s, i) => stepDetailRow(s, i));

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    sheetFromRows(summaryRows, ["Metric", "Value"]),
    "Summary"
  );
  XLSX.utils.book_append_sheet(
    workbook,
    sheetFromRows(stepRows, STEP_DETAIL_HEADER),
    "Steps"
  );
  return workbook;
}

function DownloadExcelButton({ run, flowName }) {
  function handleDownload() {
    const workbook = buildRunWorkbook(run, flowName);
    const safeName = (flowName || run.flowName || "flow")
      .replace(/\s+/g, "-")
      .toLowerCase();
    XLSX.writeFile(workbook, `${safeName}-report.xlsx`);
  }

  return (
    <button type="button" onClick={handleDownload}>
      Download Excel
    </button>
  );
}

function StepResult({ step }) {
  const [open, setOpen] = useState(Boolean(step?.skipped || !step?.success));

  const skipped = Boolean(step?.skipped);
  const passed = !skipped && Boolean(step?.success);
  const outcomeClass = skipped ? "skip" : passed ? "pass" : "fail";
  const outcome = skipped ? "↷" : passed ? "✓" : "✕";

  return (
    <li className={`flow-step-result ${outcomeClass}`}>
      <button
        type="button"
        className="flow-step-result-toggle"
        onClick={() => setOpen((value) => !value)}
      >
        {outcome} {step?.name || step?.stepId || "Step"} — {step?.method || ""} {step?.path || ""}
        {typeof step?.status === "number" && ` · ${step.status}`}
        {typeof step?.durationMs === "number" && ` · ${step.durationMs}ms`}
        {skipped && " · skipped"}
      </button>

      {open && (
        <div className="flow-step-result-detail">
          {skipped && (
            <p className="status flow-step-skip-message">
              {step.skipReason || "This endpoint was not applicable to this test-data row."}
            </p>
          )}

          {step.error && (
            <p className="status error">{step.error}</p>
          )}

          {step.aiGrade && (
            <div className="flow-step-ai-grade">
              <strong>
                🤖 AI result: {step.aiGrade.passed ? "PASS" : "FAIL"}
              </strong>

              {step.aiGrade.scenario && (
                <p>
                  <strong>Scenario:</strong> {String(step.aiGrade.scenario)}
                </p>
              )}

              {step.aiGrade.expectedStatus != null && (
                <p>
                  <strong>Expected status:</strong> {step.aiGrade.expectedStatus}
                  {typeof step.aiGrade.actualStatus === "number" && (
                    <> · <strong>Actual:</strong> {step.aiGrade.actualStatus}</>
                  )}
                </p>
              )}

              {step.aiGrade.reason && (
                <p>{step.aiGrade.reason}</p>
              )}
            </div>
          )}

          {Object.keys(step.extracted || {}).length > 0 && (
            <>
              <strong>Captured values</strong>
              <pre>{JSON.stringify(step.extracted, null, 2)}</pre>
            </>
          )}

          {step.requestSent && (
            <>
              <strong>Request / Input</strong>
              <pre>{JSON.stringify(step.requestSent, null, 2)}</pre>
            </>
          )}

          {step.responseBody !== undefined && step.responseBody !== null && (
            <>
              <strong>Response / Output</strong>
              <pre>{JSON.stringify(step.responseBody, null, 2)}</pre>
            </>
          )}

          {step.aiGrade?.checkResults?.length > 0 && (
            <>
              <strong>AI checks</strong>
              <pre>{JSON.stringify(step.aiGrade.checkResults, null, 2)}</pre>
            </>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Same idea as buildRunWorkbook, but for a bulk/global run's combined
 * result: one row per step across every input row, each tagged with
 * which input row it came from, that row's overall pass/fail, and the
 * test scenario for that row — all in the single "Steps" sheet so
 * there's one flat, filterable table instead of needing to cross-
 * reference a separate per-row sheet.
 */
function buildBulkWorkbook(result, flowName) {
  const rows = Array.isArray(result.results) ? result.results : [];

  const summaryRows = [
    { Metric: "Flow", Value: flowName || "" },
    { Metric: "Total rows", Value: Number(result.total || rows.length || 0) },
    { Metric: "Passed", Value: Number(result.passed || 0) },
    { Metric: "Failed", Value: Number(result.failed || 0) },
    { Metric: "Skipped", Value: Number(result.skipped || 0) },
  ];

  const stepRows = rows.flatMap((row, rIndex) => {
    const rowSteps = Array.isArray(row.steps) ? row.steps : [];
    return rowSteps.map((s, i) => ({
      Row: row.testId || rIndex + 1,
      "Row Result": row.overallSuccess ? "✓ PASS" : "✕ FAIL",
      "Test Scenario": cellJson(row.testScenario),
      ...stepDetailRow(s, i),
    }));
  });

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    sheetFromRows(summaryRows, ["Metric", "Value"]),
    "Summary"
  );
  XLSX.utils.book_append_sheet(
    workbook,
    sheetFromRows(stepRows, ["Row", "Row Result", "Test Scenario", ...STEP_DETAIL_HEADER]),
    "Steps"
  );
  return workbook;
}

function DownloadBulkExcelButton({ result, flowName }) {
  function handleDownload() {
    const workbook = buildBulkWorkbook(result, flowName);
    const safeName = (flowName || "flow").replace(/\s+/g, "-").toLowerCase();
    XLSX.writeFile(workbook, `${safeName}-batch-report.xlsx`);
  }

  return (
    <button type="button" onClick={handleDownload}>
      Download Excel
    </button>
  );
}

function BulkResultSummary({ result, flowName }) {
  if (!result) return null;

  const passed = Number(result.passed || 0);
  const failed = Number(result.failed || 0);
  const total = Number(result.total || result.results?.length || 0);
  const skipped = Number(result.skipped || 0);
  const analysis = result.aiAnalysis;

  return (
    <div className="flow-bulk-summary-wrap">
      <div className="flow-bulk-summary">
        <span className="stat-pass">{passed} passed</span>
        <span className="flow-bulk-summary-separator">·</span>
        <span className="stat-fail">{failed} failed</span>
        {skipped > 0 && (
          <>
            <span className="flow-bulk-summary-separator">·</span>
            <span className="flow-bulk-summary-skip">{skipped} skipped</span>
          </>
        )}
        {total > 0 && (
          <>
            <span className="flow-bulk-summary-separator">·</span>
            <span>{total} row(s)</span>
          </>
        )}
      </div>

      {Array.isArray(result.results) && result.results.length > 0 && (
        <div className="flow-report-buttons">
          <DownloadBulkExcelButton result={result} flowName={flowName} />
        </div>
      )}

      {analysis?.error && (
        <p className="status error">{analysis.error}</p>
      )}

      {analysis && !analysis.error && (
        <div className="flow-bulk-ai-summary">
          {analysis.summary && (
            <p className="summary-text">{analysis.summary}</p>
          )}

          {Array.isArray(analysis.failurePatterns) && analysis.failurePatterns.length > 0 && (
            <>
              <strong>Failure patterns</strong>
              <ul>
                {analysis.failurePatterns.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            </>
          )}

          {result.batchRunId && (
            <a
              href={`/api/flows/runs/${result.batchRunId}/report.html`}
              target="_blank"
              rel="noreferrer"
            >
              Full execution report
            </a>
          )}
        </div>
      )}

      {Array.isArray(result.results) && result.results.length > 0 && (
        <div className="flow-bulk-tree">
          {result.results.map((row, index) => {
            const rowPassed = Boolean(row.overallSuccess);
            const rowSteps = Array.isArray(row.steps) ? row.steps : [];
            const rowFailed = rowSteps.filter((step) => !step.skipped && !step.success).length;
            const rowSkipped = rowSteps.filter((step) => step.skipped).length;

            return (
              <details
                key={row.runId || `${row.testId}-${index}`}
                className={`flow-bulk-tree-row ${rowPassed ? "pass" : "fail"}`}
                open={!rowPassed}
              >
                <summary>
                  <span>{rowPassed ? "✓" : "✕"}</span>
                  <strong>Test {row.testId || index + 1}</strong>
                  <span>{rowPassed ? "PASS" : "FAIL"}</span>
                  <span className="flow-bulk-tree-meta">
                    {rowSteps.filter((step) => !step.skipped && step.success).length}/{rowSteps.filter((step) => !step.skipped).length} passed
                    {rowFailed ? ` · ${rowFailed} failed` : ""}
                    {rowSkipped ? ` · ${rowSkipped} skipped` : ""}
                  </span>
                </summary>

                <div className="flow-bulk-tree-children">
                  {row.testScenario && (
                    <div className="flow-bulk-scenario">
                      <strong>Scenario</strong>
                      <pre>{JSON.stringify(row.testScenario, null, 2)}</pre>
                    </div>
                  )}

                  {rowSteps.map((step) => (
                    <StepResult
                      key={`${row.runId || index}-${step.stepId || step.name}`}
                      step={step}
                    />
                  ))}
                </div>
              </details>
            );
          })}
        </div>
      )}
    </div>
  );
}

function downloadTemplate(inputVariables, format) {
  const row = {};

  for (const variable of inputVariables) {
    row[variable] = /pass|secret|token/i.test(variable)
      ? ""
      : `example-${variable}`;
  }

  if (format === "xlsx") {
    const sheet = XLSX.utils.json_to_sheet([row], {
      header: inputVariables,
    });

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Flow input");
    XLSX.writeFile(workbook, "flow-input-template.xlsx");
    return;
  }

  const csv = [
    inputVariables.join(","),
    inputVariables.map((key) => row[key]).join(","),
  ].join("\n") + "\n";

  const blob = new Blob([csv], {
    type: "text/csv;charset=utf-8;",
  });

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = "flow-input-template.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export default function FlowRunHistory({ runRequest = null }) {
  const {
    project,
    selectedFlow: flow,
    globalTestData,
  } = useWorkspace();

  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [runningMode, setRunningMode] = useState(null);
  const [formValues, setFormValues] = useState({});
  const [error, setError] = useState("");
  const [expandedRunId, setExpandedRunId] = useState(null);
  const [lastResult, setLastResult] = useState(null);

  const [bulkRows, setBulkRows] = useState(null);
  const [bulkFileName, setBulkFileName] = useState("");
  const [bulkError, setBulkError] = useState("");

  const load = useCallback(async () => {
    if (!flow?._id) {
      setRuns([]);
      return;
    }

    setLoading(true);

    try {
      const res = await apiFetch(
        `/api/flows/${flow._id}/runs`
      );

      if (!res.ok) {
        throw new Error("Could not load run history.");
      }

      const data = await res.json();
      setRuns(Array.isArray(data) ? data : []);
    } catch (err) {
      setRuns([]);
      setError(err.message || "Could not load run history.");
    } finally {
      setLoading(false);
    }
  }, [flow?._id]);

  useEffect(() => {
    setRuns([]);
    setFormValues({});
    setLastResult(null);
    setExpandedRunId(null);
    setBulkRows(null);
    setBulkFileName("");
    setBulkError("");
    setError("");
    load();
  }, [flow?._id, project, load]);

  function setField(name, value) {
    setFormValues((previous) => ({
      ...previous,
      [name]: value,
    }));
  }

  function validateRows(rows, source) {
    if (!Array.isArray(rows) || rows.length === 0) {
      setBulkRows(null);
      setBulkError(`${source} has no data rows.`);
      return;
    }

    const columns = Object.keys(rows[0] || {});
    const normalized = new Map();
    const duplicates = [];
    for (const column of columns) {
      const key = String(column).trim().toLowerCase();
      if (normalized.has(key)) duplicates.push(column);
      normalized.set(key, true);
    }
    if (duplicates.length) {
      setBulkRows(null);
      setBulkError(`Duplicate column name(s): ${duplicates.join(", ")}. Rename the columns before uploading.`);
      return;
    }
    if (!columns.some((name) => String(name).trim().toLowerCase() === "test_id")) {
      setBulkRows(null);
      setBulkError("Test Data Excel must contain a unique test_id column.");
      return;
    }
    const ids = rows.map((row) => String(row.test_id ?? "").trim());
    if (ids.some((id) => !id)) {
      setBulkRows(null);
      setBulkError("Every Test Data row must contain a test_id.");
      return;
    }
    // Repeated test_id values are valid for data-driven testing. One test
    // scenario can intentionally have many input rows. Keep the ID as the
    // correlation key; do not reject the batch just because it repeats.
    setBulkRows(rows);
    setBulkError("");
  }

  function handleFileUpload(event) {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) return;

    setBulkFileName(file.name);
    setBulkError("");

    if (/\.xlsx?$/i.test(file.name)) {
      const reader = new FileReader();

      reader.onload = (loadEvent) => {
        try {
          const workbook = XLSX.read(
            loadEvent.target.result,
            { type: "array" }
          );

          const sheetName = workbook.SheetNames[0];
          if (!sheetName) {
            throw new Error("Excel file has no sheet.");
          }

          const sheet = workbook.Sheets[sheetName];
          const rows = XLSX.utils.sheet_to_json(sheet, {
            defval: "",
            raw: false,
          });

          validateRows(rows, "Your Excel file");
        } catch (err) {
          setBulkRows(null);
          setBulkError(err.message || "Could not read Excel file.");
        }
      };

      reader.onerror = () => {
        setBulkRows(null);
        setBulkError("Could not read that file.");
      };

      reader.readAsArrayBuffer(file);
      return;
    }

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (parsed) => {
        if (parsed.errors?.length) {
          setBulkRows(null);
          setBulkError(parsed.errors[0].message);
          return;
        }

        validateRows(parsed.data, "Your CSV file");
      },
      error: (err) => {
        setBulkRows(null);
        setBulkError(err.message || "Could not read CSV file.");
      },
    });
  }

  // mode is "ai" or "normal" — which of the two Run buttons was clicked.
  // "ai" keeps the existing behavior (step-level AI grading, scenario-based
  // data-driven grading against a Test Scenario Excel). "normal" just runs
  // the flow's endpoints for each data row and grades against each step's
  // own fixed expected status — no AI calls at all.
  async function handleRun(mode) {
    if (!flow?._id || running) return;

    const aiEnabled = mode === "ai";
    const selectedRows = bulkRows?.length ? bulkRows : globalTestData?.rows || [];
    if (aiEnabled && selectedRows.length > 20 && !window.confirm(
      `This AI run will test ${selectedRows.length} rows and may make several billed AI requests. Continue?`
    )) {
      return;
    }

    setRunning(true);
    setRunningMode(mode);
    setError("");
    setLastResult(null);

    try {
      const hasTypedValues = Object.values(formValues).some(
        (value) => value !== undefined && String(value).trim() !== ""
      );

      let data;

      if (!hasTypedValues && bulkRows?.length) {
        data = await apiFetchJson(
          `/api/flows/${flow._id}/run-bulk`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ rows: bulkRows, aiEnabled }),
          }
        );
      } else if (!hasTypedValues && globalTestData?.rows?.length) {
        data = await apiFetchJson(
          `/api/flows/${flow._id}/run-bulk`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              rows: globalTestData.rows,
              scenarios: aiEnabled ? globalTestData.scenarios || [] : [],
              aiEnabled,
            }),
          }
        );
      } else {
        data = await apiFetchJson(
          `/api/flows/${flow._id}/run`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ context: formValues, aiEnabled }),
          }
        );
      }

      setLastResult(data);
      window.dispatchEvent(new Event("flow-run-completed"));

      if (data?._id && !Array.isArray(data.results)) {
        setExpandedRunId(data._id);
      }

      await load();
    } catch (err) {
      setError(err.message || "Failed to run flow.");
    } finally {
      setRunning(false);
      setRunningMode(null);
    }
  }

  function reuseRun(run) {
    const next = {};

    for (const key of flow?.inputVariables || []) {
      const value = run.initialContext?.[key];
      next[key] = value === "[redacted]" ? "" : value ?? "";
    }

    setFormValues(next);
    window.scrollTo?.({ top: 0, behavior: "smooth" });
  }

  function clearUploadedRows() {
    setBulkRows(null);
    setBulkFileName("");
    setBulkError("");
  }

  // The "Normal Run" / "AI Run" buttons in the flow header ask for a run by
  // passing a fresh { mode, nonce }. Ignore stale requests (e.g. when this
  // panel remounts for another flow) so nothing runs by itself.
  useEffect(() => {
    if (!runRequest || Date.now() - runRequest.nonce > 3000) return;
    handleRun(runRequest.mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runRequest]);

  if (!flow) return null;

  const inputVariables = flow.inputVariables || [];
  const hasGlobalRows = Boolean(globalTestData?.rows?.length);
  const hasUploadedRows = Boolean(bulkRows?.length);

  return (
    <div className="flow-run-history">
      <h4>Run — {flow.name}</h4>

      {hasGlobalRows && (
        <p className="status">
          <strong>{globalTestData.fileName || "Test data"}</strong> is uploaded for this project ({globalTestData.rows.length} row(s)).
          Each row is matched to the endpoint that can consume its populated inputs. <strong>AI Run</strong> grades each
          row's scenario against that endpoint's actual request and response; <strong>Normal Run</strong> just executes
          each row against the endpoint and checks it against the step's own expected status — no AI involved.
        </p>
      )}

      {inputVariables.length > 0 && (
        <div className="flow-run-form">
          <p className="status">
            Enter values for a single run. Leave them empty to use the project's uploaded test data.
          </p>

          {inputVariables.map((variable) => (
            <label key={variable}>
              {variable}
              <input
                type={/pass|secret|token/i.test(variable) ? "password" : "text"}
                value={formValues[variable] || ""}
                onChange={(event) => setField(variable, event.target.value)}
              />
            </label>
          ))}
        </div>
      )}

      <div className="flow-run-buttons">
        <button
          type="button"
          onClick={() => handleRun("normal")}
          disabled={running}
          title="Execute the flow and check its configured status rules. This does not use AI."
        >
          {running && runningMode === "normal" ? "Running…" : "Normal Run"}
        </button>
        <button
          type="button"
          className="ghost-btn"
          onClick={() => handleRun("ai")}
          disabled={running}
          title="Use AI to infer or judge test expectations. Large batches ask for confirmation first."
        >
          {running && runningMode === "ai" ? "Running (AI)…" : "AI Run"}
        </button>
      </div>
      <p className="run-guidance">Normal Run is the default for reliable day-to-day testing. AI Run is optional and confirms large batches.</p>

      {error && <p className="status error">{error}</p>}

      {lastResult && Array.isArray(lastResult.results) && (
        <BulkResultSummary result={lastResult} flowName={flow?.name} />
      )}

      {lastResult && !Array.isArray(lastResult.results) && (
        <>
          <div className={`flow-run-summary ${lastResult.overallSuccess ? "pass" : "fail"}`}>
            {lastResult.overallSuccess
              ? "All steps passed"
              : "Flow stopped early — see below"}
          </div>

          {Array.isArray(lastResult.steps) && (
            <ul className="flow-step-result-list">
              {lastResult.steps.map((step) => (
                <StepResult key={step.stepId} step={step} />
              ))}
            </ul>
          )}
        </>
      )}

      {inputVariables.length > 0 && (
        <details className="flow-bulk-run wb-disclosure" open={hasUploadedRows || undefined}>
          <summary>Run from a file (optional)</summary>

          <p className="status">
            Upload a CSV or Excel file with one row per run, then use <strong>Normal Run</strong> above.
            Row-level AI scenarios aren't part of this upload.
          </p>

          <div className="flow-bulk-upload-row">
            <button
              type="button"
              className="wb-btn wb-btn--sm"
              onClick={() => downloadTemplate(inputVariables, "xlsx")}
            >
              Excel template
            </button>

            <button
              type="button"
              className="wb-btn wb-btn--sm"
              onClick={() => downloadTemplate(inputVariables, "csv")}
            >
              CSV template
            </button>

            <input
              type="file"
              accept=".csv,.xlsx,.xls"
              onChange={handleFileUpload}
            />

            {bulkFileName && (
              <span className="status">{bulkFileName}</span>
            )}
          </div>

          {bulkError && (
            <p className="status error">{bulkError}</p>
          )}

          {hasUploadedRows && !bulkError && (
            <div className="flow-bulk-loaded">
              <span>{bulkRows.length} row(s) ready to run.</span>
              <button type="button" className="wb-btn wb-btn--sm" onClick={clearUploadedRows} disabled={running}>
                Clear
              </button>
            </div>
          )}
        </details>
      )}

      <h4>Past runs</h4>

      {loading && <p className="status">Loading…</p>}

      {!loading && runs.length === 0 && (
        <p className="status">No runs yet.</p>
      )}

      <ul className="flow-run-list">
        {runs.map((run, index) => (
          <li
            key={run._id}
            className={expandedRunId === run._id ? "active" : ""}
          >
            <div className="flow-run-row">
              <span className={run.overallSuccess ? "stat-pass" : "stat-fail"}>
                {run.overallSuccess ? "Passed" : "Failed"}
              </span>

              <span>
                {run.createdAt
                  ? ` · ${new Date(run.createdAt).toLocaleString()}`
                  : ""}
              </span>

              <span>
                {` · by ${run.ranBy || run.createdBy || "Unknown"}`}
              </span>

              {index === 0 && (
                <span className="flow-run-latest-tag"> · Latest</span>
              )}

              {run.batchLabel && (
                <span className="flow-run-batch-tag"> · {run.batchLabel}</span>
              )}

              {run.isBatchSummary && (
                <span className="flow-run-batch-tag"> · All rows</span>
              )}

              <div className="flow-run-actions">
                <button
                  type="button"
                  onClick={() =>
                    setExpandedRunId((previous) =>
                      previous === run._id ? null : run._id
                    )
                  }
                >
                  {expandedRunId === run._id ? "Hide" : "View"}
                </button>

                <DownloadReportButton
                  runId={run._id}
                  flowName={flow.name}
                />

                <DownloadExcelButton
                  run={run}
                  flowName={flow.name}
                />

                <button
                  type="button"
                  onClick={() => reuseRun(run)}
                >
                  Reuse
                </button>
              </div>
            </div>

            {expandedRunId === run._id && Array.isArray(run.steps) && (
              <ul className="flow-step-result-list">
                {run.steps.map((step) => (
                  <StepResult key={step.stepId} step={step} />
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
