/**
 * The languages the Voice add-on offers, in one place.
 *
 * The API validates against this list and the add-on renders its dropdown from
 * it, so a language can never be offered and then refused on save, or accepted
 * by the server and never offered.
 */
export const INPUT_LANGUAGES: readonly (readonly [code: string, label: string])[] = [
  ["auto", "Auto-detect"],
  ["en", "English"], ["hi", "Hindi"], ["bn", "Bengali"], ["ta", "Tamil"], ["te", "Telugu"],
  ["mr", "Marathi"], ["gu", "Gujarati"], ["kn", "Kannada"], ["ml", "Malayalam"], ["ur", "Urdu"],
  ["zh", "Chinese"], ["ja", "Japanese"], ["ko", "Korean"], ["es", "Spanish"], ["fr", "French"],
  ["de", "German"], ["it", "Italian"], ["pt", "Portuguese"], ["ar", "Arabic"], ["ru", "Russian"],
  // Chatterbox Multilingual reaches these; Qwen3-ASR recognises them too.
  ["da", "Danish"], ["nl", "Dutch"], ["fi", "Finnish"], ["el", "Greek"], ["ms", "Malay"],
  ["no", "Norwegian"], ["pl", "Polish"], ["sw", "Swahili"], ["sv", "Swedish"], ["tr", "Turkish"],
];

/**
 * Chatterbox Multilingual, as audio.cpp packages it. Chatterbox has no
 * detection mode: it is told a language or it refuses, so "auto" is not one.
 */
export const CHATTERBOX_LANGUAGES = ["ar", "da", "de", "el", "en", "es", "fi", "fr", "hi", "it", "ko", "ms", "nl", "no", "pl", "pt", "sv", "sw", "tr"];
