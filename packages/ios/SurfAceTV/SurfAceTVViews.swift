import SwiftUI

struct SurfAceTVRoot: View {
    let runtime: SurfAceRuntime
    @State private var selectedSurface: String?
    var body: some View {
        VStack {
            HStack {
                Text("Surf Ace")
                ForEach(runtime.surfaces, id: \.surfaceId) { surface in
                    Button(surface.windowLabel.isEmpty ? surface.name : surface.windowLabel) {
                        selectedSurface = surface.surfaceId
                    }
                }
            }
            if let surface = runtime.surfaces.first(where: { $0.surfaceId == selectedSurface }) ?? runtime.surfaces.first {
                SurfAceTVSurface(runtime: runtime, surface: surface)
                    .id(surface.surfaceId)
            } else { Text("Connecting…") }
            if let error = runtime.endpointError { Text(error).font(.caption) }
        }
        .padding(30)
    }
}

struct SurfAceTVSurface: View {
    let runtime: SurfAceRuntime
    let surface: SurfAceSurfaceModel
    @State private var arrangement: SurfAceTVArrangement?
    @State private var arrangementError: String?
    @State private var expandedPaneId: Int?
    var body: some View {
      VStack {
        if arrangement != nil {
            VStack {
              HStack {
                ForEach(SurfAceTVArrangement.Action.allCases, id: \.self) { action in
                    Button(action.rawValue.capitalized) { arrangement?.action = action }
                }
                Button("Pane \(arrangement?.paneId ?? 0)") { cyclePane(target: false) }
                Button("Beside \(arrangement?.targetPaneId ?? 0)") { cyclePane(target: true) }
              }
              HStack {
                SurfAceTVRemoteControl(title: "Preview — Select edits; Play/Pause confirms", move: { direction in
                        if arrangement?.action == .resize {
                            let delta = direction == .left || direction == .up ? -0.05 : 0.05
                            arrangement?.fraction = min(0.9, max(0.1, (arrangement?.fraction ?? 0.5) + delta))
                        } else {
                            arrangement?.direction = direction == .up || direction == .down ? .vertical : .horizontal
                            arrangement?.before = direction == .left || direction == .up
                        }
                    }, select: {}, done: { confirmArrangement() }, back: { arrangement = nil })
                    .frame(height: 80)
                Button("Confirm") { confirmArrangement() }
                Button("Cancel") { arrangement = nil }
              }
            }.font(.caption)
              .onExitCommand { arrangement = nil }
        } else {
            Button("Arrange panes") {
                guard let first = surface.panes.first else { return }
                expandedPaneId = nil
                arrangement = .init(original: surface.paneLayout, expectedRevision: Int64(surface.topologyEpoch),
                    paneId: first.paneId, targetPaneId: surface.panes.dropFirst().first?.paneId ?? first.paneId)
            }.frame(maxWidth: .infinity).focusSection()
        }
        if let arrangementError { Text(arrangementError) }
        GeometryReader { geometry in
            let frames = expandedPaneId.map { [$0: CGRect(origin: .zero, size: geometry.size)] }
                ?? paneFrames(arrangement?.preview ?? surface.paneLayout, in: CGRect(origin: .zero, size: geometry.size))
            ZStack(alignment: .topLeading) {
                if let frame = frames[-1] {
                    Text("New pane preview").frame(width: frame.width, height: frame.height)
                        .background(.gray.opacity(0.2)).offset(x: frame.minX, y: frame.minY)
                }
                ForEach(surface.panes, id: \.paneId) { pane in
                    if let frame = frames[pane.paneId] {
                        SurfAceTVPane(runtime: runtime, surface: surface, pane: pane,
                            showControls: arrangement == nil && (surface.panes.count == 1 || expandedPaneId == pane.paneId),
                            isExpanded: expandedPaneId == pane.paneId,
                            toggleExpansion: { expandedPaneId = expandedPaneId == pane.paneId ? nil : pane.paneId })
                            .frame(width: frame.width, height: frame.height)
                            .offset(x: frame.minX, y: frame.minY)
                    }
                }
            }
            .onAppear { runtime.updateViewport(surfaceId: surface.surfaceId, size: geometry.size, scale: 1) }
            .onChange(of: geometry.size) { _, size in runtime.updateViewport(surfaceId: surface.surfaceId, size: size, scale: 1) }
        }
      }.onChange(of: surface.topologyEpoch) { _, _ in arrangement = nil }
    }
    private func cyclePane(target: Bool) {
        let ids = surface.panes.map(\.paneId)
        guard !ids.isEmpty else { return }
        let current = target ? arrangement?.targetPaneId : arrangement?.paneId
        let next = ids[((ids.firstIndex { $0 == current } ?? 0) + 1) % ids.count]
        if target { arrangement?.targetPaneId = next } else { arrangement?.paneId = next }
    }
    private func confirmArrangement() {
        guard let preview = arrangement else { return }
        arrangement = nil
        Task { @MainActor in
            do {
                try await runtime.confirmTVArrangement(surfaceId: surface.surfaceId, preview: preview)
                arrangementError = nil
            } catch { arrangementError = "Arrangement was not saved: \(error.localizedDescription)" }
        }
    }

    private func paneFrames(_ node: SurfAcePaneLayoutNode, in bounds: CGRect) -> [Int: CGRect] {
        switch node {
        case .empty: return [:]
        case .leaf(let id, _): return [id: bounds]
        case .split(let direction, let children, _):
            let total = children.reduce(0.0) { $0 + $1.layoutWeight }
            var position: CGFloat = 0
            var result: [Int: CGRect] = [:]
            for child in children {
                let horizontal = direction == .horizontal
                let extent = (horizontal ? bounds.width : bounds.height) * child.layoutWeight / total
                let frame = horizontal
                    ? CGRect(x: bounds.minX + position, y: bounds.minY, width: extent, height: bounds.height)
                    : CGRect(x: bounds.minX, y: bounds.minY + position, width: bounds.width, height: extent)
                result.merge(paneFrames(child, in: frame)) { _, new in new }
                position += extent
            }
            return result
        }
    }
}

struct SurfAceTVPane: View {
    let runtime: SurfAceRuntime
    let surface: SurfAceSurfaceModel
    let pane: SurfAcePaneModel
    let showControls: Bool
    let isExpanded: Bool
    let toggleExpansion: () -> Void
    @State private var cursor = CGPoint.zero
    @State private var activeStrokeId: String?
    @State private var points: [SurfAceStrokePoint] = []
    @State private var drawingControls = false
    @State private var scrollingControls = false
    var body: some View {
        VStack {
            Button {
                toggleExpansion()
            } label: {
                Text("\(surface.windowLabel)\(pane.paneLabel > 0 ? String(pane.paneLabel) : "") \(isExpanded ? "Restore" : "Pane \(pane.paneId)")")
            }.font(.caption)
            ZStack {
                SurfAceTVNativePane(runtime: runtime, surface: surface, pane: pane)
                if drawingControls && pane.htmlDiagnostic == nil {
                    GeometryReader { _ in
                        Circle().stroke(.yellow, lineWidth: 3).frame(width: 18, height: 18)
                            .position(cursor)
                    }.allowsHitTesting(false)
                }
                if let diagnostic = pane.htmlDiagnostic {
                    VStack {
                        Text(diagnostic.warning).font(.headline)
                        ScrollView { Text(diagnostic.text).frame(maxWidth: .infinity, alignment: .leading).focusable() }
                        Button("Dismiss") { pane.htmlDiagnostic = nil }
                    }.padding().background(.black)
                }
            }
            if showControls && pane.htmlDiagnostic == nil {
                if scrollingControls {
                    SurfAceTVRemoteControl(title: "Select to pan — arrows move, Back exits", move: { direction in
                        let dx: CGFloat = direction == .left ? -60 : direction == .right ? 60 : 0
                        let dy: CGFloat = direction == .up ? -60 : direction == .down ? 60 : 0
                        pane.retainedHostView?.moveViewport(dx: dx, dy: dy)
                        Task { @MainActor in
                            if let snapshot = await pane.retainedHostView?.fetchSnapshotMetadata() {
                                runtime.handleScrollSettled(surfaceId: surface.surfaceId, paneId: pane.paneId, viewport: snapshot.viewport, visibleText: pane.retainedHostView?.visibleText ?? "")
                            }
                        }
                    }, select: {}, done: { scrollingControls = false }, back: { scrollingControls = false })
                    .frame(height: 80)
                } else if drawingControls {
                    HStack {
                        SurfAceTVRemoteControl(title: activeStrokeId == nil ? "Select starts stroke; Play/Pause finishes" : "Select ends stroke; Play/Pause finishes", move: moveCursor, select: {
                            guard pane.annotationMode else { return }
                            if activeStrokeId == nil {
                                activeStrokeId = UUID().uuidString
                                points = [point()]
                            } else { finishStroke() }
                        }, done: doneDrawing, back: leaveDrawing)
                        .frame(height: 80)
                        Button("Done") { doneDrawing() }.disabled(pane.annotationDonePending)
                        Button("Back") { leaveDrawing() }
                    }
                    .onExitCommand { leaveDrawing() }
                } else {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 150, maximum: 220))], spacing: 12) {
                        Button("Annotate") {
                            if let bounds = pane.retainedHostView?.bounds {
                                cursor = CGPoint(x: bounds.midX, y: bounds.midY)
                            }
                            runtime.setAnnotationMode(surfaceId: surface.surfaceId, paneId: pane.paneId, enabled: true, fingerDrawEnabled: false, source: "remote")
                            drawingControls = true
                        }.disabled(pane.currentEntry.contentId == nil || pane.annotationDonePending)
                        if pane.annotationMode {
                            Button("Done") {
                                runtime.setAnnotationMode(surfaceId: surface.surfaceId, paneId: pane.paneId, enabled: false, fingerDrawEnabled: false, source: "remote_done")
                            }
                        }
                        Button("Scroll / pan") { scrollingControls = true }.disabled(pane.annotationMode)
                        Button("Previous") { runtime.navigateHistory(surfaceId: surface.surfaceId, paneId: pane.paneId, direction: .back) }
                        Button("Next") { runtime.navigateHistory(surfaceId: surface.surfaceId, paneId: pane.paneId, direction: .forward) }
                        Button("Reset scale") { runtime.scalePaneContent(surfaceId: surface.surfaceId, paneId: pane.paneId, action: .reset) }
                        Button("−") { runtime.scalePaneContent(surfaceId: surface.surfaceId, paneId: pane.paneId, action: .decrease) }
                        Button("+") { runtime.scalePaneContent(surfaceId: surface.surfaceId, paneId: pane.paneId, action: .increase) }
                        if pane.currentEntry.contentType == .pdf {
                            Button("Page −") { pane.retainedHostView?.changePage(-1) }
                            Button("Page +") { pane.retainedHostView?.changePage(1) }
                        }
                    }.font(.caption)
                }
            }
            if pane.currentEntry.contentType == .pdf, let page = pane.lastPage {
                Text("Page \(page.page) of \(page.totalPages)").font(.caption)
            }
            if let warning = pane.toast { Text(warning).font(.caption) }
        }.border(drawingControls ? .yellow : .gray)
    }

    private func doneDrawing() {
        finishStroke()
        runtime.setAnnotationMode(surfaceId: surface.surfaceId, paneId: pane.paneId, enabled: false, fingerDrawEnabled: false, source: "remote_done")
        drawingControls = false
    }
    private func point() -> SurfAceStrokePoint {
        .init(x: cursor.x, y: cursor.y, pressure: nil, timestamp: Int64(Date().timeIntervalSince1970 * 1000))
    }
    private func moveCursor(_ direction: MoveCommandDirection) {
        guard pane.htmlDiagnostic == nil, let view = pane.retainedHostView else { return }
        switch direction {
        case .left: cursor.x -= 8
        case .right: cursor.x += 8
        case .up: cursor.y -= 8
        case .down: cursor.y += 8
        @unknown default: break
        }
        cursor.x = max(0, min(view.bounds.width, cursor.x))
        cursor.y = max(0, min(view.bounds.height, cursor.y))
        if let id = activeStrokeId {
            points.append(point())
            let stroke = SurfAceStroke(strokeId: id, points: points, tool: "pen")
            _ = view.restoreDrawingStrokes(view.strokes.filter { $0.strokeId != id } + [stroke])
        }
    }
    private func finishStroke() {
        guard pane.htmlDiagnostic == nil, let id = activeStrokeId, let view = pane.retainedHostView else { return }
        let stroke = SurfAceStroke(strokeId: id, points: points, tool: "pen")
        _ = view.restoreDrawingStrokes(view.strokes.filter { $0.strokeId != id } + [stroke])
        runtime.handleNewStrokes(surfaceId: surface.surfaceId, paneId: pane.paneId, strokes: [stroke], drawingData: view.captureDrawingData())
        points = []
        activeStrokeId = nil
    }
    private func leaveDrawing() {
        finishStroke()
        // Leave editing controls without invoking Done or discarding saved strokes.
        drawingControls = false
    }
}

struct SurfAceTVNativePane: UIViewRepresentable {
    let runtime: SurfAceRuntime
    let surface: SurfAceSurfaceModel
    let pane: SurfAcePaneModel
    func makeUIView(context: Context) -> SurfAceTVPaneView {
        if let view = pane.retainedHostView { return view }
        let view = SurfAceTVPaneView()
        pane.retainedHostView = view
        view.onWarning = { [weak pane] in pane?.toast = $0 }
        view.onPage = { page, count in
            runtime.handlePDFPageChanged(surfaceId: surface.surfaceId, paneId: pane.paneId, page: page, totalPages: count, pageText: nil)
        }
        runtime.attachPaneBridge(surfaceId: surface.surfaceId, paneId: pane.paneId, bridge: view)
        return view
    }
    func updateUIView(_ view: SurfAceTVPaneView, context: Context) {}
}
