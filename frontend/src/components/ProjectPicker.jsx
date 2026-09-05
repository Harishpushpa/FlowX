import { useEffect, useMemo, useRef, useState } from "react";
import { useWorkspace } from "../context/WorkspaceContext";

export default function ProjectPicker() {
  const {
    project,
    projects,
    projectsLoading,
    projectsError,
    switchProject,
    createProject,
    loadProjects,
  } = useWorkspace();

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  const pickerRef = useRef(null);
  const searchInputRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(event) {
      if (pickerRef.current && !pickerRef.current.contains(event.target)) {
        setOpen(false);
        setSearch("");
        setCreateError("");
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const filteredProjects = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return projects;

    return projects.filter((item) =>
      String(item).toLowerCase().includes(query)
    );
  }, [projects, search]);

  const trimmedSearch = search.trim();
  const exactExists = projects.some(
    (item) => String(item).toLowerCase() === trimmedSearch.toLowerCase()
  );
  const canCreate = Boolean(trimmedSearch) && !exactExists;

  function openPicker() {
    setOpen(true);
    setCreateError("");
    setTimeout(() => searchInputRef.current?.focus(), 0);
  }

  function closePicker() {
    setOpen(false);
    setSearch("");
    setCreateError("");
  }

  async function handleCreate() {
    if (!canCreate || creating) return;

    setCreating(true);
    setCreateError("");

    try {
      await createProject(trimmedSearch);
      closePicker();
    } catch (error) {
      setCreateError(error.message || "Could not create project");
    } finally {
      setCreating(false);
    }
  }

  function handleSelect(name) {
    if (name === project) {
      closePicker();
      return;
    }

    switchProject(name);
    closePicker();
  }

  return (
    <div className="project-picker" ref={pickerRef}>
      <button
        type="button"
        className={`project-picker-trigger ${open ? "project-picker-trigger--open" : ""}`}
        onClick={() => (open ? closePicker() : openPicker())}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="project-picker-current">
          <span className="project-picker-current-icon">
            <span className="project-picker-status-dot" />
          </span>

          <span className="project-picker-current-text">
            <span className="project-picker-current-name">
              {project || "Select a project"}
            </span>
            <span className="project-picker-current-hint">
              {project ? "Project workspace" : "Choose or create a project"}
            </span>
          </span>
        </span>

        <span
          className={`project-picker-chevron ${open ? "project-picker-chevron--open" : ""}`}
          aria-hidden="true"
        >
          ▾
        </span>
      </button>

      {open && (
        <div className="project-picker-menu" role="listbox" aria-label="Projects">
          <div className="project-picker-menu-header">
            <span>Projects</span>
            <span className="project-picker-menu-count">
              {projects.length}
            </span>
          </div>

          <div className="project-picker-search-wrap">
            <span className="project-picker-search-icon" aria-hidden="true">⌕</span>

            <input
              ref={searchInputRef}
              type="text"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setCreateError("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && canCreate) {
                  event.preventDefault();
                  handleCreate();
                }
              }}
              placeholder="Search or create project..."
              autoComplete="off"
              aria-label="Search or create project"
            />

            {search && (
              <button
                type="button"
                className="project-picker-search-clear"
                onClick={() => {
                  setSearch("");
                  setCreateError("");
                  searchInputRef.current?.focus();
                }}
                aria-label="Clear project search"
              >
                ×
              </button>
            )}
          </div>

          {projectsError && (
            <div className="project-picker-menu-error">
              {projectsError}
              <button type="button" onClick={loadProjects}>Retry</button>
            </div>
          )}

          <div className="project-picker-options">
            {projectsLoading ? (
              <div className="project-picker-menu-empty">
                Loading projects...
              </div>
            ) : (
              <>
                {filteredProjects.map((item) => {
                  const selected = item === project;

                  return (
                    <button
                      type="button"
                      key={item}
                      role="option"
                      aria-selected={selected}
                      className={`project-picker-option ${selected ? "project-picker-option--selected" : ""}`}
                      onClick={() => handleSelect(item)}
                    >
                      <span className="project-picker-option-icon">
                        <span className="project-picker-option-dot" />
                      </span>

                      <span className="project-picker-option-content">
                        <span className="project-picker-option-name">{item}</span>
                        <span className="project-picker-option-subtitle">
                          Project workspace
                        </span>
                      </span>

                      {selected && (
                        <span className="project-picker-option-check">✓</span>
                      )}
                    </button>
                  );
                })}

                {canCreate && (
                  <button
                    type="button"
                    className="project-picker-create-option"
                    onClick={handleCreate}
                    disabled={creating}
                  >
                    <span className="project-picker-create-icon">
                      {creating ? "…" : "+"}
                    </span>
                    <span className="project-picker-create-content">
                      <span className="project-picker-create-name">
                        {creating ? "Creating project..." : `Create "${trimmedSearch}"`}
                      </span>
                      <span className="project-picker-create-subtitle">
                        Start a separate project workspace
                      </span>
                    </span>
                  </button>
                )}

                {!filteredProjects.length && !canCreate && !projectsLoading && (
                  <div className="project-picker-menu-empty">
                    No projects available.
                  </div>
                )}
              </>
            )}
          </div>

          {createError && (
            <div className="project-picker-menu-error">{createError}</div>
          )}

          <div className="project-picker-menu-footer">
            <span>{filteredProjects.length} matching</span>
            <button type="button" onClick={closePicker}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
