/** Compact notation only: retain every tree node, label, state, URL and ref. */
export function cleanBrowserSnapshot(text: string): string {
  return text.replace(/(### Snapshot\r?\n)```yaml\r?\n([\s\S]*?)(\r?\n```|(?=\r?\n### )|$)/g, (_all, heading, tree: string, ending: string) => {
    const lines = tree.split('\n').map(line => {
      // Parse metadata separately from quoted labels and trailing text, so page
      // content that happens to contain snapshot syntax is never rewritten.
      const node = /^( *)- ([\w-]+)( "(?:[^"\\]|\\.)*")?((?: \[[^\]\n]+\])*)(:.*)?$/.exec(line);
      if (node) {
        const [, indent, role, label = '', attrs, value = ''] = node;
        const compactAttrs = attrs.replace(/ \[ref=((?:f\d+)?e\d+)\]/g, ' [$1]').replace(/ \[cursor=pointer\]/g, ' [pointer]');
        return `${' '.repeat(Math.ceil(indent.length / 2))}- ${role === 'generic' ? '' : role}${label}${compactAttrs}${value}`.replace(/-  /, '- ');
      }
      // Property lines retain their values verbatim, including full URLs.
      const property = /^( *)(- \/[\w-]+:.*)$/.exec(line);
      return property ? ' '.repeat(Math.ceil(property[1].length / 2)) + property[2] : line;
    });
    return `${heading}Compact notation: [eN]/[fNeN] are exact tool refs; omitted role means generic; [pointer] means cursor=pointer. All nodes and content retained.\n\`\`\`text\n${lines.join('\n')}${ending ? '\n```' : ''}`;
  });
}

export function isBrowserSnapshot(toolName: string, input: Record<string, unknown>): boolean {
  return /(^|[_.])browser_snapshot$/.test(toolName === 'mcp' ? String(input.tool ?? '') : toolName);
}
