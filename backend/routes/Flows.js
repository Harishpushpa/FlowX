// server/routes/flows.js

import express from "express";
import mongoose from "mongoose";
import Flow from "../models/Flow.js";
import FlowRun from "../models/FlowRun.js";
import { runFlow, getStepTemplateVars } from "../services/flowEngine.js";
import { ensureAiGradedSteps } from "../services/aiTestGrader.js";
import { classifyScenarioColumn, analyzeBatchRun } from "../services/llm.js";
import { buildJUnitXml, buildReportHtml } from "../services/flowReport.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { runWithCapacity } from "../services/executionQueue.js";

const router = express.Router();

const MAX_BULK_ROWS = Math.max(1, Number.parseInt(process.env.MAX_BULK_ROWS || "100", 10) || 100);
// Anything that looks like a secret gets redacted before we write it to
// FlowRun history. FlowRunHistory.jsx already expects exactly the string
// "[redacted]" back (see reuseRun()).
const SECRET_NAME_RE = /pass|secret|token|otp|pwd|apikey/i;
const REDACTED = "[redacted]";
const parsedStoredValueLimit = Number.parseInt(process.env.MAX_STORED_RESULT_CHARS || "50000", 10);
const MAX_STORED_RESULT_CHARS = Number.isFinite(parsedStoredValueLimit) && parsedStoredValueLimit > 0
  ? parsedStoredValueLimit
  : 50000;

/**
 * Resolves any not-yet-inferred aiGraded steps on this flow and persists
 * them if inference actually happened, so the (slow, billed) AI call runs
 * once per step rather than once per run — and, critically, once per
 * FLOW, not once per ROW of a bulk run, since this is called before the
 * row loop in run-bulk, not inside it. Returns the flow to actually run
 * with (steps replaced if changed).
 */
async function resolveAiGradedSteps(flow) {
  const { steps, changed } = await ensureAiGradedSteps(flow);
  if (!changed) return flow;
  await Flow.findByIdAndUpdate(flow._id, { steps });
  return { ...flow, steps };
}

function maskContextForStorage(context) {
  const out = {};
  for (const [k, v] of Object.entries(context || {})) {
    out[k] = SECRET_NAME_RE.test(k) ? REDACTED : maskValueForStorage(v, k);
  }
  return out;
}

function maskValueForStorage(value, key = "") {
  if (SECRET_NAME_RE.test(String(key))) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => maskValueForStorage(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([nestedKey, nestedValue]) => [
      nestedKey,
      maskValueForStorage(nestedValue, nestedKey),
    ]));
  }
  return value;
}

function compactStoredValue(value) {
  if (value === undefined || value === null) return value;
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = String(value);
  }
  if (typeof serialized !== "string") serialized = String(value);
  if (serialized.length <= MAX_STORED_RESULT_CHARS) return value;
  return {
    truncated: true,
    preview: serialized.slice(0, MAX_STORED_RESULT_CHARS),
    originalCharacters: serialized.length,
  };
}

function prepareStepsForStorage(steps) {
  return (steps || []).map((step) => ({
    ...step,
    requestSent: step.requestSent
      ? {
          ...step.requestSent,
          headers: maskContextForStorage(step.requestSent.headers),
          body: compactStoredValue(maskValueForStorage(step.requestSent.body)),
        }
      : step.requestSent,
    responseBody: compactStoredValue(maskValueForStorage(step.responseBody)),
    extracted: maskContextForStorage(step.extracted),
    aiGrade: step.aiGrade ? maskValueForStorage(step.aiGrade) : step.aiGrade,
  }));
}

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}
router.get("/runs/:runId/report.html", asyncHandler(async (req, res) => {
  const run = await FlowRun.findById(req.params.runId);
  if (!run) return res.status(404).json({ error: "Run not found" });
  // The report is generated and saved on the run itself the moment the
  // run finishes (see /:id/run and /:id/run-bulk below) — this is just a
  // download of that saved copy. Runs saved before reportHtml existed
  // fall back to building it on the fly so old history still works.
  res.type("html").send(run.reportHtml || buildReportHtml(run));
}));

router.get("/runs/:runId/report.junit.xml", asyncHandler(async (req, res) => {
  const run = await FlowRun.findById(req.params.runId);
  if (!run) return res.status(404).json({ error: "Run not found" });
  res.type("application/xml").send(buildJUnitXml(run));
}));
// ---------------------------------------------------------------------
// Flow CRUD
// ---------------------------------------------------------------------

// GET /api/flows?project=X&collection=Y
// collection is optional. Pass a collection's _id to get only flows in
// that collection, or the literal string "none" to get only uncategorized
// flows. Omit it entirely to get every flow for the project (unchanged
// behavior — FlowBuilder.jsx's sidebar fetches everything once and groups
// client-side rather than re-fetching per collection).
router.get("/", asyncHandler(async (req, res) => {
  const { project, collectionId } = req.query;
  if (!project) return res.status(400).json({ error: "project query param is required" });

  const filter = { project };
  if (collectionId === "none") {
    filter.collectionId = null;
  } else if (collectionId) {
    if (!isValidId(collectionId)) return res.status(400).json({ error: "Invalid collection id" });
    filter.collectionId = collectionId;
  }

  const flows = await Flow.find(filter).sort({ updatedAt: -1 }).lean();
  res.json(flows);
}));

// POST /api/flows
router.post("/", asyncHandler(async (req, res) => {
  try {
    const { project, name, baseUrl, steps, inputVariables, defaultHeaders, collectionId } = req.body;
    if (!project || !name || !Array.isArray(steps) || steps.length === 0) {
      return res.status(400).json({ error: "project, name and at least one step are required" });
    }

    const cleanBaseUrl = String(baseUrl || "").trim();
    if (cleanBaseUrl) {
      try {
        const parsed = new URL(cleanBaseUrl);
        if (!/^https?:$/.test(parsed.protocol)) throw new Error();
      } catch {
        return res.status(400).json({ error: "baseUrl must be a valid http:// or https:// address" });
      }
    }

    const hasInvalidRelativeStep = steps.some((step) => {
      const path = String(step?.path || "").trim();
      return path && !/^https?:\/\//i.test(path) && !cleanBaseUrl;
    });
    if (hasInvalidRelativeStep) {
      return res.status(400).json({
        error: "baseUrl is required for relative step paths; use a full http(s) URL when baseUrl is empty.",
      });
    }
    if (collectionId && !isValidId(collectionId)) {
      return res.status(400).json({ error: "Invalid collection id" });
    }
    const flow = await Flow.create({
      project,
      name,
      baseUrl: cleanBaseUrl,
      steps,
      inputVariables: Array.isArray(inputVariables) ? inputVariables : [],
      defaultHeaders: defaultHeaders && typeof defaultHeaders === "object" ? defaultHeaders : {},
      collectionId: collectionId || null,
      createdBy: req.user || undefined,
    });
    res.status(201).json(flow);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// PUT /api/flows/:id
// `collection` accepts a collection _id (moves the flow into it), an empty
// string, or null (moves it back to Uncategorized).
router.put("/:id", asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: "Invalid flow id" });
  const { name, baseUrl, steps, inputVariables, defaultHeaders, collectionId } = req.body;
  if (collectionId && !isValidId(collectionId)) {
    return res.status(400).json({ error: "Invalid collection id" });
  }

  const cleanBaseUrl = baseUrl === undefined ? undefined : String(baseUrl || "").trim();
  if (cleanBaseUrl) {
    try {
      const parsed = new URL(cleanBaseUrl);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error();
    } catch {
      return res.status(400).json({ error: "baseUrl must be a valid http:// or https:// address" });
    }
  }
  if (Array.isArray(steps)) {
    const existing = cleanBaseUrl === undefined ? await Flow.findById(req.params.id).select("baseUrl").lean() : null;
    const effectiveBase = cleanBaseUrl !== undefined ? cleanBaseUrl : String(existing?.baseUrl || "").trim();
    const hasInvalidRelativeStep = steps.some((step) => {
      const path = String(step?.path || "").trim();
      return path && !/^https?:\/\//i.test(path) && !effectiveBase;
    });
    if (hasInvalidRelativeStep) {
      return res.status(400).json({
        error: "baseUrl is required for relative step paths; use a full http(s) URL when baseUrl is empty.",
      });
    }
  }

  const flow = await Flow.findByIdAndUpdate(
    req.params.id,
    {
      ...(name !== undefined && { name }),
      ...(baseUrl !== undefined && { baseUrl: cleanBaseUrl }),
      ...(steps !== undefined && { steps }),
      ...(inputVariables !== undefined && { inputVariables }),
      ...(defaultHeaders !== undefined && {
        defaultHeaders: defaultHeaders && typeof defaultHeaders === "object" ? defaultHeaders : {},
      }),
      ...(collectionId !== undefined && { collectionId: collectionId || null }),
    },
    { new: true, runValidators: true }
  );
  if (!flow) return res.status(404).json({ error: "Flow not found" });
  res.json(flow);
}));

// DELETE /api/flows/:id
router.delete("/:id", asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: "Invalid flow id" });
  const flow = await Flow.findByIdAndDelete(req.params.id);
  if (!flow) return res.status(404).json({ error: "Flow not found" });
  res.json({ deleted: true });
}));

// ---------------------------------------------------------------------
// History
// ---------------------------------------------------------------------

// GET /api/flows/:id/runs
router.get("/:id/runs", asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: "Invalid flow id" });
  // A bulk run of N rows saves N individual per-row FlowRuns (rowIndex
  // set) PLUS one batchSummaryRun (isBatchSummary: true, no rowIndex)
  // that already embeds every row's steps, prefixed "[Row N: ...]", and
  // the whole-run AI analysis — see run-bulk above. The per-row docs
  // exist so an individual row's report can still be downloaded/reused,
  // but they're pure duplication in this top-level history list: one
  // click on a 3-row file would otherwise show up as 4 separate "Past
  // runs" entries instead of 1. Excluding rowIndex-tagged docs here
  // keeps single runs and batch summaries (neither has rowIndex) in the
  // list, while a batch's individual rows stay reachable inside the
  // summary entry's own step list instead of cluttering the top level.
  const runs = await FlowRun.find({ flow: req.params.id, rowIndex: { $exists: false } })
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();
  res.json(runs);
}));


// ---------------------------------------------------------------------
// Single run
// ---------------------------------------------------------------------

// POST /api/flows/:id/run   body: { context: {...}, aiEnabled?: boolean }
//
// `aiEnabled` (default true) picks between the two Run buttons in
// FlowRunHistory.jsx: "AI Run" resolves/uses any step-level AI grading as
// before; "Normal Run" skips it entirely and grades purely off each step's
// own fixed expectedStatus list, same as a plain endpoint call.
router.post("/:id/run", asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: "Invalid flow id" });
  const flow = await Flow.findById(req.params.id).lean();
  if (!flow) return res.status(404).json({ error: "Flow not found" });

  const initialContext = req.body?.context || {};
  const aiEnabled = req.body?.aiEnabled !== false;
  const missing = (flow.inputVariables || []).filter(
    (v) => initialContext[v] === undefined || initialContext[v] === ""
  );
  if (missing.length) {
    return res.status(400).json({ error: `Missing required input(s): ${missing.join(", ")}` });
  }

  const resolvedFlow = aiEnabled ? await resolveAiGradedSteps(flow) : flow;
  const result = await runWithCapacity(() => runFlow(resolvedFlow, initialContext));

  // req.user is set by basicAuth (middleware/auth.js) to the plain
  // username string itself, not an object — `req.user?.username` was
  // always undefined, so this silently fell through to "unknown" for
  // every run. req.user IS the username.
  const runData = {
    flow: flow._id,
    flowName: flow.name,
    project: flow.project,
    ranBy: req.user || req.headers["x-user"] || "unknown",
    initialContext: maskContextForStorage(initialContext),
    finalContext: maskContextForStorage(result.finalContext),
    overallSuccess: result.overallSuccess,
    steps: prepareStepsForStorage(result.steps),
    createdAt: new Date(),
  };
  // Build and save the AI report right away, by default, so a past run's
  // "Download report" is instant instead of generating on click.
  runData.reportHtml = buildReportHtml(runData);

  const run = await FlowRun.create(runData);
  res.json(run);
}));

// ---------------------------------------------------------------------
// Bulk run — one flow execution per CSV row, e.g. 50 rollNumber/teacherId
// pairs. Rows run sequentially (not in parallel) so a shared downstream
// system — the API under test — doesn't get hammered by 50 simultaneous
// logins; sequencing also keeps history rows in a predictable order.
// ---------------------------------------------------------------------

// POST /api/flows/:id/run-bulk
// body: { rows: [{...}], scenarios?: [...], aiEnabled?: boolean }
//
// `aiEnabled` (default true) is the "AI Run" vs "Normal Run" switch:
//   - AI Run (aiEnabled: true): unchanged existing behavior — resolves any
//     step-level AI grading, honors an uploaded Test Scenario Excel (or
//     falls back to auto-detecting a scenario column), and writes the
//     AI batch-analysis narrative on the combined report.
//   - Normal Run (aiEnabled: false): plain data-driven testing — every row
//     is still run against the flow (each row = one full flow execution,
//     values substituted into {{variable}} placeholders as usual), but no
//     AI calls are made anywhere. Pass/fail comes purely from each step's
//     own fixed expectedStatus list, exactly like testing the endpoint by
//     hand. `scenarios` is ignored in this mode even if the caller sends it.
router.post("/:id/run-bulk", asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: "Invalid flow id" });
  const flow = await Flow.findById(req.params.id).lean();
  if (!flow) return res.status(404).json({ error: "Flow not found" });

  const rows = req.body?.rows;
  const aiEnabled = req.body?.aiEnabled !== false;
  const scenarios = aiEnabled && Array.isArray(req.body?.scenarios) ? req.body.scenarios : [];
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: "rows must be a non-empty array" });
  }
  if (rows.length > MAX_BULK_ROWS) {
    return res.status(400).json({ error: `Too many rows — max ${MAX_BULK_ROWS} per bulk run.` });
  }

  const rowIds = rows.map((row) => String(row?.test_id ?? "").trim());
  if (rowIds.some((id) => !id)) {
    return res.status(400).json({ error: "Every Test Data row must contain a test_id." });
  }
  // A test_id repeating across rows is now expected, not an error — the
  // paired-column Test Data Excel layout gives one test_id several
  // test_data values (several rows), each run as its own data-driven
  // iteration of the same scenario/expected result from the Test
  // Scenario Excel below.
  const scenarioById = new Map();
  for (const raw of scenarios) {
    const id = String(raw?.test_id ?? raw?.testId ?? "").trim();
    if (!id) continue;
    const copy = { ...raw, test_id: id };
    if (!scenarioById.has(id)) scenarioById.set(id, []);
    scenarioById.get(id).push(copy);
  }
  const missingScenarioIds = [...new Set(rowIds.filter((id) => !scenarioById.has(id)))];
  if (scenarios.length && missingScenarioIds.length) {
    return res.status(400).json({ error: `Test Scenario Excel is missing test_id(s): ${missingScenarioIds.join(", ")}` });
  }

  const needed = flow.inputVariables || [];
  const missingCols = needed.filter((n) => !(n in (rows[0] || {})));
  if (missingCols.length) {
    return res.status(400).json({
      error: `CSV is missing column(s) required by this flow: ${missingCols.join(", ")}`,
    });
  }

  const batchLabel = `Bulk ${new Date().toISOString()} (${rows.length} rows)`;
  const results = [];
  // req.user is the username string itself (see middleware/auth.js) —
  // `req.user?.username` was always undefined here too, so every bulk
  // run row was also stamped "unknown".
  const ranBy = req.user || req.headers["x-user"] || "unknown";
  const resolvedFlow = aiEnabled ? await resolveAiGradedSteps(flow) : flow;

  // classifyScenarioColumn() runs ONCE for the whole file, not once per
  // row — column roles don't change row to row. This used to only run
  // when some step already had aiGraded.enabled manually turned on in the
  // step editor, on the theory that there'd be nowhere to use the answer
  // otherwise — but flowEngine.js's runStep() now honors a detected
  // per-row scenario (context.__aiScenario) on ANY step, not just ones
  // explicitly marked AI-graded, so classification always runs and a
  // sheet column like "expected code is 401" takes effect with no extra
  // per-step setup.
  let scenarioColumn = null;
  // When a dedicated Test Scenario Excel is supplied, its test_id-matched
  // scenario block is the only AI scenario source. Do not ask the AI to
  // guess a scenario column from the Test Data Excel because that would
  // mix metadata and API input values. The old automatic column detection
  // remains only for legacy single-sheet runs that do not supply scenarios.
  if (aiEnabled && !scenarios.length) {
    try {
      const columns = Object.keys(rows[0] || {});
      scenarioColumn = await classifyScenarioColumn(columns, rows.slice(0, 3));
    } catch {
      scenarioColumn = null;
    }
  }

  // Each step's own declared {{variable}} placeholders — computed once per
  // flow, not once per row, since a step's definition doesn't change row
  // to row. Used below to figure out which step a row's populated columns
  // (and therefore its scenario text) actually belong to.
  const stepVarSets = resolvedFlow.steps.map((s) => ({ id: s.id, vars: getStepTemplateVars(s) }));

  // Which columns of this row actually have a value — a row where only
  // username/password are filled in is a login-focused test case; a row
  // where only the event fields are filled in is an events-focused one.
  // (test_id / test_id__2 style ID columns are excluded since every row
  // has those filled and they aren't real request input.)
  function populatedFields(row) {
    return new Set(
      Object.entries(row)
        .filter(([k, v]) => !/^test_id/i.test(k) && v !== undefined && v !== null && String(v).trim() !== "")
        .map(([k]) => k)
    );
  }

  // Given a row's populated columns and a scenario text, find which step(s)
  // that scenario was actually written for by matching populated column
  // names against each step's own {{variable}} placeholders. Returns a
  // step-id -> scenarioText map (empty if nothing matched).
  function scopeScenarioToSteps(rowFields, scenarioText) {
    const targetIds = stepVarSets
      .filter(({ vars }) => [...vars].some((v) => rowFields.has(v)))
      .map(({ id }) => id);
    if (!targetIds.length) return null;
    return Object.fromEntries(targetIds.map((id) => [id, scenarioText]));
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    // Postman-style data-driven testing: every column in the row is made
    // available as a {{column}} variable for this iteration — not just
    // whichever ones happen to be declared in "Values needed". Before,
    // only declared inputVariables were copied into context, so a column
    // that existed in the sheet but wasn't (yet) added to Values needed
    // was silently dropped, even though a step referenced it. Rows run in
    // this exact order, one full flow execution per row, top to bottom —
    // the same iteration model Postman's Collection Runner uses for a
    // data file.
    const initialContext = { ...row };
    const rowFields = populatedFields(row);
    const matchedScenarioRows = scenarioById.get(rowIds[i]) || [];
    if (matchedScenarioRows.length) {
      const scenarioText = matchedScenarioRows.map((scenarioRow) => {
        const parts = Object.entries(scenarioRow)
          .filter(([key, value]) => key !== "test_id" && value !== undefined && String(value).trim() !== "")
          .map(([key, value]) => `${key}: ${value}`);
        return parts.join("; ");
      }).filter(Boolean).join("\n");
      if (scenarioText) {
        // Scope the scenario to only the step(s) whose {{variable}}
        // placeholders overlap this row's populated columns — e.g. a row
        // that only fills username/password targets the login step only,
        // not every step in the flow. See flowEngine.js's runStep comment
        // for why a flat context.__aiScenario used to leak across steps.
        const scoped = scopeScenarioToSteps(rowFields, scenarioText);
        if (scoped) initialContext.__aiScenarioByStep = { ...(initialContext.__aiScenarioByStep || {}), ...scoped };
        // Fallback only when nothing matched (e.g. a step whose vars don't
        // literally share names with the sheet's columns) — better to
        // apply it broadly than silently drop the scenario altogether.
        else initialContext.__aiScenario = scenarioText;
      }
      initialContext.__aiTestId = rowIds[i];
      initialContext.__aiTestScenario = matchedScenarioRows;
    }
    // __aiScenario/__aiScenarioByStep is what flowEngine.js's runStep
    // checks for a per-row, dynamically-inferred expectation (see its
    // comment) — set only when this row actually has a value in the
    // detected scenario column, so a row missing that cell just falls
    // back to the step's fixed grading.
    if (scenarioColumn && row[scenarioColumn] !== undefined && row[scenarioColumn] !== "") {
      const legacyText = row[scenarioColumn];
      const legacyFields = new Set([...rowFields].filter((f) => f !== scenarioColumn));
      const scoped = scopeScenarioToSteps(legacyFields, legacyText);
      if (scoped) initialContext.__aiScenarioByStep = { ...(initialContext.__aiScenarioByStep || {}), ...scoped };
      else initialContext.__aiScenario = legacyText;
    }

    let flowResult;
    try {
      flowResult = await runWithCapacity(() => runFlow(resolvedFlow, initialContext));
    } catch (err) {
      flowResult = { overallSuccess: false, steps: [], finalContext: {}, error: err.message };
    }

    const rowRunData = {
      flow: flow._id,
      flowName: flow.name,
      project: flow.project,
      ranBy,
      initialContext: maskContextForStorage(initialContext),
      finalContext: maskContextForStorage(flowResult.finalContext),
      overallSuccess: flowResult.overallSuccess,
      steps: prepareStepsForStorage(flowResult.steps),
      batchLabel,
      rowIndex: i,
      testId: rowIds[i],
      testScenario: matchedScenarioRows.length ? matchedScenarioRows : null,
      createdAt: new Date(),
    };
    // Same default-generate-and-save behavior as the single-run endpoint
    // above, so every row of a bulk run already has its report saved too.
    rowRunData.reportHtml = buildReportHtml(rowRunData);

    const run = await FlowRun.create(rowRunData);

    results.push({
      rowIndex: i,
      input: maskContextForStorage(initialContext),
      overallSuccess: flowResult.overallSuccess,
      steps: rowRunData.steps,
      runId: run._id,
      testId: rowIds[i],
      testScenario: matchedScenarioRows.length ? matchedScenarioRows : null,
    });
  }

  const passed = results.filter((r) => r.overallSuccess).length;

  // The combined "all rows" report (what "Generate report (all rows)" in
  // the UI shows) used to only be built client-side, on demand, from
  // whatever rows happened to still be on screen — nothing was saved for
  // it, so it never appeared in Past runs. Building and saving it here,
  // as one more FlowRun alongside the per-row ones, makes it show up in
  // Past runs and downloadable later like everything else. Each step is
  // prefixed with its row so it's still clear which row it came from
  // inside the single combined file.
  const batchSteps = [];
  for (const r of results) {
    const rowLabel = r.input && Object.keys(r.input).length
      ? Object.entries(r.input).map(([k, v]) => `${k}=${v}`).join(", ")
      : `row ${r.rowIndex + 1}`;
    for (const s of r.steps || []) {
      batchSteps.push({ ...s, name: `[Row ${r.rowIndex + 1}: ${rowLabel}] ${s.name}` });
    }
  }
  // Final overall execution report: one AI call that reads every row's
  // scenario (from the Test Scenario Excel — TC ID, Module, Preconditions,
  // Expected Result, etc.), the request actually sent, the real endpoint
  // output, and the per-step verdict (already cross-checked against the
  // Swagger contract in judgeTestResult during the row loop above), and
  // writes the summary/findings/failure-pattern/recommendation narrative
  // a QA lead would — not just a pass/fail count. Never blocks the run
  // itself: a failed analysis call is saved as an error note on the
  // report rather than losing the (already-real) row results.
  let aiAnalysis = null;
  if (scenarios.length) {
    try {
      aiAnalysis = await analyzeBatchRun({
        suiteName: flow.name,
        baseUrl: flow.baseUrl,
        rows: results.map((r) => ({
          testId: r.testId,
          input: r.input,
          scenario: r.testScenario,
          overallSuccess: r.overallSuccess,
          steps: (r.steps || []).map((s) => ({
            name: s.name,
            method: s.method,
            path: s.path,
            requestSent: s.requestSent,
            status: s.status,
            responseBody: s.responseBody,
            success: s.success,
            error: s.error,
            aiGrade: s.aiGrade || undefined,
          })),
        })),
      });
    } catch (err) {
      aiAnalysis = { error: `AI analysis unavailable: ${err.message}` };
    }
  }

  const batchSummaryData = {
    flow: flow._id,
    flowName: `${flow.name} — batch run (${results.length} row(s))`,
    project: flow.project,
    ranBy,
    initialContext: {},
    finalContext: {},
    overallSuccess: results.length - passed === 0,
    steps: batchSteps,
    batchLabel,
    isBatchSummary: true,
    aiAnalysis,
    createdAt: new Date(),
  };
  batchSummaryData.reportHtml = buildReportHtml(batchSummaryData);
  const batchSummaryRun = await FlowRun.create(batchSummaryData);

  res.json({
    batchLabel,
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
    aiAnalysis,
    batchRunId: batchSummaryRun._id,
  });
}));

// ---------------------------------------------------------------------
// Design-time single-step test — powers "Test this step" in FlowBuilder.
// Does NOT save to FlowRun history (it's not a real run, just a preview
// while building), and does NOT require a saved Flow — the step is sent
// as-is from the editor along with whatever sample values the user typed
// in for variables the step needs, so someone can try a step and see the
// real response BEFORE wiring up extract rules.
// ---------------------------------------------------------------------

// POST /api/flows/test-step
// body: { baseUrl, step, context, defaultHeaders, flowSteps?, stepIndex? }
//
// `step` is the (possibly edited-but-unsaved) step to actually test.
// `flowSteps` + `stepIndex` are optional: when the editor is testing a
// step that isn't first in the flow, it sends every step up to and
// including this one (FlowStepEditor.jsx's `previewSteps`) plus that
// step's index. When present, we run flowSteps[0..stepIndex-1] for real
// first — using the flow's own defaultHeaders/extract rules — so values
// an earlier step produces (access_token, a rollNumber, etc.) already
// exist in context by the time the step under test runs. That's the
// same auto-chaining runFlow() already does for a saved flow's full run;
// previously this route skipped it entirely and always tested the step
// in total isolation, so any step depending on an earlier one failed
// every time it was tested individually even though the real flow run
// (POST /:id/run) worked, since that path always calls runFlow() with
// the complete step list.
router.post("/test-step", asyncHandler(async (req, res) => {
  const { baseUrl, step, context, defaultHeaders, flowSteps, stepIndex } = req.body || {};
  if (!step || typeof step !== "object") {
    return res.status(400).json({ error: "step is required" });
  }
  const previewBaseUrl = String(baseUrl || "").trim();
  const previewPath = String(step.path || "").trim();
  if (!previewBaseUrl && !/^https?:\/\//i.test(previewPath)) {
    return res.status(400).json({ error: "Set a base URL or enter a full http(s) URL for this step." });
  }

  try {
    let runContext = { ...(context || {}) };
    const prerequisiteSteps = [];

    const hasPrereqs =
      Array.isArray(flowSteps) && Number.isInteger(stepIndex) && stepIndex > 0 && flowSteps.length > stepIndex;

    if (hasPrereqs) {
      const prereqResult = await runWithCapacity(() => runFlow(
        {
          baseUrl,
          defaultHeaders: defaultHeaders || {},
          steps: flowSteps.slice(0, stepIndex).map((s) => ({ ...s, stopOnFailure: false })),
        },
        runContext
      ));
      runContext = prereqResult.finalContext;
      prerequisiteSteps.push(...prereqResult.steps);

      const failedPrereq = prereqResult.steps.find((s) => !s.success);
      if (failedPrereq) {
        // Fail clearly on the prerequisite that broke, rather than letting
        // the step under test fail later with a confusing "unresolved
        // variable" error that hides the real cause.
        return res.json({
          stepId: step.id || "preview",
          name: step.name,
          method: step.method,
          path: step.path,
          success: false,
          status: failedPrereq.status,
          requestSent: null,
          responseBody: null,
          extracted: {},
          error: `Prerequisite step "${failedPrereq.name || failedPrereq.stepId}" failed: ${failedPrereq.error}`,
          prerequisiteSteps,
        });
      }
    }

    // No Flow document exists yet for an unsaved step being previewed, so
    // there's nothing to persist inference onto — but the step itself can
    // still carry an already-inferred aiGraded (if it was inferred on a
    // previous test-step call, or copied from a saved step) or need a
    // fresh one-off inference for this preview. ensureAiGradedSteps()
    // works on any {steps: [...]} shape, saved or not.
    const { steps: [resolvedStep] } = await ensureAiGradedSteps({ steps: [step] });

    const result = await runWithCapacity(() => runFlow(
      { baseUrl, defaultHeaders: defaultHeaders || {}, steps: [{ ...resolvedStep, id: step.id || "preview", stopOnFailure: false }] },
      runContext
    ));
    res.json({ ...result.steps[0], prerequisiteSteps, aiGraded: resolvedStep.aiGraded });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

export default router;
