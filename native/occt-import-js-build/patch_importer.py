"""Patches occt-import-js's XCAF importer to use a prebuilt shape->label index.

Run from native/occt-import-js-build with the upstream checkout in ./src.
Idempotent: a second run finds nothing left to replace and exits 0.
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent / "src" / "occt-import-js" / "src"

INDEX = r'''#include <XCAFDoc_DocumentTool.hxx>
#include <TDF_LabelSequence.hxx>
#include <NCollection_DataMap.hxx>
#include <TopTools_ShapeMapHasher.hxx>

#include <unordered_map>

/*
 * Sketchor patch: shape -> label lookups in one prebuilt index.
 *
 * Upstream resolves the name/colour of every mesh and every *face* with
 * XCAFDoc_ShapeTool::Search, which walks all top-level labels (and, for a
 * face, registers a brand-new sub-shape label on the document each time).
 * That is O(faces x parts) and dominates the import of any assembly: a
 * 1,700-part file spent most of its 28 seconds there. This index is built
 * once after transfer and answers each lookup in O(1).
 *
 * Two tiers: an exact match (same TShape *and* location - what Search
 * found for top-level shapes and single-level components) and a
 * location-agnostic fallback on the TShape, which is how a face or a solid
 * under an instance finds the label of the product it was copied from.
 * The fallback also recovers names and face colours that upstream lost for
 * parts inside nested sub-assemblies.
 */
class LabelIndex
{
public:
    void Build (const Handle (XCAFDoc_ShapeTool)& shapeTool)
    {
        TDF_LabelSequence labels;
        shapeTool->GetShapes (labels);
        for (Standard_Integer i = 1; i <= labels.Length (); i++) {
            const TDF_Label& label = labels.Value (i);
            Add (shapeTool->GetShape (label), label);
            if (XCAFDoc_ShapeTool::IsAssembly (label)) {
                TDF_LabelSequence components;
                XCAFDoc_ShapeTool::GetComponents (label, components);
                for (Standard_Integer j = 1; j <= components.Length (); j++) {
                    Add (shapeTool->GetShape (components.Value (j)), components.Value (j));
                }
            }
            TDF_LabelSequence subShapes;
            XCAFDoc_ShapeTool::GetSubShapes (label, subShapes);
            for (Standard_Integer j = 1; j <= subShapes.Length (); j++) {
                Add (shapeTool->GetShape (subShapes.Value (j)), subShapes.Value (j));
            }
        }
    }

    bool Find (const TopoDS_Shape& shape, TDF_Label& label) const
    {
        if (shape.IsNull ()) {
            return false;
        }
        const TDF_Label* exact = byShape.Seek (shape);
        if (exact != nullptr) {
            label = *exact;
            return true;
        }
        auto it = byTShape.find (shape.TShape ().get ());
        if (it != byTShape.end ()) {
            label = it->second;
            return true;
        }
        return false;
    }

private:
    void Add (const TopoDS_Shape& shape, const TDF_Label& label)
    {
        if (shape.IsNull ()) {
            return;
        }
        if (!byShape.IsBound (shape)) {
            byShape.Bind (shape, label);
        }
        // First registration wins: top-level product labels are added before
        // the components that instance them, so a shared TShape resolves to
        // the product (the label that carries the name and the colour).
        byTShape.emplace (shape.TShape ().get (), label);
    }

    NCollection_DataMap<TopoDS_Shape, TDF_Label, TopTools_ShapeMapHasher> byShape;
    std::unordered_map<const TopoDS_TShape*, TDF_Label> byTShape;
};
'''

REPLACEMENTS = [
    ("#include <XCAFDoc_DocumentTool.hxx>\n", INDEX),
    (
        "static std::string GetShapeName (const TopoDS_Shape& shape, const Handle (XCAFDoc_ShapeTool)& shapeTool)\n{\n    TDF_Label shapeLabel;\n    if (!shapeTool->Search (shape, shapeLabel)) {",
        "static std::string GetShapeName (const TopoDS_Shape& shape, const Handle (XCAFDoc_ShapeTool)& shapeTool, const LabelIndex& index)\n{\n    TDF_Label shapeLabel;\n    if (!index.Find (shape, shapeLabel)) {",
    ),
    (
        "static bool GetShapeColor (const TopoDS_Shape& shape, const Handle (XCAFDoc_ShapeTool)& shapeTool, const Handle (XCAFDoc_ColorTool)& colorTool, Color& color)\n{\n    TDF_Label shapeLabel;\n    if (!shapeTool->Search (shape, shapeLabel)) {",
        "static bool GetShapeColor (const TopoDS_Shape& shape, const Handle (XCAFDoc_ShapeTool)& shapeTool, const Handle (XCAFDoc_ColorTool)& colorTool, const LabelIndex& index, Color& color)\n{\n    TDF_Label shapeLabel;\n    if (!index.Find (shape, shapeLabel)) {",
    ),
    ("const Handle (XCAFDoc_ColorTool)& colorTool)", "const Handle (XCAFDoc_ColorTool)& colorTool, const LabelIndex& index)"),
    (
        "const Handle (XCAFDoc_ColorTool)& colorTool, const ImportParams& params)",
        "const Handle (XCAFDoc_ColorTool)& colorTool, const LabelIndex& index, const ImportParams& params)",
    ),
    ("        colorTool (colorTool)\n    {", "        colorTool (colorTool),\n        index (index)\n    {"),
    ("        colorTool (colorTool),\n        params (params)\n    {", "        colorTool (colorTool),\n        index (index),\n        params (params)\n    {"),
    ("    const Handle (XCAFDoc_ColorTool)& colorTool;\n};", "    const Handle (XCAFDoc_ColorTool)& colorTool;\n    const LabelIndex& index;\n};"),
    (
        "    const Handle (XCAFDoc_ColorTool)& colorTool;\n    const ImportParams& params;\n};",
        "    const Handle (XCAFDoc_ColorTool)& colorTool;\n    const LabelIndex& index;\n    const ImportParams& params;\n};",
    ),
    (
        "GetShapeColor ((const TopoDS_Shape&) face, shapeTool, colorTool, color)",
        "GetShapeColor ((const TopoDS_Shape&) face, shapeTool, colorTool, index, color)",
    ),
    ("return GetShapeName (shape, shapeTool);", "return GetShapeName (shape, shapeTool, index);"),
    ("return GetShapeColor (shape, shapeTool, colorTool, color);", "return GetShapeColor (shape, shapeTool, colorTool, index, color);"),
    ("XcafFace outputFace (face, shapeTool, colorTool);", "XcafFace outputFace (face, shapeTool, colorTool, index);"),
    ("childLabel, shapeTool, colorTool\n", "childLabel, shapeTool, colorTool, index\n"),
    (
        "XcafShapeMesh outputShapeMesh (currentShape, shapeTool, colorTool);",
        "XcafShapeMesh outputShapeMesh (currentShape, shapeTool, colorTool, index);",
    ),
    (
        "XcafStandaloneFacesMesh standaloneFacesMesh (shape, shapeTool, colorTool);",
        "XcafStandaloneFacesMesh standaloneFacesMesh (shape, shapeTool, colorTool, index);",
    ),
    (
        "rootNode = std::make_shared<const XcafRootNode> (shapeTool, colorTool, params);",
        "index = std::make_shared<LabelIndex> ();\n    index->Build (shapeTool);\n    rootNode = std::make_shared<const XcafRootNode> (shapeTool, colorTool, *index, params);",
    ),
    ("    colorTool (nullptr),\n    rootNode (nullptr)", "    colorTool (nullptr),\n    index (nullptr),\n    rootNode (nullptr)"),
]

HEADER_REPLACEMENTS = [
    ("class ImporterXcaf : public Importer", "class LabelIndex;\n\nclass ImporterXcaf : public Importer"),
    (
        "    Handle (XCAFDoc_ColorTool) colorTool;\n    NodePtr rootNode;",
        "    Handle (XCAFDoc_ColorTool) colorTool;\n    std::shared_ptr<LabelIndex> index;\n    NodePtr rootNode;",
    ),
]


def apply(path: Path, pairs) -> int:
    text = path.read_text(encoding="utf-8")
    if "LabelIndex" in text:
        print(f"{path.name}: already patched")
        return 0
    for old, new in pairs:
        if old not in text:
            print(f"{path.name}: pattern not found: {old[:60]!r}")
            return 1
        text = text.replace(old, new)
    path.write_text(text, encoding="utf-8", newline="\n")
    print(f"{path.name}: patched")
    return 0


if __name__ == "__main__":
    rc = apply(ROOT / "importer-xcaf.cpp", REPLACEMENTS)
    rc |= apply(ROOT / "importer-xcaf.hpp", HEADER_REPLACEMENTS)
    sys.exit(rc)
