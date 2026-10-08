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

# Sketchor fix: triangulating only the top-level free shape's compound
# (XcafRootNode::GetChildren) does not reliably leave triangulation
# reachable from a leaf's own GetShape() result on every assembly -
# observed on a real 58 MB SolidWorks export with no MAPPED_ITEM instancing
# (every pattern occurrence its own separate geometry copy): every leaf
# node had real solids and faces, but zero triangulated faces, so
# occt-import-js reported success with zero meshes for the whole file.
# Triangulating defensively at the leaf too (BRepMesh_IncrementalMesh
# checks and skips an already-meshed shape, so this costs nothing where it
# already worked) fixed it: the same file then opened with 1,366 parts and
# 546,061 triangles. These entries run after the LabelIndex replacements
# below (the `old` text here is what that patch already produces), so
# XcafNode needs a `params` member the same way the LabelIndex patch added
# `index` to it.
TRIANGULATE_LEAF_FIX = [
    (
        "    XcafNode (const TDF_Label& label, const Handle (XCAFDoc_ShapeTool)& shapeTool, const Handle (XCAFDoc_ColorTool)& colorTool, const LabelIndex& index) :\n"
        "        label (label),\n"
        "        shapeTool (shapeTool),\n"
        "        colorTool (colorTool),\n"
        "        index (index)\n"
        "    {\n"
        "\n"
        "    }",
        "    XcafNode (const TDF_Label& label, const Handle (XCAFDoc_ShapeTool)& shapeTool, const Handle (XCAFDoc_ColorTool)& colorTool, const LabelIndex& index, const ImportParams& params) :\n"
        "        label (label),\n"
        "        shapeTool (shapeTool),\n"
        "        colorTool (colorTool),\n"
        "        index (index),\n"
        "        params (params)\n"
        "    {\n"
        "\n"
        "    }",
    ),
    (
        "                children.push_back (std::make_shared<const XcafNode> (\n"
        "                    childLabel, shapeTool, colorTool, index\n"
        "                    ));",
        "                children.push_back (std::make_shared<const XcafNode> (\n"
        "                    childLabel, shapeTool, colorTool, index, params\n"
        "                    ));",
    ),
    (
        "        TopoDS_Shape shape = shapeTool->GetShape (label);\n"
        "        EnumerateShapeMeshes (shape, onMesh);",
        "        TopoDS_Shape shape = shapeTool->GetShape (label);\n"
        "        TriangulateShape (shape, params);\n"
        "        EnumerateShapeMeshes (shape, onMesh);",
    ),
    (
        "    TDF_Label label;\n"
        "    const Handle (XCAFDoc_ShapeTool)& shapeTool;\n"
        "    const Handle (XCAFDoc_ColorTool)& colorTool;\n"
        "    const LabelIndex& index;\n"
        "};\n"
        "\n"
        "class XcafRootNode : public Node",
        "    TDF_Label label;\n"
        "    const Handle (XCAFDoc_ShapeTool)& shapeTool;\n"
        "    const Handle (XCAFDoc_ColorTool)& colorTool;\n"
        "    const LabelIndex& index;\n"
        "    const ImportParams& params;\n"
        "};\n"
        "\n"
        "class XcafRootNode : public Node",
    ),
]

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
] + TRIANGULATE_LEAF_FIX

# Sketchor fix #2: the one-call whole-shape BRepMesh run leaves *no* faces
# triangulated for some big sub-assemblies. Observed on a real 74 MB
# SolidWorks export (AP203, ~700 NAUO, ~1,500 solids, no MAPPED_ITEM):
# BRepMesh_IncrementalMesh over the 1,375-solid compound of one
# sub-assembly returned without error but produced zero triangles on all
# 23,982 faces - while the same solids meshed one by one all succeeded, and
# the sibling sub-assembly (540 solids) meshed fine as a compound. The
# importer reported success and 1,375 empty meshes, i.e. 2/3 of the parts
# silently missing. So before a solid/shell is read out, any one of its
# faces still lacking a triangulation gets the solid meshed on its own
# (a no-op where the compound pass already worked, so well-behaved files
# cost nothing and keep their exact output).
ENSURE_MESHED = r'''
/*
 * Sketchor patch: mesh a solid/shell by itself when the compound pass left
 * any of its faces without a triangulation (see patch_importer.py).
 */
static bool HasUntriangulatedFace (const TopoDS_Shape& shape)
{
    for (TopExp_Explorer ex (shape, TopAbs_FACE); ex.More (); ex.Next ()) {
        TopLoc_Location location;
        Handle (Poly_Triangulation) triangulation = BRep_Tool::Triangulation (TopoDS::Face (ex.Current ()), location);
        if (triangulation.IsNull () || triangulation->NbTriangles () == 0) {
            return true;
        }
    }
    return false;
}

static void EnsureMeshed (const TopoDS_Shape& shape, const ImportParams& params)
{
    if (!HasUntriangulatedFace (shape)) {
        return;
    }
    try {
        TopoDS_Shape own = shape;
        TriangulateShape (own, params);
    } catch (Standard_Failure&) {
        // leave it: the mesh comes out empty, as before
    }
}
'''

LEAF_MESH_REPLACEMENTS = [
    (
        "static std::string GetLabelNameNoRef (const TDF_Label& label)",
        ENSURE_MESHED + "\n" + "static std::string GetLabelNameNoRef (const TDF_Label& label)",
    ),
    (
        "#include <XCAFDoc_DocumentTool.hxx>\n",
        "#include <XCAFDoc_DocumentTool.hxx>\n#include <Poly_Triangulation.hxx>\n#include <Standard_Failure.hxx>\n",
    ),
    (
        "        for (TopExp_Explorer ex (shape, TopAbs_SOLID); ex.More (); ex.Next ()) {\n"
        "            const TopoDS_Shape& currentShape = ex.Current ();\n"
        "            XcafShapeMesh",
        "        for (TopExp_Explorer ex (shape, TopAbs_SOLID); ex.More (); ex.Next ()) {\n"
        "            const TopoDS_Shape& currentShape = ex.Current ();\n"
        "            EnsureMeshed (currentShape, params);\n"
        "            XcafShapeMesh",
    ),
    (
        "        for (TopExp_Explorer ex (shape, TopAbs_SHELL, TopAbs_SOLID); ex.More (); ex.Next ()) {\n"
        "            const TopoDS_Shape& currentShape = ex.Current ();\n"
        "            XcafShapeMesh",
        "        for (TopExp_Explorer ex (shape, TopAbs_SHELL, TopAbs_SOLID); ex.More (); ex.Next ()) {\n"
        "            const TopoDS_Shape& currentShape = ex.Current ();\n"
        "            EnsureMeshed (currentShape, params);\n"
        "            XcafShapeMesh",
    ),
]

HEADER_REPLACEMENTS = [
    ("class ImporterXcaf : public Importer", "class LabelIndex;\n\nclass ImporterXcaf : public Importer"),
    (
        "    Handle (XCAFDoc_ColorTool) colorTool;\n    NodePtr rootNode;",
        "    Handle (XCAFDoc_ColorTool) colorTool;\n    std::shared_ptr<LabelIndex> index;\n    NodePtr rootNode;",
    ),
]


def apply(path: Path, pairs, marker: str = "LabelIndex") -> int:
    text = path.read_text(encoding="utf-8")
    if marker in text:
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
    rc |= apply(ROOT / "importer-xcaf.cpp", LEAF_MESH_REPLACEMENTS, "EnsureMeshed")
    rc |= apply(ROOT / "importer-xcaf.hpp", HEADER_REPLACEMENTS)
    sys.exit(rc)
