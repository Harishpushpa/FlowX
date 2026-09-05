// server/routes/globalTestData.js
//
// Backs the app-wide "upload your test data once" sheet — GlobalTestData
// is one document per project. The frontend parses the CSV/Excel file
// client-side (same PapaParse/xlsx pattern FlowRunHistory.jsx's bulk
// upload already uses) and posts the resulting rows here; this route
// doesn't touch the raw file at all, just the rows it already produced.
import express from "express";
import GlobalTestData from "../models/GlobalTestData.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = express.Router();

function deriveColumns(rows) {
  const set = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row || {})) set.add(key);
  }
  return [...set];
}

function validateUniqueColumns(rows, label = "Excel file") {
  if (!Array.isArray(rows) || !rows.length) return;
  const columns = Object.keys(rows[0] || {});
  const normalized = new Map();
  for (const raw of columns) {
    const name = String(raw ?? "").trim();
    if (!name) throw new Error(`${label} contains an empty column name. Please give every column a unique name.`);
    const key = name.toLowerCase();
    normalized.set(key, (normalized.get(key) || 0) + 1);
  }
  const duplicates = [...normalized.entries()]
    .filter(([, count]) => count > 1)
    .map(([name]) => name);
  if (duplicates.length) {
    throw new Error(`${label} contains duplicate column name(s): ${duplicates.join(", ")}. Rename them before uploading.`);
  }
}

// A test-case Excel's join-key column shows up under all sorts of
// spellings ("test_id", "testId", "TC ID", "TC_ID", "tcid"...) — normalize
// whitespace/underscores/case away and match against both accepted forms
// instead of hardcoding one exact header string.
function findIdKey(row) {
  for (const key of Object.keys(row || {})) {
    const normalized = key.toLowerCase().replace(/[\s_]/g, "");
    if (normalized === "testid" || normalized === "tcid") return key;
  }
  return null;
}

function normalizeScenarioRows(rows) {
  const out = [];
  let currentTestId = "";
  for (const raw of rows || []) {
    const row = raw && typeof raw === "object" ? { ...raw } : {};
    const idKey = findIdKey(row);
    const explicit = idKey ? String(row[idKey] ?? "").trim() : "";
    if (explicit) currentTestId = explicit;
    if (!currentTestId) continue;
    // Drop the original id column (whatever it was called) so it doesn't
    // also show up as a duplicate "TC ID: ..." line when this row's other
    // columns get turned into free-text scenario context for the AI.
    if (idKey && idKey !== "test_id") delete row[idKey];
    row.test_id = currentTestId;
    out.push(row);
  }
  return out;
}

// GET /api/global-test-data?project=X
router.get("/", asyncHandler(async (req, res) => {
  const { project } = req.query;
  if (!project) return res.status(400).json({ error: "project query param is required" });

  const data = await GlobalTestData.findOne({ project }).lean();
  res.json(data || null);
}));

// POST /api/global-test-data   body: { project, fileName, rows }
// Upserts — a project has exactly one global sheet at a time, so
// re-uploading replaces it rather than creating a second one.
router.post("/", asyncHandler(async (req, res) => {
  try {
    const { project, fileName, rows, scenarioFileName, scenarios } = req.body || {};
    if (!project) return res.status(400).json({ error: "project is required" });
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: "rows must be a non-empty array" });
    }

    validateUniqueColumns(rows, fileName || "Test data Excel");

    const scenarioRows = Array.isArray(scenarios) ? normalizeScenarioRows(scenarios) : [];
    if (scenarioRows.length) validateUniqueColumns(scenarioRows, scenarioFileName || "Test scenario Excel");

    const columns = deriveColumns(rows);
    const data = await GlobalTestData.findOneAndUpdate(
      { project },
      {
        project,
        fileName: fileName || "",
        columns,
        rows,
        scenarioFileName: scenarioFileName || "",
        scenarios: scenarioRows,
        uploadedBy: req.user || req.headers["x-user"] || undefined,
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    res.status(201).json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// DELETE /api/global-test-data?project=X
router.delete("/", asyncHandler(async (req, res) => {
  const { project } = req.query;
  if (!project) return res.status(400).json({ error: "project query param is required" });

  const deleted = await GlobalTestData.findOneAndDelete({ project });
  res.json({ deleted: Boolean(deleted) });
}));

export default router;