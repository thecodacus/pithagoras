import type { Chat } from "@pithagoras/extension-api/server";
import { imageEditingMultiple, imageEditingReady, imageGenerationConfig, imageGenerationReady } from "../image-generation";
import { videoGenerationReady } from "../video-generation";
import { editImageTool } from "./edit-image-tool";
import { generateImageTool } from "./generate-image-tool";
import { generateVideoTool } from "./generate-video-tool";
import { showImageTool } from "./show-image-tool";
import { showVideoTool } from "./show-video-tool";

/**
 * Media's tools in a chat's pi, registered by the server half (`portal.chats.extend`), so that they hold what it
 * holds: the settings, the gallery, the portal's files. Which of them there are follows the settings, and Settings →
 * Tools is told the same (`portal.tools.offer`).
 */

/** What a tool answers: its words for the model, and the files it gave (`details.files`, which the chat draws). */
export type ToolResult = { content: { type: "text"; text: string }[]; details: unknown };

/** One of the tools, as pi registers it, but made for no chat: `run` is its `execute`, given the chat it is called in. */
export interface MediaTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  voiceGuidelines?: string[];
  approvalFiles?: string[];
  run(chat: Chat, params: any, signal?: AbortSignal): Promise<ToolResult>;
}

/**
 * The tools there are as the settings are now, read once, so that a tool and its shape are of the same reading:
 * show_image always, generate_image while image generation is ready (taking references while editing is ready too,
 * one or a list as the editing endpoint takes), edit_image while editing is (with one picture or a list, as the
 * endpoint takes, and sending the agent to generate_image for a new picture where that takes references), and
 * generate_video and show_video while video generation is.
 */
export function mediaTools(): MediaTool[] {
  const images = imageGenerationConfig();
  const videos = videoGenerationReady();
  const generating = imageGenerationReady(images);
  const editing = imageEditingReady(images);
  return [
    showImageTool,
    ...(generating ? [generateImageTool(editing && { several: imageEditingMultiple(images) })] : []),
    ...(editing ? [editImageTool(imageEditingMultiple(images), generating)] : []),
    ...(videos ? [generateVideoTool, showVideoTool] : []),
  ];
}

/**
 * Registers them in a chat's pi as it loads, and again as it is reloaded: what saving settings that change them asks
 * for (see api/settings.ts). A chat that is open has the tools as they were when it loaded until then.
 */
export function registerTools(pi: any, chat: Chat): void {
  for (const { run, ...tool } of mediaTools()) {
    pi.registerTool({ ...tool, execute: (_id: string, params: unknown, signal?: AbortSignal) => run(chat, params, signal) });
  }
}

/** What Settings → Tools is told of them: the tools there are now, whether a chat has had them or not. */
export const offeredTools = (): { name: string; description: string }[] => mediaTools().map(({ name, description }) => ({ name, description }));
