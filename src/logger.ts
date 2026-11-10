import type { LogLevel } from './config.js'

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** Small dependency-free logger. Keeps the DSH host's stdout/stderr usable. */
export class Logger {
  constructor(
    private readonly level: LogLevel,
    private readonly scope = 'dsh-task-delegation',
  ) {}

  debug(message: string, fields?: Record<string, unknown>): void {
    this.write('debug', message, fields)
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.write('info', message, fields)
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.write('warn', message, fields)
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.write('error', message, fields)
  }

  private write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (ORDER[level] < ORDER[this.level]) return
    const suffix = fields === undefined ? '' : ` ${stringify(fields)}`
    const line = `${new Date().toISOString()} ${level.toUpperCase()} [${this.scope}] ${message}${suffix}`
    if (level === 'warn' || level === 'error') console.error(line)
    else console.log(line)
  }
}

function stringify(fields: Record<string, unknown>): string {
  return JSON.stringify(fields, (_key, value: unknown) => {
    if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack }
    return value
  })
}
