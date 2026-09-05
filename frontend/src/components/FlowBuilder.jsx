// client/src/components/FlowBuilder.jsx
//
// Rebuilt around Postman's own structure, since that's the closest
// mental model most people already have for "a saved list of API calls
// that run in order":
//
//   Sidebar                     Main panel
//   ------------------------    ------------------------------------
//   + New Flow                  (Flow selected, nothing open)
//   ▾ Student sign-up             [Overview] [Values needed] [Login]
//       ⚙ Flow settings           <- like Postman's collection-level
//       1  POST Log in               Authorization / Variables tabs
//       2  GET  Get profile
//       + Add step                (Step selected)
//   ▸ Teacher onboarding            [name] [METHOD][url][Send]
//                                   [Params|Headers|Body|Save Values|Settings]
//                                   ...Postman-style request editor...
//
// Saved-flow data shape is UNCHANGED: { project, name, baseUrl, steps,
// inputVariables, defaultHeaders }. The backend needs no changes.
import { useEffect, useState } from "react";
import { apiFetch, apiFetchJson } from "../api";
import { useWorkspace } from "../context/WorkspaceContext";
import FlowStepEditor from "./FlowStepEditor";
import GlobalTestDataBar from "./GlobalTestDataBar";

const METHOD_COLOR = {
  GET: "#3fd67a",
  POST: "#ffb020",
  PUT: "#4da3ff",
  PATCH: "#c792ff",
  DELETE: "#ff5c6c",
};

// Swagger path params come as /students/{id} — Flow steps use {{var}}
// templating everywhere else, so line the two up. Any of these that
// aren't filled in by an earlier step's `extract` rule show up in
// FlowStepEditor's "type a sample value" panel automatically, same as
// any other unresolved {{var}}.
function swaggerPathToFlowPath(rawPath) {
  return String(rawPath || "/").replace(/\{(\w+)\}/g, "{{$1}}");
}

function emptyStep(endpoint) {
  // endpoint.bodyTemplate / queryParams come from the swagger schema
  // (see backend/utils/schemaToTemplate.js) — every key the API expects
  // is already here with a placeholder value, so the Body/Params tabs
  // open with fields ready to fill in rather than blank.
  const query = {};
  for (const q of endpoint?.queryParams || []) query[q.name] = "";

  return {
    id: `step_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name: endpoint ? `${endpoint.method} ${endpoint.path}` : "New step",
    method: endpoint?.method || "GET",
    path: endpoint ? swaggerPathToFlowPath(endpoint.path) : "/",
    headers: {},
    query,
    bodyTemplate: endpoint?.bodyTemplate,
    extract: [],
    expectedStatus: [],
    stopOnFailure: true,
  };
}
function objectToEntries(obj) {
  return Object.entries(obj || {}).map(([key, value]) => ({ key, value: String(value ?? "") }));
}
function entriesToObject(entries) {
  const obj = {};
  for (const { key, value } of entries) {
    if (key.trim()) obj[key.trim()] = value;
  }
  return obj;
}

// Chip input for "what changes each time you run this" — Postman's
// closest equivalent is a collection Variable's name column, but since
// these are run-time inputs (not fixed values) a tag list reads clearer.
function ChipInput({ values, onChange, placeholder }) {
  const [draft, setDraft] = useState("");
  function commit() {
    const clean = draft.trim().replace(/,$/, "");
    if (clean && !values.includes(clean)) onChange([...values, clean]);
    setDraft("");
  }
  function handleKeyDown(e) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit();
    } else if (e.key === "Backspace" && !draft && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  }
  return (
    <div className="chip-input">
      {values.map((v, i) => (
        <span className="chip" key={v}>
          {v}
          <button type="button" onClick={() => onChange(values.filter((_, idx) => idx !== i))} title="Remove">
            ✕
          </button>
        </span>
      ))}
      <input value={draft} placeholder={values.length === 0 ? placeholder : "add another…"} onChange={(e) => setDraft(e.target.value)} onKeyDown={handleKeyDown} onBlur={commit} />
    </div>
  );
}

// Same key/value table as FlowStepEditor's — used here for the flow's
// shared "Login" tab (equivalent to Postman's collection-level
// Authorization / inherited headers).
const COMMON_HEADERS = [
  "Authorization",
  "Content-Type",
  "Accept",
  "Cache-Control",
  "User-Agent",
  "X-API-Key",
  "X-Requested-With",
];

function HeaderKeyControl({ value, onChange }) {
  const isCustom = value && !COMMON_HEADERS.includes(value);

  return (
    <div className="header-key-control">
      <select
        className="kv-key"
        value={isCustom ? "__custom__" : value}
        onChange={(e) => {
          if (e.target.value === "__custom__") {
            onChange("");
          } else {
            onChange(e.target.value);
          }
        }}
      >
        <option value="">Select header...</option>
        {COMMON_HEADERS.map((header) => (
          <option key={header} value={header}>
            {header}
          </option>
        ))}
        <option value="__custom__">Custom...</option>
      </select>

      {isCustom || value === "" ? (
        <input
          className="kv-key-custom"
          placeholder="Custom header name"
          value={isCustom ? value : ""}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : null}
    </div>
  );
}

function KeyValueTable({ entries, onChange, knownVariables }) {
  function setRow(i, patch) {
    onChange(entries.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  }

  function removeRow(i) {
    onChange(entries.filter((_, idx) => idx !== i));
  }

  function insertVariable(i, variable) {
    if (!variable) return;
    const current = entries[i]?.value || "";
    const token = `{{${variable}}}`;

    // Avoid creating Bearer Bearer {{access_token}} or duplicate variables.
    const nextValue =
      current.includes(token)
        ? current
        : `${current}${current && !current.endsWith(" ") ? " " : ""}${token}`;

    setRow(i, { value: nextValue });
  }

  return (
    <div className="kv-table">
      <div className="kv-table-head">
        <span>Header</span>
        <span>Value</span>
        <span />
      </div>

      {entries.length === 0 && (
        <p className="status kv-empty-hint">No shared headers added yet.</p>
      )}

      {entries.map((row, i) => (
        <div className="kv-row" key={i}>
          <HeaderKeyControl
            value={row.key}
            onChange={(key) => setRow(i, { key })}
          />

          <input
            className="kv-value"
            placeholder={
              row.key === "Authorization"
                ? "Bearer {{access_token}}"
                : "Header value"
            }
            value={row.value}
            onChange={(e) => setRow(i, { value: e.target.value })}
          />

          <div className="kv-row-tools">
            <select
              className="insert-var-btn compact"
              value=""
              title="Insert flow variable"
              onChange={(e) => insertVariable(i, e.target.value)}
            >
              <option value="">{"{{ }} insert"}</option>
              {knownVariables.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>

            <button
              type="button"
              className="kv-remove"
              onClick={() => removeRow(i)}
              title="Remove header"
            >
              ✕
            </button>
          </div>
        </div>
      ))}

      <button
        type="button"
        className="kv-add"
        onClick={() =>
          onChange([...entries, { key: "", value: "" }])
        }
      >
        + Add header
      </button>
    </div>
  );
}

// Works two ways, depending on whether a Swagger/OpenAPI spec has been
// parsed yet (see App.jsx's `parsedEndpoints`):
//
//   - No endpoints known: there's nothing to pick from, so the button
//     skips the dropdown entirely and adds a blank step straight away —
//     same one-request-at-a-time experience as QuickRequest, just saved
//     as a flow step instead of fired off immediately.
//   - Endpoints known: normal searchable picker, with "start with a
//     blank step" always available at the top in case the call isn't
//     in the spec (e.g. a webhook or an endpoint added since it was
//     uploaded).
function EndpointPicker({ endpoints, onPick, label }) {
  const hasEndpoints = endpoints.length > 0;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const term = search.trim().toLowerCase();
  const filtered = endpoints.filter((ep) => {
    if (!term) return true;
    return (
      ep.path.toLowerCase().includes(term) ||
      ep.method.toLowerCase().includes(term) ||
      (ep.summary || "").toLowerCase().includes(term) ||
      (ep.tag || "").toLowerCase().includes(term)
    );
  });
  const grouped = filtered.reduce((acc, ep) => {
    const tag = ep.tag || "Other";
    (acc[tag] ??= []).push(ep);
    return acc;
  }, {});
  const tags = Object.keys(grouped).sort();

  function handlePick(ep) {
    onPick(ep);
    setOpen(false);
    setSearch("");
  }

  function handleButtonClick() {
    if (!hasEndpoints) {
      // Nothing to browse — go straight to a blank step instead of
      // opening a dropdown that can only ever say "Nothing found."
      handlePick(null);
      return;
    }
    setOpen((o) => !o);
  }

  return (
    <div className="flow-endpoint-picker">
      <button type="button" className="sidebar-add-step-btn" onClick={handleButtonClick} title={hasEndpoints ? undefined : "No Swagger/OpenAPI spec loaded — adds a blank step you fill in by hand"}>
        {label}
      </button>
      {open && hasEndpoints && (
        <div className="flow-endpoint-dropdown">
          <input type="text" autoFocus className="flow-endpoint-search" placeholder="Search for a page or action…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <button type="button" className="flow-endpoint-blank" onClick={() => handlePick(null)}>
            Or start with a blank step
          </button>
          {tags.length === 0 && <div className="flow-endpoint-empty">Nothing found.</div>}
          {tags.map((tag) => (
            <div key={tag} className="flow-endpoint-group">
              <h5>
                {tag} <span className="flow-endpoint-group-count">{grouped[tag].length}</span>
              </h5>
              {grouped[tag].map((ep) => (
                <button type="button" key={ep.id} className="flow-endpoint-option" onClick={() => handlePick(ep)}>
                  <span className="flow-endpoint-method" style={{ color: METHOD_COLOR[ep.method] || "#aaa" }}>
                    {ep.method}
                  </span>
                  <span className="flow-endpoint-path">{ep.path}</span>
                  {ep.summary && <span className="flow-endpoint-summary">{ep.summary}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Small inline "type a name, press Add" form — used both for creating a
// new collection and for renaming one in place (no separate modal).
function InlineNameForm({ initialValue = "", placeholder, onSubmit, onCancel, submitLabel = "Add" }) {
  const [value, setValue] = useState(initialValue);
  function submit() {
    const clean = value.trim();
    if (!clean) return;
    onSubmit(clean);
  }
  return (
    <div className="inline-name-form">
      <input
        type="text"
        autoFocus
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") onCancel();
        }}
      />
      <button type="button" onClick={submit}>
        {submitLabel}
      </button>
      <button type="button" className="ghost-btn" onClick={onCancel}>
        ✕
      </button>
    </div>
  );
}

const FLOW_TABS = ["Overview", "Values needed", "Login"];

export default function FlowBuilder() {
  const {
    project,
    endpoints: availableEndpoints,
    globalColumns,
    globalSampleRow,
    setSelectedFlow,
  } = useWorkspace();
  const [flows, setFlows] = useState([]);
  const [collections, setCollections] = useState([]);
  const [flowId, setFlowId] = useState("");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [steps, setSteps] = useState([]);
  const [inputVarChips, setInputVarChips] = useState([]);
  const [defaultHeaderEntries, setDefaultHeaderEntries] = useState([]);
  const [sameLoginForAll, setSameLoginForAll] = useState(false);
  // "" means uncategorized — matches the <select> below using "" for
  // "No collection" and each collection's real _id otherwise.
  const [collectionId, setCollectionId] = useState("");

  // view: "flow" (Overview/Values/Login tabs) or "step" (request editor)
  const [view, setView] = useState("flow");
  const [flowTab, setFlowTab] = useState("Overview");
  const [openStepIndex, setOpenStepIndex] = useState(null);

  // Sidebar collection UI state: which collections are collapsed, whether
  // the "new collection" inline form is open, and which collection (if
  // any) is mid-rename.
  const [collapsedCollections, setCollapsedCollections] = useState(new Set());
  const [addingCollection, setAddingCollection] = useState(false);
  const [renamingCollectionId, setRenamingCollectionId] = useState("");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");


  function loadCollections() {
    if (!project) return;
    apiFetch(`/api/collections?project=${encodeURIComponent(project)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`Could not load collections (${r.status})`);
        return r.json();
      })
      .then((data) => setCollections(Array.isArray(data) ? data : []))
      .catch((err) => setError(err.message));
  }

  useEffect(() => {
    let cancelled = false;

    setFlows([]);
    setCollections([]);
    setSelectedFlow(null);
    setFlowId("");
    resetForm();
    setError("");

    if (!project) return () => { cancelled = true; };

    Promise.all([
      apiFetch(`/api/flows?project=${encodeURIComponent(project)}`).then((r) => {
        if (!r.ok) throw new Error(`Could not load your saved flows (${r.status})`);
        return r.json();
      }),
      apiFetch(`/api/collections?project=${encodeURIComponent(project)}`).then((r) => {
        if (!r.ok) throw new Error(`Could not load collections (${r.status})`);
        return r.json();
      }),
    ])
      .then(([flowData, collectionData]) => {
        if (cancelled) return;
        setFlows(Array.isArray(flowData) ? flowData : []);
        setCollections(Array.isArray(collectionData) ? collectionData : []);
      })
      .catch((err) => {
        if (cancelled) return;
        setFlows([]);
        setCollections([]);
        setError(err.message);
      });

    return () => {
      cancelled = true;
    };
  }, [project]);

  // --- Collection management -------------------------------------------
  async function createCollection(rawName) {
    setError("");
    try {
      const data = await apiFetchJson("/api/collections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project, name: rawName }),
      });
      setCollections((prev) => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)));
      setAddingCollection(false);
    } catch (err) {
      setError(err.message);
    }
  }
  async function renameCollection(id, rawName) {
    setError("");
    try {
      const data = await apiFetchJson(`/api/collections/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: rawName }),
      });
      setCollections((prev) => prev.map((c) => (c._id === id ? data : c)).sort((a, b) => a.name.localeCompare(b.name)));
      setRenamingCollectionId("");
    } catch (err) {
      setError(err.message);
    }
  }
async function deleteCollection(id, collectionName) {
  if (
    !window.confirm(
      `Delete "${collectionName}"?\n\nThis will permanently delete the collection and all flows inside it.\n\nThis action cannot be undone.`
    )
  ) {
    return;
  }

  setError("");

  try {
    await apiFetchJson(
      `/api/collections/${id}?deleteFlows=true`,
      {
        method: "DELETE",
      }
    );

    // Remove the collection from local state
    setCollections((prev) =>
      prev.filter(
        (collection) =>
          collection._id !== id
      )
    );

    // Permanently remove all flows that belonged
    // to the deleted collection from local state.
    setFlows((prev) =>
      prev.filter(
        (flow) =>
          flow.collection !== id
      )
    );

    // If the deleted collection was selected,
    // clear the selection.
    if (collectionId === id) {
      setCollectionId("");
    }

    // If the currently selected flow belonged
    // to the deleted collection, clear it too.
    if (
      selectedFlow &&
      selectedFlow.collection === id
    ) {
      setSelectedFlow(null);
    }

    // If your component uses flowId as the
    // selected-flow state, clear that as well.
    if (
      flowId &&
      flows.some(
        (flow) =>
          flow._id === flowId &&
          flow.collection === id
      )
    ) {
      setFlowId("");
    }
  } catch (err) {
    setError(
      err.message ||
        "Failed to delete collection"
    );
  }
}
  function toggleCollapsed(id) {
    setCollapsedCollections((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  // Changing the dropdown in Flow settings moves an already-saved flow
  // immediately (no need to hit "Save changes" first) — but for a flow
  // that hasn't been saved yet, just remember the choice locally; it goes
  // out with the rest of the payload on first save.
  async function handleCollectionChange(newCollectionId) {
    setCollectionId(newCollectionId);
    if (!flowId) return;
    try {
      const data = await apiFetchJson(`/api/flows/${flowId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ collection: newCollectionId || null }),
      });
      setFlows((prev) => prev.map((f) => (f._id === flowId ? data : f)));
      loadCollections(); // refresh flowCount badges
    } catch (err) {
      setError(err.message);
    }
  }

  function resetForm() {
    setName("");
    setBaseUrl("");
    setSteps([]);
    setInputVarChips([]);
    setDefaultHeaderEntries([
      { key: "Authorization", value: "Bearer {{access_token}}" },
    ]);
    setSameLoginForAll(true);
    setCollectionId("");
    setView("flow");
    setFlowTab("Overview");
    setOpenStepIndex(null);
  }

  function loadFlow(id) {
    setFlowId(id);
    setError("");
    const flow = flows.find((f) => f._id === id);
    if (!flow) {
      resetForm();
      return;
    }
    setSelectedFlow(flow);
    setName(flow.name);
    setBaseUrl(flow.baseUrl);
    setSteps(flow.steps);
    setInputVarChips(flow.inputVariables || []);
    const headerRows = objectToEntries(flow.defaultHeaders);
    const hasAuthorization = headerRows.some(
      (row) => row.key.trim().toLowerCase() === "authorization"
    );

    const sharedHeaders = hasAuthorization
      ? headerRows
      : [
          { key: "Authorization", value: "Bearer {{access_token}}" },
          ...headerRows,
        ];

    setDefaultHeaderEntries(sharedHeaders);
    setSameLoginForAll(true);
    setCollectionId(flow.collection || "");
    setView("flow");
    setFlowTab("Overview");
    setOpenStepIndex(null);
  }

  // presetCollectionId: when "+ New flow" is clicked from inside a
  // collection's section in the sidebar, the new flow starts already
  // assigned to that collection instead of Uncategorized.
  function startNewFlow(presetCollectionId = "") {
    setSelectedFlow(null);
    setFlowId("");
    resetForm();
    setCollectionId(presetCollectionId);
  }

  function updateStep(index, patch) {
    setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }
  function removeStep(index) {
    setSteps((prev) => prev.filter((_, i) => i !== index));
    if (openStepIndex === index) {
      setView("flow");
      setOpenStepIndex(null);
    }
  }
  function moveStep(index, dir) {
    setSteps((prev) => {
      const next = [...prev];
      const target = index + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    if (openStepIndex === index) setOpenStepIndex(index + dir);
  }
  function addStep(endpoint) {
    setSteps((prev) => {
      const next = [...prev, emptyStep(endpoint)];
      setOpenStepIndex(next.length - 1);
      return next;
    });
    setView("step");
  }
  function openStep(i) {
    setView("step");
    setOpenStepIndex(i);
  }

  function knownVariablesFor(index) {
    const fromEarlierSteps = steps.slice(0, index).flatMap((s) => (s.extract || []).map((r) => r.variable));
    return [...new Set([...inputVarChips, ...fromEarlierSteps])];
  }
  const allKnownVariables = [...new Set([...inputVarChips, ...steps.flatMap((s) => (s.extract || []).map((r) => r.variable))])];

  async function handleSave() {
    setError("");
    if (!name.trim() || !baseUrl.trim() || steps.length === 0) {
      setError("Please give this flow a name, a website address, and at least one step.");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        project,
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        steps,
        inputVariables: inputVarChips,

        // Shared headers are flow-level defaults. In particular,
        // Authorization: Bearer {{access_token}} is inherited by later
        // requests and resolved by the flow runner after the login step
        // extracts access_token.
        defaultHeaders: sameLoginForAll
          ? entriesToObject(defaultHeaderEntries)
          : {},

        collection: collectionId || null,
      };
      const data = flowId
        ? await apiFetchJson(`/api/flows/${flowId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
        : await apiFetchJson("/api/flows", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      setFlowId(data._id);
      setFlows((prev) => {
        const exists = prev.some((f) => f._id === data._id);
        return exists ? prev.map((f) => (f._id === data._id ? data : f)) : [data, ...prev];
      });
      loadCollections(); // refresh flowCount badges since this save may have moved the flow
      setSelectedFlow(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const activeStep = view === "step" && openStepIndex != null ? steps[openStepIndex] : null;

  // Group the flat `flows` list by collection for the sidebar, without a
  // second network call — every flow was already fetched once for the
  // project. Flows whose `collection` doesn't match any known collection
  // (e.g. it was just deleted elsewhere) fall back to Uncategorized too.
  const collectionIds = new Set(collections.map((c) => c._id));
  const uncategorizedFlows = flows.filter((f) => !f.collection || !collectionIds.has(f.collection));
  const flowsByCollection = (id) => flows.filter((f) => f.collection === id);

  function renderFlowList(flowList) {
    return (
      <ul className="sidebar-step-list">
        {flowList.map((f) => {
          const isActive = f._id === flowId;
          return (
            <li key={f._id} className={`sidebar-flow-item ${isActive ? "active" : ""}`}>
              <button type="button" className="sidebar-flow-name" onClick={() => (isActive ? null : loadFlow(f._id))}>
                <span className="sidebar-caret">{isActive ? "▾" : "▸"}</span>
                {f.name}
              </button>
              {isActive && (
                <ul className="sidebar-step-list">
                  <li>
                    <button type="button" className={`sidebar-step-item settings ${view === "flow" ? "active" : ""}`} onClick={() => setView("flow")}>
                      ⚙ Flow settings
                    </button>
                  </li>
                  {steps.map((s, i) => (
                    <li key={s.id}>
                      <button type="button" className={`sidebar-step-item ${view === "step" && openStepIndex === i ? "active" : ""}`} onClick={() => openStep(i)}>
                        <span className="sidebar-step-num">{i + 1}</span>
                        <span className="sidebar-step-method" style={{ color: METHOD_COLOR[s.method] || "#aaa" }}>
                          {s.method}
                        </span>
                        <span className="sidebar-step-name">{s.name || "Untitled step"}</span>
                      </button>
                    </li>
                  ))}
                  <li>
                    <EndpointPicker endpoints={availableEndpoints} label="+ Add step" onPick={addStep} />
                  </li>
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className="flow-builder-shell">
      {/* --- Sidebar: collections group flows, flows group steps --- */}
      <aside className="flow-sidebar">
        <div className="sidebar-toolbar">
          <button type="button" className="sidebar-new-flow-btn" onClick={() => startNewFlow()}>
            + New Flow
          </button>
          <button type="button" className="ghost-btn sidebar-new-collection-btn" onClick={() => setAddingCollection(true)}>
            + Collection
          </button>
        </div>
        {addingCollection && (
          <InlineNameForm
            placeholder="Collection name"
            submitLabel="Add"
            onSubmit={createCollection}
            onCancel={() => setAddingCollection(false)}
          />
        )}

        {collections.map((c) => {
          const collapsed = collapsedCollections.has(c._id);
          const collectionFlows = flowsByCollection(c._id);
          return (
            <div key={c._id} className="sidebar-collection">
              {renamingCollectionId === c._id ? (
                <InlineNameForm
                  initialValue={c.name}
                  submitLabel="Save"
                  onSubmit={(newName) => renameCollection(c._id, newName)}
                  onCancel={() => setRenamingCollectionId("")}
                />
              ) : (
                <div className="sidebar-collection-header">
                  <button type="button" className="sidebar-collection-name" onClick={() => toggleCollapsed(c._id)}>
                    <span className="sidebar-caret">{collapsed ? "▸" : "▾"}</span>
                    {c.name}
                    <span className="sidebar-collection-count">{c.flowCount ?? collectionFlows.length}</span>
                  </button>
                  <div className="sidebar-collection-tools">
                    <button type="button" title="Rename" onClick={() => setRenamingCollectionId(c._id)}>
                      ✎
                    </button>
                    <button type="button" title="Delete" onClick={() => deleteCollection(c._id, c.name)}>
                      🗑
                    </button>
                  </div>
                </div>
              )}
              {!collapsed && (
                <>
                  {collectionFlows.length === 0 ? (
                    <p className="status sidebar-collection-empty">No flows here yet.</p>
                  ) : (
                    renderFlowList(collectionFlows)
                  )}
                  <button type="button" className="ghost-btn sidebar-add-flow-to-collection" onClick={() => startNewFlow(c._id)}>
                    + New flow in this collection
                  </button>
                </>
              )}
            </div>
          );
        })}

        <div className="sidebar-collection">
          <div className="sidebar-collection-header">
            <span className="sidebar-collection-name uncategorized-label">
              <span className="sidebar-caret">▾</span>
              Uncategorized
              <span className="sidebar-collection-count">{uncategorizedFlows.length}</span>
            </span>
          </div>
          {uncategorizedFlows.length === 0 ? (
            <p className="status sidebar-collection-empty">Every flow is in a collection.</p>
          ) : (
            renderFlowList(uncategorizedFlows)
          )}
        </div>
      </aside>

      {/* --- Main panel --- */}
      <div className="flow-main">
        <div className="flow-main-header">
          <h3>{name || "New flow"} <span className="flow-main-project">— {project}</span></h3>
          <button type="button" className="primary-btn save-flow-btn" onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : flowId ? "Save changes" : "Save this flow"}
          </button>
        </div>
        <GlobalTestDataBar />
        {error && <p className="status error">{error}</p>}

        {view === "flow" && (
          <div className="flow-settings-view">
            <div className="flow-section-box">
              <label className="flow-basic-field">
                What's this flow called?
                <input type="text" placeholder="e.g. Student sign-up" value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="flow-basic-field">
                Website address to test (base address — each step adds its own page to this)
                <input type="text" placeholder="https://api.example.com" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
              </label>
              <label className="flow-basic-field">
                Collection (optional — keeps related flows organized)
                <select value={collectionId} onChange={(e) => handleCollectionChange(e.target.value)}>
                  <option value="">No collection</option>
                  {collections.map((c) => (
                    <option key={c._id} value={c._id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="request-tabs">
              {FLOW_TABS.map((tab) => (
                <button key={tab} type="button" className={`request-tab ${flowTab === tab ? "active" : ""}`} onClick={() => setFlowTab(tab)}>
                  {tab}
                </button>
              ))}
            </div>

            <div className="request-tab-content">
              {flowTab === "Overview" && (
                <div>
                  {steps.length === 0 ? (
                    <p className="status">
                      Nothing built yet. Use "+ Add step" below to add your first call — usually logging in. Test
                      it, save its access token, then come back to the Login tab here so every later step gets it
                      automatically.
                    </p>
                  ) : (
                    <p className="status">
                      This flow has {steps.length} step{steps.length === 1 ? "" : "s"}. Click any step in the
                      sidebar to open it, or add another below.
                    </p>
                  )}
                  {availableEndpoints.length > 0 ? (
                    <p className="status flow-endpoint-source-hint">
                      Picking from {availableEndpoints.length} endpoint{availableEndpoints.length === 1 ? "" : "s"}{" "}
                      parsed from your Swagger/OpenAPI spec — search by path, method, or tag, or start blank.
                    </p>
                  ) : (
                    <p className="status flow-endpoint-source-hint">
                      No Swagger/OpenAPI spec loaded for this project, so steps start blank — fill in method, URL,
                      params, headers, and body by hand, same as a single request. Load a spec in the "From
                      Swagger" tab first if you'd rather pick endpoints from a list.
                    </p>
                  )}
                  <EndpointPicker endpoints={availableEndpoints} label={steps.length === 0 ? "+ Add your first step" : "+ Add another step"} onPick={addStep} />
                </div>
              )}

              {flowTab === "Values needed" && (
                <div>
                  <p className="status">
                    Type a word for each thing that's different every time you run this — like <em>username</em> or{" "}
                    <em>rollNumber</em> — then press Enter. You'll type in the real values later, when you run this
                    flow (one at a time, or all at once from a file — e.g. one row per student).
                  </p>
                  <ChipInput values={inputVarChips} onChange={setInputVarChips} placeholder="username, rollNumber, …" />
                </div>
              )}

              {flowTab === "Login" && (
                <div>
                  <div className="flow-auth-header">
                    <div>
                      <h4>Flow authentication</h4>
                      <p className="status">
                        The access token from an earlier login step is reused
                        automatically by later requests.
                      </p>
                    </div>
                    <span className="flow-auth-badge">Bearer Token</span>
                  </div>

                  <label className="same-login-toggle">
                    <input
                      type="checkbox"
                      checked={sameLoginForAll}
                      onChange={(e) => {
                        const enabled = e.target.checked;
                        setSameLoginForAll(enabled);

                        if (
                          enabled &&
                          !defaultHeaderEntries.some(
                            (row) =>
                              row.key.trim().toLowerCase() === "authorization"
                          )
                        ) {
                          setDefaultHeaderEntries([
                            {
                              key: "Authorization",
                              value: "Bearer {{access_token}}",
                            },
                            ...defaultHeaderEntries,
                          ]);
                        }
                      }}
                    />
                    Apply shared headers to all requests
                  </label>

                  {sameLoginForAll && (
                    <>
                      <div className="flow-auth-token-hint">
                        <strong>Default token</strong>
                        <span>
                          Authorization → Bearer <code>{"{{access_token}}"}</code>
                        </span>
                      </div>

                      <p className="status">
                        Step 1 can save <code>access_token</code> from the login
                        response. Every later step inherits the Authorization
                        header automatically. You can still add other shared
                        headers below.
                      </p>

                      <KeyValueTable
                        entries={defaultHeaderEntries}
                        onChange={setDefaultHeaderEntries}
                        knownVariables={allKnownVariables}
                      />
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {view === "step" && activeStep && (
          <div className="flow-step-view">
            <div className="step-nav-actions">
              <button type="button" onClick={() => moveStep(openStepIndex, -1)} disabled={openStepIndex === 0} title="Move up">
                ↑ Move up
              </button>
              <button type="button" onClick={() => moveStep(openStepIndex, 1)} disabled={openStepIndex === steps.length - 1} title="Move down">
                ↓ Move down
              </button>
              <button type="button" className="ghost-btn" onClick={() => removeStep(openStepIndex)}>
                Remove this step
              </button>
            </div>
            <FlowStepEditor
              step={activeStep}
              baseUrl={baseUrl}
              defaultHeaders={sameLoginForAll ? entriesToObject(defaultHeaderEntries) : {}}
              knownVariables={knownVariablesFor(openStepIndex)}
              onChange={(patch) => updateStep(openStepIndex, patch)}
              // Without these two, FlowStepEditor's "test this step" always
              // fell back to testing the step completely alone (its
              // flowSteps/stepIndex props default to null/0) — so a login
              // step's access_token never made it into an individually-
              // tested later step's context, even after the /test-step
              // backend route was fixed to run prerequisites. This is what
              // actually wires that up: the full step list and the index
              // of the step currently open, so the editor can send them
              // through to the backend and run everything before it first.
              flowSteps={steps}
              stepIndex={openStepIndex}
              globalColumns={globalColumns}
              globalSampleRow={globalSampleRow}
              onGlobalColumnUsed={(varName) =>
                setInputVarChips((prev) =>
                  prev.includes(varName) ? prev : [...prev, varName]
                )
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}