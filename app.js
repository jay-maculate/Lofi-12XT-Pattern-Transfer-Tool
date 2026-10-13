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
const logEl = document.querySelector("#log");
const sides = [document.querySelector("#side-a"), document.querySelector("#side-b")];

let system = null;
const projects = [null, null];

function log(message) {
  const line = document.createElement("div");
  line.textContent = message;
  logEl.prepend(line);
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
  const mark = document.createElement("span");
  mark.className = "twist";
  mark.setAttribute("aria-hidden", "true");
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
  if (!item.info.empty) title.draggable = true;
  title.addEventListener("click", () => {
    const open = row.querySelector(".samples");
    if (open) {
      stopPlayback();
      open.remove();
      row.classList.remove("open");
      return;
    }
    row.classList.add("open");
    expandPattern(row, item, sideIndex);
  });
  row.append(title, meta);
  title.addEventListener("dragstart", (event) => {
    event.dataTransfer.setData("text/plain", `${sideIndex}:${item.number}`);
    event.dataTransfer.effectAllowed = "copy";
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
    const [fromSide, fromNumber] = event.dataTransfer.getData("text/plain").split(":").map(Number);
    dropPattern(fromSide, fromNumber, sideIndex, item.number);
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

function renderSide(sideIndex) {
  const root = sides[sideIndex];
  const project = projects[sideIndex];
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
      projects[sideIndex] = loaded;
      renderSide(sideIndex);
      log(`${chosen}: ${loaded.patterns.filter((p) => p && !p.info.empty).length} patterns with samples.`);
    } catch (error) {
      select.disabled = false;
      log(error.message);
    }
  });
  head.append(select);
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
    const [fromSide, fromNumber] = event.dataTransfer.getData("text/plain").split(":").map(Number);
    const dest = projects[sideIndex];
    const empty = dest?.patterns.find((p) => p && p.info.empty);
    if (!empty) {
      log("Drop onto a pattern slot. This project has no empty slot.");
      return;
    }
    dropPattern(fromSide, fromNumber, sideIndex, empty.number);
  });
  if (project?.patterns) {
    for (const item of project.patterns) list.append(renderPattern(item, sideIndex));
  }
  root.append(list);
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
    log("This project has no empty pattern to restore, so this one was left in place.");
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
    renderSide(sideIndex);
    log(`Pattern ${item.number} in ${project.name} was cleared.`);
  } catch (error) {
    log(error.message);
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
  const bytes = await readFile(await srcDir.getFileHandle(fileName));
  await writeFile(destDir, destParts.at(-1), bytes);
  try {
    const wdt = await readFile(await srcDir.getFileHandle(wdtName));
    await writeFile(destDir, wdtName, wdt);
  } catch {
    log(`No .wdt beside ${fileName}. The wav was still copied.`);
  }
}

async function ensureDir(root, parts) {
  let current = root;
  for (const part of parts) current = await current.getDirectoryHandle(part, { create: true });
  return current;
}

async function dropPattern(fromSide, fromNumber, toSide, toNumber) {
  if (Number.isNaN(fromSide) || fromSide === toSide) return;
  const source = projects[fromSide];
  const dest = projects[toSide];
  if (!source || !dest) return;
  const item = source.patterns[fromNumber - 1];
  const target = dest.patterns[toNumber - 1];
  if (!item || item.info.empty) return;
  if (target && !target.info.empty) {
    const ok = confirm(`Replace pattern ${toNumber} in ${dest.name}?`);
    if (!ok) return;
  }
  try {
    log(`Copying ${source.name} pattern ${fromNumber} to ${dest.name} pattern ${toNumber}…`);
    const folder = poolFolderForProject(dest.config, dest.name);
    const { map, copies } = assignSlots(
      source.slots,
      item.info.tracks.map((t) => t.slot),
      dest.slots,
      folder,
    );
    for (const copy of copies) {
      log(`Sample slot ${copy.destIndex + 1}: ${copy.file}`);
      await copyBytes(copy.fromPath, copy.toPath);
    }
    let config = dest.config;
    for (const copy of copies) config = writeSlot(config, copy.destIndex, copy.toPath);
    if (copies.length) await writeFile(dest.dir, "Config", config);
    const patched = retargetPattern(item.bytes, toNumber, map);
    await writeFile(dest.dir, patternFileName(toNumber), patched);
    dest.config = config;
    dest.slots = sampleSlots(config).slots;
    dest.patterns[toNumber - 1] = {
      number: toNumber,
      fileName: patternFileName(toNumber),
      bytes: patched,
      info: parsePattern(patched),
    };
    renderSide(toSide);
    log(`Pattern ${toNumber} in ${dest.name} is ready.`);
  } catch (error) {
    log(error.message);
    console.error(error);
  }
}

document.querySelector("#info").addEventListener("click", () => {
  document.querySelector("#info-help").showModal();
});

openButton.addEventListener("click", async () => {
  if (!window.showDirectoryPicker) {
    log("This page needs Chrome or Edge. The folder picker is not in this browser.");
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
    if (error.name !== "AbortError") log(error.message);
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
    log(`Found ${names.length} projects. Pick one on each side, then drag a pattern across.`);
  } catch (error) {
    if (error.name !== "AbortError") log(error.message);
  }
});
