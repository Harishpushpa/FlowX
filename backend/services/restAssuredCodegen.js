// server/services/restAssuredCodegen.js
import { maskSecrets } from "../utils/securityUtils.js";

export function javaIdent(index, test) {
  const raw = `${test.method}_${test.path}`
    .replace(/[^a-zA-Z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  return `test_${String(index + 1).padStart(3, "0")}_${raw.slice(0, 60) || "endpoint"}`;
}

export function javaString(value) {
  return JSON.stringify(value == null ? "" : String(value));
}

export function methodCall(method) {
  const m = String(method || "GET").toLowerCase();
  return ["get", "post", "put", "patch", "delete", "head", "options"].includes(m) ? m : "get";
}

const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g;

function placeholdersIn(value, out = new Set()) {
  if (value == null) return out;
  if (typeof value === "string") {
    let m;
    PLACEHOLDER_RE.lastIndex = 0;
    while ((m = PLACEHOLDER_RE.exec(value))) out.add(m);
  } else if (Array.isArray(value)) {
    value.forEach((v) => placeholdersIn(v, out));
  } else if (typeof value === "object") {
    Object.values(value).forEach((v) => placeholdersIn(v, out));
  }
  return out;
}

function collectAllPlaceholders(tests) {
  const out = new Set();
  for (const t of tests) {
    placeholdersIn(t.path, out);
    placeholdersIn(t.headers, out);
    placeholdersIn(t.body, out);
  }
  return out;
}

export function resolvedJavaString(literal) {
  const lit = javaString(literal);
  return /\{\{\w+\}\}/.test(String(literal)) ? `utils.RuntimeContext.resolve(${lit})` : lit;
}

export function generateRestAssuredClass(tests) {
  const allPlaceholders = collectAllPlaceholders(tests);
  const items = [...allPlaceholders].map((n) => javaString(n)).join(", ");
  const allPlaceholdersJava = items ? `utils.RuntimeContext.asSet(${items})` : "utils.RuntimeContext.asSet()";

  const methods = tests.map((test, i) => {
    const name = javaIdent(i, test);
    const verb = methodCall(test.method);

    const thisTestPlaceholders = placeholdersIn({ p: test.path, h: test.headers, b: test.body });
    const guardLines = [...thisTestPlaceholders]
      .map(
        (varName) => `
        if (utils.RuntimeContext.get(${javaString(varName)}) == null) {
            listeners.ExtentTestManager.logMissed("Depends on {{${varName}}}, which no earlier test produced.");
            throw new org.testng.SkipException("MISSED — unresolved runtime variable: {{${varName}}}");
        }`
      )
      .join("");

    const headerLines = Object.entries(test.headers || {})
      .map(([k, v]) => `                .header(${javaString(k)}, ${resolvedJavaString(maskSecrets(String(v)))})`)
      .join("\n");

    const rawBodyString =
      test.body == null
        ? ""
        : typeof test.body === "string"
        ? test.body
        : JSON.stringify(test.body);

    const bodyLines =
      test.body != null && !["get", "head"].includes(verb)
        ? `                .contentType("application/json")\n                .body(${resolvedJavaString(rawBodyString)})`
        : "";

    const givenBits = [headerLines, bodyLines].filter(Boolean).join("\n");
    const expected = Number(test.expectedStatus) || 200;
    const pathExpr = resolvedJavaString(test.path);

    const assertions = test.assertions || [];
    const jsonPathInit = assertions.some(a => a.type !== 'bodyContains')
      ? "        io.restassured.path.json.JsonPath jsonPath = rawBody.trim().startsWith(\"{\") || rawBody.trim().startsWith(\"[\") ? new io.restassured.path.json.JsonPath(rawBody) : null;"
      : "";
    
    const assertionLines = assertions.map(a => {
      if (a.type === 'exists') {
        return `        if (jsonPath != null) softAssert.assertNotNull(jsonPath.get(${javaString(a.path)}), "Field ${a.path} should exist");`;
      }
      if (a.type === 'fieldEquals') {
        return `        if (jsonPath != null) softAssert.assertEquals(String.valueOf(jsonPath.get(${javaString(a.path)})), ${javaString(a.value)}, "Field ${a.path} value mismatch");`;
      }
      if (a.type === 'fieldContains') {
        return `        if (jsonPath != null) { String val = String.valueOf(jsonPath.get(${javaString(a.path)})); softAssert.assertTrue(val != null && val.contains(${javaString(a.value)}), "Field ${a.path} doesn't contain expected value"); }`;
      }
      if (a.type === 'bodyContains') {
        return `        softAssert.assertTrue(rawBody.contains(${javaString(a.value)}), "Body doesn't contain expected value");`;
      }
      return "";
    }).filter(Boolean).join("\n");

    return `
    @Test(description = ${javaString(test.name || name)}, groups = "generated", priority = ${i})
    public void ${name}() {${guardLines}
        listeners.ExtentTestManager.logStep("Sending ${verb.toUpperCase()} ${test.path}");

        io.restassured.response.Response response =
            given()
${givenBits ? givenBits + "\n" : ""}            .when()
                .${verb}(${pathExpr});

        int expectedStatus = ${expected};
        int actualStatus = response.statusCode();
        String rawBody = response.getBody() != null ? response.getBody().asString() : "";
        String bodyPreview = rawBody.length() > 500 ? rawBody.substring(0, 500) + "..." : rawBody;

        listeners.ExtentTestManager.logResult(expectedStatus, actualStatus, bodyPreview);
        utils.RuntimeContext.captureFromResponse(rawBody, ALL_RUNTIME_VARS);

        org.testng.asserts.SoftAssert softAssert = new org.testng.asserts.SoftAssert();
        softAssert.assertEquals(actualStatus, expectedStatus,
            "Expected status " + expectedStatus + " but got " + actualStatus + " for ${verb.toUpperCase()} ${test.path}.");
${jsonPathInit ? jsonPathInit + '\n' : ''}${assertionLines ? assertionLines + '\n' : ''}        softAssert.assertAll();
    }`;
  });

  return `package tests;

import base.BaseTest;
import org.testng.annotations.Test;
import static io.restassured.RestAssured.given;

public class GeneratedApiTests extends BaseTest {

    private static final java.util.Set<String> ALL_RUNTIME_VARS = ${allPlaceholdersJava};
${methods.join("\n")}
}
`;
}

export function generateTestNgXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE suite SYSTEM "https://testng.org/testng-1.0.dtd">
<suite name="Generated API Suite" verbose="1">
    <listeners>
        <listener class-name="listeners.ExtentReportListener"/>
    </listeners>
    <test name="Generated Rest Assured tests">
        <classes>
            <class name="tests.GeneratedApiTests"/>
        </classes>
    </test>
</suite>
`;
}
