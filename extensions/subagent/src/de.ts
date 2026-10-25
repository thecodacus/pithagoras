import type { Plural } from "@pithagoras/extension-api";

/**
 * The subagent extension's texts in German, each by what the code says in English: a text, or a count's forms (see
 * `tp`). Those the portal says the same way are here as well, as the portal has them.
 */
export const de: Record<string, string | Plural> = {
  "A {tool} tool: the agent hands a self-contained task to a second agent, which works in a chat of its own with the chat's folder, tools and checks, and gets its answer back. You can watch it beside the chat and give it instructions while it works.":
    "Ein {tool}-Tool: Der Agent gibt eine abgeschlossene Aufgabe an einen zweiten Agenten weiter, der in einem eigenen Chat mit dem Ordner, den Tools und den Prüfungen des Chats arbeitet, und bekommt dessen Antwort zurück. Du kannst ihm neben dem Chat zusehen und ihm Anweisungen geben, während er arbeitet.",
  "Across every chat. One asked for beyond it waits for a free slot — its call waits in interrupt mode, and in the background it starts once another has finished. Each one is a model running.":
    "Über alle Chats. Einer, der darüber hinaus angefragt wird, wartet auf einen freien Platz — im Unterbrechen-Modus wartet sein Aufruf, im Hintergrund startet er, sobald ein anderer fertig ist. Jeder ist ein laufendes Modell.",
  "Applying…": "Wird angewendet…",
  "Background": "Hintergrund",
  "Chats have it from now on.": "Chats haben es ab jetzt.",
  "Default — {model}": "Standard — {model}",
  "Each subagent's chat is listed under its chat as a sub-chat, and the agent can give it a further task by its id. Off, it is only opened from the agents panel, and is not given more. Either way it is deleted with its chat.":
    "Der Chat jedes Subagents steht als Unterchat unter seinem Chat, und der Agent kann ihm über seine ID eine weitere Aufgabe geben. Aus, wird er nur aus dem Agenten-Panel geöffnet und bekommt nichts mehr. So oder so wird er mit seinem Chat gelöscht.",
  "Failed": "Fehlgeschlagen",
  "Fewer at once": "Weniger gleichzeitig",
  "Finished": "Fertig",
  "How a subagent runs against the agent": "Wie ein Subagent zum Agenten läuft",
  "Idle chats have it now; {n} busy chats have it from their next step.": {
    one: "Chats ohne laufende Aufgabe haben es jetzt; ein beschäftigter Chat hat es ab seinem nächsten Schritt.",
    other: "Chats ohne laufende Aufgabe haben es jetzt; {n} beschäftigte Chats haben es ab ihrem nächsten Schritt.",
  },
  "Interrupt": "Unterbrechen",
  "It waits for you in its chat.": "Er wartet in seinem Chat auf dich.",
  "Its chat is gone: it was deleted, or the subagent was stopped before it started.":
    "Sein Chat ist nicht mehr da: Er wurde gelöscht, oder der Subagent wurde gestoppt, bevor er anfing.",
  "Keep subagent chats": "Chats der Subagents behalten",
  "Loading…": "Wird geladen…",
  "Message for {name}": "Nachricht an {name}",
  "Model": "Modell",
  "More at once": "Mehr gleichzeitig",
  "No subagents in this chat yet. An extension's agent shows up here while it works, if the extension speaks the subagent protocol.":
    "In diesem Chat gibt es noch keine Subagents. Der Agent einer Erweiterung erscheint hier, während er arbeitet, wenn die Erweiterung das Subagent-Protokoll spricht.",
  "Open": "Öffnen",
  "Open as chat": "Als Chat öffnen",
  "Open it to answer": "Zum Antworten öffnen",
  "Open its chat, to read it whole or go on with it": "Seinen Chat öffnen, um ihn ganz zu lesen oder darin weiterzumachen",
  "Same as the chat": "Wie der Chat",
  "Send to the subagent": "An den Subagent senden",
  "Sent: “{text}”": "Gesendet: „{text}“",
  "Starting…": "Wird gestartet…",
  "Stop": "Stoppen",
  "Stopped": "Gestoppt",
  "Subagent": "Subagent",
  "Subagent model": "Modell der Subagents",
  "Subagents": "Subagents",
  "Subagents at once": "Subagents gleichzeitig",
  "Subagents in this chat run on": "Subagents in diesem Chat laufen auf",
  "Tell {name} something…": "Sag {name} etwas…",
  "The agent goes on working while the subagent runs, and its answer arrives as a message when it is done. The agent and its subagent run at once: on local hosting that is two model calls at the same time.":
    "Der Agent arbeitet weiter, während der Subagent läuft, und dessen Antwort kommt als Nachricht, sobald sie fertig ist. Agent und Subagent laufen gleichzeitig: Lokal gehostet sind das zwei Modellaufrufe zur selben Zeit.",
  "The agent waits for the subagent's answer before it goes on. One agent works at a time — safe on a single GPU or a local model.":
    "Der Agent wartet auf die Antwort des Subagents, bevor er weitermacht. Es arbeitet immer nur ein Agent — sicher auf einer einzelnen GPU oder mit einem lokalen Modell.",
  "The agents working beside this one": "Die Agenten, die neben diesem arbeiten",
  "The model the chat is on when it starts one": "Das Modell, das der Chat hat, wenn er einen startet",
  "The one it is on when it starts one": "Das Modell, das er hat, wenn er einen startet",
  "This chat's model": "Das Modell dieses Chats",
  "this chat's model": "das Modell dieses Chats",
  "This subagent does not take messages.": "Dieser Subagent nimmt keine Nachrichten an.",
  "Waiting for you": "Wartet auf dich",
  "waiting for you": "wartet auf dich",
  "Watch": "Zusehen",
  "What a subagent runs on unless its chat says otherwise (in the chat's model menu). The chat's own is the one already loaded, so no second model is started.":
    "Worauf ein Subagent läuft, sofern sein Chat nichts anderes sagt (im Modellmenü des Chats). Das Modell des Chats ist schon geladen, also wird kein zweites gestartet.",
  "Working": "Arbeitet",
};
