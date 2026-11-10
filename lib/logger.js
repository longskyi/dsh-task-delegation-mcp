const ORDER = { debug: 10, info: 20, warn: 30, error: 40 };
/** Small dependency-free logger. Keeps the DSH host's stdout/stderr usable. */
export class Logger {
    level;
    scope;
    constructor(level, scope = 'dsh-task-delegation') {
        this.level = level;
        this.scope = scope;
    }
    debug(message, fields) {
        this.write('debug', message, fields);
    }
    info(message, fields) {
        this.write('info', message, fields);
    }
    warn(message, fields) {
        this.write('warn', message, fields);
    }
    error(message, fields) {
        this.write('error', message, fields);
    }
    write(level, message, fields) {
        if (ORDER[level] < ORDER[this.level])
            return;
        const suffix = fields === undefined ? '' : ` ${stringify(fields)}`;
        const line = `${new Date().toISOString()} ${level.toUpperCase()} [${this.scope}] ${message}${suffix}`;
        if (level === 'warn' || level === 'error')
            console.error(line);
        else
            console.log(line);
    }
}
function stringify(fields) {
    return JSON.stringify(fields, (_key, value) => {
        if (value instanceof Error)
            return { name: value.name, message: value.message, stack: value.stack };
        return value;
    });
}
