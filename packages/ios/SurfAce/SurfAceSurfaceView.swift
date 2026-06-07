import Observation
import PDFKit
import PencilKit
import Security
import SwiftUI
import UIKit
import WebKit

private let surfAceSurfaceCoordinateSpaceName = "SurfAce.surface.logical"

private enum SurfAcePaneChromeLayout {
    static let bottomInset: CGFloat = 28
}

func surfAceRootContentIgnoredSafeAreaEdges() -> Edge.Set {
    [.horizontal, .bottom]
}

private enum SurfAceSpatialPaneChromeLayout {
    static let cornerInset: CGFloat = 0
    static let cornerRadius: CGFloat = 45
    static let endpointTrimDegrees: Double = 14
    static let outwardOffset: CGFloat = 32
    static let minimumVisibleMarkerSpan: CGFloat = 16
    static let lineWidth: CGFloat = 3
    static let opacity: Double = 0.18
    static let fillOpacity: Double = 0.01
}

func surfAceSpatialEmptyPaneCornerInset() -> CGFloat {
    SurfAceSpatialPaneChromeLayout.cornerInset
}

private enum SurfAceSpatialWindowContentLayout {
    static let cornerRadius: CGFloat = 28
    static let edgeTolerance: CGFloat = 0.5
}

private enum SurfAceSplitHandleLayout {
    static let visibleSize: CGFloat = 44
    static let iconSize: CGFloat = 17
}

func surfAceEscapeHTML(_ string: String) -> String {
    string
        .replacingOccurrences(of: "&", with: "&amp;")
        .replacingOccurrences(of: "<", with: "&lt;")
        .replacingOccurrences(of: ">", with: "&gt;")
        .replacingOccurrences(of: "\"", with: "&quot;")
        .replacingOccurrences(of: "'", with: "&#39;")
}

func surfAceMarkdownToHTML(_ markdown: String) -> String {
    let lines = markdown.replacingOccurrences(of: "\r\n", with: "\n")
        .replacingOccurrences(of: "\r", with: "\n")
        .components(separatedBy: "\n")
    var blocks: [String] = []
    var index = 0

    while index < lines.count {
        let line = lines[index]
        if line.trimmingCharacters(in: .whitespaces).isEmpty {
            index += 1
            continue
        }

        if surfAceMarkdownIsFence(line) {
            var codeLines: [String] = []
            index += 1
            while index < lines.count, !surfAceMarkdownIsFence(lines[index]) {
                codeLines.append(lines[index])
                index += 1
            }
            if index < lines.count {
                index += 1
            }
            blocks.append("<pre><code>\(surfAceEscapeHTML(codeLines.joined(separator: "\n")))</code></pre>")
            continue
        }

        let heading = surfAceMarkdownHeading(line)
        if heading.level > 0 {
            blocks.append("<h\(heading.level)>\(surfAceMarkdownInlineHTML(heading.text))</h\(heading.level)>")
            index += 1
            continue
        }

        if index + 1 < lines.count, line.contains("|"), surfAceMarkdownIsTableDivider(lines[index + 1]) {
            let headers = surfAceMarkdownTableCells(line)
            index += 2
            var rows: [[String]] = []
            while index < lines.count,
                  lines[index].contains("|"),
                  !lines[index].trimmingCharacters(in: .whitespaces).isEmpty {
                rows.append(surfAceMarkdownTableCells(lines[index]))
                index += 1
            }
            let headerHTML = headers.map { "<th>\(surfAceMarkdownInlineHTML($0))</th>" }.joined()
            let rowsHTML = rows.map { row in
                "<tr>\(row.map { "<td>\(surfAceMarkdownInlineHTML($0))</td>" }.joined())</tr>"
            }.joined()
            blocks.append("<table><thead><tr>\(headerHTML)</tr></thead><tbody>\(rowsHTML)</tbody></table>")
            continue
        }

        if surfAceMarkdownIsUnorderedListItem(line) || surfAceMarkdownIsOrderedListItem(line) {
            let ordered = surfAceMarkdownIsOrderedListItem(line)
            let tag = ordered ? "ol" : "ul"
            var items: [String] = []
            while index < lines.count,
                  ordered ? surfAceMarkdownIsOrderedListItem(lines[index]) : surfAceMarkdownIsUnorderedListItem(lines[index]) {
                items.append("<li>\(surfAceMarkdownInlineHTML(surfAceMarkdownListItemText(lines[index])))</li>")
                index += 1
            }
            blocks.append("<\(tag)>\(items.joined())</\(tag)>")
            continue
        }

        if line.trimmingCharacters(in: .whitespaces).hasPrefix(">") {
            var quoted: [String] = []
            while index < lines.count, lines[index].trimmingCharacters(in: .whitespaces).hasPrefix(">") {
                quoted.append(surfAceMarkdownStripBlockquote(lines[index]))
                index += 1
            }
            blocks.append("<blockquote>\(surfAceMarkdownToHTML(quoted.joined(separator: "\n")))</blockquote>")
            continue
        }

        var paragraph: [String] = []
        while index < lines.count, !surfAceMarkdownStartsBlock(lines: lines, index: index) {
            paragraph.append(lines[index].trimmingCharacters(in: .whitespaces))
            index += 1
        }
        blocks.append("<p>\(surfAceMarkdownInlineHTML(paragraph.joined(separator: " ")))</p>")
    }

    return blocks.joined()
}

private func surfAceMarkdownInlineHTML(_ markdown: String) -> String {
    var html = ""
    var index = markdown.startIndex

    while index < markdown.endIndex {
        let rest = markdown[index...]
        if rest.hasPrefix("`"),
           let end = markdown[index...].dropFirst().firstIndex(of: "`") {
            html += "<code>\(surfAceEscapeHTML(String(markdown[markdown.index(after: index)..<end])))</code>"
            index = markdown.index(after: end)
            continue
        }

        if rest.hasPrefix("**"),
           let end = markdown[markdown.index(index, offsetBy: 2)...].range(of: "**")?.lowerBound {
            html += "<strong>\(surfAceMarkdownInlineHTML(String(markdown[markdown.index(index, offsetBy: 2)..<end])))</strong>"
            index = markdown.index(end, offsetBy: 2)
            continue
        }

        if rest.hasPrefix("*"),
           let end = markdown[index...].dropFirst().firstIndex(of: "*") {
            html += "<em>\(surfAceMarkdownInlineHTML(String(markdown[markdown.index(after: index)..<end])))</em>"
            index = markdown.index(after: end)
            continue
        }

        if rest.hasPrefix("["),
           let labelEnd = markdown[index...].firstIndex(of: "]"),
           markdown.index(after: labelEnd) < markdown.endIndex,
           markdown[markdown.index(after: labelEnd)] == "(",
           let hrefEnd = markdown[markdown.index(labelEnd, offsetBy: 2)...].firstIndex(of: ")") {
            let label = surfAceMarkdownInlineHTML(String(markdown[markdown.index(after: index)..<labelEnd]))
            let hrefStart = markdown.index(labelEnd, offsetBy: 2)
            let href = surfAceEscapeHTML(String(markdown[hrefStart..<hrefEnd]).trimmingCharacters(in: .whitespaces))
            html += "<a data-href=\"\(href)\" title=\"\(href)\">\(label)</a>"
            index = markdown.index(after: hrefEnd)
            continue
        }

        html += surfAceEscapeHTML(String(markdown[index]))
        index = markdown.index(after: index)
    }

    return html
}

private func surfAceMarkdownIsFence(_ line: String) -> Bool {
    line.trimmingCharacters(in: .whitespaces).hasPrefix("```")
}

private func surfAceMarkdownHeading(_ line: String) -> (level: Int, text: String) {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    var level = 0
    for character in trimmed {
        if character == "#", level < 6 {
            level += 1
        } else {
            break
        }
    }
    guard level > 0,
          trimmed.count > level,
          trimmed[trimmed.index(trimmed.startIndex, offsetBy: level)] == " " else {
        return (0, line)
    }
    return (level, String(trimmed.dropFirst(level + 1)))
}

private func surfAceMarkdownIsUnorderedListItem(_ line: String) -> Bool {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    return ["- ", "* ", "+ "].contains { trimmed.hasPrefix($0) }
}

private func surfAceMarkdownIsOrderedListItem(_ line: String) -> Bool {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    guard let dot = trimmed.firstIndex(of: ".") else { return false }
    return trimmed[..<dot].allSatisfy(\.isNumber) && trimmed[trimmed.index(after: dot)...].hasPrefix(" ")
}

private func surfAceMarkdownListItemText(_ line: String) -> String {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    if surfAceMarkdownIsUnorderedListItem(trimmed) {
        return String(trimmed.dropFirst(2))
    }
    guard let dot = trimmed.firstIndex(of: ".") else { return trimmed }
    return String(trimmed[trimmed.index(dot, offsetBy: 2)...])
}

private func surfAceMarkdownStripBlockquote(_ line: String) -> String {
    var trimmed = line.trimmingCharacters(in: .whitespaces)
    if trimmed.hasPrefix(">") {
        trimmed.removeFirst()
    }
    if trimmed.hasPrefix(" ") {
        trimmed.removeFirst()
    }
    return trimmed
}

private func surfAceMarkdownIsTableDivider(_ line: String) -> Bool {
    let cells = surfAceMarkdownTableCells(line)
    return cells.count > 1 && cells.allSatisfy { cell in
        let trimmed = cell.trimmingCharacters(in: .whitespaces)
        let stripped = trimmed.replacingOccurrences(of: ":", with: "")
        return stripped.count >= 3 && stripped.allSatisfy { $0 == "-" }
    }
}

private func surfAceMarkdownTableCells(_ line: String) -> [String] {
    var trimmed = line.trimmingCharacters(in: .whitespaces)
    if trimmed.hasPrefix("|") {
        trimmed.removeFirst()
    }
    if trimmed.hasSuffix("|") {
        trimmed.removeLast()
    }
    return trimmed.split(separator: "|", omittingEmptySubsequences: false)
        .map { $0.trimmingCharacters(in: .whitespaces) }
}

private func surfAceMarkdownStartsBlock(lines: [String], index: Int) -> Bool {
    let line = lines[index]
    return line.trimmingCharacters(in: .whitespaces).isEmpty ||
        surfAceMarkdownIsFence(line) ||
        surfAceMarkdownHeading(line).level > 0 ||
        surfAceMarkdownIsUnorderedListItem(line) ||
        surfAceMarkdownIsOrderedListItem(line) ||
        line.trimmingCharacters(in: .whitespaces).hasPrefix(">") ||
        (index + 1 < lines.count && line.contains("|") && surfAceMarkdownIsTableDivider(lines[index + 1]))
}

private enum SurfAceChromeFont {
    static let regularName = "Rajdhani-Regular"
    static let boldName = "Rajdhani-Bold"
}

private enum SurfAceRajdhaniMetrics {
    static let paneNumberTrackingRatio: CGFloat = -0.04
    static let windowTextRatio: CGFloat = 0.28
    static let windowBoxHeightRatio: CGFloat = 0.4
    static let windowBoxPaddingRatio: CGFloat = 0.025
    static let windowTrackingRatio: CGFloat = -0.02
    static let identitySpacingRatio: CGFloat = 0.04
}

private enum SurfAceSpatialIdentityLayout {
    static let depthOffset: CGFloat = 56
    static let edgeInset = SurfAcePaneChromeLayout.bottomInset
    static let bundleIdentifier = "co.clicketyclacks.SurfAce.spatial"
}

private enum SurfAceSpatialChromeDepthLayout {
    static let depthOffset: CGFloat = 0
}

func surfAceSpatialIdentityDepthOffsetValue() -> CGFloat {
    SurfAceSpatialIdentityLayout.depthOffset
}

func surfAceSpatialChromeDepthOffsetValue() -> CGFloat {
    SurfAceSpatialChromeDepthLayout.depthOffset
}

func surfAcePaneIdentityChromeInset(bundleIdentifier: String? = Bundle.main.bundleIdentifier) -> CGFloat {
    if bundleIdentifier == SurfAceSpatialIdentityLayout.bundleIdentifier {
        return SurfAceSpatialIdentityLayout.edgeInset
    }
    return SurfAcePaneChromeLayout.bottomInset
}

private enum SurfAceIdentityBaseline: AlignmentID {
    static func defaultValue(in context: ViewDimensions) -> CGFloat {
        context[.bottom]
    }
}

private extension VerticalAlignment {
    static let surfAceIdentityBaseline = VerticalAlignment(SurfAceIdentityBaseline.self)
}

struct SurfAceRootView: View {
    @Bindable var runtime: SurfAceRuntime
    @Environment(\.displayScale) private var displayScale
    @State private var sceneKey: String?
    @State private var surfaceId: String?

    var body: some View {
        ZStack {
            if let surface {
                SurfAceWindowView(runtime: runtime, surface: surface)
                    .onAppear {
                        runtime.updateViewport(surfaceId: surface.surfaceId, size: surface.viewportSize, scale: displayScale)
                    }
            } else {
                Color.black
                    .overlay {
                        ProgressView()
                            .tint(.white)
                    }
            }
        }
        .ignoresSafeArea(.container, edges: surfAceRootContentIgnoredSafeAreaEdges())
        .background {
            SurfAceSceneProbeRepresentable(
                onConnect: { key, scene in
                    Task { @MainActor in
                        sceneKey = key
                        let surface = runtime.registerSurface(sceneKey: key, scene: scene)
                        surfaceId = surface.surfaceId
                    }
                }
            )
        }
    }

    private var surface: SurfAceSurfaceModel? {
        guard let surfaceId else { return nil }
        return runtime.surfaces.first { $0.surfaceId == surfaceId }
    }
}

private struct SurfAceWindowView: View {
    let runtime: SurfAceRuntime
    @Bindable var surface: SurfAceSurfaceModel
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        GeometryReader { proxy in
            let surfaceBounds = CGRect(origin: .zero, size: proxy.size)
            ZStack {
                SurfAcePaneTreeView(runtime: runtime, surface: surface, node: surface.paneLayout, surfaceBounds: surfaceBounds)
                    .background(surfAceSurfaceBackdropColor())
                    .coordinateSpace(name: surfAceSurfaceCoordinateSpaceName)
                    .onAppear {
                        runtime.updateViewport(surfaceId: surface.surfaceId, size: proxy.size, scale: displayScale)
                    }
                    .onChange(of: proxy.size) { _, newSize in
                        runtime.updateViewport(surfaceId: surface.surfaceId, size: newSize, scale: displayScale)
                    }
            }
        }
    }
}

private struct SurfAcePaneTreeView: View {
    let runtime: SurfAceRuntime
    @Bindable var surface: SurfAceSurfaceModel
    let node: SurfAcePaneLayoutNode
    let surfaceBounds: CGRect
    var path: [Int] = []

    var body: some View {
        switch node {
        case .empty:
            surfAceSurfaceBackdropColor()
        case .leaf(let paneId, _):
            if let pane = surface.panesById[paneId] {
                SurfAcePaneView(runtime: runtime, surface: surface, pane: pane, surfaceBounds: surfaceBounds)
            } else {
                Color.clear
            }
        case .split(let direction, let children, _):
            GeometryReader { proxy in
                let totalWeight = max(children.reduce(0) { $0 + $1.layoutWeight }, 1)
                if direction == .vertical {
                    ZStack(alignment: .topLeading) {
                        HStack(spacing: 0) {
                            ForEach(Array(children.enumerated()), id: \.offset) { index, child in
                                SurfAcePaneTreeView(runtime: runtime, surface: surface, node: child, surfaceBounds: surfaceBounds, path: path + [index])
                                    .frame(width: max(1, proxy.size.width * child.layoutWeight / totalWeight), height: proxy.size.height)
                            }
                        }
                        ForEach(Array(children.indices.dropLast()), id: \.self) { index in
                            let offset = proxy.size.width * children.prefix(index + 1).reduce(0) { $0 + $1.layoutWeight } / totalWeight
                            SurfAceSplitResizeHandle(
                                direction: direction,
                                weights: children.map(\.layoutWeight),
                                childIndex: index,
                                extent: proxy.size.width
                            ) { weights in
                                runtime.resizeSplit(surfaceId: surface.surfaceId, path: path, weights: weights)
                            }
                            .position(x: offset, y: proxy.size.height / 2)
                        }
                    }
                } else {
                    ZStack(alignment: .topLeading) {
                        VStack(spacing: 0) {
                            ForEach(Array(children.enumerated()), id: \.offset) { index, child in
                                SurfAcePaneTreeView(runtime: runtime, surface: surface, node: child, surfaceBounds: surfaceBounds, path: path + [index])
                                    .frame(width: proxy.size.width, height: max(1, proxy.size.height * child.layoutWeight / totalWeight))
                            }
                        }
                        ForEach(Array(children.indices.dropLast()), id: \.self) { index in
                            let offset = proxy.size.height * children.prefix(index + 1).reduce(0) { $0 + $1.layoutWeight } / totalWeight
                            SurfAceSplitResizeHandle(
                                direction: direction,
                                weights: children.map(\.layoutWeight),
                                childIndex: index,
                                extent: proxy.size.height
                            ) { weights in
                                runtime.resizeSplit(surfaceId: surface.surfaceId, path: path, weights: weights)
                            }
                            .position(x: proxy.size.width / 2, y: offset)
                        }
                    }
                }
            }
            .background(surfAceSplitBackdropColor())
        }
    }
}

private struct SurfAceSplitResizeHandle: View {
    let direction: SurfAceLayoutDirection
    let weights: [Double]
    let childIndex: Int
    let extent: CGFloat
    let onResize: ([Double]) -> Void
    @State private var dragStartLocation: CGFloat?
    @State private var dragStartWeights: [Double]?

    var body: some View {
        Image(systemName: "line.3.horizontal")
            .font(.system(size: SurfAceSplitHandleLayout.iconSize, weight: .semibold))
            .foregroundStyle(.white.opacity(0.86))
            .rotationEffect(direction == .vertical ? .degrees(90) : .zero)
            .frame(width: SurfAceSplitHandleLayout.visibleSize, height: SurfAceSplitHandleLayout.visibleSize)
            .background {
                Circle()
                    .fill(.regularMaterial)
            }
            .overlay {
                Circle()
                    .stroke(.white.opacity(0.18), lineWidth: 1)
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0, coordinateSpace: .global)
                    .onChanged { value in
                        let startLocation = dragStartLocation ?? axisLocation(value.startLocation)
                        let startWeights = dragStartWeights ?? weights
                        dragStartLocation = startLocation
                        dragStartWeights = startWeights
                        onResize(resizedWeights(from: startWeights, startLocation: startLocation, currentLocation: axisLocation(value.location)))
                    }
                    .onEnded { _ in
                        dragStartLocation = nil
                        dragStartWeights = nil
                    }
            )
    }

    private func axisLocation(_ point: CGPoint) -> CGFloat {
        direction == .vertical ? point.x : point.y
    }

    private func resizedWeights(from startWeights: [Double], startLocation: CGFloat, currentLocation: CGFloat) -> [Double] {
        guard extent > 0,
              childIndex >= 0,
              childIndex + 1 < startWeights.count else {
            return weights
        }
        let totalWeight = max(startWeights.reduce(0, +), 1)
        let before = startWeights[childIndex]
        let after = startWeights[childIndex + 1]
        let pairTotal = before + after
        let minimumWeight = min(max(0.05, totalWeight * 0.05), pairTotal / 2)
        let deltaWeight = Double((currentLocation - startLocation) / extent) * totalWeight
        let nextBefore = min(max(minimumWeight, before + deltaWeight), max(minimumWeight, pairTotal - minimumWeight))
        var nextWeights = startWeights
        nextWeights[childIndex] = nextBefore
        nextWeights[childIndex + 1] = max(minimumWeight, pairTotal - nextBefore)
        return nextWeights
    }
}

private struct SurfAcePaneView: View {
    let runtime: SurfAceRuntime
    @Bindable var surface: SurfAceSurfaceModel
    @Bindable var pane: SurfAcePaneModel
    let surfaceBounds: CGRect

    var body: some View {
        GeometryReader { proxy in
            let paneFrame = proxy.frame(in: .named(surfAceSurfaceCoordinateSpaceName))
            let showsSpatialEmptyPaneChrome = surfAceShowsSpatialEmptyPaneChrome(entry: pane.currentEntry)
            ZStack {
                ZStack {
                    ZStack {
                        SurfAcePaneRepresentable(
                            runtime: runtime,
                            surfaceId: surface.surfaceId,
                            paneId: pane.paneId
                        )
                        .id("\(surface.surfaceId):\(pane.paneId)")
                        .background(surfAcePaneBackdropColor(isEmpty: showsSpatialEmptyPaneChrome))

                        if showsSpatialEmptyPaneChrome {
                            SurfAceSpatialEmptyPaneFill()
                        }
                    }
                    .surfAceSpatialWindowContentClip(paneFrame: paneFrame, surfaceBounds: surfaceBounds)

                    let identity = surfAcePaneChromeIdentityParts(surface: surface, pane: pane)
                    SurfAcePaneIdentityOverlay(
                        displayId: identity.displayId,
                        windowLabel: identity.windowLabel,
                        paneSize: proxy.size,
                        connectionState: surface.connectionBarState
                    )
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                    .padding(.trailing, surfAcePaneIdentityChromeInset())
                    .padding(.bottom, surfAcePaneIdentityChromeInset())
                    .surfAceSpatialIdentityDepthOffset()
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)

                    if !showsSpatialEmptyPaneChrome, let toast = pane.toast {
                        VStack {
                            Spacer()
                            Text(toast)
                                .font(.custom(SurfAceChromeFont.regularName, size: 13))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 14)
                                .padding(.vertical, 8)
                                .background(.black.opacity(0.74), in: Capsule())
                                .padding(.bottom, 96)
                        }
                        .onAppear {
                            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                                runtime.clearToast(surfaceId: surface.surfaceId, paneId: pane.paneId)
                            }
                        }
                    }

                    if !showsSpatialEmptyPaneChrome {
                        VStack {
                            Spacer()
                            SurfAcePaneControls(runtime: runtime, surface: surface, pane: pane)
                                .padding(.bottom, SurfAcePaneChromeLayout.bottomInset)
                                .surfAceSpatialChromeDepthOffset()
                        }
                    }
                }
                .overlay {
                    SurfAceAnnotationBorder(
                        active: !showsSpatialEmptyPaneChrome && surfAceShowsAnnotationBorder(annotationMode: pane.annotationMode),
                        pulsing: pane.isDrawingFlushSending
                    )
                }
                .overlay {
                    SurfAceKeyboardActiveBorder(
                        active: !showsSpatialEmptyPaneChrome && surfAceShowsKeyboardFocusOutline(
                            activePaneId: surface.activeKeyboardPaneId,
                            paneId: pane.paneId,
                            paneCount: surface.panes.count
                        )
                    )
                        .allowsHitTesting(false)
                        .zIndex(10_000)
                }
                .clipped()

                if showsSpatialEmptyPaneChrome {
                    SurfAceSpatialEmptyPaneMarkers()
                        .zIndex(1)
                }
            }
            .onChange(of: proxy.size) { _, newSize in
                pane.lastMeasuredSize = newSize
            }
            .onAppear {
                publishGeometrySnapshot(paneFrame: paneFrame)
            }
            .onChange(of: paneFrame) { _, newFrame in
                publishGeometrySnapshot(paneFrame: newFrame)
            }
            .onChange(of: surface.surfaceEpoch) { _, _ in
                publishGeometrySnapshot(paneFrame: paneFrame)
            }
            .onChange(of: surface.topologyEpoch) { _, _ in
                publishGeometrySnapshot(paneFrame: paneFrame)
            }
        }
        .contentShape(Rectangle())
        .simultaneousGesture(
            TapGesture().onEnded {
                runtime.activateKeyboardPane(surfaceId: surface.surfaceId, paneId: pane.paneId)
            }
        )
    }

    private func publishGeometrySnapshot(paneFrame: CGRect) {
        runtime.updatePaneGeometrySnapshot(
            surfaceId: surface.surfaceId,
            paneId: pane.paneId,
            paneFrame: paneFrame,
            contentViewport: paneFrame,
            splitSpacing: surfAcePaneSplitSpacing
        )
    }
}

func surfAceShowsKeyboardFocusOutline(activePaneId: Int?, paneId: Int, paneCount: Int) -> Bool {
    paneCount > 1 && activePaneId == paneId
}

func surfAceShowsAnnotationBorder(annotationMode: Bool) -> Bool {
    annotationMode
}

func surfAceKeyboardFocusBandWidth() -> CGFloat {
    20
}

func surfAceShowsSpatialEmptyPaneChrome(entry: SurfAcePaneEntry) -> Bool {
#if os(visionOS)
    surfAceEntryIsVisibleEmpty(entry)
#else
    false
#endif
}

private func surfAceSurfaceBackdropColor() -> Color {
#if os(visionOS)
    Color.clear
#else
    Color.black.opacity(0.94)
#endif
}

private func surfAcePaneBackdropColor(isEmpty: Bool) -> Color {
#if os(visionOS)
    isEmpty ? Color.clear : Color.black.opacity(0.92)
#else
    Color.black.opacity(0.92)
#endif
}

private func surfAceSplitBackdropColor() -> Color {
#if os(visionOS)
    Color.clear
#else
    Color.white.opacity(0.12)
#endif
}

struct SurfAceSpatialWindowContentCorners: Equatable {
    let topLeading: Bool
    let topTrailing: Bool
    let bottomLeading: Bool
    let bottomTrailing: Bool

    var uiRectCorners: UIRectCorner {
        var corners: UIRectCorner = []
        if topLeading {
            corners.insert(.topLeft)
        }
        if topTrailing {
            corners.insert(.topRight)
        }
        if bottomLeading {
            corners.insert(.bottomLeft)
        }
        if bottomTrailing {
            corners.insert(.bottomRight)
        }
        return corners
    }
}

enum SurfAceSpatialPaneChromeCorner: CaseIterable {
    case topLeading
    case topTrailing
    case bottomLeading
    case bottomTrailing
}

func surfAceSpatialWindowContentCorners(
    paneFrame: CGRect,
    surfaceBounds: CGRect,
    tolerance: CGFloat
) -> SurfAceSpatialWindowContentCorners {
    let touchesLeading = abs(paneFrame.minX - surfaceBounds.minX) <= tolerance
    let touchesTrailing = abs(paneFrame.maxX - surfaceBounds.maxX) <= tolerance
    let touchesTop = abs(paneFrame.minY - surfaceBounds.minY) <= tolerance
    let touchesBottom = abs(paneFrame.maxY - surfaceBounds.maxY) <= tolerance

    return SurfAceSpatialWindowContentCorners(
        topLeading: touchesTop && touchesLeading,
        topTrailing: touchesTop && touchesTrailing,
        bottomLeading: touchesBottom && touchesLeading,
        bottomTrailing: touchesBottom && touchesTrailing
    )
}

private struct SurfAceSpatialWindowContentClipShape: Shape {
    let corners: SurfAceSpatialWindowContentCorners
    let cornerRadius: CGFloat

    func path(in rect: CGRect) -> Path {
        let radius = max(0, min(cornerRadius, rect.width / 2, rect.height / 2))
        guard radius > 0, !corners.uiRectCorners.isEmpty else {
            return Path(rect)
        }
        return Path(UIBezierPath(
            roundedRect: rect,
            byRoundingCorners: corners.uiRectCorners,
            cornerRadii: CGSize(width: radius, height: radius)
        ).cgPath)
    }
}

private struct SurfAceSpatialEmptyPaneFill: View {
    var body: some View {
        Canvas { context, size in
            drawFill(in: &context, size: size)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func drawFill(in context: inout GraphicsContext, size: CGSize) {
        let inset = SurfAceSpatialPaneChromeLayout.cornerInset + SurfAceSpatialPaneChromeLayout.lineWidth / 2
        let rect = CGRect(
            x: inset,
            y: inset,
            width: size.width - inset * 2,
            height: size.height - inset * 2
        )
        guard rect.width > 0, rect.height > 0 else { return }

        context.fill(
            Path(roundedRect: rect, cornerRadius: SurfAceSpatialPaneChromeLayout.cornerRadius),
            with: .color(.white.opacity(SurfAceSpatialPaneChromeLayout.fillOpacity))
        )
    }
}

private struct SurfAceSpatialEmptyPaneMarkers: View {
    var body: some View {
        GeometryReader { proxy in
            let contentSize = proxy.size
            let chromeOutset = SurfAceSpatialPaneChromeLayout.outwardOffset

            Canvas { context, _ in
                context.translateBy(x: chromeOutset, y: chromeOutset)

                let markerSize = SurfAceSpatialPaneChromeLayout.cornerInset
                    + SurfAceSpatialPaneChromeLayout.cornerRadius
                    + SurfAceSpatialPaneChromeLayout.lineWidth
                drawCorner(in: &context, size: contentSize, markerSize: markerSize, corner: .topLeading)
                drawCorner(in: &context, size: contentSize, markerSize: markerSize, corner: .topTrailing)
                drawCorner(in: &context, size: contentSize, markerSize: markerSize, corner: .bottomLeading)
                drawCorner(in: &context, size: contentSize, markerSize: markerSize, corner: .bottomTrailing)
            }
            .frame(width: contentSize.width + chromeOutset * 2, height: contentSize.height + chromeOutset * 2)
            .offset(x: -chromeOutset, y: -chromeOutset)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func drawCorner(in context: inout GraphicsContext, size: CGSize, markerSize: CGFloat, corner: SurfAceSpatialPaneChromeCorner) {
        guard let frame = surfAceSpatialEmptyPaneMarkerFrame(
            size: size,
            markerSize: markerSize,
            cornerInset: SurfAceSpatialPaneChromeLayout.cornerInset,
            outwardOffset: SurfAceSpatialPaneChromeLayout.outwardOffset,
            lineWidth: SurfAceSpatialPaneChromeLayout.lineWidth,
            corner: corner
        ) else { return }

        var path = cornerPath(size: frame.size, corner: corner)
        path = path.applying(CGAffineTransform(translationX: frame.minX, y: frame.minY))
        context.stroke(
            path,
            with: .color(.white.opacity(SurfAceSpatialPaneChromeLayout.opacity)),
            style: StrokeStyle(
                lineWidth: SurfAceSpatialPaneChromeLayout.lineWidth,
                lineCap: .round,
                lineJoin: .round
            )
        )
    }

    private func cornerPath(size: CGSize, corner: SurfAceSpatialPaneChromeCorner) -> Path {
        var path = Path()
        let strokeInset = SurfAceSpatialPaneChromeLayout.lineWidth / 2
        let minX = strokeInset
        let maxX = size.width - strokeInset
        let minY = strokeInset
        let maxY = size.height - strokeInset
        let radius = min(SurfAceSpatialPaneChromeLayout.cornerRadius, size.width - SurfAceSpatialPaneChromeLayout.lineWidth, size.height - SurfAceSpatialPaneChromeLayout.lineWidth)
        let trim = SurfAceSpatialPaneChromeLayout.endpointTrimDegrees

        switch corner {
        case .topLeading:
            path.addArc(
                center: CGPoint(x: minX + radius, y: minY + radius),
                radius: radius,
                startAngle: .degrees(180 + trim),
                endAngle: .degrees(270 - trim),
                clockwise: false
            )
        case .topTrailing:
            path.addArc(
                center: CGPoint(x: maxX - radius, y: minY + radius),
                radius: radius,
                startAngle: .degrees(360 - trim),
                endAngle: .degrees(270 + trim),
                clockwise: true
            )
        case .bottomLeading:
            path.addArc(
                center: CGPoint(x: minX + radius, y: maxY - radius),
                radius: radius,
                startAngle: .degrees(180 - trim),
                endAngle: .degrees(90 + trim),
                clockwise: true
            )
        case .bottomTrailing:
            path.addArc(
                center: CGPoint(x: maxX - radius, y: maxY - radius),
                radius: radius,
                startAngle: .degrees(trim),
                endAngle: .degrees(90 - trim),
                clockwise: false
            )
        }

        return path
    }
}

func surfAceSpatialEmptyPaneMarkerFrame(
    size: CGSize,
    markerSize: CGFloat,
    cornerInset: CGFloat,
    outwardOffset: CGFloat,
    lineWidth: CGFloat,
    corner: SurfAceSpatialPaneChromeCorner
) -> CGRect? {
    let width = min(markerSize, size.width)
    let height = min(markerSize, size.height)
    guard width > lineWidth, height > lineWidth else { return nil }

    let inset = min(cornerInset, max(0, min(size.width - width, size.height - height)))
    let minimumVisibleSpan = min(SurfAceSpatialPaneChromeLayout.minimumVisibleMarkerSpan, min(width, height))
    let offset = min(outwardOffset, max(0, inset + min(width, height) - minimumVisibleSpan))
    let leadingX = inset - offset
    let trailingX = size.width - width - inset + offset
    let topY = inset - offset
    let bottomY = size.height - height - inset + offset

    return CGRect(
        x: corner == .topLeading || corner == .bottomLeading ? leadingX : trailingX,
        y: corner == .topLeading || corner == .topTrailing ? topY : bottomY,
        width: width,
        height: height
    )
}

struct SurfAcePaneChromeIdentityParts: Equatable {
    let displayId: String
    let windowLabel: String
}

@MainActor
func surfAcePaneChromeIdentityParts(surface: SurfAceSurfaceModel, pane: SurfAcePaneModel) -> SurfAcePaneChromeIdentityParts {
    SurfAcePaneChromeIdentityParts(
        displayId: pane.displayId(windowLabel: surface.windowLabel),
        windowLabel: surface.windowLabel
    )
}

private struct SurfAcePaneIdentityOverlay: View {
    let displayId: String
    let windowLabel: String
    let paneSize: CGSize
    let connectionState: SurfAceConnectionBarState

    private var fontSize: CGFloat {
        max(1, min(paneSize.width, paneSize.height) / 4)
    }

    var body: some View {
        if connectionState == .connected {
            HStack(alignment: .surfAceIdentityBaseline, spacing: fontSize * SurfAceRajdhaniMetrics.identitySpacingRatio) {
                if !windowLabel.isEmpty {
                    Text(windowLabel.uppercased())
                        .font(.custom(SurfAceChromeFont.regularName, size: fontSize * SurfAceRajdhaniMetrics.windowTextRatio))
                        .foregroundStyle(connectionColor.opacity(0.35))
                        .lineLimit(1)
                        .tracking(fontSize * SurfAceRajdhaniMetrics.windowTextRatio * SurfAceRajdhaniMetrics.windowTrackingRatio)
                        .padding(.horizontal, fontSize * SurfAceRajdhaniMetrics.windowBoxPaddingRatio)
                        .frame(minWidth: fontSize * SurfAceRajdhaniMetrics.windowBoxHeightRatio)
                        .frame(height: fontSize * SurfAceRajdhaniMetrics.windowBoxHeightRatio)
                        .overlay {
                            RoundedRectangle(cornerRadius: fontSize * 0.04, style: .continuous)
                                .strokeBorder(connectionColor.opacity(0.35), lineWidth: max(1, fontSize * 0.008))
                        }
                        .alignmentGuide(.surfAceIdentityBaseline) { dimensions in dimensions[.bottom] }
                }

                SurfAcePaneNumberText(paneLabel: displayId.uppercased(), fontSize: fontSize)
                    .lineLimit(1)
                    .minimumScaleFactor(0.35)
                    .alignmentGuide(.surfAceIdentityBaseline) { dimensions in dimensions[.lastTextBaseline] }
            }
            .alignmentGuide(.bottom) { dimensions in dimensions[.surfAceIdentityBaseline] }
        }
    }

    private var connectionColor: Color {
        switch connectionState {
        case .connected:
            return Color(red: 0.13, green: 0.77, blue: 0.37)
        case .connecting:
            return Color(red: 0.96, green: 0.65, blue: 0.04)
        case .disconnected:
            return Color(red: 0.94, green: 0.27, blue: 0.27)
        }
    }
}

private extension View {
    @ViewBuilder
    func surfAceSpatialWindowContentClip(paneFrame: CGRect, surfaceBounds: CGRect) -> some View {
        #if os(visionOS)
        self.clipShape(SurfAceSpatialWindowContentClipShape(
            corners: surfAceSpatialWindowContentCorners(
                paneFrame: paneFrame,
                surfaceBounds: surfaceBounds,
                tolerance: SurfAceSpatialWindowContentLayout.edgeTolerance
            ),
            cornerRadius: SurfAceSpatialWindowContentLayout.cornerRadius
        ))
        #else
        self
        #endif
    }

    @ViewBuilder
    func surfAceSpatialIdentityDepthOffset() -> some View {
        #if os(visionOS)
        if Bundle.main.bundleIdentifier == SurfAceSpatialIdentityLayout.bundleIdentifier {
            self.offset(z: SurfAceSpatialIdentityLayout.depthOffset)
        } else {
            self
        }
        #else
        self
        #endif
    }

    @ViewBuilder
    func surfAceSpatialChromeDepthOffset() -> some View {
        #if os(visionOS)
        if Bundle.main.bundleIdentifier == SurfAceSpatialIdentityLayout.bundleIdentifier {
            self.offset(z: SurfAceSpatialChromeDepthLayout.depthOffset)
        } else {
            self
        }
        #else
        self
        #endif
    }
}

private struct SurfAcePaneControls: View {
    let runtime: SurfAceRuntime
    @Bindable var surface: SurfAceSurfaceModel
    @Bindable var pane: SurfAcePaneModel
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        HStack(spacing: 10) {
            if pane.drawingRestoreWarningVisible {
                SurfAceWarningIndicator()
            }

            if hasNavigationContext && (ownerName != nil || pane.canGoBack || pane.canGoForward || pane.canReload) {
                HStack(spacing: 6) {
                    if pane.canReload {
                        Button {
                            runtime.reloadPane(surfaceId: surface.surfaceId, paneId: pane.paneId)
                        } label: {
                            Image(systemName: "arrow.clockwise")
                        }
                        .buttonStyle(SurfAceGlassButtonStyle())
                    }

                    if pane.canGoBack {
                        Button {
                            runtime.navigateHistory(
                                surfaceId: surface.surfaceId,
                                paneId: pane.paneId,
                                direction: .back
                            )
                        } label: {
                            Image(systemName: "chevron.backward")
                        }
                        .buttonStyle(SurfAceGlassButtonStyle())
                    }

                    if pane.canGoForward {
                        Button {
                            runtime.navigateHistory(
                                surfaceId: surface.surfaceId,
                                paneId: pane.paneId,
                                direction: .forward
                            )
                        } label: {
                            Image(systemName: "chevron.forward")
                        }
                        .buttonStyle(SurfAceGlassButtonStyle())
                    }

                    if let ownerName {
                        Text(ownerName)
                            .font(.custom(SurfAceChromeFont.regularName, size: 16))
                            .foregroundStyle(surfAceToolbarForegroundColor(for: colorScheme).opacity(0.86))
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .padding(.leading, 4)
                            .padding(.trailing, 10)
                    }
                }
                .surfAceControlPillChrome()
            }

            HStack(spacing: 6) {
                Button {
                    runtime.setAnnotationMode(
                        surfaceId: surface.surfaceId,
                        paneId: pane.paneId,
                        enabled: true,
                        fingerDrawEnabled: pane.annotationMode ? !pane.fingerDrawEnabled : true
                    )
                } label: {
                    Image(systemName: "hand.draw")
                }
                .buttonStyle(SurfAceGlassButtonStyle())

                if pane.annotationMode {
                    Button("Done") {
                        runtime.setAnnotationMode(
                            surfaceId: surface.surfaceId,
                            paneId: pane.paneId,
                            enabled: false,
                            fingerDrawEnabled: false
                        )
                    }
                    .buttonStyle(SurfAceGlassButtonStyle())
                }
            }
            .surfAceControlPillChrome()
        }
    }

    private var ownerName: String? {
        pane.currentProvenanceDisplayName()
    }

    private var hasNavigationContext: Bool {
        pane.currentEntry.contentId != nil || pane.currentEntry.payload != nil || pane.canGoBack || pane.canGoForward || pane.canReload
    }
}

private struct SurfAceWarningIndicator: View {
    var body: some View {
        Image(systemName: "exclamationmark.triangle.fill")
            .font(.custom(SurfAceChromeFont.regularName, size: 18))
            .foregroundStyle(Color.yellow)
            .frame(minWidth: 44, minHeight: 44)
            .padding(.horizontal, 10)
            .background(.black.opacity(0.58), in: Capsule())
            .accessibilityLabel("Drawing restore warning")
    }
}

private struct SurfAceGlassButtonStyle: ButtonStyle {
    @Environment(\.colorScheme) private var colorScheme

    func makeBody(configuration: Configuration) -> some View {
        let foregroundColor = surfAceToolbarForegroundColor(for: colorScheme)

        configuration.label
            .font(.custom(SurfAceChromeFont.regularName, size: 18))
            .foregroundStyle(foregroundColor)
            .frame(minWidth: 44, minHeight: 44)
            .padding(.horizontal, 10)
            .surfAceGlassBackground(interactive: true)
            .overlay {
                Capsule()
                    .strokeBorder(foregroundColor.opacity(configuration.isPressed ? 0.32 : 0.18), lineWidth: 1)
            }
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

func surfAceToolbarForegroundColor(for colorScheme: ColorScheme) -> Color {
    colorScheme == .dark ? .white : .black
}

func surfAceToolbarChromeStrokeColor(for colorScheme: ColorScheme) -> Color {
    surfAceToolbarForegroundColor(for: colorScheme).opacity(0.18)
}

private struct SurfAceControlPillChrome: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme

    func body(content: Content) -> some View {
        content
            .padding(6)
            .surfAceGlassBackground(interactive: false)
            .overlay {
                Capsule()
                    .strokeBorder(surfAceToolbarChromeStrokeColor(for: colorScheme), lineWidth: 1)
            }
    }
}

private extension View {
    func surfAceControlPillChrome() -> some View {
        modifier(SurfAceControlPillChrome())
    }

    @ViewBuilder
    func surfAceGlassBackground(interactive: Bool) -> some View {
        #if os(visionOS)
        self.background(.regularMaterial, in: Capsule())
        #else
        if interactive {
            self.glassEffect(.regular.interactive(), in: Capsule())
        } else {
            self.glassEffect(.regular, in: Capsule())
        }
        #endif
    }
}

private struct SurfAceAnnotationBorder: View {
    let active: Bool
    let pulsing: Bool
    @State private var animatePulse = false

    var body: some View {
        RoundedRectangle(cornerRadius: 0, style: .continuous)
            .strokeBorder(Color.orange.opacity(active ? (pulsing && animatePulse ? 0.42 : 0.95) : 0), lineWidth: 2)
            .animation(.easeInOut(duration: 0.2), value: active)
            .onAppear {
                animatePulse = pulsing
            }
            .onChange(of: pulsing) { _, newValue in
                if newValue {
                    withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) {
                        animatePulse = true
                    }
                } else {
                    animatePulse = false
                }
            }
    }
}

private struct SurfAceKeyboardActiveBorder: View {
    let active: Bool

    var body: some View {
        let edgeColor = Color(red: 0.5, green: 0.5, blue: 0.5).opacity(active ? 0.25 : 0)
        let clearColor = Color(red: 0.5, green: 0.5, blue: 0.5).opacity(0)
        let bandWidth = surfAceKeyboardFocusBandWidth()

        ZStack {
            VStack(spacing: 0) {
                LinearGradient(colors: [edgeColor, clearColor], startPoint: .top, endPoint: .bottom)
                    .frame(height: bandWidth)
                Spacer(minLength: 0)
                LinearGradient(colors: [clearColor, edgeColor], startPoint: .top, endPoint: .bottom)
                    .frame(height: bandWidth)
            }

            HStack(spacing: 0) {
                LinearGradient(colors: [edgeColor, clearColor], startPoint: .leading, endPoint: .trailing)
                    .frame(width: bandWidth)
                Spacer(minLength: 0)
                LinearGradient(colors: [clearColor, edgeColor], startPoint: .leading, endPoint: .trailing)
                    .frame(width: bandWidth)
            }
        }
        .allowsHitTesting(false)
        .animation(.easeOut(duration: 0.12), value: active)
    }
}

private struct SurfAcePaneNumberText: View {
    let paneLabel: String
    let fontSize: CGFloat

    var body: some View {
        paneNumberText
    }

    private var paneNumberText: some View {
        Text(paneLabel)
            .font(.custom(SurfAceChromeFont.boldName, size: fontSize))
            .monospacedDigit()
            .tracking(fontSize * SurfAceRajdhaniMetrics.paneNumberTrackingRatio)
            .foregroundStyle(Color(red: 0.5, green: 0.5, blue: 0.5).opacity(0.3))
    }
}

private struct SurfAcePaneRepresentable: UIViewRepresentable {
    let runtime: SurfAceRuntime
    let surfaceId: String
    let paneId: Int

    func makeCoordinator() -> Coordinator {
        Coordinator(runtime: runtime, surfaceId: surfaceId, paneId: paneId)
    }

    func makeUIView(context: Context) -> SurfAceSurfaceHostView {
        let view = SurfAceSurfaceHostView()
        context.coordinator.attach(hostView: view)
        runtime.attachPaneBridge(surfaceId: surfaceId, paneId: paneId, bridge: context.coordinator)
        return view
    }

    func updateUIView(_ uiView: SurfAceSurfaceHostView, context: Context) {
        context.coordinator.updateBinding(surfaceId: surfaceId, paneId: paneId, hostView: uiView)
    }

    static func dismantleUIView(_ uiView: SurfAceSurfaceHostView, coordinator: Coordinator) {
        coordinator.detach()
    }

    @MainActor
    final class Coordinator: NSObject, SurfAcePaneBridging {
        private weak var hostView: SurfAceSurfaceHostView?
        private let runtime: SurfAceRuntime
        private var surfaceId: String
        private var paneId: Int

        init(runtime: SurfAceRuntime, surfaceId: String, paneId: Int) {
            self.runtime = runtime
            self.surfaceId = surfaceId
            self.paneId = paneId
        }

        func attach(hostView: SurfAceSurfaceHostView) {
            self.hostView = hostView
            hostView.onInteractionBegan = { [weak self] in
                guard let self else { return }
                self.runtime.activateKeyboardPane(surfaceId: self.surfaceId, paneId: self.paneId)
            }
            hostView.onPencilContact = { [weak self] in
                guard let self else { return }
                self.runtime.handlePencilContact(surfaceId: self.surfaceId, paneId: self.paneId)
            }
            hostView.onSelectionChanged = { [weak self] text, rect in
                guard let self else { return }
                self.runtime.handleSelectionChanged(surfaceId: self.surfaceId, paneId: self.paneId, text: text, rect: rect)
            }
            hostView.onScrollSettled = { [weak self] viewport, visibleText in
                guard let self else { return }
                self.runtime.handleScrollSettled(surfaceId: self.surfaceId, paneId: self.paneId, viewport: viewport, visibleText: visibleText)
            }
            hostView.onTapEvent = { [weak self] kind, position, nearestContent in
                guard let self else { return }
                self.runtime.handleTapEvent(surfaceId: self.surfaceId, paneId: self.paneId, kind: kind, position: position, nearestContent: nearestContent)
            }
            hostView.onNavigationEvent = { [weak self] url, sentAt in
                guard let self else { return }
                self.runtime.handleNavigationEvent(surfaceId: self.surfaceId, paneId: self.paneId, url: url, sentAt: sentAt)
            }
            hostView.onPDFPageChanged = { [weak self] page, totalPages, pageText in
                guard let self else { return }
                self.runtime.handlePDFPageChanged(
                    surfaceId: self.surfaceId,
                    paneId: self.paneId,
                    page: page,
                    totalPages: totalPages,
                    pageText: pageText
                )
            }
            hostView.onStrokeBatch = { [weak self] strokes, drawingData in
                guard let self else { return }
                self.runtime.handleNewStrokes(
                    surfaceId: self.surfaceId,
                    paneId: self.paneId,
                    strokes: strokes,
                    drawingData: drawingData
                )
            }
        }

        func updateBinding(surfaceId: String, paneId: Int, hostView: SurfAceSurfaceHostView) {
            guard self.surfaceId != surfaceId || self.paneId != paneId || self.hostView !== hostView else {
                return
            }
            runtime.detachPaneBridge(surfaceId: self.surfaceId, paneId: self.paneId, bridge: self)
            self.surfaceId = surfaceId
            self.paneId = paneId
            attach(hostView: hostView)
            runtime.attachPaneBridge(surfaceId: surfaceId, paneId: paneId, bridge: self)
        }

        func detach() {
            runtime.detachPaneBridge(surfaceId: surfaceId, paneId: paneId, bridge: self)
            hostView = nil
        }

        func render(entry: SurfAcePaneEntry?, restoreViewport: SurfAceViewport?) {
            hostView?.render(entry: entry, restoreViewport: restoreViewport)
        }

        func reloadBrowserURL() {
            hostView?.reloadBrowserURL()
        }

        func renderBrowserURL(entry: SurfAcePaneEntry) async -> SurfAceBrowserNavigationResult {
            guard let hostView else {
                return SurfAceBrowserNavigationResult(errorMessage: "pane bridge is detached", status: "failed", url: entry.url ?? "")
            }
            return await hostView.renderBrowserURL(entry: entry)
        }

        func setInteraction(annotationMode: Bool, fingerDrawEnabled: Bool) {
            hostView?.setInteraction(annotationMode: annotationMode, fingerDrawEnabled: fingerDrawEnabled)
        }

        func restoreDrawing(from drawingData: Data, strokes: [SurfAceStroke]) -> Bool {
            hostView?.restoreDrawing(from: drawingData, strokes: strokes) ?? drawingData.isEmpty
        }

        func captureDrawingData() -> Data {
            hostView?.captureDrawingData() ?? Data()
        }

        func fetchSnapshot(includeImage: Bool) async -> SurfAceSurfaceSnapshot? {
            await hostView?.fetchSnapshot(includeImage: includeImage)
        }

        func applyHTMLPatch(_ patch: SurfAceFramePatchRequest) async -> SurfAceHTMLPatchResult {
            await hostView?.applyHTMLPatch(patch) ?? .failed("pane renderer unavailable")
        }

        func removeDrawingStrokeIDs(_ strokeIDs: [String]) {
            hostView?.removeDrawingStrokeIDs(strokeIDs)
        }

        func clearDrawings() {
            hostView?.clearDrawings()
        }
    }
}

@MainActor
final class SurfAceSceneProbeController: UIViewController {
    var onConnect: (@Sendable (String, UIScene) -> Void)?
    private var connectedSceneKey: String?

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        resolveSceneKeyIfNeeded()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        resolveSceneKeyIfNeeded()
    }

    private func resolveSceneKeyIfNeeded() {
        guard connectedSceneKey == nil,
              let scene = view.window?.windowScene else {
            return
        }
        let sceneKey = scene.session.persistentIdentifier
        connectedSceneKey = sceneKey
        SurfAceSceneActivation.log(
            event: "scene_probe_connect",
            fields: [
                ("scene_key", sceneKey),
                ("activation_state", "\(scene.activationState.rawValue)")
            ]
        )
        onConnect?(sceneKey, scene)
    }
}

private struct SurfAceSceneProbeRepresentable: UIViewControllerRepresentable {
    let onConnect: @Sendable (String, UIScene) -> Void

    func makeUIViewController(context: Context) -> SurfAceSceneProbeController {
        let controller = SurfAceSceneProbeController()
        controller.view.isHidden = true
        controller.onConnect = onConnect
        return controller
    }

    func updateUIViewController(_ uiViewController: SurfAceSceneProbeController, context: Context) {
        uiViewController.onConnect = onConnect
    }
}

@MainActor
private final class SurfAceWeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?

    init(target: WKScriptMessageHandler) {
        self.target = target
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}

@MainActor
private final class SurfAceAnnotationCanvasView: PKCanvasView {
    var annotationMode = false
    var onPencilContact: (() -> Void)?

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        guard super.point(inside: point, with: event) else {
            return false
        }
        if annotationMode {
            return true
        }
        return event?.allTouches?.contains { $0.type == .pencil } == true
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        if touches.contains(where: { $0.type == .pencil }) {
            onPencilContact?()
        }
        super.touchesBegan(touches, with: event)
    }
}

@MainActor
private final class SurfAcePencilContactGestureRecognizer: UIGestureRecognizer {
    var onPencilContact: (() -> Void)?

    override init(target: Any?, action: Selector?) {
        super.init(target: target, action: action)
        cancelsTouchesInView = false
        delaysTouchesBegan = false
        delaysTouchesEnded = false
        allowedTouchTypes = [NSNumber(value: UITouch.TouchType.pencil.rawValue)]
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        if touches.contains(where: { $0.type == .pencil }) {
            onPencilContact?()
        }
        state = .failed
    }
}

@MainActor
final class SurfAceSurfaceHostView: UIView, PKCanvasViewDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    var onInteractionBegan: (() -> Void)?
    var onPencilContact: (() -> Void)?
    var onSelectionChanged: ((String, CGRect?) -> Void)?
    var onScrollSettled: ((SurfAceViewport, String) -> Void)?
    var onTapEvent: ((String, SurfAcePoint, String) -> Void)?
    var onNavigationEvent: ((String, Int64) -> Void)?
    var onPDFPageChanged: ((Int, Int, String?) -> Void)?
    var onStrokeBatch: (([SurfAceStroke], Data) -> Void)?

    private struct TrackedStroke {
        let strokeId: String
        var stroke: PKStroke
        var signature: String
    }

    private let selectionMessageName = "surfAceSelection"
    private let scrollMessageName = "surfAceScroll"
    private let tapMessageName = "surfAceTap"
    private let navigationMessageName = "surfAceNavigation"
    private let focusMessageName = "surfAceFocus"

    private let webView: WKWebView
    private let pdfView = PDFView()
    private let canvasView = SurfAceAnnotationCanvasView()
    private let pencilContactRecognizer = SurfAcePencilContactGestureRecognizer()
    private var currentEntry: SurfAcePaneEntry?
    private var pendingBrowserNavigation: CheckedContinuation<SurfAceBrowserNavigationResult, Never>?
    private var pendingBrowserNavigationLoad: WKNavigation?
    private var pendingBrowserNavigationURL: String?
    private var annotationMode = false
    private var fingerDrawEnabled = false
    private var trackedStrokes: [TrackedStroke] = []
    private var isApplyingProgrammaticDrawingChange = false
    private var pendingViewportRestore: SurfAceViewport?
    private var pendingHTMLRenderActive = false
    private var pendingHTMLRenderContinuations: [CheckedContinuation<Void, Never>] = []
    private var lastViewport = SurfAceViewport(
        scrollOffset: SurfAcePoint(x: 0, y: 0),
        visibleRect: SurfAceRect(x: 0, y: 0, width: 1, height: 1),
        contentSize: SurfAceSize(width: 1, height: 1),
        zoomLevel: 1
    )
    private var lastVisibleText = ""
    private var lastSelection: SurfAceSelection?

    override init(frame: CGRect) {
        let config = WKWebViewConfiguration()
        let contentController = WKUserContentController()
        config.userContentController = contentController
        config.allowsInlineMediaPlayback = true
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        webView = WKWebView(frame: .zero, configuration: config)
        super.init(frame: frame)
        webView.navigationDelegate = self
        setupViewHierarchy()
        setupScripts()
        setupPDFTracking()
        setupInteractionTracking()
        render(entry: nil, restoreViewport: nil)
    }

    required init?(coder: NSCoder) {
        nil
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    func render(entry: SurfAcePaneEntry?, restoreViewport: SurfAceViewport?) {
        finishPendingBrowserNavigation(
            status: "failed",
            errorMessage: "browser_url navigation was superseded",
            url: pendingBrowserNavigationURL
        )
        currentEntry = entry
        pendingViewportRestore = nil
        let html: String
        let baseURL: URL?

        if let entry {
            switch entry.payload {
            case .html(let rawHTML, let suppliedBaseURL):
                html = rawHTML
                baseURL = suppliedBaseURL.flatMap(URL.init(string:))
                pendingViewportRestore = restoreViewport
                beginPendingHTMLRender()
                showWebView()
            case .image(let data, let mediaType, let alt):
                beginPendingHTMLRender()
                html = imageHTML(data: data, mediaType: mediaType, alt: alt)
                baseURL = nil
                showWebView()
            case .pdf(let data):
                finishPendingHTMLRender()
                renderPDF(data)
                applyCurrentInteractionState()
                return
            case .terminal(let lines, _):
                beginPendingHTMLRender()
                html = terminalHTML(lines: lines)
                baseURL = nil
                showWebView()
            case .markdown(let markdown):
                beginPendingHTMLRender()
                html = markdownHTML(markdown)
                baseURL = nil
                showWebView()
            case .video(let url):
                beginPendingHTMLRender()
                html = videoHTML(url: url)
                baseURL = nil
                showWebView()
            case .some(.canvas):
                beginPendingHTMLRender()
                html = placeholderHTML(title: "Canvas", detail: "No preview is available for this pane.")
                baseURL = nil
                showWebView()
            case .browserURL(let url, _, _):
                finishPendingHTMLRender()
                guard let requestURL = URL(string: url) else {
                    html = placeholderHTML(title: "Browser URL", detail: "Invalid URL.")
                    baseURL = nil
                    showWebView()
                    break
                }
                showWebView()
                webView.load(URLRequest(url: requestURL))
                applyCurrentInteractionState()
                return
            case nil:
#if os(visionOS)
                showEmptyPane()
                applyCurrentInteractionState()
                return
#else
                beginPendingHTMLRender()
                html = standbyHTML()
                baseURL = nil
                showWebView()
#endif
            }
        } else {
#if os(visionOS)
            showEmptyPane()
            applyCurrentInteractionState()
            return
#else
            beginPendingHTMLRender()
            html = standbyHTML()
            baseURL = nil
            showWebView()
#endif
        }

        webView.loadHTMLString(html, baseURL: baseURL)
        applyCurrentInteractionState()
    }

    func renderBrowserURL(entry: SurfAcePaneEntry) async -> SurfAceBrowserNavigationResult {
        finishPendingBrowserNavigation(
            status: "failed",
            errorMessage: "browser_url navigation was superseded",
            url: pendingBrowserNavigationURL
        )
        return await withCheckedContinuation { continuation in
            currentEntry = entry
            pendingViewportRestore = nil
            pendingBrowserNavigation = continuation
            pendingBrowserNavigationURL = entry.url
            guard case .browserURL(let url, _, _) = entry.payload,
                  let requestURL = URL(string: url) else {
                finishPendingBrowserNavigation(status: "failed", errorMessage: "Invalid URL.", url: entry.url)
                return
            }
            finishPendingHTMLRender()
            showWebView()
            let navigation = webView.load(URLRequest(url: requestURL))
            pendingBrowserNavigationLoad = navigation
            applyCurrentInteractionState()
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 8_000_000_000)
                self?.finishPendingBrowserNavigation(
                    status: "failed",
                    errorMessage: "browser_url navigation was not verified before timeout",
                    navigation: navigation,
                    url: self?.pendingBrowserNavigationURL
                )
            }
        }
    }

    func reloadBrowserURL() {
        webView.reload()
    }

    func setInteraction(annotationMode: Bool, fingerDrawEnabled: Bool) {
        self.annotationMode = annotationMode
        self.fingerDrawEnabled = fingerDrawEnabled
        applyCurrentInteractionState()
    }

    func restoreDrawing(from drawingData: Data, strokes: [SurfAceStroke]) -> Bool {
        isApplyingProgrammaticDrawingChange = true
        defer { isApplyingProgrammaticDrawingChange = false }

        guard !drawingData.isEmpty else {
            canvasView.drawing = PKDrawing()
            trackedStrokes = []
            return true
        }
        guard let drawing = try? PKDrawing(data: drawingData) else {
            canvasView.drawing = PKDrawing()
            trackedStrokes = []
            return false
        }

        canvasView.drawing = drawing
        trackedStrokes = zip(drawing.strokes, strokes).map { stroke, serialized in
            TrackedStroke(strokeId: serialized.strokeId, stroke: stroke, signature: strokeSignature(stroke))
        }
        return true
    }

    func captureDrawingData() -> Data {
        canvasView.drawing.dataRepresentation()
    }

    func fetchSnapshot(includeImage: Bool) async -> SurfAceSurfaceSnapshot? {
        await waitForPendingHTMLRenderIfNeeded()

        switch currentEntry?.payload {
        case .html:
            if let payload = await evaluateSnapshotPayload() {
                lastViewport = payload.viewport
                lastVisibleText = payload.visibleText
                lastSelection = payload.selection ?? lastSelection
            }
        case .markdown(let markdown):
            lastVisibleText = markdown
        case .image(_, _, let alt):
            lastVisibleText = alt ?? ""
        case .pdf(let data):
            lastViewport = pdfViewport()
            lastVisibleText = currentPDFPageText() ?? extractPDFText(data)
            lastSelection = nil
        case .terminal(let lines, _):
            lastVisibleText = lines.suffix(200).map(SurfAceANSI.strip).joined(separator: "\n")
        case .browserURL(let url, _, _):
            lastVisibleText = url
            lastSelection = nil
        case .some(.video), .some(.canvas):
            lastVisibleText = ""
            lastSelection = nil
        case nil:
            break
        }

        let imageBase64 = includeImage ? await captureRenderedImageBase64() : nil

        return SurfAceSurfaceSnapshot(
            viewport: lastViewport,
            visibleText: lastVisibleText.prefix(4096).description,
            selection: lastSelection,
            imageBase64: imageBase64
        )
    }

    var hasPendingWebContentRenderForTesting: Bool {
        pendingHTMLRenderActive
    }

    func applyHTMLPatch(_ patch: SurfAceFramePatchRequest) async -> SurfAceHTMLPatchResult {
        let supportedActions: Set<String> = ["replace_inner", "replace_outer", "insert_before", "insert_after", "remove"]
        guard supportedActions.contains(patch.action) else {
            return .invalidAction
        }
        if patch.action != "remove", patch.html == nil {
            return .failed("Patch html is required for action \(patch.action)")
        }

        let payload: [String: Any?] = [
            "selector": patch.selector,
            "action": patch.action,
            "html": patch.html,
        ]
        guard let bodyData = try? JSONSerialization.data(withJSONObject: payload.compactMapValues { $0 }),
              let bodyJSON = String(data: bodyData, encoding: .utf8) else {
            return .failed("Patch payload serialization failed")
        }

        let script = """
        (function() {
          const patch = \(bodyJSON);
          const target = document.querySelector(patch.selector);
          if (!target) { return JSON.stringify({ ok: false, reason: "selector_not_found" }); }
          const html = patch.html || "";
          switch (patch.action) {
            case "replace_inner": target.innerHTML = html; break;
            case "replace_outer": target.outerHTML = html; break;
            case "insert_before": target.insertAdjacentHTML("beforebegin", html); break;
            case "insert_after": target.insertAdjacentHTML("afterend", html); break;
            case "remove": target.remove(); break;
            default: return JSON.stringify({ ok: false, reason: "invalid_action" });
          }
          return JSON.stringify({ ok: true, html: document.documentElement.outerHTML });
        })();
        """

        guard let result = await evaluateJSONObject(script),
              let ok = result["ok"] as? Bool else {
            return .failed("Patch evaluation failed")
        }

        guard ok else {
            switch result["reason"] as? String {
            case "selector_not_found":
                return .selectorNotFound
            case "invalid_action":
                return .invalidAction
            default:
                return .failed("Patch rejected by renderer")
            }
        }

        guard let updatedHTML = result["html"] as? String else {
            return .failed("Updated html unavailable")
        }
        return .success(updatedHTML: updatedHTML)
    }

    func removeDrawingStrokeIDs(_ strokeIDs: [String]) {
        let removeSet = Set(strokeIDs)
        let remaining = trackedStrokes.filter { !removeSet.contains($0.strokeId) }
        trackedStrokes = remaining
        applyDrawing(strokes: remaining.map(\.stroke))
    }

    func clearDrawings() {
        trackedStrokes.removeAll()
        applyDrawing(strokes: [])
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        onInteractionBegan?()

        switch message.name {
        case selectionMessageName:
            if let text = body["text"] as? String,
               let rect = parseRect(body["boundingRect"] as? [String: Any]) {
                let selection = SurfAceSelection.text(text, boundingRect: rect.surfAceRect)
                lastSelection = selection
                onSelectionChanged?(text, rect)
            }
        case scrollMessageName:
            guard let viewport = parseViewport(body["viewport"] as? [String: Any]) else { return }
            let visibleText = (body["visibleText"] as? String) ?? ""
            lastViewport = viewport
            lastVisibleText = visibleText
            onScrollSettled?(viewport, visibleText)
        case tapMessageName:
            guard let position = parsePoint(body["position"] as? [String: Any]) else { return }
            let nearestContent = (body["nearestContent"] as? String) ?? ""
            let kind = (body["kind"] as? String) == "long_press" ? "long_press" : "tap"
            onTapEvent?(kind, SurfAcePoint(x: Double(position.x), y: Double(position.y)), nearestContent)
        case navigationMessageName:
            guard let url = body["url"] as? String, !url.isEmpty else { return }
            let sentAt = parseInt64(body["sentAt"]) ?? Int64(Date().timeIntervalSince1970 * 1000)
            onNavigationEvent?(url, sentAt)
        case focusMessageName:
            onInteractionBegan?()
        default:
            break
        }
    }

    func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
        let changed = syncTrackedStrokes(with: canvasView.drawing.strokes, emitChanges: !isApplyingProgrammaticDrawingChange)
        if !isApplyingProgrammaticDrawingChange, !changed.isEmpty {
            onInteractionBegan?()
            onStrokeBatch?(changed, canvasView.drawing.dataRepresentation())
        }
    }

    private func setupViewHierarchy() {
#if os(visionOS)
        backgroundColor = .clear
#else
        backgroundColor = .black
#endif

        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        #if !os(visionOS)
        webView.scrollView.keyboardDismissMode = .onDrag
        #endif

        pdfView.translatesAutoresizingMaskIntoConstraints = false
        pdfView.backgroundColor = .black
        pdfView.autoScales = true
        pdfView.displayMode = .singlePageContinuous
        pdfView.displayDirection = .vertical
        pdfView.usePageViewController(false)

        canvasView.translatesAutoresizingMaskIntoConstraints = false
        canvasView.backgroundColor = .clear
        canvasView.isOpaque = false
        canvasView.delegate = self
        canvasView.onPencilContact = { [weak self] in
            self?.onPencilContact?()
        }
        canvasView.tool = PKInkingTool(.pen, color: .systemOrange, width: 4)

        addSubview(webView)
        addSubview(pdfView)
        addSubview(canvasView)

        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: trailingAnchor),
            webView.topAnchor.constraint(equalTo: topAnchor),
            webView.bottomAnchor.constraint(equalTo: bottomAnchor),
            pdfView.leadingAnchor.constraint(equalTo: leadingAnchor),
            pdfView.trailingAnchor.constraint(equalTo: trailingAnchor),
            pdfView.topAnchor.constraint(equalTo: topAnchor),
            pdfView.bottomAnchor.constraint(equalTo: bottomAnchor),
            canvasView.leadingAnchor.constraint(equalTo: leadingAnchor),
            canvasView.trailingAnchor.constraint(equalTo: trailingAnchor),
            canvasView.topAnchor.constraint(equalTo: topAnchor),
            canvasView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    private func setupScripts() {
        let script = WKUserScript(source: bridgeScript(), injectionTime: .atDocumentEnd, forMainFrameOnly: true)
        let controller = webView.configuration.userContentController
        controller.addUserScript(script)
        controller.add(SurfAceWeakScriptMessageHandler(target: self), name: selectionMessageName)
        controller.add(SurfAceWeakScriptMessageHandler(target: self), name: scrollMessageName)
        controller.add(SurfAceWeakScriptMessageHandler(target: self), name: tapMessageName)
        controller.add(SurfAceWeakScriptMessageHandler(target: self), name: navigationMessageName)
        controller.add(SurfAceWeakScriptMessageHandler(target: self), name: focusMessageName)
    }

    private func setupInteractionTracking() {
        let recognizer = UITapGestureRecognizer(target: self, action: #selector(handlePaneTapGesture(_:)))
        recognizer.cancelsTouchesInView = false
        recognizer.delaysTouchesBegan = false
        recognizer.delaysTouchesEnded = false
        addGestureRecognizer(recognizer)

        pencilContactRecognizer.onPencilContact = { [weak self] in
            self?.onPencilContact?()
        }
        addGestureRecognizer(pencilContactRecognizer)
    }

    @objc
    private func handlePaneTapGesture(_ recognizer: UITapGestureRecognizer) {
        if recognizer.state == .ended {
            onInteractionBegan?()
        }
    }

    private func setupPDFTracking() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handlePDFPageChangedNotification(_:)),
            name: Notification.Name.PDFViewPageChanged,
            object: pdfView
        )
    }

    private func applyCurrentInteractionState() {
        let entryScrollable = currentEntry?.scrollable ?? true
        let entryInteractive = currentEntry?.interactive ?? true
        canvasView.isUserInteractionEnabled = true
        canvasView.annotationMode = annotationMode
        if annotationMode {
            webView.scrollView.isScrollEnabled = false
            webView.isUserInteractionEnabled = false
            pdfView.isUserInteractionEnabled = false
            pdfScrollView()?.isScrollEnabled = false
            canvasView.drawingPolicy = fingerDrawEnabled ? .anyInput : .pencilOnly
        } else {
            webView.scrollView.isScrollEnabled = entryScrollable
            webView.isUserInteractionEnabled = entryInteractive
            pdfView.isUserInteractionEnabled = entryInteractive
            pdfScrollView()?.isScrollEnabled = entryScrollable
            canvasView.drawingPolicy = .pencilOnly
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            await self.restorePendingViewportIfNeeded()
            await self.publishCurrentWebViewportIfNeeded()
            await self.waitForWebContentPaint()
            self.finishPendingHTMLRender()
            self.finishPendingBrowserNavigation(status: "applied", errorMessage: nil, navigation: navigation, url: self.pendingBrowserNavigationURL)
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        finishPendingHTMLRender()
        finishPendingBrowserNavigation(status: "failed", errorMessage: error.localizedDescription, navigation: navigation, url: pendingBrowserNavigationURL)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        finishPendingHTMLRender()
        finishPendingBrowserNavigation(status: "failed", errorMessage: error.localizedDescription, navigation: navigation, url: pendingBrowserNavigationURL)
    }

    private func finishPendingBrowserNavigation(status: String, errorMessage: String?, navigation: WKNavigation? = nil, url: String?) {
        guard let continuation = pendingBrowserNavigation else { return }
        if let navigation, pendingBrowserNavigationLoad !== navigation {
            return
        }
        pendingBrowserNavigation = nil
        pendingBrowserNavigationLoad = nil
        let resolvedURL = url ?? pendingBrowserNavigationURL ?? ""
        pendingBrowserNavigationURL = nil
        continuation.resume(returning: SurfAceBrowserNavigationResult(errorMessage: errorMessage, status: status, url: resolvedURL))
    }

    private func showWebView() {
        pdfView.document = nil
        pdfView.isHidden = true
        webView.isHidden = false
    }

    private func showEmptyPane() {
        finishPendingHTMLRender()
        pdfView.document = nil
        pdfView.isHidden = true
        webView.stopLoading()
        webView.loadHTMLString(standbyHTML(), baseURL: nil)
        webView.isHidden = true
    }

    private func renderPDF(_ base64Data: String) {
        webView.isHidden = true
        pdfView.isHidden = false
        guard let data = Data(base64Encoded: base64Data, options: [.ignoreUnknownCharacters]),
              let document = PDFDocument(data: data) else {
            pdfView.document = nil
            webView.loadHTMLString(placeholderHTML(title: "PDF unavailable", detail: "This PDF could not be rendered on iOS."), baseURL: nil)
            showWebView()
            return
        }

        pdfView.document = document
        pdfView.goToFirstPage(nil)
        lastViewport = pdfViewport()
        lastVisibleText = currentPDFPageText() ?? ""
        DispatchQueue.main.async { [weak self] in
            self?.notifyPDFPageChanged()
        }
    }

    private func pdfScrollView() -> UIScrollView? {
        if let scrollView = pdfView.subviews.compactMap({ $0 as? UIScrollView }).first {
            return scrollView
        }
        return pdfView.subviews
            .flatMap(\.subviews)
            .compactMap { $0 as? UIScrollView }
            .first
    }

    private func pdfViewport() -> SurfAceViewport {
        let scrollView = pdfScrollView()
        let contentOffset = scrollView?.contentOffset ?? .zero
        let contentSize = scrollView?.contentSize ?? bounds.size
        return SurfAceViewport(
            scrollOffset: SurfAcePoint(x: Double(contentOffset.x), y: Double(contentOffset.y)),
            visibleRect: SurfAceRect(
                x: Double(contentOffset.x),
                y: Double(contentOffset.y),
                width: Double(max(bounds.width, 1)),
                height: Double(max(bounds.height, 1))
            ),
            contentSize: SurfAceSize(
                width: Double(max(contentSize.width, 1)),
                height: Double(max(contentSize.height, 1))
            ),
            zoomLevel: Double(scrollView?.zoomScale ?? pdfView.scaleFactor)
        )
    }

    private func currentPDFPageText() -> String? {
        pdfView.currentPage?.string?.prefix(4096).description
    }

    @objc
    private func handlePDFPageChangedNotification(_ notification: Notification) {
        notifyPDFPageChanged()
    }

    private func notifyPDFPageChanged() {
        guard let document = pdfView.document,
              let currentPage = pdfView.currentPage else {
            return
        }
        lastViewport = pdfViewport()
        let page = max(document.index(for: currentPage) + 1, 1)
        let totalPages = max(document.pageCount, 1)
        let pageText = currentPage.string?.prefix(4096).description
        lastVisibleText = pageText ?? ""
        onPDFPageChanged?(page, totalPages, pageText)
    }

    private func applyDrawing(strokes: [PKStroke]) {
        isApplyingProgrammaticDrawingChange = true
        canvasView.drawing = PKDrawing(strokes: strokes)
        isApplyingProgrammaticDrawingChange = false
    }

    private func syncTrackedStrokes(with strokes: [PKStroke], emitChanges: Bool) -> [SurfAceStroke] {
        var next: [TrackedStroke] = []
        var changed: [SurfAceStroke] = []

        for (index, stroke) in strokes.enumerated() {
            let signature = strokeSignature(stroke)
            if index < trackedStrokes.count {
                var existing = trackedStrokes[index]
                if existing.signature != signature {
                    existing.signature = signature
                    existing.stroke = stroke
                    if emitChanges {
                        changed.append(serializeStroke(stroke, strokeId: existing.strokeId))
                    }
                } else {
                    existing.stroke = stroke
                }
                next.append(existing)
            } else {
                let strokeId = randomStrokeID()
                let tracked = TrackedStroke(strokeId: strokeId, stroke: stroke, signature: signature)
                next.append(tracked)
                if emitChanges {
                    changed.append(serializeStroke(stroke, strokeId: strokeId))
                }
            }
        }

        trackedStrokes = next
        return changed
    }

    private func strokeSignature(_ stroke: PKStroke) -> String {
        let count = stroke.path.count
        let lastPoint = count > 0 ? stroke.path[count - 1] : nil
        let x = lastPoint?.location.x ?? 0
        let y = lastPoint?.location.y ?? 0
        let force = lastPoint?.force ?? 0
        return "\(count)-\(x)-\(y)-\(force)-\(stroke.ink.inkType.rawValue)"
    }

    private func serializeStroke(_ stroke: PKStroke, strokeId: String) -> SurfAceStroke {
        let nowMilliseconds = Int64(Date().timeIntervalSince1970 * 1000)
        var points: [SurfAceStrokePoint] = []
        for index in 0..<stroke.path.count {
            let point = stroke.path[index]
            points.append(
                SurfAceStrokePoint(
                    x: Double(point.location.x),
                    y: Double(point.location.y),
                    pressure: Double(point.force),
                    timestamp: nowMilliseconds + Int64(point.timeOffset * 1000)
                )
            )
        }
        return SurfAceStroke(
            strokeId: strokeId,
            points: points,
            tool: fingerDrawEnabled ? "finger" : "pencil"
        )
    }

    private func evaluateSnapshotPayload() async -> (viewport: SurfAceViewport, visibleText: String, selection: SurfAceSelection?)? {
        let script = "window.__surfAceSnapshotPayload ? JSON.stringify(window.__surfAceSnapshotPayload()) : null;"
        guard let object = await evaluateJSONObject(script),
              let viewport = parseViewport(object["viewport"] as? [String: Any]) else {
            return nil
        }

        let visibleText = (object["visibleText"] as? String) ?? ""
        var selection: SurfAceSelection?
        if let selectionObject = object["selection"] as? [String: Any],
           let text = selectionObject["text"] as? String,
           let rect = parseRect(selectionObject["boundingRect"] as? [String: Any]) {
            selection = .text(text, boundingRect: rect.surfAceRect)
        }

        return (viewport, visibleText, selection)
    }

    private func evaluateJSONObject(_ script: String) async -> [String: Any]? {
        await withCheckedContinuation { continuation in
            webView.evaluateJavaScript(script) { result, _ in
                guard let json = result as? String,
                      let data = json.data(using: .utf8),
                      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    continuation.resume(returning: nil)
                    return
                }
                continuation.resume(returning: object)
            }
        }
    }

    private func evaluateJavaScriptVoid(_ script: String) async {
        await withCheckedContinuation { continuation in
            webView.evaluateJavaScript(script) { _, _ in
                continuation.resume()
            }
        }
    }

    private func beginPendingHTMLRender() {
        finishPendingHTMLRender()
        pendingHTMLRenderActive = true
    }

    private func waitForPendingHTMLRenderIfNeeded() async {
        guard pendingHTMLRenderActive else { return }
        await withCheckedContinuation { continuation in
            if pendingHTMLRenderActive {
                pendingHTMLRenderContinuations.append(continuation)
            } else {
                continuation.resume()
            }
        }
    }

    private func waitForWebContentPaint() async {
        try? await Task.sleep(nanoseconds: 50_000_000)
    }

    private func finishPendingHTMLRender() {
        pendingHTMLRenderActive = false
        let continuations = pendingHTMLRenderContinuations
        pendingHTMLRenderContinuations.removeAll()
        continuations.forEach { $0.resume() }
    }

    private func restorePendingViewportIfNeeded() async {
        guard let viewport = pendingViewportRestore else { return }
        pendingViewportRestore = nil

        let script = """
        (function() {
          const doc = document.documentElement;
          const body = document.body;
          const maxX = Math.max(
            (doc ? doc.scrollWidth : 0),
            (body ? body.scrollWidth : 0),
            window.innerWidth || 0
          ) - (window.innerWidth || 0);
          const maxY = Math.max(
            (doc ? doc.scrollHeight : 0),
            (body ? body.scrollHeight : 0),
            window.innerHeight || 0
          ) - (window.innerHeight || 0);
          window.scrollTo(
            Math.max(0, Math.min(\(viewport.scrollOffset.x), Math.max(maxX, 0))),
            Math.max(0, Math.min(\(viewport.scrollOffset.y), Math.max(maxY, 0)))
          );
        })();
        """
        await evaluateJavaScriptVoid(script)
    }

    private func publishCurrentWebViewportIfNeeded() async {
        guard case .some(.html) = currentEntry?.payload else { return }
        guard let payload = await evaluateSnapshotPayload() else { return }
        lastViewport = payload.viewport
        lastVisibleText = payload.visibleText
        lastSelection = payload.selection ?? lastSelection
        onScrollSettled?(payload.viewport, payload.visibleText)
    }

    private func parseViewport(_ object: [String: Any]?) -> SurfAceViewport? {
        guard let object,
              let scrollOffset = parsePoint(object["scrollOffset"] as? [String: Any]),
              let visibleRect = parseRect(object["visibleRect"] as? [String: Any]),
              let contentSize = parseSize(object["contentSize"] as? [String: Any]),
              let zoomLevel = parseDouble(object["zoomLevel"]) else {
            return nil
        }
        return SurfAceViewport(
            scrollOffset: SurfAcePoint(x: Double(scrollOffset.x), y: Double(scrollOffset.y)),
            visibleRect: visibleRect.surfAceRect,
            contentSize: SurfAceSize(width: Double(contentSize.width), height: Double(contentSize.height)),
            zoomLevel: zoomLevel
        )
    }

    private func parsePoint(_ object: [String: Any]?) -> CGPoint? {
        guard let object,
              let x = parseDouble(object["x"]),
              let y = parseDouble(object["y"]) else {
            return nil
        }
        return CGPoint(x: x, y: y)
    }

    private func parseRect(_ object: [String: Any]?) -> CGRect? {
        guard let object,
              let x = parseDouble(object["x"]),
              let y = parseDouble(object["y"]),
              let width = parseDouble(object["width"]),
              let height = parseDouble(object["height"]) else {
            return nil
        }
        return CGRect(x: x, y: y, width: width, height: height)
    }

    private func parseSize(_ object: [String: Any]?) -> CGSize? {
        guard let object,
              let width = parseDouble(object["width"]),
              let height = parseDouble(object["height"]) else {
            return nil
        }
        return CGSize(width: width, height: height)
    }

    private func parseDouble(_ value: Any?) -> Double? {
        if let value = value as? Double { return value }
        if let value = value as? CGFloat { return Double(value) }
        if let value = value as? NSNumber { return value.doubleValue }
        if let value = value as? String { return Double(value) }
        return nil
    }

    private func parseInt64(_ value: Any?) -> Int64? {
        if let value = value as? Int64 { return value }
        if let value = value as? Int { return Int64(value) }
        if let value = value as? NSNumber { return value.int64Value }
        if let value = value as? String { return Int64(value) }
        return nil
    }

    private func captureRenderedImageBase64() async -> String? {
        guard bounds.width > 1, bounds.height > 1 else { return nil }
        if !webView.isHidden, let webImage = await captureWebViewSnapshot() {
            return renderCompositeImageBase64(webImage: webImage)
        }
        return captureFullScreenshotBase64()
    }

    private func captureWebViewSnapshot() async -> UIImage? {
        guard webView.bounds.width > 1, webView.bounds.height > 1 else { return nil }
        let configuration = WKSnapshotConfiguration()
        configuration.rect = webView.bounds
        configuration.afterScreenUpdates = true
        return await withCheckedContinuation { continuation in
            webView.takeSnapshot(with: configuration) { image, _ in
                continuation.resume(returning: image)
            }
        }
    }

    private func renderCompositeImageBase64(webImage: UIImage) -> String? {
        let renderer = UIGraphicsImageRenderer(bounds: bounds)
        let image = renderer.image { _ in
            UIColor.black.setFill()
            UIRectFill(bounds)
            webImage.draw(in: webView.convert(webView.bounds, to: self))
            if !canvasView.drawing.strokes.isEmpty {
                canvasView.drawHierarchy(in: canvasView.convert(canvasView.bounds, to: self), afterScreenUpdates: true)
            }
        }
        return image.pngData()?.base64EncodedString()
    }

    private func captureFullScreenshotBase64() -> String? {
        guard bounds.width > 1, bounds.height > 1 else { return nil }
        let renderer = UIGraphicsImageRenderer(bounds: bounds)
        let image = renderer.image { _ in
            drawHierarchy(in: bounds, afterScreenUpdates: true)
        }
        return image.pngData()?.base64EncodedString()
    }

    private func standbyHTML() -> String {
        """
        <!doctype html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width,initial-scale=1.0" />
          <style>html, body { margin: 0; min-height: 100%; background: #000; overflow: hidden; }</style>
        </head>
        <body></body>
        </html>
        """
    }

    private func imageHTML(data: String, mediaType: String, alt: String?) -> String {
        let escapedAlt = escapeHTML(alt ?? "")
        return """
        <!doctype html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=5.0,user-scalable=yes" />
          <style>
            body { margin: 0; background: #0a0f14; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
            img { max-width: 100%; max-height: 100vh; object-fit: contain; }
          </style>
        </head>
        <body><img alt="\(escapedAlt)" src="data:\(mediaType);base64,\(data)" /></body>
        </html>
        """
    }

    private func videoHTML(url: String) -> String {
        let escapedURL = escapeHTML(url)
        return """
        <!doctype html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=3.0,user-scalable=yes" />
          <style>
            html, body { margin: 0; min-height: 100%; background: #05080c; }
            body {
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
            }
            video {
              width: 100%;
              max-height: 100vh;
              background: #000;
            }
          </style>
        </head>
        <body>
          <video controls playsinline preload="metadata" src="\(escapedURL)"></video>
        </body>
        </html>
        """
    }

    private func markdownHTML(_ markdown: String) -> String {
        return """
        <!doctype html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=3.0,user-scalable=yes" />
          <style>
            html, body { margin: 0; min-height: 100%; background: #fbfcff; color: #172033; }
            body {
              padding: clamp(24px, 4vw, 56px);
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
              font-size: 17px;
              line-height: 1.62;
              overflow-wrap: anywhere;
            }
            h1, h2, h3, h4, h5, h6 { margin: 1.35em 0 0.55em; color: #0d1628; line-height: 1.2; }
            h1:first-child, h2:first-child, h3:first-child, h4:first-child, h5:first-child, h6:first-child { margin-top: 0; }
            h1 { font-size: 2rem; }
            h2 { font-size: 1.55rem; }
            h3 { font-size: 1.25rem; }
            p, ul, ol, blockquote, pre, table { margin: 0 0 1em; }
            ul, ol { padding-left: 1.5em; }
            li + li { margin-top: 0.3em; }
            code {
              padding: 0.15em 0.3em;
              border-radius: 5px;
              background: #eef2f8;
              color: #0d1628;
              font-family: "SF Mono", Menlo, ui-monospace, monospace;
              font-size: 0.92em;
            }
            pre {
              overflow: auto;
              padding: 14px 16px;
              border: 1px solid #d8e0ec;
              border-radius: 8px;
              background: #101828;
              color: #f5f7fb;
            }
            pre code { padding: 0; background: transparent; color: inherit; }
            blockquote { padding: 0.1em 0 0.1em 1em; border-left: 4px solid #9aabc3; color: #46546a; }
            a { color: #1d5fbf; }
            table { width: 100%; border-collapse: collapse; font-size: 0.95em; }
            th, td { padding: 8px 10px; border: 1px solid #d8e0ec; text-align: left; vertical-align: top; }
            th { background: #eef2f8; color: #0d1628; }
          </style>
        </head>
        <body>\(surfAceMarkdownToHTML(markdown))</body>
        </html>
        """
    }

    private func placeholderHTML(title: String, detail: String, backgroundCSS: String = "#0a0f14") -> String {
        let escapedTitle = escapeHTML(title)
        let escapedDetail = escapeHTML(detail)
        return """
        <!doctype html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width,initial-scale=1.0" />
          <style>
            html, body { margin: 0; min-height: 100%; background: \(backgroundCSS); color: #f3f5f8; }
            body {
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              font-family: -apple-system, BlinkMacSystemFont, sans-serif;
            }
            .card {
              max-width: 320px;
              padding: 20px 22px;
              border-radius: 18px;
              background: rgba(0, 0, 0, 0.34);
              text-align: center;
            }
            h1 { margin: 0 0 8px; font-size: 20px; }
            p { margin: 0; line-height: 1.4; color: rgba(243, 245, 248, 0.78); }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>\(escapedTitle)</h1>
            <p>\(escapedDetail)</p>
          </div>
        </body>
        </html>
        """
    }

    private func terminalHTML(lines: [String]) -> String {
        let renderedLines = lines.map(SurfAceANSI.html).joined(separator: "<br/>")
        return """
        <!doctype html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=3.0,user-scalable=yes" />
          <style>
            html, body { margin: 0; padding: 0; background: #0a0f14; color: #d4e8ff; }
            pre { margin: 0; padding: 18px; font-family: Menlo, SFMono-Regular, ui-monospace, monospace; font-size: 14px; line-height: 1.4; white-space: pre-wrap; word-break: break-word; }
          </style>
        </head>
        <body><pre>\(renderedLines)</pre></body>
        </html>
        """
    }

    private func escapeHTML(_ string: String) -> String {
        surfAceEscapeHTML(string)
    }

    private func extractPDFText(_ base64Data: String) -> String {
        guard let decoded = Data(base64Encoded: base64Data, options: [.ignoreUnknownCharacters]),
              let document = PDFDocument(data: decoded) else {
            return ""
        }
        return document.string ?? ""
    }

    private func randomStrokeID() -> String {
        var bytes = [UInt8](repeating: 0, count: 8)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        let hex: String
        if status == errSecSuccess {
            hex = bytes.map { String(format: "%02x", $0) }.joined()
        } else {
            hex = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        }
        return "stroke_\(hex)"
    }

    private func bridgeScript() -> String {
        #"""
        (function() {
          if (window.__surfAceBridgeInstalled) { return; }
          window.__surfAceBridgeInstalled = true;
          window.__surfAceScrollDebounce = 500;

          function cleanText(input) {
            return String(input || '').replace(/\s+/g, ' ').trim().slice(0, 4096);
          }

          function collectVisibleText() {
            const root = document.body || document.documentElement;
            function stripCssNoise(text) {
              return cleanText(String(text || '')
                .replace(/\/\*[\s\S]*?\*\//g, ' ')
                .replace(/\b[a-zA-Z0-9_.#:-]+\s*\{[^{}]*\}/g, ' '));
            }
            function extractFromSanitizedClone() {
              if (!root || !root.cloneNode) return '';
              const clone = root.cloneNode(true);
              if (!clone || !clone.querySelectorAll) return '';
              clone.querySelectorAll('style,script,noscript,template').forEach(function(el) { el.remove(); });
              return stripCssNoise(clone.innerText || '');
            }
            const sanitized = extractFromSanitizedClone();
            if (sanitized) return sanitized.slice(0, 4096);
            return stripCssNoise((document.body && document.body.innerText) || document.documentElement.innerText || '').slice(0, 4096);
          }

          function currentSelection() {
            const selection = window.getSelection();
            if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
            const text = cleanText(selection.toString());
            if (!text) return null;
            const range = selection.getRangeAt(0);
            const rect = range.getBoundingClientRect();
            return {
              kind: 'text',
              text: text,
              boundingRect: {
                x: rect.x + window.scrollX,
                y: rect.y + window.scrollY,
                width: rect.width,
                height: rect.height
              }
            };
          }

          window.__surfAceSnapshotPayload = function() {
            return {
              viewport: {
                scrollOffset: { x: window.scrollX || 0, y: window.scrollY || 0 },
                visibleRect: { x: window.scrollX || 0, y: window.scrollY || 0, width: window.innerWidth || 0, height: window.innerHeight || 0 },
                contentSize: {
                  width: Math.max(document.documentElement.scrollWidth || 0, document.body ? document.body.scrollWidth : 0),
                  height: Math.max(document.documentElement.scrollHeight || 0, document.body ? document.body.scrollHeight : 0)
                },
                zoomLevel: (window.visualViewport && window.visualViewport.scale) || 1
              },
              visibleText: collectVisibleText(),
              selection: currentSelection()
            };
          };

          function postSelectionIfAvailable() {
            const payload = window.__surfAceSnapshotPayload();
            if (payload && payload.selection && window.webkit?.messageHandlers?.surfAceSelection) {
              window.webkit.messageHandlers.surfAceSelection.postMessage(payload.selection);
            }
          }

          let scrollTimer = null;
          function postScrollSettled() {
            const payload = window.__surfAceSnapshotPayload();
            if (window.webkit?.messageHandlers?.surfAceScroll) {
              window.webkit.messageHandlers.surfAceScroll.postMessage(payload);
            }
          }

          function postTap(event, kind) {
            if (!event) return;
            const payload = {
              kind: kind,
              position: { x: (event.clientX || 0) + (window.scrollX || 0), y: (event.clientY || 0) + (window.scrollY || 0) },
              nearestContent: cleanText(event.target && event.target.innerText ? event.target.innerText : '').slice(0, 4096)
            };
            if (window.webkit?.messageHandlers?.surfAceTap) {
              window.webkit.messageHandlers.surfAceTap.postMessage(payload);
            }
          }

          function postNavigation(url) {
            if (!url) return;
            if (window.webkit?.messageHandlers?.surfAceNavigation) {
              window.webkit.messageHandlers.surfAceNavigation.postMessage({ url: String(url), sentAt: Date.now() });
            }
          }

          function postFocus() {
            if (window.webkit?.messageHandlers?.surfAceFocus) {
              window.webkit.messageHandlers.surfAceFocus.postMessage({});
            }
          }

          document.addEventListener('pointerdown', postFocus, { capture: true, passive: true });
          document.addEventListener('selectionchange', postSelectionIfAvailable);
          document.addEventListener('click', function(event) {
            const anchor = event && event.target && event.target.closest ? event.target.closest('a[href]') : null;
            if (anchor && anchor.href) {
              postNavigation(anchor.href);
              return;
            }
            postTap(event, 'tap');
          }, { passive: true });
          document.addEventListener('contextmenu', function(event) {
            postTap(event, 'long_press');
            event.preventDefault();
          });
          window.addEventListener('scroll', function() {
            clearTimeout(scrollTimer);
            scrollTimer = setTimeout(postScrollSettled, window.__surfAceScrollDebounce || 500);
          }, { passive: true });
        })();
        """#
    }
}
