// Thin chalk-aware logger. Honours WR_QUIET=1 for CI runs.

import chalk from 'chalk';

const QUIET = process.env.WR_QUIET === '1';

export const log = {
  info(msg: string): void {
    if (QUIET) return;
    process.stderr.write(`${chalk.cyan('[wr]')} ${msg}\n`);
  },
  step(msg: string): void {
    if (QUIET) return;
    process.stderr.write(`${chalk.cyan.bold('→')} ${msg}\n`);
  },
  ok(msg: string): void {
    if (QUIET) return;
    process.stderr.write(`${chalk.green('✓')} ${msg}\n`);
  },
  warn(msg: string): void {
    process.stderr.write(`${chalk.yellow('!')} ${msg}\n`);
  },
  error(msg: string): void {
    process.stderr.write(`${chalk.red('✗')} ${msg}\n`);
  },
  skip(msg: string): void {
    if (QUIET) return;
    process.stderr.write(`${chalk.gray('·')} ${msg}\n`);
  },
};
