import mongoose from "mongoose";

let reportsConnection = null;

export function getReportsConnection() {
  if (!reportsConnection) {
    if (!process.env.REPORTS_DB_URI) {
      throw new Error("REPORTS_DB_URI is missing from .env");
    }
    reportsConnection = mongoose.createConnection(process.env.REPORTS_DB_URI);
  }
  return reportsConnection;
}