// C ABI exposed by native/dxf-quicklook/ffi (libdxf_quicklook_ffi.a).
// Imported into Swift via `swiftc -import-objc-header`. Must mirror the
// #[repr(C)] structs in ffi/src/lib.rs exactly.
#pragma once
#include <stddef.h>
#include <stdint.h>

typedef struct {
    double x1, y1, x2, y2;
} DxfLine;

typedef struct {
    double cx, cy, r;
} DxfCircle;

typedef struct {
    DxfLine *lines;
    size_t n_lines;
    DxfCircle *circles;
    size_t n_circles;
} DxfProjection;

// Parse UTF-8 DXF text and project into a size x size box with `pad` margin.
// Returns NULL on null/invalid input; free the result with dxf_projection_free.
DxfProjection *dxf_project(const uint8_t *text, size_t len, double size, double pad);

// Free a projection returned by dxf_project. NULL is a no-op.
void dxf_projection_free(DxfProjection *p);
