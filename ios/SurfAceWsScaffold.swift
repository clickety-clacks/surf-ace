import Foundation

/// Fresh WS-era scaffold for Surf Ace iOS.
/// Source of truth: DESIGN.md
struct PairResponseEnvelope: Codable {
    let type: String
    let payload: PairResponsePayload
}

struct PairResponsePayload: Codable {
    let sessionId: String
    let resumed: Bool
    let surface: SurfaceSummary
    let currentContentId: String?
    let currentRevision: Int
    let contentType: String?
}

struct SurfaceSummary: Codable {
    let id: String
    let name: String
    let viewport: Viewport
}

struct Viewport: Codable {
    let width: Int
    let height: Int
}
