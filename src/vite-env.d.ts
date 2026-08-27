/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CODEX_GATEWAY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
