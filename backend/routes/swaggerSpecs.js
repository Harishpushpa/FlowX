// server/routes/swaggerSpecs.js
//
// Backs the "Saved specs" list in SwaggerEndpointPicker.jsx. Parsing a
// spec (POST /api/test-from-spec/parse-url) stays separate and unchanged
// — this only persists whatever that parse already returned, so it can
// be picked again later without re-parsing.
import express from "express";
import mongoose from "mongoose";
import SwaggerSpec from "../models/SwaggerSpec.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = express.Router();

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

// GET /api/swagger-specs?project=X
// Metadata only (no endpoints array) — keeps the picker list light. The
// full endpoint list is fetched on demand via GET /:id when one is picked.
router.get("/", asyncHandler(async (req, res) => {
  const { project } = req.query;
  if (!project) return res.status(400).json({ error: "project query param is required" });

  const specs = await SwaggerSpec.find({ project })
    .select("-endpoints")
    .sort({ updatedAt: -1 })
    .lean();
  res.json(specs);
}));

// GET /api/swagger-specs/:id — full doc, including endpoints, for
// re-selecting a saved spec without hitting the source URL again.
router.get("/:id", asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: "Invalid spec id" });
  const spec = await SwaggerSpec.findById(req.params.id).lean();
  if (!spec) return res.status(404).json({ error: "Saved spec not found" });
  res.json(spec);
}));

// POST /api/swagger-specs
// body: { project, name, sourceUrl?, title?, version?, baseUrl?, endpoints }
// Upserts on (project, name) so re-saving after re-parsing the same API
// updates it in place instead of creating a duplicate entry.
router.post("/", asyncHandler(async (req, res) => {
  try {
    const { project, sourceUrl, title, version, baseUrl, endpoints } = req.body;
    const name = (req.body.name || "").trim();
    if (!project || !name) {
      return res.status(400).json({ error: "project and name are required" });
    }
    if (!Array.isArray(endpoints) || endpoints.length === 0) {
      return res.status(400).json({ error: "endpoints are required — parse a spec first" });
    }
    const spec = await SwaggerSpec.findOneAndUpdate(
      { project, name },
      {
        project,
        name,
        sourceUrl: sourceUrl || "",
        title: title || "",
        version: version || "",
        baseUrl: baseUrl || "",
        endpoints,
        createdBy: req.user?.username || req.headers["x-user"] || undefined,
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    res.status(201).json(spec);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// DELETE /api/swagger-specs/:id
router.delete("/:id", asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: "Invalid spec id" });
  const spec = await SwaggerSpec.findByIdAndDelete(req.params.id);
  if (!spec) return res.status(404).json({ error: "Saved spec not found" });
  res.json({ deleted: true });
}));

export default router;