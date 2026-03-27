import CoreGraphics
import Foundation
import Observation
import UIKit

enum SurfAceConnectionBarState {
    case connected
    case connecting
    case disconnected
}

enum SurfAceContentType: String, Codable {
    case html
    case image
    case pdf
    case terminal
    case markdown
    case video
    case canvas
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
                "event.snapshot_hint",
            ]
        case .deepPlusScroll:
            return [
                "event.drawing_flush",
                "event.tap",
                "event.selection",
                "event.page",
                "event.navigation",
                "event.snapshot_hint",
                "event.scroll",
            ]
        }
    }
}

struct SurfAceDrawingFlushConfig {
    let idleWindowMs: Int
    let maxIntervalMs: Int

    static let `default` = SurfAceDrawingFlushConfig(idleWindowMs: 8_000, maxIntervalMs: 30_000)

    static func from(requestedIdleWindowMs: Int?, requestedMaxIntervalMs: Int?) -> SurfAceDrawingFlushConfig {
        let idle = requestedIdleWindowMs ?? Self.default.idleWindowMs
        let maxInterval = requestedMaxIntervalMs ?? Self.default.maxIntervalMs
        return SurfAceDrawingFlushConfig(
            idleWindowMs: min(max(idle, 5_000), 10_000),
            maxIntervalMs: max(maxInterval, 10_000)
        )
    }
}

enum SurfAceFrameParseError: Error {
    case missingField(String)
    case unsupportedType
    case invalidContentID
}

enum SurfAceHTMLPatchResult {
    case success(updatedHTML: String)
    case selectorNotFound
    case invalidAction
    case failed(String)
}

struct SurfAceFramePatchRequest {
    let contentId: String
    let selector: String
    let action: String
    let html: String?
}

enum SurfAceFramePayload: Equatable {
    case html(html: String, baseURL: String?)
    case image(data: String, mediaType: String, alt: String?)
    case pdf(data: String)
    case terminal(lines: [String], scrollback: Int)
    case markdown(markdown: String)
    case video(url: String?, data: String?, mediaType: String?)
    case canvas(color: String?, grid: Bool)
}

struct SurfAceFrame: Equatable {
    let contentId: String
    let revision: Int
    let contentType: SurfAceContentType
    let payload: SurfAceFramePayload
    let title: String?
    let scrollable: Bool
    let interactive: Bool

    static func from(contentId: String, revision: Int, jsonObject: [String: Any]) throws -> SurfAceFrame {
        guard contentId.range(of: #"^ct_[0-9a-f]{8}$"#, options: .regularExpression) != nil else {
            throw SurfAceFrameParseError.invalidContentID
        }
        guard let contentTypeRaw = jsonObject["contentType"] as? String,
              let contentType = SurfAceContentType(rawValue: contentTypeRaw) else {
            throw SurfAceFrameParseError.unsupportedType
        }

        let payload: SurfAceFramePayload
        switch contentType {
        case .html:
            guard let content = jsonObject["content"] as? [String: Any] else {
                throw SurfAceFrameParseError.missingField("content")
            }
            guard let html = content["html"] as? String else {
                throw SurfAceFrameParseError.missingField("content.html")
            }
            payload = .html(html: html, baseURL: content["baseUrl"] as? String)
        case .image:
            guard let content = jsonObject["content"] as? [String: Any] else {
                throw SurfAceFrameParseError.missingField("content")
            }
            guard let data = content["data"] as? String,
                  let mediaType = content["mediaType"] as? String else {
                throw SurfAceFrameParseError.missingField("content.data/mediaType")
            }
            payload = .image(data: data, mediaType: mediaType, alt: content["alt"] as? String)
        case .pdf:
            guard let content = jsonObject["content"] as? [String: Any] else {
                throw SurfAceFrameParseError.missingField("content")
            }
            guard let data = content["data"] as? String else {
                throw SurfAceFrameParseError.missingField("content.data")
            }
            payload = .pdf(data: data)
        case .terminal:
            guard let content = jsonObject["content"] as? [String: Any] else {
                throw SurfAceFrameParseError.missingField("content")
            }
            guard let lines = content["lines"] as? [String],
                  let scrollback = content["scrollback"] as? Int else {
                throw SurfAceFrameParseError.missingField("content.lines/scrollback")
            }
            payload = .terminal(lines: lines, scrollback: scrollback)
        case .markdown:
            guard let content = jsonObject["content"] as? [String: Any] else {
                throw SurfAceFrameParseError.missingField("content")
            }
            guard let markdown = content["markdown"] as? String else {
                throw SurfAceFrameParseError.missingField("content.markdown")
            }
            payload = .markdown(markdown: markdown)
        case .video:
            if let url = jsonObject["content"] as? String {
                payload = .video(url: url, data: nil, mediaType: nil)
            } else if let content = jsonObject["content"] as? [String: Any] {
                let data = content["data"] as? String
                let url = content["url"] as? String
                let mediaType = content["mediaType"] as? String
                guard data != nil || url != nil else {
                    throw SurfAceFrameParseError.missingField("content.data/url")
                }
                payload = .video(url: url, data: data, mediaType: mediaType)
            } else {
                throw SurfAceFrameParseError.missingField("content")
            }
        case .canvas:
            if let content = jsonObject["content"] as? [String: Any] {
                payload = .canvas(
                    color: content["color"] as? String,
                    grid: content["grid"] as? Bool ?? false
                )
            } else if let content = jsonObject["content"] as? String, content.isEmpty {
                payload = .canvas(color: nil, grid: false)
            } else {
                throw SurfAceFrameParseError.missingField("content")
            }
        }

        let display = jsonObject["display"] as? [String: Any]
        return SurfAceFrame(
            contentId: contentId,
            revision: revision,
            contentType: contentType,
            payload: payload,
            title: display?["title"] as? String,
            scrollable: display?["scrollable"] as? Bool ?? true,
            interactive: display?["interactive"] as? Bool ?? true
        )
    }
}

struct SurfAcePoint: Codable, Equatable {
    let x: Double
    let y: Double
}

struct SurfAceRect: Codable, Equatable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct SurfAceSize: Codable, Equatable {
    let width: Double
    let height: Double
}

struct SurfAceViewport: Codable, Equatable {
    let scrollOffset: SurfAcePoint
    let visibleRect: SurfAceRect
    let contentSize: SurfAceSize
    let zoomLevel: Double
}

struct SurfAceSelection: Codable, Equatable {
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

struct SurfAceStrokePoint: Codable, Equatable {
    let x: Double
    let y: Double
    let pressure: Double?
    let timestamp: Int64
}

struct SurfAceStroke: Codable, Equatable {
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

struct SurfAcePaneEntry {
    var contentId: String?
    var revision: Int
    var historyOwnerToken: String?
    var contentType: SurfAceContentType?
    var payload: SurfAceFramePayload?
    var title: String?
    var scrollable: Bool
    var interactive: Bool
    var url: String?
    var drawingData: Data
    var strokesById: [String: SurfAceStroke]

    static func empty(revision: Int = 0, historyOwnerToken: String? = nil) -> SurfAcePaneEntry {
        SurfAcePaneEntry(
            contentId: nil,
            revision: revision,
            historyOwnerToken: historyOwnerToken,
            contentType: nil,
            payload: nil,
            title: nil,
            scrollable: true,
            interactive: true,
            url: nil,
            drawingData: Data(),
            strokesById: [:]
        )
    }

    static func from(frame: SurfAceFrame, historyOwnerToken: String? = nil) -> SurfAcePaneEntry {
        SurfAcePaneEntry(
            contentId: frame.contentId,
            revision: frame.revision,
            historyOwnerToken: historyOwnerToken,
            contentType: frame.contentType,
            payload: frame.payload,
            title: frame.title,
            scrollable: frame.scrollable,
            interactive: frame.interactive,
            url: nil,
            drawingData: Data(),
            strokesById: [:]
        )
    }
}

enum SurfAceLayoutDirection: String {
    case horizontal
    case vertical
}

indirect enum SurfAcePaneLayoutNode {
    case empty
    case leaf(Int)
    case split(direction: SurfAceLayoutDirection, children: [SurfAcePaneLayoutNode])

    var layoutIdentity: String {
        switch self {
        case .empty:
            return "empty"
        case .leaf(let paneId):
            return "leaf:\(paneId)"
        case .split(let direction, let children):
            let childIdentity = children.map(\.layoutIdentity).joined(separator: "|")
            return "split:\(direction.rawValue):[\(childIdentity)]"
        }
    }

    var paneIDs: [Int] {
        switch self {
        case .empty:
            return []
        case .leaf(let paneId):
            return [paneId]
        case .split(_, let children):
            return children.flatMap(\.paneIDs)
        }
    }

    func replacingLeaf(paneId: Int, with replacement: SurfAcePaneLayoutNode) -> SurfAcePaneLayoutNode {
        switch self {
        case .empty:
            return self
        case .leaf(let currentPaneId):
            return currentPaneId == paneId ? replacement : self
        case .split(let direction, let children):
            return .split(
                direction: direction,
                children: children.map { $0.replacingLeaf(paneId: paneId, with: replacement) }
            )
        }
    }

    func replacingPaneID(from sourcePaneID: Int, to destinationPaneID: Int) -> SurfAcePaneLayoutNode {
        switch self {
        case .empty:
            return self
        case .leaf(let paneId):
            return .leaf(paneId == sourcePaneID ? destinationPaneID : paneId)
        case .split(let direction, let children):
            return .split(
                direction: direction,
                children: children.map { $0.replacingPaneID(from: sourcePaneID, to: destinationPaneID) }
            )
        }
    }

    func removingLeaf(paneId: Int) -> SurfAcePaneLayoutNode? {
        switch self {
        case .empty:
            return self
        case .leaf(let currentPaneId):
            return currentPaneId == paneId ? nil : self
        case .split(let direction, let children):
            let remaining = children.compactMap { $0.removingLeaf(paneId: paneId) }
            if remaining.isEmpty {
                return nil
            }
            if remaining.count == 1 {
                return remaining[0]
            }
            return .split(direction: direction, children: remaining)
        }
    }
}

@MainActor
protocol SurfAcePaneBridging: AnyObject {
    func render(entry: SurfAcePaneEntry?)
    func setInteraction(annotationMode: Bool, fingerDrawEnabled: Bool)
    func restoreDrawing(from drawingData: Data, strokes: [SurfAceStroke]) -> Bool
    func captureDrawingData() -> Data
    func fetchSnapshot(includeImage: Bool) async -> SurfAceSurfaceSnapshot?
    func applyHTMLPatch(_ patch: SurfAceFramePatchRequest) async -> SurfAceHTMLPatchResult
    func removeDrawingStrokeIDs(_ strokeIDs: [String])
    func clearDrawings()
}

@MainActor
@Observable
final class SurfAcePaneModel {
    var paneId: Int
    var name: String?
    var backStack: [SurfAcePaneEntry]
    var currentEntry: SurfAcePaneEntry
    var forwardStack: [SurfAcePaneEntry]
    var annotationMode = false
    var fingerDrawEnabled = false
    var isDrawingFlushSending = false
    var drawingRestoreWarningVisible = false
    var toast: String?
    var lastViewport = SurfAceViewport(
        scrollOffset: SurfAcePoint(x: 0, y: 0),
        visibleRect: SurfAceRect(x: 0, y: 0, width: 1, height: 1),
        contentSize: SurfAceSize(width: 1, height: 1),
        zoomLevel: 1
    )
    var lastVisibleText = ""
    var lastSelection: SurfAceSelection?
    var lastNavigationURL: String?
    var lastPage: (page: Int, totalPages: Int, pageText: String?)?
    var lastMeasuredSize = CGSize(width: 1, height: 1)
    var pendingFlushStrokes: [SurfAceStroke] = []
    var deliveredClosedFrameCount = 0
    var firstPendingStrokeAt: Int64?
    var lastPendingStrokeAt: Int64?
    var lastSuccessfulFlushAt: Date?
    @ObservationIgnored var pendingFlushTask: Task<Void, Never>?
    @ObservationIgnored weak var bridge: (any SurfAcePaneBridging)?

    init(paneId: Int, name: String? = nil) {
        self.paneId = paneId
        self.name = name
        self.backStack = []
        self.currentEntry = .empty()
        self.forwardStack = []
    }

    var labelText: String { name ?? "\(paneId)" }
    var activeContentId: String? { currentEntry.contentId }
    var activeContentType: SurfAceContentType? { currentEntry.contentType }
    var currentRevision: Int { currentEntry.revision }
    var canGoBack: Bool { !backStack.isEmpty }
    var canGoForward: Bool { !forwardStack.isEmpty }
    var activeStrokes: [SurfAceStroke] { currentEntry.strokesById.values.sorted { $0.strokeId < $1.strokeId } }
}

@MainActor
@Observable
final class SurfAceSurfaceModel {
    let sceneKey: String
    let surfaceId: String
    var windowLabel: String
    var name: String
    var providerName: String?
    var paneLayout: SurfAcePaneLayoutNode
    var panesById: [Int: SurfAcePaneModel]
    var providerTopologyInitialized = false
    var connectionBarState: SurfAceConnectionBarState = .disconnected
    var labelsVisible = true
    var viewportSize = CGSize(width: 1, height: 1)
    var viewportScale: CGFloat = 1
    var lastError: String?
    @ObservationIgnored var labelRestoreTask: Task<Void, Never>?

    init(sceneKey: String, surfaceId: String, windowLabel: String, name: String) {
        self.sceneKey = sceneKey
        self.surfaceId = surfaceId
        self.windowLabel = windowLabel
        self.name = name
        let initialPane = SurfAcePaneModel(paneId: 1)
        self.panesById = [initialPane.paneId: initialPane]
        self.paneLayout = .leaf(initialPane.paneId)
    }

    var panes: [SurfAcePaneModel] { paneLayout.paneIDs.compactMap { panesById[$0] } }
    var pendingEventCount: Int { panes.reduce(0) { $0 + ($1.pendingFlushStrokes.isEmpty ? 0 : 1) } }
}

struct SurfAceIdentityMapping: Codable {
    var surfacesBySceneKey: [String: StoredSurfaceIdentity] = [:]
}

struct StoredSurfaceIdentity: Codable {
    var surfaceId: String
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
