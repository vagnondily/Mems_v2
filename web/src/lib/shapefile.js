import { n } from "./calc.js";

/* ══════════════════ Lecture de shapefile (ZIP, SHP, DBF, GeoJSON) ══════════════════ */
function zipIndex(ab){
  const dv = new DataView(ab), u8 = new Uint8Array(ab);
  let eo = -1;
  for(let i=u8.length-22; i>=Math.max(0,u8.length-66000); i--) if(dv.getUint32(i,true)===0x06054b50){ eo=i; break; }
  if(eo<0) throw new Error("Ce fichier n'est pas une archive ZIP valide");
  const cnt = dv.getUint16(eo+10,true); let p = dv.getUint32(eo+16,true); const ent = [];
  for(let k=0;k<cnt;k++){
    if(dv.getUint32(p,true)!==0x02014b50) break;
    const method=dv.getUint16(p+10,true), csize=dv.getUint32(p+20,true);
    const nlen=dv.getUint16(p+28,true), elen=dv.getUint16(p+30,true), clen=dv.getUint16(p+32,true);
    const lho=dv.getUint32(p+42,true);
    const name = new TextDecoder().decode(u8.subarray(p+46,p+46+nlen));
    const lnlen=dv.getUint16(lho+26,true), lelen=dv.getUint16(lho+28,true);
    ent.push({ name, method, off: lho+30+lnlen+lelen, csize });
    p += 46+nlen+elen+clen;
  }
  return ent.filter(e => !e.name.endsWith("/"));
}
async function zipRead(ab, e){
  const raw = new Uint8Array(ab, e.off, e.csize);
  if(e.method===0) return raw.slice();
  if(e.method===8){
    /* On alimente le flux directement, sans passer par Blob.stream(),
       absent de certains environnements d'exécution. */
    const ds = new DecompressionStream("deflate-raw");
    const w = ds.writable.getWriter();
    w.write(raw); w.close();
    return new Uint8Array(await new Response(ds.readable).arrayBuffer());
  }
  throw new Error("Compression non prise en charge : "+e.name);
}
function readDBF(u8){
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const nrec = dv.getUint32(4,true), hlen = dv.getUint16(8,true), rlen = dv.getUint16(10,true);
  const fields = []; let p = 32;
  const d1 = new TextDecoder("utf-8"), d2 = new TextDecoder("windows-1252");
  while(p < hlen-1 && u8[p] !== 0x0D){
    fields.push({ name: d1.decode(u8.subarray(p,p+11)).replace(/\0.*$/,"").trim(),
      type: String.fromCharCode(u8[p+11]), len: u8[p+16] });
    p += 32;
  }
  const txt = b => { const s = d1.decode(b); return /\uFFFD/.test(s) ? d2.decode(b).trim() : s.trim(); };
  const rows = []; let off = hlen;
  for(let i=0;i<nrec;i++){
    if(off+rlen > u8.length) break;
    if(u8[off] !== 0x2A){ const o = {}; let c = off+1;
      for(const f of fields){ const v = txt(u8.subarray(c,c+f.len));
        o[f.name] = (f.type==="N"||f.type==="F") ? (v===""?null:parseFloat(v)) : v; c += f.len; }
      rows.push(o); }
    off += rlen;
  }
  return { fields: fields.map(f=>f.name), rows };
}
function ringCentroid(r){
  let a=0,x=0,y=0;
  for(let i=0,j=r.length-1;i<r.length;j=i++){
    const f = r[j][0]*r[i][1] - r[i][0]*r[j][1]; a += f; x += (r[j][0]+r[i][0])*f; y += (r[j][1]+r[i][1])*f; }
  a *= 0.5;
  if(Math.abs(a) < 1e-12){ const m = r.reduce((t,p)=>[t[0]+p[0],t[1]+p[1]],[0,0]); return [m[0]/r.length, m[1]/r.length]; }
  return [x/(6*a), y/(6*a)];
}
function readSHP(u8){
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const shapes = []; let p = 100;
  while(p+8 <= u8.length){
    const len = dv.getInt32(p+4,false)*2, s = p+8;
    if(len<=0 || s+len > u8.length) break;
    const t = dv.getInt32(s,true);
    if(t===1||t===11||t===21) shapes.push({ pt:[dv.getFloat64(s+4,true), dv.getFloat64(s+12,true)] });
    else if([3,5,13,15,23,25].includes(t)){
      const nP = dv.getInt32(s+36,true), nPts = dv.getInt32(s+40,true), parts = [];
      for(let i=0;i<nP;i++) parts.push(dv.getInt32(s+44+i*4,true));
      const base = s+44+nP*4; const rings = [];
      for(let i=0;i<nP;i++){ const a = parts[i], b = (i+1<nP?parts[i+1]:nPts), r = [];
        for(let k=a;k<b;k++) r.push([dv.getFloat64(base+k*16,true), dv.getFloat64(base+k*16+8,true)]);
        if(r.length>2) rings.push(r); }
      shapes.push({ rings });
    } else shapes.push({});
    p = s+len;
  }
  return shapes;
}
function shapeCentroid(sh){
  if(!sh) return null;
  if(sh.pt) return sh.pt;
  if(sh.rings?.length){
    let big = sh.rings[0], ba = 0;
    sh.rings.forEach(r => { const c = ringCentroid(r); const a = r.length; if(a>ba){ ba=a; big=r; } });
    return ringCentroid(big);
  }
  return null;
}
async function readGeoFile(file){
  const nm = file.name.toLowerCase();
  if(nm.endsWith(".geojson") || nm.endsWith(".json")){
    const j = JSON.parse(await file.text());
    const feats = j.type==="FeatureCollection" ? j.features : (j.type==="Feature" ? [j] : []);
    const rows = feats.map(f=>f.properties||{});
    const cent = feats.map(f => { const g=f.geometry||{};
      if(g.type==="Point") return g.coordinates;
      if(g.type==="Polygon") return ringCentroid(g.coordinates[0]);
      if(g.type==="MultiPolygon") return ringCentroid(g.coordinates[0][0]);
      return null; });
    return { src:file.name, fields:[...new Set(rows.flatMap(r=>Object.keys(r)))], rows, cent };
  }
  const ab = await file.arrayBuffer();
  let src = file.name, att = null, shpEntry = null, entries = null;
  if(nm.endsWith(".zip")){
    entries = zipIndex(ab);
    const find = ext => entries.find(e => e.name.toLowerCase().endsWith(ext) && !e.name.split("/").pop().startsWith("."));
    const dbfE = find(".dbf"); shpEntry = find(".shp");
    if(!dbfE && !shpEntry) throw new Error("L'archive ne contient ni .dbf ni .shp");
    src = (dbfE || shpEntry).name.split("/").pop().replace(/\.[^.]+$/,"");
    if(dbfE) att = readDBF(await zipRead(ab, dbfE));
  } else if(nm.endsWith(".shp")){ shpEntry = { direct:true }; }
  else if(nm.endsWith(".dbf")){ att = readDBF(new Uint8Array(ab)); }
  else throw new Error("Format non reconnu : utilisez .zip, .shp, .dbf ou .geojson");

  /* Chemin rapide : de nombreux découpages portent déjà les centroïdes en attributs.
     On évite alors d'ouvrir la géométrie, qui pèse souvent des dizaines de mégaoctets. */
  if(att){
    const fx = att.fields.find(f => /^(x|lon|long|longitude|centroid_x|point_x)$/i.test(f));
    const fy = att.fields.find(f => /^(y|lat|lati|latitude|centroid_y|point_y)$/i.test(f));
    if(fx && fy && att.rows.some(r => Number.isFinite(parseFloat(r[fx])) && Number.isFinite(parseFloat(r[fy])))){
      return { src, fields: att.fields, rows: att.rows, geomSkipped: true,
        cent: att.rows.map(r => { const x = parseFloat(r[fx]), y = parseFloat(r[fy]);
          return (Number.isFinite(x) && Number.isFinite(y)) ? [x,y] : null; }) };
    }
  }
  /* Sinon seulement, on calcule les centroïdes depuis la géométrie */
  if(!shpEntry) return { src, fields: att.fields, rows: att.rows, cent: att.rows.map(()=>null) };
  const shpBuf = shpEntry.direct ? new Uint8Array(ab) : await zipRead(ab, shpEntry);
  const shapes = readSHP(shpBuf);
  if(!att) att = { fields:[], rows: shapes.map(()=>({})) };
  return { src, fields: att.fields, rows: att.rows, cent: shapes.map(shapeCentroid) };
}
const GUESS = {
  adm0:[/^adm0[_ ]?(en|fr|name)?$/i,/^pays$/i,/^country/i],
  adm1:[/adm1[_ ]?(en|fr|name)?$/i,/^r[ée]gion/i,/^province/i],
  adm2:[/adm2[_ ]?(en|fr|name)?$/i,/^district/i,/^d[ée]partement/i],
  adm3:[/adm3[_ ]?(en|fr|name)?$/i,/^commune/i],
  adm4:[/adm4[_ ]?(en|fr|name)?$/i,/^fokontany/i,/^village/i,/^localit/i],
  code:[/^adm4_?pcode$/i,/^adm3_?pcode$/i,/pcode$/i,/^code/i],
  p1:[/^adm1_?pcode$/i], p2:[/^adm2_?pcode$/i], p3:[/^adm3_?pcode$/i],
};
const guessField = (fields,pats) => { for(const p of pats){ const f=fields.find(x=>p.test(x)); if(f) return f; } return ""; };

export { GUESS, guessField, readDBF, readSHP, ringCentroid, shapeCentroid, zipIndex };
