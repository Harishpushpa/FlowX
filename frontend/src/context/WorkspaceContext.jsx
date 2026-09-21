import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from "react";
import { apiFetch, apiFetchJson, getLastProject, saveLastProject } from "../api";

const WorkspaceContext = createContext(null);

const initialState = {
  project: "",
  projects: [],
  projectsLoading: false,
  projectsError: "",
  endpoints: [],
  swaggerLoading: false,
  globalTestData: null,
  globalTestDataLoading: false,
  globalTestDataError: "",
  selectedFlow: null,
};

function reducer(state, action) {
  switch (action.type) {
    case "PROJECT_SWITCH_START":
      return {
        ...state,
        project: action.project,
        endpoints: [],
        globalTestData: null,
        globalTestDataError: "",
        swaggerLoading: false,
        selectedFlow: null,
      };

    case "PROJECTS_LOADING":
      return { ...state, projectsLoading: true, projectsError: "" };

    case "PROJECTS_LOADED":
      return {
        ...state,
        projects: action.projects,
        projectsLoading: false,
        projectsError: "",
      };

    case "PROJECTS_ERROR":
      return {
        ...state,
        projectsLoading: false,
        projectsError: action.error,
      };

    case "ENDPOINTS_SET":
      return { ...state, endpoints: action.endpoints };

    case "GLOBAL_LOADING":
      return {
        ...state,
        globalTestDataLoading: true,
        globalTestDataError: "",
      };

    case "GLOBAL_SET":
      return {
        ...state,
        globalTestData: action.data,
        globalTestDataLoading: false,
        globalTestDataError: "",
      };

    case "GLOBAL_ERROR":
      return {
        ...state,
        globalTestData: null,
        globalTestDataLoading: false,
        globalTestDataError: action.error,
      };

    case "GLOBAL_CLEAR":
      return {
        ...state,
        globalTestData: null,
        globalTestDataLoading: false,
        globalTestDataError: "",
      };

    case "SELECT_FLOW":
      return { ...state, selectedFlow: action.flow || null };

    case "RESET":
      return { ...initialState };

    default:
      return state;
  }
}

export function WorkspaceProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const workspaceVersion = useRef(0);

  const isCurrentWorkspace = useCallback((project, version) => {
    return (
      workspaceVersion.current === version &&
      state.project === project
    );
  }, [state.project]);

  const loadProjects = useCallback(async () => {
    dispatch({ type: "PROJECTS_LOADING" });

    try {
      const res = await apiFetch("/api/projects");
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data?.error || `Could not load projects (${res.status})`);
      }

      dispatch({
        type: "PROJECTS_LOADED",
        projects: Array.isArray(data) ? data : [],
      });
    } catch (error) {
      dispatch({
        type: "PROJECTS_ERROR",
        error: error.message || "Could not load projects",
      });
    }
  }, []);

  const switchProject = useCallback((nextProject) => {
    const project = String(nextProject || "").trim();
    workspaceVersion.current += 1;
    dispatch({ type: "PROJECT_SWITCH_START", project });
    saveLastProject(project);
  }, []);

  const createProject = useCallback(async (rawName) => {
    const name = String(rawName || "").trim();
    if (!name) throw new Error("Project name is required");

    const data = await apiFetchJson("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });

    const projectName = String(data?.name || name).trim();

    dispatch({
      type: "PROJECTS_LOADED",
      projects: Array.from(
        new Set([...state.projects, projectName])
      ).sort((a, b) => a.localeCompare(b)),
    });

    switchProject(projectName);
    return projectName;
  }, [state.projects, switchProject]);

  const setEndpointsForProject = useCallback((project, endpoints) => {
    if (state.project !== project) return;
    dispatch({
      type: "ENDPOINTS_SET",
      endpoints: Array.isArray(endpoints) ? endpoints : [],
    });
  }, [state.project]);

  const setSelectedFlow = useCallback((flow) => {
    dispatch({ type: "SELECT_FLOW", flow });
  }, []);

  const loadGlobalTestData = useCallback(async (project) => {
    if (!project) {
      dispatch({ type: "GLOBAL_CLEAR" });
      return;
    }

    const version = workspaceVersion.current;
    dispatch({ type: "GLOBAL_LOADING" });

    try {
      const res = await apiFetch(
        `/api/global-test-data?project=${encodeURIComponent(project)}`
      );
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data?.error || `Could not load test data (${res.status})`);
      }

      if (!isCurrentWorkspace(project, version)) return;
      dispatch({ type: "GLOBAL_SET", data: data || null });
    } catch (error) {
      if (!isCurrentWorkspace(project, version)) return;
      dispatch({
        type: "GLOBAL_ERROR",
        error: error.message || "Could not load test data",
      });
    }
  }, [isCurrentWorkspace]);

  // Saves the Test Data Excel and/or the Test Scenario Excel. Only the parts
  // that are passed in are sent, so saving new test data alone keeps the
  // previously saved scenarios (and vice versa).
  //   saveGlobalTestData(project, { fileName, rows })                       // test data only
  //   saveGlobalTestData(project, { scenarioFileName, scenarios })          // scenarios only
  //   saveGlobalTestData(project, { fileName, rows, scenarioFileName, scenarios })  // both
  const saveGlobalTestData = useCallback(async (project, parts = {}) => {
    if (!project) throw new Error("Pick a project first.");

    const { fileName, rows, scenarioFileName, scenarios } = parts;
    const body = { project };
    if (rows) {
      body.fileName = fileName || "";
      body.rows = rows;
    }
    if (scenarios) {
      body.scenarioFileName = scenarioFileName || "";
      body.scenarios = scenarios;
    }
    if (!rows && !scenarios) throw new Error("Nothing to save — upload a file first.");

    const version = workspaceVersion.current;
    dispatch({ type: "GLOBAL_LOADING" });

    try {
      const saved = await apiFetchJson("/api/global-test-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (isCurrentWorkspace(project, version)) {
        dispatch({ type: "GLOBAL_SET", data: saved });
      }

      return saved;
    } catch (error) {
      if (isCurrentWorkspace(project, version)) {
        dispatch({
          type: "GLOBAL_ERROR",
          error: error.message || "Could not save test data",
        });
      }
      throw error;
    }
  }, [isCurrentWorkspace]);

  const clearGlobalTestData = useCallback(async (project) => {
    if (!project) return;

    const version = workspaceVersion.current;
    dispatch({ type: "GLOBAL_LOADING" });

    try {
      const res = await apiFetch(
        `/api/global-test-data?project=${encodeURIComponent(project)}`,
        { method: "DELETE" }
      );

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || "Could not clear test data");
      }

      if (isCurrentWorkspace(project, version)) {
        dispatch({ type: "GLOBAL_CLEAR" });
      }
    } catch (error) {
      if (isCurrentWorkspace(project, version)) {
        dispatch({
          type: "GLOBAL_ERROR",
          error: error.message || "Could not clear test data",
        });
      }
      throw error;
    }
  }, [isCurrentWorkspace]);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    const saved = getLastProject();
    if (saved) switchProject(saved);
  }, [switchProject]);

  useEffect(() => {
    loadGlobalTestData(state.project);
  }, [state.project, loadGlobalTestData]);

  const value = useMemo(() => {
    const globalColumns = state.globalTestData?.columns || [];
    const globalSampleRow = state.globalTestData?.rows?.[0] || {};

    return {
      ...state,
      globalColumns,
      globalSampleRow,
      loadProjects,
      switchProject,
      createProject,
      setEndpointsForProject,
      setSelectedFlow,
      loadGlobalTestData,
      saveGlobalTestData,
      clearGlobalTestData,
    };
  }, [
    state,
    loadProjects,
    switchProject,
    createProject,
    setEndpointsForProject,
    setSelectedFlow,
    loadGlobalTestData,
    saveGlobalTestData,
    clearGlobalTestData,
  ]);

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  const context = useContext(WorkspaceContext);

  if (!context) {
    throw new Error("useWorkspace must be used inside WorkspaceProvider");
  }

  return context;
}