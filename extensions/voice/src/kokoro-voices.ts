/**
 * The voices Kokoro 82M speaks with, as audio.cpp packages them in its GGUF.
 *
 * Kokoro has no cloned or designed voice: it speaks with one of these, by id.
 * The first letter of an id is the language and the second the speaker's sex,
 * and the model reads the text in that language. The Japanese voices are left
 * out: they need MeCab and UniDic, which the packaged GGUF does not carry.
 * It has no node imports: the page uses it too.
 */
/** By the first letter of a voice: the language as a BCP 47 code, which the page names in its own language, and in English. */
const LANGUAGES: Record<string, readonly [code: string, label: string]> = {
  a: ["en-US", "American English"], b: ["en-GB", "British English"], e: ["es", "Spanish"], f: ["fr", "French"],
  h: ["hi", "Hindi"], i: ["it", "Italian"], p: ["pt-BR", "Brazilian Portuguese"], z: ["zh", "Mandarin Chinese"],
};

const IDS = [
  "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
  "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx", "am_puck", "am_santa",
  "bf_alice", "bf_emma", "bf_isabella", "bf_lily", "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
  "ef_dora", "em_alex", "em_santa",
  "ff_siwis",
  "hf_alpha", "hf_beta", "hm_omega", "hm_psi",
  "if_sara", "im_nicola",
  "pf_dora", "pm_alex", "pm_santa",
  "zf_xiaobei", "zf_xiaoni", "zf_xiaoxiao", "zf_xiaoyi", "zm_yunjian", "zm_yunxi", "zm_yunxia", "zm_yunyang",
];

export interface KokoroVoice { id: string; name: string; locale: string; language: string; female: boolean }

export const KOKORO_VOICES: readonly KokoroVoice[] = IDS.map((id) => {
  const name = id.slice(3);
  const [locale, language] = LANGUAGES[id[0]];
  return { id, name: name[0].toUpperCase() + name.slice(1), locale, language, female: id[1] === "f" };
});

export const DEFAULT_KOKORO_VOICE = "af_heart";

export const isKokoroVoice = (id: unknown): id is string => typeof id === "string" && IDS.includes(id);

/** The speeds the page offers, as Kokoro's own multiplier. */
export const KOKORO_SPEEDS = [0.85, 1, 1.15] as const;
