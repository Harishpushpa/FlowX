import "dotenv/config";
import OpenAI from "openai";

// timeout: without this, a hung/slow OpenAI response leaves the request
// (and whoever's waiting on it) stuck indefinitely instead of failing.
// maxRetries: the SDK automatically retries retryable failures (429s,
// 5xxs, connection errors) with exponential backoff before giving up —
// important once several people are hitting this at the same time and
// occasionally tripping OpenAI's own rate limits.
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: parseInt(process.env.OPENAI_TIMEOUT_MS || "30000", 10),
  maxRetries: parseInt(process.env.OPENAI_MAX_RETRIES || "2", 10),
});

const MODEL = process.env.GENERATION_MODEL || "gpt-4o-mini";

/**
 * Phase 1 of AI-graded testing: turn a test case (a plain-English
 * description and/or a partially-specified request) into a complete,
 * executable request definition plus what a passing response should look
 * like — an expected status code and a set of checks against the body.
 *
 * Checks come back typed so the caller can evaluate most of them in code
 * (deterministic, free, repeatable) and only fall back to a second AI call
 * for the ones that genuinely can't be reduced to a literal comparison.
 */
export async function inferTestExpectations({ description, method, path, body, headers }) {
  const systemPrompt = `You are a senior API test engineer. Given a test case description and/or a partially-specified HTTP request, produce a complete, executable test definition as JSON.

Return ONLY a JSON object with this exact shape, nothing else:
{
  "name": string,
  "method": "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  "path": string,
  "headers": object,
  "body": object | null,
  "expectedStatus": number,
  "checks": [
    {
      "path": string,
      "type": "exists" | "equals" | "contains" | "type" | "semantic",
      "value": "required for equals/contains — the expected literal value",
      "valueType": "required for type — e.g. string, number, boolean, array, object",
      "criterion": "required for semantic — a plain-English pass condition"
    }
  ]
}

Rules:
- "path" in a check is a dot/bracket path into the JSON response body, e.g. "data.token" or "items[0].id".
- If the description explicitly states an expected status code (e.g. "expected status code is 401", "should return 200", "expect a 404", "need to get 401"), use that EXACT number for expectedStatus verbatim. Do not override it with your own judgment about whether the given credentials/body look like they should succeed — the description's stated expectation is authoritative, even if the request looks like it should succeed or fail differently.
- If expectedStatus is an error code (400 or above), do NOT add checks that assume a successful/authenticated response — e.g. a token existing, an id being returned, an echoed field matching the input. An error response usually won't have those fields, and asserting they exist will always fail regardless of whether the API behaved correctly. Only add a check about the error response itself (e.g. an error message or code) if the description explicitly asks for it.
- Prefer deterministic checks (exists/equals/contains/type) whenever the description gives you something concrete to check. Only use "semantic" for a genuinely subjective condition that can't be reduced to a literal comparison (e.g. "the error message should be helpful and mention the missing field").
- You are NOT given the API's actual response shape — only the description and whatever request details were supplied. If a check is about a field whose exact location in the response body you can't be reasonably certain of (e.g. "the response should contain a token" — is it at "token", "access_token", "data.token", nested under "user", or something else entirely?), do NOT guess a specific path with type "exists"/"equals"/"contains" — a wrong guess will fail even when the real API is behaving correctly. Use type "semantic" instead, with a criterion describing the field in plain English (e.g. "the response should contain some form of access/auth token") — a later step evaluates that against the real response as a whole, not a single guessed path. Reserve exists/equals/contains/type checks for fields whose location the description states explicitly or that follow a convention you're actually confident about (e.g. an echoed input field usually appears under the same key name it was sent with).
- If the caller already supplied method/path/body/headers, keep those exact values rather than inventing new ones — only fill in what's missing (at minimum expectedStatus and checks).
- Never fabricate a specific token/id/secret value inside "body" or "headers" — use a {{variableName}} placeholder for anything that should come from prior context or test data instead.
- Keep checks minimal and high-signal — 1 to 5 checks is typical; don't pad the list. When expectedStatus is an error code and the description gives no other detail to check, it's fine to return an empty checks array — the status code match is the whole test.
- Omit an Authorization header — that's applied separately by the caller.`;

  const userParts = [];
  if (description) userParts.push(`Test case description:\n${description}`);
  if (method) userParts.push(`Given method: ${method}`);
  if (path) userParts.push(`Given path: ${path}`);
  if (headers && Object.keys(headers).length) userParts.push(`Given headers: ${JSON.stringify(headers)}`);
  if (body !== undefined && body !== null) userParts.push(`Given body: ${JSON.stringify(body)}`);

  const response = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userParts.join("\n\n") || "No details given — infer a reasonable smoke test." },
    ],
  });

  return JSON.parse(response.choices[0]?.message?.content ?? "{}");
}

/**
 * Phase 2 of AI-graded testing — only called when a test can't be fully
 * resolved by code: the request errored, or at least one check was marked
 * "semantic". Gets the real request/response plus the deterministic
 * sub-results already computed, and makes the final pass/fail call.
 */
export async function judgeTestResult({ testCaseDescription, request, expected, actual, deterministicFindings }) {
  const systemPrompt = `You are grading a single API test result. You're given what the test case was supposed to verify, the request that was actually sent, what was expected, the actual response received, and the results of whatever deterministic (programmatic) checks already ran.

Make the FINAL pass/fail call yourself, taking the deterministic findings into account but not treating them as automatically decisive — a deterministic check failing does not automatically mean fail if the response still clearly satisfies the intent of the test case, and vice versa.

Deterministic checks were inferred from the test case description BEFORE the real response was ever seen, so a check's exact JSON path is a guess, not ground truth — a check for "data.token" failing only proves nothing exists at that literal path, not that no token exists at all. Before agreeing with a failed check, look at the full actual response body yourself: if the value the check was trying to find (a token, an id, a specific field, etc.) is genuinely present somewhere in the actual response under a different name or location, treat that as satisfying the check's intent and do not fail the test for it. Only fail on a check if the actual response body, read as a whole, truly does not contain what the test case needed.

Return ONLY a JSON object: { "passed": boolean, "reason": string }. Keep "reason" to one or two sentences.`;

  const userPrompt = JSON.stringify(
    { testCaseDescription, request, expected, actual, deterministicFindings },
    null,
    2
  );

  const response = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  return JSON.parse(
    response.choices[0]?.message?.content ?? '{"passed": false, "reason": "Judge call returned no content."}'
  );
}

/**
 * Given an uploaded sheet's columns and a few sample rows, identifies
 * whether one column holds a free-text TEST SCENARIO / expected-outcome
 * description (e.g. "wrong password, should fail with 401") rather than
 * plain input data (usernames, IDs, dates). Called ONCE per bulk run — not
 * once per row — since column roles don't change row to row, only the
 * values do. Returns null when no such column exists, which is the common
 * case for a sheet that's pure input data.
 */
export async function classifyScenarioColumn(columns, sampleRows) {
  const systemPrompt = `You're given the column names of an uploaded spreadsheet used for API testing, plus a few sample rows. Most columns hold plain input data (usernames, passwords, IDs, dates, statuses). At most ONE column might instead hold a free-text TEST SCENARIO or EXPECTED-OUTCOME description meant for a QA engineer to read — something like "valid login, should succeed" or "wrong password, expect 401 unauthorized". That's a distinct kind of column: a sentence describing what should happen, not a value the request would send.

Return ONLY a JSON object: { "scenarioColumn": "<exact column name from the list>" | null }. Return null if every column is plain data — don't force a match.`;

  const userPrompt = `Columns: ${JSON.stringify(columns)}\n\nSample rows:\n${JSON.stringify(sampleRows, null, 2)}`;

  const response = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const parsed = JSON.parse(response.choices[0]?.message?.content ?? "{}");
  return parsed.scenarioColumn && columns.includes(parsed.scenarioColumn) ? parsed.scenarioColumn : null;
}

/**
 * Whole-sheet AI analysis for an Excel batch run — called ONCE after every
 * row has actually been executed against the live API, not per row. This
 * is what makes the batch *report* AI-authored rather than just a table of
 * per-row pass/fail lines: the model reads every row's request/response
 * side by side and writes the summary a QA lead would, spotting patterns
 * (e.g. "every negative-credential row correctly returned 401 with the
 * same error shape") that no single row's grading verdict can show on its
 * own.
 *
 * Kept deliberately separate from judgeTestResult() (which grades one row
 * in isolation, before this ever runs) — this never changes any row's
 * pass/fail, it only narrates the finished set.
 */
export async function analyzeBatchRun({ suiteName, baseUrl, rows }) {
  const systemPrompt = `You are a senior QA engineer writing the summary section of an API test report for a batch of test rows that have ALREADY been executed. You are given, for every row: its scenario name, the request that was sent, what was expected (from the sheet and/or AI-inferred), what actually came back, and the pass/fail verdict with reason.

Write a concise, high-signal analysis of the WHOLE run — not a restatement of each row. Return ONLY a JSON object with this exact shape:
{
  "summary": "2-4 sentence overall verdict — what this run shows about the API's correctness",
  "findings": ["short bullet", "..."],
  "failurePatterns": ["short bullet describing a pattern across failed rows, if any — omit entirely (empty array) if nothing patterns"],
  "recommendations": ["short actionable bullet", "..."]
}

Rules:
- Ground every claim in the actual rows given — never invent a row, status code, or field that isn't there.
- "findings" should surface what's notable: consistent behavior, surprising results, endpoints exercised more than once, anything a QA lead would flag.
- "failurePatterns" groups related failures together (e.g. "all 3 rows using the /login endpoint with a malformed body returned 500 instead of 400") rather than listing each failed row again — if failures don't share a pattern, note that instead of forcing one.
- Keep every bullet to one sentence. 2-6 bullets per list is typical — don't pad.`;

  const userPrompt = JSON.stringify({ suiteName, baseUrl, rows }, null, 2);

  const response = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const parsed = JSON.parse(response.choices[0]?.message?.content ?? "{}");
  return {
    summary: parsed.summary || "",
    findings: Array.isArray(parsed.findings) ? parsed.findings : [],
    failurePatterns: Array.isArray(parsed.failurePatterns) ? parsed.failurePatterns : [],
    recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : [],
  };
}