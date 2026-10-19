const text = new TextDecoder("latin1");

export function u16(buf, off) {
  return buf[off] | (buf[off + 1] << 8);
}

export function u32(buf, off) {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}

function setU16(buf, off, value) {
  buf[off] = value & 0xff;
  buf[off + 1] = (value >> 8) & 0xff;
}

function setU32(buf, off, value) {
  buf[off] = value & 0xff;
  buf[off + 1] = (value >> 8) & 0xff;
  buf[off + 2] = (value >> 16) & 0xff;
  buf[off + 3] = (value >> 24) & 0xff;
}

function findAscii(buf, ascii, from = 0) {
  const needle = ascii.split("").map((c) => c.charCodeAt(0));
  outer: for (let i = from; i <= buf.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (buf[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function findAsciiLast(buf, ascii) {
  const needle = ascii.split("").map((c) => c.charCodeAt(0));
  outer: for (let i = buf.length - needle.length; i >= 0; i--) {
    for (let j = 0; j < needle.length; j++) {
      if (buf[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function cstr(buf, off) {
  let end = off;
  while (end < buf.length && buf[end] !== 0) end++;
  return text.decode(buf.subarray(off, end));
}

export function projectHash(config) {
  const b = config.subarray(0x224, 0x228);
  return [...b].reverse().map((n) => n.toString(16).padStart(2, "0")).join("").toUpperCase();
}

export function sampleSlots(config) {
  const smps = findAscii(config, "SMPS");
  if (smps < 0) throw new Error("Config has no SMPS sample table");
  const base = smps + 0x14;
  const slots = [];
  for (let i = 0; i < 256; i++) {
    const at = base + i * 0x100;
    const path = config[at] === 0x2f ? cstr(config, at) : "";
    slots.push({ index: i, deviceSlot: i + 1, path, file: path ? path.split("/").pop() : "" });
  }
  return { base, slots };
}

export function poolFolderForProject(config, projectName) {
  const hash = projectHash(config);
  const { slots } = sampleSlots(config);
  for (const slot of slots) {
    const parts = slot.path.split("/");
    const folder = parts[6];
    if (folder && folder.endsWith(`_${hash}`)) return folder;
  }
  return `${projectName}_${hash}`;
}

export function parsePattern(buf) {
  const data = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (findAscii(data, "PTRN") !== 0) throw new Error("Not a pattern file");
  const ptd = findAsciiLast(data, "PTD2");
  const footer = ptd >= 0 ? ptd : findAsciiLast(data, "PTDT");
  if (footer < 0) throw new Error("Pattern has no footer");
  const name = cstr(data, footer + 20);
  const sig = findAsciiLast(data, "\u0004\u0002\u0000\u0001");
  if (sig < 0) throw new Error("Pattern has no tempo");
  const tempoTimes10 = u32(data, sig + 4);
  const footerIndex = u32(data, footer + 8);
  const indexAt = footerIndex <= 127 ? [8, footer + 8] : [8];

  const tracks = [];
  let off = findAscii(data, "TRAU");
  for (let n = 0; n < 8 && off >= 0; n++) {
    const size = u32(data, off + 4);
    const end = off + size;
    const tmsc = findAscii(data, "TMSC", off);
    if (tmsc < 0 || tmsc >= end) break;
    const tmts = findAscii(data, "TMTS", off);
    tracks.push({
      index: n,
      slot: u16(data, tmsc + 0x14),
      slotAt: tmsc + 0x14,
      length: tmts >= 0 && tmts < end ? u16(data, tmts + 0x14) : 0,
    });
    off = end;
  }
  return {
    index: u32(data, 8),
    indexAt,
    footer,
    name,
    tempo: tempoTimes10 / 10,
    tracks,
    empty: tracks.every((t) => t.slot === 0),
  };
}

export function patternFileName(slotNumber) {
  return `Pattern${String(slotNumber).padStart(3, "0")}`;
}

export function retargetPattern(buf, patternNumber, slotMap) {
  const out = new Uint8Array(buf);
  const info = parsePattern(out);
  const index = patternNumber - 1;
  for (const at of info.indexAt) setU32(out, at, index);
  for (const track of info.tracks) {
    if (slotMap.has(track.slot)) setU16(out, track.slotAt, slotMap.get(track.slot));
  }
  const renamed = parsePattern(out);
  if (/^PTN\d{3}$/.test(renamed.name)) {
    const label = `PTN${String(patternNumber).padStart(3, "0")}`;
    for (let i = 0; i < label.length; i++) out[renamed.footer + 20 + i] = label.charCodeAt(i);
    out[renamed.footer + 20 + label.length] = 0;
  }
  return out;
}

export function makeSlotRecord(path) {
  const rec = new Uint8Array(0x100);
  const bytes = new TextEncoder().encode(path);
  if (bytes.length + 1 > 0x80) throw new Error(`Sample path is too long: ${path}`);
  rec.set(bytes, 0);
  let pos = bytes.length + 1;
  if (pos % 8) pos += 8 - (pos % 8);
  const unit = Uint8Array.from([0xff, 0x00, 0x00, 0x00, 0x32, 0x00, 0x00, 0x00]);
  while (pos < rec.length) {
    const n = Math.min(8, rec.length - pos);
    rec.set(unit.subarray(0, n), pos);
    pos += n;
  }
  return rec;
}

export function clearSlot(config, slotIndex) {
  const { base } = sampleSlots(config);
  const out = new Uint8Array(config);
  out.fill(0, base + slotIndex * 0x100, base + (slotIndex + 1) * 0x100);
  return out;
}

export function writeSlot(config, slotIndex, path) {
  const { base } = sampleSlots(config);
  const out = new Uint8Array(config);
  out.set(makeSlotRecord(path), base + slotIndex * 0x100);
  return out;
}

export function systemRelative(poolPath) {
  const marker = "/System/";
  const at = poolPath.indexOf(marker);
  if (at < 0) throw new Error(`Unrecognized sample path: ${poolPath}`);
  return poolPath.slice(at + marker.length).split("/");
}

function poolFilePath(folder, file) {
  return `/Lofi-12XT/System/Pool/Audio/${folder}/${file}`;
}

function splitFileName(file) {
  const dot = file.lastIndexOf(".");
  if (dot <= 0) return { stem: file, ext: "" };
  return { stem: file.slice(0, dot), ext: file.slice(dot) };
}

function unusedFileName(file, folder, byPath) {
  const { stem, ext } = splitFileName(file);
  if (!byPath.has(poolFilePath(folder, file))) return file;
  let n = 2;
  while (byPath.has(poolFilePath(folder, `${stem}-${n}${ext}`))) n += 1;
  return `${stem}-${n}${ext}`;
}

export function assignSlots(sourceSlotList, sourceIndexes, destSlotList, destPoolFolder, aliases = new Map()) {
  const byPath = new Map(destSlotList.filter((s) => s.path).map((s) => [s.path, s.index]));
  const taken = new Set(destSlotList.filter((s) => s.path).map((s) => s.index));
  let cursor = 1;
  const nextFree = () => {
    while (cursor < 256 && taken.has(cursor)) cursor++;
    if (cursor >= 256) throw new Error("Your selection exceeds the available number of sample slots.");
    taken.add(cursor);
    return cursor++;
  };
  const needed = [];
  for (const srcIndex of [...new Set(sourceIndexes.filter((n) => n > 0))]) {
    const src = sourceSlotList[srcIndex];
    if (!src?.path) throw new Error(`Track points at empty sample slot ${srcIndex + 1}`);
    if (byPath.has(src.path) || aliases.has(src.path)) continue;
    needed.push(srcIndex);
  }
  let free = 0;
  for (let index = 1; index < 256; index++) if (!taken.has(index)) free += 1;
  if (needed.length > free) {
    const over = needed.length - free;
    throw new Error(`Your selection exceeds the available number of sample slots by ${over} ${over === 1 ? "sample" : "samples"}.`);
  }
  const map = new Map();
  const copies = [];
  for (const srcIndex of [...new Set(sourceIndexes.filter((n) => n > 0))]) {
    const src = sourceSlotList[srcIndex];
    if (!src?.path) throw new Error(`Track points at empty sample slot ${srcIndex + 1}`);
    if (byPath.has(src.path)) {
      map.set(srcIndex, byPath.get(src.path));
      continue;
    }
    if (aliases.has(src.path)) {
      map.set(srcIndex, aliases.get(src.path));
      continue;
    }
    const file = unusedFileName(src.path.split("/").pop(), destPoolFolder, byPath);
    const destPath = poolFilePath(destPoolFolder, file);
    const destIndex = nextFree();
    map.set(srcIndex, destIndex);
    byPath.set(destPath, destIndex);
    copies.push({ fromPath: src.path, toPath: destPath, destIndex, file });
  }
  return { map, copies };
}