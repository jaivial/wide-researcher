// Tiny readline wrappers — interactive terminal prompts.
// Uses node:readline/promises so we don't pull a heavy interactive
// library. Three primitives: ask (free text), askSecret (no echo),
// select (multi-choice with arrow keys).

import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

export async function ask(question: string, fallback?: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(question);
    return answer.trim() || (fallback ?? '');
  } finally {
    rl.close();
  }
}

/** Hide echoed characters while user types. Used for API keys. */
export async function askSecret(question: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  // Hack: temporarily mute stdout for the question's echo.
  // Node's readline doesn't have a built-in mute mode; this is the
  // standard workaround.
  const _writeToOutput = (rl as unknown as { _writeToOutput?: (s: string) => void })
    ._writeToOutput;
  (rl as unknown as { _writeToOutput?: (s: string) => void })._writeToOutput =
    (stringToWrite: string): void => {
      if (stringToWrite && stringToWrite.length > 0) {
        // print the prompt itself, but not the user's typing
        if (stringToWrite.includes('\n') || stringToWrite.includes('?')) {
          output.write(stringToWrite);
        } else {
          output.write('*');
        }
      }
    };
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    (rl as unknown as { _writeToOutput?: typeof _writeToOutput })._writeToOutput =
      _writeToOutput;
    rl.close();
    output.write('\n');
  }
}

export interface SelectChoice<T extends string> {
  value: T;
  label: string;
  description?: string;
}

/** Numbered selection (cross-platform; no ANSI cursor manipulation). */
export async function select<T extends string>(
  title: string,
  choices: SelectChoice<T>[],
  defaultIndex = 0,
): Promise<T> {
  output.write(`\n${title}\n\n`);
  choices.forEach((c, i) => {
    const marker = i === defaultIndex ? '❯' : ' ';
    output.write(`  ${marker} ${i + 1}. ${c.label}\n`);
    if (c.description) output.write(`       ${c.description}\n`);
  });
  output.write('\n');

  const def = defaultIndex + 1;
  const raw = await ask(`Pick [1-${choices.length}] (default ${def}): `, String(def));
  const idx = parseInt(raw, 10);
  if (!Number.isFinite(idx) || idx < 1 || idx > choices.length) {
    return choices[defaultIndex]!.value;
  }
  return choices[idx - 1]!.value;
}
