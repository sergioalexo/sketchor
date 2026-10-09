import { describe, expect, it } from "vitest";
import { entitiesToDxf2018 } from "./index";
import { parseDxf } from "../dxf";

/**
 * X-09: opening and re-saving a colleague's DXF must not silently delete the
 * objects Sketchor can't model (PROXY, 3DSOLID, ...). If this regresses, a
 * save-over of a shared drawing destroys other people's data.
 */

const pairs = (...p: (string | number)[]) => p.join("\n") + "\n";

const SOURCE =
  pairs("0", "SECTION", "2", "HEADER", "9", "$INSUNITS", "70", 4, "0", "ENDSEC") +
  pairs("0", "SECTION", "2", "CLASSES", "0", "CLASS", "1", "ACAD_PROXY_ENTITY", "2", "AcDbProxyEntity", "3", "ObjectDBX Classes", "90", 127, "0", "ENDSEC") +
  pairs("0", "SECTION", "2", "ENTITIES") +
  pairs("0", "LINE", "5", "1A", "8", "Walls", "10", 0, "20", 0, "11", 10, "21", 0) +
  pairs("0", "ACAD_PROXY_ENTITY", "5", "1B", "330", "1F", "100", "AcDbEntity", "8", "Walls", "102", "{ACAD_REACTORS", "330", "77", "102", "}", "100", "AcDbProxyEntity", "90", 499, "310", "DEADBEEF", "340", "99", "10", 1.5, "20", 2.5) +
  pairs("0", "3DSOLID", "5", "1C", "8", "Solids", "100", "AcDb3dSolid", "1", "ACIS DATA 12 34") +
  pairs("0", "ENDSEC", "0", "EOF");

describe("unknown DXF data survives a re-save", () => {
  const first = parseDxf(SOURCE);

  it("keeps unmodelled records (and their class) as foreign records", () => {
    expect(first.foreign.map((f) => f.type)).toEqual(["ACAD_PROXY_ENTITY", "3DSOLID"]);
    expect(first.foreign[0].cls).toBeTruthy();
    expect(first.foreign[1].cls).toBeUndefined();
    expect(first.entities).toHaveLength(1);
  });

  it("writes them back with fresh handles, no dangling references, and the same payload", () => {
    const out = entitiesToDxf2018(first.entities, { insUnits: 4, foreign: first.foreign });
    expect(out).toContain("0\nACAD_PROXY_ENTITY\n5\n");
    expect(out).toContain("310\nDEADBEEF\n");
    expect(out).toContain("1\nACIS DATA 12 34\n");
    expect(out).toContain("0\nCLASS\n1\nACAD_PROXY_ENTITY\n");
    expect(out).not.toContain("ACAD_REACTORS");
    expect(out).not.toContain("340\n99\n");
    const again = parseDxf(out);
    expect(again.foreign.map((f) => f.type)).toEqual(["ACAD_PROXY_ENTITY", "3DSOLID"]);
    expect(again.foreign[0].layer).toBe("Walls");
    expect(again.foreign[1].layer).toBe("Solids");
    // a second generation is stable: payload pairs identical
    const third = parseDxf(entitiesToDxf2018(again.entities, { insUnits: 4, foreign: again.foreign }));
    expect(third.foreign.map((f) => f.pairs.filter(([c]) => c !== 5 && c !== 330))).toEqual(
      again.foreign.map((f) => f.pairs.filter(([c]) => c !== 5 && c !== 330)),
    );
  });

  it("does not write opaque geometry into a drawing of a different unit", () => {
    const out = entitiesToDxf2018(first.entities, { insUnits: 1, foreign: first.foreign });
    expect(out).not.toContain("ACAD_PROXY_ENTITY");
  });

  it("registers foreign layers in the layer table", () => {
    const out = entitiesToDxf2018([], { insUnits: 4, foreign: first.foreign });
    expect(out).toContain("2\nSolids\n");
  });
});
