// server/models/GlobalTestData.js
//
// One uploaded Excel/CSV, persisted per project — the same "upload once,
// stays there across logins/reloads, shared by anyone using this app"
// deal your SwaggerSpec already gets. Re-uploading for the same project
// replaces the whole sheet (see the upsert in routes/globalTestData.js)
// rather than versioning or appending, since this is meant to be THE
// current set of test data for the project, not a history of uploads.
//
// `columns` is derived from the uploaded rows at upload time and cached
// here so any editor (FlowStepEditor's key/value tables, AITestRunner)
// can list "does this key match a global column?" without re-deriving it
// from `rows` on every keystroke.
import mongoose from "mongoose";

const GlobalTestDataSchema = new mongoose.Schema(
  {
    project: { type: String, required: true, unique: true, index: true },
    fileName: { type: String, default: "" },
    columns: { type: [String], default: [] },
    rows: { type: [mongoose.Schema.Types.Mixed], default: [] },
    uploadedBy: { type: String },
    scenarioFileName: { type: String, default: "" },
    scenarios: { type: [mongoose.Schema.Types.Mixed], default: [] },
  },
  { timestamps: true }
);

export default mongoose.model("GlobalTestData", GlobalTestDataSchema);