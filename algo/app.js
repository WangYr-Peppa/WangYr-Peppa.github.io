// =============================================================================
// AlgorithmVisualizer - front-end
// -----------------------------------------------------------------------------
// Responsibilities:
//   - Read the catalogue produced by the C++ program (window.ALGO_DATA):
//         { "<type>": { "<algorithm>": <run>, ... }, ... }
//   - Build two linked dropdowns (type + algorithm); the algorithm list is
//     rebuilt whenever the type changes, so only matching entries are offered.
//   - Replay the selected run frame by frame and draw the array as bars.
//
// Frames are operations:  { op, i, j, value, desc }
//     op = "compare" : no state change (just a highlight)
//     op = "swap"    : swap arr[i] and arr[j]
//     op = "set"     : arr[i] = value
//     op = "mark"    : index i becomes permanently "sorted" (green)
//   stateAt() replays frames 0..N to rebuild the array at frame N.
// =============================================================================

(function () {
  "use strict";

  var data = window.ALGO_DATA;
  var canvas = document.getElementById("board");
  var ctx = canvas.getContext("2d");
  var metaEl = document.getElementById("meta");
  var statusEl = document.getElementById("status");
  var complexityEl = document.getElementById("complexity");
  var legendEl = document.getElementById("legend");
  var speedEl = document.getElementById("speed");
  var playBtn = document.getElementById("play");
  var typeSel = document.getElementById("typeSel");
  var algoSel = document.getElementById("algoSel");

  if (!data) {
    metaEl.textContent =
      "未找到数据（web/data.js）。请先运行 C++ 程序生成数据，再刷新此页面。";
    return;
  }

  // --- display labels --------------------------------------------------------
  // Keys come straight from the C++ JSON. Add a label here when you add a new
  // algorithm/type; unknown keys simply fall back to the raw key name.
  var TYPE_LABELS = { sort: "排序", search: "查找", maze: "迷宫" };
  var ALGO_LABELS = {
    bubble: "冒泡排序",
    selection: "选择排序",
    insertion: "插入排序",
    quick: "快速排序",
    merge: "归并排序",
    linear: "线性查找",
    binary: "二分查找",
    interpolation: "插值查找",
    bfs: "广度优先搜索 (BFS)",
    dfs: "深度优先搜索 (DFS)",
    dijkstra: "Dijkstra 搜索",
    astar: "A* 搜索"
  };
  function typeLabel(t) { return TYPE_LABELS[t] || t; }
  function algoLabel(a) { return ALGO_LABELS[a] || a; }

  // --- colors ----------------------------------------------------------------
  // Picked to differ in BOTH hue and brightness on the dark background, so the
  // states stay readable even at small cell sizes.
  var C_IDLE = "#6a9bff";     // untouched bar (bright blue)
  var C_COMPARE = "#ffd93d";  // comparing (yellow)
  var C_SWAP = "#ff5c7a";     // swapping (hot pink)
  var C_WRITE = "#c07bff";    // writing / set (violet)
  var C_DONE = "#3ddc84";     // sorted / found (bright green)
  var C_DIM = "#2a3142";      // outside the active search window
  var C_EXCLUDED = "#8a94a6"; // checked, no match (light gray)

  // Maze colours.
  var C_WALL = "#060810";     // near-black walls
  var C_OPEN = "#2b3550";     // plain passage (clearly lighter than walls)
  var C_FRONTIER = "#ffd93d"; // discovered, waiting in queue / stack
  var C_CURRENT = "#ff6b3d";  // being processed now (orange)
  var C_VISITED = "#4d7fe6";  // finished (blue)
  var C_PATH = "#3ddc84";     // final route (bright green)
  var C_MAZE_BG = "#0b0f17";

  // Terrain colours, keyed by entry cost (see terrainColor()).
  var C_GRASS = "#3f7d4a";     // cost 2 (green)
  var C_MUD = "#a06a32";       // cost 5 (brown)
  var C_WATER = "#1f7f8c";     // cost 9 (teal, distinct from visited blue)
  var C_RELAX = "#f0f6ff";     // cell whose distance is being relaxed (near-white)

  // --- state -----------------------------------------------------------------
  var current = null;    // the currently selected run
  var totalFrames = 0;
  var frame = 0;         // 0 = initial state, N = after N operations
  var playing = false;
  var timer = null;

  // --- dropdowns -------------------------------------------------------------
  function fillTypes() {
    typeSel.innerHTML = "";
    Object.keys(data).forEach(function (t) {
      var opt = document.createElement("option");
      opt.value = t;
      opt.textContent = typeLabel(t);
      typeSel.appendChild(opt);
    });
  }

  // Only algorithms belonging to `type` are listed. This keeps the two
  // dropdowns in sync structurally (no manual filtering needed).
  function fillAlgorithms(type) {
    algoSel.innerHTML = "";
    Object.keys(data[type]).forEach(function (a) {
      var opt = document.createElement("option");
      opt.value = a;
      opt.textContent = algoLabel(a);
      algoSel.appendChild(opt);
    });
  }

  function onTypeChange() {
    fillAlgorithms(typeSel.value);
    loadRun();
  }

  function loadRun() {
    stopPlay();
    current = data[typeSel.value][algoSel.value];
    totalFrames = current.steps.length;
    frame = 0;

    // The maze needs a square canvas; arrays use the wide one.
    if (current.kind === "maze") {
      canvas.width = 640;
      canvas.height = 640;
    } else {
      canvas.width = 960;
      canvas.height = 380;
    }

    updateMeta();
    updateLegend();
    draw();
  }

  function updateMeta() {
    var s = current.stats;
    var cmp = current.complexity || {};
    var text = "类型: " + typeLabel(typeSel.value) +
               "   |   算法: " + algoLabel(algoSel.value);

    if (current.kind === "maze") {
      text += "   |   迷宫: " + current.rows + " x " + current.cols +
              "   |   扩展节点: " + s.expanded +
              "   |   帧数: " + s.frames;
    } else {
      text += "   |   元素: " + current.array.length +
              "   |   比较: " + s.comparisons +
              "   |   帧数: " + s.frames;
      if (current.target !== undefined) {
        text += "   |   目标值: " + current.target;
      } else {
        text += "   |   交换: " + s.swaps;
      }
    }

    metaEl.textContent = text;
    complexityEl.textContent =
      "时间复杂度: " + (cmp.time || "-").trim() +
      "     空间复杂度: " + (cmp.space || "-").trim();
  }

  // --- replay + drawing ------------------------------------------------------
  // Rebuild the array state at the given frame by replaying operations.
  // Also accumulate the set of "sorted" indices marked so far.
  function stateAt(frameIndex) {
    var arr = current.array.slice();
    var sorted = {};
    var excluded = {};
    var hi = [-1, -1];
    var op = "";
    var desc = "初始状态";
    var win = null;   // active search window {lo, hi} (binary search only)

    for (var k = 0; k < frameIndex; k++) {
      var s = current.steps[k];
      if (s.op === "swap") {
        var t = arr[s.i];
        arr[s.i] = arr[s.j];
        arr[s.j] = t;
      } else if (s.op === "set") {
        arr[s.i] = s.value;
      } else if (s.op === "mark") {
        sorted[s.i] = true;
      } else if (s.op === "exclude") {
        excluded[s.i] = true;
      }
      if (s.lo !== undefined) win = { lo: s.lo, hi: s.hi };
      hi = [s.i, s.j];
      op = s.op;
      desc = s.desc;
    }
    if (frameIndex === 0) {
      hi = [-1, -1];
    }
    return { arr: arr, hi: hi, op: op, desc: desc,
             sorted: sorted, excluded: excluded, win: win };
  }

  // Dispatch to the right renderer based on the run's `kind`.
  function draw() {
    if (current.kind === "maze") drawMaze();
    else drawArray();
  }

  function drawArray() {
    var state = stateAt(frame);
    var arr = state.arr;
    var n = arr.length;

    var maxV = arr[0];
    for (var m = 1; m < n; m++) {
      if (arr[m] > maxV) maxV = arr[m];
    }

    var padX = 20, padY = 24;
    var w = canvas.width, h = canvas.height;
    var barW = (w - padX * 2) / n;

    ctx.clearRect(0, 0, w, h);

    for (var k = 0; k < n; k++) {
      var v = arr[k];
      var barH = (v / maxV) * (h - padY * 2);
      var x = padX + k * barW;
      var y = h - padY - barH;

      var highlighted = (k === state.hi[0] || k === state.hi[1]);
      // Binary search: dim every bar outside the current [lo, hi] window.
      var inWindow = !state.win || (k >= state.win.lo && k <= state.win.hi);

      var color = inWindow ? C_IDLE : C_DIM;
      if (state.sorted[k]) {
        color = C_DONE;                                   // permanently sorted
      } else if (state.desc === "found" && highlighted) {
        color = C_DONE;                                   // search hit
      } else if (state.excluded[k]) {
        color = C_EXCLUDED;                               // checked, no match
      } else if (highlighted) {
        if (state.op === "swap") color = C_SWAP;
        else if (state.op === "set") color = C_WRITE;
        else color = C_COMPARE;
      }

      ctx.fillStyle = color;
      ctx.fillRect(x + 2, y, barW - 4, barH);

      // value label
      ctx.fillStyle = "#c3ccdb";
      ctx.font = "12px Segoe UI, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(String(v), x + barW / 2, h - 8);
    }

    var statusText = "帧 " + frame + " / " + totalFrames +
      (frame > 0 ? "  —  " + state.desc : "");
    if (state.win && state.win.lo <= state.win.hi) {
      statusText += "     区间 [" + state.win.lo + ", " + state.win.hi + "]";
    }
    statusEl.textContent = statusText;
  }

  // --- maze replay + drawing -------------------------------------------------
  // Replay frontier/current/visit/path frames into per-cell state.
  //   0 = untouched, 1 = frontier (discovered), 2 = visited, 3 = path
  function stateAtMaze(frameIndex) {
    var state = [];
    for (var z = 0; z < current.grid.length; z++) state.push(0);
    var currentCell = -1;
    var last = null;

    for (var k = 0; k < frameIndex; k++) {
      var s = current.steps[k];
      if (s.op === "frontier") {
        if (state[s.i] < 2) state[s.i] = 1;
      } else if (s.op === "current") {
        currentCell = s.i;
      } else if (s.op === "visit") {
        state[s.i] = 2;
        if (currentCell === s.i) currentCell = -1;
      } else if (s.op === "path") {
        state[s.i] = 3;
      }
      // "relax" does not change a cell's persistent state; it is shown only
      // for the current frame (the target cell flashes cyan in drawMaze).
      last = s;
    }
    return { state: state, currentCell: currentCell, last: last };
  }

  // Draw a small filled dot at a cell (used for the start / goal markers).
  function drawCellDot(idx, offX, offY, cell, cols, color) {
    if (idx < 0) return;
    var r = Math.floor(idx / cols);
    var c = idx % cols;
    var cx = offX + c * cell + cell / 2;
    var cy = offY + r * cell + cell / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(2, cell * 0.28), 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = C_MAZE_BG;
    ctx.stroke();
  }

  // Terrain base colour for an open cell, based on its entry cost.
  function terrainColor(costValue) {
    if (costValue >= 9) return C_WATER;
    if (costValue >= 5) return C_MUD;
    if (costValue >= 2) return C_GRASS;
    return C_OPEN;
  }

  function drawMaze() {
    var st = stateAtMaze(frame);
    var rows = current.rows;
    var cols = current.cols;
    var w = canvas.width;
    var h = canvas.height;
    var pad = 16;

    // Square cells, grid centred inside the canvas.
    var cell = Math.floor(Math.min((w - pad * 2) / cols, (h - pad * 2) / rows));
    var offX = Math.floor((w - cell * cols) / 2);
    var offY = Math.floor((h - cell * rows) / 2);

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = C_MAZE_BG;
    ctx.fillRect(0, 0, w, h);

    var last = st.last;
    var relaxCell = (last && last.op === "relax") ? last.j : -1;

    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var k = r * cols + c;
        var x = offX + c * cell;
        var y = offY + r * cell;

        if (current.grid[k] === 1) {
          ctx.fillStyle = C_WALL;
          ctx.fillRect(x, y, cell, cell);
          continue;
        }

        // 1) terrain as the base colour
        ctx.fillStyle = terrainColor(current.cost[k]);
        ctx.fillRect(x, y, cell, cell);

        // 2) search state as a translucent overlay, so terrain still shows through
        var stt = st.state[k];
        var overlay = null;
        var alpha = 0.82;
        if (stt === 3) { overlay = C_PATH; alpha = 0.95; }
        else if (k === st.currentCell) { overlay = C_CURRENT; }
        else if (k === relaxCell) { overlay = C_RELAX; alpha = 0.9; }
        else if (stt === 2) { overlay = C_VISITED; }
        else if (stt === 1) { overlay = C_FRONTIER; }

        if (overlay) {
          ctx.globalAlpha = alpha;
          ctx.fillStyle = overlay;
          ctx.fillRect(x, y, cell, cell);
          ctx.globalAlpha = 1;
        }
      }
    }

    // Start / goal markers on top of the cells.
    drawCellDot(current.start, offX, offY, cell, cols, "#20bf6b");
    drawCellDot(current.goal, offX, offY, cell, cols, "#fc5c65");

    var msg = "";
    if (last) {
      if (last.op === "relax") {
        msg = "松弛 " + last.i + " → " + last.j + "，新距离 " + last.value;
      } else {
        msg = last.desc;
      }
    }
    statusEl.textContent = "帧 " + frame + " / " + totalFrames +
      (msg ? "  —  " + msg : "");
  }

  // Swap the legend to match the current renderer.
  function updateLegend() {
    if (current.kind === "maze") {
      legendEl.innerHTML =
        '<span class="dot open"></span> 平地' +
        '<span class="dot mud"></span> 泥地(5)' +
        '<span class="dot water"></span> 水域(9)' +
        '<span class="dot frontier"></span> 已发现' +
        '<span class="dot current"></span> 当前' +
        '<span class="dot visited"></span> 已访问' +
        '<span class="dot found"></span> 路径';
    } else {
      legendEl.innerHTML =
        '<span class="dot compare"></span> 比较中' +
        '<span class="dot swap"></span> 交换' +
        '<span class="dot write"></span> 写入' +
        '<span class="dot excluded"></span> 已排除' +
        '<span class="dot found"></span> 已排序 / 找到';
    }
  }

  function setFrame(f) {
    if (f < 0) f = 0;
    if (f > totalFrames) f = totalFrames;
    frame = f;
    draw();
  }

  // --- playback --------------------------------------------------------------
  function stopPlay() {
    playing = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    playBtn.textContent = "播放";
  }

  function stepOnce() {
    if (frame >= totalFrames) {
      stopPlay();
      return;
    }
    setFrame(frame + 1);
  }

  // Slider is "right = faster": the delay shrinks as the value grows. Clamp the
  // delay so it never reaches 0 / goes negative (browsers treat that as a busy
  // loop and the animation becomes unusable).
  function speedDelay() {
    var maxVal = parseInt(speedEl.max, 10) || 600;
    return Math.max(10, maxVal - parseInt(speedEl.value, 10));
  }

  function startPlay() {
    if (frame >= totalFrames) frame = 0;
    playing = true;
    playBtn.textContent = "暂停";
    timer = setInterval(stepOnce, speedDelay());
  }

  document.getElementById("next").onclick = function () { stopPlay(); setFrame(frame + 1); };
  document.getElementById("prev").onclick = function () { stopPlay(); setFrame(frame - 1); };
  document.getElementById("reset").onclick = function () { stopPlay(); setFrame(0); };
  playBtn.onclick = function () { if (playing) stopPlay(); else startPlay(); };
  speedEl.oninput = function () {
    if (playing) {
      clearInterval(timer);
      timer = setInterval(stepOnce, speedDelay());
    }
  };
  typeSel.onchange = onTypeChange;
  algoSel.onchange = loadRun;

  // --- init ------------------------------------------------------------------
  fillTypes();
  fillAlgorithms(typeSel.value);
  loadRun();
})();
