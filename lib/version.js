import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/** Read the package version without trusting a hard-coded constant. */
export function readVersion() {
    try {
        const manifest = require('../package.json');
        return typeof manifest.version === 'string' ? manifest.version : '0.0.0';
    }
    catch {
        return '0.0.0';
    }
}
