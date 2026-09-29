export type SyntaxToken = { content: string; color?: string };

export function compactSyntaxTokens(tokens: readonly SyntaxToken[], baseColor: string): SyntaxToken[] {
  const result: SyntaxToken[] = [];
  const base = baseColor.toLowerCase();
  for (const token of tokens) {
    if (!token.content) continue;
    const color = token.color?.toLowerCase() === base ? undefined : token.color;
    const previous = result[result.length - 1];
    if (previous && previous.color === color) previous.content += token.content;
    else result.push({ content: token.content, color });
  }
  return result;
}
