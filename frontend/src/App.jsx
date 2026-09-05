import { useEffect, useState } from "react";
import Login from "./components/Login";
import ProjectPicker from "./components/ProjectPicker";
import SwaggerSpecBar from "./components/SwaggerSpecBar";
import FlowBuilder from "./components/FlowBuilder";
import FlowRunHistory from "./components/FlowRunHistory";
import GlobalTestDataBar from "./components/GlobalTestDataBar";
import { clearAuth, getAuthHeader, getSavedUsername } from "./api";
import { WorkspaceProvider, useWorkspace } from "./context/WorkspaceContext";
import "./App.css";

function WorkspaceApp({ user, onLogout }) {
  const {
    project,
    endpoints,
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

  const endpointCount = endpoints.length;

  return (
    <div className="app app--workspace">
      <header className="workspace-header">
        <div className="workspace-brand">
          <span className="brand-mark" />

          <div>
            <div className="brand-name">Flow Builder</div>
            <div className="brand-subtitle">
              API testing workspace
            </div>
          </div>
        </div>

        <div className="workspace-header-center">
          <div className="workspace-breadcrumb">
            <span>Workspace</span>
            <span className="breadcrumb-separator">/</span>
            <strong>
              {project || "Select a project"}
            </strong>
          </div>
        </div>

        <div className="workspace-actions">
          <div className="connection-status">
            <span className="status-dot" />
            <span>Connected</span>
          </div>

          <div className="user-menu-pill">
            <span className="user-avatar">
              {String(user).slice(0, 1).toUpperCase()}
            </span>

            <span className="user-name">
              {user}
            </span>
          </div>

          <button
            type="button"
            className="theme-toggle-btn"
            title={
              theme === "dark"
                ? "Switch to light theme"
                : "Switch to dark theme"
            }
            aria-label={
              theme === "dark"
                ? "Switch to light theme"
                : "Switch to dark theme"
            }
            onClick={() =>
              setTheme((current) =>
                current === "dark"
                  ? "light"
                  : "dark"
              )
            }
          >
            <span
              className="theme-toggle-icon"
              aria-hidden="true"
            >
              {theme === "dark" ? "☀" : "☾"}
            </span>

            <span className="theme-toggle-label">
              {theme === "dark" ? "Light" : "Dark"}
            </span>
          </button>

          <button
            type="button"
            className="header-icon-btn"
            title="Log out"
            onClick={handleLogout}
          >
            ↪
          </button>
        </div>
      </header>

      <main className="workspace-body">
        <section className="workspace-toolbar">
          <div className="project-context">
            <div className="toolbar-eyebrow">
              CURRENT PROJECT
            </div>

            <ProjectPicker />
          </div>

          <div className="toolbar-divider" />

          <div className="workspace-metrics">
            <div className="metric-card">
              <span className="metric-icon">◈</span>

              <div>
                <span className="metric-label">
                  Swagger
                </span>

                <strong>
                  {endpointCount
                    ? `${endpointCount} endpoints`
                    : "Not loaded"}
                </strong>
              </div>
            </div>

            <div className="metric-card">
              <span className="metric-icon">◇</span>

              <div>
                <span className="metric-label">
                  Workspace
                </span>

                <strong>
                  {project
                    ? "Ready"
                    : "Choose project"}
                </strong>
              </div>
            </div>
          </div>

          <div className="toolbar-spacer" />

          <SwaggerSpecBar />
        </section>

        {!project ? (
          <section className="workspace-empty">
            <div className="empty-hero-icon">
              ⌁
            </div>

            <div className="empty-kicker">
              READY WHEN YOU ARE
            </div>

            <h2>
              Choose a project to start testing
            </h2>

            <p>
              Select an existing project or type a new
              project name. Your flows, collections,
              Swagger specs and test data stay organized
              by project.
            </p>
          </section>
        ) : (
          <>
            {/* PROJECT / SCHOOL BAR */}
            <section className="workspace-context-strip">
              <div className="context-title">
                <span className="context-live-dot" />

                <div>
                  <strong>
                    {project}
                  </strong>

                  <span>
                    Project workspace
                  </span>
                </div>
              </div>

              <div className="context-help">
                {endpointCount > 0 && (
                  <span className="context-chip">
                    {endpointCount} Swagger endpoints ready
                  </span>
                )}
              </div>
            </section>

            

            {/* FLOW BUILDER */}
            <section className="builder-region">
              <FlowBuilder />
            </section>

            {selectedFlow && (
              <section className="history-region">
                <div className="region-heading">
                  <div>
                    <span className="toolbar-eyebrow">
                      EXECUTION CENTER
                    </span>

                    <h2>
                      Run history
                    </h2>
                  </div>

                  <span className="region-hint">
                    Review results, diagnose failures
                    and generate reports.
                  </span>
                </div>

                <FlowRunHistory />
              </section>
            )}
          </>
        )}
      </main>
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