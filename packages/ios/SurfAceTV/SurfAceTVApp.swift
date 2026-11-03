import SwiftUI

@main
struct SurfAceTVApp: App {
    @State private var runtime = SurfAceRuntime()
    var body: some Scene {
        WindowGroup {
            SurfAceTVRoot(runtime: runtime)
                .task {
                    let environment = ProcessInfo.processInfo.environment
                    guard environment["SURF_ACE_XCTEST_HOST_NO_AUTOSTART"] != "1",
                          environment["XCTestConfigurationFilePath"] == nil else { return }
                    await runtime.start()
                    if runtime.surfaces.isEmpty {
                        _ = await runtime.registerSurfaceForScene(sceneKey: "tv-main")
                    }
                }
        }
    }
}

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
            } else { Text("Connecting…") }
            if let error = runtime.endpointError { Text(error).font(.caption) }
        }
        .padding(30)
    }
}

struct SurfAceTVSurface: View {
    let runtime: SurfAceRuntime
    let surface: SurfAceSurfaceModel
    var body: some View {
        GeometryReader { geometry in
            let frames = paneFrames(surface.paneLayout, in: CGRect(origin: .zero, size: geometry.size))
            ZStack(alignment: .topLeading) {
                ForEach(surface.panes, id: \.paneId) { pane in
                    if let frame = frames[pane.paneId] {
                        SurfAceTVPane(runtime: runtime, surface: surface, pane: pane)
                            .frame(width: frame.width, height: frame.height)
                            .offset(x: frame.minX, y: frame.minY)
                    }
                }
            }
            .onAppear { runtime.updateViewport(surfaceId: surface.surfaceId, size: geometry.size, scale: 1) }
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
    @State private var cursor = CGPoint(x: 100, y: 100)
    @State private var activeStrokeId: String?
    @State private var points: [SurfAceStrokePoint] = []
    @State private var drawingControls = false
    var body: some View {
        VStack {
            Text("\(surface.windowLabel)\(pane.paneLabel > 0 ? String(pane.paneLabel) : "")")
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
                        ScrollView { Text(diagnostic.text).frame(maxWidth: .infinity, alignment: .leading) }
                        Button("Dismiss") { pane.htmlDiagnostic = nil }
                    }.padding().background(.black)
                }
            }
            if pane.htmlDiagnostic == nil {
                if drawingControls {
                    HStack {
                        Button(activeStrokeId == nil ? "Select to start stroke" : "Select to end stroke") {
                            guard pane.annotationMode else { return }
                            if activeStrokeId == nil {
                                activeStrokeId = UUID().uuidString
                                points = [point()]
                            } else { finishStroke() }
                        }
                        .onMoveCommand { direction in moveCursor(direction) }
                        Button("Done") {
                            finishStroke()
                            runtime.setAnnotationMode(surfaceId: surface.surfaceId, paneId: pane.paneId, enabled: false, fingerDrawEnabled: false, source: "remote_done")
                            drawingControls = false
                        }
                        Button("Back") { leaveDrawing() }
                    }
                    .onExitCommand { leaveDrawing() }
                } else {
                    HStack {
                        Button("Annotate") {
                            runtime.setAnnotationMode(surfaceId: surface.surfaceId, paneId: pane.paneId, enabled: true, fingerDrawEnabled: false, source: "remote")
                            drawingControls = true
                        }.disabled(pane.currentEntry.contentId == nil)
                        Button("Previous") { runtime.navigateHistory(surfaceId: surface.surfaceId, paneId: pane.paneId, direction: .back) }
                        Button("Next") { runtime.navigateHistory(surfaceId: surface.surfaceId, paneId: pane.paneId, direction: .forward) }
                        Button("−") { runtime.scalePaneContent(surfaceId: surface.surfaceId, paneId: pane.paneId, action: .decrease) }
                        Button("+") { runtime.scalePaneContent(surfaceId: surface.surfaceId, paneId: pane.paneId, action: .increase) }
                        if pane.currentEntry.contentType == .pdf {
                            Button("Page −") { pane.retainedHostView?.changePage(-1) }
                            Button("Page +") { pane.retainedHostView?.changePage(1) }
                        }
                    }.font(.caption)
                }
            }
            if let warning = pane.toast { Text(warning).font(.caption) }
        }.border(drawingControls ? .yellow : .gray)
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
