import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactSyntaxTokens } from '../src/diffSyntaxTokens.ts';

test('merges default-color tokens without dropping text', () => {
  const input = [
    { content: '  ', color: '#B4AEA3' },
    { content: 'override', color: '#B4AEA3' },
    { content: ' ', color: '#B4AEA3' },
    { content: 'fun', color: '#E9AB8D' },
    { content: ' ', color: '#B4AEA3' },
    { content: 'onCreate', color: '#E9AB8D' },
  ];
  const output = compactSyntaxTokens(input, '#b4aea3');
  assert.deepEqual(output, [
    { content: '  override ', color: undefined },
    { content: 'fun', color: '#E9AB8D' },
    { content: ' ', color: undefined },
    { content: 'onCreate', color: '#E9AB8D' },
  ]);
  assert.equal(output.map((token) => token.content).join(''), input.map((token) => token.content).join(''));
});
