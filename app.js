import {
  assignSlots,
  clearSlot,
  parsePattern,
  patternFileName,
  poolFolderForProject,
  projectHash,
  retargetPattern,
  sampleSlots,
  systemRelative,
  writeSlot,
} from "./format.js";

const openButton = document.querySelector("#open");
document.querySelector("#boot")?.remove();
const workspace = document.querySelector("#workspace");
const sides = [document.querySelector("#side-a"), document.querySelector("#side-b")];

let system = null;
const projects = [null, null];
const selection = [new Set(), new Set()];
const selectionAnchor = [null, null];
let progressBusy = false;

document.querySelector("#progress").addEventListener("cancel", (event) => {
  if (progressBusy) event.preventDefault();
});

function openProgress(title) {
  const dialog = document.querySelector("#progress");
  dialog.querySelector("h2").textContent = title;
  document.querySelector("#progress-label").textContent = "";
  document.querySelector("#progress-files").replaceChildren();
  dialog.querySelector(".fill").style.width = "0%";
  document.querySelector("#progress-close").hidden = true;
  progressBusy = true;
  if (!dialog.open) dialog.showModal();
}

function reportProgress(done, total, label) {
  document.querySelector("#progress-label").textContent = label;
  document.querySelector("#progress .fill").style.width = `${Math.round((done / total) * 100)}%`;
  const line = document.createElement("li");
  line.textContent = label;
  document.querySelector("#progress-files").prepend(line);
}

function closeProgress() {
  progressBusy = false;
  document.querySelector("#progress").close();
}

function failProgress(message) {
  progressBusy = false;
  document.querySelector("#progress-label").textContent = message;
  document.querySelector("#progress-close").hidden = false;
}

async function hasDir(dir, name) {
  try {
    await dir.getDirectoryHandle(name);
    return true;
  } catch {
    return false;
  }
}

async function resolveSystem(root) {
  if ((await hasDir(root, "Project")) && (await hasDir(root, "Pool"))) return root;
  if (await hasDir(root, "System")) return root.getDirectoryHandle("System");
  throw new Error("Choose the SD card, or the System folder on it.");
}

async function readFile(handle) {
  const file = await handle.getFile();
  return new Uint8Array(await file.arrayBuffer());
}

async function writeFile(dir, name, bytes) {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(bytes);
  await writable.close();
}

async function walk(dir, parts) {
  let current = dir;
  for (const part of parts) current = await current.getDirectoryHandle(part);
  return current;
}

async function listProjects() {
  const projectDir = await system.getDirectoryHandle("Project");
  const onCard = new Set();
  for await (const [name, handle] of projectDir.entries()) {
    if (handle.kind !== "directory" || name.startsWith(".")) continue;
    try {
      await handle.getFileHandle("Config");
      onCard.add(name);
    } catch {
      /* not a project */
    }
  }
  const ordered = [];
  const seen = new Set();
  try {
    const list = await readFile(await projectDir.getFileHandle("Project.lst"));
    const lines = new TextDecoder("latin1").decode(list).split(/\r?\n/);
    lines.forEach((line, index) => {
      const name = line.replace(/^>/, "").trim();
      if (!name || !onCard.has(name) || seen.has(name)) return;
      seen.add(name);
      ordered.push({ name, slot: index + 1 });
    });
  } catch {
    /* Project.lst is missing; fall through to folder order */
  }
  return ordered;
}

function showProgress(sideIndex, label, fraction) {
  const list = sides[sideIndex].querySelector(".list");
  if (!list) return;
  let box = list.querySelector(".loading");
  if (!box) {
    list.replaceChildren();
    box = document.createElement("div");
    box.className = "loading";
    box.innerHTML = `<p></p><div class="track"><div class="fill"></div></div>`;
    list.append(box);
  }
  box.querySelector("p").textContent = label;
  box.querySelector(".fill").style.width = `${Math.round(fraction * 100)}%`;
}

async function loadProject(name, sideIndex) {
  const dir = await (await system.getDirectoryHandle("Project")).getDirectoryHandle(name);
  showProgress(sideIndex, `Reading ${name}…`, 0.02);
  const config = await readFile(await dir.getFileHandle("Config"));
  const patterns = [];
  for (let n = 1; n <= 128; n++) {
    const fileName = patternFileName(n);
    showProgress(sideIndex, `Reading ${name} · pattern ${n} of 128`, n / 128);
    try {
      const bytes = await readFile(await dir.getFileHandle(fileName));
      patterns.push({ number: n, fileName, bytes, info: parsePattern(bytes) });
    } catch {
      patterns.push(null);
    }
    if (n % 4 === 0) await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  return { name, dir, config, slots: sampleSlots(config).slots, patterns };
}

let audioContext = null;
let playing = null;
const audioCache = new Map();

function audio() {
  if (!audioContext) audioContext = new AudioContext();
  return audioContext;
}

function stopPlayback() {
  if (!playing) return;
  try { playing.source.stop(); } catch { /* already stopped */ }
  playing.button.textContent = "Play";
  playing = null;
}

async function loadAudio(poolPath) {
  if (audioCache.has(poolPath)) return audioCache.get(poolPath);
  const pending = (async () => {
    const parts = systemRelative(poolPath);
    const dir = await walk(system, parts.slice(0, -1));
    const bytes = await readFile(await dir.getFileHandle(parts.at(-1)));
    return audio().decodeAudioData(bytes.buffer.slice(0));
  })();
  audioCache.set(poolPath, pending);
  try {
    return await pending;
  } catch (error) {
    audioCache.delete(poolPath);
    throw error;
  }
}

function drawWaveform(canvas, buffer) {
  const width = Math.max(1, Math.floor(canvas.clientWidth * devicePixelRatio));
  const height = Math.floor(36 * devicePixelRatio);
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const data = buffer.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / width));
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#e2a04a";
  for (let x = 0; x < width; x++) {
    let peak = 0;
    const start = x * step;
    for (let i = 0; i < step; i += 8) peak = Math.max(peak, Math.abs(data[start + i] || 0));
    const bar = Math.max(1, peak * height);
    ctx.fillRect(x, (height - bar) / 2, 1, bar);
  }
}

function playBuffer(buffer, button) {
  stopPlayback();
  const ctx = audio();
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.onended = () => {
    if (playing?.source === source) {
      playing.button.textContent = "Play";
      playing = null;
    }
  };
  source.start();
  button.textContent = "Stop";
  playing = { source, button };
}

async function expandPattern(row, item, sideIndex) {
  const panel = document.createElement("div");
  panel.className = "samples";
  row.append(panel);
  for (const track of item.info.tracks) {
    const slot = track.slot > 0 ? projects[sideIndex].slots[track.slot] : null;
    const line = document.createElement("div");
    line.className = "sample";
    const head = document.createElement("div");
    head.className = "sample-head";
    const label = document.createElement("span");
    const missing = track.slot > 0 && !slot?.file;
    label.textContent = slot?.file
      ? `Track ${track.index + 1} · ${slot.file}`
      : missing
        ? `Track ${track.index + 1} · sample missing`
        : `Track ${track.index + 1} · no sample`;
    if (missing) label.classList.add("missing-sample");
    head.append(label);
    line.append(head);
    if (slot?.path) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "play";
      button.textContent = "Play";
      head.append(button);
      const canvas = document.createElement("canvas");
      line.append(canvas);
      button.addEventListener("click", async (event) => {
        event.stopPropagation();
        if (playing?.button === button) {
          stopPlayback();
          return;
        }
        button.disabled = true;
        try {
          const buffer = await loadAudio(slot.path);
          if (!canvas.dataset.drawn) {
            drawWaveform(canvas, buffer);
            canvas.dataset.drawn = "1";
          }
          playBuffer(buffer, button);
        } catch (error) {
          label.textContent = `Track ${track.index + 1} · ${error.message}`;
        } finally {
          button.disabled = false;
        }
      });
      loadAudio(slot.path).then((buffer) => {
        drawWaveform(canvas, buffer);
        canvas.dataset.drawn = "1";
      }).catch((error) => {
        label.textContent = `Track ${track.index + 1} · ${error.message}`;
      });
    }
    panel.append(line);
  }
}

function renderPattern(item, sideIndex) {
  const row = document.createElement("div");
  row.className = "pattern";
  row.dataset.side = String(sideIndex);
  if (!item) {
    row.classList.add("missing");
    row.textContent = "missing file";
    return row;
  }
  row.dataset.number = String(item.number);
  if (item.info.empty) row.classList.add("empty");
  const title = document.createElement("div");
  title.className = "pattern-title";
  const mark = document.createElement("button");
  mark.type = "button";
  mark.className = "twist-hit";
  mark.title = "Show samples";
  mark.setAttribute("aria-label", `Show samples for pattern ${item.number}`);
  const markGlyph = document.createElement("span");
  markGlyph.className = "twist";
  markGlyph.setAttribute("aria-hidden", "true");
  mark.append(markGlyph);
  mark.addEventListener("click", (event) => {
    event.stopPropagation();
    const open = row.querySelector(".samples");
    if (open) {
      stopPlayback();
      open.remove();
      row.classList.remove("open");
      mark.title = "Show samples";
      return;
    }
    row.classList.add("open");
    mark.title = "Hide samples";
    expandPattern(row, item, sideIndex);
  });
  mark.addEventListener("dragstart", (event) => event.preventDefault());
  const num = document.createElement("span");
  num.className = "num";
  num.textContent = String(item.number).padStart(3, "0");
  const name = document.createElement("span");
  name.textContent = item.info.name || "untitled";
  const tempo = document.createElement("span");
  tempo.className = "tempo";
  tempo.textContent = item.info.empty ? "" : `${item.info.tempo} BPM`;
  title.append(mark, num, name, tempo);
  if (!item.info.empty) {
    const trash = document.createElement("button");
    trash.type = "button";
    trash.className = "trash";
    trash.title = "Delete pattern";
    trash.setAttribute("aria-label", `Delete pattern ${item.number}`);
    trash.textContent = "🗑";
    trash.addEventListener("click", (event) => {
      event.stopPropagation();
      deletePattern(sideIndex, item);
    });
    trash.addEventListener("dragstart", (event) => event.preventDefault());
    title.append(trash);
  }
  const meta = document.createElement("div");
  meta.className = "meta";
  if (item.info.empty) {
    meta.textContent = "empty";
  } else {
    const seen = new Set();
    item.info.tracks.filter((t) => t.slot > 0).forEach((t) => {
      const file = projects[sideIndex].slots[t.slot]?.file;
      const label = file || "sample missing";
      if (seen.has(label)) return;
      seen.add(label);
      if (meta.childNodes.length) meta.append(", ");
      const part = document.createElement("span");
      part.textContent = label;
      if (!file) part.className = "missing-sample";
      meta.append(part);
    });
  }
  if (selection[sideIndex].has(item.number)) row.classList.add("selected");
  if (!item.info.empty) title.draggable = true;
  row.addEventListener("click", (event) => {
    if (item.info.empty) return;
    if (event.target.closest(".twist-hit, .trash, .samples, .play")) return;
    const selected = selection[sideIndex];
    if (event.shiftKey) {
      selectRange(sideIndex, item.number);
    } else if (event.ctrlKey || event.metaKey) {
      if (selected.has(item.number)) selected.delete(item.number);
      else selected.add(item.number);
      selectionAnchor[sideIndex] = item.number;
    } else {
      selected.clear();
      selected.add(item.number);
      selectionAnchor[sideIndex] = item.number;
    }
    paintSelection(sideIndex);
  });
  row.append(title, meta);
  title.addEventListener("dragstart", (event) => {
    const numbers = selection[sideIndex].has(item.number)
      ? [...selection[sideIndex]].sort((a, b) => a - b)
      : [item.number];
    event.dataTransfer.setData("text/plain", `${sideIndex}:${numbers.join(",")}`);
    event.dataTransfer.effectAllowed = "copyMove";
  });
  row.addEventListener("dragover", (event) => {
    event.preventDefault();
    row.classList.add("drop");
  });
  row.addEventListener("dragleave", () => row.classList.remove("drop"));
  row.addEventListener("drop", (event) => {
    event.preventDefault();
    event.stopPropagation();
    row.classList.remove("drop");
    const drag = readDrag(event.dataTransfer.getData("text/plain"));
    transferPatterns(drag.side, drag.numbers, sideIndex, item.number);
  });
  return row;
}

function usageMeter(label, fraction) {
  const row = document.createElement("div");
  row.className = "usage-row";
  const text = document.createElement("p");
  text.textContent = label;
  const track = document.createElement("div");
  track.className = "track";
  const fill = document.createElement("div");
  fill.className = "fill";
  fill.style.width = `${Math.round(Math.min(1, fraction) * 100)}%`;
  track.append(fill);
  row.append(text, track);
  return row;
}

function readDrag(payload) {
  const [side, list] = payload.split(":");
  return {
    side: Number(side),
    numbers: (list || "").split(",").map(Number).filter((n) => n > 0),
  };
}

function selectRange(sideIndex, number) {
  const selected = selection[sideIndex];
  if (selectionAnchor[sideIndex] == null) selectionAnchor[sideIndex] = number;
  const anchor = selectionAnchor[sideIndex];
  selected.clear();
  const lo = Math.min(anchor, number);
  const hi = Math.max(anchor, number);
  for (let n = lo; n <= hi; n++) {
    const item = projects[sideIndex].patterns[n - 1];
    if (item && !item.info.empty) selected.add(n);
  }
  if (selected.size === 0) selected.add(number);
}

function paintSelection(sideIndex) {
  const list = sides[sideIndex].querySelector(".list");
  if (!list) return;
  for (const row of list.querySelectorAll(".pattern")) {
    row.classList.toggle("selected", selection[sideIndex].has(Number(row.dataset.number)));
  }
  updateSelectionSummary(sideIndex);
}

function selectionSummaryText(sideIndex) {
  const numbers = [...selection[sideIndex]];
  const project = projects[sideIndex];
  if (!project || numbers.length < 2) return "";
  const samples = new Set();
  for (const number of numbers) {
    const item = project.patterns[number - 1];
    if (!item) continue;
    for (const track of item.info.tracks) {
      if (track.slot <= 0) continue;
      samples.add(project.slots[track.slot]?.path || `slot:${track.slot}`);
    }
  }
  const patterns = `${numbers.length} patterns`;
  const sampleLabel = `${samples.size} unique ${samples.size === 1 ? "sample" : "samples"}`;
  return `${patterns} selected, ${sampleLabel}`;
}

function updateSelectionSummary(sideIndex) {
  const summary = sides[sideIndex].querySelector(".selection-summary");
  if (!summary) return;
  const text = selectionSummaryText(sideIndex);
  summary.textContent = text;
  summary.hidden = !text;
}

function renderSide(sideIndex) {
  const root = sides[sideIndex];
  const project = projects[sideIndex];
  const scrollTop = root.querySelector(".list")?.scrollTop || 0;
  root.innerHTML = "";
  const head = document.createElement("div");
  head.className = "side-head";
  const select = document.createElement("select");
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "Select a project";
  select.append(blank);
  for (const choice of project?.choices || []) {
    const option = document.createElement("option");
    option.value = choice.name;
    option.textContent = `${choice.slot}  ${choice.name}`;
    if (project?.name === choice.name) option.selected = true;
    select.append(option);
  }
  select.addEventListener("change", async () => {
    if (!select.value) return;
    const chosen = select.value;
    select.disabled = true;
    head.querySelector(".usage")?.remove();
    try {
      const loaded = await loadProject(chosen, sideIndex);
      loaded.choices = project.choices;
      selection[sideIndex].clear();
      selectionAnchor[sideIndex] = null;
      projects[sideIndex] = loaded;
      renderSide(sideIndex);
    } catch (error) {
      select.disabled = false;
      alert(error.message);
    }
  });
  head.append(select);
  const summary = document.createElement("p");
  summary.className = "selection-summary";
  summary.hidden = true;
  head.prepend(summary);
  if (project?.slots) {
    const usedSamples = project.slots.filter((slot) => slot.index > 0 && slot.file).length;
    const usedPatterns = project.patterns.filter((item) => item && !item.info.empty).length;
    const usage = document.createElement("div");
    usage.className = "usage";
    usage.append(
      usageMeter(`${usedSamples} / 255 Sample Slots Used`, usedSamples / 255),
      usageMeter(`${usedPatterns} / 128 Pattern Slots Used`, usedPatterns / 128),
    );
    head.append(usage);
  }
  root.append(head);
  updateSelectionSummary(sideIndex);
  const list = document.createElement("div");
  list.className = "list";
  list.addEventListener("dragover", (event) => {
    event.preventDefault();
    const rect = list.getBoundingClientRect();
    const edge = 56;
    if (event.clientY < rect.top + edge) list.scrollTop -= 18;
    else if (event.clientY > rect.bottom - edge) list.scrollTop += 18;
  });
  list.addEventListener("drop", (event) => {
    const drag = readDrag(event.dataTransfer.getData("text/plain"));
    if (drag.side === sideIndex) return;
    const dest = projects[sideIndex];
    const empty = dest?.patterns.find((p) => p && p.info.empty);
    if (!empty) {
      alert("Drop onto a pattern slot. This project has no empty slot.");
      return;
    }
    transferPatterns(drag.side, drag.numbers, sideIndex, empty.number);
  });
  if (project?.patterns) {
    for (const item of project.patterns) list.append(renderPattern(item, sideIndex));
  }
  root.append(list);
  list.scrollTop = scrollTop;
}

async function deletePattern(sideIndex, item) {
  const project = projects[sideIndex];
  const usedByOthers = new Set();
  for (const pattern of project.patterns) {
    if (!pattern || pattern.number === item.number) continue;
    for (const track of pattern.info.tracks) {
      if (track.slot > 0) usedByOthers.add(track.slot);
    }
  }
  const mine = [...new Set(item.info.tracks.map((track) => track.slot).filter((slot) => slot > 0))];
  const clear = mine.filter((slot) => !usedByOthers.has(slot));
  const keep = mine.filter((slot) => usedByOthers.has(slot));
  const fileName = (slot) => project.slots[slot]?.file || `slot ${slot + 1}`;
  const lines = [
    `Delete pattern ${item.number} (${item.info.name || "untitled"}) from ${project.name}?`,
    "",
    "The pattern will be cleared. Sample files on the card are kept.",
  ];
  if (clear.length) {
    lines.push("", "These sample slots will be cleared:");
    for (const slot of clear) lines.push(fileName(slot));
  }
  if (keep.length) {
    lines.push("", "These slots stay loaded because other patterns use them:");
    for (const slot of keep) lines.push(fileName(slot));
  }
  if (!confirm(lines.join("\n"))) return;

  const template = project.patterns.find((pattern) => pattern && pattern.info.empty);
  if (!template) {
    alert("This project has no empty pattern to restore, so this one was left in place.");
    return;
  }
  try {
    stopPlayback();
    const blank = retargetPattern(template.bytes, item.number, new Map());
    await writeFile(project.dir, patternFileName(item.number), blank);
    let config = project.config;
    for (const slot of clear) config = clearSlot(config, slot);
    if (clear.length) await writeFile(project.dir, "Config", config);
    project.config = config;
    project.slots = sampleSlots(config).slots;
    project.patterns[item.number - 1] = {
      number: item.number,
      fileName: patternFileName(item.number),
      bytes: blank,
      info: parsePattern(blank),
    };
    selection[sideIndex].delete(item.number);
    renderSide(sideIndex);
  } catch (error) {
    alert(error.message);
    console.error(error);
  }
}

async function copyBytes(fromPath, toPath) {
  const srcParts = systemRelative(fromPath);
  const destParts = systemRelative(toPath);
  const srcDir = await walk(system, srcParts.slice(0, -1));
  const destDir = await ensureDir(system, destParts.slice(0, -1));
  const fileName = srcParts.at(-1);
  const wdtName = fileName.replace(/\.wav$/i, ".wdt");
  const destWav = destParts.at(-1);
  const bytes = await readFile(await srcDir.getFileHandle(fileName));
  await writeFile(destDir, destWav, bytes);
  try {
    const wdt = await readFile(await srcDir.getFileHandle(wdtName));
    await writeFile(destDir, destWav.replace(/\.wav$/i, ".wdt"), wdt);
  } catch {
    /* The wav is enough when the device has no .wdt beside it. */
  }
}

async function ensureDir(root, parts) {
  let current = root;
  for (const part of parts) current = await current.getDirectoryHandle(part, { create: true });
  return current;
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameSampleName(candidate, file) {
  if (candidate === file) return true;
  const dot = file.lastIndexOf(".");
  const stem = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot) : "";
  if (!candidate.startsWith(`${stem}-`) || !candidate.endsWith(ext)) return false;
  return /^\d+$/.test(candidate.slice(stem.length + 1, candidate.length - ext.length));
}

async function matchingSlots(sourceSlots, sourceIndexes, destSlots) {
  const aliases = new Map();
  const seen = new Set();
  for (const srcIndex of sourceIndexes) {
    const src = sourceSlots[srcIndex];
    if (!src?.path || seen.has(src.path)) continue;
    seen.add(src.path);
    const file = src.path.split("/").pop();
    const candidates = destSlots.filter((slot) => slot.path && sameSampleName(slot.file, file));
    if (!candidates.length) continue;
    let srcBytes;
    try {
      const parts = systemRelative(src.path);
      srcBytes = await readFile(await (await walk(system, parts.slice(0, -1))).getFileHandle(parts.at(-1)));
    } catch {
      continue;
    }
    for (const slot of candidates) {
      try {
        const parts = systemRelative(slot.path);
        const destBytes = await readFile(await (await walk(system, parts.slice(0, -1))).getFileHandle(parts.at(-1)));
        if (sameBytes(srcBytes, destBytes)) {
          aliases.set(src.path, slot.index);
          break;
        }
      } catch {
        /* A missing dest file is not a match. */
      }
    }
  }
  return aliases;
}

function planShift(dest, start, count) {
  const last = start + count - 1;
  const displaced = [];
  const following = [];
  for (let number = start; number <= 128; number++) {
    const item = dest.patterns[number - 1];
    if (!item || item.info.empty) continue;
    if (number <= last) displaced.push(item);
    else following.push(item);
  }
  const shiftBy = displaced.length;
  const moves = [];
  displaced.forEach((item, index) => moves.push({ item, number: last + 1 + index }));
  for (const item of following) moves.push({ item, number: item.number + shiftBy });
  return { moves, overflow: moves.some((move) => move.number > 128) };
}

async function applyShift(dest, plan) {
  const template = dest.patterns.find((pattern) => pattern && pattern.info.empty);
  const writes = plan.moves.map((move) => ({
    number: move.number,
    bytes: retargetPattern(move.item.bytes, move.number, new Map()),
  }));
  const taken = new Set(writes.map((write) => write.number));
  const clears = [...new Set(plan.moves.map((move) => move.item.number))].filter((number) => !taken.has(number));
  if (clears.length && !template) {
    throw new Error("This project has no empty pattern to restore, so the shift was left unfinished.");
  }
  const total = writes.length + clears.length;
  let done = 0;
  for (const write of writes.sort((a, b) => b.number - a.number)) {
    reportProgress(done, total, `Shifting pattern ${write.number}`);
    await writeFile(dest.dir, patternFileName(write.number), write.bytes);
    storePattern(dest, write.number, write.bytes);
    done += 1;
  }
  for (const number of clears) {
    const blank = retargetPattern(template.bytes, number, new Map());
    reportProgress(done, total, `Clearing pattern ${number}`);
    await writeFile(dest.dir, patternFileName(number), blank);
    storePattern(dest, number, blank);
    done += 1;
  }
}

function blankPattern(project, number) {
  const template = project.patterns.find((pattern) => pattern && pattern.info.empty);
  if (!template) throw new Error("This project has no empty pattern to restore, so the move was left unfinished.");
  return retargetPattern(template.bytes, number, new Map());
}

function storePattern(project, number, bytes) {
  project.patterns[number - 1] = {
    number,
    fileName: patternFileName(number),
    bytes,
    info: parsePattern(bytes),
  };
}

async function transferPatterns(fromSide, numbers, toSide, toNumber) {
  if (Number.isNaN(fromSide) || !numbers.length) return;
  const source = projects[fromSide];
  const dest = projects[toSide];
  if (!source || !dest) return;
  const moving = fromSide === toSide;
  if (moving && numbers.includes(toNumber)) return;
  const items = numbers.map((number) => source.patterns[number - 1]);
  if (items.some((item) => !item || item.info.empty)) return;
  const last = toNumber + items.length - 1;
  if (toNumber < 1 || last > 128) {
    alert("There are not enough pattern slots from the drop point.");
    return;
  }
  const destinations = items.map((_, index) => toNumber + index);
  const occupied = destinations.filter((number) => {
    if (moving && numbers.includes(number)) return false;
    const target = dest.patterns[number - 1];
    return target && !target.info.empty;
  });
  let shiftPlan = null;
  if (!moving && occupied.length) {
    shiftPlan = planShift(dest, toNumber, items.length);
    if (shiftPlan.overflow) {
      alert(`Not enough free pattern slots at the end of ${dest.name} to shift patterns down.`);
      return;
    }
    const open = items.length - occupied.length;
    const extra = occupied.length === 1 ? "the extra pattern" : "the extra patterns";
    const blocking = occupied.length === 1 ? "one pattern is" : `${occupied.length} patterns are`;
    const openText = open === 0
      ? "No pattern slots are open"
      : `Only ${open} pattern ${open === 1 ? "slot is" : "slots are"} open`;
    const ok = confirm(`${openText} and ${blocking} already in the way. Shift existing patterns down to fit ${extra}?`);
    if (!ok) return;
  } else if (occupied.length === 1) {
    if (!confirm(`Replace pattern ${occupied[0]} in ${dest.name}?`)) return;
  } else if (occupied.length > 1) {
    if (!confirm(`Replace ${occupied.length} patterns in ${dest.name}, starting at ${toNumber}?`)) return;
  }
  const title = moving ? "Moving" : "Copying";
  try {
    openProgress(title);
    if (moving) {
      const clears = numbers.filter((number) => !destinations.includes(number));
      const blanks = new Map(clears.map((number) => [number, blankPattern(source, number)]));
      const total = items.length + clears.length;
      let done = 0;
      for (let index = 0; index < items.length; index++) {
        const number = destinations[index];
        const patched = retargetPattern(items[index].bytes, number, new Map());
        reportProgress(done, total, `Pattern ${items[index].number} → ${number}`);
        await writeFile(dest.dir, patternFileName(number), patched);
        storePattern(dest, number, patched);
        done += 1;
      }
      for (const number of clears) {
        reportProgress(done, total, `Clearing pattern ${number}`);
        const blank = blanks.get(number);
        await writeFile(source.dir, patternFileName(number), blank);
        storePattern(source, number, blank);
        selection[fromSide].delete(number);
        done += 1;
      }
      for (const number of destinations) selection[fromSide].add(number);
    } else {
      if (shiftPlan) await applyShift(dest, shiftPlan);
      const folder = poolFolderForProject(dest.config, dest.name);
      const tracks = items.flatMap((item) => item.info.tracks.map((track) => track.slot));
      const aliases = await matchingSlots(source.slots, tracks, dest.slots);
      const { map, copies } = assignSlots(source.slots, tracks, dest.slots, folder, aliases);
      const total = copies.length + items.length + (copies.length ? 1 : 0);
      let done = 0;
      let config = dest.config;
      for (const copy of copies) {
        reportProgress(done, total, copy.file);
        await copyBytes(copy.fromPath, copy.toPath);
        config = writeSlot(config, copy.destIndex, copy.toPath);
        done += 1;
      }
      if (copies.length) {
        reportProgress(done, total, "Saving sample slots");
        await writeFile(dest.dir, "Config", config);
        done += 1;
      }
      dest.config = config;
      dest.slots = sampleSlots(config).slots;
      for (let index = 0; index < items.length; index++) {
        const number = destinations[index];
        const patched = retargetPattern(items[index].bytes, number, map);
        reportProgress(done, total, `Pattern ${items[index].number} → ${number}`);
        await writeFile(dest.dir, patternFileName(number), patched);
        storePattern(dest, number, patched);
        done += 1;
      }
    }
    document.querySelector("#progress .fill").style.width = "100%";
    renderSide(toSide);
    closeProgress();
  } catch (error) {
    console.error(error);
    if (document.querySelector("#progress").open) failProgress(error.message);
    else alert(error.message);
  }
}

document.querySelector("#info").addEventListener("click", () => {
  document.querySelector("#info-help").showModal();
});

openButton.addEventListener("click", async () => {
  if (!window.showDirectoryPicker) {
    alert("This page needs Chrome or Edge. The folder picker is not in this browser.");
    return;
  }
  const help = document.querySelector("#pick-help");
  help.showModal();
  let picked;
  try {
    picked = await new Promise((resolve, reject) => {
      const cont = document.querySelector("#pick-continue");
      const onClose = () => {
        cont.removeEventListener("click", onContinue);
        resolve(null);
      };
      async function onContinue() {
        help.removeEventListener("close", onClose);
        try {
          const dir = await showDirectoryPicker({ mode: "readwrite", id: "lofi12xt-sd" });
          help.close();
          resolve(dir);
        } catch (error) {
          help.close();
          reject(error);
        }
      }
      cont.addEventListener("click", onContinue);
      help.addEventListener("close", onClose);
    });
  } catch (error) {
    if (error.name !== "AbortError") alert(error.message);
    return;
  }
  if (!picked) return;
  try {
    system = await resolveSystem(picked);
    const names = await listProjects();
    projects[0] = { choices: names };
    projects[1] = { choices: names };
    workspace.hidden = false;
    renderSide(0);
    renderSide(1);
  } catch (error) {
    if (error.name !== "AbortError") alert(error.message);
  }
});
