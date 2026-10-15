# Session canvases

A canvas is a document associated with a conversation. **Session canvases** in
the chat's header opens them beside the conversation, docked like Files or
floating, to browse, read, create, edit inline, or delete the chat's documents.
In voice mode they are a window of the stage's, which <kbd>D</kbd> shows or
hides. Documents can contain plain text or Markdown.

Canvases are an extension, `pithagoras-canvas` from the portal's
`extensions/canvas`, installed when a portal starts for the first time and
listed under Settings → Extensions → Installed like any other: switch it off or
remove it, and the button, the window and the agent's canvas tools go.

New canvases are temporary and held in the portal's memory. They remain available across tab refreshes but disappear when the portal restarts. Choose **Store canvas** beside the document picker to save the current document permanently; subsequent applied human edits and streamed AI writes auto-save. Existing saved canvases remain permanent.

**Download canvas** exports Markdown (including the current inline edit draft). Applying inline edits to a temporary canvas does not store it permanently. Interrupted AI writes retain their partial content with the same temporary/stored lifetime.

Ask the agent to create a canvas and write into it. The text appears live while
its write arguments stream, rather than waiting for the entire tool call.
Decoded text is retained as it arrives, in memory for temporary canvases and in the extension's own database for stored canvases. A stored canvas is written to the database about once a second at most while the text streams in, and once more when the write ends, so a long document does not slow the other chats; a server that stops in the middle of a write loses at most the last moment of it. If interrupted, the current text remains as a **Partial draft retained**; incomplete JSON escapes are not invented. Stored partial drafts also survive server restarts.

A write that replaces the document and is cut off (you stopped it, the model ran out of output or failed, the server restarted) leaves only what had streamed in, and the rest of the old document would be gone. So the portal keeps the document as it was before the write until the write is done. While the draft is partial, **Restore the version before the interrupted write** puts that text back, as a revision of its own: you can still copy the partial draft first. It is let go as soon as a write goes through, or you edit the document yourself, and a write that is tried again after a cut-off keeps the text from before the first one.

Choose **Edit inline**, make changes in the same panel, and **Apply changes** (temporary) or **Save changes** (stored).
Your save marks the canvas **Edited by you**. The AI must read it before making
its next change. It can continue its own edits without rereading; an unread
canvas also requires an initial read. Revisions prevent stale edits from
silently overwriting newer text. While an AI write is streaming, finish or
interrupt it before editing manually. A conflicting manual draft stays in the
editor so you can copy it before reloading the document.

If the document you are editing is deleted meanwhile, by the agent or from another tab, the edit ends with a
notice and your draft stays below it, read-only, with **Copy draft**; the panel stays usable.

A canvas can show pictures from the chat's folder: `![Sales by month](plots/sales.png)`
draws `plots/sales.png`, by a path relative to the folder or an absolute one
inside it. The agent is told it can do this, so a report can carry the chart it
made. A picture from another website is not loaded, here as everywhere in the portal: it shows where it
would have come from instead (see [Security](/guide/security)). A path outside the folder is not shown.

The agent has five tools: `canvas_create`, `canvas_list`, `canvas_read`,
`canvas_write` (replace or append), and `canvas_delete`. Write arguments specify
the document and revision before the content so live writes have an unambiguous
target. No content is guessed to complete an interrupted call.

In voice mode the canvases are a window like the others, in the middle when it
has the choice: at most two windows sit beside the orb, and opening a third
minimizes the one opened longest ago. A document the agent makes, reads or
begins writing brings the window up, and the card of a canvas tool's call opens
it when tapped. Minimizing it does not remove a document or discard an unsaved
edit.

Stored canvases live in the extension's own database, `canvases.db` in its
folder of the portal's data folder (`extension-data/pithagoras-canvas/`), where no
agent can reach them. They are removed when their chat is deleted, and so are
the temporary ones, which go from memory at once. Include the data folder in
backups.

A portal from before Canvases were an extension kept stored canvases in its own
database. Its first start after the upgrade writes each of them out as a
Markdown file in its chat's folder, `canvases/<title>.md` (in the data folder's
`canvases/` for a chat whose folder is gone), and the table goes: nothing is
lost, and they are files you can open in Files, not canvases. See
[Upgrading](/guide/upgrading).
