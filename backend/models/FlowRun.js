// server/models/FlowRun.js
//
// One document per flow EXECUTION. A bulk run (CSV upload in
// FlowRunHistory.jsx) creates one FlowRun per row, tagged with the same
// batchLabel, so "50 rollNumber/teacherId pairs" shows up as 50 rows in
// history that can each be reopened individually.
//
// Stored on the REPORTS connection (same place as Extent test reports) —
// this is run *history/output*, not a definition, same category as a
// test report.
import mongoose from "mongoose";
import { getReportsConnection } from "../db/reportsConnection.js";

const conn = getReportsConnection();

const StepResultSchema = new mongoose.Schema(
  {
    stepId: String,
    name: String,
    method: String,
    path: String,
    success: Boolean,
    status: Number,
    requestSent: mongoose.Schema.Types.Mixed,
    responseBody: mongoose.Schema.Types.Mixed,
    extracted: mongoose.Schema.Types.Mixed,
    error: String,
    skipped: { type: Boolean, default: false },
    skipReason: String,
    aiGrade: mongoose.Schema.Types.Mixed,
    durationMs: Number,
  },
  { _id: false }
);

const FlowRunSchema = new mongoose.Schema(
  {
    flow: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    flowName: { type: String }, // denormalized so history reads don't need a join/lookup
    project: { type: String, index: true },
    ranBy: { type: String, default: "unknown" },
    // Secrets are redacted BEFORE this document is saved — see
    // maskContextForStorage in routes/flows.js. Never trust this field
    // to contain real passwords/tokens; it's for "reuse inputs" convenience.
    initialContext: { type: mongoose.Schema.Types.Mixed, default: {} },
    finalContext: { type: mongoose.Schema.Types.Mixed, default: {} },
    overallSuccess: { type: Boolean, required: true },
    steps: { type: [StepResultSchema], default: [] },
    // AI/step report, built once right when the run finishes (see
    // routes/Flows.js) and saved here so "Download report" on a past run
    // is an instant fetch of an already-built file instead of building it
    // fresh on every click. Runs saved before this field existed will be
    // missing it — the report.html route falls back to building it live
    // for those.
    reportHtml: { type: String },
    // Bulk-run fields — undefined for a normal single run.
    batchLabel: { type: String },
    rowIndex: { type: Number },
    // True only for the single extra FlowRun created per bulk run that
    // combines every row's steps into one report (what the "Generate
    // report (all rows)" button used to build on the fly, client-side,
    // with nothing saved for it). Saving it here means that combined
    // report shows up in Past runs like everything else, instead of only
    // being downloadable right after the batch finishes.
    isBatchSummary: { type: Boolean, default: false },
    testId: { type: String, index: true },
    testScenario: { type: mongoose.Schema.Types.Mixed, default: null },
    // Whole-run AI narrative (summary/findings/failurePatterns/
    // recommendations), or { error } if the analysis call itself failed —
    // see analyzeBatchRun() in services/llm.js and run-bulk in
    // routes/Flows.js. Only set on the isBatchSummary run, not per-row
    // runs. buildReportHtml() already renders this when present.
    aiAnalysis: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

// Bind the schema to the REPORTS connection specifically, not the default
// mongoose connection — this is why we can't use mongoose.model() directly.
export default conn.model("FlowRun", FlowRunSchema);
