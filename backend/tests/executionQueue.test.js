import { describe, expect, test } from "@jest/globals";
import { getExecutionStats, runWithCapacity } from "../services/executionQueue.js";

describe("execution queue", () => {
  test("accepts every submission while keeping active work within its configured capacity", async () => {
    let observedPeak = 0;
    const work = () => new Promise((resolve) => {
      observedPeak = Math.max(observedPeak, getExecutionStats().activeRuns);
      setTimeout(resolve, 5);
    });

    const submissions = Array.from({ length: getExecutionStats().maxConcurrentRuns + 2 }, () => runWithCapacity(work));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getExecutionStats().queuedRuns).toBeGreaterThan(0);
    expect(observedPeak).toBeLessThanOrEqual(getExecutionStats().maxConcurrentRuns);

    await Promise.all(submissions);
    expect(getExecutionStats().activeRuns).toBe(0);
    expect(getExecutionStats().queuedRuns).toBe(0);
  });
});
