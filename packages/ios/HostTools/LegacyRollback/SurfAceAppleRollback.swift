import CryptoKit
import Foundation

struct SurfAceRollbackManifestEntry: Codable, Equatable, Sendable {
    var bytes: Int64?
    var path: String
    var sha256: String?
    var symlinkDestination: String?
    var type: String
}

struct SurfAceRollbackContainerManifest: Codable, Equatable, Sendable {
    var digest: String
    var entries: [SurfAceRollbackManifestEntry]
}

struct SurfAceAppleRollbackPreviewReport: Codable, Equatable, Sendable {
    var authorityGeneration: Int64
    var authorityRelativePath: String
    var authoritySHA256: String
    var legacyPreview: SurfAceLocklessRollbackPreview
    var priorApplicationArtifactPath: String
    var priorApplicationArtifactSHA256: String
    var sourceContainerManifest: SurfAceRollbackContainerManifest
    var sourceContainerPath: String
    var version: Int
}

struct SurfAceAppleRollbackApplyReport: Codable, Equatable, Sendable {
    var appliedContainerManifest: SurfAceRollbackContainerManifest
    var appliedContainerPath: String
    var originalContainerManifest: SurfAceRollbackContainerManifest
    var preferencesRelativePath: String
    var sourceGeneration: Int64
    var version: Int
}

enum SurfAceAppleRollbackError: Error, Equatable, CustomStringConvertible {
    case authorityIdentityMismatch
    case containerCopyMustDifferFromSource
    case containerIdentityMismatch
    case invalidArguments(String)
    case invalidContainer(String)
    case priorApplicationArtifactMismatch
    case restorationMismatch

    var description: String {
        switch self {
        case .authorityIdentityMismatch: "authority_identity_mismatch"
        case .containerCopyMustDifferFromSource: "container_copy_must_differ_from_source"
        case .containerIdentityMismatch: "container_identity_mismatch"
        case .invalidArguments(let detail): "invalid_arguments:\(detail)"
        case .invalidContainer(let detail): "invalid_container:\(detail)"
        case .priorApplicationArtifactMismatch: "prior_application_artifact_mismatch"
        case .restorationMismatch: "restoration_mismatch"
        }
    }
}

enum SurfAceAppleRollback {
    static let defaultAuthorityRelativePath = "Library/Application Support/SurfAce/lockless-authority-v1.json"
    static let preferencesRelativePath = "Library/Preferences/co.clicketyclacks.SurfAce.plist"

    static func preview(
        sourceContainer: URL,
        priorApplicationArtifact: URL,
        authorityRelativePath: String = defaultAuthorityRelativePath
    ) throws -> SurfAceAppleRollbackPreviewReport {
        let source = try canonicalDirectory(sourceContainer)
        let artifact = priorApplicationArtifact.standardizedFileURL
        guard FileManager.default.fileExists(atPath: artifact.path) else {
            throw SurfAceAppleRollbackError.priorApplicationArtifactMismatch
        }
        let authorityURL = source.appendingPathComponent(authorityRelativePath)
        let authorityBytes = try Data(contentsOf: authorityURL)
        let authority = try JSONDecoder().decode(SurfAceLocklessAuthorityState.self, from: authorityBytes)
        try authority.validate()
        return SurfAceAppleRollbackPreviewReport(
            authorityGeneration: authority.generation,
            authorityRelativePath: authorityRelativePath,
            authoritySHA256: sha256(authorityBytes),
            legacyPreview: try SurfAceLocklessMigration.rollbackPreview(authority),
            priorApplicationArtifactPath: artifact.path,
            priorApplicationArtifactSHA256: try itemDigest(artifact),
            sourceContainerManifest: try manifest(source),
            sourceContainerPath: source.path,
            version: 1
        )
    }

    static func apply(
        preview: SurfAceAppleRollbackPreviewReport,
        sourceContainer: URL,
        containerCopy: URL,
        priorApplicationArtifact: URL
    ) throws -> SurfAceAppleRollbackApplyReport {
        let source = try canonicalDirectory(sourceContainer)
        let copy = try canonicalDirectory(containerCopy)
        try validateDistinct(source: source, copy: copy)
        try validate(preview: preview, source: source, priorApplicationArtifact: priorApplicationArtifact)
        guard try manifest(copy) == preview.sourceContainerManifest else {
            throw SurfAceAppleRollbackError.containerIdentityMismatch
        }

        let preferencesURL = copy.appendingPathComponent(preferencesRelativePath)
        var preferences = try readPreferences(preferencesURL)
        preferences[SurfAceLegacyUserDefaultsSnapshot.identityMappingKey] = preview.legacyPreview.projection.identityMapping
        preferences[SurfAceLegacyUserDefaultsSnapshot.surfaceTopologyKey] = preview.legacyPreview.projection.surfaceTopologies
        try writePreferences(preferences, to: preferencesURL)

        return SurfAceAppleRollbackApplyReport(
            appliedContainerManifest: try manifest(copy),
            appliedContainerPath: copy.path,
            originalContainerManifest: preview.sourceContainerManifest,
            preferencesRelativePath: preferencesRelativePath,
            sourceGeneration: preview.authorityGeneration,
            version: 1
        )
    }

    static func restore(
        preview: SurfAceAppleRollbackPreviewReport,
        sourceContainer: URL,
        containerCopy: URL,
        priorApplicationArtifact: URL
    ) throws -> SurfAceRollbackContainerManifest {
        let source = try canonicalDirectory(sourceContainer)
        let copy = try canonicalDirectory(containerCopy)
        try validateDistinct(source: source, copy: copy)
        try validate(preview: preview, source: source, priorApplicationArtifact: priorApplicationArtifact)

        for child in try FileManager.default.contentsOfDirectory(
            at: copy,
            includingPropertiesForKeys: nil,
            options: []
        ) {
            try FileManager.default.removeItem(at: child)
        }
        for child in try FileManager.default.contentsOfDirectory(
            at: source,
            includingPropertiesForKeys: nil,
            options: []
        ) {
            try FileManager.default.copyItem(at: child, to: copy.appendingPathComponent(child.lastPathComponent))
        }
        let restored = try manifest(copy)
        guard restored == preview.sourceContainerManifest else {
            throw SurfAceAppleRollbackError.restorationMismatch
        }
        return restored
    }

    static func writeJSON<T: Encodable>(_ value: T, to url: URL) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        try atomicWrite(try encoder.encode(value), to: url)
    }

    static func readJSON<T: Decodable>(_ type: T.Type, from url: URL) throws -> T {
        try JSONDecoder().decode(type, from: Data(contentsOf: url))
    }

    static func manifest(_ container: URL) throws -> SurfAceRollbackContainerManifest {
        let root = try canonicalDirectory(container)
        guard let enumerator = FileManager.default.enumerator(atPath: root.path) else {
            throw SurfAceAppleRollbackError.invalidContainer("enumeration_failed")
        }
        var entries: [SurfAceRollbackManifestEntry] = []
        for case let relative as String in enumerator {
            let item = root.appendingPathComponent(relative)
            let values = try item.resourceValues(forKeys: [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            if values.isSymbolicLink == true {
                entries.append(.init(
                    bytes: nil,
                    path: relative,
                    sha256: nil,
                    symlinkDestination: try FileManager.default.destinationOfSymbolicLink(atPath: item.path),
                    type: "symlink"
                ))
                enumerator.skipDescendants()
            } else if values.isDirectory == true {
                entries.append(.init(bytes: nil, path: relative, sha256: nil, symlinkDestination: nil, type: "directory"))
            } else if values.isRegularFile == true {
                let bytes = try Data(contentsOf: item)
                entries.append(.init(
                    bytes: Int64(bytes.count),
                    path: relative,
                    sha256: sha256(bytes),
                    symlinkDestination: nil,
                    type: "file"
                ))
            } else {
                throw SurfAceAppleRollbackError.invalidContainer("unsupported_item:\(relative)")
            }
        }
        entries.sort { $0.path < $1.path }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return SurfAceRollbackContainerManifest(
            digest: sha256(try encoder.encode(entries)),
            entries: entries
        )
    }

    private static func validate(
        preview: SurfAceAppleRollbackPreviewReport,
        source: URL,
        priorApplicationArtifact: URL
    ) throws {
        guard preview.version == 1, preview.sourceContainerPath == source.path,
              try manifest(source) == preview.sourceContainerManifest else {
            throw SurfAceAppleRollbackError.containerIdentityMismatch
        }
        let artifact = priorApplicationArtifact.standardizedFileURL
        guard artifact.path == preview.priorApplicationArtifactPath,
              try itemDigest(artifact) == preview.priorApplicationArtifactSHA256 else {
            throw SurfAceAppleRollbackError.priorApplicationArtifactMismatch
        }
        let authorityBytes = try Data(contentsOf: source.appendingPathComponent(preview.authorityRelativePath))
        let authority = try JSONDecoder().decode(SurfAceLocklessAuthorityState.self, from: authorityBytes)
        guard sha256(authorityBytes) == preview.authoritySHA256,
              authority.generation == preview.authorityGeneration else {
            throw SurfAceAppleRollbackError.authorityIdentityMismatch
        }
    }

    private static func readPreferences(_ url: URL) throws -> [String: Any] {
        guard FileManager.default.fileExists(atPath: url.path) else { return [:] }
        var format = PropertyListSerialization.PropertyListFormat.binary
        let value = try PropertyListSerialization.propertyList(
            from: Data(contentsOf: url),
            options: [],
            format: &format
        )
        guard let preferences = value as? [String: Any] else {
            throw SurfAceAppleRollbackError.invalidContainer("preferences_root")
        }
        return preferences
    }

    private static func writePreferences(_ preferences: [String: Any], to url: URL) throws {
        let bytes = try PropertyListSerialization.data(
            fromPropertyList: preferences,
            format: .binary,
            options: 0
        )
        try atomicWrite(bytes, to: url)
    }

    private static func atomicWrite(_ bytes: Data, to url: URL) throws {
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let temporary = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).next")
        try bytes.write(to: temporary)
        let handle = try FileHandle(forWritingTo: temporary)
        try handle.synchronize()
        try handle.close()
        if FileManager.default.fileExists(atPath: url.path) {
            _ = try FileManager.default.replaceItemAt(url, withItemAt: temporary)
        } else {
            try FileManager.default.moveItem(at: temporary, to: url)
        }
    }

    private static func validateDistinct(source: URL, copy: URL) throws {
        guard source.path != copy.path else {
            throw SurfAceAppleRollbackError.containerCopyMustDifferFromSource
        }
    }

    private static func canonicalDirectory(_ url: URL) throws -> URL {
        let canonical = url.standardizedFileURL.resolvingSymlinksInPath()
        var isDirectory: ObjCBool = false
        guard canonical.path != "/",
              FileManager.default.fileExists(atPath: canonical.path, isDirectory: &isDirectory),
              isDirectory.boolValue else {
            throw SurfAceAppleRollbackError.invalidContainer(canonical.path)
        }
        return canonical
    }

    private static func itemDigest(_ url: URL) throws -> String {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) else {
            throw SurfAceAppleRollbackError.priorApplicationArtifactMismatch
        }
        return isDirectory.boolValue ? try manifest(url).digest : sha256(try Data(contentsOf: url))
    }

    private static func sha256(_ bytes: Data) -> String {
        SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }
}
