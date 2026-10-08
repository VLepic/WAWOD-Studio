import assert from "node:assert/strict";
import { buildSync } from "esbuild";

class MemoryStorage {
  data = new Map();
  getItem(key) { return this.data.get(key) ?? null; }
  setItem(key, value) { this.data.set(key, value); }
}
const localStorage = new MemoryStorage();
const sessionStorage = new MemoryStorage();
globalThis.window = { localStorage, sessionStorage, location: { hash: "" } };

// Bundle in memory so this suite runs against the real TypeScript without test artifacts.
const bundle = buildSync({
  stdin: { contents: `
    export * from './src/domain/viewport';
    export * from './src/domain/editor-session';
    export * from './src/domain/preview-window-sync';
    export * from './src/domain/project-recovery';
    export * from './src/domain/project-model';
    export * from './src/domain/project-serialization';
    export * from './src/store/project-store';
  `, resolveDir: process.cwd(), loader: "ts" },
  bundle: true, platform: "node", format: "esm", write: false,
}).outputFiles[0].text;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundle).toString("base64")}`;
const api = await import(moduleUrl);
const sessionId = api.getEditorSessionId();
assert.equal(api.getEditorSessionId(), sessionId);

const frame = { widthPx: 1280, heightPx: 720 };
const obstacles = [
  { left: 0, top: 0, right: 1280, bottom: 150 },
  { left: 0, top: 650, right: 1280, bottom: 720 },
  { left: 0, top: 150, right: 300, bottom: 650 },
  { left: 980, top: 150, right: 1280, bottom: 650 },
];
const usable = api.getUnobstructedRectangle(frame, obstacles);
assert.deepEqual(usable, { left: 300, top: 150, right: 980, bottom: 650 });
const fit = api.getViewportFit({ minX: -4, maxX: 4, minY: -3, maxY: 3 }, { widthPx: 680, heightPx: 500 }, 200, 24);
assert.ok(fit.zoom > 0 && 8 * 200 * fit.zoom <= 680 - 48);

const project = api.ensureProjectDefaults(api.createEmptyProject());
const json = api.stringifyProject(project);
const preview = { cameraMode: "Orbit", yawDeg: 0, pitchDeg: 30, distanceMultiplier: 2, targetOffset: [0, 0, 0], cameraPositionOffset: null, renderMode: "ArchitecturalJoin", surfaceMode: "LevelColor" };
const a = api.createPreviewWindowSnapshot(json, preview, ["level-a"]);
const b = api.createPreviewWindowSnapshot("other project", preview, []);
api.writePreviewWindowSnapshot(a, "editor-a");
api.writePreviewWindowSnapshot(b, "editor-b");
assert.equal(api.readPreviewWindowSnapshot("editor-a").projectJson, json);
assert.equal(api.readPreviewWindowSnapshot("editor-b").projectJson, "other project");
assert.equal(api.readPreviewWindowSnapshot(null), null);
assert.notEqual(api.previewChannelName("editor-a"), api.previewChannelName("editor-b"));
const previewUrl = new URL(api.createPreviewWindowUrl("http://localhost:4173/?test=1", "editor-a"));
assert.equal(api.getPreviewSessionId(previewUrl.hash), "editor-a");
assert.equal(api.isPreviewWindowHash(previewUrl.hash), true);
assert.equal(api.getPreviewSessionId("#/preview-3d?source=bad%2Fid"), null);

const baseline = api.useProjectStore.getState().project;
api.useProjectStore.getState().replaceProject({ ...baseline, projectName: "Recovery test" }, true);
assert.equal(api.useProjectStore.getState().draftStatus, "pending");
assert.equal(api.flushProjectDraft(), true);
assert.equal(api.useProjectStore.getState().isDirty, true);
assert.equal(api.readProjectDraft().projectJson.includes("Recovery test"), true);
const reloaded = await import(moduleUrl + "#reload");
assert.equal(reloaded.useProjectStore.getState().project.projectName, "Recovery test");
assert.equal(reloaded.useProjectStore.getState().isDirty, true);
assert.equal(reloaded.getEditorSessionId(), sessionId);
assert.equal(api.parseProjectDraft("not json"), null);
assert.equal(api.parseProjectDraft(JSON.stringify({ version: 1, projectJson: '{"walls":"invalid"}', savedProjectJson: json, updatedAtIso: "now" })), null);

api.useProjectStore.getState().markSaved();
api.flushProjectDraft();
assert.equal(api.useProjectStore.getState().isDirty, false);
assert.equal(api.readProjectDraft().savedProjectJson, api.readProjectDraft().projectJson);
window.localStorage = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
assert.equal(api.writeProjectDraft({ version: 1, projectJson: json, savedProjectJson: json, updatedAtIso: new Date().toISOString() }), true);
assert.equal(api.readProjectDraft().projectJson, json);
window.sessionStorage = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
assert.equal(api.writeProjectDraft({ version: 1, projectJson: json, savedProjectJson: json, updatedAtIso: "now" }), false);
assert.equal(api.readPreviewWindowSnapshot("editor-a"), null);
console.log("PASS: recovery, dirty/export baseline, storage fallback, scoped previews and unobstructed fit");
