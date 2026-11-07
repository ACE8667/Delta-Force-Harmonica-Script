// TXT 曲谱解析与序列化。
// 浏览器里挂到 window.ChartText；Node 里可通过 require 使用，方便测试。
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ChartText = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const BASE_MIDI = [60, 62, 64, 65, 67, 69, 71, 72];
  const SHARP_NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  // 同字母候选轨道（0 基）：C 有 C4 和 C5 两个键，其余字母只有一个。
  const LETTER_LANES = { C: [0, 7], D: [1], E: [2], F: [3], G: [4], A: [5], B: [6] };
  const MIN_BPM = 30;
  const MAX_BPM = 240;
  const MAX_EVENTS = 10000;
  const DEFAULT_LINE_BEATS = 16;

  function formatPitch(midi) {
    const pitchClass = ((midi % 12) + 12) % 12;
    const octave = Math.floor(midi / 12) - 1;
    return `${SHARP_NOTE_NAMES[pitchClass]}${octave}`;
  }

  function pitchClassToMidi(letter, sharp, octave) {
    const pitchClass = SHARP_NOTE_NAMES.indexOf(`${letter}${sharp}`);
    if (pitchClass < 0) return null;
    return (octave + 1) * 12 + pitchClass;
  }

  function stateFromDiff(diff) {
    if (diff === 0 || diff === 1) return { transpose: "center", semitone: diff === 1 };
    if (diff === 12 || diff === 13) return { transpose: "up", semitone: diff === 13 };
    if (diff === -12 || diff === -11) return { transpose: "down", semitone: diff === -11 };
    return null;
  }

  function tokenError(lineNumber, tokenNumber, raw, message) {
    return new Error(`第 ${lineNumber} 行第 ${tokenNumber} 个 token「${raw}」：${message}`);
  }

  function parseToken(raw, lineNumber, tokenNumber) {
    const match = /^(.+?)([—\-_]+)$/.exec(raw);
    if (!match) {
      throw tokenError(lineNumber, tokenNumber, raw, "缺少时值符号（— / - / _）。");
    }

    const durationText = match[2];
    let duration = 0;
    for (const symbol of durationText) {
      if (symbol === "—") duration += 1;
      else if (symbol === "-") duration += 0.5;
      else if (symbol === "_") duration += 0.25;
      else throw tokenError(lineNumber, tokenNumber, raw, "时值符号无效。");
    }
    duration = Math.round(duration * 4) / 4;
    if (duration <= 0) throw tokenError(lineNumber, tokenNumber, raw, "时值必须大于 0。");

    let notePart = match[1];
    const arrows = notePart.match(/[↑↓]/g) || [];
    let octaveShift = 0;
    for (const arrow of arrows) octaveShift += arrow === "↑" ? 12 : -12;
    notePart = notePart.replace(/[↑↓]/g, "");

    if (/^[Rr]$/.test(notePart)) {
      if (octaveShift !== 0) throw tokenError(lineNumber, tokenNumber, raw, "休止符不能带八度箭头。");
      return { isRest: true, duration, raw };
    }

    const noteMatch = /^([A-Ga-g])(#?)(\d+)$/.exec(notePart);
    if (!noteMatch) {
      throw tokenError(lineNumber, tokenNumber, raw, "音名格式无效，应为 A–G + 可选 # + 八度数字。");
    }

    const letter = noteMatch[1].toUpperCase();
    const midi = pitchClassToMidi(letter, noteMatch[2], Number(noteMatch[3]));
    if (midi == null) throw tokenError(lineNumber, tokenNumber, raw, "音名无效。");

    return { isRest: false, letter, midi: midi + octaveShift, duration, raw };
  }

  // C 的落轨按“前一个音的走向”决定：
  // 往上走到 C 就用高音区的 C（lane 8），往下走到 C 就用低音区的 C（lane 1）。
  // 每行第一个音没有“前一个音”，改用后一个音的走向。
  function chooseLane(token, previousMidi, nextMidi, previousLane, context) {
    const laneIndexes = LETTER_LANES[token.letter];
    const candidates = [];

    for (const laneIndex of laneIndexes) {
      const state = stateFromDiff(token.midi - BASE_MIDI[laneIndex]);
      if (state) candidates.push({ lane: laneIndex, ...state });
    }

    if (candidates.length === 0) {
      throw tokenError(
        context.lineNumber,
        context.tokenNumber,
        context.raw,
        `音高 ${formatPitch(token.midi)} 超出乐器范围或无法落轨。`
      );
    }

    if (candidates.length === 1) return candidates[0];

    let preferredLane;
    if (previousMidi != null && token.midi !== previousMidi) {
      preferredLane = token.midi > previousMidi ? 7 : 0;
    } else if (previousMidi == null && nextMidi != null && token.midi !== nextMidi) {
      preferredLane = token.midi > nextMidi ? 7 : 0;
    } else if (previousMidi === token.midi && (previousLane === 0 || previousLane === 7)) {
      preferredLane = previousLane;
    } else {
      preferredLane = token.midi >= 72 ? 7 : 0;
    }

    return candidates.find((candidate) => candidate.lane === preferredLane) || candidates[0];
  }

  function parse(text, options = {}) {
    if (typeof text !== "string") throw new Error("曲谱内容必须是文本。");

    const source = text.replace(/^\uFEFF/, "");
    const lines = source.split(/\r?\n/);
    const noteLines = [];
    let title = "";
    let bpm = 80;
    let bpmSeen = false;

    lines.forEach((rawLine, index) => {
      const lineNumber = index + 1;
      const commentIndex = rawLine.indexOf("//");
      const line = (commentIndex >= 0 ? rawLine.slice(0, commentIndex) : rawLine).trim();
      if (!line) return;

      const bpmMatch = /^BPM\s*=\s*(.*)$/i.exec(line);
      if (bpmMatch) {
        if (bpmSeen) throw new Error(`第 ${lineNumber} 行：BPM 重复。`);
        const value = bpmMatch[1].trim();
        if (!/^\d+$/.test(value)) throw new Error(`第 ${lineNumber} 行：BPM 必须是 ${MIN_BPM}–${MAX_BPM} 的整数。`);
        bpm = Number(value);
        if (bpm < MIN_BPM || bpm > MAX_BPM) {
          throw new Error(`第 ${lineNumber} 行：BPM 必须是 ${MIN_BPM}–${MAX_BPM} 的整数。`);
        }
        bpmSeen = true;
        return;
      }

      const titleMatch = /^TITLE\s*=\s*(.*)$/i.exec(line);
      if (titleMatch) {
        title = titleMatch[1].trim();
        return;
      }

      const tokens = line.split(/\s+/).filter(Boolean);
      if (tokens.length === 0) return;

      const parsedTokens = tokens.map((token, tokenIndex) =>
        parseToken(token, lineNumber, tokenIndex + 1)
      );
      noteLines.push({ lineNumber, tokens: parsedTokens });
    });

    if (noteLines.length === 0) throw new Error("曲谱中没有音符。");

    const fallbackTitle = options.fileName
      ? options.fileName.replace(/\.[^.]+$/, "").trim()
      : "未命名曲谱";
    title = (title || fallbackTitle || "未命名曲谱").trim();
    if (!title || title.length > 100) {
      throw new Error("曲谱名称必须为 1–100 个字符。");
    }

    const chart = [];
    for (const noteLine of noteLines) {
      const tokens = noteLine.tokens;

      // 预先记录每个位置后面的第一个有音高的 token，供行首 C 判断走向。
      const nextPitched = new Array(tokens.length).fill(null);
      let nextMidi = null;
      for (let index = tokens.length - 1; index >= 0; index -= 1) {
        nextPitched[index] = nextMidi;
        if (!tokens[index].isRest) nextMidi = tokens[index].midi;
      }

      let previousMidi = null;
      let previousLane = null;

      tokens.forEach((token, index) => {
        if (token.isRest) {
          chart.push({ note: 0, duration: token.duration });
          return;
        }

        const chosen = chooseLane(token, previousMidi, nextPitched[index], previousLane, {
          lineNumber: noteLine.lineNumber,
          tokenNumber: index + 1,
          raw: token.raw,
        });

        chart.push({
          note: chosen.lane + 1,
          duration: token.duration,
          transpose: chosen.transpose,
          semitone: chosen.semitone,
          pitch: formatPitch(token.midi),
        });

        previousMidi = token.midi;
        previousLane = chosen.lane;
      });
    }

    if (chart.length > MAX_EVENTS) {
      throw new Error(`曲谱事件不能超过 ${MAX_EVENTS} 条。`);
    }

    return { title, bpm, chart };
  }

  function formatDuration(duration) {
    const q = Math.round(duration * 4);
    if (!Number.isFinite(duration) || q <= 0 || Math.abs(duration * 4 - q) > 1e-6) {
      throw new Error(`时值 ${duration} 不是 0.25 的整数倍。`);
    }

    const whole = Math.floor(q / 4);
    const half = Math.floor((q % 4) / 2);
    const quarter = q % 2;
    return "—".repeat(whole) + (half ? "-" : "") + (quarter ? "_" : "");
  }

  function resolveEvent(event) {
    if (!event || typeof event !== "object") throw new Error("曲谱事件格式无效。");
    if (event.note === 0) return { isRest: true, duration: event.duration };

    const base = BASE_MIDI[event.note - 1];
    if (!Number.isFinite(base)) throw new Error(`音轨 ${event.note} 无效。`);

    if (event.transpose === "center" || event.transpose === "up" || event.transpose === "down") {
      const offset = event.transpose === "up" ? 12 : event.transpose === "down" ? -12 : 0;
      return {
        isRest: false,
        midi: base + offset + (event.semitone ? 1 : 0),
        duration: event.duration,
      };
    }

    if (typeof event.pitch === "string") {
      const match = /^([A-G])(#?)(-?\d+)$/.exec(event.pitch);
      if (match) {
        const midi = pitchClassToMidi(match[1], match[2], Number(match[3]));
        if (midi != null) return { isRest: false, midi, duration: event.duration };
      }
    }

    return { isRest: false, midi: base, duration: event.duration };
  }

  function serialize(options = {}) {
    const { bpm, chart, lineBeats = DEFAULT_LINE_BEATS } = options;

    if (!Array.isArray(chart) || chart.length === 0) throw new Error("曲谱没有事件。");
    if (!Number.isInteger(lineBeats) || lineBeats < 1 || lineBeats > 64) {
      throw new Error("换行拍数必须是 1–64 的整数。");
    }
    if (!Number.isInteger(bpm) || bpm < MIN_BPM || bpm > MAX_BPM) {
      throw new Error(`BPM 必须是 ${MIN_BPM}–${MAX_BPM} 的整数。`);
    }

    const tokens = chart.map((event) => {
      const resolved = resolveEvent(event);
      const durationText = formatDuration(resolved.duration);
      const text = resolved.isRest
        ? `R${durationText}`
        : `${formatPitch(resolved.midi)}${durationText}`;
      return { text, duration: resolved.duration };
    });

    const noteLines = [];
    let currentLine = [];
    let currentBeats = 0;

    for (const token of tokens) {
      if (currentLine.length > 0 && currentBeats + token.duration > lineBeats + 1e-9) {
        noteLines.push(currentLine.join(" "));
        currentLine = [];
        currentBeats = 0;
      }
      currentLine.push(token.text);
      currentBeats += token.duration;
    }
    if (currentLine.length > 0) noteLines.push(currentLine.join(" "));

    const header = [
      "// 符号注释：# 代表升半音，↓ 代表低八度，↑ 代表高八度。",
      "// 时长：— 为 1 拍，- 为 0.5 拍，_ 为 0.25 拍；—— 为 2 拍，——— 为 3 拍，———— 为 4 拍。",
      "// 非整拍可组合，如 —- 为 1.5 拍。",
      `BPM=${bpm}`,
    ];

    return `${header.join("\n")}\n${noteLines.join("\n")}\n`;
  }

  return {
    BASE_MIDI,
    DEFAULT_LINE_BEATS,
    parse,
    serialize,
    formatPitch,
    formatDuration,
  };
});
