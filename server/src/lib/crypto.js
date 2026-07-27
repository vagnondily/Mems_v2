import crypto from "node:crypto";
import { config } from "../config.js";

/* Chiffrement symétrique authentifié des secrets stockés (jetons ODK, etc.). */
export function encrypt(plain){
  if(plain === null || plain === undefined || plain === "") return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", config.dataKey, iv);
  const enc = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}
export function decrypt(payload){
  if(!payload) return null;
  try{
    const b = Buffer.from(payload, "base64");
    const d = crypto.createDecipheriv("aes-256-gcm", config.dataKey, b.subarray(0,12));
    d.setAuthTag(b.subarray(12,28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
  }catch(e){ return null; }
}
const ALPHA = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/* Identifiant trié par date de création, sans collision pratique. */
export function newId(prefix=""){
  const t = Date.now();
  let ts = ""; let x = t;
  for(let i=0;i<10;i++){ ts = ALPHA[x % 32] + ts; x = Math.floor(x/32); }
  const r = crypto.randomBytes(10);
  let rand = ""; for(const b of r) rand += ALPHA[b % 32];
  return (prefix ? prefix+"_" : "") + ts + rand;
}
