import { projectSchema } from "./project-schemas";
import { getEditorSessionId } from "./editor-session";

const DRAFT_PREFIX = "wawod-project-draft:";
const LATEST_DRAFT_KEY = "wawod-latest-project-draft";

export interface ProjectDraft {
  version: 1;
  projectJson: string;
  savedProjectJson: string;
  updatedAtIso: string;
}

export function parseProjectDraft(source: string | null): ProjectDraft | null {
  if (!source) return null;
  try {
    const value = JSON.parse(source) as ProjectDraft;
    if (value.version !== 1 || typeof value.projectJson !== "string" ||
        typeof value.savedProjectJson !== "string" || typeof value.updatedAtIso !== "string") return null;
    projectSchema.parse(JSON.parse(value.projectJson));
    projectSchema.parse(JSON.parse(value.savedProjectJson));
    return value;
  } catch {
    return null;
  }
}

export function readProjectDraft(latest = false): ProjectDraft | null {
  const ownKey = DRAFT_PREFIX + getEditorSessionId();
  try {
    const key = latest ? window.localStorage.getItem(LATEST_DRAFT_KEY) : ownKey;
    if (key?.startsWith(DRAFT_PREFIX)) {
      const draft = parseProjectDraft(window.localStorage.getItem(key));
      if (draft) return draft;
    }
  } catch {}
  if (!latest) {
    try { return parseProjectDraft(window.sessionStorage.getItem(ownKey)); } catch {}
  }
  return null;
}

export function writeProjectDraft(draft: ProjectDraft) {
  const key = DRAFT_PREFIX + getEditorSessionId();
  const source = JSON.stringify(draft);
  let saved = false;
  try {
    window.localStorage.setItem(key, source);
    window.localStorage.setItem(LATEST_DRAFT_KEY, key);
    saved = true;
  } catch {}
  try {
    window.sessionStorage.setItem(key, source);
    saved = true;
  } catch {}
  return saved;
}
