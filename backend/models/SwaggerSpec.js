// server/models/SwaggerSpec.js
//
// A parsed Swagger/OpenAPI spec, saved once per project so the user can
// pick it again later (like picking a saved Flow) instead of re-pasting
// the spec URL and re-parsing every time they open the "From Swagger" tab.
// `endpoints` is the same shape SwaggerEndpointPicker already gets back
// from POST /api/test-from-spec/parse-url — we just cache that response.
import mongoose from "mongoose";

const SwaggerSpecSchema = new mongoose.Schema(
  {
    project: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    sourceUrl: { type: String, default: "" },
    title: { type: String, default: "" },
    version: { type: String, default: "" },
    baseUrl: { type: String, default: "" },
    endpoints: { type: Array, default: [] },
    createdBy: { type: String },
  },
  { timestamps: true }
);

// Saving the same named spec again in the same project (e.g. re-parsing
// after the API changed) updates it in place instead of piling up
// duplicates — see the upsert in routes/swaggerSpecs.js.
SwaggerSpecSchema.index({ project: 1, name: 1 }, { unique: true });

export default mongoose.model("SwaggerSpec", SwaggerSpecSchema);