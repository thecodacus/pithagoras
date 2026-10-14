/** Playwright 0.0.79 suppresses inline image data when filename is supplied.
 * Screenshots still save to an automatically generated path without it.
 */
export function inlineBrowserScreenshot(toolName: string, input: Record<string, unknown>): void {
  const name = toolName === "mcp" ? String(input.tool ?? "") : toolName;
  if (!/(^|[_.])browser_take_screenshot$/.test(name)) return;
  const args = (toolName === "mcp" ? input.args : input) as Record<string, unknown> | undefined;
  if (!args || typeof args !== "object") return;
  if (!args.type && typeof args.filename === "string" && /\.jpe?g$/i.test(args.filename)) args.type = "jpeg";
  delete args.filename;
}
