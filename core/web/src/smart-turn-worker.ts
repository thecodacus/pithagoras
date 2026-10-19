import { SMART_TURN_FILE, smartTurnModel } from "./smart-turn-model";

/**
 * Smart Turn, away from the page: a check takes about 200 ms of computing in
 * WebAssembly, which on the page would stall the orb and Silero's frames.
 */
const scope = self as unknown as { postMessage(message: unknown): void; onmessage: ((event: MessageEvent<{ id: number; window: Float32Array }>) => void) | null };
const model = fetch(`/voice-assets/${SMART_TURN_FILE}`).then(async response => {
  if (!response.ok) throw new Error(`${SMART_TURN_FILE}: ${response.status}`);
  return smartTurnModel(new Uint8Array(await response.arrayBuffer()), "/voice-assets/");
});
model.then(() => scope.postMessage({ ready: true }), error => scope.postMessage({ failed: String(error?.message ?? error) }));
scope.onmessage = async ({ data: { id, window } }) => {
  try { scope.postMessage({ id, probability: await (await model)(window) }); }
  catch (error) { scope.postMessage({ id, error: String((error as Error)?.message ?? error) }); }
};
