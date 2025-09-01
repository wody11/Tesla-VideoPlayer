// Minimal global type shims for environment types used in the project
// Some browsers/TS versions may not include VideoFrame in lib.dom, provide a lightweight shim.
interface VideoFrame {
  readonly timestamp?: number | undefined;
  close(): void;
}

// Ensure ImageBitmap exists for older TS setups (it's usually present in lib.dom)
interface ImageBitmap {}
