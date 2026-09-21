import { describe, expect, test } from "@jest/globals";
import Flow from "../models/Flow.js";

describe("Flow schema", () => {
  test("keeps a collection assignment and AI grading configuration", () => {
    const collectionId = "507f1f77bcf86cd799439011";
    const flow = new Flow({
      project: "Internal QA",
      name: "Login",
      collectionId,
      steps: [{
        id: "login",
        name: "Log in",
        method: "POST",
        path: "/login",
        aiGraded: {
          enabled: true,
          description: "A valid user receives a token",
          expectedStatus: 200,
          checks: [{ type: "exists", path: "token" }],
          inferredAt: "2026-09-20T00:00:00.000Z",
        },
      }],
    });

    expect(String(flow.collectionId)).toBe(collectionId);
    expect(flow.steps[0].aiGraded).toMatchObject({
      enabled: true,
      description: "A valid user receives a token",
      expectedStatus: 200,
    });
    expect(flow.steps[0].aiGraded.checks).toHaveLength(1);

    // Same values must survive serialisation (what actually gets saved).
    const saved = flow.toObject();
    expect(String(saved.collectionId)).toBe(collectionId);
    expect(saved.steps[0].aiGraded.enabled).toBe(true);
  });
});
