import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// Three-dot "⋯" button that opens a small Rename / Delete menu.
// Rendered in a portal so the scrolling sidebar can't clip it.
export default function RowMenu({ label = "Item", className = "", onRename, onDelete }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const buttonRef = useRef(null);
  const menuRef = useRef(null);

  function close() {
    setOpen(false);
    setPos(null);
  }

  useLayoutEffect(() => {
    if (!open || !menuRef.current || !buttonRef.current) return;
    const btn = buttonRef.current.getBoundingClientRect();
    const menu = menuRef.current.getBoundingClientRect();
    let top = btn.bottom + 4;
    if (top + menu.height > window.innerHeight - 8) {
      top = Math.max(8, btn.top - menu.height - 4);
    }
    const left = Math.min(
      Math.max(8, btn.right - menu.width),
      window.innerWidth - menu.width - 8
    );
    setPos({ top, left });
  }, [open]);

  useEffect(() => {
    if (open && pos) menuRef.current?.querySelector("button")?.focus();
  }, [open, pos]);

  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(e) {
      if (menuRef.current?.contains(e.target) || buttonRef.current?.contains(e.target)) return;
      close();
    }
    function onKeyDown(e) {
      if (e.key === "Escape") {
        close();
        buttonRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  function handleMenuKeyDown(e) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...menuRef.current.querySelectorAll("button")];
    const next = items.indexOf(document.activeElement) + (e.key === "ArrowDown" ? 1 : -1);
    items[(next + items.length) % items.length]?.focus();
  }

  function pick(action) {
    close();
    action();
  }

  return (
    <span className={`row-menu-slot ${className} ${open ? "is-open" : ""}`}>
      <button
        ref={buttonRef}
        type="button"
        className="row-menu-btn"
        aria-label={`${label} actions`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="More actions"
        onClick={(e) => {
          e.stopPropagation();
          if (open) close();
          else setOpen(true);
        }}
      >
        ⋯
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="row-menu-popover"
            role="menu"
            style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: "hidden" }}
            onKeyDown={handleMenuKeyDown}
          >
            <button type="button" role="menuitem" className="row-menu-item" onClick={() => pick(onRename)}>
              <span aria-hidden="true">✎</span> Rename
            </button>
            <button type="button" role="menuitem" className="row-menu-item row-menu-item--danger" onClick={() => pick(onDelete)}>
              <span aria-hidden="true">🗑</span> Delete
            </button>
          </div>,
          document.body
        )}
    </span>
  );
}