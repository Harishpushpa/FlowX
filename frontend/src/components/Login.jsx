import { useState } from "react";
import { saveAuth, getSavedUsername } from "../api";

export default function Login({ onLoggedIn }) {
  const [username, setUsername] = useState(getSavedUsername() || "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setChecking(true);
    try {
      const encoded = btoa(`${username}:${password}`);
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { Authorization: `Basic ${encoded}` },
      });
      if (!res.ok) {
        throw new Error(res.status === 401 ? "Incorrect username or password" : "Sign-in failed — try again");
      }
      const data = await res.json();
      saveAuth(encoded, data.username);
      onLoggedIn(data.username);
    } catch (err) {
      setError(err.message);
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="login-page">
      <form className="login-form" onSubmit={handleSubmit}>
        <h2>Welcome back</h2>
        <p className="login-subtitle">Sign in to your RAG API Test Generator workspace.</p>
        <label>
          Username
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus={!username}
            autoComplete="username"
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus={!!username}
            autoComplete="current-password"
            required
          />
        </label>
        {error && (
          <p className="status error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={checking || !username || !password}>
          {checking ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}