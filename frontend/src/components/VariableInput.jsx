import { useLayoutEffect, useRef } from "react";

// Value field that shows every {{variable}} as a removable pill (✕) while the
// rest of the text stays normally editable — e.g. "Bearer {{access_token}}"
// renders as:  Bearer [access_token ✕]
//
// The stored value is still the plain string, so nothing else in the app
// (saving, running, codegen) changes.

// "Bearer {{a}}{{b}}" -> ["Bearer ", "{{a}}", "", "{{b}}", ""]
// Even indexes are plain text (always present, possibly empty — before,
// between and after pills, so there is always somewhere to type); odd
// indexes are {{variable}} pills.
const splitValue = (value) => String(value ?? "").split(/(\{\{[^{}]+\}\})/);

// Maps a caret position in the full string back to { part index, offset }.
function locate(parts, pos) {
  let seen = 0;
  for (let k = 0; k < parts.length; k += 1) {
    const end = seen + parts[k].length;
    if (pos <= end) {
      // A caret inside/at the end of a pill belongs right after it.
      return k % 2 === 0 ? { index: k, caret: pos - seen } : { index: k + 1, caret: 0 };
    }
    seen = end;
  }
  const last = parts.length - 1;
  return { index: last, caret: parts[last].length };
}

export default function VariableInput({ value, onChange, placeholder, className = "" }) {
  const parts = splitValue(value);
  const inputRefs = useRef([]);
  const pending = useRef(null); // { pos, value } — where the caret goes after our own edit

  // After our own edit, put the caret back where the user expects it (also
  // covers a pill being created by typing "{{x}}" or removed with ✕/Backspace).
  useLayoutEffect(() => {
    const target = pending.current;
    pending.current = null;
    if (!target || target.value !== String(value ?? "")) return;
    const { index, caret } = locate(splitValue(value), target.pos);
    const el = inputRefs.current[index];
    if (el) {
      el.focus();
      el.setSelectionRange(caret, caret);
    }
  });

  const offsetBefore = (i) => parts.slice(0, i).reduce((n, p) => n + p.length, 0);

  function commit(nextParts, pos) {
    const next = nextParts.join("");
    pending.current = { pos, value: next };
    onChange(next);
  }

  function handleText(i, e) {
    const next = parts.slice();
    next[i] = e.target.value;
    commit(next, offsetBefore(i) + (e.target.selectionStart ?? e.target.value.length));
  }

  function removePill(i) {
    const next = parts.slice();
    next[i] = "";
    commit(next, offsetBefore(i));
  }

  function focusPart(index, caret) {
    const el = inputRefs.current[index];
    if (!el) return;
    el.focus();
    el.setSelectionRange(caret, caret);
  }

  function handleKeyDown(i, e) {
    const el = e.currentTarget;
    const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
    const atEnd = el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
    if (e.key === "Backspace" && atStart && i > 0) {
      e.preventDefault();
      removePill(i - 1);
    } else if (e.key === "Delete" && atEnd && i < parts.length - 1) {
      e.preventDefault();
      removePill(i + 1);
    } else if (e.key === "ArrowLeft" && atStart && i > 0) {
      e.preventDefault();
      focusPart(i - 2, parts[i - 2].length);
    } else if (e.key === "ArrowRight" && atEnd && i < parts.length - 1) {
      e.preventDefault();
      focusPart(i + 2, 0);
    }
  }

  const isEmpty = String(value ?? "") === "";

  return (
    <div
      className={`var-input ${className}`}
      onMouseDown={(e) => {
        // Clicking the empty area of the field puts the cursor at the end.
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        const last = parts.length - 1;
        focusPart(last, parts[last].length);
      }}
    >
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <span className="var-chip" key={i} title={part}>
            <span className="var-chip-label">{part.slice(2, -2).trim()}</span>
            <button
              type="button"
              className="var-chip-remove"
              aria-label={`Remove ${part.slice(2, -2).trim()}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => removePill(i)}
            >
              ✕
            </button>
          </span>
        ) : (
          <input
            key={i}
            ref={(el) => {
              inputRefs.current[i] = el;
            }}
            type="text"
            className="var-input-text"
            aria-label="Value"
            placeholder={isEmpty ? placeholder : undefined}
            value={part}
            style={i < parts.length - 1 ? { width: part ? `${part.length + 1}ch` : "6px" } : undefined}
            onChange={(e) => handleText(i, e)}
            onKeyDown={(e) => handleKeyDown(i, e)}
          />
        )
      )}
    </div>
  );
}