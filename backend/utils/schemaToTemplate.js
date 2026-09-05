// server/utils/schemaToTemplate.js
//
// Turns an OpenAPI/Swagger JSON schema into a plain JS value shaped like a
// real request body — every property name already present as a key, with a
// sensible placeholder value — so a user picking an endpoint from the
// Swagger picker gets a body template with all the right KEYS already
// filled in and only has to type VALUES. Also pulls out path/query/header
// parameter names the same way.
//
// Normally the caller has already run the whole document through
// SwaggerParser.dereference(), so every $ref is inlined and this module
// wouldn't need to look at `api` at all. But dereference() can throw on
// some real-world specs (unusual circular shapes, certain OpenAPI 3.1
// constructs) — see routes/testFromSpec.js's fallback to a plain
// SwaggerParser.parse(). A plain parse leaves every $ref (e.g.
// `{ $ref: "#/components/schemas/AcademicYear" }`) unresolved, which
// silently produced empty params/body/headers for every endpoint that used
// a shared component schema. To make that failure mode harmless, every
// schema this module touches is resolved against the full `api` document
// right before use, so it works whether or not upstream dereference
// succeeded.
const PRIMITIVE_DEFAULTS = {
  string: "",
  integer: 0,
  number: 0,
  boolean: false,
};

const MAX_DEPTH = 6;

// Follows a local JSON-pointer $ref ("#/components/schemas/Foo" or the
// Swagger 2.0 "#/definitions/Foo" form) against the full parsed document.
// Chases chains of $refs (a ref pointing at another ref) with a cycle
// guard. Returns the schema unchanged if it isn't a $ref, api is missing,
// or the pointer can't be resolved (best-effort — never throws).
function resolveRef(schema, api, seen) {
  let current = schema;
  let guard = 0;
  while (current && typeof current === "object" && typeof current.$ref === "string" && guard < 20) {
    guard += 1;
    if (seen.has(current)) return {};
    seen.add(current);
    if (!api) return current;
    const pointer = current.$ref.startsWith("#/") ? current.$ref.slice(2) : current.$ref;
    const parts = pointer.split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
    let node = api;
    for (const part of parts) {
      if (node == null) break;
      node = node[part];
    }
    if (node == null) return current;
    current = node;
  }
  return current;
}

export function schemaToTemplate(schema, api, seen = new Set(), depth = 0) {
  if (!schema || typeof schema !== "object" || depth > MAX_DEPTH) return "";
  const resolved = resolveRef(schema, api, seen);
  if (!resolved || typeof resolved !== "object") return "";
  // dereference() (or resolveRef above, for circular $refs) reuses the same
  // object for circular references — without this guard a self-referencing
  // schema (e.g. a "parent" field pointing back to its own type) would
  // recurse forever.
  if (seen.has(resolved)) return {};
  seen.add(resolved);

  if (resolved.example !== undefined) return resolved.example;
  if (resolved.default !== undefined) return resolved.default;
  if (Array.isArray(resolved.enum) && resolved.enum.length > 0) return resolved.enum[0];

  if (Array.isArray(resolved.allOf) && resolved.allOf.length > 0) {
    return resolved.allOf.reduce((acc, sub) => {
      const t = schemaToTemplate(sub, api, seen, depth + 1);
      return t && typeof t === "object" && !Array.isArray(t) ? { ...acc, ...t } : acc;
    }, {});
  }
  if (Array.isArray(resolved.oneOf) && resolved.oneOf.length > 0) {
    return schemaToTemplate(resolved.oneOf[0], api, seen, depth + 1);
  }
  if (Array.isArray(resolved.anyOf) && resolved.anyOf.length > 0) {
    return schemaToTemplate(resolved.anyOf[0], api, seen, depth + 1);
  }

  const type = resolved.type || (resolved.properties ? "object" : undefined);

  if (type === "object" || resolved.properties) {
    const out = {};
    for (const [key, propSchema] of Object.entries(resolved.properties || {})) {
      out[key] = schemaToTemplate(propSchema, api, seen, depth + 1);
    }
    return out;
  }
  if (type === "array") {
    return resolved.items ? [schemaToTemplate(resolved.items, api, seen, depth + 1)] : [];
  }
  if (type in PRIMITIVE_DEFAULTS) return PRIMITIVE_DEFAULTS[type];
  return "";
}

/**
 * details = the operation object for this method (e.g. api.paths[p].post)
 * pathItem = the shared object for this path (e.g. api.paths[p]) — carries
 * path-level `parameters` that apply to every method under it.
 * api = the full parsed document, passed through so any unresolved $ref
 * can be looked up (see the module-level comment above).
 */
export function extractRequestBodyTemplate(details, pathItem, api) {
  // requestBody itself can be a $ref to a shared components/requestBodies
  // entry, same reasoning as resolveParamList() above.
  const requestBody = resolveRef(details?.requestBody, api, new Set());
  // OpenAPI 3: requestBody.content["application/json"].schema (or the
  // first content type present if JSON isn't offered).
  const content = requestBody?.content;
  if (content && typeof content === "object") {
    const keys = Object.keys(content);
    const jsonKey = keys.find((k) => k.toLowerCase().includes("json")) || keys[0];
    const schema = jsonKey && content[jsonKey]?.schema;
    if (schema) {
      const template = schemaToTemplate(schema, api);
      if (template && typeof template === "object") return template;
    }
  }

  // Swagger 2.0: a parameter with in: "body" carries the schema directly.
  const allParams = resolveParamList([...(pathItem?.parameters || []), ...(details?.parameters || [])], api);
  const bodyParam = allParams.find((p) => p && p.in === "body");
  if (bodyParam?.schema) {
    const template = schemaToTemplate(bodyParam.schema, api);
    if (template && typeof template === "object") return template;
  }

  return undefined;
}

// A parameter entry can itself be a $ref (OpenAPI 3 lets you define a
// shared header/query param once under components/parameters and
// reference it from every operation that needs it — e.g. a required
// "X-Tenant-Id" header). Without resolving the entry itself (not just its
// .schema), every operation using a shared parameter silently lost that
// parameter whenever dereference() fell back to a plain parse().
function resolveParamList(rawParams, api) {
  const seen = new Set();
  return rawParams
    .map((p) => resolveRef(p, api, seen))
    .filter((p) => p && typeof p === "object" && p.name);
}

export function extractParams(details, pathItem, api) {
  const allParams = resolveParamList([...(pathItem?.parameters || []), ...(details?.parameters || [])], api);
  const pathParams = [];
  const queryParams = [];
  const headerParams = [];
  for (const p of allParams) {
    if (p.in === "path") pathParams.push({ name: p.name, required: p.required !== false });
    else if (p.in === "query") queryParams.push({ name: p.name, required: !!p.required });
    // Authorization is always supplied by the flow's own auth setup, never
    // by a swagger-prefilled header — skip it here so it can't collide.
    else if (p.in === "header" && p.name.toLowerCase() !== "authorization") {
      headerParams.push({ name: p.name, required: !!p.required });
    }
  }
  return { pathParams, queryParams, headerParams };
}

/**
 * Full parameter metadata (name/in/type/required/example/enum) for every
 * path+query+header+cookie parameter on this operation. This is separate
 * from extractParams() above (which only returns {name, required} and
 * feeds the Flow-step body/query/header prefill) — this one feeds the
 * "Show schema" preview in SwaggerEndpointPicker.jsx, which needs
 * type/example info that extractParams() never carried.
 *
 * Handles both param shapes:
 *  - Swagger 2.0: type/enum live directly on the parameter (p.type, p.enum)
 *  - OpenAPI 3:   type/enum live under p.schema (p.schema.type, p.schema.enum),
 *    which may itself still be an unresolved $ref — resolved against `api`.
 */
export function extractParamSchema(details, pathItem, api) {
  const allParams = resolveParamList([...(pathItem?.parameters || []), ...(details?.parameters || [])], api);
  const out = [];
  for (const p of allParams) {
    if (!p.in) continue;
    const rawSchema = p.schema && typeof p.schema === "object" ? p.schema : p;
    const schema = resolveRef(rawSchema, api, new Set()) || {};
    out.push({
      name: p.name,
      in: p.in,
      type: schema.type || (schema.enum ? typeof schema.enum[0] : "string"),
      required: p.in === "path" ? true : !!p.required,
      example:
        p.example !== undefined
          ? p.example
          : schema.example !== undefined
            ? schema.example
            : schema.default !== undefined
              ? schema.default
              : undefined,
      enum: Array.isArray(schema.enum) ? schema.enum : undefined,
    });
  }
  return out;
}

/**
 * Flattens a request-body schema into a list of {path, type, required,
 * example, enum} rows (dot-notation for nested objects, "[]" suffix for
 * array items) for the schema preview table. Mirrors schemaToTemplate()'s
 * traversal (including the circular-ref guard and $ref resolution) but
 * records field metadata instead of building a filled-in value.
 */
function flattenSchemaFields(schema, api, basePath, out, seen, depth) {
  if (!schema || typeof schema !== "object" || depth > MAX_DEPTH) return;
  const resolved = resolveRef(schema, api, seen);
  if (!resolved || typeof resolved !== "object") return;
  if (seen.has(resolved)) return;
  seen.add(resolved);

  if (Array.isArray(resolved.allOf)) {
    for (const sub of resolved.allOf) flattenSchemaFields(sub, api, basePath, out, seen, depth + 1);
    return;
  }
  const branch =
    (Array.isArray(resolved.oneOf) && resolved.oneOf[0]) ||
    (Array.isArray(resolved.anyOf) && resolved.anyOf[0]);
  if (branch) {
    flattenSchemaFields(branch, api, basePath, out, seen, depth + 1);
    return;
  }

  const type = resolved.type || (resolved.properties ? "object" : resolved.items ? "array" : undefined);

  if (type === "object" || resolved.properties) {
    const requiredHere = Array.isArray(resolved.required) ? resolved.required : [];
    for (const [key, rawPropSchema] of Object.entries(resolved.properties || {})) {
      const propSchema = resolveRef(rawPropSchema, api, seen) || {};
      const path = basePath ? `${basePath}.${key}` : key;
      const propType =
        propSchema.type || (propSchema.properties ? "object" : propSchema.items ? "array" : "string");
      out.push({
        path,
        type: propType,
        required: requiredHere.includes(key),
        example:
          propSchema.example !== undefined
            ? propSchema.example
            : propSchema.default !== undefined
              ? propSchema.default
              : undefined,
        enum: Array.isArray(propSchema.enum) ? propSchema.enum : undefined,
      });
      if (propType === "object" || propType === "array") {
        flattenSchemaFields(
          propType === "array" ? propSchema.items : propSchema,
          api,
          propType === "array" ? `${path}[]` : path,
          out,
          seen,
          depth + 1
        );
      }
    }
    return;
  }
  if (type === "array" && resolved.items) {
    flattenSchemaFields(resolved.items, api, basePath ? `${basePath}[]` : "[]", out, seen, depth + 1);
  }
}

/**
 * details/pathItem — same as extractRequestBodyTemplate(). Returns
 * { required, contentType, fields } or undefined if this operation has
 * no request body, for the SwaggerEndpointPicker schema preview.
 */
export function extractRequestBodySchema(details, pathItem, api) {
  const requestBody = resolveRef(details?.requestBody, api, new Set());
  const content = requestBody?.content;
  if (content && typeof content === "object") {
    const keys = Object.keys(content);
    const jsonKey = keys.find((k) => k.toLowerCase().includes("json")) || keys[0];
    const schema = jsonKey && content[jsonKey]?.schema;
    if (schema) {
      const fields = [];
      flattenSchemaFields(schema, api, "", fields, new Set(), 0);
      return {
        required: !!requestBody.required,
        contentType: jsonKey,
        fields,
      };
    }
  }

  const allParams = resolveParamList([...(pathItem?.parameters || []), ...(details?.parameters || [])], api);
  const bodyParam = allParams.find((p) => p && p.in === "body");
  if (bodyParam?.schema) {
    const fields = [];
    flattenSchemaFields(bodyParam.schema, api, "", fields, new Set(), 0);
    return {
      required: bodyParam.required !== false,
      contentType: "application/json",
      fields,
    };
  }

  return undefined;
}