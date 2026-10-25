import { createElement, useContext } from "react";
import { copyText } from "../clipboard";
import { asksBeforeDeleting } from "../confirm-prefs";
import { confirmDialog } from "../components/ConfirmDialog";
import { ErrorBoundary, PartFailed } from "../components/ErrorBoundary";
import { ImageViewer, iconButton, viewerButton } from "../components/ImageViewer";
import { Markdown } from "../components/Markdown";
import { Ring, Shimmer } from "../components/ChatActivity";
import { TrayChip } from "../components/RunningTray";
import { Modal, useUnsavedDraft } from "../components/Modal";
import { PageHeader, Stat } from "../components/PageHeader";
import { Select } from "../components/Select";
import {
  CollapsibleSection, DetailsGroup, Empty, ErrorBanner, Field, LoadFailed, Section, Segments, Switch, SwitchRow, WarnBanner,
  btnCls, codeAreaCls, ghostCls, inputCls, inputSmCls, primaryCls, primarySmCls,
} from "../components/SettingsUi";
import { RowsSkeleton, SkeletonGroup } from "../components/Skeleton";
import { StatusDot } from "../components/StatusDot";
import { lazyComponent } from "../lazy";
import { useLeaveRef } from "../motion";
import { local, session } from "../safe-storage";
import { tabKeys } from "../tab-keys";
import { useFollowBottom } from "../use-follow-bottom";
import { useNow } from "../use-now";
import { ToolLink } from "./ToolView";
import { Transcript } from "./Transcript";
import { CallImagePreview } from "./call-pictures";
import { DrawnFor } from "./slots";
import type { Ui, ViewerPicture } from "@pithagoras/extension-api";
export type { Ui } from "@pithagoras/extension-api";

/**
 * `ui.ImageViewer`: the chat's viewer. It is drawn over the page, out of the
 * element of the extension that opened it (see slots.ts), so what the extension
 * puts beside its buttons is drawn in one of its own there, for its styles to reach.
 */
const ExtensionImageViewer: Ui["ImageViewer"] = ({ actions, ...props }) => {
  const extension = useContext(DrawnFor);
  return createElement(ImageViewer, {
    ...props,
    actions: actions && ((picture: ViewerPicture) => createElement("div", { "data-extension": extension, style: { display: "contents" } }, actions(picture))),
  });
};

/**
 * The portal's own building blocks, handed to an extension as `portal.ui`, so
 * that what it draws is made of what the portal's pages are made of: an
 * extension is loaded as it is, with no part of the portal compiled into it.
 */
export const ui: Ui = {
  /** Markdown as the conversation draws it: code, tables, diagrams, and no picture from another site. */
  Markdown,
  Select,
  /** The card at the top of a page, and a number in it. */
  PageHeader,
  Stat,
  StatusDot,
  Section,
  CollapsibleSection,
  Empty,
  ErrorBanner,
  WarnBanner,
  /** Why something could not be fetched, with a button to try again. */
  LoadFailed,
  Field,
  Switch,
  SwitchRow,
  Segments,
  RowsSkeleton,
  SkeletonGroup,
  ErrorBoundary,
  PartFailed,
  /** A component of a chunk of the extension's own, fetched when it is first drawn; one that cannot be fetched says so as the portal's own do. */
  lazy: lazyComponent,
  /** A link on a tool call's card, as the portal's own are drawn: for `chat.tool.action`. */
  ToolLink,
  /** A conversation drawn from its events as the chat draws its own: a subagent's run, beside the chat. */
  Transcript,
  /** A chip in the running tray, as the portal draws a background job there: for `chat.tray`. */
  TrayChip,
  /** The ring that spins beside what is running, and the text that shimmers while it goes on. */
  Ring,
  Shimmer,
  /** A picture being made, made or not made, as the conversation shows one a tool makes: opens the chat's viewer for a picture a call gave. */
  ImagePreview: CallImagePreview,
  /** The pictures over the whole page, to zoom and step through, as the chat shows its own. */
  ImageViewer: ExtensionImageViewer,
  /** A dialog as the portal's own, which asks before what is typed in it is lost. */
  Modal,
  /** A group of settings that folds, and that Settings' search opens. */
  DetailsGroup,
  /** Says that this part of a dialog holds what is not saved. */
  useUnsavedDraft,
  /** A question with two answers, asked over the page: resolves true for yes. */
  confirm: confirmDialog,
  /** The look of the portal's own fields and buttons, as class names for a `className`. */
  classes: {
    input: inputCls, inputSmall: inputSmCls, codeArea: codeAreaCls, button: btnCls, primary: primaryCls, primarySmall: primarySmCls, ghost: ghostCls,
    viewerButton, iconButton,
  },
  /** Copies text, where the page is served over plain HTTP as well. */
  copyText,
  /** Whether the person wants to be asked before something is deleted (Settings → This browser). */
  asksBeforeDeleting,
  /** The browser's storage, which never throws: kept across reloads, and kept for the tab. */
  storage: { local, session },
  /** Keeps a scrolling box at its end while more comes, until the person scrolls away. */
  useFollowBottom,
  /** The time now, drawn again every second while `on`. */
  useNow,
  /** Arrow keys for a row of tabs. */
  tabKeys,
  /** The ref for the one element a part draws, which leaves as a picture of itself, as the portal's own parts do. */
  useLeaveRef,
};


