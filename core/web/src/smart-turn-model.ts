import * as ort from "onnxruntime-web/wasm";
import { MEL_BINS, MEL_FRAMES, whisperFeatures } from "./smart-turn";

/** The model file, as web/scripts/copy-vad-assets.mjs puts it into voice-assets. */
export const SMART_TURN_FILE = "smart-turn-v3.2-cpu.onnx";

/**
 * Smart Turn v3.2 on ONNX Runtime's WebAssembly build, the one Silero runs on:
 * gives the probability that the turn in an 8 s window is complete.
 */
export async function smartTurnModel(model: Uint8Array, wasmPaths: string): Promise<(window: Float32Array) => Promise<number>> {
  ort.env.wasm.wasmPaths = wasmPaths;
  // Several threads need a cross-origin isolated page, which the portal is not.
  ort.env.wasm.numThreads = 1;
  const session = await ort.InferenceSession.create(model);
  return async window => {
    const input = new ort.Tensor("float32", whisperFeatures(window), [1, MEL_BINS, MEL_FRAMES]);
    const output = await session.run({ input_features: input });
    // The model ends in a sigmoid: this is the probability itself.
    return (output[session.outputNames[0]].data as Float32Array)[0];
  };
}
