import Foundation

enum SurfAceAnnotationOutboxError: Error {
    case invalidLimit
    case invalidState
    case sequenceExhausted
    case gapReserveViolation
    case staleAcceptance
    case invalidRecord
}

struct SurfAceAnnotationOutboxEntry: Codable, Equatable, Sendable {
    var canonical: String
    var kind: String
    var sourceEventId: String
    var sourceSequence: String
}

struct SurfAceAnnotationPendingGap: Codable, Equatable, Sendable {
    var from: String
    var through: String
    var sourceEventId: String
    var reason: String
}

struct SurfAceAnnotationSurfaceOutbox: Codable, Equatable, Sendable {
    var acceptedCursor: SurfAceAnnotationServerCursor?
    var diagnostic: SurfAceAnnotationDiagnostic?
    var fifo: [SurfAceAnnotationOutboxEntry]
    var nextSequence: Int64
    var trailingGap: SurfAceAnnotationPendingGap?

    static var empty: Self {
        Self(acceptedCursor: nil, diagnostic: nil, fifo: [], nextSequence: 1, trailingGap: nil)
    }
}

struct SurfAceAnnotationServerCursor: Codable, Equatable, Sendable {
    var epoch: String
    var sequence: String
}

struct SurfAceAnnotationDiagnostic: Codable, Equatable, Sendable {
    var code: String
    var sequence: String
}

/// The caller commits a mutated snapshot before attempting to send `head`.
struct SurfAceAnnotationOutbox: Codable, Equatable, Sendable {
    static let maximumBytes = 67_108_864
    static let maximumRecords = 256
    static let gapSlotBytes = 8_192
    static let maximumRecordBytes = 16_777_216

    var version = 1
    var clientId: String
    var sourceEpoch: String
    var surfaces: [String: SurfAceAnnotationSurfaceOutbox] = [:]

    init(clientId: String, sourceEpoch: String = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()) throws {
        guard !clientId.isEmpty, clientId.utf8.count <= 128,
              sourceEpoch.count == 32, sourceEpoch.utf8.allSatisfy({ $0.isASCIIHexLowercase }) else {
            throw SurfAceAnnotationOutboxError.invalidState
        }
        self.clientId = clientId
        self.sourceEpoch = sourceEpoch
    }

    func validate(maxBytes: Int = maximumBytes, maxRecords: Int = maximumRecords) throws {
        guard maxBytes >= 2 * Self.gapSlotBytes + 1_024,
              maxBytes <= Self.maximumBytes, maxRecords >= 2,
              maxRecords <= Self.maximumRecords, version == 1,
              sourceEpoch.count == 32, sourceEpoch.utf8.allSatisfy({ $0.isASCIIHexLowercase }) else {
            throw SurfAceAnnotationOutboxError.invalidLimit
        }
        for (surfaceId, surface) in surfaces {
            guard !surfaceId.isEmpty, surfaceId.utf8.count <= 128,
                  surface.nextSequence > 0, surface.fifo.count <= maxRecords,
                  surface.fifo.allSatisfy({ $0.canonical.utf8.count <= Self.maximumRecordBytes }),
                  try fits(surfaceId: surfaceId, maxBytes: maxBytes, maxRecords: maxRecords) else {
                throw SurfAceAnnotationOutboxError.invalidState
            }
        }
    }

    func partitionBytes(surfaceId: String) throws -> Int64 {
        guard let surface = surfaces[surfaceId] else { return 0 }
        struct Partition: Encodable {
            let version: Int
            let clientId: String
            let sourceEpoch: String
            let surface: SurfAceAnnotationSurfaceOutbox
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return Int64(try encoder.encode(Partition(version: 1, clientId: clientId,
                                                 sourceEpoch: sourceEpoch, surface: surface)).count)
    }

    func pendingSurfaceIds() -> [String] {
        surfaces.keys.filter { surfaceId in
            guard let surface = surfaces[surfaceId] else { return false }
            return !surface.fifo.isEmpty || surface.trailingGap != nil
        }.sorted()
    }

    func needsSeal(surfaceId: String) -> Bool {
        guard let surface = surfaces[surfaceId] else { return false }
        return surface.trailingGap != nil && !surface.fifo.contains { $0.kind == "gap" }
    }

    mutating func append(surfaceId: String, record: [String: Any],
                         maxBytes: Int = maximumBytes, maxRecords: Int = maximumRecords) throws -> String {
        try ensureSurface(surfaceId, maxBytes: maxBytes, maxRecords: maxRecords)
        guard var surface = surfaces[surfaceId] else { throw SurfAceAnnotationOutboxError.invalidState }
        guard surface.nextSequence < Int64.max else { throw SurfAceAnnotationOutboxError.sequenceExhausted }
        let sequence = String(surface.nextSequence)
        surface.nextSequence += 1
        if surface.trailingGap != nil || surface.fifo.contains(where: { $0.kind == "gap" }) {
            surface.extendGap(sequence: sequence, reason: "source_retention_overflow")
            surfaces[surfaceId] = surface
            return sequence
        }
        let eventId = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        var source = record
        source["protocolVersion"] = 1
        source["clientId"] = clientId
        source["sourceEpoch"] = sourceEpoch
        source["surfaceId"] = surfaceId
        source["sourceSequence"] = sequence
        source["sourceEventId"] = eventId
        guard let canonical = Self.canonical(source),
              Self.hasBasicRecordShape(source) else {
            surface.extendGap(sequence: sequence, reason: "source_record_rejected")
            surface.diagnostic = .init(code: "annotation_invalid_request", sequence: sequence)
            surfaces[surfaceId] = surface
            return sequence
        }
        if canonical.utf8.count > Self.maximumRecordBytes || surface.fifo.count >= maxRecords - 1 {
            surface.extendGap(sequence: sequence, reason: "source_retention_overflow")
            surfaces[surfaceId] = surface
            return sequence
        }
        surface.fifo.append(.init(canonical: canonical, kind: "payload",
                                  sourceEventId: eventId, sourceSequence: sequence))
        surfaces[surfaceId] = surface
        if try !fits(surfaceId: surfaceId, maxBytes: maxBytes, maxRecords: maxRecords) {
            surface.fifo.removeLast()
            surface.extendGap(sequence: sequence, reason: "source_retention_overflow")
            surfaces[surfaceId] = surface
        }
        return sequence
    }

    mutating func head(surfaceId: String, maxBytes: Int = maximumBytes,
                       maxRecords: Int = maximumRecords) throws -> SurfAceAnnotationOutboxEntry? {
        guard var surface = surfaces[surfaceId] else { return nil }
        if !surface.fifo.contains(where: { $0.kind == "gap" }), let gap = surface.trailingGap {
            let source: [String: Any] = [
                "protocolVersion": 1, "clientId": clientId, "sourceEpoch": sourceEpoch,
                "surfaceId": surfaceId, "sourceSequence": gap.through,
                "sourceEventId": gap.sourceEventId, "lostFromSequence": gap.from,
                "lostThroughSequence": gap.through, "reason": gap.reason,
            ]
            guard let canonical = Self.canonical(source), canonical.utf8.count <= Self.maximumRecordBytes else {
                throw SurfAceAnnotationOutboxError.gapReserveViolation
            }
            surface.fifo.append(.init(canonical: canonical, kind: "gap",
                                      sourceEventId: gap.sourceEventId, sourceSequence: gap.through))
            surface.trailingGap = nil
            surfaces[surfaceId] = surface
            guard try fits(surfaceId: surfaceId, maxBytes: maxBytes, maxRecords: maxRecords) else {
                throw SurfAceAnnotationOutboxError.gapReserveViolation
            }
        }
        return surfaces[surfaceId]?.fifo.first
    }

    mutating func accept(surfaceId: String, head: SurfAceAnnotationOutboxEntry,
                         cursor: SurfAceAnnotationServerCursor) throws {
        guard var surface = surfaces[surfaceId], surface.fifo.first == head,
              cursor.epoch.count == 32, cursor.epoch.utf8.allSatisfy({ $0.isASCIIHexLowercase }),
              Int64(cursor.sequence).map({ $0 > 0 }) == true else {
            throw SurfAceAnnotationOutboxError.staleAcceptance
        }
        surface.fifo.removeFirst()
        surface.acceptedCursor = cursor
        surfaces[surfaceId] = surface
    }

    mutating func rejectHead(surfaceId: String, code: String) throws {
        guard code == "annotation_record_too_large" || code == "annotation_context_image_invalid",
              var surface = surfaces[surfaceId], let head = surface.fifo.first,
              head.kind == "payload" else { throw SurfAceAnnotationOutboxError.invalidRecord }
        let source: [String: Any] = [
            "protocolVersion": 1, "clientId": clientId, "sourceEpoch": sourceEpoch,
            "surfaceId": surfaceId, "sourceSequence": head.sourceSequence,
            "sourceEventId": head.sourceEventId,
            "lostFromSequence": head.sourceSequence,
            "lostThroughSequence": head.sourceSequence,
            "reason": "source_record_rejected",
        ]
        guard let canonical = Self.canonical(source) else { throw SurfAceAnnotationOutboxError.invalidRecord }
        surface.fifo[0] = .init(canonical: canonical, kind: "gap",
                                sourceEventId: head.sourceEventId, sourceSequence: head.sourceSequence)
        surface.diagnostic = .init(code: code, sequence: head.sourceSequence)
        surfaces[surfaceId] = surface
    }

    private mutating func ensureSurface(_ surfaceId: String, maxBytes: Int, maxRecords: Int) throws {
        guard !surfaceId.isEmpty, surfaceId.utf8.count <= 128 else {
            throw SurfAceAnnotationOutboxError.invalidState
        }
        if surfaces[surfaceId] != nil { return }
        surfaces[surfaceId] = .empty
        guard try fits(surfaceId: surfaceId, maxBytes: maxBytes, maxRecords: maxRecords) else {
            surfaces.removeValue(forKey: surfaceId)
            throw SurfAceAnnotationOutboxError.invalidLimit
        }
    }

    private func fits(surfaceId: String, maxBytes: Int, maxRecords: Int) throws -> Bool {
        guard let surface = surfaces[surfaceId], surface.fifo.count <= maxRecords else { return false }
        return try partitionBytes(surfaceId: surfaceId) + Int64(2 * Self.gapSlotBytes) <= maxBytes
    }

    private static func canonical(_ value: [String: Any]) -> String? {
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
              let string = String(data: data, encoding: .utf8) else { return nil }
        return string
    }

    private static func hasBasicRecordShape(_ value: [String: Any]) -> Bool {
        guard let kind = value["kind"] as? String, kind == "live_delta" || kind == "frame_commit",
              let paneId = value["paneId"] as? Int, paneId > 0,
              let frameId = value["frameId"] as? String, !frameId.isEmpty,
              let contentId = value["contentId"] as? String, !contentId.isEmpty,
              let revision = value["revision"] as? Int, revision >= 0,
              let contentType = value["contentType"] as? String,
              ["html", "image", "pdf", "terminal", "markdown", "video", "canvas"].contains(contentType),
              value["sourceTimestamp"] is String,
              value["viewport"] is [String: Any], value["payload"] is [String: Any] else { return false }
        return true
    }
}

private extension UInt8 {
    var isASCIIHexLowercase: Bool { (48...57).contains(self) || (97...102).contains(self) }
}

private extension SurfAceAnnotationSurfaceOutbox {
    mutating func extendGap(sequence: String, reason: String) {
        if trailingGap != nil {
            trailingGap?.through = sequence
        } else {
            trailingGap = .init(from: sequence, through: sequence,
                                sourceEventId: UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased(),
                                reason: reason)
        }
    }
}
