// Thin chalk-aware logger. Honours WR_QUIET=1 for CI runs.
import chalk from 'chalk';
const QUIET = process.env.WR_QUIET === '1';
export const log = {
    info(msg) {
        if (QUIET)
            return;
        process.stderr.write(`${chalk.cyan('[wr]')} ${msg}\n`);
    },
    step(msg) {
        if (QUIET)
            return;
        process.stderr.write(`${chalk.cyan.bold('→')} ${msg}\n`);
    },
    ok(msg) {
        if (QUIET)
            return;
        process.stderr.write(`${chalk.green('✓')} ${msg}\n`);
    },
    warn(msg) {
        process.stderr.write(`${chalk.yellow('!')} ${msg}\n`);
    },
    error(msg) {
        process.stderr.write(`${chalk.red('✗')} ${msg}\n`);
    },
    skip(msg) {
        if (QUIET)
            return;
        process.stderr.write(`${chalk.gray('·')} ${msg}\n`);
    },
};
//# sourceMappingURL=log.js.map