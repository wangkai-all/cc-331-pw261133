/**
 * Tiny navigation indirection.
 *
 * The shell owns the router, but view modules need to send the user to another
 * screen. Registering a handler here avoids a circular import between the shell
 * and the views it renders.
 */

let handler = null;

export function registerRouter(fn) {
  handler = fn;
}

export function navigate(view) {
  if (handler) handler(view);
}
