import CoreGraphics
import Foundation

enum SurfAceContentType: String, Codable {
    case html
    case image
    case pdf
    case terminal
    case markdown
}

enum SurfAceEventProfile: String {
    case minimumDeep = "minimum_deep"
    case deepPlusScroll = "deep_plus_scroll"

    var activeEvents: [String] {
        switch self {
        case .minimumDeep:
            return [
                "event.drawing_flush",
                "event.tap",
                "event.selection",
                "event.page",
                "event.navigation",
                "event.snapshot_hint"
            ]
        case .deepPlusScroll:
            return [
                "event.drawing_flush",
                "event.tap",
                "event.selection",
                "event.page",
                "event.navigation",
                "event.snapshot_hint",
                "event.scroll"
            ]
        }
    }
}

struct SurfAceDrawingFlushConfig {
    let idleWindowMs: Int
    let maxIntervalMs: Int

    static let `default` = SurfAceDrawingFlushConfig(idleWindowMs: 8000, maxIntervalMs: 30000)

    static func from(requestedIdleWindowMs: Int?, requestedMaxIntervalMs: Int?) -> SurfAceDrawingFlushConfig {
        let idle = requestedIdleWindowMs ?? Self.default.idleWindowMs
        let maxInterval = requestedMaxIntervalMs ?? Self.default.maxIntervalMs
        return SurfAceDrawingFlushConfig(
            idleWindowMs: min(max(idle, 5000), 10_000),
            maxIntervalMs: max(maxInterval, 10_000)
        )
    }
}

struct SurfAceFrame: Equatable {
    let frameID: String
    let contentType: SurfAceContentType
    let payload: SurfAceFramePayload
    let title: String?
    let scrollable: Bool
    let interactive: Bool

    static func from(jsonObject: [String: Any]) throws -> SurfAceFrame {
        guard let frameID = jsonObject["frameId"] as? String, !frameID.isEmpty else {
            throw SurfAceFrameParseError.missingField("frameId")
        }
        if frameID.range(of: #"^(fr|ct)_[0-9a-f]{8}$"#, options: .regularExpression) == nil {
            throw SurfAceFrameParseError.invalidFrameID
        }

        guard let contentTypeRaw = jsonObject["contentType"] as? String,
              let contentType = SurfAceContentType(rawValue: contentTypeRaw) else {
            throw SurfAceFrameParseError.unsupportedType
        }

        guard let content = jsonObject["content"] as? [String: Any] else {
            throw SurfAceFrameParseError.missingField("content")
        }

        let payload: SurfAceFramePayload
        switch contentType {
        case .html:
            guard let html = content["html"] as? String else {
                throw SurfAceFrameParseError.missingField("content.html")
            }
            payload = .html(html: html, baseURL: content["baseUrl"] as? String)
        case .image:
            guard let data = content["data"] as? String,
                  let mediaType = content["mediaType"] as? String else {
                throw SurfAceFrameParseError.missingField("content.data/mediaType")
            }
            payload = .image(data: data, mediaType: mediaType, alt: content["alt"] as? String)
        case .pdf:
            guard let data = content["data"] as? String else {
                throw SurfAceFrameParseError.missingField("content.data")
            }
            payload = .pdf(data: data)
        case .terminal:
            guard let lines = content["lines"] as? [String],
                  let scrollback = content["scrollback"] as? Int else {
                throw SurfAceFrameParseError.missingField("content.lines/scrollback")
            }
            payload = .terminal(lines: lines, scrollback: scrollback)
        case .markdown:
            guard let markdown = content["markdown"] as? String else {
                throw SurfAceFrameParseError.missingField("content.markdown")
            }
            payload = .markdown(markdown: markdown)
        }

        let display = jsonObject["display"] as? [String: Any]
        return SurfAceFrame(
            frameID: frameID,
            contentType: contentType,
            payload: payload,
            title: display?["title"] as? String,
            scrollable: display?["scrollable"] as? Bool ?? true,
            interactive: display?["interactive"] as? Bool ?? true
        )
    }
}

enum SurfAceFramePayload: Equatable {
    case html(html: String, baseURL: String?)
    case image(data: String, mediaType: String, alt: String?)
    case pdf(data: String)
    case terminal(lines: [String], scrollback: Int)
    case markdown(markdown: String)
}

enum SurfAceFrameParseError: Error {
    case missingField(String)
    case unsupportedType
    case invalidFrameID
}

struct SurfAceFrameAppendRequest {
    let frameID: String
    let lines: [String]

    static func from(jsonObject: [String: Any]) throws -> SurfAceFrameAppendRequest {
        guard let frameID = jsonObject["frameId"] as? String, !frameID.isEmpty else {
            throw SurfAceFrameParseError.missingField("frameId")
        }
        guard let lines = jsonObject["lines"] as? [String] else {
            throw SurfAceFrameParseError.missingField("lines")
        }
        return SurfAceFrameAppendRequest(frameID: frameID, lines: lines)
    }
}

struct SurfAceFramePatchRequest {
    let frameID: String
    let selector: String
    let action: String
    let html: String?

    static func from(jsonObject: [String: Any]) throws -> SurfAceFramePatchRequest {
        guard let frameID = jsonObject["frameId"] as? String, !frameID.isEmpty else {
            throw SurfAceFrameParseError.missingField("frameId")
        }
        guard let patch = jsonObject["patch"] as? [String: Any],
              let selector = patch["selector"] as? String,
              let action = patch["action"] as? String else {
            throw SurfAceFrameParseError.missingField("patch.selector/action")
        }

        return SurfAceFramePatchRequest(
            frameID: frameID,
            selector: selector,
            action: action,
            html: patch["html"] as? String
        )
    }
}

struct SurfAcePoint: Codable {
    let x: Double
    let y: Double
}

struct SurfAceRect: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct SurfAceSize: Codable {
    let width: Double
    let height: Double
}

struct SurfAceViewport: Codable {
    let scrollOffset: SurfAcePoint
    let visibleRect: SurfAceRect
    let contentSize: SurfAceSize
    let zoomLevel: Double
}

struct SurfAceSelection: Codable {
    let kind: String
    let text: String?
    let boundingRect: SurfAceRect?
    let position: SurfAcePoint?
    let rect: SurfAceRect?

    static func text(_ text: String, boundingRect: SurfAceRect) -> SurfAceSelection {
        SurfAceSelection(kind: "text", text: text, boundingRect: boundingRect, position: nil, rect: nil)
    }

    static func point(_ position: SurfAcePoint) -> SurfAceSelection {
        SurfAceSelection(kind: "point", text: nil, boundingRect: nil, position: position, rect: nil)
    }

    static func region(_ rect: SurfAceRect, text: String?) -> SurfAceSelection {
        SurfAceSelection(kind: "region", text: text, boundingRect: nil, position: nil, rect: rect)
    }
}

struct SurfAceStrokePoint: Codable {
    let x: Double
    let y: Double
    let pressure: Double?
    let timestamp: Int64
}

struct SurfAceStroke: Codable {
    let strokeId: String
    let points: [SurfAceStrokePoint]
    let tool: String
}

struct SurfAceSurfaceSnapshot {
    let viewport: SurfAceViewport
    let visibleText: String
    let selection: SurfAceSelection?
    let imageBase64: String?
}

struct SurfAceReadFrameViewport: Codable {
    let width: Double
    let height: Double
    let scale: Double
}

struct SurfAceReadStrokePoint: Codable {
    let x: Double
    let y: Double
    let pressure: Double?
}

struct SurfAceReadStroke: Codable {
    let strokeId: String
    let points: [SurfAceReadStrokePoint]
    let bbox: SurfAceRect
    let startedAt: Int64
    let endedAt: Int64
}

struct SurfAceReadFrame: Codable {
    let frameId: String
    let contextKey: String
    let contentId: String
    let url: String?
    var scrollOffset: SurfAcePoint
    var viewport: SurfAceReadFrameViewport
    let openedAt: Int64
    var updatedAt: Int64
    var image: String
    var strokes: [SurfAceReadStroke]
}

struct SurfAceReadTap: Codable {
    let eventId: String
    let timestamp: Int64
    let x: Double
    let y: Double
    let kind: String
    let nearestText: String?
    let elementRole: String?
}

struct SurfAceReadScrollPosition: Codable {
    let x: Double
    let y: Double
    let visibleRect: SurfAceRect
}

struct SurfAceReadSelection: Codable {
    let selectedText: String
    let bounds: SurfAceRect
    let anchorStart: Int?
    let anchorEnd: Int?
}

struct SurfAceReadPage: Codable {
    let pageNumber: Int
    let pageCount: Int
    let pageLabel: String?
}

struct SurfAceReadNavigation: Codable {
    let url: String
    let navigatedAt: Int64
}

struct SurfAceReadResult {
    let fingerprint: String
    let liveFrame: SurfAceReadFrame?
    let liveDirtyStrokeIds: [String]?
    let liveSeq: Int?
    let frames: [SurfAceReadFrame]
    let pendingFrames: Int?
    let taps: [SurfAceReadTap]
    let scrollPosition: SurfAceReadScrollPosition?
    let selection: SurfAceReadSelection?
    let page: SurfAceReadPage?
    let playbackPosition: Double?
    let playbackState: String?
    let lastNavigation: SurfAceReadNavigation?
    let overflowed: Bool
    let readAt: Int64
}

enum SurfAceSpecOperation: String, CaseIterable {
    case surfacesList = "surfaces.list"
    case pairRequest = "pair.request"
    case contentSet = "content.set"
    case contentAppend = "content.append"
    case contentPatch = "content.patch"
    case contentClear = "content.clear"
    case annotationsRemove = "annotations.remove"
    case snapshotGet = "snapshot.get"
    case heartbeatPing = "heartbeat.ping"
}

enum SurfAceSurfaceID {
    static func fromFingerprint(_ fingerprint: String) -> String {
        let filtered = fingerprint
            .lowercased()
            .filter { $0.isLetter || $0.isNumber || $0 == "_" || $0 == "." || $0 == ":" || $0 == "-" }
        let seed = filtered.isEmpty ? "surface" : filtered
        return "sf_\(seed)"
    }
}

extension CGRect {
    var surfAceRect: SurfAceRect {
        SurfAceRect(
            x: Double(origin.x),
            y: Double(origin.y),
            width: Double(size.width),
            height: Double(size.height)
        )
    }
}
