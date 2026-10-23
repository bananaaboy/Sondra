/**
 * The unified version number for Sondra across the web site, app, and package.
 * Read from package.json at build time, so a new version is set in one place;
 * a copy written here by hand was missed once and named the old version.
 */
import { version } from '../../package.json'

export const APP_VERSION: string = version
