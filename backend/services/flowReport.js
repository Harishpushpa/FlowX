// server/services/flowReport.js
//
// Turns an ALREADY-EXECUTED FlowRun (see models/FlowRun.js) into a
// shareable report. Deliberately does NOT re-run anything through
// mavenRunner.js/flowCodegen.js — those regenerate Java and re-hit the
// live API, which has real side effects (re-login, re-create a student,
// etc). A "generate report" click on a past run should be idempotent and
// safe to click twice, so this reads step results straight off the
// FlowRun document that was already saved.
//
// Two output shapes, same input:
//   - buildJUnitXml()  -> drops straight into Jenkins/GitHub Actions/GitLab
//                         as a native test-results tab (see also the
//                         "report genaration" discussion re: Newman/Bruno
//                         parity — this is the piece you were missing).
//   - buildReportHtml() -> a standalone, emailable/downloadable page, for
//                         when nobody's touching a CI system at all.

function escapeXml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapeHtml(str) {
  return escapeXml(str);
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Builds a JUnit-XML testsuite from one FlowRun. Each step becomes one
 * <testcase>; a failed/errored step gets a <failure> child so CI systems
 * render it exactly like a failed unit test, with the same message they'd
 * show for a RestAssured/TestNG failure.
 */
export function buildJUnitXml(flowRun) {
  const steps = flowRun.steps || [];
  const executedSteps = steps.filter((s) => !s.skipped);
  const failures = executedSteps.filter((s) => !s.success).length;
  const suiteName = flowRun.flowName || "Flow";
  const timestamp = new Date(flowRun.createdAt || Date.now()).toISOString();

  const testcases = steps
    .map((s) => {
      const name = `${s.name || s.stepId} (${s.method} ${s.path})`;
      const timeSec = ((s.durationMs || 0) / 1000).toFixed(3);
      const failureBlock = s.skipped
        ? `\n      <skipped message="${escapeXml(s.skipReason || "Step not applicable to this row")}"/>`
        : s.success
          ? ""
          : `\n      <failure message=${JSON.stringify(
            s.error || `Unexpected status ${s.status}`
          )}>${escapeXml(
            `Request:\n${safeJson(s.requestSent)}\n\nResponse:\n${safeJson(s.responseBody)}`
          )}</failure>`;
      // AI-graded steps get a system-out block either way — the verdict
      // and per-check breakdown are useful context even on a pass, and on
      // a fail they show up alongside (not instead of) the request/
      // response already in <failure>.
      const aiBlock = s.aiGrade
        ? `\n      <system-out>${escapeXml(
            `AI grading (${s.aiGrade.verdictSource}): ${s.aiGrade.reason}\n${safeJson(s.aiGrade.checkResults)}`
          )}</system-out>`
        : "";
      return `    <testcase name="${escapeXml(name)}" classname="${escapeXml(
        suiteName
      )}" time="${timeSec}">${failureBlock}${aiBlock}\n    </testcase>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="${escapeXml(suiteName)}" tests="${steps.length}" failures="${failures}" errors="0" timestamp="${timestamp}">
${testcases}
</testsuite>
`;
}

/**
 * Truncates a huge JSON dump for display — a response like a 100-entry
 * academic-years list is real data worth having, but printing all of it
 * inline makes every step report unreadable. Keeps the shape visible
 * (first N chars) and says how much was cut, rather than silently
 * dropping data or forcing the reader to scroll past pages of it.
 */
const MAX_JSON_CHARS = 2400;
function safeJsonTruncated(value) {
  const full = safeJson(value);
  if (full.length <= MAX_JSON_CHARS) return full;
  return `${full.slice(0, MAX_JSON_CHARS)}\n… truncated (${full.length - MAX_JSON_CHARS} more characters — see the raw run data for the full response)`;
}

/**
 * Bulk/data-driven runs (Excel batch, or a Flow run across CSV rows)
 * prefix each step's name with "[Row N: k=v, ...]" (see
 * excelBatchGrader.js's toBatchReportShape() and aiTestGrader.js's
 * toFlowRunShape()) — that's the only place row membership is recorded
 * once steps have been flattened into one array. Parsed back out here so
 * the report can group steps by row instead of showing one long flat
 * list, which is what made a 3-row/2-step run read as "5 mystery steps"
 * with no visual indication that rows 1 and 2 each contributed 2 and row
 * 3 only contributed 1.
 */
const ROW_PREFIX_RE = /^\[(?:[Rr]ow) (\d+)(?::\s*([^\]]*))?\]\s*/;
function splitStepsByRow(steps) {
  const groups = [];
  let current = null;
  for (const s of steps) {
    const m = ROW_PREFIX_RE.exec(s.name || "");
    if (m) {
      const rowNum = m[1];
      const rowInput = m[2] || "";
      const cleanStep = { ...s, name: s.name.slice(m[0].length) };
      if (!current || current.rowNum !== rowNum) {
        current = { rowNum, rowInput, steps: [] };
        groups.push(current);
      }
      current.steps.push(cleanStep);
    } else {
      if (!current || current.rowNum !== null) {
        current = { rowNum: null, rowInput: "", steps: [] };
        groups.push(current);
      }
      current.steps.push(s);
    }
  }
  // Only worth grouping visually if more than one row was actually found —
  // a single-flow run (no row prefixes at all) renders as one ungrouped
  // section, same as before.
  const isGrouped = groups.some((g) => g.rowNum !== null) && groups.length > 1;
  return { groups, isGrouped };
}

/**
 * Renders a dependency-free SVG donut chart for passed/failed/skipped
 * counts. No chart library needed — this is a self-contained HTML file
 * (emailed/downloaded standalone), so anything that needs a <script>
 * tag pulled from a CDN would silently break offline/email viewing.
 * Pure SVG with stroke-dasharray segments works everywhere a plain
 * <img> would.
 */
function buildSummaryChartSvg(passed, failed, skipped) {
  const total = passed + failed + skipped;
  if (!total) return "";

  const size = 160;
  const strokeWidth = 22;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const center = size / 2;

  const segments = [
    { value: passed, color: "#16e37b", label: "Passed" },
    { value: failed, color: "#ff6b6b", label: "Failed" },
    { value: skipped, color: "#8891a8", label: "Skipped" },
  ].filter((s) => s.value > 0);

  let offset = 0;
  const circles = segments
    .map((s) => {
      const fraction = s.value / total;
      const dash = fraction * circumference;
      const gap = circumference - dash;
      const circle = `<circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="${s.color}" stroke-width="${strokeWidth}" stroke-dasharray="${dash.toFixed(
        2
      )} ${gap.toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${center} ${center})" />`;
      offset += dash;
      return circle;
    })
    .join("\n      ");

  const passRate = Math.round((passed / total) * 100);
  const legend = segments
    .map(
      (s) =>
        `<div class="chart-legend-item"><span class="chart-swatch" style="background:${s.color}"></span>${escapeHtml(
          s.label
        )} <strong>${s.value}</strong></div>`
    )
    .join("\n        ");

  return `
  <section class="chart-section">
    <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Pass/fail breakdown">
      ${circles}
      <circle cx="${center}" cy="${center}" r="${radius - strokeWidth / 2 - 3}" fill="#0b0d13" />
      <text x="${center}" y="${center - 4}" text-anchor="middle" fill="#f5f7fc" font-size="22" font-weight="700" font-family="-apple-system,Segoe UI,Roboto,sans-serif">${passRate}%</text>
      <text x="${center}" y="${center + 14}" text-anchor="middle" fill="#8891a8" font-size="10" font-family="-apple-system,Segoe UI,Roboto,sans-serif">pass rate</text>
    </svg>
    <div class="chart-legend">
      ${legend}
    </div>
  </section>`;
}

/**
 * Renders one horizontal bar per row/branch (a "Row 1", "Row 2", …
 * group from splitStepsByRow) so a multi-row/data-driven run shows at a
 * glance which specific row has a problem, instead of having to open
 * every row's collapsible section to find the failing one. Each bar is
 * a clickable link straight to that row's detail section below — click
 * a red bar, land on the row that needs attention.
 */
function buildRowBreakdownChartSvg(groups) {
  const rowGroups = groups.filter((g) => g.rowNum !== null);
  if (rowGroups.length < 2) return "";

  const barHeight = 22;
  const gap = 10;
  const width = 640;
  const labelWidth = 90;
  const trackWidth = width - labelWidth - 70;
  const height = rowGroups.length * (barHeight + gap) + gap;

  const bars = rowGroups
    .map((g, idx) => {
      const executed = g.steps.filter((s) => !s.skipped);
      const passedN = executed.filter((s) => s.success).length;
      const failedN = executed.filter((s) => !s.success).length;
      const skippedN = g.steps.filter((s) => s.skipped).length;
      const total = passedN + failedN + skippedN || 1;
      const y = gap + idx * (barHeight + gap);

      const segments = [
        { value: passedN, color: "#16e37b" },
        { value: failedN, color: "#ff6b6b" },
        { value: skippedN, color: "#8891a8" },
      ];
      let x = labelWidth;
      const rects = segments
        .map((s) => {
          if (!s.value) return "";
          const w = (s.value / total) * trackWidth;
          const rect = `<rect x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(
            1
          )}" height="${barHeight}" fill="${s.color}" />`;
          x += w;
          return rect;
        })
        .join("");

      const rowCls = failedN > 0 ? "fail" : "pass";
      const summary = `${passedN}/${executed.length} passed${failedN ? ` · ${failedN} failed` : ""}${
        skippedN ? ` · ${skippedN} skipped` : ""
      }`;

      return `
      <a href="#row-${escapeXml(g.rowNum)}" class="row-bar-link" aria-label="Jump to Row ${escapeXml(g.rowNum)}">
        <text x="0" y="${y + barHeight / 2 + 4}" class="row-bar-label ${rowCls}">Row ${escapeXml(g.rowNum)}</text>
        <rect x="${labelWidth}" y="${y}" width="${trackWidth}" height="${barHeight}" rx="4" fill="#1c2030" />
        ${rects}
        <text x="${labelWidth + trackWidth + 8}" y="${y + barHeight / 2 + 4}" class="row-bar-summary">${escapeXml(
          summary
        )}</text>
      </a>`;
    })
    .join("\n");

  return `
  <section class="row-chart-section">
    <h2>Rows at a glance</h2>
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="Pass/fail by row">
      ${bars}
    </svg>
  </section>`;
}

function buildAiAnalysisHtml(aiAnalysis) {
  if (!aiAnalysis) return "";
  if (aiAnalysis.error) {
    return `<section class="ai-analysis"><h2>🤖 AI analysis</h2><p class="error">${escapeHtml(aiAnalysis.error)}</p></section>`;
  }
  const list = (items, label) =>
    items && items.length
      ? `<h4>${escapeHtml(label)}</h4><ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`
      : "";
  return `
  <section class="ai-analysis">
    <h2>🤖 AI analysis</h2>
    ${aiAnalysis.summary ? `<p class="summary-text">${escapeHtml(aiAnalysis.summary)}</p>` : ""}
    <div class="ai-analysis-grid">
      <div>${list(aiAnalysis.findings, "Findings")}</div>
      <div>${list(aiAnalysis.failurePatterns, "Failure patterns")}</div>
      <div>${list(aiAnalysis.recommendations, "Recommendations")}</div>
    </div>
  </section>`;
}

/** Renders one step as a collapsible card. Open by default on failure,
 * collapsed by default on pass — a report you can actually scan, instead
 * of every request/response dumped open regardless of whether it needs a
 * second look. */
function buildStepHtml(s, i) {
  const cls = s.skipped ? "skip" : (s.success ? "pass" : "fail");
  const statusBadge = typeof s.status === "number" ? `<span class="pill status-pill">${s.status}</span>` : "";
  const timeBadge = typeof s.durationMs === "number" ? `<span class="pill time-pill">${s.durationMs}ms</span>` : "";
  const methodBadge = s.method ? `<span class="pill method-pill">${escapeHtml(s.method)}</span>` : "";

  return `
      <details class="step ${cls}" ${s.success && !s.skipped ? "" : "open"}>
        <summary>
          <span class="step-outcome">${s.skipped ? "↷" : (s.success ? "✓" : "✕")}</span>
          <span class="step-name">${i + 1}. ${escapeHtml(s.name)}</span>
          ${methodBadge}<code class="step-path">${escapeHtml(s.path || "")}</code>${statusBadge}${timeBadge}
        </summary>
        <div class="step-body">
          ${s.skipped ? `<p class="skip-text">${escapeHtml(s.skipReason || "Step not applicable to this row")}</p>` : ""}
          ${s.error ? `<p class="error">${escapeHtml(s.error)}</p>` : ""}
          ${
            s.aiGrade
              ? `<div class="ai-grade-line"><strong>AI grading (${escapeHtml(s.aiGrade.verdictSource)})</strong> — ${
                  s.aiGrade.passed ? '<span class="pass-text">PASS</span>' : '<span class="fail-text">FAIL</span>'
                }<br/>${escapeHtml(s.aiGrade.reason || "")}</div>
          ${
            s.aiGrade.excelExpected || s.aiGrade.aiGenerated
              ? `<div class="expected-compare">
              ${
                s.aiGrade.excelExpected && (s.aiGrade.excelExpected.status || s.aiGrade.excelExpected.notes)
                  ? `<div><strong>From sheet:</strong> ${
                      s.aiGrade.excelExpected.status ? `status ${escapeHtml(s.aiGrade.excelExpected.status)}` : ""
                    }${s.aiGrade.excelExpected.notes ? ` — ${escapeHtml(s.aiGrade.excelExpected.notes)}` : ""}</div>`
                  : `<div><strong>From sheet:</strong> not specified</div>`
              }
              ${
                s.aiGrade.aiGenerated
                  ? `<div><strong>AI generated:</strong> status ${escapeHtml(s.aiGrade.aiGenerated.expectedStatus)}${
                      s.aiGrade.aiGenerated.checks?.length ? ` · ${s.aiGrade.aiGenerated.checks.length} check(s)` : ""
                    }</div>`
                  : `<div><strong>AI generated:</strong> n/a — sheet already gave a complete test</div>`
              }
              <div><strong>Actual:</strong> status ${typeof s.status === "number" ? escapeHtml(s.status) : "—"}</div>
              ${s.aiGrade.expectedStatus != null ? `<div><strong>Status check:</strong> ${typeof s.status === "number" && s.status === s.aiGrade.expectedStatus ? "matched" : "FAILED — expected " + escapeHtml(s.aiGrade.expectedStatus)}</div>` : ""}
            </div>`
              : ""
          }`
              : ""
          }
          ${
            s.extracted && Object.keys(s.extracted).length
              ? `<details class="sub"><summary>Captured for later steps</summary><pre>${escapeHtml(safeJsonTruncated(s.extracted))}</pre></details>`
              : ""
          }
          <details class="sub"><summary>Request</summary><pre>${escapeHtml(safeJsonTruncated(s.requestSent))}</pre></details>
          <details class="sub"><summary>Response</summary><pre>${escapeHtml(safeJsonTruncated(s.responseBody))}</pre></details>
          ${
            s.aiGrade?.checkResults?.length
              ? `<details class="sub"><summary>AI check results</summary><pre>${escapeHtml(safeJsonTruncated(s.aiGrade.checkResults))}</pre></details>`
              : ""
          }
        </div>
      </details>`;
}

export function buildReportHtml(flowRun) {
  const steps = flowRun.steps || [];
  const executedSteps = steps.filter((s) => !s.skipped);
  const passed = executedSteps.filter((s) => s.success).length;
  const failed = executedSteps.filter((s) => !s.success).length;
  const skipped = steps.filter((s) => s.skipped).length;
  const passRate = executedSteps.length ? Math.round((passed / executedSteps.length) * 100) : 0;
  const overallClass = flowRun.overallSuccess ? "pass" : "fail";

  const { groups, isGrouped } = splitStepsByRow(steps);

  const body = isGrouped
    ? groups
        .map((g) => {
          const rowExecuted = g.steps.filter((s) => !s.skipped);
          const rowPassed = rowExecuted.filter((s) => s.success).length;
          const rowSkipped = g.steps.filter((s) => s.skipped).length;
          const rowCls = rowExecuted.length && rowPassed === rowExecuted.length ? "pass" : "fail";
          return `
      <details id="row-${escapeHtml(g.rowNum)}" class="row-group ${rowCls}" ${rowCls === "fail" ? "open" : ""}>
        <summary>
          <span class="step-outcome">${rowCls === "pass" ? "✓" : "✕"}</span>
          <span class="row-title">Row ${g.rowNum}</span>
          <span class="pill">${rowPassed}/${rowExecuted.length} steps passed${rowSkipped ? ` · ${rowSkipped} skipped` : ""}</span>
          ${g.rowInput ? `<code class="row-input">${escapeHtml(g.rowInput)}</code>` : ""}
        </summary>
        <div class="row-body">${g.steps.map((s, i) => buildStepHtml(s, i)).join("\n")}</div>
      </details>`;
        })
        .join("\n")
    : steps.map((s, i) => buildStepHtml(s, i)).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>${escapeHtml(flowRun.flowName || "Flow")} — run report</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { background:#0b0d13; color:#f5f7fc; font-family:-apple-system,Segoe UI,Roboto,sans-serif; margin:0; padding:2rem; max-width:960px; margin-inline:auto; }
  h1 { font-size:1.4rem; margin:0 0 .3rem; }
  .meta { color:#8891a8; font-size:.85rem; margin-bottom:1.5rem; }

  .dashboard-row { display:flex; gap:1.2rem; align-items:stretch; flex-wrap:wrap; margin-bottom:.5rem; }
  .dashboard { display:flex; gap:.9rem; flex-wrap:wrap; flex:1; min-width:260px; }
  .stat-card { flex:1; min-width:120px; border:1px solid #232838; border-radius:10px; padding:.9rem 1rem; background:#12151d; }
  .stat-card .num { font-size:1.6rem; font-weight:700; line-height:1.1; }
  .stat-card .label { font-size:.72rem; text-transform:uppercase; letter-spacing:.06em; color:#8891a8; margin-top:.2rem; }
  .stat-card.pass .num { color:#16e37b; }
  .stat-card.fail .num { color:#ff6b6b; }
  .stat-card.rate .num { color:#a5a6ff; }
  .progress-bar { height:8px; border-radius:999px; background:#232838; overflow:hidden; margin-bottom:1.6rem; }
  .progress-fill { height:100%; background:linear-gradient(90deg,#16e37b,#6d6ef8); }

  .chart-section { display:flex; align-items:center; gap:1rem; border:1px solid #232838; border-radius:10px; padding:.9rem 1.1rem; background:#12151d; }
  .chart-legend { display:flex; flex-direction:column; gap:.4rem; }
  .chart-legend-item { display:flex; align-items:center; gap:.5rem; font-size:.82rem; color:#c9d1d9; }
  .chart-legend-item strong { color:#f5f7fc; }
  .chart-swatch { width:.7rem; height:.7rem; border-radius:3px; display:inline-block; }
  @media (max-width:700px) { .chart-section { width:100%; justify-content:center; } }

  .row-chart-section { border:1px solid #232838; border-radius:10px; padding:1rem 1.2rem; margin-bottom:1.6rem; background:#12151d; }
  .row-chart-section h2 { font-size:.95rem; margin:0 0 .8rem; color:#c9d1d9; }
  .row-bar-link { cursor:pointer; }
  .row-bar-link:hover rect:first-of-type { stroke:#6d6ef8; stroke-width:1.5; }
  .row-bar-label { font-size:11px; font-family:-apple-system,Segoe UI,Roboto,sans-serif; fill:#c9d1d9; }
  .row-bar-label.fail { fill:#ff6b6b; font-weight:700; }
  .row-bar-label.pass { fill:#16e37b; }
  .row-bar-summary { font-size:11px; font-family:-apple-system,Segoe UI,Roboto,sans-serif; fill:#8891a8; }

  section.ai-analysis { border:1px solid #6d6ef8; border-radius:10px; padding:1.1rem 1.3rem; margin-bottom:1.6rem; background:#151726; }
  section.ai-analysis h2 { font-size:1rem; margin:0 0 .6rem; color:#a5a6ff; }
  section.ai-analysis h4 { font-size:.72rem; text-transform:uppercase; letter-spacing:.06em; color:#8891a8; margin:.5rem 0 .3rem; }
  section.ai-analysis ul { margin:0; padding-left:1.1rem; }
  section.ai-analysis li { margin-bottom:.3rem; font-size:.83rem; }
  .ai-analysis-grid { display:grid; grid-template-columns:repeat(3, 1fr); gap:1rem; }
  @media (max-width:700px) { .ai-analysis-grid { grid-template-columns:1fr; } }
  .summary-text { font-size:.92rem; color:#f5f7fc; margin:0 0 .8rem; }

  details.row-group { border:1px solid #2f3548; border-radius:10px; margin-bottom:1rem; background:#0f1119; overflow:hidden; }
  details.row-group > summary { list-style:none; cursor:pointer; padding:.8rem 1rem; display:flex; align-items:center; gap:.6rem; font-weight:600; }
  details.row-group.fail { box-shadow: inset 3px 0 0 #ff3b3b; }
  details.row-group.pass { box-shadow: inset 3px 0 0 #16e37b; }
  .row-title { font-size:.95rem; }
  .row-input { color:#8891a8; font-size:.78rem; }
  .row-body { padding:0 1rem 1rem; }

  details.step { border:1px solid #232838; border-radius:9px; margin-bottom:.7rem; background:#12151d; }
  details.step > summary { list-style:none; cursor:pointer; padding:.7rem .9rem; display:flex; align-items:center; gap:.5rem; flex-wrap:wrap; }
  details.step.fail { box-shadow: inset 3px 0 0 #ff3b3b; }
  details.step.pass { box-shadow: inset 3px 0 0 #16e37b; }
  details.step.skip { box-shadow: inset 3px 0 0 #8891a8; }
  .skip-text { color:#8891a8; font-weight:600; margin:.2rem 0; }
  .step-outcome { font-weight:700; }
  .step-name { font-size:.88rem; font-weight:600; }
  .step-path { color:#c9d1d9; font-size:.78rem; }
  .step-body { padding:0 .9rem .9rem; }
  summary::-webkit-details-marker { display:none; }
  summary { position:relative; padding-left:1.4rem !important; }
  summary::before { content:"▸"; position:absolute; left:.2rem; color:#8891a8; }
  details[open] > summary::before { content:"▾"; }

  .pill { display:inline-block; padding:.12rem .55rem; border-radius:999px; font-size:.72rem; font-weight:600; background:#1c2030; color:#c9d1d9; }
  .status-pill { background:#1c2030; }
  .method-pill { background:#232838; color:#a5a6ff; }
  .time-pill { color:#8891a8; }

  details.sub { margin-top:.6rem; }
  details.sub > summary { font-size:.72rem; text-transform:uppercase; letter-spacing:.06em; color:#8891a8; padding:.2rem 0 .2rem 1.2rem !important; }
  pre { background:#0b0d13; border:1px solid #232838; border-radius:7px; padding:.75rem; overflow-x:auto; font-size:.76rem; color:#c9d1d9; margin:.4rem 0 0; }
  .error { color:#ff6b6b; font-weight:600; margin:.2rem 0; }
  .pass-text { color:#16e37b; }
  .fail-text { color:#ff6b6b; }
  .ai-grade-line { font-size:.85rem; margin-bottom:.4rem; }
  .expected-compare { display:grid; gap:.3rem; font-size:.8rem; color:#c9d1d9; background:#0b0d13; border:1px solid #232838; border-radius:7px; padding:.55rem .75rem; margin:.5rem 0; }
  .expected-compare strong { color:#8891a8; font-weight:600; }

  @media print { details { open: true; } summary::before { display:none; } }
</style>
</head>
<body>
  <h1>${escapeHtml(flowRun.flowName || "Flow")}</h1>
  <div class="meta">
    ${new Date(flowRun.createdAt || Date.now()).toLocaleString()} · run by ${escapeHtml(flowRun.ranBy || "unknown")}${flowRun.batchLabel ? ` · batch "${escapeHtml(flowRun.batchLabel)}"${typeof flowRun.rowIndex === "number" ? ` row ${flowRun.rowIndex + 1}` : ""}` : ""}
  </div>

  <div class="dashboard-row">
    <div class="dashboard">
      <div class="stat-card"><div class="num">${steps.length}</div><div class="label">Total steps</div></div>
      <div class="stat-card pass"><div class="num">${passed}</div><div class="label">Passed</div></div>
      <div class="stat-card fail"><div class="num">${failed}</div><div class="label">Failed</div></div>
      <div class="stat-card"><div class="num">${skipped}</div><div class="label">Skipped</div></div>
      <div class="stat-card rate"><div class="num">${passRate}%</div><div class="label">Pass rate</div></div>
    </div>
    ${buildSummaryChartSvg(passed, failed, skipped)}
  </div>
  <div class="progress-bar"><div class="progress-fill" style="width:${passRate}%"></div></div>

  ${isGrouped ? buildRowBreakdownChartSvg(groups) : ""}
  ${buildAiAnalysisHtml(flowRun.aiAnalysis)}
  ${body}
</body>
</html>
`;
}