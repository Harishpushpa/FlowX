import { useEffect, useMemo, useRef, useState } from "react";
import { useWorkspace } from "../context/WorkspaceContext";
import { IconChevronDown, IconCheck, IconPlus, IconSearch } from "./Icons";

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
    <div className="wb-pp" ref={pickerRef}>
      <button
        type="button"
        className={`wb-pp-trigger ${open ? "is-open" : ""}`}
        onClick={() => (open ? closePicker() : openPicker())}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Switch project"
      >
        <span className="wb-pp-dot" aria-hidden="true" />
        <span className="wb-pp-name">{project || "Select a project"}</span>
        <IconChevronDown size={14} />
      </button>

      {open && (
        <div className="wb-pop wb-pp-menu" role="listbox" aria-label="Projects">
          <div className="wb-pp-search">
            <IconSearch size={14} />
            <input
              ref={searchInputRef}
              type="text"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setCreateError("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") closePicker();
                if (event.key === "Enter" && canCreate) {
                  event.preventDefault();
                  handleCreate();
                }
              }}
              placeholder="Search or create a project"
              autoComplete="off"
              aria-label="Search or create a project"
            />
          </div>

          {projectsError && (
            <div className="wb-pp-note wb-pp-note--error">
              {projectsError}{" "}
              <button type="button" className="wb-link" onClick={loadProjects}>Retry</button>
            </div>
          )}

          <div className="wb-pp-options">
            {projectsLoading ? (
              <div className="wb-pp-note">Loading projects…</div>
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
                      className={`wb-pp-option ${selected ? "is-selected" : ""}`}
                      onClick={() => handleSelect(item)}
                    >
                      <span className="wb-pp-option-name">{item}</span>
                      {selected && <IconCheck size={14} />}
                    </button>
                  );
                })}

                {canCreate && (
                  <button
                    type="button"
                    className="wb-pp-option wb-pp-create"
                    onClick={handleCreate}
                    disabled={creating}
                  >
                    <IconPlus size={14} />
                    <span className="wb-pp-option-name">
                      {creating ? "Creating…" : `Create "${trimmedSearch}"`}
                    </span>
                  </button>
                )}

                {!filteredProjects.length && !canCreate && (
                  <div className="wb-pp-note">Type a name to create your first project.</div>
                )}
              </>
            )}
          </div>

          {createError && <div className="wb-pp-note wb-pp-note--error">{createError}</div>}
        </div>
      )}
    </div>
  );
}
