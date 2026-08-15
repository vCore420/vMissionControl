import { EventEmitter } from 'node:events';

// A small in-process bus so config.js and healthChecker.js can announce
// changes without importing the WebSocket layer directly — ws.js is the
// only module that listens, keeping the write paths (saveConfig, the
// health sweep) ignorant of who, if anyone, is connected.
export const appEvents = new EventEmitter();
