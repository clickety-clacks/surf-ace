import Foundation

enum SurfAceLegacyRollbackCommand {
    static func run() throws {
        var arguments = Array(CommandLine.arguments.dropFirst())
        guard let command = arguments.first else { throw usage() }
        arguments.removeFirst()
        let options = try parse(arguments)
        switch command {
        case "preview":
            let report = try SurfAceAppleRollback.preview(
                sourceContainer: requiredURL("source-container", options),
                priorApplicationArtifact: requiredURL("prior-app-artifact", options),
                authorityRelativePath: options["authority-relative-path"]
                    ?? SurfAceAppleRollback.defaultAuthorityRelativePath
            )
            try SurfAceAppleRollback.writeJSON(report, to: requiredURL("output", options))
        case "apply":
            let preview = try SurfAceAppleRollback.readJSON(
                SurfAceAppleRollbackPreviewReport.self,
                from: requiredURL("preview", options)
            )
            let report = try SurfAceAppleRollback.apply(
                preview: preview,
                sourceContainer: requiredURL("source-container", options),
                containerCopy: requiredURL("container-copy", options),
                priorApplicationArtifact: requiredURL("prior-app-artifact", options)
            )
            try SurfAceAppleRollback.writeJSON(report, to: requiredURL("output", options))
        case "restore":
            let preview = try SurfAceAppleRollback.readJSON(
                SurfAceAppleRollbackPreviewReport.self,
                from: requiredURL("preview", options)
            )
            let manifest = try SurfAceAppleRollback.restore(
                preview: preview,
                sourceContainer: requiredURL("source-container", options),
                containerCopy: requiredURL("container-copy", options),
                priorApplicationArtifact: requiredURL("prior-app-artifact", options)
            )
            try SurfAceAppleRollback.writeJSON(manifest, to: requiredURL("output", options))
        default:
            throw usage()
        }
    }

    private static func parse(_ arguments: [String]) throws -> [String: String] {
        guard arguments.count.isMultiple(of: 2) else { throw usage() }
        var options: [String: String] = [:]
        var index = 0
        while index < arguments.count {
            let flag = arguments[index]
            guard flag.hasPrefix("--"), flag.count > 2 else { throw usage() }
            options[String(flag.dropFirst(2))] = arguments[index + 1]
            index += 2
        }
        return options
    }

    private static func requiredURL(_ name: String, _ options: [String: String]) throws -> URL {
        guard let path = options[name], !path.isEmpty else {
            throw SurfAceAppleRollbackError.invalidArguments("missing_\(name)")
        }
        return URL(fileURLWithPath: path)
    }

    private static func usage() -> SurfAceAppleRollbackError {
        .invalidArguments(
            "SurfAceLegacyRollback <preview|apply|restore> --source-container DIR "
                + "--prior-app-artifact PATH [--container-copy DIR] [--preview FILE] --output FILE"
        )
    }
}

try SurfAceLegacyRollbackCommand.run()
