import type { Plural } from "@pithagoras/extension-api";

/**
 * Voice servers' texts in German, each by what the code says in English: a text, or a count's forms (see `tp`). Those
 * the portal says the same way are here as well, as the portal has them.
 */
export const de: Record<string, string | Plural> = {
  "Dictation endpoint": "Adresse für das Diktieren",
  "Dictation model": "Modell für das Diktieren",
  "Empty uses the speech recognition model above": "Leer nutzt das Modell der Spracherkennung oben",
  "Empty uses the speech recognition URL above": "Leer nutzt die URL der Spracherkennung oben",
  "Empty: the server detects it": "Leer: Der Server erkennt sie",
  "In use for voice mode": "Wird für den Sprachmodus verwendet",
  "Input language": "Eingabesprache",
  "Loading…": "Wird geladen…",
  "One voice per line: its id, or id = Name.": "Eine Stimme pro Zeile: ihre ID oder ID = Name.",
  "Read voices from the server": "Stimmen vom Server lesen",
  "Save": "Speichern",
  "Saved": "Gespeichert",
  "Saving…": "Wird gespeichert…",
  "Set a speech recognition address first": "Zuerst eine Adresse für die Spracherkennung festlegen",
  "Speech recognition and speech synthesis on servers you run, spoken to as OpenAI's audio API is. The speech server has to answer 24 kHz mono WAV.": "Spracherkennung und Sprachausgabe auf Servern, die du betreibst, angesprochen wie die Audio-API von OpenAI. Der Sprachserver muss 24-kHz-Mono-WAV liefern.",
  "Speech recognition model": "Modell der Spracherkennung",
  "Speech recognition URL": "URL der Spracherkennung",
  "Speech synthesis model": "Modell der Sprachsynthese",
  "Speech synthesis URL": "URL der Sprachsynthese",
  "Stop using": "Nicht mehr verwenden",
  "The address the microphone button of the message box sends its recordings to. Voice mode keeps using the one above, so dictation can run on another service.": "Die Adresse, an die die Mikrofontaste des Nachrichtenfelds ihre Aufnahmen schickt. Der Sprachmodus nutzt weiter die Adresse oben, so kann das Diktieren auf einem anderen Dienst laufen.",
  "The model the microphone button of the message box transcribes with. Voice mode keeps using the one above, so a conversation can have the quick model and dictation the accurate one.": "Das Modell, mit dem die Mikrofontaste des Nachrichtenfelds transkribiert. Der Sprachmodus nutzt weiter das Modell oben, so kann ein Gespräch das schnelle Modell haben und das Diktieren das genauere.",
  "the server's own": "vom Server vorgegeben",
  "Use for voice mode": "Für den Sprachmodus verwenden",
  "Voice": "Stimme",
  "Voice servers": "Sprachserver",
  "Voices": "Stimmen",
};
