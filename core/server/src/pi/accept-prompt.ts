/** Resolve at SDK acceptance while retaining a handler for failures during the run. */
export function acceptPrompt(
  run: (preflight: (success: boolean) => void) => Promise<void>,
  failedAfterAcceptance: (error: unknown) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let accepted = false;
    try {
      void run(success => { if (success) { accepted = true; resolve(); } }).then(resolve, error => {
        if (accepted) failedAfterAcceptance(error);
        else reject(error);
      });
    } catch (error) { reject(error); }
  });
}
