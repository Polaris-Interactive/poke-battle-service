type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const threshold = ORDER[(process.env.LOG_LEVEL as Level | undefined) ?? 'info'] ?? ORDER.info;

/**
 * One JSON object per line on stdout, for the container log collector.
 */
function write(level: Level, message: string, fields?: Record<string, unknown>): void {
    if (ORDER[level] < threshold)
        return;
    const entry: Record<string, unknown> = { time: new Date().toISOString(), level, message, ...fields };
    const error = fields?.error;
    if (error instanceof Error) {
        // Connection failures are AggregateErrors with an empty message: report their causes
        const causes = error instanceof AggregateError ? error.errors.map(String) : undefined;
        entry.error = { message: error.message || String((error as NodeJS.ErrnoException).code ?? error.name), causes,
            stack: error.stack };
    }
    process.stdout.write(JSON.stringify(entry) + '\n');
}

export const log = {
    debug: (message: string, fields?: Record<string, unknown>) => write('debug', message, fields),
    info: (message: string, fields?: Record<string, unknown>) => write('info', message, fields),
    warn: (message: string, fields?: Record<string, unknown>) => write('warn', message, fields),
    error: (message: string, fields?: Record<string, unknown>) => write('error', message, fields),
};
