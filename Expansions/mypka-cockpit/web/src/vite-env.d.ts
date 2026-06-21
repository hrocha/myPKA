/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Optional per-instance valence map for the Mind "patterns" cards, as a JSON
   * string: { "<topic-slug>": { "tone": "good|watch|strain|neutral", "label": "..." } }.
   * Empty / unset → no slug is coloured (calm, honest default). See src/lib/valence.ts.
   */
  readonly VITE_MIND_VALENCE_MAP?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
