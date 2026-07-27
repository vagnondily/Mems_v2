import { config } from "../config.js";
const LEVELS = { error:0, warn:1, info:2, debug:3 };
const cur = LEVELS[config.logLevel] ?? 2;
const REDACT = /("(?:password|pw|token|secret|authorization|pw_hash|token_enc)"\s*:\s*)"[^"]*"/gi;
const line = (level, msg, meta) => {
  if((LEVELS[level] ?? 2) > cur) return;
  let payload = meta ? " " + JSON.stringify(meta) : "";
  payload = payload.replace(REDACT, '$1"[masqué]"');
  process.stdout.write(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}${payload}\n`);
};
export const log = {
  error: (m,x)=>line("error",m,x), warn:(m,x)=>line("warn",m,x),
  info:  (m,x)=>line("info", m,x), debug:(m,x)=>line("debug",m,x),
};
