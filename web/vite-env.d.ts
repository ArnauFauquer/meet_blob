/// <reference types="vite/client" />

// Page version, injected at build from the backend __version__ (see vite.config.ts).
declare const __BLOB_VERSION__: string;

declare module '*.frag?raw' {
  const src: string;
  export default src;
}
declare module '*.vert?raw' {
  const src: string;
  export default src;
}
