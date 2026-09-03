import CoreGraphics
import Foundation
import QuickLookThumbnailing

/// Quick Look thumbnail provider for `.dxf` drawings — the macOS counterpart of
/// the Windows `IThumbnailProvider` in `native/dxf-thumbnailer`. The actual
/// parsing, projection, and drawing live in `DxfRender` (shared with the
/// `render_sample` dev tool); this class only bridges Quick Look to it.
@objc(ThumbnailProvider)
final class ThumbnailProvider: QLThumbnailProvider {

    override func provideThumbnail(
        for request: QLFileThumbnailRequest,
        _ handler: @escaping (QLThumbnailReply?, Error?) -> Void
    ) {
        guard let data = try? Data(contentsOf: request.fileURL) else {
            handler(nil, nil)
            return
        }

        // Draw at exactly the requested size. Quick Look sizes the backing
        // store (including the Retina scale factor) from contextSize, so the
        // context must be request.maximumSize — passing a smaller/square size
        // makes the thumbnail render small in a corner on Retina displays.
        let contextSize = request.maximumSize
        guard contextSize.width > 0, contextSize.height > 0 else {
            handler(nil, nil)
            return
        }

        let reply = QLThumbnailReply(contextSize: contextSize, drawing: { (ctx: CGContext) -> Bool in
            DxfRender.draw(into: ctx, data: data)
        })
        handler(reply, nil)
    }
}
