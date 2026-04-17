import { hello } from './hello.js';
import { onInteractionIngested } from './interaction-received.js';

/**
 * All Inngest functions the web app should register with the serve endpoint.
 * Add new functions to this array as you create them.
 */
export const functions = [hello, onInteractionIngested] as const;

export { hello, onInteractionIngested };
