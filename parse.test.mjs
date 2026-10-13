import { readFileSync } from "node:fs";
import { assignSlots, parsePattern, projectHash, retargetPattern, sampleSlots } from "./format.js";

const root = new URL("../System/", import.meta.url);
const pattern = new Uint8Array(readFileSync(new URL("Project/BEATS 06/Pattern001", root)));
const config = new Uint8Array(readFileSync(new URL("Project/BEATS 06/Config", root)));
const info = parsePattern(pattern);
const slots = sampleSlots(config).slots;

if (info.tempo !== 93) throw new Error(`tempo ${info.tempo}`);
if (info.name !== "26-09-26B") throw new Error(`name ${info.name}`);
if (info.tracks.map((t) => t.slot).join(",") !== "1,2,3,4,6,7,8,9") {
  throw new Error(info.tracks.map((t) => t.slot).join(","));
}
if (slots[1].file !== "007MIX01.wav") throw new Error(slots[1].path);
if (projectHash(config) !== "1AFC84DF") throw new Error(projectHash(config));

const { map, copies } = assignSlots(slots, info.tracks.map((t) => t.slot), sampleSlots(new Uint8Array(readFileSync(new URL("Project/BEATS01/Config", root)))).slots, "BEATS01_E86ED7A3");
if (copies.length !== 8) throw new Error(`copies ${copies.length}`);
const moved = parsePattern(retargetPattern(pattern, 21, map));
if (moved.index !== 20) throw new Error(`index ${moved.index}`);
if (moved.tracks[0].slot !== map.get(1)) throw new Error("remap");
if (moved.tempo !== 93) throw new Error("tempo changed");
if (moved.name !== "26-09-26B") throw new Error("name changed");
console.log("ok", moved.tracks.map((t) => t.slot).join(","));

const beats02 = new Uint8Array(readFileSync(new URL("Project/BEATS02/Pattern001", root)));
const b2 = parsePattern(beats02);
if (!b2.name || !Number.isFinite(b2.tempo)) throw new Error("BEATS02 parse");
if (b2.indexAt.length !== 1) throw new Error("BEATS02 footer index should stay untouched");
console.log("BEATS02", b2.name, b2.tempo, b2.tracks.map((t) => t.slot).join(","));
