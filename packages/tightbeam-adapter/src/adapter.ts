import type {
  LocklessContentPush,
  LocklessPaneCloseIntent,
  LocklessPaneRestoreIntent,
  LocklessPaneSplitIntent,
  LocklessScopeId,
} from "@surf-ace/protocol";
import type {
  LocalConsumableRead,
} from "@surf-ace/controller";

export interface TightBeamControllerSession {
  closePane(surfaceId: string, input: LocklessPaneCloseIntent): Promise<unknown>;
  flushAcknowledgements(): Promise<void>;
  listSurfaces(): Promise<unknown>;
  openSurface(input: any): Promise<unknown>;
  push(surfaceId: string, input: LocklessContentPush): Promise<unknown>;
  readLocal(scopeId: LocklessScopeId): Promise<LocalConsumableRead>;
  requestLifecycle(op: string, payload: Record<string, unknown>): Promise<unknown>;
  requestSurface(surfaceId: string, op: string, payload: Record<string, unknown>): Promise<unknown>;
  restorePane(surfaceId: string, input: LocklessPaneRestoreIntent): Promise<unknown>;
  restoreSurface(tombstoneId: string, input: any): Promise<unknown>;
  closeSurface(surfaceId: string, input: any): Promise<unknown>;
  splitPane(surfaceId: string, input: LocklessPaneSplitIntent): Promise<unknown>;
  start(): Promise<unknown>;
  stop(): Promise<void>;
}

export type TightBeamAdapterTool =
  | "surf_ace_list"
  | "surf_ace_push"
  | "surf_ace_read"
  | "surf_ace_topology_intent"
  | "surf_ace_clear"
  | "surf_ace_annotations_remove"
  | "surf_ace_capture_pane"
  | "surf_ace_surface_intent"
  | "surf_ace_target_apply"
  | "surf_ace_target_register"
  | "surf_ace_topology_realize";

export class TightBeamSurfAceAdapter {
  constructor(
    private readonly session: TightBeamControllerSession,
  ) {}

  async start(): Promise<void> {
    await this.session.start();
  }

  async stop(): Promise<void> {
    await this.session.stop();
  }

  async call(tool: TightBeamAdapterTool, input: unknown): Promise<unknown> {
    const args = asRecord(input);
    switch (tool) {
      case "surf_ace_list":
        return await this.session.listSurfaces();
      case "surf_ace_push":
        return await this.session.push(requiredString(args, "surfaceId"), {
          content: args.content,
          contentId: requiredString(args, "contentId"),
          contentType: requiredString(args, "contentType"),
          display: optionalRecord(args.display),
          friendlyChatName: optionalString(args.friendlyChatName),
          paneId: requiredInteger(args, "paneId"),
        });
      case "surf_ace_read": {
        return await this.session.readLocal(
          requiredString(args, "scopeId") as LocklessScopeId,
        );
      }
      case "surf_ace_topology_intent":
        return await this.topologyIntent(args);
      case "surf_ace_clear":
        return await this.session.requestSurface(
          requiredString(args, "surfaceId"),
          "content.clear",
          {
            expectedRevision: requiredInteger(args, "expectedRevision"),
            paneId: requiredInteger(args, "paneId"),
          },
        );
      case "surf_ace_annotations_remove":
        return await this.session.requestSurface(
          requiredString(args, "surfaceId"),
          "annotations.remove",
          {
            contentId: requiredString(args, "contentId"),
            paneId: requiredInteger(args, "paneId"),
            strokeIds: requiredStringArray(args, "strokeIds"),
          },
        );
      case "surf_ace_capture_pane":
        return await this.session.requestSurface(
          requiredString(args, "surfaceId"),
          "snapshot.get",
          {
            includeDrawings: args.includeDrawings === true,
            includeImage: args.includeImage !== false,
            includeVisibleText: args.includeVisibleText !== false,
            paneId: requiredInteger(args, "paneId"),
          },
        );
      case "surf_ace_surface_intent":
        return await this.surfaceIntent(args);
      case "surf_ace_target_apply":
        return await this.session.requestSurface(
          requiredString(args, "surfaceId"),
          "target.apply",
          withoutLegacyOwnership(args),
        );
      case "surf_ace_target_register":
        return await this.session.requestSurface(
          requiredString(args, "surfaceId"),
          "target.register",
          withoutLegacyOwnership(args),
        );
      case "surf_ace_topology_realize":
        return await this.session.requestSurface(
          requiredString(args, "surfaceId"),
          "topology.apply",
          without(args, ["surfaceId"]),
        );
    }
  }

  private async topologyIntent(args: Record<string, unknown>): Promise<unknown> {
    const surfaceId = requiredString(args, "surfaceId");
    const expectedTopologyRevision = requiredInteger(
      args,
      "expectedTopologyRevision",
    );
    switch (requiredString(args, "action")) {
      case "split":
        return await this.session.splitPane(surfaceId, {
          count: requiredInteger(args, "count"),
          direction: requiredDirection(args.direction),
          expectedTopologyRevision,
          paneId: requiredInteger(args, "paneId"),
        });
      case "close":
        return await this.session.closePane(surfaceId, {
          expectedTopologyRevision,
          paneId: requiredInteger(args, "paneId"),
        });
      case "restore":
        return await this.session.restorePane(surfaceId, {
          anchorPaneId: requiredInteger(args, "anchorPaneId"),
          direction: requiredDirection(args.direction),
          expectedTopologyRevision,
          tombstoneId: requiredString(args, "tombstoneId"),
        });
      case "rename":
        return await this.session.requestSurface(surfaceId, "pane.rename", {
          expectedTopologyRevision,
          name: args.name === null ? null : requiredString(args, "name"),
          paneId: requiredInteger(args, "paneId"),
        });
      default:
        throw new Error("invalid_topology_action");
    }
  }

  private async surfaceIntent(args: Record<string, unknown>): Promise<unknown> {
    const action = requiredString(args, "action");
    if (action === "open" || action === "restore") {
      if (action === "open") {
        return await this.session.openSurface(without(args, ["action"]));
      }
      return await this.session.restoreSurface(
        requiredString(args, "tombstoneId"),
        without(args, ["action", "tombstoneId"]),
      );
    }
    if (action === "close") {
      const surfaceId = requiredString(args, "surfaceId");
      return await this.session.closeSurface(
        surfaceId,
        without(args, ["action", "surfaceId"]),
      );
    }
    throw new Error("invalid_surface_action");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid_tool_input");
  }
  return value as Record<string, unknown>;
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
): string {
  if (typeof value[key] !== "string" || value[key].length === 0) {
    throw new Error(`invalid_tool_input:${key}`);
  }
  return value[key] as string;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requiredInteger(
  value: Record<string, unknown>,
  key: string,
): number {
  if (!Number.isSafeInteger(value[key])) {
    throw new Error(`invalid_tool_input:${key}`);
  }
  return value[key] as number;
}

function requiredDirection(
  value: unknown,
): "horizontal" | "vertical" {
  if (value !== "horizontal" && value !== "vertical") {
    throw new Error("invalid_tool_input:direction");
  }
  return value;
}

function requiredStringArray(
  value: Record<string, unknown>,
  key: string,
): string[] {
  if (
    !Array.isArray(value[key]) ||
    !(value[key] as unknown[]).every((entry) => typeof entry === "string")
  ) {
    throw new Error(`invalid_tool_input:${key}`);
  }
  return value[key] as string[];
}

function without(
  value: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !keys.includes(key)),
  );
}

function withoutLegacyOwnership(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return without(value, [
    "connectionId",
    "ownershipEpoch",
    "ownershipSessionId",
    "providerId",
    "surfaceId",
  ]);
}
