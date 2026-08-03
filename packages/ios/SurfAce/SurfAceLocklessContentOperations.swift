import Foundation

enum SurfAceLocklessContentOperationError: Error, Equatable, Sendable {
    case surfaceNotFound(String)
    case paneNotFound(Int64)
    case annotationModeActive(Int64)
    case staleContent(currentContentId: String?, currentRevision: Int64)
    case unsupportedContentType(String?)
    case invalidContent(String)
    case paneStateCapacity(
        limit: String,
        current: Int64,
        prospective: Int64,
        maximum: Int64
    )
}

struct SurfAceLocklessContentSetIntent: Equatable, Sendable {
    var content: SurfAceLocklessJSON
    var contentId: String
    var contentType: String
    var controllerProductName: String?
    var friendlyChatName: String?
    var paneId: Int64
    var surfaceId: String
}

struct SurfAceLocklessContentMutationResult: Equatable, Sendable {
    var contentId: String?
    var contentType: String?
    var currentRevision: Int64
    var historyEntryId: String?
    var paneId: Int64
}

struct SurfAceLocklessContentPatchPreparation: Equatable, Sendable {
    var contentId: String
    var expectedRevision: Int64
    var historyEntryId: String
    var paneId: Int64
    var sourceContent: SurfAceLocklessJSON
    var surfaceId: String
}

enum SurfAceLocklessContentOperations {
    static let maximumNonVisibleHistoryEntries = 20

    static func exactPaneRecoverableBytes(
        _ pane: SurfAceLocklessPaneMaterial
    ) throws -> Int64 {
        try encodedBytes(Versioned(value: pane))
    }

    static func exactAnnotationRestoreBytes(
        _ pane: SurfAceLocklessPaneMaterial
    ) throws -> Int64 {
        try encodedBytes(Versioned(value:
            pane.history.back.map(\.annotations)
                + [pane.history.visible.annotations]
                + pane.history.forward.map(\.annotations)
        ))
    }

    static func set(
        state: inout SurfAceLocklessAuthorityState,
        intent: SurfAceLocklessContentSetIntent
    ) throws -> SurfAceLocklessContentMutationResult {
        try atomically(&state) { candidate in
            var surface = try liveSurface(candidate, intent.surfaceId)
            guard var pane = surface.panes[String(intent.paneId)] else {
                throw Error.paneNotFound(intent.paneId)
            }
            try requireAnnotationModeInactive(pane)
            try validateContent(intent.content, type: intent.contentType)

            let currentBytes = try paneBytes(pane)
            pane.history.forward.removeAll()
            pane.history.back.append(pane.history.visible)
            let revision = allocateRevision(in: &pane.history)
            let historyEntryId = opaqueHistoryEntryId()
            pane.history.visible = SurfAceLocklessHistoryEntry(
                annotations: emptyAnnotations,
                content: intent.content,
                contentId: intent.contentId,
                contentType: intent.contentType,
                historyEntryId: historyEntryId,
                lastVisibleSequence: allocateVisibleSequence(in: &pane.history),
                provenance: SurfAceLocklessEntryProvenance(
                    friendlyChatName: normalizedProvenance(intent.friendlyChatName),
                    controllerProductName: normalizedProvenance(intent.controllerProductName)
                ),
                revision: revision
            )
            trimNonVisibleHistory(&pane.history)
            try assertPaneCapacity(current: currentBytes, pane: pane, limits: candidate.limits)

            surface.panes[String(intent.paneId)] = pane
            surface.surfaceRevision += 1
            candidate.liveSurfaces[intent.surfaceId] = surface
            return result(for: pane, includeHistoryEntryId: true)
        }
    }

    static func append(
        state: inout SurfAceLocklessAuthorityState,
        surfaceId: String,
        paneId: Int64,
        contentId: String,
        expectedRevision: Int64,
        lines: [String]
    ) throws -> SurfAceLocklessContentMutationResult {
        try atomically(&state) { candidate in
            var surface = try liveSurface(candidate, surfaceId)
            guard var pane = surface.panes[String(paneId)] else {
                throw Error.paneNotFound(paneId)
            }
            try requireAnnotationModeInactive(pane)
            try requireCurrent(pane, contentId: contentId, revision: expectedRevision)
            guard pane.history.visible.contentType == "terminal",
                  case .object(var terminal) = pane.history.visible.content,
                  case .array(let currentLines) = terminal["lines"],
                  currentLines.allSatisfy({ if case .string = $0 { true } else { false } }),
                  case .integer(let scrollback) = terminal["scrollback"],
                  scrollback >= 0 else {
                throw Error.unsupportedContentType(pane.history.visible.contentType)
            }

            let currentBytes = try paneBytes(pane)
            terminal["lines"] = .array(currentLines + lines.map(SurfAceLocklessJSON.string))
            pane.history.visible.content = .object(terminal)
            pane.history.visible.revision = allocateRevision(in: &pane.history)
            try assertPaneCapacity(current: currentBytes, pane: pane, limits: candidate.limits)

            surface.panes[String(paneId)] = pane
            surface.surfaceRevision += 1
            candidate.liveSurfaces[surfaceId] = surface
            return result(for: pane, includeHistoryEntryId: false)
        }
    }

    static func clear(
        state: inout SurfAceLocklessAuthorityState,
        surfaceId: String,
        paneId: Int64,
        expectedRevision: Int64
    ) throws -> SurfAceLocklessContentMutationResult {
        try atomically(&state) { candidate in
            var surface = try liveSurface(candidate, surfaceId)
            guard var pane = surface.panes[String(paneId)] else {
                throw Error.paneNotFound(paneId)
            }
            try requireAnnotationModeInactive(pane)
            guard pane.history.visible.revision == expectedRevision else {
                throw staleContent(pane)
            }

            let currentBytes = try paneBytes(pane)
            pane.history.visible.annotations = emptyAnnotations
            pane.history.visible.content = emptyContent
            pane.history.visible.contentId = nil
            pane.history.visible.contentType = nil
            pane.history.visible.revision = allocateRevision(in: &pane.history)
            try assertPaneCapacity(current: currentBytes, pane: pane, limits: candidate.limits)

            surface.panes[String(paneId)] = pane
            surface.surfaceRevision += 1
            candidate.liveSurfaces[surfaceId] = surface
            return result(for: pane, includeHistoryEntryId: false)
        }
    }

    static func preparePatch(
        state: SurfAceLocklessAuthorityState,
        surfaceId: String,
        paneId: Int64,
        contentId: String,
        expectedRevision: Int64
    ) throws -> SurfAceLocklessContentPatchPreparation {
        let surface = try liveSurface(state, surfaceId)
        guard let pane = surface.panes[String(paneId)] else {
            throw Error.paneNotFound(paneId)
        }
        try requireAnnotationModeInactive(pane)
        try requireCurrent(pane, contentId: contentId, revision: expectedRevision)
        guard pane.history.visible.contentType == "html",
              case .object(let html) = pane.history.visible.content,
              case .string = html["html"] else {
            throw Error.unsupportedContentType(pane.history.visible.contentType)
        }
        return SurfAceLocklessContentPatchPreparation(
            contentId: contentId,
            expectedRevision: expectedRevision,
            historyEntryId: pane.history.visible.historyEntryId,
            paneId: paneId,
            sourceContent: pane.history.visible.content,
            surfaceId: surfaceId
        )
    }

    static func commitPatch(
        state: inout SurfAceLocklessAuthorityState,
        preparation: SurfAceLocklessContentPatchPreparation,
        patchedContent: SurfAceLocklessJSON
    ) throws -> SurfAceLocklessContentMutationResult {
        try atomically(&state) { candidate in
            var surface = try liveSurface(candidate, preparation.surfaceId)
            guard var pane = surface.panes[String(preparation.paneId)] else {
                throw Error.paneNotFound(preparation.paneId)
            }
            try requireAnnotationModeInactive(pane)
            try requireCurrent(
                pane,
                contentId: preparation.contentId,
                revision: preparation.expectedRevision
            )
            guard pane.history.visible.historyEntryId == preparation.historyEntryId,
                  pane.history.visible.content == preparation.sourceContent else {
                throw staleContent(pane)
            }
            try validateContent(patchedContent, type: "html")

            let currentBytes = try paneBytes(pane)
            pane.history.visible.content = patchedContent
            pane.history.visible.revision = allocateRevision(in: &pane.history)
            try assertPaneCapacity(current: currentBytes, pane: pane, limits: candidate.limits)

            surface.panes[String(preparation.paneId)] = pane
            surface.surfaceRevision += 1
            candidate.liveSurfaces[preparation.surfaceId] = surface
            return result(for: pane, includeHistoryEntryId: false)
        }
    }

    private typealias Error = SurfAceLocklessContentOperationError

    private static let emptyAnnotations: SurfAceLocklessJSON = .object([
        "drawingData": .string(""),
        "strokesById": .object([:]),
    ])
    private static let emptyContent: SurfAceLocklessJSON = .object([
        "interactive": .bool(true),
        "scrollable": .bool(true),
    ])

    private static func atomically<Result>(
        _ state: inout SurfAceLocklessAuthorityState,
        operation: (inout SurfAceLocklessAuthorityState) throws -> Result
    ) throws -> Result {
        var candidate = state
        let result = try operation(&candidate)
        state = candidate
        return result
    }

    private static func liveSurface(
        _ state: SurfAceLocklessAuthorityState,
        _ surfaceId: String
    ) throws -> SurfAceLocklessSurfaceMaterial {
        guard let surface = state.liveSurfaces[surfaceId] else {
            throw Error.surfaceNotFound(surfaceId)
        }
        return surface
    }

    private static func requireAnnotationModeInactive(
        _ pane: SurfAceLocklessPaneMaterial
    ) throws {
        guard !pane.annotationMode else {
            throw Error.annotationModeActive(pane.paneId)
        }
    }

    private static func requireCurrent(
        _ pane: SurfAceLocklessPaneMaterial,
        contentId: String,
        revision: Int64
    ) throws {
        guard pane.history.visible.contentId == contentId,
              pane.history.visible.revision == revision else {
            throw staleContent(pane)
        }
    }

    private static func staleContent(
        _ pane: SurfAceLocklessPaneMaterial
    ) -> SurfAceLocklessContentOperationError {
        .staleContent(
            currentContentId: pane.history.visible.contentId,
            currentRevision: pane.history.visible.revision
        )
    }

    private static func allocateRevision(in history: inout SurfAceLocklessHistory) -> Int64 {
        let revision = history.nextRevision
        history.nextRevision += 1
        return revision
    }

    private static func allocateVisibleSequence(
        in history: inout SurfAceLocklessHistory
    ) -> Int64 {
        let sequence = history.nextVisibleSequence
        history.nextVisibleSequence += 1
        return sequence
    }

    private static func trimNonVisibleHistory(_ history: inout SurfAceLocklessHistory) {
        while history.back.count + history.forward.count > maximumNonVisibleHistoryEntries {
            let backVictim = history.back.enumerated().min {
                ($0.element.lastVisibleSequence, $0.offset)
                    < ($1.element.lastVisibleSequence, $1.offset)
            }
            let forwardVictim = history.forward.enumerated().min {
                ($0.element.lastVisibleSequence, $0.offset)
                    < ($1.element.lastVisibleSequence, $1.offset)
            }
            switch (backVictim, forwardVictim) {
            case let (.some(back), .some(forward)):
                if back.element.lastVisibleSequence <= forward.element.lastVisibleSequence {
                    history.back.remove(at: back.offset)
                } else {
                    history.forward.remove(at: forward.offset)
                }
            case let (.some(back), .none):
                history.back.remove(at: back.offset)
            case let (.none, .some(forward)):
                history.forward.remove(at: forward.offset)
            case (.none, .none):
                return
            }
        }
    }

    private static func normalizedProvenance(_ value: String?) -> String? {
        guard let normalized = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !normalized.isEmpty else {
            return nil
        }
        return normalized
    }

    private static func opaqueHistoryEntryId() -> String {
        "he_\(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased())"
    }

    private static func result(
        for pane: SurfAceLocklessPaneMaterial,
        includeHistoryEntryId: Bool
    ) -> SurfAceLocklessContentMutationResult {
        SurfAceLocklessContentMutationResult(
            contentId: pane.history.visible.contentId,
            contentType: pane.history.visible.contentType,
            currentRevision: pane.history.visible.revision,
            historyEntryId: includeHistoryEntryId ? pane.history.visible.historyEntryId : nil,
            paneId: pane.paneId
        )
    }

    private static func validateContent(
        _ content: SurfAceLocklessJSON,
        type: String
    ) throws {
        guard case .object(let object) = content else {
            throw Error.invalidContent(type)
        }
        switch type {
        case "html":
            guard case .string = object["html"],
                  object.keys.allSatisfy({ $0 == "html" || $0 == "baseUrl" }),
                  object["baseUrl"].map({ if case .string = $0 { true } else { false } }) ?? true else {
                throw Error.invalidContent(type)
            }
        case "image":
            guard case .string = object["data"],
                  case .string = object["mediaType"],
                  object.keys.allSatisfy({ $0 == "data" || $0 == "mediaType" || $0 == "alt" }),
                  object["alt"].map({ if case .string = $0 { true } else { false } }) ?? true else {
                throw Error.invalidContent(type)
            }
        case "pdf":
            guard Set(object.keys) == Set(["data"]), case .string = object["data"] else {
                throw Error.invalidContent(type)
            }
        case "terminal":
            guard Set(object.keys) == Set(["lines", "scrollback"]),
                  case .array(let lines) = object["lines"],
                  lines.allSatisfy({ if case .string = $0 { true } else { false } }),
                  case .integer(let scrollback) = object["scrollback"],
                  scrollback >= 0 else {
                throw Error.invalidContent(type)
            }
        case "markdown":
            guard Set(object.keys) == Set(["markdown"]), case .string = object["markdown"] else {
                throw Error.invalidContent(type)
            }
        default:
            throw Error.unsupportedContentType(type)
        }
    }

    private static func assertPaneCapacity(
        current: Int64,
        pane: SurfAceLocklessPaneMaterial,
        limits: SurfAceLocklessCapacityLimits
    ) throws {
        let prospective = try paneBytes(pane)
        let annotationBytes = try exactAnnotationRestoreBytes(pane)
        if annotationBytes > limits.maxPaneAnnotationRestoreBytes {
            throw Error.paneStateCapacity(
                limit: "maxPaneAnnotationRestoreBytes",
                current: current,
                prospective: annotationBytes,
                maximum: limits.maxPaneAnnotationRestoreBytes
            )
        }
        if prospective > limits.maxPaneRecoverableStateBytes {
            throw Error.paneStateCapacity(
                limit: "maxPaneRecoverableStateBytes",
                current: current,
                prospective: prospective,
                maximum: limits.maxPaneRecoverableStateBytes
            )
        }
    }

    private static func paneBytes(_ pane: SurfAceLocklessPaneMaterial) throws -> Int64 {
        try exactPaneRecoverableBytes(pane)
    }

    private static func encodedBytes<Value: Encodable>(_ value: Value) throws -> Int64 {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return Int64(try encoder.encode(value).count)
    }

    private struct Versioned<Value: Codable>: Codable {
        var value: Value
        var version = 1
    }
}
