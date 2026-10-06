/**
 * Why: a theme file is untrusted and lands in CSS variables and canvas
 * styles. If the validator lets a url()/var()/style injection through, a
 * shared theme becomes a tracking beacon or a UI-spoofing tool.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_DARK, DEFAULT_LIGHT } from "./theme";
import { isSafeColor, isSafeFontStack, resolveTheme, themeJsonSchema, validateTheme } from "./themeFile";

const base = { id: "nord", name: "Nord", base: "dark", tokens: {} };

describe("isSafeColor", () => {
  it.each(["#fff", "#FFFA", "#1e2025", "#1e202580", "rgb(1, 2, 3)", "rgba(0,0,0,.5)", "rgb(0 0 0 / 50%)", "hsl(210, 20%, 30%)", "hsla(210deg 20% 30% / .4)", "rebeccapurple", "transparent"])(
    "accepts %s",
    (c) => expect(isSafeColor(c)).toBe(true),
  );
  it.each(["url(http://x/y.png)", "var(--bg)", "calc(1px)", "#12", "#12345", "red; background:url(x)", "rgb(1,2,3) } body{", "expression(alert(1))", "", "javascript:1", 5, null, "rgb(1,2)", "notacolour"])(
    "rejects %s",
    (c) => expect(isSafeColor(c)).toBe(false),
  );
});

describe("isSafeFontStack", () => {
  it("accepts whitelisted stacks and rejects the rest", () => {
    expect(isSafeFontStack('"Segoe UI", system-ui, sans-serif')).toBe(true);
    expect(isSafeFontStack("Comic Sans MS")).toBe(false);
    expect(isSafeFontStack("Arial; background:red")).toBe(false);
    expect(isSafeFontStack("url(x)")).toBe(false);
  });
});

describe("validateTheme", () => {
  it("accepts a minimal theme", () => expect(validateTheme(base).ok).toBe(true));
  it("rejects non-objects, bad ids, bad base, unknown fields, missing parts", () => {
    expect(validateTheme(null).ok).toBe(false);
    expect(validateTheme([]).ok).toBe(false);
    expect(validateTheme({ ...base, id: "Has Space" }).ok).toBe(false);
    expect(validateTheme({ ...base, base: "blue" }).ok).toBe(false);
    expect(validateTheme({ ...base, extra: 1 }).ok).toBe(false);
    expect(validateTheme({ id: "a", name: "A", base: "dark" }).ok).toBe(false);
  });
  it("reports the exact path of an unsafe token", () => {
    const r = validateTheme({ ...base, tokens: { canvas: { bg: "url(//evil/x)", entity: "#fff", nope: "#000" }, ui: { bg: "var(--x)" }, bogus: {} } });
    expect(r.ok).toBe(false);
    const paths = !r.ok ? r.issues.map((i) => i.path).sort() : [];
    expect(paths).toEqual(["tokens.bogus", "tokens.canvas.bg", "tokens.canvas.nope", "tokens.ui.bg"]);
  });
  it("validates fonts", () => {
    expect(validateTheme({ ...base, tokens: { fonts: { ui: "Inter, sans-serif" } } }).ok).toBe(true);
    expect(validateTheme({ ...base, tokens: { fonts: { ui: "Evil Font" } } }).ok).toBe(false);
    expect(validateTheme({ ...base, tokens: { fonts: { weird: "Inter" } } }).ok).toBe(false);
  });
  it("survives prototype-pollution-shaped input", () => {
    const evil = JSON.parse('{"id":"a","name":"A","base":"dark","tokens":{"__proto__":{"bg":"#fff"},"toString":{},"canvas":{"__proto__":"x"}}}');
    expect(validateTheme(evil).ok).toBe(false);
    expect(({} as Record<string, unknown>).bg).toBeUndefined();
  });
});

describe("resolveTheme", () => {
  it("overlays tokens on the base and leaves the rest alone", () => {
    const v = validateTheme({ ...base, base: "light", tokens: { canvas: { bg: "#ffffff" } } });
    if (!v.ok) throw new Error("invalid");
    const t = resolveTheme(v.theme);
    expect(t.canvas.bg).toBe("#ffffff");
    expect(t.canvas.entity).toBe(DEFAULT_LIGHT.canvas.entity);
    expect(t.ui).toEqual(DEFAULT_LIGHT.ui);
    expect(DEFAULT_DARK.canvas.bg).not.toBe("#ffffff");
  });
});

describe("theme.schema.json", () => {
  it("matches themeJsonSchema() — regenerate with `npm run theme:schema` if tokens change", () => {
    const committed = JSON.parse(readFileSync(new URL("./theme.schema.json", import.meta.url), "utf8"));
    expect(committed).toEqual(JSON.parse(JSON.stringify(themeJsonSchema())));
  });
});
