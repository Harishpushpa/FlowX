import { describe, expect, test } from "@jest/globals";
import { getByPath, joinUrl, resolveTemplate } from "../services/flowEngine.js";

describe("flow engine helpers", () => {
  test("keeps a base URL path prefix while joining a step path", () => {
    expect(joinUrl("https://example.test/api/v1/", "/students/123"))
      .toBe("https://example.test/api/v1/students/123");
  });

  test("resolves nested template values without stringifying an exact token", () => {
    const context = { data: { ids: [42] } };
    expect(getByPath(context, "data.ids[0]")).toBe(42);
    expect(resolveTemplate("{{data.ids[0]}}", context)).toBe(42);
    expect(resolveTemplate("id-{{data.ids[0]}}", context)).toBe("id-42");
  });
});
