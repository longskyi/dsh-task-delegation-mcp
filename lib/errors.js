/** A failure that maps to the documented MCP error envelope. */
export class DomainError extends Error {
    code;
    expected;
    actual;
    state;
    constructor(code, message, options = {}) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = 'DomainError';
        this.code = code;
        this.expected = options.expected;
        this.actual = options.actual;
        this.state = options.state;
    }
}
export function isDomainError(error) {
    return error instanceof DomainError;
}
export function asDomainError(error) {
    if (isDomainError(error))
        return error;
    if (error instanceof Error)
        return new DomainError('internal', error.message, { cause: error });
    return new DomainError('internal', String(error));
}
