// server/server.js
import "dotenv/config";
import express from "express";
import mongoose from "mongoose";
import cors from "cors";

import loginRouter from "./routes/login.js";
import projectsRouter from "./routes/projects.js";
import flowsRouter from "./routes/Flows.js";
import collectionsRouter from "./routes/collections.js";
import globalTestDataRouter from "./routes/globalTestData.js";
import flowBatchReportRouter from "./routes/flowBatchReport.js";
import testFromSpecRouter from "./routes/testFromSpec.js";
import swaggerSpecsRouter from "./routes/swaggerSpecs.js";
import { basicAuth } from "./middleware/auth.js";
import { getReportsConnection } from "./db/reportsConnection.js";

const app = express();
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGODB_URI;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5173";

app.use(cors({ origin: FRONTEND_ORIGIN, credentials: true }));
app.use(express.json({ limit: "5mb" }));

// Fixed Health Endpoint: reflects actual DB & OpenAI status
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    mongoConnected: mongoose.connection.readyState === 1,
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
  });
});

app.use("/api/login", loginRouter);
app.use(basicAuth);

app.use("/api/projects", projectsRouter);
app.use("/api/flows", flowsRouter);
app.use("/api/collections", collectionsRouter);
app.use("/api/global-test-data", globalTestDataRouter);
// Swagger/OpenAPI URL parsing + saved-spec persistence — feeds the
// "Swagger" tab inside FlowBuilder so a step's endpoint/body can be
// picked from a real spec instead of typed by hand.
app.use("/api/test-from-spec", testFromSpecRouter);
app.use("/api/swagger-specs", swaggerSpecsRouter);
// Stateless report formatter for a bulk/global multi-row Flow run — takes
// the already-assembled batch of rows from the client and formats one
// combined HTML/JUnit report, the same way the per-run report routes in
// flows.js do for a single FlowRun.
app.use("/api/flows/batch", flowBatchReportRouter);

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
  console.error(`[${new Date().toISOString()}] Unhandled error on ${req.method} ${req.originalUrl}:`, err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({
    error: "Internal server error",
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
  console.error(`[${new Date().toISOString()}] Unhandled promise rejection:`, reason);
});

process.on("uncaughtException", (err) => {
  // Per Node's docs, the process is in an undefined state after a truly
  // synchronous uncaught exception, so log and exit rather than keep
  // serving requests — run this behind a process manager (pm2, systemd,
  // Docker --restart) so it comes back up automatically.
  console.error(`[${new Date().toISOString()}] Uncaught exception, shutting down:`, err);
  process.exit(1);
});

async function start() {
  try {
    if (!MONGO_URI) throw new Error("MONGODB_URI is missing from .env");
    if (!process.env.REPORTS_DB_URI) throw new Error("REPORTS_DB_URI is missing from .env");

    await mongoose.connect(MONGO_URI);
    console.log("Connected to MongoDB Atlas (main)");

    await getReportsConnection().asPromise();
    console.log("Connected to MongoDB Atlas (reports)");

    app.listen(PORT, () => {
      console.log(`Flow Builder API running on port ${PORT}`);
    });
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

export default app;
if (process.env.NODE_ENV !== "test") start();