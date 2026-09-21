// server/server.js
import "dotenv/config";
import crypto from "crypto";
import express from "express";
import mongoose from "mongoose";
import cors from "cors";

import loginRouter from "./routes/login.js";
import projectsRouter from "./routes/projects.js";
import flowsRouter from "./routes/Flows.js";
import collectionsRouter from "./routes/collections.js";
import globalTestDataRouter from "./routes/globalTestData.js";
import testFromSpecRouter from "./routes/testFromSpec.js";
import swaggerSpecsRouter from "./routes/swaggerSpecs.js";
import { basicAuth } from "./middleware/auth.js";
import { getReportsConnection } from "./db/reportsConnection.js";
import { logEvent } from "./utils/logger.js";
import { beginQueueShutdown, getExecutionStats, waitForQueueIdle } from "./services/executionQueue.js";

const app = express();
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGODB_URI;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5173";

app.use(cors({ origin: FRONTEND_ORIGIN, credentials: true }));
app.use(express.json({ limit: "5mb" }));
app.use((req, res, next) => {
  const requestId = req.get("x-request-id") || crypto.randomUUID();
  const startedAt = Date.now();
  req.requestId = requestId;
  res.setHeader("x-request-id", requestId);
  res.on("finish", () => {
    // Only log failed requests (400 and above). Successful ones stay silent.
    if (res.statusCode < 400) return;
    logEvent(res.statusCode >= 500 ? "error" : "log", "request_failed", {
      requestId,
      method: req.method,
      path: req.originalUrl.split("?")[0],
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
    });
  });
  next();
});

// Health check: reflects actual DB & OpenAI status
app.get("/api/health", (req, res) => {
  const mainDatabaseReady = mongoose.connection.readyState === 1;
  const reportsDatabaseReady = getReportsConnection().readyState === 1;
  res.json({
    status: mainDatabaseReady && reportsDatabaseReady ? "ok" : "degraded",
    mongoConnected: mainDatabaseReady,
    reportsDatabaseConnected: reportsDatabaseReady,
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
  });
});

app.get("/api/readiness", (req, res) => {
  const ready = mongoose.connection.readyState === 1 && getReportsConnection().readyState === 1;
  res.status(ready ? 200 : 503).json({ ready });
});

app.use("/api/login", loginRouter);
app.use(basicAuth);

app.use("/api/projects", projectsRouter);
app.use("/api/flows", flowsRouter);
// Live run-queue status shown in the header (active / max concurrent runs).
app.get("/api/queue", (req, res) => res.json(getExecutionStats()));
app.use("/api/collections", collectionsRouter);
app.use("/api/global-test-data", globalTestDataRouter);
// Swagger/OpenAPI URL parsing + saved-spec persistence — feeds the
// "Swagger" tab inside FlowBuilder so a step's endpoint/body can be
// picked from a real spec instead of typed by hand.
app.use("/api/test-from-spec", testFromSpecRouter);
app.use("/api/swagger-specs", swaggerSpecsRouter);

// --- 404 for anything that didn't match a route above ---
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// --- Centralized error handler ---
// Every route's async handlers are wrapped in asyncHandler (see
// utils/asyncHandler.js), so any rejected promise or thrown error ends up
// here via next(err) instead of hanging the request or crashing the
// process. This must be the LAST app.use() call — Express identifies an
// error middleware by its 4-argument signature.
app.use((err, req, res, next) => {
  logEvent("error", "request_failed", { requestId: req.requestId, method: req.method, path: req.originalUrl, message: err.message });
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({
    error: err.expose ? err.message : "Internal server error",
    detail: process.env.NODE_ENV === "production" ? undefined : err.message,
  });
});

// --- Process-level safety nets ---
// These are a last resort for anything OUTSIDE the Express request cycle
// (background code, a forgotten await, a timer callback) — request-level
// errors are now caught by asyncHandler + the error middleware above and
// should never reach these. Without these handlers, one such error would
// otherwise crash the whole process and take the tool down for every
// concurrent user, not just whoever triggered it.
process.on("unhandledRejection", (reason) => {
  logEvent("error", "unhandled_rejection", { message: reason?.message || String(reason) });
});

process.on("uncaughtException", (err) => {
  // Per Node's docs, the process is in an undefined state after a truly
  // synchronous uncaught exception, so log and exit rather than keep
  // serving requests — run this behind a process manager (pm2, systemd,
  // Docker --restart) so it comes back up automatically.
  logEvent("error", "uncaught_exception", { message: err.message });
  process.exit(1);
});

let httpServer;
async function shutdown(signal) {
  logEvent("log", "shutdown_started", { signal });
  beginQueueShutdown();
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  await Promise.race([
    waitForQueueIdle(),
    new Promise((resolve) => setTimeout(resolve, 35000)),
  ]);
  await Promise.allSettled([mongoose.disconnect(), getReportsConnection().close()]);
  process.exit(0);
}
process.once("SIGTERM", () => { shutdown("SIGTERM"); });
process.once("SIGINT", () => { shutdown("SIGINT"); });

async function start() {
  try {
    if (!MONGO_URI) throw new Error("MONGODB_URI is missing from .env");
    if (!process.env.REPORTS_DB_URI) throw new Error("REPORTS_DB_URI is missing from .env");

    await mongoose.connect(MONGO_URI);
    console.log("Connected to MongoDB Atlas (main)");

    await getReportsConnection().asPromise();
    console.log("Connected to MongoDB Atlas (reports)");

    httpServer = app.listen(PORT, () => {
      logEvent("log", "server_started", { port: PORT });
    });
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

export default app;
if (process.env.NODE_ENV !== "test") start();