import type { Preview3DState } from "../store/editor-ui-store";

export const PREVIEW_WINDOW_HASH = "#/preview-3d";
export const PREVIEW_SYNC_CHANNEL = "wawod-studio-preview";
export const PREVIEW_SNAPSHOT_STORAGE_KEY = "wawod-studio-preview-snapshot";

export interface PreviewWindowSnapshot {
  projectJson: string;
  preview3D: Preview3DState;
  hiddenLevelIds3D: string[];
  hiddenRoofLayerIds3D: string[];
  updatedAtIso: string;
}

export interface PreviewSnapshotMessage {
  type: "project-snapshot";
  sourceId: string;
  snapshot: PreviewWindowSnapshot;
}

export interface PreviewSnapshotRequestMessage {
  type: "request-project-snapshot";
  sourceId: string;
}

export type PreviewWindowMessage = PreviewSnapshotMessage | PreviewSnapshotRequestMessage;

export function getPreviewSessionId(hash = window.location.hash) {
  const session = new URLSearchParams(hash.split("?")[1] ?? "").get("source");
  return session && /^[a-zA-Z0-9_-]+$/.test(session) ? session : null;
}

export function previewStorageKey(sessionId: string) {
  return `${PREVIEW_SNAPSHOT_STORAGE_KEY}:${sessionId}`;
}

export function previewChannelName(sessionId: string) {
  return `${PREVIEW_SYNC_CHANNEL}:${sessionId}`;
}

export function createPreviewWindowUrl(currentUrl: string, sessionId: string) {
  const url = new URL(currentUrl);
  url.hash = `${PREVIEW_WINDOW_HASH}?source=${encodeURIComponent(sessionId)}`;
  return url.toString();
}

export function isPreviewWindowHash(hash: string) {
  return hash.split("?")[0] === PREVIEW_WINDOW_HASH;
}

export function createPreviewWindowSnapshot(
  projectJson: string,
  preview3D: Preview3DState,
  hiddenLevelIds3D: string[],
  hiddenRoofLayerIds3D: string[] = [],
): PreviewWindowSnapshot {
  return {
    projectJson,
    preview3D: { ...preview3D },
    hiddenLevelIds3D: [...hiddenLevelIds3D],
    hiddenRoofLayerIds3D: [...hiddenRoofLayerIds3D],
    updatedAtIso: new Date().toISOString(),
  };
}

export function writePreviewWindowSnapshot(snapshot: PreviewWindowSnapshot, sessionId: string) {
  try {
    window.localStorage.setItem(previewStorageKey(sessionId), JSON.stringify(snapshot));
  } catch {
    // BroadcastChannel still supports live preview when storage is unavailable.
  }
}

export function readPreviewWindowSnapshot(sessionId: string | null) {
  if (!sessionId) return null;
  let rawValue: string | null;
  try { rawValue = window.localStorage.getItem(previewStorageKey(sessionId)); } catch { return null; }
  if (!rawValue) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawValue) as Partial<PreviewWindowSnapshot>;
    if (
      typeof parsed.projectJson !== "string" ||
      typeof parsed.updatedAtIso !== "string" ||
      parsed.preview3D === undefined ||
      !Array.isArray(parsed.hiddenLevelIds3D)
    ) {
      return null;
    }

    return {
      ...(parsed as PreviewWindowSnapshot),
      hiddenRoofLayerIds3D: Array.isArray(parsed.hiddenRoofLayerIds3D)
        ? parsed.hiddenRoofLayerIds3D
        : [],
    };
  } catch {
    return null;
  }
}
