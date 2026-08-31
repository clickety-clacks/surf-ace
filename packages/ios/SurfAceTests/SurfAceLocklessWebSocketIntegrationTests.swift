import Foundation
import XCTest
@testable import SurfAce

@MainActor
final class SurfAceLocklessWebSocketIntegrationTests: XCTestCase {
    func testResumeBarrierCannotRegisterInsideAnActiveDeliveryTurn() async throws {
        let suiteName = "SurfAceLocklessDeliveryGateTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        addTeardownBlock { defaults.removePersistentDomain(forName: suiteName) }
        let runtime = SurfAceRuntime(
            userDefaults: defaults,
            locklessStateURL: FileManager.default.temporaryDirectory
                .appendingPathComponent("unused-delivery-gate-\(UUID().uuidString).json")
        )
        let activeTurnEntered = expectation(description: "active delivery turn entered")
        let activeTurnRelease = SurfAceLocklessTestGate()
        let probe = SurfAceLocklessDeliveryGateProbe()

        let activeTurn = Task { @MainActor in
            await runtime.withLocklessDeliveryTurn {
                activeTurnEntered.fulfill()
                await activeTurnRelease.wait()
            }
        }
        await fulfillment(of: [activeTurnEntered], timeout: 1)

        let resumeBarrier = Task { @MainActor in
            await runtime.beginLocklessAdmissionDeliveryBarrier(connectionUUID: "resume-connection")
            probe.resumeBarrierRegistered = true
        }
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertFalse(probe.resumeBarrierRegistered)

        await activeTurnRelease.open()
        await activeTurn.value
        await resumeBarrier.value
        XCTAssertTrue(probe.resumeBarrierRegistered)

        let laterDelivery = Task { @MainActor in
            await runtime.withLocklessDeliveryTurn {
                probe.laterDeliveryEntered = true
            }
        }
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertFalse(probe.laterDeliveryEntered)

        runtime.endLocklessAdmissionDeliveryBarrier(connectionUUID: "resume-connection")
        await laterDelivery.value
        XCTAssertTrue(probe.laterDeliveryEntered)
    }

    func testAdmissionProjectionPrecedesItsReclamationEventOnTheWire() async throws {
        let identifier = UUID().uuidString
        let suiteName = "SurfAceLocklessReclamationOrderTests-\(identifier)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        let stateURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(suiteName).json")
        let store = SurfAceLocklessGenerationStore(stateURL: stateURL)
        var state = try SurfAceLocklessAuthorityState.empty()
        state.limits.maxAdmittedControllerEntries = 2
        try store.save(state)
        addTeardownBlock {
            defaults.removePersistentDomain(forName: suiteName)
            try? FileManager.default.removeItem(at: stateURL)
        }

        let pairResponseGate = SurfAceLocklessPairResponseSendGate(
            requestId: "pair-order-c"
        )
        let deliveryContention = expectation(description: "N+1 queued behind pair response")
        let runtime = SurfAceRuntime(
            userDefaults: defaults,
            locklessStateURL: stateURL,
            outboundSendPreparation: { text, priority in
                await pairResponseGate.prepareSend(text: text, priority: priority)
            },
            locklessDeliveryWaitObserver: {
                deliveryContention.fulfill()
            }
        )
        await runtime.start()
        let port = try XCTUnwrap(UInt16(exactly: runtime.serverPort))
        addTeardownBlock { await runtime.stop() }
        let registeredSurface = await runtime.registerSurfaceForScene(
            sceneKey: "reclamation-order-scene"
        )
        let surface = try XCTUnwrap(registeredSurface)
        let paneId = try XCTUnwrap(surface.panes.first?.paneId)

        let first = socket(port: port)
        let second = socket(port: port)
        let third = socket(port: port)
        first.resume()
        second.resume()
        third.resume()
        _ = try await pair(
            first, id: "pair-order-a", controllerId: "controller-order-a",
            surfaceId: surface.surfaceId
        )
        _ = try await pair(
            second, id: "pair-order-b", controllerId: "controller-order-b",
            surfaceId: surface.surfaceId
        )
        first.cancel(with: .goingAway, reason: nil)
        try await Task.sleep(for: .milliseconds(250))

        try await send(third, op: "pair.request", id: "pair-order-c", payload: [
            "controllerInstanceId": "controller-order-c",
            "controllerProductName": "integration-client",
            "projectionCapacityBytes": 8 * 1_024 * 1_024,
            "protocolFeatures": [surfAceLocklessCapability],
            "protocolVersion": 1,
            "surfaceId": surface.surfaceId,
        ])
        await pairResponseGate.waitUntilHeld()
        let afterReclamation = try await runtime.locklessReadinessSnapshot().state
        let reclamationOccurrence = try XCTUnwrap(
            afterReclamation.pendingControllerRetentionReclamations?.first
        )
        XCTAssertEqual(reclamationOccurrence.controllerInstanceId, "controller-order-a")

        try await send(second, op: "content.set", id: "mutation-after-reclamation", payload: [
            "content": ["html": "<main>after reclamation</main>"],
            "contentId": "content-after-reclamation",
            "contentType": "html",
            "friendlyChatName": "Reclamation Order",
            "paneId": paneId,
            "surfaceId": surface.surfaceId,
        ])
        await fulfillment(of: [deliveryContention], timeout: 2)
        let whileDeliveryBlocked = try await runtime.locklessReadinessSnapshot().state
        let mutationReceipt = try XCTUnwrap(
            whileDeliveryBlocked.controllers["controller-order-b"]?
                .pendingOperationReceipts["mutation-after-reclamation"]
        )
        XCTAssertGreaterThan(
            try XCTUnwrap(mutationReceipt.commitSequence),
            reclamationOccurrence.commitSequence
        )
        await pairResponseGate.release()

        let firstOnThird = try await receive(third)
        XCTAssertEqual(firstOnThird["id"] as? String, "pair-order-c")
        XCTAssertEqual(payload(firstOnThird)["mode"] as? String, "lockless")
        let reclamation = try await receive(
            third, matchingOp: "event.controller_retention_reclaimed"
        )
        XCTAssertEqual(
            payload(reclamation)["controllerInstanceId"] as? String,
            "controller-order-a"
        )
        XCTAssertFalse((reclamation["eventId"] as? String)?.isEmpty ?? true)
        let observerReclamation = try await receive(
            second, matchingOp: "event.controller_retention_reclaimed"
        )
        XCTAssertEqual(observerReclamation["eventId"] as? String, reclamation["eventId"] as? String)
        let laterCommit = try await receive(second, matchingOp: "event.lockless_content_committed")
        XCTAssertEqual(payload(laterCommit)["contentId"] as? String, "content-after-reclamation")
        let mutationResponse = try await receive(second, matchingId: "mutation-after-reclamation")
        XCTAssertEqual(
            (payload(mutationResponse)["operationReceipt"] as? [String: Any])?["requestId"] as? String,
            "mutation-after-reclamation"
        )

        second.cancel(with: .normalClosure, reason: nil)
        third.cancel(with: .normalClosure, reason: nil)
    }

    func testInvalidTargetIntentIsRejectedBeforeReceiptAndWorkAdmission() async throws {
        let identifier = UUID().uuidString
        let suiteName = "SurfAceLocklessTargetPreflightTests-\(identifier)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        let stateURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(suiteName).json")
        addTeardownBlock {
            defaults.removePersistentDomain(forName: suiteName)
            try? FileManager.default.removeItem(at: stateURL)
        }

        let runtime = SurfAceRuntime(userDefaults: defaults, locklessStateURL: stateURL)
        await runtime.start()
        let port = try XCTUnwrap(UInt16(exactly: runtime.serverPort))
        addTeardownBlock { await runtime.stop() }
        let registeredSurface = await runtime.registerSurfaceForScene(
            sceneKey: "target-preflight-scene"
        )
        let surface = try XCTUnwrap(registeredSurface)
        let paneId = try XCTUnwrap(surface.panes.first?.paneId)

        let controller = socket(port: port)
        controller.resume()
        _ = try await pair(
            controller,
            id: "target-preflight-pair",
            controllerId: "target-preflight-controller",
            surfaceId: surface.surfaceId
        )
        let before = try await runtime.locklessReadinessSnapshot().state
        let beforeReceipts = try XCTUnwrap(
            before.controllers["target-preflight-controller"]?.pendingOperationReceipts
        )
        let beforeReceiptBytes = beforeReceipts.values.reduce(Int64(0)) { $0 + $1.bytes }
        XCTAssertTrue(before.targetApplyWorkItems.isEmpty)
        XCTAssertTrue(before.targetApplyResults.isEmpty)

        try await send(controller, op: "target.apply", id: "invalid-target-operation", payload: [
            "paneId": paneId,
            "requestId": "invalid-target-request",
            "restoreReason": "initial",
            "surfaceId": surface.surfaceId,
            "targetEpoch": 1,
            "targetHeader": [
                "replaySemantics": "navigate",
                "requiredCapabilities": ["target.browser_url.v1"],
            ],
            "targetId": "invalid-target",
            "targetKind": "browser_url",
            "targetPayload": ["url": "file:///private/invalid-target"],
        ])
        let rejection = try await receive(controller, matchingId: "invalid-target-operation")
        XCTAssertEqual(rejection["ok"] as? Bool, false)
        XCTAssertEqual(
            (rejection["error"] as? [String: Any])?["code"] as? String,
            "invalid_payload"
        )
        XCTAssertEqual(
            ((rejection["error"] as? [String: Any])?["details"] as? [String: Any])?["targetErrorCode"] as? String,
            "unsafe_payload"
        )
        XCTAssertNil(payload(rejection)["operationReceipt"])

        try await send(controller, op: "operation.receipt.sync", id: "target-preflight-sync", payload: [
            "requestIds": ["invalid-target-operation"],
        ])
        let sync = try await receive(controller, matchingId: "target-preflight-sync")
        let resolutions = try XCTUnwrap(payload(sync)["resolutions"] as? [[String: Any]])
        XCTAssertEqual(resolutions.count, 1)
        XCTAssertEqual(resolutions[0]["outcome"] as? String, "not_committed")

        let after = try await runtime.locklessReadinessSnapshot().state
        let afterReceipts = try XCTUnwrap(
            after.controllers["target-preflight-controller"]?.pendingOperationReceipts
        )
        XCTAssertEqual(afterReceipts.count, beforeReceipts.count)
        XCTAssertEqual(
            afterReceipts.values.reduce(Int64(0)) { $0 + $1.bytes },
            beforeReceiptBytes
        )
        XCTAssertNil(afterReceipts["invalid-target-operation"])
        XCTAssertEqual(after.targetApplyWorkItems, before.targetApplyWorkItems)
        XCTAssertEqual(after.targetApplyResults, before.targetApplyResults)
        XCTAssertNil(
            after.liveSurfaces[surface.surfaceId]?.panes[String(paneId)]?.target
        )

        controller.cancel(with: .normalClosure, reason: nil)
    }

    func testTwoControllersShareAuthorityReceiptsReadsEventsAndReconnectLocklessly() async throws {
        let identifier = UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "SurfAceLocklessWebSocketIntegrationTests-\(identifier)"))
        defaults.removePersistentDomain(forName: "SurfAceLocklessWebSocketIntegrationTests-\(identifier)")
        let stateURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("SurfAceLocklessWebSocketIntegrationTests-\(identifier).json")
        addTeardownBlock {
            defaults.removePersistentDomain(forName: "SurfAceLocklessWebSocketIntegrationTests-\(identifier)")
            try? FileManager.default.removeItem(at: stateURL)
        }
        let runtime = SurfAceRuntime(userDefaults: defaults, locklessStateURL: stateURL)
        await runtime.start()
        XCTAssertNil(runtime.endpointError)
        let port = try XCTUnwrap(UInt16(exactly: runtime.serverPort))
        addTeardownBlock { await runtime.stop() }
        let registeredSurface = await runtime.registerSurfaceForScene(sceneKey: "integration-scene")
        let surface = try XCTUnwrap(registeredSurface)
        let paneId = try XCTUnwrap(surface.panes.first?.paneId)

        let first = socket(port: port)
        let second = socket(port: port)
        first.resume()
        second.resume()
        try await send(first, op: "surfaces.list", id: "discovery", payload: [:])
        let discovery = try await receive(first, matchingId: "discovery")
        let discoveryPayload = payload(discovery)
        let discoveryCapabilities = try XCTUnwrap(discoveryPayload["capabilities"] as? [String: Any])
        XCTAssertEqual(
            discoveryCapabilities["protocolFeatures"] as? [String], [surfAceLocklessCapability]
        )
        XCTAssertEqual(discoveryCapabilities["surfaceLifecycle"] as? Bool, true)
        let discoveryLimits = try XCTUnwrap(discoveryCapabilities["limits"] as? [String: Any])
        XCTAssertGreaterThan((discoveryLimits["maxPanesPerSurface"] as? NSNumber)?.intValue ?? 0, 0)
        XCTAssertNotNil(discoveryPayload["surfaceSetRevision"] as? NSNumber)
        XCTAssertNotNil(discoveryPayload["surfaceTombstones"] as? [[String: Any]])

        let firstPair = try await pair(first, id: "pair-a", controllerId: "controller-a", surfaceId: surface.surfaceId)
        let secondPair = try await pair(second, id: "pair-b", controllerId: "controller-b", surfaceId: surface.surfaceId)
        XCTAssertEqual(payload(firstPair)["mode"] as? String, "lockless")
        XCTAssertEqual(payload(secondPair)["mode"] as? String, "lockless")
        XCTAssertFalse((payload(firstPair)["scopes"] as? [[String: Any]])?.isEmpty ?? true)

        let unsupported = socket(port: port)
        unsupported.resume()
        try await send(unsupported, op: "pair.request", id: "unsupported-pair", payload: [
            "controllerInstanceId": "controller-unsupported",
            "controllerProductName": "integration-client",
            "protocolVersion": 1,
            "protocolFeatures": [],
            "surfaceId": surface.surfaceId,
        ])
        let unsupportedPair = try await receive(unsupported, matchingId: "unsupported-pair")
        XCTAssertEqual(unsupportedPair["ok"] as? Bool, false)
        XCTAssertEqual((unsupportedPair["error"] as? [String: Any])?["code"] as? String, "capability_mismatch")
        unsupported.cancel(with: .normalClosure, reason: nil)

        let malformedResume = socket(port: port)
        malformedResume.resume()
        try await send(malformedResume, op: "pair.request", id: "malformed-resume", payload: [
            "controllerInstanceId": "controller-malformed",
            "controllerProductName": "integration-client",
            "projectionCapacityBytes": 8 * 1_024 * 1_024,
            "protocolFeatures": [surfAceLocklessCapability],
            "protocolVersion": 1,
            "resume": [
                "pendingAcks": [],
                "scopes": ["surface:\(surface.surfaceId)": ["cursor": 1]],
            ],
            "surfaceId": surface.surfaceId,
        ])
        let malformedPair = try await receive(malformedResume, matchingId: "malformed-resume")
        XCTAssertEqual(malformedPair["ok"] as? Bool, false)
        XCTAssertEqual(
            (malformedPair["error"] as? [String: Any])?["code"] as? String,
            "invalid_payload"
        )
        malformedResume.cancel(with: .normalClosure, reason: nil)

        try await send(first, op: "heartbeat.ping", id: "heartbeat", payload: ["nonce": "native-nonce"])
        let heartbeat = try await receive(first, matchingId: "heartbeat")
        XCTAssertEqual(payload(heartbeat)["nonce"] as? String, "native-nonce")
        try await send(first, op: "heartbeat.ping", id: "heartbeat-empty", payload: ["nonce": ""])
        let invalidHeartbeat = try await receive(first, matchingId: "heartbeat-empty")
        XCTAssertEqual(invalidHeartbeat["ok"] as? Bool, false)
        XCTAssertEqual(
            (invalidHeartbeat["error"] as? [String: Any])?["code"] as? String,
            "invalid_payload"
        )

        try await send(first, op: "content.set", id: "mutation-a", payload: [
            "content": ["html": "<main>shared</main>"],
            "contentId": "content-a",
            "contentType": "html",
            "friendlyChatName": "Integration",
            "paneId": paneId,
            "surfaceId": surface.surfaceId,
        ])
        let mutation = try await receive(first, matchingId: "mutation-a")
        let mutationPayload = payload(mutation)
        let receipt = try XCTUnwrap(mutationPayload["operationReceipt"] as? [String: Any])
        XCTAssertEqual(receipt["requestId"] as? String, "mutation-a")
        XCTAssertNotNil(receipt["commitSequence"] as? NSNumber)

        let deltaEvent = try await receive(second, matchingOp: "event.lockless_consumable_delta")
        let deltaPayload = payload(deltaEvent)
        let scopeId = try XCTUnwrap(deltaPayload["scopeId"] as? String)
        XCTAssertFalse((deltaPayload["records"] as? [[String: Any]])?.isEmpty ?? true)
        _ = try await receive(second, matchingOp: "event.consumable_available")
        let event = try await receive(second, matchingOp: "event.lockless_content_committed")
        XCTAssertEqual(payload(event)["contentId"] as? String, "content-a")
        try await send(second, op: "panes.list", id: "read-b", payload: ["surfaceId": surface.surfaceId])
        let read = try await receive(second, matchingId: "read-b")
        let panes = try XCTUnwrap(payload(read)["panes"] as? [[String: Any]])
        XCTAssertTrue(panes.contains { ($0["history"] as? [String: Any])?["visible"] != nil })

        try await send(second, op: "consumable.sync", id: "sync-b", payload: ["scopeIds": [scopeId]])
        let secondSync = try await receive(second, matchingId: "sync-b")
        let secondScopes = try XCTUnwrap(payload(secondSync)["snapshots"] as? [[String: Any]])
        let secondRecords = try XCTUnwrap(secondScopes.first?["records"] as? [[String: Any]])
        let nextCursor = ((secondRecords.last?["sequence"] as? NSNumber)?.int64Value ?? 0) + 1
        try await send(second, op: "consumable.ack", id: "ack-b", payload: [
            "cursor": nextCursor, "scopeId": scopeId,
        ])
        _ = try await receive(second, matchingId: "ack-b")
        try await send(first, op: "consumable.sync", id: "sync-a", payload: ["scopeIds": [scopeId]])
        let firstSync = try await receive(first, matchingId: "sync-a")
        let firstScopes = try XCTUnwrap(payload(firstSync)["snapshots"] as? [[String: Any]])
        XCTAssertFalse((firstScopes.first?["records"] as? [[String: Any]])?.isEmpty ?? true)
        let firstCursor = try XCTUnwrap(firstScopes.first?["cursor"] as? [String: Any])
        let resumeCursor = try XCTUnwrap((firstCursor["cursor"] as? NSNumber)?.int64Value)

        try await send(first, op: "operation.receipt.sync", id: "receipt-sync", payload: [
            "requestIds": ["mutation-a", "missing"],
        ])
        let sync = try await receive(first, matchingId: "receipt-sync")
        let resolutions = try XCTUnwrap(payload(sync)["resolutions"] as? [[String: Any]])
        XCTAssertEqual(resolutions.count, 2)
        XCTAssertEqual(resolutions[0]["outcome"] as? String, "resolved_success")
        XCTAssertEqual(resolutions[1]["outcome"] as? String, "not_committed")

        // The mutation remains valid authority material, but its consumable record is
        // deliberately larger than maxConsumableRecordBytes. Both controllers must
        // observe the same structured loss while retaining independent cursors.
        try await send(first, op: "content.set", id: "mutation-oversize", payload: [
            "content": ["html": String(repeating: "x", count: 1_100_000)],
            "contentId": "content-oversize",
            "contentType": "html",
            "friendlyChatName": "Integration Oversize",
            "paneId": paneId,
            "surfaceId": surface.surfaceId,
        ])
        let oversizeMutation = try await receive(first, matchingId: "mutation-oversize")
        XCTAssertEqual(payload(oversizeMutation)["contentId"] as? String, "content-oversize")
        let overflow = try await receive(second, matchingOp: "event.consumable_overflow")
        let overflowGap = try XCTUnwrap(payload(overflow)["gap"] as? [String: Any])
        XCTAssertEqual(overflowGap["cause"] as? String, "record_oversize")
        _ = try await receive(second, matchingOp: "event.consumable_available")
        _ = try await receive(second, matchingOp: "event.lockless_content_committed")
        try await send(second, op: "consumable.sync", id: "gap-sync-b", payload: ["scopeIds": [scopeId]])
        let gapSync = try await receive(second, matchingId: "gap-sync-b")
        let gapScopes = try XCTUnwrap(payload(gapSync)["snapshots"] as? [[String: Any]])
        let gapCursor = try XCTUnwrap(gapScopes.first?["cursor"] as? [String: Any])
        XCTAssertEqual((gapCursor["gap"] as? [String: Any])?["cause"] as? String, "record_oversize")

        let healthURL = URL(string: "http://127.0.0.1:\(port)/health")!
        let (healthData, _) = try await URLSession.shared.data(from: healthURL)
        let health = try XCTUnwrap(JSONSerialization.jsonObject(with: healthData) as? [String: Any])
        XCTAssertEqual((health["busy"] as? NSNumber)?.intValue, 0)

        try await send(second, op: "target.apply", id: "target-operation", payload: [
            "paneId": paneId,
            "requestId": "target-request",
            "restoreReason": "initial",
            "surfaceId": surface.surfaceId,
            "targetEpoch": 1,
            "targetHeader": [
                "replaySemantics": "navigate",
                "requiredCapabilities": ["target.browser_url.v1"],
            ],
            "targetId": "target-a",
            "targetKind": "browser_url",
            "targetPayload": ["url": "https://example.com"],
        ])
        let targetIntent = try await receive(second, matchingId: "target-operation")
        XCTAssertEqual(payload(targetIntent)["status"] as? String, "intent_committed")
        let targetResult = try await receive(second, matchingOp: "event.target_apply_result")
        let targetResultPayload = payload(targetResult)
        XCTAssertEqual(targetResultPayload["operationRequestId"] as? String, "target-operation")
        XCTAssertFalse((targetResultPayload["recordId"] as? String)?.isEmpty ?? true)
        XCTAssertGreaterThan(
            (targetResultPayload["consumableSequence"] as? NSNumber)?.int64Value ?? 0, 0
        )

        first.cancel(with: .goingAway, reason: nil)
        try await Task.sleep(for: .milliseconds(250))
        let resumed = socket(port: port)
        resumed.resume()
        let resumedPair = try await pair(
            resumed,
            id: "pair-a-resume",
            controllerId: "controller-a",
            surfaceId: surface.surfaceId,
            resume: [
                "pendingAcks": [["cursor": resumeCursor, "scopeId": scopeId]],
                "scopes": [scopeId: ["cursor": resumeCursor, "gapGeneration": 0]],
                "unresolvedRequestIds": ["mutation-a", "missing-after-reconnect"],
            ]
        )
        XCTAssertEqual(payload(resumedPair)["resumed"] as? Bool, true)
        let resumedResolutions = try XCTUnwrap(
            payload(resumedPair)["receiptResolutions"] as? [[String: Any]]
        )
        XCTAssertEqual(resumedResolutions.map { $0["outcome"] as? String }, [
            "resolved_success", "not_committed",
        ])
        XCTAssertEqual(
            ((resumedResolutions[0]["terminalResponse"] as? [String: Any])?["payload"] as? [String: Any])?["contentId"] as? String,
            "content-a"
        )
        let resumedScopes = try XCTUnwrap(payload(resumedPair)["scopes"] as? [[String: Any]])
        let resumedScope = try XCTUnwrap(resumedScopes.first { $0["scopeId"] as? String == scopeId })
        XCTAssertGreaterThanOrEqual(
            ((resumedScope["cursor"] as? [String: Any])?["cursor"] as? NSNumber)?.int64Value ?? 0,
            resumeCursor
        )
        try await send(resumed, op: "consumable.sync", id: "gap-sync-a-resumed", payload: ["scopeIds": [scopeId]])
        let resumedGapSync = try await receive(resumed, matchingId: "gap-sync-a-resumed")
        let resumedGapScopes = try XCTUnwrap(payload(resumedGapSync)["snapshots"] as? [[String: Any]])
        let resumedGapCursor = try XCTUnwrap(resumedGapScopes.first?["cursor"] as? [String: Any])
        XCTAssertEqual(
            (resumedGapCursor["gap"] as? [String: Any])?["cause"] as? String,
            "record_oversize"
        )
        resumed.cancel(with: .normalClosure, reason: nil)
        second.cancel(with: .normalClosure, reason: nil)
        try await Task.sleep(for: .milliseconds(250))

        await runtime.unregisterSurfaceForScene(sceneKey: "integration-scene")
        let discoveryAfterLastSurface = socket(port: port)
        discoveryAfterLastSurface.resume()
        try await send(
            discoveryAfterLastSurface,
            op: "surfaces.list",
            id: "discovery-zero-live",
            payload: [:]
        )
        let zeroLiveDiscovery = try await receive(
            discoveryAfterLastSurface,
            matchingId: "discovery-zero-live"
        )
        let zeroLivePayload = payload(zeroLiveDiscovery)
        XCTAssertEqual((zeroLivePayload["surfaces"] as? [[String: Any]])?.count, 0)
        XCTAssertTrue(
            (zeroLivePayload["surfaceTombstones"] as? [[String: Any]])?.contains(where: {
                (($0["surface"] as? [String: Any])?["surfaceId"] as? String) == surface.surfaceId
            }) ?? false
        )
        XCTAssertEqual(
            ((zeroLivePayload["capabilities"] as? [String: Any])?["protocolFeatures"] as? [String]),
            [surfAceLocklessCapability]
        )
        XCTAssertNotNil(zeroLivePayload["surfaceSetRevision"] as? NSNumber)
        discoveryAfterLastSurface.cancel(with: .normalClosure, reason: nil)
    }

    private func socket(port: UInt16) -> URLSessionWebSocketTask {
        let task = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)/ws")!)
        task.maximumMessageSize = 12 * 1_024 * 1_024
        return task
    }

    private func pair(
        _ socket: URLSessionWebSocketTask,
        id: String,
        controllerId: String,
        surfaceId: String,
        resume: [String: Any]? = nil
    ) async throws -> [String: Any] {
        var pairPayload: [String: Any] = [
            "controllerInstanceId": controllerId,
            "controllerProductName": "integration-client",
            "projectionCapacityBytes": 8 * 1_024 * 1_024,
            "protocolFeatures": [surfAceLocklessCapability],
            "protocolVersion": 1,
            "surfaceId": surfaceId,
        ]
        pairPayload["resume"] = resume
        try await send(socket, op: "pair.request", id: id, payload: pairPayload)
        return try await receive(socket, matchingId: id)
    }

    private func send(
        _ socket: URLSessionWebSocketTask,
        op: String,
        id: String,
        payload: [String: Any]
    ) async throws {
        let data = try JSONSerialization.data(withJSONObject: [
            "id": id, "op": op, "payload": payload, "sentAt": 1,
            "type": "request", "v": 1,
        ])
        try await socket.send(.string(String(decoding: data, as: UTF8.self)))
    }

    private func receive(
        _ socket: URLSessionWebSocketTask,
        matchingId: String? = nil,
        matchingOp: String? = nil
    ) async throws -> [String: Any] {
        for _ in 0..<20 {
            let message = try await withThrowingTaskGroup(
                of: URLSessionWebSocketTask.Message.self
            ) { group in
                group.addTask { try await socket.receive() }
                group.addTask {
                    try await Task.sleep(for: .seconds(5))
                    throw SurfAceLocklessIntegrationError.messageTimeout
                }
                let first = try await group.next()!
                group.cancelAll()
                return first
            }
            let data: Data
            switch message {
            case .string(let text): data = Data(text.utf8)
            case .data(let bytes): data = bytes
            @unknown default: continue
            }
            guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            if let matchingId, object["id"] as? String != matchingId { continue }
            if let matchingOp, object["op"] as? String != matchingOp { continue }
            return object
        }
        XCTFail("No matching WebSocket message")
        return [:]
    }

    private func payload(_ response: [String: Any]) -> [String: Any] {
        response["payload"] as? [String: Any] ?? [:]
    }

}

private enum SurfAceLocklessIntegrationError: Error {
    case messageTimeout
}

@MainActor
private final class SurfAceLocklessDeliveryGateProbe {
    var laterDeliveryEntered = false
    var resumeBarrierRegistered = false
}

private actor SurfAceLocklessTestGate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        guard !isOpen else { return }
        await withCheckedContinuation { continuation in
            waiters.append(continuation)
        }
    }

    func open() {
        isOpen = true
        let pending = waiters
        waiters.removeAll()
        pending.forEach { $0.resume() }
    }
}

private actor SurfAceLocklessPairResponseSendGate {
    private let requestId: String
    private var held = false
    private var heldWaiters: [CheckedContinuation<Void, Never>] = []
    private let releaseGate = SurfAceLocklessTestGate()

    init(requestId: String) {
        self.requestId = requestId
    }

    func prepareSend(text: String, priority: SurfAceOutboundSender.Priority) async {
        guard priority == .response,
              let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["id"] as? String == requestId else { return }
        held = true
        let waiters = heldWaiters
        heldWaiters.removeAll()
        waiters.forEach { $0.resume() }
        await releaseGate.wait()
    }

    func waitUntilHeld() async {
        guard !held else { return }
        await withCheckedContinuation { continuation in
            heldWaiters.append(continuation)
        }
    }

    func release() async {
        await releaseGate.open()
    }
}
