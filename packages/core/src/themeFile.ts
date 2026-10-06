/**
 * TH-01: the `.sketchor-theme.json` format. A theme file is untrusted input
 * that ends up in CSS custom properties and canvas fillStyles, so the
 * validator accepts *only* colour values (hex / rgb() / hsl() / a CSS colour
 * name) and a whitelisted set of font families. No `url()`, `var()`,
 * `calc()`, semicolons or braces can get through — a theme cannot fetch a
 * remote image, exfiltrate data via a URL, or inject a stylesheet.
 * Tokens a theme doesn't set fall back to its `base` ("dark" | "light").
 */
import { defaultTheme, type FontTokens, type ThemeMode, type ThemeTokens } from "./theme";

export const THEME_SCHEMA_URL = "https://sketchor.sergioalexo.com/schemas/theme-1.json";

export interface ThemeFile {
  $schema?: string;
  id: string;
  name: string;
  author?: string;
  version?: string;
  base: ThemeMode;
  tokens: ThemeOverrides;
}

export type ThemeOverrides = {
  [G in "ui" | "canvas" | "model3d" | "code"]?: Partial<ThemeTokens[G]>;
} & { fonts?: FontTokens };

export interface ThemeIssue {
  path: string;
  message: string;
}

const NAMED_COLORS = new Set(
  (
    "transparent aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown " +
    "burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod " +
    "darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon " +
    "darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey " +
    "dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey " +
    "honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral " +
    "lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue " +
    "lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine " +
    "mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise " +
    "mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered " +
    "orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple " +
    "rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue " +
    "slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white " +
    "whitesmoke yellow yellowgreen"
  ).split(" "),
);

const NUM = "[+-]?(?:\\d+\\.?\\d*|\\.\\d+)";
const ALPHA = `(?:\\s*[,/]\\s*${NUM}%?)?`;
const RGB = new RegExp(`^rgba?\\(\\s*${NUM}%?\\s*[,\\s]\\s*${NUM}%?\\s*[,\\s]\\s*${NUM}%?${ALPHA}\\s*\\)$`, "i");
const HSL = new RegExp(`^hsla?\\(\\s*${NUM}(?:deg)?\\s*[,\\s]\\s*${NUM}%\\s*[,\\s]\\s*${NUM}%${ALPHA}\\s*\\)$`, "i");
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** True for a plain CSS colour value and nothing else. */
export function isSafeColor(v: unknown): v is string {
  if (typeof v !== "string" || v.length > 64) return false;
  const s = v.trim();
  return HEX.test(s) || RGB.test(s) || HSL.test(s) || NAMED_COLORS.has(s.toLowerCase());
}

export const THEME_FONT_WHITELIST: readonly string[] = [
  "system-ui", "sans-serif", "serif", "monospace", "ui-monospace", "ui-sans-serif",
  "Segoe UI", "Cascadia Code", "Consolas", "Arial", "Helvetica", "Helvetica Neue", "Inter", "Roboto",
  "SF Pro Text", "SF Mono", "Menlo", "Monaco", "Courier New", "Fira Code", "JetBrains Mono",
  "Source Code Pro", "Georgia", "Verdana", "Tahoma", "Ubuntu", "Noto Sans",
];

/** A font stack is valid when every comma-separated family (quotes optional) is whitelisted. */
export function isSafeFontStack(v: unknown): v is string {
  if (typeof v !== "string" || v.length > 200) return false;
  const families = v.split(",").map((f) => f.trim().replace(/^(["'])(.*)\1$/, "$2"));
  const allowed = THEME_FONT_WHITELIST.map((f) => f.toLowerCase());
  return families.length > 0 && families.every((f) => allowed.includes(f.toLowerCase()));
}

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Token groups and keys a theme may set — taken from the dark default so it can't drift from `ThemeTokens`. */
export function themeTokenKeys(): Record<"ui" | "canvas" | "model3d" | "code", string[]> {
  const t = defaultTheme("dark");
  return { ui: Object.keys(t.ui), canvas: Object.keys(t.canvas), model3d: Object.keys(t.model3d), code: Object.keys(t.code) };
}

export type ThemeValidation = { ok: true; theme: ThemeFile } | { ok: false; issues: ThemeIssue[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

export function validateTheme(input: unknown): ThemeValidation {
  const issues: ThemeIssue[] = [];
  const bad = (path: string, message: string) => issues.push({ path, message });
  if (!isObj(input)) return { ok: false, issues: [{ path: "", message: "a theme must be a JSON object" }] };

  const str = (key: string, required: boolean, max: number) => {
    const v = input[key];
    if (v === undefined) {
      if (required) bad(key, "is required");
      return undefined;
    }
    if (typeof v !== "string" || v.length > max || (required && !v.trim())) {
      bad(key, `must be a string of at most ${max} characters`);
      return undefined;
    }
    return v;
  };
  const id = str("id", true, 64);
  if (id !== undefined && !ID.test(id)) bad("id", "must be lowercase letters, digits, '.', '_' or '-'");
  str("name", true, 80);
  str("author", false, 120);
  str("version", false, 32);
  str("$schema", false, 200);
  if (input.base !== "dark" && input.base !== "light") bad("base", 'must be "dark" or "light"');

  const known = new Set(["$schema", "id", "name", "author", "version", "base", "tokens"]);
  for (const k of Object.keys(input)) if (!known.has(k)) bad(k, "is not a recognised theme field");

  const tokens = input.tokens;
  const keys = themeTokenKeys();
  if (!isObj(tokens)) {
    bad("tokens", "must be an object");
  } else {
    for (const [group, value] of Object.entries(tokens)) {
      if (group === "fonts") {
        if (!isObj(value)) {
          bad("tokens.fonts", "must be an object");
          continue;
        }
        for (const [k, v] of Object.entries(value)) {
          if (k !== "ui" && k !== "mono") bad(`tokens.fonts.${k}`, "is not a known font slot (ui, mono)");
          else if (!isSafeFontStack(v)) bad(`tokens.fonts.${k}`, "must only name fonts from the allowed list");
        }
        continue;
      }
      if (!has(keys, group)) {
        bad(`tokens.${group}`, "is not a known token group");
        continue;
      }
      if (!isObj(value)) {
        bad(`tokens.${group}`, "must be an object");
        continue;
      }
      for (const [k, v] of Object.entries(value)) {
        if (!keys[group as keyof typeof keys].includes(k)) bad(`tokens.${group}.${k}`, "is not a known token");
        else if (!isSafeColor(v)) bad(`tokens.${group}.${k}`, "must be a plain colour (hex, rgb(), hsl() or a colour name)");
      }
    }
  }
  if (issues.length) return { ok: false, issues };
  return { ok: true, theme: input as unknown as ThemeFile };
}

/** A validated theme laid over its base: every token present, ready for the theme store. */
export function resolveTheme(file: ThemeFile): ThemeTokens {
  const base = defaultTheme(file.base);
  return {
    ui: { ...base.ui, ...file.tokens.ui },
    canvas: { ...base.canvas, ...file.tokens.canvas },
    model3d: { ...base.model3d, ...file.tokens.model3d },
    code: { ...base.code, ...file.tokens.code },
    fonts: { ...base.fonts, ...file.tokens.fonts },
  };
}

/** The JSON Schema for editors/CI. Committed as `theme.schema.json`; a test keeps the two identical. */
export function themeJsonSchema(): object {
  const keys = themeTokenKeys();
  const colour = {
    type: "string",
    maxLength: 64,
    description: "A plain CSS colour: #rgb[a], #rrggbb[aa], rgb()/rgba(), hsl()/hsla() or a colour name. No url(), var() or calc().",
  };
  const group = (ks: string[]) => ({
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(ks.map((k) => [k, { $ref: "#/$defs/colour" }])),
  });
  const font = { type: "string", maxLength: 200, description: `Comma-separated families from: ${THEME_FONT_WHITELIST.join(", ")}` };
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: THEME_SCHEMA_URL,
    title: "Sketchor theme",
    type: "object",
    required: ["id", "name", "base", "tokens"],
    additionalProperties: false,
    properties: {
      $schema: { type: "string", maxLength: 200 },
      id: { type: "string", pattern: ID.source },
      name: { type: "string", minLength: 1, maxLength: 80 },
      author: { type: "string", maxLength: 120 },
      version: { type: "string", maxLength: 32 },
      base: { enum: ["dark", "light"], description: "Tokens the theme doesn't set come from this built-in theme." },
      tokens: {
        type: "object",
        additionalProperties: false,
        properties: {
          ui: group(keys.ui),
          canvas: group(keys.canvas),
          model3d: group(keys.model3d),
          code: group(keys.code),
          fonts: { type: "object", additionalProperties: false, properties: { ui: font, mono: font } },
        },
      },
    },
    $defs: { colour },
  };
}
