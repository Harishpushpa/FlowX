// server/routes/testFromSpec.js
//
// Swagger/OpenAPI URL parser. /parse-url is what SwaggerEndpointPicker.jsx
// calls (embedded inside FlowBuilder's "Swagger" tab) to turn a spec URL
// into the endpoint list a Flow step can be built from, complete with a
// pre-filled body template.
import express from "express";
import SwaggerParser from "@apidevtools/swagger-parser";
import {
  extractRequestBodyTemplate,
  extractParams,
  extractParamSchema,
  extractRequestBodySchema,
} from "../utils/schemaToTemplate.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = express.Router();

/**
 * Swagger UI pages almost always embed the real spec URL somewhere in their
 * HTML/JS, e.g. `url: "/v3/api-docs"` or `urls: [{url: "...", name: "..."}]`
 * inside the SwaggerUIBundle config, or a plain <link>/<a> to the JSON file.
 * This pulls out every plausible candidate (resolved to an absolute URL)
 * plus the common default paths, so we can try them in turn instead of
 * giving up as soon as we see HTML.
 */
function discoverSpecCandidates(html, baseUrl) {
  const candidates = new Set();
  const patterns = [
    /url\s*:\s*["']([^"']+)["']/gi,
    /href\s*=\s*["']([^"']+\.(?:json|yaml|yml))["']/gi,
    /(?:src|data-url)\s*=\s*["']([^"']+\.(?:json|yaml|yml))["']/gi,
  ];

  for (const re of patterns) {
    let match;
    while ((match = re.exec(html)) !== null) {
      try {
        candidates.add(new URL(match[1], baseUrl).toString());
      } catch {
        // ignore anything that isn't a resolvable URL (e.g. a JS variable)
      }
    }
  }

  const origin = new URL(baseUrl).origin;
  const fallbackPaths = [
    "/v3/api-docs",
    "/v2/api-docs",
    "/api-docs.json",
    "/api-docs",
    "/swagger.json",
    "/swagger/v1/swagger.json",
    "/openapi.json",
  ];
  for (const p of fallbackPaths) candidates.add(new URL(p, origin).toString());

  return Array.from(candidates);
}

/**
 * Tries a candidate URL and returns the parsed spec object only if it looks
 * like a real OpenAPI/Swagger document (has `paths` plus a `swagger` or
 * `openapi` version field) — not just "happened to be valid JSON".
 */
async function tryFetchSpecJson(candidateUrl) {
  try {
    const res = await fetch(candidateUrl, { redirect: "follow" });
    if (!res.ok) return null;
    const text = await res.text();
    const parsed = JSON.parse(text);
    if (parsed && parsed.paths && (parsed.swagger || parsed.openapi)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * POST /api/test-from-spec/parse-url
 * Body: { url: string }
 * Fetches and parses a Swagger/OpenAPI spec directly from a URL and
 * returns every endpoint (method + path) for the user to pick from
 * via checkboxes on the frontend.
 *
 * If the URL points at a Swagger UI HTML page rather than the raw spec,
 * this scans that page for the embedded spec URL (and common fallback
 * paths on the same host) and uses whichever one actually resolves to a
 * valid OpenAPI/Swagger document.
 */
router.post("/parse-url", asyncHandler(async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== "string" || !url.trim()) {
    return res.status(400).json({ error: "Swagger/OpenAPI URL is required." });
  }

  const trimmedUrl = url.trim();
  let precheckText = "";
  const triedUrls = [trimmedUrl];

  try {
    let specSource = trimmedUrl;
    let specObject = null;

    try {
      const probe = await fetch(trimmedUrl, { redirect: "follow" });
      const contentType = probe.headers.get("content-type") || "";
      precheckText = await probe.text();

      const looksLikeHtml =
        contentType.includes("text/html") || precheckText.trim().startsWith("<");

      if (!probe.ok && !looksLikeHtml) {
        return res.status(422).json({
          error: `The URL responded with ${probe.status} ${probe.statusText}.`,
          detail: `First 300 chars of response:\n${precheckText.slice(0, 300)}`,
        });
      }

      if (looksLikeHtml) {
        const candidates = discoverSpecCandidates(precheckText, trimmedUrl);
        let found = null;
        for (const candidate of candidates) {
          triedUrls.push(candidate);
          const json = await tryFetchSpecJson(candidate);
          if (json) {
            found = { candidate, json };
            break;
          }
        }

        if (!found) {
          return res.status(422).json({
            error:
              "That URL returned an HTML page, and no valid spec file could be found automatically.",
            detail: `Tried: ${triedUrls.join(", ")}. Open the URL in a browser, check the Network tab for the request the Swagger UI page makes to load its spec, and paste that URL instead.`,
          });
        }

        specObject = found.json;
        specSource = found.candidate;
      }
    } catch (probeErr) {
      return res.status(422).json({
        error: "Could not reach the provided URL.",
        detail: probeErr.message,
      });
    }

    // Dereference (not just parse) so every $ref inside a requestBody/param
    // schema is resolved to the real schema object — needed to build a
    // filled-in body template below. Some specs have constructs
    // swagger-parser can't fully dereference (unusual circular shapes,
    // etc.); if that happens, fall back to a plain parse so endpoint
    // listing still works, just without prefilled body templates.
    let api;
    try {
      api = specObject
        ? await SwaggerParser.dereference(specObject)
        : await SwaggerParser.dereference(specSource);
    } catch (derefErr) {
      console.warn("parse-url: dereference failed, falling back to parse (no body templates):", derefErr.message);
      api = specObject
        ? await SwaggerParser.parse(specObject)
        : await SwaggerParser.parse(specSource);
    }

    const endpoints = [];
    for (const [apiPath, pathItem] of Object.entries(api.paths || {})) {
      for (const [method, details] of Object.entries(pathItem)) {
        if (!["get", "post", "put", "delete", "patch", "options", "head"].includes(method)) {
          continue;
        }
        const { pathParams, queryParams, headerParams } = extractParams(details, pathItem, api);
        // `api` is passed through so any $ref left unresolved by a failed
        // dereference() (see the try/catch above) still gets looked up —
        // otherwise every param/body/header tied to a shared component
        // schema silently comes back empty. See schemaToTemplate.js.
        const bodyTemplate = extractRequestBodyTemplate(details, pathItem, api);
        endpoints.push({
          id: `${method.toUpperCase()}_${apiPath}`,
          method: method.toUpperCase(),
          path: apiPath,
          summary: details.summary || details.operationId || "",
          tag: (details.tags && details.tags[0]) || "default",
          // pathParams/queryParams/headerParams/bodyTemplate feed the
          // Flow-step body/query/header prefill (FlowBuilder.jsx's
          // emptyStep()) — keep these exactly as-is, unrelated code
          // depends on this shape.
          pathParams: pathParams.map((p) => p.name),
          queryParams,
          headerParams,
          bodyTemplate,
          // parameters/requestBody carry the fuller type/required/example
          // metadata that SwaggerEndpointPicker.jsx's schema preview reads
          // (endpoint.parameters, endpoint.requestBody.fields/.contentType).
          parameters: extractParamSchema(details, pathItem, api),
          requestBody: extractRequestBodySchema(details, pathItem, api),
        });
      }
    }

    if (endpoints.length === 0) {
      return res.status(422).json({ error: "No endpoints found in the provided spec." });
    }

    res.json({
      title: api.info?.title || "Untitled API",
      version: api.info?.version || "",
      baseUrl: (api.servers && api.servers[0]?.url) || api.host || "",
      resolvedFrom: specSource !== trimmedUrl ? specSource : undefined,
      totalEndpoints: endpoints.length,
      endpoints,
    });
  } catch (err) {
    console.error("Swagger parse-url error:", err);
    console.error("Response preview (first 300 chars):", precheckText.slice(0, 300));
    res.status(422).json({
      error: "Failed to fetch or parse the Swagger/OpenAPI spec",
      detail: err.message,
    });
  }
}));

export default router;