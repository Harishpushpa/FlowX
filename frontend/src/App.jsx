import { useEffect, useRef, useState } from "react";
import Login from "./components/Login";
import ProjectPicker from "./components/ProjectPicker";
import SwaggerSpecBar from "./components/SwaggerSpecBar";
import FlowBuilder from "./components/FlowBuilder";
import FlowRunHistory from "./components/FlowRunHistory";
import { apiFetchJson, clearAuth, getAuthHeader, getSavedUsername } from "./api";
import { WorkspaceProvider, useWorkspace } from "./context/WorkspaceContext";
import { IconLogout, IconMoon, IconSun } from "./components/Icons";
import "./App.css";
import "./workspace.css";

function WorkspaceApp({ user, onLogout }) {
  const {
    project,
    projects,
    selectedFlow,
    switchProject,
    setSelectedFlow,
  } = useWorkspace();

  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem("flow-builder-theme") || "light";
    } catch {
      return "light";
    }
  });
  const [queue, setQueue] = useState(null);

  // Live run-queue status for the header (refreshes every 15s and after a run).
  useEffect(() => {
    let cancelled = false;
    const loadQueue = () => apiFetchJson("/api/queue")
      .then((data) => { if (!cancelled) setQueue(data); })
      .catch(() => { if (!cancelled) setQueue(null); });
    loadQueue();
    const intervalId = window.setInterval(loadQueue, 15000);
    window.addEventListener("flow-run-completed", loadQueue);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener("flow-run-completed", loadQueue);
    };
  }, [project]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    document.body.setAttribute("data-theme", theme);

    try {
      localStorage.setItem("flow-builder-theme", theme);
    } catch {
      // Ignore storage errors.
    }
  }, [theme]);

  function handleLogout() {
    clearAuth();
    switchProject("");
    setSelectedFlow(null);
    onLogout();
  }

  const queueBusy = (queue?.activeRuns || 0) > 0 || (queue?.queuedRuns || 0) > 0;
  const queueLabel = queue
    ? `Queue ${queue.activeRuns}/${queue.maxConcurrentRuns}${queue.queuedRuns > 0 ? ` · ${queue.queuedRuns} waiting` : ""}`
    : "";

  return (
    <div className="app app--workspace wb-app">
      <header className="wb-topbar">
        <div className="wb-brand">
          <span className="wb-brand-mark" aria-hidden="true" />
          <span>Flow Builder</span>
        </div>

        <span className="wb-topbar-sep" aria-hidden="true" />

        <ProjectPicker />
        <SwaggerSpecBar />

        {queue && project && (
          <span className="wb-chip wb-chip--static" title="Runs using the execution queue (active / maximum)">
            <span className={`wb-status-dot ${queueBusy ? "wb-status-dot--live" : ""}`} aria-hidden="true" />
            {queueLabel}
          </span>
        )}

        <div className="wb-topbar-spacer" />

        <button
          type="button"
          className="wb-icon-btn"
          title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
        >
          {theme === "dark" ? <IconSun /> : <IconMoon />}
        </button>

        <UserMenu user={user} onLogout={handleLogout} />
      </header>

      <main className="wb-body">
        {!project ? (
          <section className="wb-welcome">
            <h1>Choose a project</h1>
            <p>
              Flows, collections, API specs and test data are kept separately for each project.
            </p>

            {projects.length > 0 && (
              <div className="wb-welcome-projects">
                {projects.map((item) => (
                  <button
                    key={item}
                    type="button"
                    className="wb-btn"
                    onClick={() => switchProject(item)}
                  >
                    {item}
                  </button>
                ))}
              </div>
            )}

            <p className="wb-muted">
              {projects.length > 0
                ? "Or create a new one from the project menu at the top."
                : "Use the project menu at the top to create your first project."}
            </p>
          </section>
        ) : (
          <FlowBuilder runPanel={selectedFlow ? <FlowRunHistory /> : null} />
        )}
      </main>
    </div>
  );
}

function UserMenu({ user, onLogout }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function onDown(event) {
      if (ref.current && !ref.current.contains(event.target)) setOpen(false);
    }
    function onKey(event) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="wb-user" ref={ref}>
      <button
        type="button"
        className="wb-avatar"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Signed in as ${user}`}
        aria-label={`Account menu for ${user}`}
      >
        {String(user).slice(0, 1).toUpperCase()}
      </button>

      {open && (
        <div className="wb-pop wb-user-menu" role="menu">
          <div className="wb-user-name">
            <span className="wb-muted">Signed in as</span>
            <strong>{user}</strong>
          </div>
          <button type="button" role="menuitem" className="wb-menu-item" onClick={onLogout}>
            <IconLogout size={14} />
            Log out
          </button>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [checkingSession, setCheckingSession] =
    useState(true);

  useEffect(() => {
    let cancelled = false;

    async function checkSession() {
      const authHeader = getAuthHeader();
      const username = getSavedUsername();

      if (!authHeader || !username) {
        if (!cancelled) {
          setCheckingSession(false);
        }

        return;
      }

      try {
        const res = await fetch("/api/login", {
          method: "POST",
          headers: {
            Authorization: authHeader,
          },
        });

        if (cancelled) {
          return;
        }

        if (res.ok) {
          setUser(username);
        } else {
          clearAuth();
          setUser(null);
        }
      } catch {
        if (!cancelled) {
          clearAuth();
          setUser(null);
        }
      } finally {
        if (!cancelled) {
          setCheckingSession(false);
        }
      }
    }

    checkSession();

    return () => {
      cancelled = true;
    };
  }, []);

  if (checkingSession) {
    return (
      <div className="boot-screen">
        <div className="boot-card">
          <span className="brand-mark" />

          <strong>
            Flow Builder
          </strong>

          <span className="boot-spinner" />

          <span>
            Restoring your workspace…
          </span>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <Login
        onLoggedIn={setUser}
      />
    );
  }

  return (
    <WorkspaceProvider>
      <WorkspaceApp
        user={user}
        onLogout={() => setUser(null)}
      />
    </WorkspaceProvider>
  );
}
