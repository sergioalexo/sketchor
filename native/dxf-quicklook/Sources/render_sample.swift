import CoreGraphics
import Foundation
import ImageIO

// Renders a sample (or given) DXF through the same DxfRender path the Quick
// Look extension uses and writes a PNG, so the output can be inspected without
// registering the extension. Mirrors dxf-thumbnailer/examples/render_sample.rs.
//
//   render_sample [input.dxf] [out.png] [size]

@main
struct RenderSample {
    // Same sample geometry as the Windows example: a rounded slot outline with
    // three circles and an arc.
    static let sample =
        "0\nSECTION\n2\nENTITIES\n"
        + "0\nLWPOLYLINE\n90\n4\n70\n1\n10\n0\n20\n0\n10\n120\n20\n0\n10\n120\n20\n80\n10\n0\n20\n80\n"
        + "0\nCIRCLE\n10\n60\n20\n40\n40\n28\n"
        + "0\nCIRCLE\n10\n24\n20\n56\n40\n8\n"
        + "0\nCIRCLE\n10\n96\n20\n56\n40\n8\n"
        + "0\nARC\n10\n60\n20\n40\n40\n30\n50\n200\n51\n340\n"
        + "0\nENDSEC\n0\nEOF\n"

    static func main() {
        let args = CommandLine.arguments
        let out = args.count > 2 ? args[2] : "sample.png"
        let size = args.count > 3 ? (Int(args[3]) ?? 256) : 256

        let data: Data
        if args.count > 1, !args[1].isEmpty {
            guard let d = try? Data(contentsOf: URL(fileURLWithPath: args[1])) else {
                FileHandle.standardError.write(Data("cannot read \(args[1])\n".utf8))
                exit(1)
            }
            data = d
        } else {
            data = Data(sample.utf8)
        }

        let cs = CGColorSpaceCreateDeviceRGB()
        guard
            let ctx = CGContext(
                data: nil, width: size, height: size,
                bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else {
            FileHandle.standardError.write(Data("failed to create context\n".utf8))
            exit(1)
        }

        DxfRender.draw(into: ctx, data: data)

        guard let img = ctx.makeImage(),
            let dest = CGImageDestinationCreateWithURL(
                URL(fileURLWithPath: out) as CFURL, "public.png" as CFString, 1, nil)
        else {
            FileHandle.standardError.write(Data("failed to encode png\n".utf8))
            exit(1)
        }
        CGImageDestinationAddImage(dest, img, nil)
        CGImageDestinationFinalize(dest)
        print("wrote \(out) (\(size)x\(size))")
    }
}
