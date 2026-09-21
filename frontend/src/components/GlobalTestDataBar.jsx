import { useEffect, useRef, useState } from "react";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { useWorkspace } from "../context/WorkspaceContext";
import { IconChevronDown, IconTable } from "./Icons";

function parseRowsFromFile(file) {
  return new Promise((resolve, reject) => {
    if (/\.xlsx?$/i.test(file.name)) {
      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const workbook = XLSX.read(event.target.result, { type: "array" });
          const sheetName = workbook.SheetNames[0];
          if (!sheetName) throw new Error("Excel file has no sheets.");
          const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
            defval: "",
            raw: false,
          });
          resolve(rows);
        } catch (err) {
          reject(new Error(`Could not read that Excel file: ${err.message}`));
        }
      };
      reader.onerror = () => reject(new Error("Could not read that file."));
      reader.readAsArrayBuffer(file);
      return;
    }

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (parsed) => {
        if (parsed.errors?.length) reject(new Error(parsed.errors[0].message));
        else resolve(parsed.data);
      },
      error: (err) => reject(err),
    });
  });
}

// Reads a file as a raw array-of-arrays (no header-row assumptions) — used
// for the Test Data Excel, where we need to look at the header row
// ourselves to tell a plain one-row-per-test_id sheet apart from the
// paired-column layout (test_id, test_data, test_id, test_data, ...)
// before deciding how to turn it into rows.
function readAoaFromFile(file) {
  return new Promise((resolve, reject) => {
    if (/\.xlsx?$/i.test(file.name)) {
      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const workbook = XLSX.read(event.target.result, { type: "array" });
          const sheetName = workbook.SheetNames[0];
          if (!sheetName) throw new Error("Excel file has no sheets.");
          const aoa = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
            header: 1,
            defval: "",
            raw: false,
          });
          resolve(aoa);
        } catch (err) {
          reject(new Error(`Could not read that Excel file: ${err.message}`));
        }
      };
      reader.onerror = () => reject(new Error("Could not read that file."));
      reader.readAsArrayBuffer(file);
      return;
    }

    Papa.parse(file, {
      header: false,
      skipEmptyLines: true,
      complete: (parsed) => {
        if (parsed.errors?.length) reject(new Error(parsed.errors[0].message));
        else resolve(parsed.data);
      },
      error: (err) => reject(err),
    });
  });
}

function normalizeHeaderText(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[\s_]/g, "");
}

// True when every odd column (0, 2, 4, ...) is a "test_id" header — the
// paired layout described for the Test Data Excel: every 2 columns is one
// test_id plus its own list of test_data values, so a test_id can repeat
// across several rows (one per value) instead of appearing once.
function isPairedTestDataLayout(headerRow) {
  if (!Array.isArray(headerRow) || headerRow.length < 2 || headerRow.length % 2 !== 0) return false;
  for (let i = 0; i < headerRow.length; i += 2) {
    if (normalizeHeaderText(headerRow[i]) !== "testid") return false;
  }
  return true;
}

// Flattens the paired-column layout into one row per (test_id, test_data)
// value — exactly the {test_id, ...contextVars} shape run-bulk already
// expects for a data-driven row, just with multiple rows now legitimately
// sharing the same test_id (one per value) rather than one row per id.
function flattenPairedTestData(aoa) {
  const header = aoa[0] || [];
  const dataRows = aoa.slice(1);
  const out = [];
  for (let col = 0; col < header.length; col += 2) {
    const valueKey = String(header[col + 1] ?? "").trim() || "test_data";
    let currentId = "";
    for (const row of dataRows) {
      const idCell = String(row?.[col] ?? "").trim();
      if (idCell) currentId = idCell;
      const valueCell = row?.[col + 1];
      const value = valueCell === undefined || valueCell === null ? "" : String(valueCell).trim();
      if (!currentId || !value) continue;
      out.push({ test_id: currentId, [valueKey]: value });
    }
  }
  return out;
}

// Old/plain layout: one row = one test_id plus whatever named variable
// columns it needs (rollNumber, teacherId, ...) — unchanged behavior for
// sheets that don't use the paired layout above.
function rowsFromAoa(aoa) {
  const rawHeader = (aoa[0] || []).map((h) => String(h ?? "").trim());

  // Excel/CSV files can contain duplicate headers. Keep a unique internal
  // name while parsing, then collapse every test_id/test_id__N column into
  // ONE canonical test_id value. This prevents a later blank/duplicate
  // test_id column from overwriting the real id and avoids sending
  // test_id__2 into API request context.
  const seen = new Map();
  const header = rawHeader.map((name) => {
    const base = name || "column";
    const key = base.toLowerCase();
    const count = (seen.get(key) || 0) + 1;
    seen.set(key, count);
    return count === 1 ? base : `${base}__${count}`;
  });

  const testIdIndexes = header
    .map((name, index) => ({ name, index }))
    .filter(({ name }) => normalizeHeaderText(String(name).replace(/__\d+$/, "")) === "testid")
    .map(({ index }) => index);

  return aoa
    .slice(1)
    .filter((r) => (r || []).some((cell) => String(cell ?? "").trim() !== ""))
    .map((r) => {
      const obj = {};

      header.forEach((h, i) => {
        const isDuplicateTestId =
          testIdIndexes.includes(i) &&
          i !== testIdIndexes[0];

        if (isDuplicateTestId) return;

        obj[h] = r[i] === undefined || r[i] === null ? "" : String(r[i]).trim();
      });

      let canonicalTestId = "";
      for (const index of testIdIndexes) {
        const value = String(r[index] ?? "").trim();
        if (value) {
          canonicalTestId = value;
          break;
        }
      }

      if (canonicalTestId) obj.test_id = canonicalTestId;

      return obj;
    });
}
function validateHeaders(rows, label) {
  if (!rows?.length) throw new Error(`${label} has no data rows.`);
  const headers = Object.keys(rows[0] || {}).map((x) => String(x).trim());
  const seen = new Set();
  const duplicates = new Set();
  for (const header of headers) {
    if (!header) throw new Error(`${label} contains an empty column name. Rename it before uploading.`);
    const key = header.toLowerCase();
    if (seen.has(key)) duplicates.add(header);
    seen.add(key);
  }
  if (duplicates.size) {
    throw new Error(`${label} contains duplicate column name(s): ${[...duplicates].join(", ")}. Please rename them before uploading.`);
  }
  return headers;
}

// The Test Scenario Excel's join-key column shows up as "test_id",
// "testId", "TC ID", "TC_ID", etc. — match on normalized form instead of
// one hardcoded spelling (kept in sync with the same helper in the
// backend's routes/globalTestData.js).
function findIdKey(row) {
  for (const key of Object.keys(row || {})) {
    if (normalizeHeaderText(key) === "testid" || normalizeHeaderText(key) === "tcid") return key;
  }
  return null;
}

function normalizeScenarioRows(rows) {
  const result = [];
  let currentTestId = "";
  for (const source of rows || []) {
    const row = { ...(source || {}) };
    const idKey = findIdKey(row);
    const id = idKey ? String(row[idKey] ?? "").trim() : "";
    if (id) currentTestId = id;
    if (!currentTestId) continue;
    // Drop the original id column so it doesn't also show up as a
    // duplicate line once the rest of the row becomes free-text scenario
    // context for the AI.
    if (idKey && idKey !== "test_id") delete row[idKey];
    row.test_id = currentTestId;
    result.push(row);
  }
  return result;
}

export default function GlobalTestDataBar() {
  const {
    project,
    globalTestData: data,
    globalTestDataLoading: loading,
    globalTestDataError,
    saveGlobalTestData,
    clearGlobalTestData,
  } = useWorkspace();

  const dataInputRef = useRef(null);
  const scenarioInputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [showColumns, setShowColumns] = useState(false);
  const wrapRef = useRef(null);
  const [pendingDataRows, setPendingDataRows] = useState(null);
  const [pendingDataFile, setPendingDataFile] = useState("");
  const [pendingScenarioRows, setPendingScenarioRows] = useState(null);
  const [pendingScenarioFile, setPendingScenarioFile] = useState("");

  async function uploadPart(file, type) {
    if (!file || !project) return;
    setUploading(true);
    setError("");
    try {
      if (type === "data") {
        // Test Data Excel: figure out the layout from the header row
        // before deciding how to turn it into rows — paired columns
        // (test_id, test_data, test_id, test_data, ...) flatten to one
        // row per value; anything else is the older one-row-per-test_id
        // layout, unchanged.
        const aoa = await readAoaFromFile(file);
        if (!aoa.length) throw new Error("Test data Excel has no rows.");
        const headerRow = aoa[0] || [];
        const rows = isPairedTestDataLayout(headerRow) ? flattenPairedTestData(aoa) : rowsFromAoa(aoa);
        if (!rows.length) {
          throw new Error("Test data Excel produced no usable rows — check that every test_id has a value next to it.");
        }
        if (!isPairedTestDataLayout(headerRow)) validateHeaders(rows, "Test data Excel");
        setPendingDataRows(rows);
        setPendingDataFile(file.name);
      } else {
        const rows = await parseRowsFromFile(file);
        validateHeaders(rows, "Test scenario Excel");
        const normalized = normalizeScenarioRows(rows);
        if (!normalized.length) {
          throw new Error("Test scenario Excel must contain at least one row with a TC ID / test_id.");
        }
        setPendingScenarioRows(normalized);
        setPendingScenarioFile(file.name);
      }
    } catch (err) {
      setError(err.message || "Could not read the file.");
    } finally {
      setUploading(false);
    }
  }

  async function handleDataUpload(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) await uploadPart(file, "data");
  }

  async function handleScenarioUpload(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) await uploadPart(file, "scenario");
  }

  // Saves whichever file(s) were picked. Replacing only the Test Data Excel
  // leaves the saved Test Scenario Excel exactly as it was, and vice versa.
  async function savePending() {
    if (!project || !hasPending) {
      setError("Upload a Test Data Excel or a Test Scenario Excel before saving.");
      return;
    }
    setUploading(true);
    setError("");
    try {
      const parts = {};
      if (pendingDataRows) {
        parts.fileName = pendingDataFile;
        parts.rows = pendingDataRows;
      }
      if (pendingScenarioRows) {
        parts.scenarioFileName = pendingScenarioFile;
        parts.scenarios = pendingScenarioRows;
      }
      await saveGlobalTestData(project, parts);
      setPendingDataRows(null);
      setPendingScenarioRows(null);
      setPendingDataFile("");
      setPendingScenarioFile("");
      setOpen(false);
    } catch (err) {
      setError(err.message || "Could not save test data.");
    } finally {
      setUploading(false);
    }
  }

  async function handleClear() {
    if (!project || uploading) return;
    setUploading(true);
    setError("");
    try {
      await clearGlobalTestData(project);
      setPendingDataRows(null);
      setPendingScenarioRows(null);
      setPendingDataFile("");
      setPendingScenarioFile("");
    } catch (err) {
      setError(err.message || "Could not clear test data.");
    } finally {
      setUploading(false);
    }
  }

  // Close the popover on outside click / Escape (uploads keep their pending
  // state, so closing never loses a selected-but-unsaved file).
  useEffect(() => {
    if (!open) return undefined;
    function onDown(event) {
      if (wrapRef.current && !wrapRef.current.contains(event.target)) setOpen(false);
    }
    function onKey(event) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!project) return null;

  const displayError = error || globalTestDataError;
  const savedScenarioCount = data?.scenarios?.length || 0;
  const savedRowCount = data?.rows?.length || 0;
  const busy = uploading || loading;
  const hasPending = Boolean(pendingDataRows || pendingScenarioRows);
  const readyToSave = hasPending;
  let saveLabel = "Save test data";
  if (pendingDataRows && pendingScenarioRows) saveLabel = "Save both files";
  else if (pendingScenarioRows) saveLabel = "Save test scenarios";

  let chipLabel = "Add test data";
  if (loading) chipLabel = "Test data…";
  else if (hasPending) chipLabel = "Test data · unsaved";
  else if (data) chipLabel = `Test data · ${savedRowCount} row${savedRowCount === 1 ? "" : "s"}`;

  return (
    <div className="wb-data" ref={wrapRef}>
      <button
        type="button"
        className={`wb-chip ${open ? "is-open" : ""}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        title="Upload the Test Data and Test Scenario Excel files used for data-driven and AI runs"
      >
        <IconTable size={14} />
        <span>{chipLabel}</span>
        {hasPending ? (
          <span className="wb-status-dot wb-status-dot--warn" aria-label="Unsaved uploads" />
        ) : data ? (
          <span className="wb-status-dot" aria-label="Test data saved" />
        ) : null}
        <IconChevronDown size={14} />
      </button>

      <input ref={dataInputRef} type="file" accept=".csv,.xlsx,.xls" onChange={handleDataUpload} disabled={busy} hidden />
      <input ref={scenarioInputRef} type="file" accept=".csv,.xlsx,.xls" onChange={handleScenarioUpload} disabled={busy} hidden />

      {open && (
        <div className="wb-pop wb-data-panel">
          <div className="wb-pop-head">
            <div>
              <h3>Test data</h3>
              <p>Used for data-driven runs and AI grading. Replace either file and save — the other one stays as it is.</p>
            </div>
          </div>

          <ul className="wb-data-list">
            <li className="wb-data-item">
              <div className="wb-data-item-text">
                <strong>Test data</strong>
                <span className="wb-muted">
                  {pendingDataFile
                    ? `${pendingDataFile} — ready to save`
                    : data
                      ? `${data.fileName || "Saved"} — ${savedRowCount} row${savedRowCount === 1 ? "" : "s"}, ${data.columns?.length || 0} column${(data.columns?.length || 0) === 1 ? "" : "s"}`
                      : "Not uploaded"}
                </span>
              </div>
              <button type="button" className="wb-btn wb-btn--sm" onClick={() => dataInputRef.current?.click()} disabled={busy}>
                {data || pendingDataFile ? "Replace" : "Upload"}
              </button>
            </li>

            <li className="wb-data-item">
              <div className="wb-data-item-text">
                <strong>Test scenarios</strong>
                <span className="wb-muted">
                  {pendingScenarioFile
                    ? `${pendingScenarioFile} — ready to save`
                    : data?.scenarioFileName
                      ? `${data.scenarioFileName} — ${savedScenarioCount} row${savedScenarioCount === 1 ? "" : "s"}`
                      : "Not uploaded"}
                </span>
              </div>
              <button type="button" className="wb-btn wb-btn--sm" onClick={() => scenarioInputRef.current?.click()} disabled={busy}>
                {data?.scenarioFileName || pendingScenarioFile ? "Replace" : "Upload"}
              </button>
            </li>
          </ul>

          {data && (data.columns || []).length > 0 && (
            <div className="wb-data-columns">
              <button type="button" className="wb-link" onClick={() => setShowColumns((value) => !value)}>
                {showColumns ? "Hide columns" : `Show ${data.columns.length} column${data.columns.length === 1 ? "" : "s"}`}
              </button>
              {showColumns && (
                <div className="wb-data-column-list">
                  {data.columns.map((column) => <code key={column}>{column}</code>)}
                </div>
              )}
            </div>
          )}

          {hasPending && !(pendingDataRows && pendingScenarioRows) && (
            <p className="wb-help">
              {pendingDataRows
                ? (data?.scenarioFileName
                    ? `Only the test data will change — ${data.scenarioFileName} stays saved.`
                    : "Only the test data will be saved.")
                : (data?.fileName
                    ? `Only the test scenarios will change — ${data.fileName} stays saved.`
                    : "Only the test scenarios will be saved.")}
            </p>
          )}

          {displayError && <p className="wb-error" role="alert">{displayError}</p>}

          {(readyToSave || data) && (
            <div className="wb-pop-foot">
              {data ? (
                <button type="button" className="wb-btn wb-btn--quiet wb-btn--danger" onClick={handleClear} disabled={busy}>
                  Clear saved data
                </button>
              ) : <span />}
              {readyToSave && (
                <button type="button" className="wb-btn wb-btn--primary" onClick={savePending} disabled={busy}>
                  {uploading ? "Saving…" : saveLabel}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}