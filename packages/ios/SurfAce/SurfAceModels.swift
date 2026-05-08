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
                "event.annotation_committed",
                "event.history_navigated",
                "event.tap",
                "event.selection",
                "event.page",
                "event.navigation",
                "event.snapshot_hint",
            ]
        case .deepPlusScroll:
            return [
                "event.drawing_flush",
                "event.annotation_committed",
                "event.history_navigated",
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
    case video(url: String)
    case canvas(color: String?, grid: Bool)
    case browserURL(url: String, allowedSnapshotFallback: Bool?, fallbackSnapshotTargetId: String?)
}

struct SurfAceFrame: Equatable {
    let contentId: String
    let revision: Int
    let contentType: SurfAceContentType
    let payload: SurfAceFramePayload
    let reloadSource: SurfAceContentReloadSource?
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
            guard let url = jsonObject["content"] as? String else {
                throw SurfAceFrameParseError.missingField("content")
            }
            payload = .video(url: url)
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
            reloadSource: SurfAceContentReloadSource.from(jsonObject["reloadSource"] as? [String: Any]),
            title: display?["title"] as? String,
            scrollable: display?["scrollable"] as? Bool ?? true,
            interactive: display?["interactive"] as? Bool ?? true
        )
    }
}

struct SurfAceContentReloadSource: Equatable {
    let kind: String
    let path: String

    static func from(_ payload: [String: Any]?) -> SurfAceContentReloadSource? {
        guard let payload,
              payload["kind"] as? String == "file",
              let path = payload["path"] as? String,
              !path.isEmpty else {
            return nil
        }
        return SurfAceContentReloadSource(kind: "file", path: path)
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
    var reloadSource: SurfAceContentReloadSource?
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
            reloadSource: nil,
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
            reloadSource: frame.reloadSource,
            title: frame.title,
            scrollable: frame.scrollable,
            interactive: frame.interactive,
            url: nil,
            drawingData: Data(),
            strokesById: [:]
        )
    }

    static func browserURL(
        targetId: String,
        targetEpoch: Int,
        url: String,
        title: String? = nil,
        allowedSnapshotFallback: Bool? = nil,
        fallbackSnapshotTargetId: String? = nil
    ) -> SurfAcePaneEntry {
        SurfAcePaneEntry(
            contentId: nil,
            revision: targetEpoch,
            historyOwnerToken: nil,
            contentType: nil,
            payload: .browserURL(
                url: url,
                allowedSnapshotFallback: allowedSnapshotFallback,
                fallbackSnapshotTargetId: fallbackSnapshotTargetId
            ),
            reloadSource: nil,
            title: title,
            scrollable: true,
            interactive: true,
            url: url,
            drawingData: Data(),
            strokesById: [:]
        )
    }
}

struct SurfAcePaneTargetState: Equatable {
    var targetId: String
    var targetKind: String
    var paneLineageId: String
    var targetEpoch: Int
    var restorePolicy: String
    var currentState: String
    var lastApplyEvidence: [String: Any]?

    static func == (lhs: SurfAcePaneTargetState, rhs: SurfAcePaneTargetState) -> Bool {
        lhs.targetId == rhs.targetId &&
        lhs.targetKind == rhs.targetKind &&
        lhs.paneLineageId == rhs.paneLineageId &&
        lhs.targetEpoch == rhs.targetEpoch &&
        lhs.restorePolicy == rhs.restorePolicy &&
        lhs.currentState == rhs.currentState
    }
}

enum SurfAceLayoutDirection: String, Codable {
    case horizontal
    case vertical
}

enum SurfAcePersistedPaneLayoutNode: Codable {
    case empty
    case leaf(Int, weight: Double? = nil)
    case split(direction: SurfAceLayoutDirection, children: [SurfAcePersistedPaneLayoutNode], weight: Double? = nil)

    private enum CodingKeys: String, CodingKey {
        case children
        case direction
        case kind
        case paneId
        case weight
    }

    private enum Kind: String, Codable {
        case empty
        case leaf
        case split
    }

    init(from runtimeNode: SurfAcePaneLayoutNode) {
        switch runtimeNode {
        case .empty:
            self = .empty
        case .leaf(let paneId, let weight):
            self = .leaf(paneId, weight: weight)
        case .split(let direction, let children, let weight):
            self = .split(
                direction: direction,
                children: children.map(SurfAcePersistedPaneLayoutNode.init(from:)),
                weight: weight
            )
        }
    }

    var runtimeNode: SurfAcePaneLayoutNode {
        switch self {
        case .empty:
            return .empty
        case .leaf(let paneId, let weight):
            return .leaf(paneId, weight: weight)
        case .split(let direction, let children, let weight):
            return .split(direction: direction, children: children.map(\.runtimeNode), weight: weight)
        }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(Kind.self, forKey: .kind) {
        case .empty:
            self = .empty
        case .leaf:
            self = .leaf(
                try container.decode(Int.self, forKey: .paneId),
                weight: try container.decodeIfPresent(Double.self, forKey: .weight)
            )
        case .split:
            self = .split(
                direction: try container.decode(SurfAceLayoutDirection.self, forKey: .direction),
                children: try container.decode([SurfAcePersistedPaneLayoutNode].self, forKey: .children),
                weight: try container.decodeIfPresent(Double.self, forKey: .weight)
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .empty:
            try container.encode(Kind.empty, forKey: .kind)
        case .leaf(let paneId, let weight):
            try container.encode(Kind.leaf, forKey: .kind)
            try container.encode(paneId, forKey: .paneId)
            try container.encodeIfPresent(weight, forKey: .weight)
        case .split(let direction, let children, let weight):
            try container.encode(Kind.split, forKey: .kind)
            try container.encode(direction, forKey: .direction)
            try container.encode(children, forKey: .children)
            try container.encodeIfPresent(weight, forKey: .weight)
        }
    }
}

indirect enum SurfAcePaneLayoutNode {
    case empty
    case leaf(Int, weight: Double? = nil)
    case split(direction: SurfAceLayoutDirection, children: [SurfAcePaneLayoutNode], weight: Double? = nil)

    var layoutIdentity: String {
        switch self {
        case .empty:
            return "empty"
        case .leaf(let paneId, let weight):
            return "leaf:\(paneId):\(weight ?? 1)"
        case .split(let direction, let children, let weight):
            let childIdentity = children.map(\.layoutIdentity).joined(separator: "|")
            return "split:\(direction.rawValue):\(weight ?? 1):[\(childIdentity)]"
        }
    }

    var paneIDs: [Int] {
        switch self {
        case .empty:
            return []
        case .leaf(let paneId, _):
            return [paneId]
        case .split(_, let children, _):
            return children.flatMap(\.paneIDs)
        }
    }

    func replacingLeaf(paneId: Int, with replacement: SurfAcePaneLayoutNode) -> SurfAcePaneLayoutNode {
        switch self {
        case .empty:
            return self
        case .leaf(let currentPaneId, _):
            return currentPaneId == paneId ? replacement : self
        case .split(let direction, let children, let weight):
            return .split(
                direction: direction,
                children: children.map { $0.replacingLeaf(paneId: paneId, with: replacement) },
                weight: weight
            )
        }
    }

    func replacingPaneID(from sourcePaneID: Int, to destinationPaneID: Int) -> SurfAcePaneLayoutNode {
        switch self {
        case .empty:
            return self
        case .leaf(let paneId, let weight):
            return .leaf(paneId == sourcePaneID ? destinationPaneID : paneId, weight: weight)
        case .split(let direction, let children, let weight):
            return .split(
                direction: direction,
                children: children.map { $0.replacingPaneID(from: sourcePaneID, to: destinationPaneID) },
                weight: weight
            )
        }
    }

    func removingLeaf(paneId: Int) -> SurfAcePaneLayoutNode? {
        switch self {
        case .empty:
            return self
        case .leaf(let currentPaneId, _):
            return currentPaneId == paneId ? nil : self
        case .split(let direction, let children, let weight):
            let remaining = children.compactMap { $0.removingLeaf(paneId: paneId) }
            if remaining.isEmpty {
                return nil
            }
            if remaining.count == 1 {
                return remaining[0]
            }
            return .split(direction: direction, children: remaining, weight: weight)
        }
    }

    var layoutWeight: Double {
        switch self {
        case .empty:
            return 1
        case .leaf(_, let weight), .split(_, _, let weight):
            guard let weight, weight.isFinite, weight > 0 else { return 1 }
            return weight
        }
    }

    func updatingSplitWeights(path: [Int], weights: [Double]) -> SurfAcePaneLayoutNode {
        guard case .split(let direction, let children, let weight) = self else { return self }
        guard let first = path.first else {
            let updatedChildren = children.enumerated().map { index, child in
                child.withWeight(max(0.05, weights.indices.contains(index) ? weights[index] : child.layoutWeight))
            }
            return .split(direction: direction, children: updatedChildren, weight: weight)
        }
        let rest = Array(path.dropFirst())
        let updatedChildren = children.enumerated().map { index, child in
            index == first ? child.updatingSplitWeights(path: rest, weights: weights) : child
        }
        return .split(direction: direction, children: updatedChildren, weight: weight)
    }

    private func withWeight(_ nextWeight: Double) -> SurfAcePaneLayoutNode {
        switch self {
        case .empty:
            return self
        case .leaf(let paneId, _):
            return .leaf(paneId, weight: nextWeight)
        case .split(let direction, let children, _):
            return .split(direction: direction, children: children, weight: nextWeight)
        }
    }
}

struct SurfAcePersistedPaneTopology: Codable {
    var paneId: Int
    var paneLineageId: String
    var paneLabel: Int
    var name: String?

    @MainActor
    init(pane: SurfAcePaneModel) {
        self.paneId = pane.paneId
        self.paneLineageId = pane.paneLineageId
        self.paneLabel = pane.paneLabel
        self.name = pane.name
    }

    @MainActor
    func makePane() -> SurfAcePaneModel {
        SurfAcePaneModel(paneId: paneId, paneLineageId: paneLineageId, paneLabel: paneLabel, name: name)
    }
}

struct SurfAcePersistedSurfaceTopology: Codable {
    var windowLabel: String
    var name: String
    var paneLayout: SurfAcePersistedPaneLayoutNode
    var panes: [SurfAcePersistedPaneTopology]

    @MainActor
    init(surface: SurfAceSurfaceModel) {
        self.windowLabel = surface.windowLabel
        self.name = surface.name
        self.paneLayout = SurfAcePersistedPaneLayoutNode(from: surface.paneLayout)
        self.panes = surface.panes.map(SurfAcePersistedPaneTopology.init(pane:))
    }

    @MainActor
    func apply(to surface: SurfAceSurfaceModel) {
        let restoredPanes = Dictionary(
            uniqueKeysWithValues: panes.map { pane in
                let restoredPane = pane.makePane()
                return (restoredPane.paneId, restoredPane)
            }
        )
        guard !restoredPanes.isEmpty else { return }
        surface.windowLabel = windowLabel
        surface.name = name
        surface.panesById = restoredPanes
        surface.paneLayout = paneLayout.runtimeNode
        surface.providerTopologyInitialized = true
    }
}

@MainActor
protocol SurfAcePaneBridging: AnyObject {
    func render(entry: SurfAcePaneEntry?, restoreViewport: SurfAceViewport?)
    func reloadBrowserURL()
    func renderBrowserURL(entry: SurfAcePaneEntry) async -> SurfAceBrowserNavigationResult
    func setInteraction(annotationMode: Bool, fingerDrawEnabled: Bool)
    func restoreDrawing(from drawingData: Data, strokes: [SurfAceStroke]) -> Bool
    func captureDrawingData() -> Data
    func fetchSnapshot(includeImage: Bool) async -> SurfAceSurfaceSnapshot?
    func applyHTMLPatch(_ patch: SurfAceFramePatchRequest) async -> SurfAceHTMLPatchResult
    func removeDrawingStrokeIDs(_ strokeIDs: [String])
    func clearDrawings()
}

extension SurfAcePaneBridging {
    func reloadBrowserURL() {}
}

struct SurfAceBrowserNavigationResult {
    var errorMessage: String?
    var status: String
    var url: String
}

struct SurfAceRenderDiagnostics: Equatable {
    var bridgeAttached: Bool
    var contentId: String?
    var contentType: SurfAceContentType?
    var revision: Int
    var status: String
    var message: String?

    var payload: [String: Any] {
        var payload: [String: Any] = [
            "bridgeAttached": bridgeAttached,
            "revision": revision,
            "status": status,
        ]
        if let contentId {
            payload["contentId"] = contentId
        }
        if let contentType {
            payload["contentType"] = contentType.rawValue
        }
        if let message {
            payload["message"] = message
        }
        return payload
    }
}

let surfAcePaneSplitSpacing: CGFloat = 1

struct SurfAcePaneGeometrySnapshot: Equatable {
    static let coordinateSpace = "surface_logical"

    let paneId: Int
    let paneInstanceId: String
    let topologyEpoch: Int
    let surfaceEpoch: Int
    let geometryRevision: Int
    let coordinateSpace: String
    let surfaceBounds: CGRect
    let paneFrame: CGRect
    let contentViewport: CGRect
    let splitSpacing: CGFloat
    let scale: CGFloat

    func withGeometryRevision(_ geometryRevision: Int) -> SurfAcePaneGeometrySnapshot {
        SurfAcePaneGeometrySnapshot(
            paneId: paneId,
            paneInstanceId: paneInstanceId,
            topologyEpoch: topologyEpoch,
            surfaceEpoch: surfaceEpoch,
            geometryRevision: geometryRevision,
            coordinateSpace: coordinateSpace,
            surfaceBounds: surfaceBounds,
            paneFrame: paneFrame,
            contentViewport: contentViewport,
            splitSpacing: splitSpacing,
            scale: scale
        )
    }
}

@MainActor
@Observable
final class SurfAcePaneModel {
    var paneId: Int
    var paneLineageId: String
    var paneLabel: Int
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
    var pendingSnapshotHintReason: String?
    var lastNavigationURL: String?
    var lastPage: (page: Int, totalPages: Int, pageText: String?)?
    var lastMeasuredSize = CGSize(width: 1, height: 1)
    var geometrySnapshot: SurfAcePaneGeometrySnapshot?
    var pendingFlushStrokes: [SurfAceStroke] = []
    var deliveredClosedFrameCount = 0
    var firstPendingStrokeAt: Int64?
    var lastPendingStrokeAt: Int64?
    var lastSuccessfulFlushAt: Date?
    var pendingAnnotationCommit = false
    var currentTarget: SurfAcePaneTargetState?
    var lastRenderDiagnostics = SurfAceRenderDiagnostics(
        bridgeAttached: false,
        contentId: nil,
        contentType: nil,
        revision: 0,
        status: "idle",
        message: nil
    )
    @ObservationIgnored var pendingFlushTask: Task<Void, Never>?
    @ObservationIgnored weak var bridge: (any SurfAcePaneBridging)?
    let paneInstanceId: String

    init(paneId: Int, paneLineageId: String = "pl_\(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased())", paneLabel: Int? = nil, name: String? = nil) {
        self.paneId = paneId
        self.paneLineageId = paneLineageId
        self.paneLabel = paneLabel ?? paneId
        self.name = name
        self.paneInstanceId = UUID().uuidString
        self.backStack = []
        self.currentEntry = .empty()
        self.forwardStack = []
    }

    var labelText: String { "\(paneLabel)" }
    var activeContentId: String? { currentEntry.contentId }
    var activeContentType: SurfAceContentType? { currentEntry.contentType }
    var currentRevision: Int { currentEntry.revision }
    var canGoBack: Bool { !backStack.isEmpty }
    var canGoForward: Bool { !forwardStack.isEmpty }
    var canReload: Bool {
        guard !annotationMode else { return false }
        if case .browserURL = currentEntry.payload {
            return true
        }
        return false
    }
    var activeStrokes: [SurfAceStroke] { currentEntry.strokesById.values.sorted { $0.strokeId < $1.strokeId } }

    func currentOwnerDisplayName() -> String? {
        if let title = currentEntry.title,
           !title.isEmpty {
            return title
        }
        return nil
    }
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
    var activeKeyboardPaneId: Int?
    var providerTopologyInitialized = false
    var connectionBarState: SurfAceConnectionBarState = .disconnected
    var viewportSize = CGSize(width: 1, height: 1)
    var viewportScale: CGFloat = 1
    var surfaceEpoch = 0
    var topologyEpoch = 0
    var geometryRevision = 0
    var lastError: String?

    init(sceneKey: String, surfaceId: String, windowLabel: String, name: String) {
        self.sceneKey = sceneKey
        self.surfaceId = surfaceId
        self.windowLabel = windowLabel
        self.name = name
        let initialPane = SurfAcePaneModel(paneId: 1, paneLabel: 1)
        self.panesById = [initialPane.paneId: initialPane]
        self.paneLayout = .leaf(initialPane.paneId)
        self.activeKeyboardPaneId = initialPane.paneId
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
