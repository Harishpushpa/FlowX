import { useEffect, useRef, useState } from "react";
import SwaggerEndpointPicker from "./SwaggerEndpointPicker";
import { useWorkspace } from "../context/WorkspaceContext";

export default function SwaggerSpecBar() {
  const {
    project,
    endpoints,
    setEndpointsForProject,
  } = useWorkspace();

  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  const safeEndpoints = Array.isArray(endpoints) ? endpoints : [];

  useEffect(() => {
    if (!open) return;

    function handleClickOutside(event) {
      if (wrapRef.current && !wrapRef.current.contains(event.target)) {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  useEffect(() => {
    setOpen(false);
  }, [project]);

  const hasEndpoints = safeEndpoints.length > 0;
  const label = !project
    ? "Swagger / OpenAPI"
    : hasEndpoints
      ? `Swagger · ${safeEndpoints.length} endpoints`
      : "Load Swagger / OpenAPI";

  return (
    <div className="swagger-bar" ref={wrapRef}>
      <button
        type="button"
        className={`swagger-bar-toggle ${open ? "is-open" : ""}`}
        onClick={() => setOpen((value) => !value)}
        disabled={!project}
        title={project ? "Load or switch the OpenAPI specification" : "Pick a project first"}
      >
        <span className={`swagger-bar-status ${hasEndpoints ? "ready" : ""}`} />
        <span className="swagger-bar-copy">
          <small>API SPEC</small>
          <strong>{label}</strong>
        </span>
        <span className="swagger-bar-chevron">{open ? "⌃" : "⌄"}</span>
      </button>

      {open && project && (
        <div className="swagger-bar-panel">
          <div className="swagger-panel-head">
            <div>
              <span className="toolbar-eyebrow">API CONTRACT</span>
              <h3>Swagger</h3>
              <p>
                Load a specification once, then use its endpoints directly in your flows.
              </p>
            </div>

            <button
              type="button"
              className="swagger-close"
              onClick={() => setOpen(false)}
              title="Close"
            >
              ×
            </button>
          </div>

          <SwaggerEndpointPicker
            key={project}
            project={project}
            onSelectionChange={(eps) => {
              setEndpointsForProject(project, eps);
            }}
          />
        </div>
      )}
    </div>
  );
}
