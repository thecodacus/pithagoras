import { copyText } from "../clipboard";
import { confirmDialog } from "../components/ConfirmDialog";
import { ErrorBoundary, PartFailed } from "../components/ErrorBoundary";
import { Markdown } from "../components/Markdown";
import { PageHeader, Stat } from "../components/PageHeader";
import { Select } from "../components/Select";
import {
  CollapsibleSection, Empty, ErrorBanner, Field, LoadFailed, Section, Segments, Switch, SwitchRow, WarnBanner,
  btnCls, codeAreaCls, ghostCls, inputCls, inputSmCls, primaryCls, primarySmCls,
} from "../components/SettingsUi";
import { RowsSkeleton, SkeletonGroup } from "../components/Skeleton";
import { StatusDot } from "../components/StatusDot";
import { local, session } from "../safe-storage";
import { tabKeys } from "../tab-keys";
import { useFollowBottom } from "../use-follow-bottom";
import { useNow } from "../use-now";

/**
 * The portal's own building blocks, handed to an extension as `portal.ui`, so
 * that what it draws is made of what the portal's pages are made of: an
 * extension is loaded as it is, with no part of the portal compiled into it.
 */
export const ui = {
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
  /** A question with two answers, asked over the page: resolves true for yes. */
  confirm: confirmDialog,
  /** The look of the portal's own fields and buttons, as class names for a `className`. */
  classes: { input: inputCls, inputSmall: inputSmCls, codeArea: codeAreaCls, button: btnCls, primary: primaryCls, primarySmall: primarySmCls, ghost: ghostCls },
  /** Copies text, where the page is served over plain HTTP as well. */
  copyText,
  /** The browser's storage, which never throws: kept across reloads, and kept for the tab. */
  storage: { local, session },
  /** Keeps a scrolling box at its end while more comes, until the person scrolls away. */
  useFollowBottom,
  /** The time now, drawn again every second while `on`. */
  useNow,
  /** Arrow keys for a row of tabs. */
  tabKeys,
};

export type Ui = typeof ui;
