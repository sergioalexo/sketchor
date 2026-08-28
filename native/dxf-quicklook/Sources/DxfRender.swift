import CoreGraphics
import Foundation

/// Shared drawing for DXF previews: parse + fit-to-box projection come from the
/// Rust FFI (`dxf-parse`), this strokes the result with Core Graphics. Used by
/// both the Quick Look thumbnail extension and the `render_sample` dev tool, so
/// what Finder shows is exactly what the inspection tool writes.
enum DxfRender {

    // Match native/dxf-thumbnailer/src/render.rs: background #1E1F22, stroke
    // #C7D0DC at 1px, 10% padding.
    static let bg = (r: 30.0 / 255, g: 31.0 / 255, b: 34.0 / 255)
    static let stroke = (r: 199.0 / 255, g: 208.0 / 255, b: 220.0 / 255)
    static let padFraction = 0.10

    /// Paints the drawing to fill `ctx`'s entire backing store. Returns false
    /// only when the input can't be parsed at all; an empty drawing still paints
    /// the background and returns true.
    ///
    /// Sizing comes from the context's real pixel dimensions (`ctx.width` /
    /// `ctx.height`), not a passed-in CGSize — Quick Look hands us a context
    /// whose backing is `maximumSize × scale` pixels, and reading those pixels
    /// directly is what keeps the drawing filling the whole thumbnail on Retina
    /// instead of a corner. We also flatten the CTM to identity so one drawing
    /// unit is one device pixel regardless of any scale the context arrived with.
    @discardableResult
    static func draw(into ctx: CGContext, data: Data) -> Bool {
        ctx.saveGState()
        ctx.concatenate(ctx.ctm.inverted())  // effective CTM -> identity (1 unit = 1px)
        defer { ctx.restoreGState() }

        let w = CGFloat(ctx.width)
        let h = CGFloat(ctx.height)
        guard w > 0, h > 0 else { return false }

        ctx.setFillColor(red: bg.r, green: bg.g, blue: bg.b, alpha: 1)
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))

        // Fit into the largest square that fits the pixel box, centered — so a
        // non-square request still frames the drawing rather than cropping it.
        let side = min(w, h)
        let pad = side * padFraction
        let ox = (w - side) / 2
        let oy = (h - side) / 2

        let projPtr: UnsafeMutablePointer<DxfProjection>? = data.withUnsafeBytes { raw in
            let base = raw.bindMemory(to: UInt8.self).baseAddress
            return dxf_project(base, raw.count, Double(side), Double(pad))
        }
        guard let proj = projPtr else { return false }
        defer { dxf_projection_free(proj) }

        ctx.setStrokeColor(red: stroke.r, green: stroke.g, blue: stroke.b, alpha: 1)
        ctx.setLineWidth(1)
        ctx.setLineCap(.round)
        ctx.setLineJoin(.round)

        // The FFI returns raster coords within the side x side box (origin
        // top-left, Y down). Offset by (ox, oy) to center, and flip Y since
        // this CGContext is Y-up (origin bottom-left).
        let p = proj.pointee

        if p.n_lines > 0, let lines = p.lines {
            for l in UnsafeBufferPointer(start: lines, count: p.n_lines) {
                ctx.move(to: CGPoint(x: ox + l.x1, y: oy + (side - l.y1)))
                ctx.addLine(to: CGPoint(x: ox + l.x2, y: oy + (side - l.y2)))
            }
            ctx.strokePath()
        }

        if p.n_circles > 0, let circles = p.circles {
            for c in UnsafeBufferPointer(start: circles, count: p.n_circles) {
                let rect = CGRect(
                    x: ox + c.cx - c.r,
                    y: oy + (side - c.cy) - c.r,
                    width: c.r * 2,
                    height: c.r * 2
                )
                ctx.strokeEllipse(in: rect)
            }
        }

        return true
    }
}
