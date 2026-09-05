// server/services/flowEngine.js
//
// Executes a saved Flow: an ordered list of API calls where later steps can
// reference values extracted from earlier responses via {{variableName}}
// placeholders. This is what makes "login -> take token -> call dashboard
// -> take rollNumber -> assign teacher" work as one click instead of manual
// copy-pasting values between requests.
import { inferTestExpectations, judgeTestResult } from "./llm.js";

/**
 * Get a nested value from an object using dot / bracket path notation.
 * getByPath(obj, "data.user.token") or getByPath(obj, "items[0].id")
 */
export function getByPath(obj, pathStr) {
  if (!pathStr) return obj;
  const parts = pathStr
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  let current = obj;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

/**
 * Loose equality for matching extracted-array items: a rollNumber typed as
 * "1024" by a user must still match a response field that came back as the
 * number 1024, so compare as strings rather than requiring exact type match.
 */
function looseEquals(a, b) {
  return String(a) === String(b);
}

/**
 * Replace {{varName}} tokens anywhere inside a string, object, or array with
 * values pulled from `context`. If an entire string is exactly one token
 * (e.g. "{{accessToken}}"), the raw value is substituted directly (so a
 * templated body can carry numbers/objects, not just strings). Unknown
 * tokens are left as-is rather than silently becoming "undefined", so a
 * misspelled variable is obvious in the recorded request.
 */
export function resolveTemplate(value, context) {
  if (typeof value === "string") {
    const exact = value.match(/^\{\{\s*([\w.[\]]+)\s*\}\}$/);
    if (exact) {
      const v = getByPath(context, exact[1]);
      return v === undefined ? value : v;
    }
    return value.replace(/\{\{\s*([\w.[\]]+)\s*\}\}/g, (whole, key) => {
      const v = getByPath(context, key);
      return v === undefined ? whole : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolveTemplate(v, context));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveTemplate(v, context);
    return out;
  }
  return value;
}

/**
 * Collects every {{variable}} token referenced anywhere in a step's own
 * definition (path, headers, query, bodyTemplate) — the set of input names
 * this specific step actually consumes.
 *
 * Used to figure out, for a bulk-run row, which step a row's populated
 * data columns (and therefore its scenario/expected-outcome text) were
 * actually written for — see the __aiScenarioByStep comment in runStep()
 * below for why this matters.
 */
export function getStepTemplateVars(step) {
  const vars = new Set();
  const scan = (val) => {
    if (typeof val === "string") {
      for (const m of val.matchAll(/\{\{\s*([\w.[\]]+)\s*\}\}/g)) {
        vars.add(m[1].split(/[.[]/)[0]);
      }
    } else if (Array.isArray(val)) {
      val.forEach(scan);
    } else if (val && typeof val === "object") {
      Object.values(val).forEach(scan);
    }
  };
  scan(step?.path);
  scan(step?.headers);
  scan(step?.query);
  scan(step?.bodyTemplate);
  return vars;
}

/**
 * Joins a flow's baseUrl with a step's path the way Postman does it: plain
 * string concatenation, NOT `new URL(path, base)` resolution.
 *
 * `new URL(path, base)` treats a path starting with "/" as an absolute
 * path on the base's ORIGIN, which silently discards any path segment
 * already present in `base` — e.g.
 *
 *   new URL("/students/123", "https://api.example.com/api/v1")
 *     -> "https://api.example.com/students/123"   (drops /api/v1 !)
 *
 * That breaks every API whose baseUrl includes a prefix like /api/v1,
 * which is most of them. FlowBuilder's own copy tells the user baseUrl is
 * "each step adds its own page to this" — i.e. simple concatenation is the
 * promised, documented behavior, so the engine must actually do that.
 *
 * A step's path may occasionally already be a full absolute URL (some
 * specs do this for one-off cross-host calls) — pass those through as-is.
 */
export function joinUrl(baseUrl, path) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const p = String(path || "");
  if (/^https?:\/\//i.test(p)) return p;
  return base + (p.startsWith("/") ? p : `/${p}`);
}

/**
 * Resolves one extraction rule against a step's response/headers/status and
 * returns { value, missing, description } — description is only used to
 * build a clear error message when a `required` rule comes back empty.
 *
 * Two rule shapes are supported:
 *   - path rule (default): { variable, from: "body", path: "data.token" }
 *     Pulls a single value out via dot/bracket path — use when the response
 *     already hands you exactly the value you need.
 *   - find rule: { variable, from: "body", type: "find",
 *       arrayPath: "data.students", where: { field: "rollNumber", equals: "{{rollNumber}}" },
 *       select: "id" }
 *     Searches an array in the response for the first item whose `field`
 *     matches `equals` (which may itself be a {{template}} — usually the
 *     value collected in an earlier step), then returns `select` off that
 *     item (or the whole item if `select` is omitted). Use this whenever an
 *     endpoint returns a list and the value you need has to be looked up by
 *     some key rather than being at a fixed position.
 */
function resolveExtractRule(rule, { responseBody, headerMap, status }, context) {
  if (rule.from === "status") {
    return { value: status, description: "status code" };
  }
  if (rule.from === "header") {
    const path = (rule.path || "").toLowerCase();
    return { value: getByPath(headerMap, path), description: `header "${path}"` };
  }

  if (rule.type === "find") {
    const arr = getByPath(responseBody, rule.arrayPath);
    const field = rule.where?.field;
    const resolvedEquals = resolveTemplate(rule.where?.equals, context);
    const description = `item in "${rule.arrayPath || "(response root)"}" where ${field} == ${resolvedEquals}`;

    if (!Array.isArray(arr)) {
      return { value: undefined, description: `${description} — response at that path was not an array` };
    }
    const match = arr.find((item) => looseEquals(getByPath(item, field), resolvedEquals));
    if (!match) return { value: undefined, description };
    return { value: rule.select ? getByPath(match, rule.select) : match, description };
  }

  // default: plain path rule
  return { value: getByPath(responseBody, rule.path), description: `body path "${rule.path}"` };
}

/**
 * Evaluates one AI-inferred check against a step's actual response body.
 * Shared by flowEngine.js (a step's own aiGraded.checks, evaluated inline
 * during a real run) and aiTestGrader.js (the standalone AI test runner) —
 * defined here, not there, specifically so aiTestGrader.js can import it
 * FROM flowEngine.js without flowEngine.js importing back from
 * aiTestGrader.js, which would be a circular import.
 *
 * "semantic" checks can't be judged in code by definition — passed comes
 * back null and needsJudge signals the caller to escalate to the AI judge.
 */
export function evaluateCheck(check, responseBody) {
  const actualValue = getByPath(responseBody, check.path);
  switch (check.type) {
    case "exists":
      return { ...check, actualValue, passed: actualValue !== undefined && actualValue !== null };
    case "equals":
      return { ...check, actualValue, passed: looseEquals(actualValue, check.value) };
    case "contains": {
      let passed = false;
      if (typeof actualValue === "string") passed = actualValue.includes(String(check.value));
      else if (Array.isArray(actualValue)) passed = actualValue.some((v) => looseEquals(v, check.value));
      return { ...check, actualValue, passed };
    }
    case "type": {
      const actualType = Array.isArray(actualValue) ? "array" : actualValue === null ? "null" : typeof actualValue;
      return { ...check, actualValue, passed: actualType === check.valueType };
    }
    case "semantic":
    default:
      return { ...check, actualValue, passed: null, needsJudge: true };
  }
}

async function runStep(step, baseUrl, context, defaultHeaders = {}, extraHeaders = {}) {
  const start = Date.now();
  const resolvedPath = resolveTemplate(step.path, context);
  // Flow-level defaultHeaders (e.g. { "Authorization": "Bearer {{accessToken}}" })
  // are applied to every step automatically; a step's own headers override
  // a default on the same key, so a step can still opt out or use a
  // different value where needed. `extraHeaders` are headers typed in at
  // run time (see FlowRunHistory.jsx's header editor) — they're layered on
  // top of both, so a run-time header always wins if it collides with a
  // saved default/step header, letting someone add or override a header
  // (an API key, a different Authorization value, etc.) for a single run
  // without having to edit the saved flow.
  const resolvedHeaders = {
    ...resolveTemplate(defaultHeaders || {}, context),
    ...resolveTemplate(step.headers || {}, context),
    ...resolveTemplate(extraHeaders || {}, context),
  };
  const resolvedQuery = resolveTemplate(step.query || {}, context);
  const resolvedBody =
    step.bodyTemplate !== undefined ? resolveTemplate(step.bodyTemplate, context) : undefined;

  // FIXED: was `new URL(resolvedPath, baseUrl)`, which drops any path
  // prefix already in baseUrl. joinUrl() does plain, Postman-style
  // concatenation instead — see its doc comment above.
  const url = new URL(joinUrl(baseUrl, resolvedPath));
  for (const [k, v] of Object.entries(resolvedQuery)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  }

  const method = (step.method || "GET").toUpperCase();
  const fetchOpts = {
    method,
    headers: { "Content-Type": "application/json", ...resolvedHeaders },
  };
  // GET/HEAD never carry a body over HTTP — a leftover bodyTemplate on a
  // GET step (e.g. copy-pasted from a POST step) must not be sent, and
  // must not be *reported* as sent either. `bodyApplies` drives both the
  // real fetch() call and what we tell the UI actually went out, so the
  // "what I did" preview for a GET step never shows a body that was never
  // on the wire.
  const bodyApplies = resolvedBody !== undefined && !["GET", "HEAD"].includes(method);
  if (bodyApplies) {
    fetchOpts.body = typeof resolvedBody === "string" ? resolvedBody : JSON.stringify(resolvedBody);
  }

  const requestSent = {
    method,
    url: url.toString(),
    headers: resolvedHeaders,
    body: bodyApplies ? resolvedBody : undefined,
  };

  try {
    const res = await fetch(url.toString(), fetchOpts);
    const status = res.status;
    const contentType = res.headers.get("content-type") || "";
    const rawText = await res.text();

    let responseBody = rawText;
    if (contentType.includes("application/json")) {
      try {
        responseBody = JSON.parse(rawText);
      } catch {
        // leave as raw text if it claimed JSON but wasn't
      }
    }

    const expected = step.expectedStatus && step.expectedStatus.length ? step.expectedStatus : null;
    const statusOk = expected ? expected.includes(status) : status < 400;

    // header keys from fetch's Headers are always lowercased
    const headerMap = Object.fromEntries(res.headers.entries());

    const extracted = {};
    const missingRequired = [];
    for (const rule of step.extract || []) {
      const { value, description } = resolveExtractRule(rule, { responseBody, headerMap, status }, context);
      extracted[rule.variable] = value;
      if (rule.required && (value === undefined || value === null)) {
        missingRequired.push(`"${rule.variable}" (${description})`);
      }
    }

    // A call can return a healthy status code and still not contain the
    // data a later step needs (e.g. the roll number just wasn't in the
    // list). Treat that as a distinct failure from a bad status, with a
    // message that says exactly what was expected but not found.
    let success = statusOk && missingRequired.length === 0;
    let error = null;
    if (!statusOk) error = `Unexpected status ${status}`;
    else if (missingRequired.length) error = `Could not extract required value(s): ${missingRequired.join(", ")}`;

    // Kept separate from `success` below: a dynamic scenario can
    // legitimately grade THIS step as passed (e.g. "expect 401" and it
    // got exactly 401), but a required value later steps depend on
    // (typically an access token) still genuinely wasn't in that
    // response — there's no way for the flow to continue meaningfully.
    // `success` is allowed to be overridden by AI grading below (that's
    // what the scenario is FOR), but whether the flow chain can continue
    // must stay tied to the real, unoverridden extraction outcome —
    // otherwise a deliberately-failed login (scenario: "expect 401",
    // correctly graded PASS) still lets the flow limp into the next step
    // with no token, which then fails for the boring, uninteresting
    // reason of having no token — noise that isn't what that row's
    // scenario was testing at all.
    const chainBroken = missingRequired.length > 0;

    // AI grading has two modes:
    //   - Dynamic, per-row scenario (context.__aiScenario): set by
    //     Flows.js's run-bulk when the uploaded sheet has a detected
    //     scenario/expected-outcome column. Each row can describe a
    //     completely different expected outcome ("valid login, should
    //     succeed" vs "wrong password, expect 401"), so this is inferred
    //     FRESH every time it's present — it overrides any cached
    //     step-level inference, and is never itself cached, since the
    //     text (and therefore the right expectations) can differ on the
    //     very next row.
    //   - Fixed, step-level description (step.aiGraded, set in the step
    //     editor): the same expectation applies to every run of this
    //     step, so it's inferred once and cached via inferredAt — see
    //     aiTestGrader.js's ensureAiGradedSteps().
    let aiGrade = null;
    // A bulk-run row's scenario text is written about ONE endpoint (e.g.
    // "expected status code is 401" is about the login call), but a flow
    // is usually login -> do the actual thing being tested. If we read a
    // single flat context.__aiScenario here, EVERY step in the flow sees
    // the same text — so a login-only scenario leaks onto the next step
    // too (and gets it wrongly graded against "expect 401"), and an
    // events-only scenario leaks backward onto login. Flows.js's run-bulk
    // now scopes the scenario per step (context.__aiScenarioByStep, keyed
    // by step.id) by matching the row's populated columns against each
    // step's own {{variable}} placeholders, so only the step the row's
    // data was actually written for gets AI-graded against it; every
    // other step in the same flow keeps its normal fixed-list grading.
    // context.__aiScenario (flat, ungenerated as a map) is kept as a
    // fallback for callers that don't build the per-step map — e.g.
    // single-step flows, or a row whose columns didn't match any step's
    // variables at all.
    const dynamicScenario = context.__aiScenarioByStep
      ? context.__aiScenarioByStep[step.id]
      : context.__aiScenario;
    // A per-row scenario column (e.g. "expected code is 401") always wins
    // when present — it's the sheet telling you what THIS row is supposed
    // to do, which is more specific than any per-step fixed expectedStatus
    // list. Previously this also required step.aiGraded?.enabled to be
    // manually turned on in the step editor, which meant a detected
    // scenario column silently did nothing unless that toggle had already
    // been flipped — a row could say "expected code is 401", get exactly
    // 401 back, and still fail because the step's fixed list only had
    // [200] in it. The step-level (cached, aiGraded.inferredAt) path below
    // still requires aiGraded.enabled, since that's a deliberate per-step
    // setting rather than something inferred from the data.
    if (dynamicScenario || (step.aiGraded?.enabled && step.aiGraded.inferredAt)) {
      let expectedStatus;
      let checks;
      if (dynamicScenario) {
        const inferred = await inferTestExpectations({
          description: dynamicScenario,
          method,
          path: resolvedPath,
          body: resolvedBody,
          headers: resolvedHeaders,
        });
        expectedStatus = inferred.expectedStatus || 200;
        checks = inferred.checks || [];
      } else {
        expectedStatus = step.aiGraded.expectedStatus;
        checks = step.aiGraded.checks || [];
      }

      const checkResults = checks.map((c) => evaluateCheck(c, responseBody));
      const aiStatusMatch = status === expectedStatus;
      // Escalate to the AI judge not only for explicit "semantic" checks,
      // but also whenever the status code came back exactly as expected
      // yet a deterministic check still failed. That combination is
      // genuinely ambiguous — it usually means an inferred check doesn't
      // actually apply here (e.g. "token exists" inferred for what turns
      // out to be a correctly-rejected 401 login) rather than a real bug —
      // so let the judge weigh it with full context instead of an
      // automatic hard fail. A status MISMATCH is unambiguous already and
      // still fails without needing the judge.
      const needsJudge = checkResults.some((c) => c.needsJudge) || (aiStatusMatch && checkResults.some((c) => c.passed === false));
      const deterministicPass = aiStatusMatch && checkResults.every((c) => c.passed !== false);

      let aiPassed = deterministicPass;
      let verdictSource = "programmatic";
      let reason = `Status ${status} (expected ${expectedStatus}); ${checkResults.filter((c) => c.passed).length}/${checkResults.length} AI checks passed.`;

      if (needsJudge) {
        try {
          const verdict = await judgeTestResult({
            testCaseDescription: dynamicScenario || step.aiGraded.description || step.name,
            request: requestSent,
            expected: { status: expectedStatus, checks },
            actual: { status, body: responseBody, error: null },
            deterministicFindings: { statusMatch: aiStatusMatch, checkResults },
          });
          aiPassed = Boolean(verdict.passed);
          reason = verdict.reason || reason;
          verdictSource = "ai-judge";
        } catch (err) {
          aiPassed = deterministicPass;
          reason = `${reason} (AI judge unavailable: ${err.message}; used deterministic result.)`;
        }
      }

      aiGrade = { checkResults, passed: aiPassed, reason, verdictSource, scenario: dynamicScenario || null, expectedStatus };
      // A per-row dynamic scenario REPLACES the fixed-list statusOk verdict
      // rather than ANDing with it — the whole point of a scenario column
      // is that this row's correct status can differ from the step's
      // normal fixed expectedStatus list (e.g. a "wrong password, expect
      // 401" row inside a flow whose login step is normally graded against
      // [200]). ANDing here meant a row expecting 401, which correctly got
      // 401, still failed because 401 was never in the step's fixed list.
      // The step-level (cached) aiGraded path is still layered ON TOP of
      // the fixed check, since that's an additional signal for a step
      // that's graded the same way every run.
      if (dynamicScenario) {
        success = aiPassed;
        error = aiPassed ? null : reason;
      } else {
        success = success && aiPassed;
        if (!aiPassed && !error) error = reason;
      }
    }

    return {
      success,
      status,
      requestSent,
      responseBody,
      extracted,
      error,
      aiGrade,
      chainBroken,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      success: false,
      status: null,
      requestSent,
      responseBody: null,
      extracted: {},
      error: err.message,
      aiGrade: null,
      chainBroken: false,
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Runs every step of a flow in order, threading extracted variables from
 * each response into the context available to every later step.
 *
 * `initialContext` seeds starting values that aren't baked into the saved
 * flow (username/password for the login step, a rollNumber to look up,
 * etc.) so the same saved flow can be re-run with different data.
 */
export async function runFlow(flow, initialContext = {}, extraHeaders = {}) {
  const context = { ...initialContext };
  const stepResults = [];
  let overallSuccess = true;

  for (const step of flow.steps) {
    const result = await runStep(step, flow.baseUrl, context, flow.defaultHeaders, extraHeaders);
    stepResults.push({
      stepId: step.id,
      name: step.name,
      method: step.method,
      path: step.path,
      ...result,
    });

    // Even on a failed/required-missing step, keep whatever *did* extract
    // successfully — a partial success further up the chain shouldn't be
    // thrown away just because this step's own data wasn't found.
    Object.assign(context, result.extracted);

    if (!result.success) overallSuccess = false;
    // Stop the flow whenever this step failed its own grading, OR (even
    // if AI grading passed it, e.g. a scenario that correctly expected a
    // login to fail) a value later steps depend on genuinely wasn't
    // extracted — continuing would only run the next step with missing
    // data (no access token, etc.) and produce a failure that has nothing
    // to do with what that step was actually testing. See chainBroken's
    // definition in runStep() above.
    if ((!result.success || result.chainBroken) && step.stopOnFailure !== false) break;
  }

  return { overallSuccess, steps: stepResults, finalContext: context };
}