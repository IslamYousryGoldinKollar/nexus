import { hello } from './hello.js';

/**
 * All Inngest functions the web app should register with the serve endpoint.
 * Add new functions to this array as you create them.
 */
export const functions = [hello] as const;

export { hello };
