import express from "express";
import Flow from "../models/Flow.js";
import Project from "../models/Project.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = express.Router();

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const q = String(req.query.q || "").trim();
    const regex = q ? new RegExp(escapeRegex(q), "i") : null;

    const projectFilter = regex ? { name: regex } : {};
    const flowFilter = regex ? { project: regex } : {};

    const [savedProjects, flowProjects] = await Promise.all([
      Project.find(projectFilter).select("name").lean(),
      Flow.distinct("project", flowFilter),
    ]);

    const names = new Set([
      ...savedProjects.map((item) => item.name),
      ...flowProjects.filter(Boolean),
    ]);

    res.json(
      Array.from(names).sort((a, b) =>
        String(a).localeCompare(String(b))
      )
    );
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const name = String(req.body?.name || "").trim();

    if (!name) {
      return res.status(400).json({
        error: "Project name is required",
      });
    }

    const existing = await Project.findOne({
      name: {
        $regex: `^${escapeRegex(name)}$`,
        $options: "i",
      },
    });

    if (existing) {
      return res.json({
        name: existing.name,
        existing: true,
      });
    }

    try {
      const project = await Project.create({
        name,
        createdBy: req.user || "",
      });

      return res.status(201).json({
        name: project.name,
        existing: false,
      });
    } catch (error) {
      if (error?.code === 11000) {
        const duplicate = await Project.findOne({
          name: {
            $regex: `^${escapeRegex(name)}$`,
            $options: "i",
          },
        });

        return res.json({
          name: duplicate?.name || name,
          existing: true,
        });
      }

      throw error;
    }
  })
);

export default router;
