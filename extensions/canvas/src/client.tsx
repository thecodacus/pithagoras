import { useEffect, useRef } from "react";
import { LuFileText } from "react-icons/lu";
import type { ChatProps, PanelProps, Portal, ToolCallView } from "@pithagoras/extension-api";
import { Canvases } from "./Canvases";
import { hear, useAsked, type CanvasMessage } from "./feed";
import { msg, portal, setPortal, t } from "./portal";
import { de } from "./de";
import "./client.css";

/**
 * Canvases: documents the agent writes live beside the conversation, with the
 * tools it writes them with (the server half). A panel by the name `canvas`,
 * a window in voice mode that the agent's work brings up, and D to show or
 * hide it there.
 */

const TOOL = /^canvas_/;
const text = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

/** What a card of a canvas tool's call says in voice mode. */
function describe(call: ToolCallView) {
  const verb: Record<string, string> = {
    canvas_create: t("Starting a document"),
    canvas_write: t("Writing in a document"),
    canvas_read: t("Reading a document"),
    canvas_list: t("Looking at the documents"),
    canvas_delete: t("Deleting a document"),
  };
  return { label: verb[call.name] ?? t("Using a document"), detail: text((call.input as { title?: unknown } | undefined)?.title) };
}

function Panel({ chat }: PanelProps) {
  return <Canvases chat={chat.id} folder={chat.workspace} />;
}

/** Brings the panel up when the agent makes a document, reads one, or begins writing one. */
function Follow({ chat, panels }: ChatProps) {
  const { count } = useAsked(chat.id);
  const first = useRef(count);
  useEffect(() => {
    if (count !== first.current) panels.open("canvas");
  }, [count]);
  return null;
}

export default function canvas(given: Portal) {
  setPortal(given);
  portal.locale.add("de", de);
  portal.server.on((chat, data) => hear(chat, data as CanvasMessage));

  portal.slots.register("chat.panel", {
    id: "canvas",
    name: "canvas",
    title: "Session canvases",
    icon: LuFileText,
    component: Panel,
    useButton: () => {
      portal.locale.use();
      return { title: t("Session canvases") };
    },
  });
  portal.slots.register("chat.background", { id: "follow", component: Follow });

  portal.slots.register("voice.window", {
    id: "canvas",
    title: "Session canvases",
    icon: LuFileText,
    place: "middle",
    useAutoOpen: ({ chat }) => useAsked(chat.id).count,
    opensFor: (call) => TOOL.test(call.name),
    describe,
    component: ({ chat }) => <Canvases chat={chat.id} folder={chat.workspace} />,
  });

  portal.shortcuts.register({
    id: "canvas",
    // Translated where it is listed, as the extension's own texts are.
    label: msg("Show or hide canvases"),
    scope: "voice",
    default: { code: "KeyD" },
    run: ({ windows }) => (windows.isOpen("canvas") ? windows.close("canvas") : windows.open("canvas")),
  });
}
