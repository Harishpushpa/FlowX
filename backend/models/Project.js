import mongoose from "mongoose";

const ProjectSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      unique: true,
    },
    createdBy: {
      type: String,
      default: "",
      index: true,
    },
  },
  { timestamps: true }
);

export default mongoose.model("Project", ProjectSchema);
