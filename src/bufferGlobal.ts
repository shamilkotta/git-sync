import { Buffer } from "buffer";

const g = globalThis as unknown as { Buffer?: typeof Buffer };
if (g.Buffer === undefined) {
  g.Buffer = Buffer;
}
