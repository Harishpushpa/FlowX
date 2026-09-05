// server/models/Flow.js
//
// A saved "business flow" — e.g. Login -> Dashboard -> Student(rollNumber)
// -> Assign Teacher. Stored on the MAIN db connection (same place as
// documents/projects), since a Flow is a *definition* the user builds and
// reuses, not a report artifact.
import mongoose from "mongoose";

const ExtractRuleSchema = new mongoose.Schema(
  {
    variable: { type: String, required: true }, // e.g. "accessToken", "rollNumber"
    from: { type: String, enum: ["body", "header", "status"], default: "body" },
    path: { type: String }, // dot/bracket path, used for plain + header rules
    type: { type: String, enum: ["path", "find"], default: "path" },
    arrayPath: { type: String }, // only for type: "find"
    where: {
      field: { type: String },
      equals: { type: String }, // may itself be "{{someEarlierVar}}"
    },
    select: { type: String },
    required: { type: Boolean, default: false },
  },
  { _id: false }
);

const StepSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    name: { type: String, required: true },
    method: { type: String, required: true, uppercase: true },
    path: { type: String, required: true }, // may contain {{variable}}
    headers: { type: mongoose.Schema.Types.Mixed, default: {} },
    query: { type: mongoose.Schema.Types.Mixed, default: {} },
    bodyTemplate: { type: mongoose.Schema.Types.Mixed },
    extract: { type: [ExtractRuleSchema], default: [] },
    expectedStatus: { type: [Number], default: [] },
    stopOnFailure: { type: Boolean, default: true },
  },
  { _id: false }
);

const FlowSchema = new mongoose.Schema(
  {
    project: { type: String, required: true, index: true },
    // Optional grouping — a Flow with no collection is just "uncategorized"
    // in the sidebar. Kept nullable so existing flows created before this
    // field existed don't need a migration.
    collectionId: { type: mongoose.Schema.Types.ObjectId, ref: "Collection", default: null, index: true },
    name: { type: String, required: true },
    // Optional when every step uses a full http(s) URL. Relative step
    // paths still require a flow-level base URL.
    baseUrl: { type: String, default: "" },
    // Applied to EVERY step automatically (a step's own headers win on a
    // key collision). This is the fix for "accessToken is needed by every
    // endpoint" — set it here once instead of pasting {{accessToken}}
    // into every step's Headers section.
    defaultHeaders: { type: mongoose.Schema.Types.Mixed, default: {} },
    steps: { type: [StepSchema], default: [] },
    // Names the flow needs seeded from OUTSIDE itself (username/password
    // for a login step, a rollNumber to look up, etc.) — everything else
    // (accessToken, studentId...) is expected to come from `extract` rules
    // on an earlier step instead of being asked from the user.
    inputVariables: { type: [String], default: [] },
    createdBy: { type: String },
  },
  { timestamps: true }
);

export default mongoose.model("Flow", FlowSchema);