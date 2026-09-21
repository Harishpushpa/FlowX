// server/services/aiTestGrader.js
//
// AI-graded steps, phase 1: before a flow runs, ask the model to turn a
// step's plain-English description (and/or partial request) into an expected
// status code plus a set of response checks.
//
// Deterministic checks (exists / equals / contains / type) are evaluated in
// code by flowEngine.js once the real response comes back; only "semantic"
// checks or request errors go back to the model for a final verdict (see
// judgeTestResult() in llm.js and runStep() in flowEngine.js).
import { inferTestExpectations } from "./llm.js";

/**
 * Given a flow about to be run via runFlow(), infers expectedStatus/checks
 * for any step that has aiGraded.enabled but hasn't been inferred yet (no
 * inferredAt), and returns a new steps array with those filled in — flowEngine.js's
 * runStep() only ever READS an already-resolved step.aiGraded, it never
 * calls the model itself. Deliberately separated like this so:
 *
 *   - Inference happens ONCE per step, not once per row of a bulk run —
 *     Flows.js persists the returned steps back onto the Flow document
 *     when `changed` is true, so every subsequent run (including every
 *     row of the same bulk run, since this runs before the row loop, not
 *     inside it) reuses the same expectedStatus/checks instead of paying
 *     for a fresh inference call every time.
 *   - A step whose description or method/path is edited later naturally
 *     gets re-inferred, because editing it should clear inferredAt (see
 *     FlowStepEditor.jsx) — this function only skips steps that already
 *     have a live inferredAt.
 *
 * Returns { steps, changed } — `changed` tells the caller whether a DB
 * write is actually needed; a flow with no aiGraded steps (the common
 * case) or one where everything's already inferred costs nothing extra.
 */
export async function ensureAiGradedSteps(flow) {
  let changed = false;

  const steps = await Promise.all(
    (flow.steps || []).map(async (step) => {
      if (!step.aiGraded?.enabled || step.aiGraded.inferredAt) return step;

      const inferred = await inferTestExpectations({
        description: step.aiGraded.description,
        method: step.method,
        path: step.path,
        body: step.bodyTemplate,
        headers: step.headers,
      });

      changed = true;
      return {
        ...step,
        aiGraded: {
          ...step.aiGraded,
          expectedStatus: step.aiGraded.expectedStatus || inferred.expectedStatus || 200,
          checks: Array.isArray(step.aiGraded.checks) && step.aiGraded.checks.length
            ? step.aiGraded.checks
            : inferred.checks || [],
          inferredAt: new Date().toISOString(),
        },
      };
    })
  );

  return { steps, changed };
}