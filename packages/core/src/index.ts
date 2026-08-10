/**
 * @mt/core — all the domain logic, none of the I/O.
 *
 * Nothing in this package reads a file, opens a socket, or touches a database.
 * That is what makes it possible to simulate five hundred days of study in a
 * millisecond and see what the scheduler actually does, rather than waiting two
 * years to find out (docs/design.md §6).
 */

export * from './types.js';
export * from './scheduling.js';
export * from './selection.js';
export * from './grading.js';
export * from './progress.js';
