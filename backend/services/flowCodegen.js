// server/services/flowCodegen.js
//
// Turns a Flow (steps + extract rules — see models/Flow.js and
// services/flowEngine.js) into a RestAssured/TestNG Java class that
// performs the SAME sequence, in Java, with real local variables carrying
// data between calls (accessToken, studentId, ...) instead of JS's
// `context` object.
//
// Design choice vs. restAssuredCodegen.js (used for flat OpenAPI-derived
// tests): those tests are independent methods sharing a static
// `RuntimeContext` map because TestNG methods don't share local scope, and
// they never run into each other's business logic — plain name-matching
// capture is good enough. A Flow is the opposite: one fixed, ordered
// scenario. So here every step runs inside ONE Java method, in order, with
// captured values as ordinary Java `String` locals — no shared mutable
// state, no cross-test ordering risk, and "find item where rollNumber ==
// X" is generated as an explicit loop instead of relying on name-matching.
//
// Data-driven support: pass `rows` (from a CSV upload, same shape as
// run-bulk's `rows`) and you get one @Test method PER ROW, with the flow's
// own inputVariables (rollNumber, teacherId, username...) baked in as
// literals for that row — mirroring how dataDrivenTests.js expands one
// templated flat test into N concrete ones. Only the flow's declared
// inputVariables are baked at generation time; everything a step captures
// from a live response (accessToken, studentId...) stays a real Java
// variable resolved at RUN time, because it doesn't exist yet.
import { resolveTemplate } from "./flowEngine.js";

function javaString(value) {
  return JSON.stringify(value == null ? "" : String(value));
}

function sanitizeJavaIdent(name, fallback = "v") {
  let id = String(name || "").replace(/[^a-zA-Z0-9_]/g, "_");
  if (!/^[a-zA-Z_]/.test(id)) id = `${fallback}_${id}`;
  return id || fallback;
}

function methodCall(method) {
  const m = String(method || "GET").toLowerCase();
  return ["get", "post", "put", "patch", "delete", "head", "options"].includes(m) ? m : "get";
}

/**
 * Splits a template string on {{var}} tokens and returns a Java
 * expression that concatenates literal pieces (as Java string literals)
 * with bare Java variable references for each token — e.g.
 * "Bearer {{accessToken}}" -> "\"Bearer \" + accessToken".
 * `varJavaNames` maps the ORIGINAL {{name}} token to its sanitized Java
 * identifier, since a captured variable name might not itself be a valid
 * Java identifier.
 */
function javaConcatExpr(template, varJavaNames) {
  const str = String(template ?? "");
  const re = /\{\{(\w+)\}\}/g;
  const parts = [];
  let last = 0;
  let m;
  while ((m = re.exec(str))) {
    if (m.index > last) parts.push(javaString(str.slice(last, m.index)));
    const javaName = varJavaNames.get(m[1]);
    parts.push(javaName ? `String.valueOf(${javaName})` : javaString(m[0])); // unknown token -> keep literal
    last = re.lastIndex;
  }
  if (last < str.length) parts.push(javaString(str.slice(last)));
  if (parts.length === 0) return javaString("");
  return parts.join(" + ");
}

/**
 * Bakes the flow's declared inputVariables (rollNumber, teacherId, ...)
 * into a step as literal values for ONE row, leaving any {{token}} that
 * refers to a variable captured by an EARLIER step untouched — those
 * aren't known until the request actually runs.
 */
function bakeRowInputs(step, row) {
  return resolveTemplate(step, row);
}

/**
 * Generates the Java for one step's `extract` rules, declaring a Java
 * String local for each captured variable. `responseVar` is the Java
 * variable holding that step's RestAssured Response.
 */
function generateExtractCode(step, responseVar, varJavaNames, softAssertVar) {
  const lines = [];
  for (const rule of step.extract || []) {
    const javaName = sanitizeJavaIdent(rule.variable);
    varJavaNames.set(rule.variable, javaName);

    if (rule.from === "status") {
      lines.push(`        String ${javaName} = String.valueOf(${responseVar}.statusCode());`);
      continue;
    }
    if (rule.from === "header") {
      lines.push(`        String ${javaName} = ${responseVar}.getHeader(${javaString(rule.path || "")});`);
    } else if (rule.type === "find") {
      const arrayExpr = javaConcatExpr(rule.arrayPath || "", varJavaNames);
      const field = rule.where?.field || "";
      const equalsExpr = javaConcatExpr(rule.where?.equals ?? "", varJavaNames);
      const selectPath = rule.select || "";
      lines.push(`        String ${javaName} = null;`);
      lines.push(`        {`);
      lines.push(
        `            java.util.List<Object> __list_${javaName} = ${responseVar}.jsonPath().getList(${arrayExpr});`
      );
      lines.push(`            for (Object __item : __list_${javaName}) {`);
      lines.push(
        `                if (__item instanceof java.util.Map && String.valueOf(((java.util.Map<?, ?>) __item).get(${javaString(
          field
        )})).equals(${equalsExpr})) {`
      );
      if (selectPath) {
        lines.push(
          `                    Object __sel = ${selectPath
            .split(".")
            .map((p) => `((java.util.Map<?, ?>) __item).get(${javaString(p)})`)
            .join(" /* nested select: adjust if deeper than 1 level */ ")};`
        );
        lines.push(`                    ${javaName} = String.valueOf(__sel);`);
      } else {
        lines.push(`                    ${javaName} = String.valueOf(__item);`);
      }
      lines.push(`                    break;`);
      lines.push(`                }`);
      lines.push(`            }`);
      lines.push(`        }`);
    } else {
      // default: plain body path via RestAssured's JsonPath, e.g. "data.token"
      lines.push(`        String ${javaName} = ${responseVar}.jsonPath().getString(${javaString(rule.path || "")});`);
    }

    if (rule.required) {
      lines.push(
        `        ${softAssertVar}.assertNotNull(${javaName}, "Could not capture required variable '${rule.variable}' from step '${step.name}'");`
      );
    }
  }
  return lines.join("\n");
}

function generateStepCode(step, index, baseUrlVar, varJavaNames, softAssertVar) {
  const responseVar = `step${index + 1}Response`;
  const verb = methodCall(step.method);
  const pathExpr = javaConcatExpr(step.path, varJavaNames);

  const headerLines = Object.entries(step.headers || {})
    .map(([k, v]) => `                .header(${javaString(k)}, ${javaConcatExpr(v, varJavaNames)})`)
    .join("\n");

  const queryLines = Object.entries(step.query || {})
    .map(([k, v]) => `                .queryParam(${javaString(k)}, ${javaConcatExpr(v, varJavaNames)})`)
    .join("\n");

  let bodyLine = "";
  if (step.bodyTemplate !== undefined && !["get", "head"].includes(verb)) {
    const rawBodyString =
      typeof step.bodyTemplate === "string" ? step.bodyTemplate : JSON.stringify(step.bodyTemplate);
    bodyLine = `                .contentType("application/json")\n                .body(${javaConcatExpr(
      rawBodyString,
      varJavaNames
    )})`;
  }

  const givenBits = [headerLines, queryLines, bodyLine].filter(Boolean).join("\n");
  const expectedList = Array.isArray(step.expectedStatus) ? step.expectedStatus : [];

  const lines = [];
  lines.push(`        // Step ${index + 1}: ${step.name}`);
  lines.push(`        io.restassured.response.Response ${responseVar} =`);
  lines.push(`            given()`);
  if (givenBits) lines.push(givenBits);
  lines.push(`            .when()`);
  lines.push(`                .${verb}(${baseUrlVar} + (${pathExpr}));`);
  lines.push("");

  if (expectedList.length > 0) {
    const listLiteral = expectedList.map((n) => Number(n)).join(", ");
    lines.push(`        {`);
    lines.push(`            int __status = ${responseVar}.statusCode();`);
    lines.push(`            java.util.List<Integer> __expected = java.util.Arrays.asList(${listLiteral});`);
    lines.push(
      `            ${softAssertVar}.assertTrue(__expected.contains(__status), "Step ${index + 1} (${step.name}) — expected one of " + __expected + " but got " + __status);`
    );
    lines.push(`        }`);
  } else {
    lines.push(
      `        ${softAssertVar}.assertTrue(${responseVar}.statusCode() < 400, "Step ${index + 1} (${step.name}) failed with status " + ${responseVar}.statusCode());`
    );
  }

  const extractCode = generateExtractCode(step, responseVar, varJavaNames, softAssertVar);
  if (extractCode) {
    lines.push("");
    lines.push(extractCode);
  }

  if (step.stopOnFailure !== false) {
    lines.push("");
    lines.push(`        if (${responseVar}.statusCode() >= 400) {`);
    lines.push(
      `            throw new org.testng.SkipException("Stopping flow — step ${index + 1} (${step.name}) failed with status " + ${responseVar}.statusCode());`
    );
    lines.push(`        }`);
  }

  return lines.join("\n");
}

function javaMethodName(flowName, rowIndex, totalRows) {
  const base = sanitizeJavaIdent(flowName.replace(/\s+/g, "_"), "flow");
  return totalRows > 1 ? `${base}_row${rowIndex + 1}` : base;
}

/**
 * Generates the full Java test class for a flow, one @Test method per row.
 * `rows` should be an array of objects keyed by the flow's inputVariables
 * (from a CSV upload, or a single-element array for a manual one-off run).
 * If the flow has no inputVariables, pass `[{}]` for a single run.
 */
export function generateFlowRestAssuredClass(flow, rows) {
  const effectiveRows = rows && rows.length ? rows : [{}];

  const methods = effectiveRows.map((row, rowIndex) => {
    const methodName = javaMethodName(flow.name, rowIndex, effectiveRows.length);
    const varJavaNames = new Map(); // {{token}} name -> sanitized Java identifier
    const baseUrlVar = "baseUrl";

    const stepBlocks = flow.steps.map((rawStep, i) => {
      const step = bakeRowInputs(rawStep, row); // bakes THIS row's inputVariables as literals
      return generateStepCode(step, i, baseUrlVar, varJavaNames, "softAssert");
    });

    return `
    @Test(description = ${javaString(`${flow.name}${effectiveRows.length > 1 ? ` [row ${rowIndex + 1}/${effectiveRows.length}]` : ""}`)}, groups = "generated-flow", priority = ${rowIndex})
    public void ${methodName}() {
        String ${baseUrlVar} = ${javaString(flow.baseUrl)};
        org.testng.asserts.SoftAssert softAssert = new org.testng.asserts.SoftAssert();

${stepBlocks.join("\n\n")}

        softAssert.assertAll();
    }`;
  });

  return `package tests;

import base.BaseTest;
import org.testng.annotations.Test;
import static io.restassured.RestAssured.given;

// Generated from Flow "${flow.name}" — DO NOT EDIT BY HAND, regenerate from the Flow builder instead.
public class GeneratedFlowTests extends BaseTest {
${methods.join("\n")}
}
`;
}
