import { useEffect, useRef, useState } from "react";
import SwaggerEndpointPicker from "./SwaggerEndpointPicker";
import { useWorkspace } from "../context/WorkspaceContext";
import { IconApi, IconChevronDown, IconClose } from "./Icons";

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
    function handleKey(event) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  useEffect(() => {
    setOpen(false);
  }, [project]);

  const count = safeEndpoints.length;
  const hasEndpoints = count > 0;

  if (!project) return null;

  return (
    <div className="wb-spec" ref={wrapRef}>
      <button
        type="button"
        className={`wb-chip ${open ? "is-open" : ""}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        title="Load or switch the OpenAPI / Swagger specification"
      >
        <IconApi size={14} />
        <span>{hasEndpoints ? `${count} endpoint${count === 1 ? "" : "s"}` : "Load API spec"}</span>
        {hasEndpoints && <span className="wb-status-dot" aria-label="Spec loaded" />}
        <IconChevronDown size={14} />
      </button>

      {open && (
        <div className="wb-pop wb-spec-panel">
          <div className="wb-pop-head">
            <div>
              <h3>API spec</h3>
              <p>Load a Swagger / OpenAPI spec once, then pick its endpoints when adding steps.</p>
            </div>
            <button
              type="button"
              className="wb-icon-btn wb-icon-btn--sm"
              onClick={() => setOpen(false)}
              title="Close"
              aria-label="Close"
            >
              <IconClose size={14} />
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
