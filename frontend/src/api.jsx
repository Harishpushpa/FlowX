const AUTH_KEY = "rag_auth_header";
const USER_KEY = "rag_username";
const LAST_PROJECT_KEY = "rag_last_project";

export function saveAuth(encoded, username) {
  localStorage.setItem(AUTH_KEY, encoded);
  localStorage.setItem(USER_KEY, username);
}

export function clearAuth() {
  localStorage.removeItem(AUTH_KEY);
  localStorage.removeItem(USER_KEY);
}

export function getAuthHeader() {
  const encoded = localStorage.getItem(AUTH_KEY);
  return encoded ? `Basic ${encoded}` : null;
}

export function getSavedUsername() {
  return localStorage.getItem(USER_KEY);
}

export function saveLastProject(project) {
  if (project) localStorage.setItem(LAST_PROJECT_KEY, project);
  else localStorage.removeItem(LAST_PROJECT_KEY);
}

export function getLastProject() {
  return localStorage.getItem(LAST_PROJECT_KEY) || "";
}

export async function apiFetch(path, options = {}) {
  const authHeader = getAuthHeader();
  const headers = { ...(options.headers || {}) };
  if (authHeader) headers["Authorization"] = authHeader;

  const res = await fetch(path, { ...options, headers });
  if (res.status === 401) {
    clearAuth();
    window.location.reload();
  }
  return res;
}

/**
 * Convenience wrapper around apiFetch: parses the JSON body and throws a
 * readable Error (using the server's { error } message when present) on any
 * non-OK response, so components don't each have to repeat that boilerplate.
 */
export async function apiFetchJson(path, options = {}) {
  const res = await apiFetch(path, options);
  let data = null;
  try {
    data = await res.json();
  } catch {
    // empty or non-JSON body — fine for e.g. 204 responses
  }
  if (!res.ok) {
    throw new Error((data && data.error) || `Request failed (${res.status})`);
  }
  return data;
}