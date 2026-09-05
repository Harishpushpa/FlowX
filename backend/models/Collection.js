// server/models/Collection.js
//
// A named group of Flows within a project — purely organizational, the
// same way a Postman "Collection" groups related requests. Deleting a
// Collection does NOT delete the Flows inside it; they just fall back to
// "no collection" (see DELETE /api/collections/:id in routes/collections.js).
import mongoose from "mongoose";

const CollectionSchema = new mongoose.Schema(
  {
    project: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    createdBy: { type: String },
  },
  { timestamps: true }
);

// Two collections with the same name in the same project would just be
// confusing to pick between when moving a flow — block it at the DB level.
CollectionSchema.index({ project: 1, name: 1 }, { unique: true });

export default mongoose.model("Collection", CollectionSchema);