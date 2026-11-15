import type { api as realApi } from "../api";

/**
 * Where a chat's files are fetched from: the pictures sent with a message, and the pictures, clips and files its tool
 * calls gave, by their path in the chat's folder. Only addresses, nothing is asked: an interface puts them in an
 * `img`, a `video` or a link. `version` is anything that changes when the file does (the agent rewrites pictures in place).
 */
export type MediaApi = Pick<typeof realApi, "imageUrl" | "pictureUrl" | "videoUrl" | "fileUrl">;

export function createMedia(api: MediaApi) {
  return {
    /** A picture sent with a message, by its name. */
    image: (chat: string, name: string): string => api.imageUrl(chat, name),
    /** A picture in the chat's folder. */
    picture: (chat: string, path: string, version?: string | number): string => api.pictureUrl(chat, path, version),
    /** A clip in the chat's folder: the player asks for the parts it needs. */
    video: (chat: string, path: string, version?: string | number): string => api.videoUrl(chat, path, version),
    /** Any file in the chat's folder, to be saved. */
    file: (chat: string, path: string, version?: string | number): string => api.fileUrl(chat, path, version),
  };
}

export type Media = ReturnType<typeof createMedia>;
