// client/src/components/FlowStepEditor.jsx
//
// Rebuilt to mirror Postman's request editor, since that's a layout a
// lot of people have muscle memory for even if they've never built an
// API integration themselves:
//
//   [ name ]
//   [ METHOD ▾ ]  [ base-url/path ................ ]   [ Send ]
//   [ Params | Headers | Body | Save Values | Settings ]  <- tabs
//   ...tab content...
//   ---------------------------------------------------
//   Response:  [ 200 OK ]                                <- appears after Send
//   [ Body ]
//   ...click a value to save it as a variable...
//
// Data shape in/out is UNCHANGED (headers, query, bodyTemplate, extract,
// expectedStatus, stopOnFailure) — services/flowEngine.js needs no
// changes. This file only changes how it's arranged on screen.
import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../api";

const VAR_TOKEN_RE = /\{\{(\w+)\}\}/g;
const METHOD_COLOR = {
  GET: "#3fd67a",
  POST: "#ffb020",
  PUT: "#4da3ff",
  PATCH: "#c792ff",
  DELETE: "#ff5c6c",
};

function findVarsIn(value, out = new Set()) {
  if (value == null) return out;
  if (typeof value === "string") {
    let m;
    VAR_TOKEN_RE.lastIndex = 0;
    while ((m = VAR_TOKEN_RE.exec(value))) out.add(m[1]);
  } else if (Array.isArray(value)) {
    value.forEach((v) => findVarsIn(v, out));
  } else if (typeof value === "object") {
    Object.values(value).forEach((v) => findVarsIn(v, out));
  }
  return out;
}
// Previously this required every top-level value to be a primitive, so a
// swagger-generated body with even one nested/array field (e.g. an
// "attachments": [""] field alongside eight plain string fields) fell
// back to advanced mode and silently dropped ALL fields from the
// field-by-field view, not just the nested one. A body is only unusable
// in the field-by-field editor when its *top level* isn't a plain
// object at all (e.g. the whole body is an array or a scalar) — nested
// values are still perfectly fine as fields, they just round-trip
// through objectToEntries/entriesToObject as JSON text.
function isFlatObject(obj) {
  return obj != null && typeof obj === "object" && !Array.isArray(obj);
}
function lastPathSegment(path) {
  const parts = String(path).replace(/\[(\d+)\]/g, ".$1").split(".");
  return parts[parts.length - 1] || "value";
}
function objectToEntries(obj) {
  return Object.entries(obj || {}).map(([key, value]) => ({
    key,
    value: value !== null && typeof value === "object" ? JSON.stringify(value) : String(value ?? ""),
  }));
}
function entriesToObject(entries) {
  const obj = {};
  for (const { key, value } of entries) {
    const trimmedKey = key.trim();
    if (!trimmedKey) continue;
    const trimmedValue = typeof value === "string" ? value.trim() : value;
    // Round-trip nested/array fields (stringified by objectToEntries)
    // back into real JSON values instead of leaving them as literal
    // "[...]"/"{...}" strings in the request body.
    if (typeof trimmedValue === "string" && (trimmedValue.startsWith("{") || trimmedValue.startsWith("["))) {
      try {
        obj[trimmedKey] = JSON.parse(trimmedValue);
        continue;
      } catch {
        // Not actually valid JSON (e.g. user is mid-typing) — keep it as
        // the plain string they typed.
      }
    }
    obj[trimmedKey] = value;
  }
  return obj;
}

// Postman-style "insert variable" affordance — a small pill dropdown
// next to any field that can use a saved value, so the {{...}} syntax
// never has to be typed by hand.
function InsertVariableButton({ knownVariables = [], onInsert, compact }) {
  return (
    <select
      className={`insert-var-btn ${compact ? "compact" : ""}`}
      value=""
      onChange={(e) => {
        if (e.target.value) onInsert(e.target.value);
        e.target.value = "";
      }}
      title="Insert a saved value"
    >
      <option value="">{"{{ }} insert"}</option>
      {knownVariables.map((v) => (
        <option key={v} value={v}>
          {v}
        </option>
      ))}
    </select>
  );
}

// Params/Headers table — modeled directly on Postman's key/value grid.
const HEADER_OPTIONS = [
  "Authorization",
  "Content-Type",
  "Accept",
  "Cache-Control",
  "User-Agent",
  "X-API-Key",
  "X-Requested-With",
];

function KeyValueTable({
  entries,
  onChange,
  knownVariables,
  globalColumns = [],
  onGlobalColumnUsed,
  keyPlaceholder,
  valuePlaceholder,
  emptyHint,
  keyOptions = null,
}) {
  // Both requested behaviors for the global test-data sheet: typing a key
  // that matches an uploaded column auto-fills {{key}} as the value (no
  // {{}} needed by hand), AND the {{ }} insert dropdown lists global
  // columns alongside captured/known variables either way — so a value
  // that already has other text in it, or a key that doesn't match, can
  // still pull in a column manually.
  const insertableVars = [...new Set([...knownVariables, ...globalColumns])];

  function setRow(i, patch) {
    onChange(entries.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  }
  function removeRow(i) {
    onChange(entries.filter((_, idx) => idx !== i));
  }
  function addRow() {
    onChange([...entries, { key: "", value: "" }]);
  }
  function insertVar(i, varName) {
    setRow(i, { value: `${entries[i].value || ""}{{${varName}}}` });
  }
  function setKey(i, nextKey) {
    const row = entries[i];
    const matchesGlobalColumn = globalColumns.some((c) => c.toLowerCase() === nextKey.trim().toLowerCase());
    // Only auto-fill when the value is still empty — never overwrite
    // something the user already typed just because the key now matches.
    if (matchesGlobalColumn && !row.value) {
      setRow(i, { key: nextKey, value: `{{${nextKey.trim()}}}` });
      // Auto-filling {{key}} here is worthless on its own — nothing asks
      // the user for that value unless it's also a declared flow input.
      // Without this, "Run flow" shows no field for it, nothing gets
      // collected, and the literal "{{key}}" string gets sent as-is. This
      // is what makes typing a key immediately usable end to end, not
      // just at edit time.
      onGlobalColumnUsed?.(nextKey.trim());
    } else {
      setRow(i, { key: nextKey });
    }
  }

  return (
    <div className="kv-table">
      <div className="kv-table-head">
        <span>Key</span>
        <span>Value</span>
        <span />
      </div>
      {entries.length === 0 && <p className="status kv-empty-hint">{emptyHint}</p>}
      {entries.map((row, i) => (
        <div className="kv-row" key={i}>
          {keyOptions ? (
            <div className="kv-key-control">
              <select
                className="kv-key-select"
                value={keyOptions.includes(row.key) ? row.key : "__custom__"}
                onChange={(e) => {
                  const value = e.target.value;
                  setKey(i, value === "__custom__" ? "" : value);
                }}
              >
                {keyOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
                <option value="__custom__">Custom...</option>
              </select>
              {(!row.key || !keyOptions.includes(row.key)) && (
                <input
                  className="kv-key kv-key-custom"
                  placeholder={keyPlaceholder}
                  value={row.key}
                  onChange={(e) => setKey(i, e.target.value)}
                />
              )}
            </div>
          ) : (
            <input className="kv-key" placeholder={keyPlaceholder} value={row.key} onChange={(e) => setKey(i, e.target.value)} />
          )}
          <input className="kv-value" placeholder={valuePlaceholder} value={row.value} onChange={(e) => setRow(i, { value: e.target.value })} />
          <div className="kv-row-tools">
            <InsertVariableButton knownVariables={insertableVars} onInsert={(v) => insertVar(i, v)} compact />
            <button type="button" className="kv-remove" title="Remove" onClick={() => removeRow(i)}>
              ✕
            </button>
          </div>
        </div>
      ))}
      <button type="button" className="kv-add" onClick={addRow}>
        + Add
      </button>
    </div>
  );
}

// Flattens ANY response into a flat, searchable list — Postman doesn't
// have this (you eyeball the JSON tree), but for non-technical users a
// search-and-click beats scanning nested brackets, so we keep it.
function flattenToLeaves(value, path = "", out = []) {
  if (value === null || typeof value !== "object") {
    out.push({ path, value });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => flattenToLeaves(v, `${path}[${i}]`, out));
    return out;
  }
  for (const [k, v] of Object.entries(value)) {
    flattenToLeaves(v, path ? `${path}.${k}` : k, out);
  }
  return out;
}

function ResponseLeafList({ data, onPick }) {
  const [filter, setFilter] = useState("");
  const leaves = useMemo(() => flattenToLeaves(data), [data]);
  const term = filter.trim().toLowerCase();
  const visible = term
    ? leaves.filter((l) => l.path.toLowerCase().includes(term) || String(l.value).toLowerCase().includes(term))
    : leaves;

  return (
    <div className="response-leaf-list">
      <input
        type="text"
        className="response-leaf-filter"
        placeholder={`Search ${leaves.length} value(s) — try "token" or "id"`}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {visible.length === 0 && <p className="status">Nothing matches "{filter}".</p>}
      <ul className="response-leaf-rows">
        {visible.map((leaf) => (
          <li key={leaf.path} className="response-leaf-row">
            <button type="button" className="response-leaf-pick" onClick={() => onPick(leaf.path, leaf.value)}>
              <span className="response-leaf-path">{leaf.path || "(whole result)"}</span>
              <span className="response-leaf-value">{JSON.stringify(leaf.value)}</span>
              <span className="response-leaf-cta">Save →</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ParamsTab({ pathVars, sample, onSampleChange, queryEntries, onChange, knownVariables, globalColumns, onGlobalColumnUsed }) {
  return (
    <div>
      {pathVars.length > 0 && (
        <div className="params-path-vars">
          <h5>Path Variables</h5>
          <table className="swagger-picker-schema-table">
            <thead>
              <tr>
                <th>Key</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {pathVars.map((name) => (
                <tr key={name}>
                  <td className="schema-field-name">{name}</td>
                  <td>
                    <input
                      type="text"
                      value={sample[name] || ""}
                      placeholder={`Value for {{${name}}}`}
                      onChange={(e) => onSampleChange(name, e.target.value)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="status">
            Comes from <code>{"{{ }}"}</code> tokens in the URL above — used to send/preview this step. If
            an earlier step's Save Values already produces one of these, its real runtime value is used
            automatically and this is only needed here for testing.
          </p>
        </div>
      )}
      <KeyValueTable
        entries={queryEntries}
        onChange={onChange}
        knownVariables={knownVariables}
        globalColumns={globalColumns}
        onGlobalColumnUsed={onGlobalColumnUsed}
        keyPlaceholder="status"
        valuePlaceholder="active"
        emptyHint="No query filters added — most steps don't need any."
      />
    </div>
  );
}

function HeadersTab({ headerEntries, onChange, knownVariables, globalColumns, onGlobalColumnUsed, inheritedAuth }) {
  return (
    <div>
      {inheritedAuth && (
        <p className="status">
          Authorization is managed by the flow. Add only step-specific
          headers here; the inherited Bearer token will be applied
          automatically.
        </p>
      )}

      <KeyValueTable
        entries={headerEntries}
        onChange={onChange}
        knownVariables={knownVariables}
        globalColumns={globalColumns}
        onGlobalColumnUsed={onGlobalColumnUsed}
        keyPlaceholder="X-Custom-Header"
        valuePlaceholder="Header value"
        emptyHint={
          inheritedAuth
            ? "No step-specific headers."
            : "No step-specific headers."
        }
        keyOptions={HEADER_OPTIONS.filter((header) => header !== "Authorization")}
      />
    </div>
  );
}

function BodyTab({ advancedBody, setAdvancedBody, bodyEntries, updateBodyRows, knownVariables, globalColumns, onGlobalColumnUsed, rawBodyText, setRawBodyText, rawBodyError, onSaveRaw }) {
  return (
    <div>
      <div className="body-mode-switch">
        <button type="button" className={!advancedBody ? "active" : ""} onClick={() => setAdvancedBody(false)}>
          Field by field
        </button>
        <button type="button" className={advancedBody ? "active" : ""} onClick={() => setAdvancedBody(true)}>
          Raw JSON
        </button>
      </div>
      {!advancedBody ? (
        <KeyValueTable
          entries={bodyEntries}
          onChange={updateBodyRows}
          knownVariables={knownVariables}
          globalColumns={globalColumns}
          onGlobalColumnUsed={onGlobalColumnUsed}
          keyPlaceholder="username"
          valuePlaceholder="jane"
          emptyHint={
            globalColumns.length
              ? `Add a field — type a key like ${globalColumns[0]} and it'll fill itself in from your uploaded test data.`
              : "Nothing to send yet — add a field, e.g. username."
          }
        />
      ) : (
        <div>
          <textarea
            className="raw-body-textarea"
            rows={7}
            value={rawBodyText}
            placeholder='{ "username": "jane" }'
            onChange={(e) => setRawBodyText(e.target.value)}
            onBlur={onSaveRaw}
          />
          {rawBodyError && <span className="status error">{rawBodyError}</span>}
        </div>
      )}
    </div>
  );
}

function SaveValuesTab({ extract, removeExtract, testPanel }) {
  return (
    <div>
      <p className="status">
        Click <strong>Send</strong> above to run this step for real, then click any value in the response to save
        it — later steps can reuse it.
      </p>
      {extract.length > 0 && (
        <ul className="captured-var-list">
          {extract.map((rule) => (
            <li key={rule.variable} className="captured-var-chip">
              ✓ <code>{rule.variable}</code>
              <span className="captured-var-source"> from {rule.path || rule.arrayPath || rule.from}</span>
              <button type="button" onClick={() => removeExtract(rule.variable)} title="Remove">
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      {testPanel}
    </div>
  );
}

function SettingsTab({ step, onChange }) {
  const aiGraded = step.aiGraded || {};

  function updateAiGraded(patch) {
    onChange({ aiGraded: { ...aiGraded, ...patch } });
  }

  function reinfer() {
    // Clearing inferredAt (and the previous expectedStatus/checks) is what
    // tells ensureAiGradedSteps() this step needs a fresh inference call —
    // it only re-infers when inferredAt is absent, specifically so editing
    // the description or flipping the checkbox doesn't silently re-bill an
    // AI call on every keystroke. This button is the explicit "yes, redo
    // it" action.
    updateAiGraded({ inferredAt: undefined, expectedStatus: undefined, checks: undefined });
  }

  return (
    <div>
      <label className="flow-stop-toggle">
        <input
          type="checkbox"
          checked={step.stopOnFailure !== false}
          onChange={(e) => onChange({ stopOnFailure: e.target.checked })}
        />
        If this step fails, stop the whole flow (don't run the steps after it)
      </label>

      <div className="ai-grading-section">
        <label className="flow-stop-toggle">
          <input
            type="checkbox"
            checked={Boolean(aiGraded.enabled)}
            onChange={(e) => updateAiGraded({ enabled: e.target.checked })}
          />
          Grade this step's response with AI
        </label>

        {aiGraded.enabled && (
          <>
            <p className="status">
              Describe what a passing response looks like — you can leave this blank if the method/path/body
              already make it obvious. The AI fills in an expected status code and response checks the first
              time this step runs; after that it reuses them (free, repeatable) until you re-infer.
            </p>
            <textarea
              rows={3}
              placeholder={`e.g. "Should succeed and return an access token" — optional if it's a plain login/lookup`}
              value={aiGraded.description || ""}
              onChange={(e) => updateAiGraded({ description: e.target.value })}
            />

            {aiGraded.inferredAt ? (
              <div className="ai-grading-inferred">
                <p className="status">
                  <strong>Inferred expected status:</strong> {aiGraded.expectedStatus}
                </p>
                {aiGraded.checks?.length > 0 ? (
                  <ul className="ai-test-checklist">
                    {aiGraded.checks.map((c, i) => (
                      <li key={i}>
                        <code>{c.path}</code> — {c.type}
                        {c.type === "semantic" ? ` — "${c.criterion}"` : ""}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="status">No content checks — status code only.</p>
                )}
                <button type="button" className="ghost-btn" onClick={reinfer}>
                  Re-infer with AI
                </button>
              </div>
            ) : (
              <p className="status">Not inferred yet — happens automatically the next time this step runs.</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const TABS = ["Params", "Headers", "Body", "Save Values", "Settings"];
const METHODS_WITHOUT_BODY = ["GET", "HEAD"];

export default function FlowStepEditor({
  step,
  baseUrl,
  defaultHeaders,
  knownVariables,
  globalColumns = [],
  globalSampleRow = {},
  onGlobalColumnUsed,
  onChange,
  authEnabled = true,
  authType = "bearer",
  authTokenVariable = "access_token",
  flowSteps = null,
  stepIndex = 0,
}) {
  const bodySource = step.bodyTemplate !== undefined ? step.bodyTemplate : step.body;

  // {{name}} tokens straight out of the URL — e.g. /chapters/{{chapterId}}
  // from a swagger path parameter. Surfaced in the Params tab as "Path
  // Variables" (see ParamsTab below) since that's where Swagger itself
  // lists them, even though under the hood they're filled in the same
  // `sample` test-context state as everything else on this panel.
  const pathVars = useMemo(() => [...findVarsIn(step.path)], [step.path]);

  const [headerEntries, setHeaderEntries] = useState(() => objectToEntries(step.headers));
  const [queryEntries, setQueryEntries] = useState(() => objectToEntries(step.query));
  const [bodyEntries, setBodyEntries] = useState(() => objectToEntries(isFlatObject(bodySource) ? bodySource : {}));
  const [advancedBody, setAdvancedBody] = useState(bodySource != null && !isFlatObject(bodySource));
  const [rawBodyText, setRawBodyText] = useState(bodySource === undefined ? "" : JSON.stringify(bodySource, null, 2));
  const [rawBodyError, setRawBodyError] = useState("");
  const [activeTab, setActiveTab] = useState("Params");

  // Send/response state lives here (not in a sub-panel) so the response
  // sits below the tabs the way it does in Postman, regardless of which
  // tab is open.
  const [sample, setSample] = useState({});
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [sendError, setSendError] = useState("");
  const [pendingPick, setPendingPick] = useState(null);
  const [varName, setVarName] = useState("");

  // Per-step auth override (Inherit/None/Bearer) has been removed — every
  // step now always inherits the flow's Authorization header, which is the
  // only mode this app actually used in practice. Authorization is never
  // allowed to live in step.headers itself (it's always supplied by the
  // flow's defaultHeaders and merged in at runtime), so we always strip it
  // out here rather than branching on a per-step mode.
  function stripAuthorization(headers = {}) {
    return Object.fromEntries(
      Object.entries(headers || {}).filter(
        ([key]) => key.toLowerCase() !== "authorization"
      )
    );
  }

  useEffect(() => {
    const src = step.bodyTemplate !== undefined ? step.bodyTemplate : step.body;
    const normalizedHeaders = stripAuthorization(step.headers);

    if (Object.keys(step.headers || {}).some(
      (key) => key.toLowerCase() === "authorization"
    )) {
      // Persist the cleanup locally so the next Send cannot accidentally
      // override the inherited Authorization header.
      onChange({ headers: normalizedHeaders });
    }

    setHeaderEntries(objectToEntries(normalizedHeaders));
    setQueryEntries(objectToEntries(step.query));
    setBodyEntries(objectToEntries(isFlatObject(src) ? src : {}));
    setAdvancedBody(src != null && !isFlatObject(src));
    setRawBodyText(src === undefined ? "" : JSON.stringify(src, null, 2));
    setRawBodyError("");
    setActiveTab("Params");
    setResult(null);
    setSendError("");
    setSample({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.id]);

  function updateHeaders(rows) {
    // Keep the raw rows (including a freshly-added blank one, or one
    // that's still mid-typing) for the visible table. Previously this
    // rebuilt headerEntries from entriesToObject(rows) — which drops any
    // row with a blank key — so a row added via "+ Add" (key: "") was
    // wiped out on the very next render, before there was ever a chance
    // to type a header name into it. Only "Authorization" is filtered out
    // of the visible rows, since that's always inherited from the flow.
    const visibleRows = rows.filter((row) => row.key.trim().toLowerCase() !== "authorization");
    setHeaderEntries(visibleRows);
    onChange({ headers: entriesToObject(visibleRows) });
  }
  function updateQuery(rows) {
    setQueryEntries(rows);
    onChange({ query: entriesToObject(rows) });
  }
  function updateBodyRows(rows) {
    setBodyEntries(rows);
    onChange({ bodyTemplate: entriesToObject(rows) });
  }
  function saveRawBody() {
    if (!rawBodyText.trim()) {
      onChange({ bodyTemplate: undefined });
      setRawBodyError("");
      return;
    }
    try {
      onChange({ bodyTemplate: JSON.parse(rawBodyText) });
      setRawBodyError("");
    } catch {
      setRawBodyError("That's not valid JSON, so this wasn't saved.");
    }
  }
  function insertIntoPath(name) {
    onChange({ path: `${step.path || ""}{{${name}}}` });
  }
  function addExtract(rule) {
    const existing = (step.extract || []).filter((r) => r.variable !== rule.variable);
    onChange({ extract: [...existing, rule] });
  }
  function removeExtract(name) {
    onChange({ extract: (step.extract || []).filter((r) => r.variable !== name) });
  }

  const previewSteps = Array.isArray(flowSteps) && flowSteps.length
    ? [...flowSteps.slice(0, stepIndex), step]
    : [step];

  // A standalone step can depend on values created by earlier steps. For
  // example, GET /academic-years needs access_token created by the login
  // step. The old editor only sent the selected step to /test-step, so the
  // placeholder had no runtime value and the API correctly returned 401.
  // For preview, collect every unresolved input needed by the prerequisite
  // steps plus the selected step. Extracted variables are not requested from
  // the user because the prerequisite run will create them.
  const previewInputs = useMemo(() => {
    const required = new Set();
    const produced = new Set();

    previewSteps.forEach((previewStep) => {
      findVarsIn(
        {
          p: previewStep.path,
          h: { ...defaultHeaders, ...previewStep.headers },
          q: previewStep.query,
          b: previewStep.bodyTemplate ?? previewStep.body,
        },
        required
      );

      for (const rule of previewStep.extract || []) {
        if (rule?.variable) produced.add(rule.variable);
      }
    });

    // Values produced by an earlier step are runtime values, not inputs.
    for (const variable of produced) required.delete(variable);

    // The configured flow Bearer token is intentionally deferred until an
    // earlier step extracts it. It must never be shown as a sample input.
    if (authEnabled && authType === "bearer") {
      required.delete((authTokenVariable || "access_token").trim());
    }

    return [...required];
  }, [previewSteps, defaultHeaders, authEnabled, authType, authTokenVariable]);

  const deferredAuthVariable =
    authEnabled && authType === "bearer" ? (authTokenVariable || "access_token").trim() : "";
  const unknown = previewInputs.filter((v) => v !== deferredAuthVariable);

  // Pre-fill "Test this step" sample inputs from the global sheet's first
  // row wherever a needed variable name matches a column — same idea as
  // the key/value auto-fill above, just for the test-run panel instead of
  // the saved step body. Never overwrites something the user already
  // typed in this panel.
  useEffect(() => {
    if (!unknown.length || !Object.keys(globalSampleRow).length) return;
    setSample((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const v of unknown) {
        if (!next[v] && globalSampleRow[v] !== undefined) {
          next[v] = String(globalSampleRow[v]);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unknown.join("|"), globalSampleRow]);

  async function handleSend() {
    setRunning(true);
    setSendError("");
    setResult(null);
    try {
      const res = await apiFetch("/api/flows/test-step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl,
          // FlowStepEditor's local state can inherit a legacy step that
          // stored its body under `body` instead of `bodyTemplate` (see
          // bodySource above) — spreading `step` as-is is enough, since
          // flowEngine.js's runStep only ever reads `bodyTemplate`, and
          // that field is already preserved by the spread. No separate
          // `body:` override needed here.
          step: {
            ...step,
            headers: stripAuthorization(step.headers),
          },
          // When this is a later step, the server runs the prerequisite
          // steps first so their extracted values (especially access_token)
          // exist in the preview context. For the first step this naturally
          // becomes a one-step preview.
          flowSteps: previewSteps,
          stepIndex: previewSteps.length - 1,
          context: sample,
          defaultHeaders: defaultHeaders || {},
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "That didn't work.");
      setResult(data);
      setActiveTab("Save Values");
      // If this step has AI grading enabled and hadn't been inferred yet,
      // /test-step just did a one-off inference to run this preview —
      // capture that back onto the step so it's not re-inferred (and
      // re-billed) again on the next preview or the next real run. Only
      // update when it actually changed, so an ordinary send on a step
      // without AI grading doesn't rewrite anything.
      if (data.aiGraded && data.aiGraded.inferredAt !== step.aiGraded?.inferredAt) {
        onChange({ aiGraded: data.aiGraded });
      }
    } catch (err) {
      setSendError(err.message);
    } finally {
      setRunning(false);
    }
  }

  function startPick(path, value) {
    setPendingPick({ path, value });
    setVarName(lastPathSegment(path));
  }
  function confirmPick() {
    if (!varName.trim()) return;
    addExtract({ variable: varName.trim(), from: "body", path: pendingPick.path });
    setPendingPick(null);
    setVarName("");
  }

  const testPanel = (
    <div className="test-step-panel">
      {previewSteps.length > 1 && (
        <div className="test-step-chain-hint">
          <strong>Previewing this step with its prerequisites</strong>
          <span>Earlier steps will run first so saved values such as <code>access_token</code> are available.</span>
        </div>
      )}
      {unknown.length > 0 && (
        <div className="test-step-sample-inputs">
          <p className="status">Enter example values needed to run this step and its prerequisites (not saved):</p>
          {unknown.map((v) => (
            <label key={v} className="test-step-sample-field">
              {v}
              <input
                type={/pass|secret|token/i.test(v) ? "password" : "text"}
                value={sample[v] || ""}
                onChange={(e) => setSample((prev) => ({ ...prev, [v]: e.target.value }))}
              />
            </label>
          ))}
        </div>
      )}
      {sendError && <p className="status error">{sendError}</p>}
      {result && (
        <div className={`test-step-result ${result.success ? "pass" : "fail"}`}>
          {result.responseBody && typeof result.responseBody === "object" ? (
            <ResponseLeafList data={result.responseBody} onPick={startPick} />
          ) : (
            <p className="status">No JSON came back to save values from.</p>
          )}
        </div>
      )}
      {pendingPick && (
        <div className="capture-confirm">
          <span>
            Save <code>{JSON.stringify(pendingPick.value)}</code> and call it:
          </span>
          <input value={varName} onChange={(e) => setVarName(e.target.value)} placeholder="e.g. accessToken" autoFocus />
          <button type="button" onClick={confirmPick}>
            Save it
          </button>
          <button type="button" className="ghost-btn" onClick={() => setPendingPick(null)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );

  return (
    <div className="request-editor">
      <input
        className="request-name-input"
        value={step.name}
        placeholder="e.g. Log in"
        onChange={(e) => onChange({ name: e.target.value })}
      />

      <div className="request-bar">
        <select
          className="method-select"
          style={{ color: METHOD_COLOR[step.method] || "#aaa" }}
          value={step.method}
          onChange={(e) => {
            const nextMethod = e.target.value;
            onChange({ method: nextMethod });
            // GET/HEAD can't carry a body — jump off the Body tab if it's
            // open so the user is never staring at a tab that's about to
            // disappear, and isn't asked to fill in something that will
            // never be sent.
            if (METHODS_WITHOUT_BODY.includes(nextMethod) && activeTab === "Body") {
              setActiveTab("Params");
            }
          }}
        >
          {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <div className="url-bar">
          <span className="url-base">{baseUrl || "(set your flow's base address)"}</span>
          <input className="path-input" value={step.path} placeholder="/students/123" onChange={(e) => onChange({ path: e.target.value })} />
          <InsertVariableButton knownVariables={knownVariables} onInsert={insertIntoPath} compact />
        </div>
        <button type="button" className="send-btn" onClick={handleSend} disabled={running}>
          {running ? "Sending…" : "Send"}
        </button>
      </div>

      <div className="step-auth-strip">
        <div className="step-auth-label">
          <span className="step-auth-icon">🔐</span>
          <span>Authentication</span>
        </div>
        {authEnabled && authType === "bearer" ? (
          <span className="step-auth-hint">
            {`Inherits flow auth — Authorization: Bearer {{${authTokenVariable || "access_token"}}}`}
          </span>
        ) : (
          <span className="step-auth-hint">Inherits the flow's Authorization header</span>
        )}
      </div>

      <div className="request-tabs">
        {TABS.filter((tab) => tab !== "Body" || !METHODS_WITHOUT_BODY.includes(step.method)).map((tab) => {
          const badge =
            (tab === "Headers" && headerEntries.length) ||
            (tab === "Params" && queryEntries.length + pathVars.length) ||
            (tab === "Save Values" && (step.extract || []).length) ||
            0;
          return (
            <button key={tab} type="button" className={`request-tab ${activeTab === tab ? "active" : ""}`} onClick={() => setActiveTab(tab)}>
              {tab}
              {badge > 0 && <span className="request-tab-badge">{badge}</span>}
            </button>
          );
        })}
      </div>

      <div className="request-tab-content">
        {activeTab === "Params" && (
          <ParamsTab
            pathVars={pathVars}
            sample={sample}
            onSampleChange={(name, value) => setSample((prev) => ({ ...prev, [name]: value }))}
            queryEntries={queryEntries}
            onChange={updateQuery}
            knownVariables={knownVariables}
            globalColumns={globalColumns}
            onGlobalColumnUsed={onGlobalColumnUsed}
          />
        )}
        {activeTab === "Headers" && (
          <div>
            {Object.keys(defaultHeaders || {}).some((key) => key.toLowerCase() === "authorization") && (
              <div className="inherited-auth-banner">
                <span>🔐</span>
                <div>
                  <strong>Authorization is inherited from flow</strong>
                  <span>Every request uses the flow's Bearer token automatically.</span>
                </div>
              </div>
            )}
            <HeadersTab
              headerEntries={headerEntries}
              onChange={updateHeaders}
              knownVariables={knownVariables}
              globalColumns={globalColumns}
              onGlobalColumnUsed={onGlobalColumnUsed}
              inheritedAuth={authEnabled && authType === "bearer"}
            />
          </div>
        )}
        {activeTab === "Body" && (
          <BodyTab
            advancedBody={advancedBody}
            setAdvancedBody={setAdvancedBody}
            bodyEntries={bodyEntries}
            updateBodyRows={updateBodyRows}
            knownVariables={knownVariables}
            globalColumns={globalColumns}
            onGlobalColumnUsed={onGlobalColumnUsed}
            rawBodyText={rawBodyText}
            setRawBodyText={setRawBodyText}
            rawBodyError={rawBodyError}
            onSaveRaw={saveRawBody}
          />
        )}
        {activeTab === "Save Values" && <SaveValuesTab extract={step.extract || []} removeExtract={removeExtract} testPanel={testPanel} />}
        {activeTab === "Settings" && <SettingsTab step={step} onChange={onChange} />}
      </div>

      {result && (
        <div className={`response-pane ${result.success ? "pass" : "fail"}`}>
          <div className="response-pane-header">
            <span className="response-status-badge">{result.success ? "✓" : "✕"}</span>
            <span>Status {result.status ?? "—"}</span>
            {result.error ? <span className="status error">{result.error}</span> : null}
            {activeTab !== "Save Values" && (
              <button type="button" className="ghost-btn response-goto-save" onClick={() => setActiveTab("Save Values")}>
                Save a value from this →
              </button>
            )}
          </div>
          {result.aiGrade && (
            <div className={`ai-grade-summary ${result.aiGrade.passed ? "pass" : "fail"}`}>
              <strong>AI grading: {result.aiGrade.passed ? "PASS" : "FAIL"}</strong>{" "}
              <span className="status">(via {result.aiGrade.verdictSource})</span>
              <p>{result.aiGrade.reason}</p>
              {result.aiGrade.checkResults?.length > 0 && (
                <ul className="ai-test-checklist">
                  {result.aiGrade.checkResults.map((c, i) => (
                    <li key={i} className={c.passed === false ? "fail" : c.passed === true ? "pass" : "pending"}>
                      <code>{c.path}</code> — {c.type === "semantic" ? c.criterion : `expected ${c.type === "type" ? c.valueType : JSON.stringify(c.value)}, got ${JSON.stringify(c.actualValue)}`}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}