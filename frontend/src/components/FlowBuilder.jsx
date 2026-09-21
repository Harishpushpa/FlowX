
import { cloneElement, useEffect, useRef, useState } from "react";
import { apiFetch, apiFetchJson } from "../api";
import { useWorkspace } from "../context/WorkspaceContext";
import FlowStepEditor from "./FlowStepEditor";
import GlobalTestDataBar from "./GlobalTestDataBar";
import RowMenu from "./RowMenu";
import VariableInput from "./VariableInput";
import {
  IconArrowDown,
  IconArrowUp,
  IconChevron,
  IconFolderPlus,
  IconMenu,
  IconPlus,
  IconSearch,
  IconTrash,
} from "./Icons";

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

          <VariableInput
            className="kv-value"
            placeholder={
              row.key === "Authorization"
                ? "Bearer {{access_token}}"
                : "Header value"
            }
            value={row.value}
            onChange={(value) => setRow(i, { value })}
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
// parsed yet:
//
//   - No endpoints known: there's nothing to pick from, so the button
//     skips the dropdown entirely and adds a blank step straight away.
//   - Endpoints known: normal searchable picker, with "start with a
//     blank step" always available at the top in case the call isn't
//     in the spec (e.g. a webhook or an endpoint added since it was
//     uploaded).
//
// The list is positioned with `position: fixed` from the button's on-screen
// rect so the scrolling sidebar can't clip it.
function methodClass(method) {
  return `wb-method wb-method--${String(method || "").toLowerCase()}`;
}

function EndpointPicker({ endpoints, onPick, label, variant = "ghost" }) {
  const hasEndpoints = endpoints.length > 0;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [pos, setPos] = useState(null);
  const wrapRef = useRef(null);
  const buttonRef = useRef(null);

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

  function close() {
    setOpen(false);
    setSearch("");
  }

  useEffect(() => {
    if (!open) return undefined;
    function onDown(event) {
      if (wrapRef.current && !wrapRef.current.contains(event.target)) close();
    }
    function onKey(event) {
      if (event.key === "Escape") close();
    }
    function onResize() {
      close();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  function handlePick(ep) {
    onPick(ep);
    close();
  }

  function handleButtonClick() {
    if (!hasEndpoints) {
      // Nothing to browse — go straight to a blank step instead of
      // opening a dropdown that can only ever say "Nothing found."
      handlePick(null);
      return;
    }
    if (open) {
      close();
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      const width = Math.min(440, window.innerWidth - 16);
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      const spaceBelow = window.innerHeight - rect.bottom - 16;
      const openUp = spaceBelow < 260 && rect.top > spaceBelow;
      setPos(
        openUp
          ? { left, width, bottom: window.innerHeight - rect.top + 6, maxHeight: Math.min(440, rect.top - 16) }
          : { left, width, top: rect.bottom + 6, maxHeight: Math.min(440, Math.max(240, spaceBelow)) }
      );
    }
    setOpen(true);
  }

  return (
    <div className="wb-ep" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className={`wb-btn ${variant === "primary" ? "wb-btn--primary" : "wb-btn--dashed"} wb-btn--block`}
        onClick={handleButtonClick}
        aria-expanded={hasEndpoints ? open : undefined}
        title={hasEndpoints ? undefined : "No API spec loaded — adds a blank step you fill in by hand"}
      >
        <IconPlus size={14} />
        {label}
      </button>

      {open && hasEndpoints && pos && (
        <div className="wb-pop wb-ep-list" style={pos}>
          <div className="wb-ep-search">
            <IconSearch size={14} />
            <input
              type="text"
              autoFocus
              placeholder="Search by path, method or tag"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div className="wb-ep-scroll">
            <button type="button" className="wb-ep-option wb-ep-blank" onClick={() => handlePick(null)}>
              Blank step
              <span className="wb-muted">fill in the request by hand</span>
            </button>

            {tags.length === 0 && <div className="wb-pp-note">Nothing matches "{search}".</div>}

            {tags.map((tag) => (
              <div key={tag} className="wb-ep-group">
                <h5>
                  {tag}
                  <span className="wb-count">{grouped[tag].length}</span>
                </h5>
                {grouped[tag].map((ep) => (
                  <button type="button" key={ep.id} className="wb-ep-option" onClick={() => handlePick(ep)}>
                    <span className={methodClass(ep.method)}>{ep.method}</span>
                    <span className="wb-ep-path">{ep.path}</span>
                    {ep.summary && <span className="wb-ep-summary">{ep.summary}</span>}
                  </button>
                ))}
              </div>
            ))}
          </div>
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

const FLOW_TABS = ["Steps", "Values needed", "Login"];

export default function FlowBuilder({ runPanel = null }) {
  const {
    project,
    endpoints: availableEndpoints,
    globalColumns,
    globalSampleRow,
    selectedFlow,
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
  const [flowTab, setFlowTab] = useState("Steps");
  const [openStepIndex, setOpenStepIndex] = useState(null);

  // mainTab: "build" (edit the flow) or "run" (run it + results). The Run
  // tab is only usable once the flow has been saved.
  const [mainTab, setMainTab] = useState("build");
  // On narrow screens the flow list is a drawer instead of a fixed column.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Header "Normal Run" / "AI Run" buttons ask the run panel to start a run.
  const [runRequest, setRunRequest] = useState(null);

  // Sidebar collection UI state: which collections are collapsed, whether
  // the "new collection" inline form is open, and which collection (if
  // any) is mid-rename.
  const [collapsedCollections, setCollapsedCollections] = useState(new Set());
  const [addingCollection, setAddingCollection] = useState(false);
  const [renamingCollectionId, setRenamingCollectionId] = useState("");
  // Same idea for the flow / step currently being renamed from the sidebar.
  const [renamingFlowId, setRenamingFlowId] = useState("");
  const [renamingStepIndex, setRenamingStepIndex] = useState(null);

  // Drag-to-reorder state for the step lists (sidebar + overview cards).
  // dragOverPos tells us which half of the hovered row the pointer is over,
  // so dropping above/below the midpoint inserts on the correct side.
  const [dragStepIndex, setDragStepIndex] = useState(null);
  const [dragOverStepIndex, setDragOverStepIndex] = useState(null);
  const [dragOverPos, setDragOverPos] = useState(null);

  // Resizable sidebar: width is driven by a CSS var updated directly via ref
  // during drag (avoids a re-render per mousemove), then committed to state
  // + localStorage once the drag ends.
  const shellRef = useRef(null);
  const resizeRef = useRef(null);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem("flow-builder-sidebar-w"));
      return Number.isFinite(saved) && saved >= 220 && saved <= 480 ? saved : 276;
    } catch {
      return 276;
    }
  });
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);

  function clampSidebarWidth(w) {
    return Math.min(480, Math.max(220, w));
  }
  function handleSidebarResizeMove(e) {
    if (!resizeRef.current) return;
    const next = clampSidebarWidth(resizeRef.current.startWidth + (e.clientX - resizeRef.current.startX));
    if (shellRef.current) shellRef.current.style.setProperty("--wb-sidebar-w", `${next}px`);
  }
  function handleSidebarResizeUp(e) {
    if (!resizeRef.current) return;
    const next = clampSidebarWidth(resizeRef.current.startWidth + (e.clientX - resizeRef.current.startX));
    setSidebarWidth(next);
    try {
      localStorage.setItem("flow-builder-sidebar-w", String(next));
    } catch {
      // Ignore storage errors (private browsing, quota, etc.).
    }
    resizeRef.current = null;
    setIsResizingSidebar(false);
    document.removeEventListener("mousemove", handleSidebarResizeMove);
    document.removeEventListener("mouseup", handleSidebarResizeUp);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }
  function handleSidebarResizeDown(e) {
    e.preventDefault();
    resizeRef.current = { startX: e.clientX, startWidth: sidebarWidth };
    setIsResizingSidebar(true);
    document.addEventListener("mousemove", handleSidebarResizeMove);
    document.addEventListener("mouseup", handleSidebarResizeUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }
  // Safety net: if the component unmounts mid-drag (e.g. logging out while
  // resizing), drop the document-level listeners instead of leaking them.
  useEffect(() => {
    return () => {
      document.removeEventListener("mousemove", handleSidebarResizeMove);
      document.removeEventListener("mouseup", handleSidebarResizeUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function handleSidebarResizeReset() {
    setSidebarWidth(276);
    if (shellRef.current) shellRef.current.style.setProperty("--wb-sidebar-w", "276px");
    try {
      localStorage.setItem("flow-builder-sidebar-w", "276");
    } catch {
      // Ignore storage errors.
    }
  }

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // --- Auto-save --------------------------------------------------------
  // `baseline` is the payload as last loaded from / saved to the server; the
  // flow is "dirty" whenever the current payload differs from it. Bumping
  // `baselineVersion` (on load / reset) re-captures the baseline from the
  // freshly loaded state so loading a flow never counts as an edit.
  const [autoSave, setAutoSave] = useState(() => {
    try {
      return localStorage.getItem("flow-builder-autosave") !== "off";
    } catch {
      return true;
    }
  });
  const [baseline, setBaseline] = useState(null);
  const [baselineVersion, setBaselineVersion] = useState(0);
  const savingRef = useRef(false);
  const failedPayloadRef = useRef(null);
  // Changes whenever the open flow changes, so a save that finishes after the
  // user switched flows doesn't overwrite the newly opened one.
  const activeFlowToken = useRef(0);


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
          flow.collectionId !== id
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
      selectedFlow.collectionId === id
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
          flow.collectionId === id
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
        body: JSON.stringify({ collectionId: newCollectionId || null }),
      });
      setFlows((prev) => prev.map((f) => (f._id === flowId ? data : f)));
      loadCollections(); // refresh flowCount badges
    } catch (err) {
      setError(err.message);
    }
  }

  function resetForm() {
    activeFlowToken.current += 1;
    failedPayloadRef.current = null;
    setBaselineVersion((v) => v + 1);
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
    setFlowTab("Steps");
    setOpenStepIndex(null);
    setRenamingFlowId("");
    setRenamingStepIndex(null);
    setMainTab("build");
  }

  function loadFlow(id) {
    flushAutoSave();
    activeFlowToken.current += 1;
    failedPayloadRef.current = null;
    setBaselineVersion((v) => v + 1);
    setSidebarOpen(false);
    setFlowId(id);
    setError("");
    setRenamingFlowId("");
    setRenamingStepIndex(null);
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
    setCollectionId(flow.collectionId || "");
    setView("flow");
    setFlowTab("Steps");
    setOpenStepIndex(null);
  }

  // presetCollectionId: when "+ New flow" is clicked from inside a
  // collection's section in the sidebar, the new flow starts already
  // assigned to that collection instead of Uncategorized.
  function startNewFlow(presetCollectionId = "") {
    flushAutoSave();
    setSidebarOpen(false);
    setSelectedFlow(null);
    setFlowId("");
    resetForm();
    setCollectionId(presetCollectionId);
  }

  function updateStep(index, patch) {
    setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }
  function removeStep(index) {
    const label = steps[index]?.name || "Untitled step";
    if (!window.confirm(`Remove step "${label}" from this flow?`)) return;
    setSteps((prev) => prev.filter((_, i) => i !== index));
    if (openStepIndex === index) {
      setView("flow");
      setOpenStepIndex(null);
    }
  }

  // --- Flow rename / delete (sidebar ⋯ menu) ------------------------------
  async function renameFlow(id, rawName) {
    setError("");
    try {
      const data = await apiFetchJson(`/api/flows/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: rawName }),
      });
      setFlows((prev) => prev.map((f) => (f._id === id ? data : f)));
      if (id === flowId) {
        setName(data.name);
        setSelectedFlow(data);
      }
      setRenamingFlowId("");
    } catch (err) {
      setError(err.message);
    }
  }

  async function deleteFlow(id, flowName) {
    if (!window.confirm(`Delete flow "${flowName}"?\n\nThis cannot be undone.`)) return;
    setError("");
    try {
      await apiFetchJson(`/api/flows/${id}`, { method: "DELETE" });
      setFlows((prev) => prev.filter((f) => f._id !== id));
      if (id === flowId) startNewFlow();
      loadCollections(); // refresh flowCount badges
    } catch (err) {
      setError(err.message);
    }
  }

  // --- Step (endpoint) rename / delete (sidebar ⋯ menu) --------------------
  // For an already-saved flow the change is saved straight away, the same way
  // renaming a collection is. For a flow that hasn't been saved yet it only
  // updates the local list and goes out with the first "Save this flow".
  async function commitSteps(nextSteps) {
    if (flowId) {
      setError("");
      try {
        const data = await apiFetchJson(`/api/flows/${flowId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ steps: nextSteps }),
        });
        setFlows((prev) => prev.map((f) => (f._id === flowId ? data : f)));
        setSelectedFlow(data);
      } catch (err) {
        setError(err.message);
        return false;
      }
    }
    setSteps(nextSteps);
    return true;
  }

  async function renameStepAt(index, rawName) {
    const saved = await commitSteps(steps.map((s, i) => (i === index ? { ...s, name: rawName } : s)));
    if (saved) setRenamingStepIndex(null);
  }

  async function deleteStepAt(index) {
    const label = steps[index]?.name || "Untitled step";
    if (!window.confirm(`Delete step "${label}"?`)) return;
    const saved = await commitSteps(steps.filter((_, i) => i !== index));
    if (!saved) return;
    setRenamingStepIndex(null);
    if (openStepIndex === index) {
      setView("flow");
      setOpenStepIndex(null);
    } else if (openStepIndex != null && openStepIndex > index) {
      setOpenStepIndex(openStepIndex - 1);
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

  // General-position reorder (drag from anywhere to anywhere), unlike
  // moveStep above which only swaps adjacent steps.
  function reorderSteps(fromIndex, toIndex) {
    if (fromIndex === toIndex || fromIndex == null || toIndex == null) return;
    setSteps((prev) => {
      if (fromIndex < 0 || fromIndex >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
    setOpenStepIndex((current) => {
      if (current == null) return current;
      if (current === fromIndex) return toIndex;
      if (fromIndex < current && toIndex >= current) return current - 1;
      if (fromIndex > current && toIndex <= current) return current + 1;
      return current;
    });
  }

  function handleStepDragStart(index) {
    return (e) => {
      setDragStepIndex(index);
      e.dataTransfer.effectAllowed = "move";
      // Firefox requires data to be set for the drag to start.
      e.dataTransfer.setData("text/plain", String(index));
    };
  }
  function handleStepDragOver(index) {
    return (e) => {
      if (dragStepIndex == null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const rect = e.currentTarget.getBoundingClientRect();
      const pos = e.clientY - rect.top > rect.height / 2 ? "below" : "above";
      setDragOverStepIndex(index);
      setDragOverPos(pos);
    };
  }
  function handleStepDrop(index) {
    return (e) => {
      e.preventDefault();
      if (dragStepIndex == null) return;
      let target = index + (dragOverPos === "below" ? 1 : 0);
      if (dragStepIndex < target) target -= 1;
      reorderSteps(dragStepIndex, target);
      setDragStepIndex(null);
      setDragOverStepIndex(null);
      setDragOverPos(null);
    };
  }
  function handleStepDragEnd() {
    setDragStepIndex(null);
    setDragOverStepIndex(null);
    setDragOverPos(null);
  }
  function stepDragClass(index) {
    if (dragStepIndex === index) return "is-dragging";
    if (dragOverStepIndex === index && dragStepIndex != null) {
      return dragOverPos === "below" ? "is-drag-over-below" : "is-drag-over";
    }
    return "";
  }
  function addStep(endpoint) {
    setSteps((prev) => {
      const next = [...prev, emptyStep(endpoint)];
      setOpenStepIndex(next.length - 1);
      return next;
    });
    setView("step");
    setMainTab("build");
  }
  function openStep(i) {
    setView("step");
    setOpenStepIndex(i);
    setMainTab("build");
    setSidebarOpen(false);
  }

  function knownVariablesFor(index) {
    const fromEarlierSteps = steps.slice(0, index).flatMap((s) => (s.extract || []).map((r) => r.variable));
    return [...new Set([...inputVarChips, ...fromEarlierSteps])];
  }
  const allKnownVariables = [...new Set([...inputVarChips, ...steps.flatMap((s) => (s.extract || []).map((r) => r.variable))])];

  // The exact body sent to the server. Also used (as a string) to tell
  // whether anything changed since the last load / save.
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
    defaultHeaders: sameLoginForAll ? entriesToObject(defaultHeaderEntries) : {},

    collectionId: collectionId || null,
  };
  const payloadStr = JSON.stringify(payload);
  const isDirty = baseline !== null && payloadStr !== baseline;
  const isSaveable = Boolean(payload.name && payload.baseUrl && steps.length > 0);

  // auto=true: silent background save (no validation error, no spinner reset
  // of the error banner). auto=false: the Save button.
  async function persist({ auto = false } = {}) {
    if (savingRef.current) return false;
    if (!isSaveable) {
      if (!auto) setError("Please give this flow a name, a website address, and at least one step.");
      return false;
    }
    if (!auto) setError("");

    savingRef.current = true;
    setSaving(true);
    const token = activeFlowToken.current;
    const sentPayload = payloadStr;
    const previousCollectionId = flows.find((f) => f._id === flowId)?.collectionId;
    try {
      const data = flowId
        ? await apiFetchJson(`/api/flows/${flowId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
        : await apiFetchJson("/api/flows", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      setFlows((prev) => {
        const exists = prev.some((f) => f._id === data._id);
        return exists ? prev.map((f) => (f._id === data._id ? data : f)) : [data, ...prev];
      });
      // Only re-fetch collections when the flow count could have changed
      // (new flow, or moved to another collection). Skipping it for ordinary
      // edits keeps auto-save to a single request per save.
      if (!flowId || (previousCollectionId || null) !== (payload.collectionId || null)) loadCollections();
      if (activeFlowToken.current === token) {
        setFlowId(data._id);
        setSelectedFlow(data);
        setBaseline(sentPayload);
        failedPayloadRef.current = null;
        if (auto) setError("");
      }
      return true;
    } catch (err) {
      failedPayloadRef.current = sentPayload;
      setError(auto ? `Auto-save failed: ${err.message}` : err.message);
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  function handleSave() {
    return persist();
  }

  // Save pending edits right before the open flow is switched away.
  function flushAutoSave() {
    if (autoSave && isDirty && isSaveable && !savingRef.current) persist({ auto: true });
  }

  function toggleAutoSave(enabled) {
    setAutoSave(enabled);
    try {
      localStorage.setItem("flow-builder-autosave", enabled ? "on" : "off");
    } catch {
      // Ignore storage errors.
    }
  }

  // Re-capture the baseline once a load/reset has been rendered.
  useEffect(() => {
    setBaseline(payloadStr);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baselineVersion]);

  // Debounced background save. A payload that just failed isn't retried
  // until the user changes something again.
  useEffect(() => {
    if (!autoSave || !isDirty || !isSaveable || saving) return undefined;
    if (failedPayloadRef.current === payloadStr) return undefined;
    const timer = setTimeout(() => persist({ auto: true }), 2500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSave, payloadStr, baseline, saving]);

  // Warn before closing the tab with edits that haven't reached the server.
  useEffect(() => {
    if (!isDirty) return undefined;
    function onBeforeUnload(event) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isDirty]);

  let saveStatus = "";
  if (saving) saveStatus = "Saving…";
  else if (isDirty && failedPayloadRef.current === payloadStr) saveStatus = "Not saved";
  else if (isDirty) saveStatus = autoSave && isSaveable ? "Saving soon…" : "Unsaved changes";
  else if (flowId) saveStatus = "All changes saved";

  const activeStep = view === "step" && openStepIndex != null ? steps[openStepIndex] : null;

  // Group the flat `flows` list by collection for the sidebar, without a
  // second network call — every flow was already fetched once for the
  // project. Flows whose `collection` doesn't match any known collection
  // (e.g. it was just deleted elsewhere) fall back to Uncategorized too.
  const collectionIds = new Set(collections.map((c) => c._id));
  const uncategorizedFlows = flows.filter((f) => !f.collectionId || !collectionIds.has(f.collectionId));
  const flowsByCollection = (id) => flows.filter((f) => f.collectionId === id);

  const canRun = Boolean(selectedFlow && runPanel);
  const activeTab = canRun ? mainTab : "build";
  const hasSpec = availableEndpoints.length > 0;

  function requestRun(mode) {
    setMainTab("run");
    setRunRequest({ mode, nonce: Date.now() });
  }

  function renderFlowList(flowList) {
    return (
      <ul className="wb-list">
        {flowList.map((f) => {
          const isActive = f._id === flowId;
          return (
            <li key={f._id} className="wb-flow">
              {renamingFlowId === f._id ? (
                <InlineNameForm
                  initialValue={f.name}
                  submitLabel="Save"
                  onSubmit={(newName) => renameFlow(f._id, newName)}
                  onCancel={() => setRenamingFlowId("")}
                />
              ) : (
                <div className={`wb-row ${isActive ? "is-active" : ""}`}>
                  <button
                    type="button"
                    className="wb-row-main"
                    onClick={() => (isActive ? null : loadFlow(f._id))}
                    aria-expanded={isActive}
                  >
                    <IconChevron open={isActive} size={14} />
                    <span className="wb-row-label">{f.name}</span>
                  </button>
                  <RowMenu
                    label="Flow"
                    onRename={() => setRenamingFlowId(f._id)}
                    onDelete={() => deleteFlow(f._id, f.name)}
                  />
                </div>
              )}

              {isActive && (
                <ul className="wb-steps">
                  <li>
                    <button
                      type="button"
                      className={`wb-step wb-step--settings ${view === "flow" && activeTab === "build" ? "is-active" : ""}`}
                      onClick={() => {
                        setView("flow");
                        setMainTab("build");
                        setSidebarOpen(false);
                      }}
                    >
                      Flow settings
                    </button>
                  </li>

                  {steps.map((s, i) => (
                    <li key={s.id}>
                      {renamingStepIndex === i ? (
                        <InlineNameForm
                          initialValue={s.name || ""}
                          submitLabel="Save"
                          onSubmit={(newName) => renameStepAt(i, newName)}
                          onCancel={() => setRenamingStepIndex(null)}
                        />
                      ) : (
                        <div
                          className={`wb-row wb-row--step ${view === "step" && openStepIndex === i && activeTab === "build" ? "is-active" : ""} ${stepDragClass(i)}`}
                          draggable
                          onDragStart={handleStepDragStart(i)}
                          onDragOver={handleStepDragOver(i)}
                          onDrop={handleStepDrop(i)}
                          onDragEnd={handleStepDragEnd}
                          title="Drag to reorder"
                        >
                          <button type="button" className="wb-row-main wb-step" onClick={() => openStep(i)}>
                            <span className="wb-step-num">{i + 1}</span>
                            <span className={methodClass(s.method)}>{s.method}</span>
                            <span className="wb-row-label">{s.name || "Untitled step"}</span>
                          </button>
                          <RowMenu
                            label="Step"
                            onRename={() => setRenamingStepIndex(i)}
                            onDelete={() => deleteStepAt(i)}
                          />
                        </div>
                      )}
                    </li>
                  ))}

                  <li>
                    <EndpointPicker endpoints={availableEndpoints} label="Add step" onPick={addStep} />
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
    <div
      className={`wb-shell ${sidebarOpen ? "is-drawer-open" : ""}`}
      ref={shellRef}
      style={{ "--wb-sidebar-w": `${sidebarWidth}px` }}
    >
      {/* --- Sidebar: collections group flows, flows group steps --- */}
      <aside className="wb-sidebar" aria-label="Flows">
        <div className="wb-sidebar-top">
          <button type="button" className="wb-btn wb-btn--block" onClick={() => startNewFlow()}>
            <IconPlus size={14} />
            New flow
          </button>
          <button
            type="button"
            className="wb-icon-btn"
            onClick={() => setAddingCollection(true)}
            title="New collection"
            aria-label="New collection"
          >
            <IconFolderPlus />
          </button>
        </div>

        {addingCollection && (
          <div className="wb-sidebar-form">
            <InlineNameForm
              placeholder="Collection name"
              submitLabel="Add"
              onSubmit={createCollection}
              onCancel={() => setAddingCollection(false)}
            />
          </div>
        )}

        <nav className="wb-tree">
          {flows.length === 0 && collections.length === 0 && (
            <p className="wb-sidebar-empty">No flows yet. Create one with “New flow”.</p>
          )}

          {collections.map((c) => {
            const collapsed = collapsedCollections.has(c._id);
            const collectionFlows = flowsByCollection(c._id);
            return (
              <div key={c._id} className="wb-group">
                {renamingCollectionId === c._id ? (
                  <InlineNameForm
                    initialValue={c.name}
                    submitLabel="Save"
                    onSubmit={(newName) => renameCollection(c._id, newName)}
                    onCancel={() => setRenamingCollectionId("")}
                  />
                ) : (
                  <div className="wb-row wb-row--group">
                    <button
                      type="button"
                      className="wb-row-main"
                      onClick={() => toggleCollapsed(c._id)}
                      aria-expanded={!collapsed}
                    >
                      <IconChevron open={!collapsed} size={14} />
                      <span className="wb-row-label">{c.name}</span>
                      <span className="wb-count">{c.flowCount ?? collectionFlows.length}</span>
                    </button>
                    <button
                      type="button"
                      className="wb-icon-btn wb-icon-btn--sm wb-row-action"
                      onClick={() => startNewFlow(c._id)}
                      title={`New flow in ${c.name}`}
                      aria-label={`New flow in ${c.name}`}
                    >
                      <IconPlus size={14} />
                    </button>
                    <RowMenu
                      label="Collection"
                      onRename={() => setRenamingCollectionId(c._id)}
                      onDelete={() => deleteCollection(c._id, c.name)}
                    />
                  </div>
                )}

                {!collapsed && (
                  collectionFlows.length === 0 ? (
                    <p className="wb-group-empty">Empty</p>
                  ) : (
                    renderFlowList(collectionFlows)
                  )
                )}
              </div>
            );
          })}

          {uncategorizedFlows.length > 0 && (
            <div className="wb-group">
              {collections.length > 0 && (
                <div className="wb-row wb-row--group wb-row--static">
                  <span className="wb-row-main wb-row-main--static">
                    <span className="wb-row-label">Uncategorized</span>
                    <span className="wb-count">{uncategorizedFlows.length}</span>
                  </span>
                </div>
              )}
              {renderFlowList(uncategorizedFlows)}
            </div>
          )}
        </nav>
      </aside>

      <div
        className={`wb-resizer ${isResizingSidebar ? "is-dragging" : ""}`}
        onMouseDown={handleSidebarResizeDown}
        onDoubleClick={handleSidebarResizeReset}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize flow list panel"
        title="Drag to resize · double-click to reset"
      />

      {sidebarOpen && <button type="button" className="wb-scrim" aria-label="Close flow list" onClick={() => setSidebarOpen(false)} />}

      {/* --- Main panel --- */}
      <section className="wb-main">
        <div className="wb-main-head">
          <button
            type="button"
            className="wb-icon-btn wb-flows-toggle"
            onClick={() => setSidebarOpen(true)}
            title="Show flows"
            aria-label="Show flows"
          >
            <IconMenu />
          </button>

          <h2 className="wb-flow-title" title={name || "New flow"}>{name || "New flow"}</h2>

          <div className="wb-main-actions">
            {saveStatus && (
              <span className={`wb-save-status ${saveStatus === "Not saved" ? "is-error" : ""}`} role="status">
                {saveStatus}
              </span>
            )}
            <label
              className="wb-switch"
              title={isSaveable ? "Save changes automatically a moment after you stop typing" : "Auto-save starts once the flow has a name, a base URL and at least one step"}
            >
              <input type="checkbox" checked={autoSave} onChange={(e) => toggleAutoSave(e.target.checked)} />
              <span className="wb-switch-track" aria-hidden="true" />
              <span>Auto-save</span>
            </label>
            <GlobalTestDataBar />
            {canRun && (
              <>
                <button
                  type="button"
                  className="wb-btn"
                  onClick={() => requestRun("normal")}
                  title="Execute the flow and check its configured status rules. This does not use AI."
                >
                  Normal Run
                </button>
                <button
                  type="button"
                  className="wb-btn"
                  onClick={() => requestRun("ai")}
                  title="Use AI to infer or judge test expectations. Large batches ask for confirmation first."
                >
                  AI Run
                </button>
              </>
            )}
            <button type="button" className="wb-btn wb-btn--primary" onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : flowId ? "Save changes" : "Save flow"}
            </button>
          </div>
        </div>

        <div className="wb-tabs" role="tablist" aria-label="Flow sections">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "build"}
            className={`wb-tab ${activeTab === "build" ? "is-active" : ""}`}
            onClick={() => setMainTab("build")}
          >
            Build
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "run"}
            className={`wb-tab ${activeTab === "run" ? "is-active" : ""}`}
            onClick={() => setMainTab("run")}
            disabled={!canRun}
            title={canRun ? undefined : "Save this flow to run it"}
          >
            Run &amp; results
          </button>
        </div>

        <div className="wb-main-scroll">
          {error && <p className="wb-error" role="alert">{error}</p>}

          <div className="wb-panel" hidden={activeTab !== "build"}>
            {view === "flow" && (
              <div className="wb-settings">
                <section className="wb-card wb-fields">
                  <label className="wb-field">
                    <span>Flow name</span>
                    <input type="text" placeholder="e.g. Student sign-up" value={name} onChange={(e) => setName(e.target.value)} />
                  </label>
                  <label className="wb-field">
                    <span>Collection</span>
                    <select value={collectionId} onChange={(e) => handleCollectionChange(e.target.value)}>
                      <option value="">No collection</option>
                      {collections.map((c) => (
                        <option key={c._id} value={c._id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="wb-field wb-field--wide">
                    <span>Base URL</span>
                    <input type="text" placeholder="https://api.example.com" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
                    <small>Every step adds its own path to this address.</small>
                  </label>
                </section>

                <div className="wb-subtabs" role="tablist" aria-label="Flow settings">
                  {FLOW_TABS.map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      role="tab"
                      aria-selected={flowTab === tab}
                      className={`wb-subtab ${flowTab === tab ? "is-active" : ""}`}
                      onClick={() => setFlowTab(tab)}
                    >
                      {tab}
                      {tab === "Steps" && steps.length > 0 && <span className="wb-count">{steps.length}</span>}
                      {tab === "Values needed" && inputVarChips.length > 0 && <span className="wb-count">{inputVarChips.length}</span>}
                    </button>
                  ))}
                </div>

                <div className="wb-subpanel">
                  {flowTab === "Steps" && (
                    <div>
                      {steps.length === 0 ? (
                        <div className="wb-empty">
                          <p>No steps yet. Most flows start with a login call.</p>
                          <div className="wb-empty-action">
                            <EndpointPicker endpoints={availableEndpoints} label="Add first step" variant="primary" onPick={addStep} />
                          </div>
                        </div>
                      ) : (
                        <>
                          <ol className="wb-step-list">
                            {steps.map((s, i) => (
                              <li
                                key={s.id}
                                className={stepDragClass(i)}
                                draggable
                                onDragStart={handleStepDragStart(i)}
                                onDragOver={handleStepDragOver(i)}
                                onDrop={handleStepDrop(i)}
                                onDragEnd={handleStepDragEnd}
                                title="Drag to reorder"
                              >
                                <button type="button" className="wb-step-card" onClick={() => openStep(i)}>
                                  <span className="wb-step-num">{i + 1}</span>
                                  <span className={methodClass(s.method)}>{s.method}</span>
                                  <span className="wb-step-card-name">{s.name || "Untitled step"}</span>
                                  <span className="wb-step-card-path">{s.path}</span>
                                </button>
                              </li>
                            ))}
                          </ol>
                          <div className="wb-step-add">
                            <EndpointPicker endpoints={availableEndpoints} label="Add step" onPick={addStep} />
                          </div>
                        </>
                      )}
                      {!hasSpec && (
                        <p className="wb-help">
                          No API spec loaded, so new steps start blank. Load one from the top bar to pick endpoints instead.
                        </p>
                      )}
                    </div>
                  )}

                  {flowTab === "Values needed" && (
                    <div>
                      <p className="wb-help">
                        Name what changes on every run, like <em>username</em> or <em>rollNumber</em>, and press Enter after each.
                        You'll fill in the real values when you run the flow, one at a time or from a file.
                      </p>
                      <ChipInput values={inputVarChips} onChange={setInputVarChips} placeholder="username, rollNumber, …" />
                    </div>
                  )}

                  {flowTab === "Login" && (
                    <div>
                      <p className="wb-help">
                        Headers sent with every step. A step that saves <code>access_token</code> from a login response
                        passes it on to the steps after it.
                      </p>

                      <label className="wb-toggle">
                        <input
                          type="checkbox"
                          checked={sameLoginForAll}
                          onChange={(e) => {
                            const enabled = e.target.checked;
                            setSameLoginForAll(enabled);

                            if (
                              enabled &&
                              !defaultHeaderEntries.some(
                                (row) => row.key.trim().toLowerCase() === "authorization"
                              )
                            ) {
                              setDefaultHeaderEntries([
                                { key: "Authorization", value: "Bearer {{access_token}}" },
                                ...defaultHeaderEntries,
                              ]);
                            }
                          }}
                        />
                        <span>Send these headers with every step</span>
                      </label>

                      {sameLoginForAll && (
                        <KeyValueTable
                          entries={defaultHeaderEntries}
                          onChange={setDefaultHeaderEntries}
                          knownVariables={allKnownVariables}
                        />
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {view === "step" && activeStep && (
              <div className="wb-step-view">
                <div className="wb-step-bar">
                  <span className="wb-muted">Step {openStepIndex + 1} of {steps.length}</span>
                  <div className="wb-icon-group">
                    <button
                      type="button"
                      className="wb-icon-btn wb-icon-btn--sm"
                      onClick={() => moveStep(openStepIndex, -1)}
                      disabled={openStepIndex === 0}
                      title="Move step up"
                      aria-label="Move step up"
                    >
                      <IconArrowUp size={14} />
                    </button>
                    <button
                      type="button"
                      className="wb-icon-btn wb-icon-btn--sm"
                      onClick={() => moveStep(openStepIndex, 1)}
                      disabled={openStepIndex === steps.length - 1}
                      title="Move step down"
                      aria-label="Move step down"
                    >
                      <IconArrowDown size={14} />
                    </button>
                    <button
                      type="button"
                      className="wb-icon-btn wb-icon-btn--sm wb-icon-btn--danger"
                      onClick={() => removeStep(openStepIndex)}
                      title="Remove this step"
                      aria-label="Remove this step"
                    >
                      <IconTrash size={14} />
                    </button>
                  </div>
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

          {runPanel && (
            <div className="wb-panel wb-run" hidden={activeTab !== "run"}>
              {cloneElement(runPanel, { runRequest })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
