/**
 * Ranking of tools for a search: BM25 over what a tool is called, what it says it does, its parameters' names and the
 * name of the set it is in. pi's own tool search ranks the same way and does not export its ranker, so this is the
 * portal's own, small enough to read in one go and with no dependency.
 */

/** What a search ranks: a tool by its text. */
export interface Rankable {
  name: string;
  description: string;
  /** The names of its parameters. */
  params: string[];
  /** What its set is called, and what the set's tools say about it. */
  group: string;
}

/** Words of a text: a name's underscores, hyphens, dots and camel humps are breaks, as the model would say them. */
export function wordsOf(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** How much more a word in a tool's name counts than one in its description. */
const NAME_WEIGHT = 3;
/** And one in its parameters' names, or its set's. */
const SIDE_WEIGHT = 1.5;

const K1 = 1.2;
const B = 0.75;

/**
 * The tools that match the query, best first. A tool that none of the query's words is in is not a match; a query of no
 * words matches everything, in the order the tools were given. A word also counts as the start of one: "screen" finds
 * "screenshot".
 */
export function rank<T extends Rankable>(tools: readonly T[], query: string): T[] {
  const terms = [...new Set(wordsOf(query))];
  if (!terms.length) return [...tools];
  const docs = tools.map((tool) => {
    const weighted = new Map<string, number>();
    const add = (text: string, weight: number) => {
      for (const word of wordsOf(text)) weighted.set(word, (weighted.get(word) ?? 0) + weight);
    };
    add(tool.name, NAME_WEIGHT);
    add(tool.description, 1);
    add(tool.params.join(" "), SIDE_WEIGHT);
    add(tool.group, SIDE_WEIGHT);
    let length = 0;
    for (const n of weighted.values()) length += n;
    return { tool, weighted, length };
  });
  const average = docs.reduce((sum, d) => sum + d.length, 0) / (docs.length || 1) || 1;
  // A query word is counted by the words it matches: its own, and any that starts with it.
  const frequency = (doc: (typeof docs)[number], term: string) => {
    let n = 0;
    for (const [word, count] of doc.weighted) if (word === term || (term.length >= 3 && word.startsWith(term))) n += count;
    return n;
  };
  const idf = new Map<string, number>();
  for (const term of terms) {
    const having = docs.filter((d) => frequency(d, term) > 0).length;
    idf.set(term, Math.log(1 + (docs.length - having + 0.5) / (having + 0.5)));
  }
  return docs
    .map((doc, at) => {
      let score = 0;
      for (const term of terms) {
        const f = frequency(doc, term);
        if (!f) continue;
        score += (idf.get(term) ?? 0) * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * (doc.length / average))));
      }
      return { tool: doc.tool, score, at };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name) || a.at - b.at)
    .map((hit) => hit.tool);
}
