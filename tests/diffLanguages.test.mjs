import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DIFF_LANGUAGES, grammarIdForDiffLanguage, languageForDiffPath } from '../src/diffLanguages.ts';

test('recognizes source files and extensionless build files', () => {
  const paths = {
    'src/App.tsx': 'tsx',
    'core/src/MainActivity.kt': 'kotlin',
    'build.gradle.kts': 'kotlin',
    'src-tauri/Cargo.lock': 'toml',
    'src-tauri/Cargo.toml': 'toml',
    'Dockerfile.dev': 'dockerfile',
    'Makefile': 'makefile',
    'android/build.gradle': 'groovy',
    'gradle.properties': 'properties',
    'scripts/setup.sh': 'bash',
    'gradlew': 'bash',
    'native/App.mm': 'objectivec',
    'docs/README.md': 'markdown',
  };
  for (const [path, language] of Object.entries(paths)) {
    assert.equal(languageForDiffPath(path), language, path);
  }
  assert.equal(languageForDiffPath('assets/logo.png'), null);
});

test('every configured language resolves to a bundled Shiki grammar', async () => {
  for (const [language, load] of Object.entries(DIFF_LANGUAGES)) {
    const registrations = (await load()).default;
    assert.ok(registrations.some((registration) => registration.name === grammarIdForDiffLanguage(language)), language);
  }
});
