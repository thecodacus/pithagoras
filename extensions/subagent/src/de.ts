import type { Plural } from "@pithagoras/extension-api";

/**
 * The subagent extension's texts in German, each by what the code says in English: a text, or a count's forms (see
 * `tp`). Those the portal says the same way are here as well, as the portal has them.
 */
export const de: Record<string, string | Plural> = {
  "A {tool} tool: the agent hands a self-contained task to a second agent with a context of its own, and gets its answer back. You can watch it beside the chat and give it instructions while it works.":
    "Ein {tool}-Tool: Der Agent gibt eine abgeschlossene Aufgabe an einen zweiten Agenten mit eigenem Kontext weiter und bekommt dessen Antwort zurück. Du kannst ihm neben dem Chat zusehen und ihm Anweisungen geben, während er arbeitet.",
  "Across every chat. One asked for beyond it waits for a free slot — its call waits in interrupt mode, and in the background it starts once another has finished. Each one is a model running.":
    "Über alle Chats. Einer, der darüber hinaus angefragt wird, wartet auf einen freien Platz — im Unterbrechen-Modus wartet sein Aufruf, im Hintergrund startet er, sobald ein anderer fertig ist. Jeder ist ein laufendes Modell.",
  "Applying…": "Wird angewendet…",
  "Background": "Hintergrund",
  "Chats have it from now on.": "Chats haben es ab jetzt.",
  "Fewer at once": "Weniger gleichzeitig",
  "How a subagent runs against the agent": "Wie ein Subagent zum Agenten läuft",
  "Idle chats have it now; {n} busy chats have it from their next step.": {
    one: "Chats ohne laufende Aufgabe haben es jetzt; ein beschäftigter Chat hat es ab seinem nächsten Schritt.",
    other: "Chats ohne laufende Aufgabe haben es jetzt; {n} beschäftigte Chats haben es ab ihrem nächsten Schritt.",
  },
  "Interrupt": "Unterbrechen",
  "Loading…": "Wird geladen…",
  "Model": "Modell",
  "More at once": "Mehr gleichzeitig",
  "Same as the chat": "Wie der Chat",
  "Subagent model": "Modell der Subagents",
  "Subagents": "Subagents",
  "Subagents at once": "Subagents gleichzeitig",
  "The agent goes on working while the subagent runs, and its answer arrives as a message when it is done. The agent and its subagent run at once: on local hosting that is two model calls at the same time.":
    "Der Agent arbeitet weiter, während der Subagent läuft, und dessen Antwort kommt als Nachricht, sobald sie fertig ist. Agent und Subagent laufen gleichzeitig: Lokal gehostet sind das zwei Modellaufrufe zur selben Zeit.",
  "The agent waits for the subagent's answer before it goes on. One agent works at a time — safe on a single GPU or a local model.":
    "Der Agent wartet auf die Antwort des Subagents, bevor er weitermacht. Es arbeitet immer nur ein Agent — sicher auf einer einzelnen GPU oder mit einem lokalen Modell.",
  "The model the chat is on when it starts one": "Das Modell, das der Chat hat, wenn er einen startet",
  "What a subagent runs on unless its chat says otherwise (in the chat's model menu). The chat's own is the one already loaded, so no second model is started.":
    "Worauf ein Subagent läuft, sofern sein Chat nichts anderes sagt (im Modellmenü des Chats). Das Modell des Chats ist schon geladen, also wird kein zweites gestartet.",
};
