// server/routes/flowBatchReport.js
//
// Register in server.js alongside the other routers:
//   import flowBatchReportRouter from "./routes/flowBatchReport.js";
//   app.use("/api/flows/batch", flowBatchReportRouter);
//
// Stateless on purpose — a bulk/global run's rows are already saved as
// individual FlowRun documents (each gets its own report via the
// existing /api/flows/runs/:id/report.* routes), so this doesn't need to
// read or write the DB. It just takes the flowReport.js-shaped JSON the
// client already assembled from the rows on screen and formats it,
// exactly like the per-run report routes do for one FlowRun.
import express from "express";
import { buildJUnitXml, buildReportHtml } from "../services/flowReport.js";

const router = express.Router();

router.post("/report/html", (req, res) => {
  try {
    res.setHeader("Content-Type", "text/html");
    res.send(buildReportHtml(req.body));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/report/junit.xml", (req, res) => {
  try {
    res.setHeader("Content-Type", "application/xml");
    res.send(buildJUnitXml(req.body));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;