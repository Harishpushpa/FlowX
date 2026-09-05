// server/services/aiTestGrader.js
//
// Orchestrates "upload a test case (+ optional test data), let AI say
// what's expected, run it for real, get pass/fail" — the AI-graded test
// feature. Two-phase grading, the way a QA engineer would actually work:
//
//   1. BEFORE running anything: ask the model to turn the test case (an
//      English description and/or a partially-filled request) into a
//      complete request definition, an expected status code, and a set of
//      checks against the response. Deterministic checks (exists / equals
//      / contains / type) get evaluated in code once the real response
//      comes back — free, repeatable, no second AI call needed for the
//      common case.
//   2. AFTER running: if every check was deterministic and the request
//      didn't error, the verdict is final right there. Otherwise — any
//      check the model marked "semantic" (a plain-English condition that
//      can't be reduced to a literal comparison), or the request itself
//      errored/timed out — the real request/response plus the
//      deterministic sub-results go back to the model for the final call.
//
// Built on flowEngine.js's existing getByPath/resolveTemplate/joinUrl/
// evaluateCheck rather than duplicating them — this is now also what
// FlowStepEditor's "AI-graded" step type uses (see ensureAiGradedSteps()
// below and flowEngine.js's runStep()), so both places share one
// evaluation function instead of two copies drifting apart.
import { resolveTemplate, joinUrl, evaluateCheck } from "./flowEngine.js";
import { inferTestExpectations, judgeTestResult } from "./llm.js";

const DEFAULT_TIMEOUT_MS = parseInt(process.env.TEST_REQUEST_TIMEOUT_MS || "15000", 10);

/**
 * Fills in whatever the test case didn't already specify. Works whether
 * the caller gave a free-text description, a partial structured request,
 * or both — anything explicitly given (method/path/headers/body) is kept
 * as-is; the model only supplies what's missing. If the caller already
 * gave a complete test (method + path + expectedStatus + checks), no AI
 * call is made at all.
 */
export async function inferTestCase(rawTestCase = {}) {
  const { description, name, method, path, headers, body, expectedStatus, checks } = rawTestCase;

  const alreadyComplete = method && path && expectedStatus && Array.isArray(checks) && checks.length;
  if (alreadyComplete) {
    return {
      name: name || `${method} ${path}`,
      method,
      path,
      headers: headers || {},
      body: body ?? null,
      expectedStatus,
      checks,
      // No AI call was needed — nothing was left for it to fill in, so
      // there's no independent "what the AI thinks this should return"
      // to show next to the given values.
      aiGenerated: null,
    };
  }

  const inferred = await inferTestExpectations({ description, method, path, body, headers });

  return {
    name: name || inferred.name || `${(method || inferred.method || "GET")} ${path || inferred.path || "/"}`,
    method: (method || inferred.method || "GET").toUpperCase(),
    path: path || inferred.path || "/",
    headers: headers && Object.keys(headers).length ? headers : inferred.headers || {},
    body: body !== undefined ? body : inferred.body ?? null,
    expectedStatus: expectedStatus || inferred.expectedStatus || 200,
    checks: Array.isArray(checks) && checks.length ? checks : Array.isArray(inferred.checks) ? inferred.checks : [],
    // The AI's own, independently-inferred expectation — kept verbatim
    // (not merged with any given values) purely so the UI/report can show
    // "here's what was given" next to "here's what the AI thinks this
    // should return", even on rows that already gave some/all fields.
    aiGenerated: {
      expectedStatus: inferred.expectedStatus ?? null,
      checks: Array.isArray(inferred.checks) ? inferred.checks : [],
      body: inferred.body ?? null,
    },
  };
}

/**
 * Runs ONE resolved test case (after {{variable}} substitution from
 * context/a data-driven row) for real and grades it.
 */
export async function executeAndGrade(resolvedTest, { baseUrl, defaultHeaders, context, timeoutMs }) {
  const method = (resolvedTest.method || "GET").toUpperCase();
  const path = resolveTemplate(resolvedTest.path, context);
  const headers = {
    "Content-Type": "application/json",
    ...resolveTemplate(defaultHeaders || {}, context),
    ...resolveTemplate(resolvedTest.headers || {}, context),
  };
  const body = resolvedTest.body != null ? resolveTemplate(resolvedTest.body, context) : undefined;
  const url = joinUrl(baseUrl, path);

  const request = { method, url, path, headers, body: body ?? null };

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let actual = { status: null, body: null, error: null };

  try {
    const fetchOpts = { method, headers, signal: controller.signal };
    if (body !== undefined && !["GET", "HEAD"].includes(method)) {
      fetchOpts.body = typeof body === "string" ? body : JSON.stringify(body);
    }
    const res = await fetch(url, fetchOpts);
    const text = await res.text();
    let parsed = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // leave as raw text — not every endpoint returns JSON
    }
    actual = { status: res.status, body: parsed, error: null };
  } catch (err) {
    actual = {
      status: null,
      body: null,
      error: err.name === "AbortError" ? `Timed out after ${timeoutMs}ms` : err.message,
    };
  } finally {
    clearTimeout(timer);
  }

  const statusMatch = !actual.error && actual.status === resolvedTest.expectedStatus;
  const checkResults = actual.error
    ? (resolvedTest.checks || []).map((c) => ({ ...c, actualValue: undefined, passed: false }))
    : (resolvedTest.checks || []).map((c) => evaluateCheck(c, actual.body));

  const needsJudge = Boolean(actual.error) || checkResults.some((c) => c.needsJudge);
  const deterministicPass = !actual.error && statusMatch && checkResults.every((c) => c.passed !== false);

  let passed = deterministicPass;
  let verdictSource = "programmatic";
  let reason = actual.error
    ? `Request failed: ${actual.error}`
    : `Status ${actual.status} (expected ${resolvedTest.expectedStatus}); ${checkResults.filter((c) => c.passed).length}/${checkResults.length} checks passed.`;

  if (needsJudge) {
    try {
      const verdict = await judgeTestResult({
        testCaseDescription: resolvedTest.name,
        request,
        expected: { status: resolvedTest.expectedStatus, checks: resolvedTest.checks },
        actual,
        deterministicFindings: { statusMatch, checkResults },
      });
      passed = Boolean(verdict.passed);
      reason = verdict.reason || reason;
      verdictSource = "ai-judge";
    } catch (err) {
      // AI judge unreachable — fall back to the deterministic verdict
      // rather than silently failing (or passing) the whole test.
      passed = deterministicPass;
      reason = `${reason} (AI judge unavailable: ${err.message}; used deterministic result.)`;
    }
  }

  return {
    name: resolvedTest.name,
    request,
    expected: { status: resolvedTest.expectedStatus, checks: resolvedTest.checks },
    // Carried straight through from inferTestCase() — null when the row
    // gave a fully-complete test (nothing for the AI to generate), an
    // object like { expectedStatus, checks, body } otherwise. Kept
    // separate from `expected` above, which is whatever value actually
    // ended up governing the grading (given value if present, else this
    // same AI-generated one) — this field is purely "what did the AI
    // independently think, for comparison".
    aiGenerated: resolvedTest.aiGenerated ?? null,
    actual,
    checkResults,
    passed,
    verdictSource,
    reason,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Full entry point. Infers whatever's missing from the test case, expands
 * it across a data-driven row set if one was given (same {{field}}
 * templating convention as the rest of the app — a row's keys become
 * context variables the resolved test's path/headers/body can reference),
 * runs every row for real, and grades each one.
 *
 * `context`/`defaultHeaders` work exactly like a Flow: pass in whatever's
 * already been extracted (e.g. { access_token: "..." }) and defaultHeaders
 * like { Authorization: "Bearer {{access_token}}" } to carry auth through,
 * same as flowEngine.js's runFlow().
 */
export async function runGradedTest({ baseUrl, testCase, dataSet, defaultHeaders, context, timeoutMs }) {
  const resolvedTest = await inferTestCase(testCase || {});
  const rows = Array.isArray(dataSet) && dataSet.length ? dataSet : [null];

  const results = [];
  for (const row of rows) {
    const rowContext = row ? { ...(context || {}), ...row } : context || {};
    const result = await executeAndGrade(resolvedTest, {
      baseUrl,
      defaultHeaders,
      context: rowContext,
      timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS,
    });
    results.push({ row, ...result });
  }

  const passed = results.filter((r) => r.passed).length;

  return { testCase: resolvedTest, total: results.length, passed, failed: results.length - passed, results };
}

/**
 * Adapts a runGradedTest() result into the same shape flowReport.js's
 * buildJUnitXml()/buildReportHtml() already expect from a saved FlowRun —
 * so AI-graded results get the identical JUnit XML / standalone HTML
 * report your flows already produce, instead of a third report format.
 * One row = one <testcase>, so a data-driven run with 5 rows reports as
 * 5 testcases the same way 5 flow steps would.
 */
export function toFlowRunShape(gradedResult, { ranBy } = {}) {
  const steps = gradedResult.results.map((r, i) => ({
    name: r.row
      ? `${r.name} [row ${i + 1}: ${Object.entries(r.row).map(([k, v]) => `${k}=${v}`).join(", ")}]`
      : r.name,
    method: r.request.method,
    path: r.request.path,
    status: r.actual.status,
    durationMs: r.durationMs,
    success: r.passed,
    error: r.passed ? undefined : r.reason,
    requestSent: r.request,
    responseBody: r.actual.body,
    extracted: {},
  }));

  return {
    flowName: `${gradedResult.testCase.name} (AI-graded)`,
    createdAt: Date.now(),
    overallSuccess: gradedResult.failed === 0,
    ranBy: ranBy || "AI test runner",
    steps,
  };
}

/**
 * The Flow-integration half of AI grading: given a flow (about to be run
 * via runFlow()), infers expectedStatus/checks for any step that has
 * aiGraded.enabled but hasn't been inferred yet (no inferredAt), and
 * returns a new steps array with those filled in — flowEngine.js's
 * runStep() only ever READS an already-resolved step.aiGraded, it never
 * calls the model itself. Deliberately separated like this so:
 *
 *   - Inference happens ONCE per step, not once per row of a bulk run —
 *     Flows.js persists the returned steps back onto the Flow document
 *     when `changed` is true, so every subsequent run (including every
 *     row of the same bulk run, since this runs before the row loop, not
 *     inside it) reuses the same expectedStatus/checks instead of paying
 *     for a fresh inference call every time.
 *   - A step whose description or method/path is edited later naturally
 *     gets re-inferred, because editing it should clear inferredAt (see
 *     FlowStepEditor.jsx) — this function only skips steps that already
 *     have a live inferredAt.
 *
 * Returns { steps, changed } — `changed` tells the caller whether a DB
 * write is actually needed; a flow with no aiGraded steps (the common
 * case) or one where everything's already inferred costs nothing extra.
 */
export async function ensureAiGradedSteps(flow) {
  let changed = false;

  const steps = await Promise.all(
    (flow.steps || []).map(async (step) => {
      if (!step.aiGraded?.enabled || step.aiGraded.inferredAt) return step;

      const inferred = await inferTestExpectations({
        description: step.aiGraded.description,
        method: step.method,
        path: step.path,
        body: step.bodyTemplate,
        headers: step.headers,
      });

      changed = true;
      return {
        ...step,
        aiGraded: {
          ...step.aiGraded,
          expectedStatus: step.aiGraded.expectedStatus || inferred.expectedStatus || 200,
          checks: Array.isArray(step.aiGraded.checks) && step.aiGraded.checks.length
            ? step.aiGraded.checks
            : inferred.checks || [],
          inferredAt: new Date().toISOString(),
        },
      };
    })
  );

  return { steps, changed };
}