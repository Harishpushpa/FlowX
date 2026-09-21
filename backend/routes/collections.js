// server/routes/collections.js
//
// Backs the "Collections" grouping in FlowBuilder.jsx's sidebar. A
// Collection is purely organizational — it never affects how a Flow runs
// (services/flowEngine.js doesn't know Collections exist at all), it only
// changes how Flows are grouped in the UI.
import express from "express";
import mongoose from "mongoose";
import Collection from "../models/Collection.js";
import Flow from "../models/Flow.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = express.Router();

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

// GET /api/collections?project=X
// Returns each collection plus how many flows currently sit inside it, so
// the sidebar can show a count without a second round trip per collection.
router.get("/", asyncHandler(async (req, res) => {
  const { project } = req.query;
  if (!project) return res.status(400).json({ error: "project query param is required" });

  const collections = await Collection.find({ project }).sort({ name: 1 }).lean();
  const counts = await Flow.aggregate([
    { $match: { project, collectionId: { $ne: null } } },
    { $group: { _id: "$collectionId", count: { $sum: 1 } } },
  ]);
  const countByCollection = new Map(counts.map((c) => [String(c._id), c.count]));

  res.json(
    collections.map((c) => ({ ...c, flowCount: countByCollection.get(String(c._id)) || 0 }))
  );
}));

// POST /api/collections   body: { project, name, description? }
router.post("/", asyncHandler(async (req, res) => {
  try {
    const { project, description } = req.body;
    const name = (req.body.name || "").trim();
    if (!project || !name) {
      return res.status(400).json({ error: "project and name are required" });
    }
    const collection = await Collection.create({
      project,
      name,
      description: description || "",
      createdBy: req.user || req.headers["x-user"] || undefined,
    });
    res.status(201).json({ ...collection.toObject(), flowCount: 0 });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: `A collection named "${req.body.name}" already exists in this project.` });
    }
    res.status(400).json({ error: err.message });
  }
}));

// PUT /api/collections/:id   body: { name?, description? }
router.put("/:id", asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: "Invalid collection id" });
  const { name, description } = req.body;
  try {
    const collection = await Collection.findByIdAndUpdate(
      req.params.id,
      {
        ...(name !== undefined && { name: name.trim() }),
        ...(description !== undefined && { description }),
      },
      { new: true, runValidators: true }
    ).lean();
    if (!collection) return res.status(404).json({ error: "Collection not found" });
    const flowCount = await Flow.countDocuments({ collectionId: collection._id });
    res.json({ ...collection, flowCount });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: `A collection named "${name}" already exists in this project.` });
    }
    res.status(400).json({ error: err.message });
  }
}));

// DELETE /api/collections/:id
// Non-destructive to Flows: every Flow that was in this collection is set
// back to collection: null (falls into "Uncategorized" in the sidebar)
// rather than being deleted along with it.
// DELETE /api/collections/:id?deleteFlows=true
//
// Deletes the collection and, when deleteFlows=true,
// permanently deletes every Flow belonging to it.
router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (
      !isValidId(req.params.id)
    ) {
      return res.status(400).json({
        error: "Invalid collection id",
      });
    }

    const collection =
      await Collection.findById(
        req.params.id
      );

    if (!collection) {
      return res.status(404).json({
        error: "Collection not found",
      });
    }

    const deleteFlows =
      String(
        req.query.deleteFlows
      ).toLowerCase() === "true";

    let deletedFlows = 0;

    if (deleteFlows) {
      const result =
        await Flow.deleteMany({
          collectionId:
            collection._id,
        });

      deletedFlows =
        result.deletedCount || 0;
    } else {
      // Safety fallback:
      // If deleteFlows=true is not explicitly supplied,
      // do NOT delete flows.
      await Flow.updateMany(
        {
          collectionId:
            collection._id,
        },
        {
          $set: {
            collectionId: null,
          },
        }
      );
    }

    await collection.deleteOne();

    res.json({
      deleted: true,
      collectionId:
        String(collection._id),
      collectionName:
        collection.name,
      flowsDeleted:
        deletedFlows,
    });
  })
);

export default router;
