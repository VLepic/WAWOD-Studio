const SESSION_KEY = "wawod-editor-session";
let fallbackSessionId: string | undefined;

export function getEditorSessionId() {
  if (fallbackSessionId) return fallbackSessionId;
  try {
    const existing = window.sessionStorage.getItem(SESSION_KEY);
    if (existing && /^[a-zA-Z0-9_-]+$/.test(existing)) {
      fallbackSessionId = existing;
      return existing;
    }
  } catch {
    // Editing must remain available when browser storage is disabled.
  }
  fallbackSessionId = globalThis.crypto?.randomUUID?.() ?? `editor_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  try {
    window.sessionStorage.setItem(SESSION_KEY, fallbackSessionId);
  } catch {}
  return fallbackSessionId;
}
