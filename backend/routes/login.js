import express from "express";
import { basicAuth } from "../middleware/auth.js";

const router = express.Router();

// Frontend sends Authorization: Basic <base64> manually (never via browser
// popup). This route just confirms the credentials are valid.
router.post("/", basicAuth, (req, res) => {
  res.json({ username: req.user });
});

export default router;