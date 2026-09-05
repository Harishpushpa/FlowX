import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../api";

const METHOD_COLOR = {
  GET: "#3fd67a",
  POST: "#ffb020",
  PUT: "#4da3ff",
  PATCH: "#c792ff",
  DELETE: "#ff5c6c",
  OPTIONS: "#9a9aad",
  HEAD: "#9a9aad",
};

function SchemaFields({ endpoint }) {
  const parameters = Array.isArray(endpoint?.parameters)
    ? endpoint.parameters
    : [];

  const bodyFields = Array.isArray(endpoint?.requestBody?.fields)
    ? endpoint.requestBody.fields
    : [];

  if (!parameters.length && !bodyFields.length) {
    return (
      <div className="swagger-picker-schema-empty">
        No parameters or request body.
      </div>
    );
  }

  return (
    <div className="swagger-picker-schema">
      {parameters.length > 0 && (
        <div className="swagger-picker-schema-group">
          <h5>Parameters</h5>

          <table className="swagger-picker-schema-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>In</th>
                <th>Type</th>
                <th>Required</th>
                <th>Example</th>
              </tr>
            </thead>

            <tbody>
              {parameters.map((p) => (
                <tr key={`${p.in}-${p.name}`}>
                  <td className="schema-field-name">
                    {p.name}
                  </td>

                  <td className="schema-field-in">
                    {p.in}
                  </td>

                  <td className="schema-field-type">
                    {p.enum?.length
                      ? `enum(${p.enum.join(", ")})`
                      : p.type || "string"}
                  </td>

                  <td>
                    {p.required ? (
                      <span className="schema-required">required</span>
                    ) : (
                      <span className="schema-optional">optional</span>
                    )}
                  </td>

                  <td className="schema-field-example">
                    {p.example !== undefined &&
                    p.example !== null
                      ? String(p.example)
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {bodyFields.length > 0 && (
        <div className="swagger-picker-schema-group">
          <h5>
            Request body
            {endpoint.requestBody?.required
              ? " · required"
              : " · optional"}

            {endpoint.requestBody?.contentType
              ? ` · ${endpoint.requestBody.contentType}`
              : ""}
          </h5>

          <table className="swagger-picker-schema-table">
            <thead>
              <tr>
                <th>Field</th>
                <th>Type</th>
                <th>Required</th>
                <th>Example</th>
              </tr>
            </thead>

            <tbody>
              {bodyFields.map((field) => (
                <tr key={field.path}>
                  <td className="schema-field-name">
                    {field.path}
                  </td>

                  <td className="schema-field-type">
                    {field.enum?.length
                      ? `enum(${field.enum.join(", ")})`
                      : field.type || "string"}
                  </td>

                  <td>
                    {field.required ? (
                      <span className="schema-required">
                        required
                      </span>
                    ) : (
                      <span className="schema-optional">
                        optional
                      </span>
                    )}
                  </td>

                  <td className="schema-field-example">
                    {field.example !== undefined &&
                    field.example !== null
                      ? String(field.example)
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function EndpointRow({
  endpoint,
  selected,
  expanded,
  onToggle,
  onExpand,
}) {
  const parameterCount = Array.isArray(endpoint.parameters)
    ? endpoint.parameters.length
    : 0;

  const bodyFieldCount = Array.isArray(
    endpoint.requestBody?.fields
  )
    ? endpoint.requestBody.fields.length
    : 0;

  const hasSchema =
    parameterCount > 0 || bodyFieldCount > 0;

  return (
    <div className="swagger-picker-endpoint">
      <div className="swagger-picker-row">
        <label className="swagger-picker-checkbox-label">
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggle(endpoint.id)}
          />

          <span
            className="swagger-picker-method"
            style={{
              color:
                METHOD_COLOR[endpoint.method] || "#aaa",
            }}
          >
            {endpoint.method}
          </span>

          <span className="swagger-picker-path">
            {endpoint.path}
          </span>

          {endpoint.requestBody && (
            <span
              className="swagger-picker-badge"
              title="This endpoint has a request body"
            >
              body
            </span>
          )}

          {parameterCount > 0 && (
            <span
              className="swagger-picker-badge"
              title={`${parameterCount} parameter(s)`}
            >
              {parameterCount} params
            </span>
          )}

          {endpoint.summary && (
            <span className="swagger-picker-summary">
              {endpoint.summary}
            </span>
          )}
        </label>

        {hasSchema && (
          <button
            type="button"
            className="swagger-picker-schema-toggle"
            onClick={() => onExpand(endpoint.id)}
          >
            {expanded ? "Hide schema ▲" : "Show schema ▼"}
          </button>
        )}
      </div>

      {expanded && (
        <SchemaFields endpoint={endpoint} />
      )}
    </div>
  );
}

export default function SwaggerEndpointPicker({
  project,
  onSelectionChange,
}) {
  const [url, setUrl] = useState("");

  const [meta, setMeta] = useState(null);
  const [endpoints, setEndpoints] = useState([]);

  const [selected, setSelected] = useState(
    new Set()
  );

  const [expanded, setExpanded] = useState(
    new Set()
  );

  const [search, setSearch] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [savedSpecs, setSavedSpecs] = useState([]);
  const [savedSpecsLoading, setSavedSpecsLoading] =
    useState(false);

  const [activeSpecId, setActiveSpecId] =
    useState("");

  const [saveName, setSaveName] = useState("");
  const [saving, setSaving] = useState(false);

  async function loadSavedSpecs() {
    if (!project) {
      setSavedSpecs([]);
      return;
    }

    setSavedSpecsLoading(true);

    try {
      const res = await apiFetch(
        `/api/swagger-specs?project=${encodeURIComponent(
          project
        )}`
      );

      if (!res.ok) {
        throw new Error(
          `Could not load saved specs (${res.status})`
        );
      }

      const data = await res.json();

      setSavedSpecs(
        Array.isArray(data) ? data : []
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setSavedSpecsLoading(false);
    }
  }

  useEffect(() => {
    loadSavedSpecs();

    setUrl("");
    setMeta(null);
    setEndpoints([]);
    setSelected(new Set());
    setExpanded(new Set());
    setActiveSpecId("");
    setSearch("");

    onSelectionChange?.([], new Set());

    // project is the intentional reset boundary
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  function applyEndpoints(list) {
    const safe = Array.isArray(list)
      ? list
      : [];

    setEndpoints(safe);

    const all = new Set(
      safe.map((endpoint) => endpoint.id)
    );

    setSelected(all);

    onSelectionChange?.(safe, all);
  }

  async function fetchAndParse() {
    const source = url.trim();

    if (!source) {
      setError("Enter a Swagger/OpenAPI URL.");
      return;
    }

    setLoading(true);
    setError("");
    setMeta(null);
    setActiveSpecId("");

    try {
      const res = await apiFetch(
        "/api/test-from-spec/parse-url",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            url: source,
          }),
        }
      );

      const data = await res.json();

      if (!res.ok) {
        throw new Error(
          data.error || "Failed to parse Swagger/OpenAPI"
        );
      }

      setMeta({
        title: data.title || "OpenAPI specification",
        version: data.version || "",
        baseUrl: data.baseUrl || "",
        total: data.totalEndpoints || 0,
      });

      setSaveName(
        data.title || "Swagger API"
      );

      applyEndpoints(data.endpoints || []);
    } catch (err) {
      setEndpoints([]);
      setSelected(new Set());
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function selectSavedSpec(id) {
    setActiveSpecId(id);
    setError("");

    if (!id) {
      setMeta(null);
      setEndpoints([]);
      setSelected(new Set());
      setExpanded(new Set());

      onSelectionChange?.([], new Set());

      return;
    }

    setLoading(true);

    try {
      const res = await apiFetch(
        `/api/swagger-specs/${id}`
      );

      const data = await res.json();

      if (!res.ok) {
        throw new Error(
          data.error ||
            "Could not load saved Swagger specification"
        );
      }

      setUrl(data.sourceUrl || "");

      setMeta({
        title: data.title || "OpenAPI specification",
        version: data.version || "",
        baseUrl: data.baseUrl || "",
        total: Array.isArray(data.endpoints)
          ? data.endpoints.length
          : 0,
      });

      applyEndpoints(data.endpoints || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function saveSpec() {
    const name = saveName.trim();

    if (
      !project ||
      !name ||
      endpoints.length === 0
    ) {
      return;
    }

    setSaving(true);
    setError("");

    try {
      const res = await apiFetch(
        "/api/swagger-specs",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            project,
            name,
            sourceUrl: url.trim(),
            title: meta?.title || "",
            version: meta?.version || "",
            baseUrl: meta?.baseUrl || "",
            endpoints,
          }),
        }
      );

      const data = await res.json();

      if (!res.ok) {
        throw new Error(
          data.error || "Could not save Swagger spec"
        );
      }

      setActiveSpecId(data._id);

      await loadSavedSpecs();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function deleteSavedSpec(id, name) {
    if (
      !window.confirm(
        `Delete saved spec "${name}"?`
      )
    ) {
      return;
    }

    try {
      const res = await apiFetch(
        `/api/swagger-specs/${id}`,
        {
          method: "DELETE",
        }
      );

      if (!res.ok) {
        const data = await res
          .json()
          .catch(() => ({}));

        throw new Error(
          data.error ||
            "Could not delete saved spec"
        );
      }

      setSavedSpecs((prev) =>
        prev.filter((spec) => spec._id !== id)
      );

      if (activeSpecId === id) {
        setActiveSpecId("");
        setMeta(null);
        setEndpoints([]);
        setSelected(new Set());
        setExpanded(new Set());

        onSelectionChange?.([], new Set());
      }
    } catch (err) {
      setError(err.message);
    }
  }

  function toggleEndpoint(id) {
    setSelected((previous) => {
      const next = new Set(previous);

      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }

      onSelectionChange?.(endpoints, next);

      return next;
    });
  }

  function toggleAll() {
    const next =
      selected.size === endpoints.length
        ? new Set()
        : new Set(
            endpoints.map(
              (endpoint) => endpoint.id
            )
          );

    setSelected(next);

    onSelectionChange?.(endpoints, next);
  }

  function toggleExpanded(id) {
    setExpanded((previous) => {
      const next = new Set(previous);

      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }

      return next;
    });
  }

  const filteredEndpoints = useMemo(() => {
    const term = search
      .trim()
      .toLowerCase();

    if (!term) {
      return endpoints;
    }

    return endpoints.filter((endpoint) => {
      return (
        endpoint.path
          ?.toLowerCase()
          .includes(term) ||
        endpoint.method
          ?.toLowerCase()
          .includes(term) ||
        endpoint.summary
          ?.toLowerCase()
          .includes(term) ||
        endpoint.tag
          ?.toLowerCase()
          .includes(term) ||
        endpoint.operationId
          ?.toLowerCase()
          .includes(term)
      );
    });
  }, [endpoints, search]);

  const grouped = useMemo(() => {
    return filteredEndpoints.reduce(
      (result, endpoint) => {
        const tag =
          endpoint.tag || "Other";

        if (!result[tag]) {
          result[tag] = [];
        }

        result[tag].push(endpoint);

        return result;
      },
      {}
    );
  }, [filteredEndpoints]);

  const selectedCount = selected.size;

  const isUnsavedParse =
    endpoints.length > 0 && !activeSpecId;

  return (
    <div className="swagger-picker">

      {/* Saved specs */}
      <div className="swagger-picker-saved">
        <div className="swagger-picker-saved-head">
          <strong>Saved Swagger / OpenAPI</strong>

          {savedSpecsLoading && (
            <span className="swagger-picker-muted">
              loading…
            </span>
          )}
        </div>

        {savedSpecs.length === 0 &&
          !savedSpecsLoading && (
            <p className="status swagger-picker-muted">
              No saved specification for this
              project yet.
            </p>
          )}

        {savedSpecs.length > 0 && (
          <div className="swagger-picker-saved-row">
            <select
              className="swagger-picker-saved-select"
              value={activeSpecId}
              onChange={(event) =>
                selectSavedSpec(
                  event.target.value
                )
              }
            >
              <option value="">
                Select a saved spec…
              </option>

              {savedSpecs.map((spec) => (
                <option
                  key={spec._id}
                  value={spec._id}
                >
                  {spec.name}
                  {spec.version
                    ? ` — v${spec.version}`
                    : ""}
                </option>
              ))}
            </select>

            {activeSpecId && (
              <button
                type="button"
                className="swagger-picker-saved-delete"
                onClick={() => {
                  const spec =
                    savedSpecs.find(
                      (item) =>
                        item._id ===
                        activeSpecId
                    );

                  deleteSavedSpec(
                    activeSpecId,
                    spec?.name ||
                      "this specification"
                  );
                }}
              >
                Delete
              </button>
            )}
          </div>
        )}
      </div>

      {/* URL parser */}
      <div className="swagger-picker-input-row">
        <input
          value={url}
          onChange={(event) =>
            setUrl(event.target.value)
          }
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              fetchAndParse();
            }
          }}
          placeholder="https://example.com/swagger.json"
        />

        <button
          type="button"
          onClick={fetchAndParse}
          disabled={loading}
        >
          {loading ? "Parsing…" : "Parse Swagger"}
        </button>
      </div>

      {error && (
        <p className="status swagger-picker-error">
          {error}
        </p>
      )}

      {/* Parsed metadata */}
      {meta && (
        <div className="swagger-picker-meta">
          <strong>{meta.title}</strong>

          {meta.version && (
            <span>
              {" "}
              · v{meta.version}
            </span>
          )}

          {meta.baseUrl && (
            <span className="swagger-picker-muted">
              {" "}
              · {meta.baseUrl}
            </span>
          )}

          <span className="swagger-picker-muted">
            {" "}
            · {meta.total} endpoints
          </span>
        </div>
      )}

      {/* Save parsed spec */}
      {isUnsavedParse && (
        <div className="swagger-picker-save-row">
          <input
            value={saveName}
            onChange={(event) =>
              setSaveName(event.target.value)
            }
            placeholder="Name for this specification"
          />

          <button
            type="button"
            onClick={saveSpec}
            disabled={
              saving ||
              !saveName.trim()
            }
          >
            {saving
              ? "Saving…"
              : "Save this spec"}
          </button>
        </div>
      )}

      {/* Endpoint catalog */}
      {endpoints.length > 0 && (
        <div className="swagger-picker-catalog">

          <div className="swagger-picker-toolbar">
            <div>
              <strong>
                API endpoints
              </strong>

              <span className="swagger-picker-muted">
                {" "}
                {selectedCount} selected
              </span>
            </div>

            <button
              type="button"
              className="ghost-btn"
              onClick={toggleAll}
            >
              {selectedCount ===
              endpoints.length
                ? "Clear all"
                : "Select all"}
            </button>
          </div>

          <div className="swagger-picker-search">
            <input
              value={search}
              onChange={(event) =>
                setSearch(event.target.value)
              }
              placeholder="Search endpoint, method, tag, operation…"
            />
          </div>

          {Object.keys(grouped).length === 0 && (
            <p className="status">
              No endpoint matches your search.
            </p>
          )}

          {Object.entries(grouped).map(
            ([tag, tagEndpoints]) => (
              <div
                key={tag}
                className="swagger-picker-group"
              >
                <h4>
                  {tag}
                  <span className="swagger-picker-group-count">
                    {tagEndpoints.length}
                  </span>
                </h4>

                {tagEndpoints.map(
                  (endpoint) => (
                    <EndpointRow
                      key={endpoint.id}
                      endpoint={endpoint}
                      selected={selected.has(
                        endpoint.id
                      )}
                      expanded={expanded.has(
                        endpoint.id
                      )}
                      onToggle={
                        toggleEndpoint
                      }
                      onExpand={
                        toggleExpanded
                      }
                    />
                  )
                )}
              </div>
            )
          )}
        </div>
      )}

      {!loading &&
        !error &&
        endpoints.length === 0 && (
          <div className="swagger-picker-empty">
            <strong>
              Load your Swagger/OpenAPI
              specification
            </strong>

            <p>
              Once loaded, every endpoint
              becomes available when creating
              a flow step.
            </p>
          </div>
        )}
    </div>
  );
}