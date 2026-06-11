import "./style.css";
import {
  Board,
  BoardContactPhase,
  BoardContactType,
  type BoardContact,
} from "@board.fun/web-sdk";

const GAME_NAME = "Board Web3";
const GAME_VERSION = "0.0.1";
const WIDTH = 1920;
const HEIGHT = 1080;

/** Replace with glyph IDs from your Piece Set taxonomy. */
const GLYPH_EXAMPLE = 1;

type LogCategory = "input" | "pause" | "save" | "session" | "system";

const MAX_LOG_LINES = 80;

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <canvas id="game" width="${WIDTH}" height="${HEIGHT}"></canvas>
  <div id="hud">
    <span id="mode"></span>
    <span id="players"></span>
  </div>
  <div id="console">
    <div id="console-header">Event log</div>
    <div id="console-log"></div>
  </div>
`;

const canvas = document.querySelector<HTMLCanvasElement>("#game")!;
const ctx = canvas.getContext("2d")!;
const modeEl = document.querySelector<HTMLSpanElement>("#mode")!;
const playersEl = document.querySelector<HTMLSpanElement>("#players")!;
const logEl = document.querySelector<HTMLDivElement>("#console-log")!;

function log(category: LogCategory, message: string, detail?: string): void {
  const line = document.createElement("div");
  line.className = `log-line log-${category}`;
  line.innerHTML = [
    `<span class="log-time">${new Date().toLocaleTimeString()}</span>`,
    `<span class="log-cat">[${category}]</span>`,
    `<span class="log-msg">${message}</span>`,
    detail ? `<span class="log-detail">${detail}</span>` : "",
  ].join(" ");
  logEl.prepend(line);
  while (logEl.children.length > MAX_LOG_LINES) {
    logEl.lastElementChild?.remove();
  }
  console.log(`[${category}]`, message, detail ?? "");
}

function describeContact(contact: BoardContact): string {
  const kind = contact.glyphId === 0 ? "finger" : `glyph ${contact.glyphId}`;
  return `id=${contact.contactId} ${kind} @ ${Math.round(contact.x)},${Math.round(contact.y)} · ${BoardContactPhase[contact.phase]}`;
}

const contacts = new Map<number, BoardContact>();
const prevTouched = new Map<number, boolean>();

let playedMs = 0;
let lastTick = performance.now();
let pauseUnsubscribe: (() => void) | null = null;
let lastPlayerSummary = "";
let frameCount = 0;
let lastFrameLogMs = 0;
let lastFrameContactCount = -1;
const FRAME_LOG_INTERVAL_MS = 2000;
let inputSubscribed = false;
let inputWatchdog: ReturnType<typeof setInterval> | null = null;

function hasBoardSdkBridge(): boolean {
  return typeof window.BoardSDK !== "undefined";
}

function hasBoardTouchBridge(): boolean {
  return typeof window.boardTouch !== "undefined";
}

function logInputBridgeState(context: string): void {
  log(
    "input",
    `bridge state (${context})`,
    [
      `BoardSDK=${hasBoardSdkBridge()}`,
      `boardTouch=${hasBoardTouchBridge()}`,
      `isSubscribed=${Board.input.isSubscribed}`,
      `callbacks=${inputSubscribed}`,
    ].join(" · "),
  );
}

function onTouchDown(contact: BoardContact): void {
  log("input", "hand down", describeContact(contact));
  if (contact.glyphId === GLYPH_EXAMPLE) {
    log("input", "example glyph touched");
  }
}

function onTouchUp(contact: BoardContact): void {
  log("input", "hand up", describeContact(contact));
}

function onContactEnded(contact: BoardContact): void {
  contacts.delete(contact.contactId);
  log("input", "contact ended", describeContact(contact));
}

function onFrame(frameContacts: ReadonlyArray<BoardContact>): void {
  frameCount++;
  const now = performance.now();
  const count = frameContacts.length;

  if (frameCount === 1) {
    log("input", "onFrame: first frame", `${count} contact(s)`);
  }

  if (count !== lastFrameContactCount) {
    log(
      "input",
      "onFrame contact count changed",
      `${lastFrameContactCount < 0 ? "none" : lastFrameContactCount} → ${count}`,
    );
    if (count > 0) {
      log(
        "input",
        "onFrame contacts",
        frameContacts.map(describeContact).join("; "),
      );
    }
    lastFrameContactCount = count;
  }

  if (count === 0 && now - lastFrameLogMs >= FRAME_LOG_INTERVAL_MS) {
    lastFrameLogMs = now;
    log("input", "onFrame heartbeat", `frame #${frameCount}, 0 contacts`);
  }

  const seen = new Set<number>();

  for (const contact of frameContacts) {
    seen.add(contact.contactId);
    contacts.set(contact.contactId, contact);

    const wasTouched = prevTouched.get(contact.contactId) ?? false;
    if (contact.phase === BoardContactPhase.Began) {
      log("input", "contact began", describeContact(contact));
    }
    if (contact.isTouched && !wasTouched) {
      onTouchDown(contact);
    } else if (!contact.isTouched && wasTouched) {
      onTouchUp(contact);
    }
    if (contact.phase === BoardContactPhase.Ended) {
      onContactEnded(contact);
    } else if (contact.phase === BoardContactPhase.Canceled) {
      log("input", "contact canceled", describeContact(contact));
    }
    prevTouched.set(contact.contactId, contact.isTouched);
  }

  for (const id of prevTouched.keys()) {
    if (!seen.has(id)) prevTouched.delete(id);
  }
}

function drawContact(contact: BoardContact): void {
  const isFinger = contact.glyphId === 0;
  const radius = isFinger ? 24 : 40;

  ctx.beginPath();
  ctx.arc(contact.x, contact.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = isFinger
    ? "rgba(100, 180, 255, 0.7)"
    : "rgba(255, 200, 80, 0.85)";
  ctx.fill();

  if (!isFinger) {
    ctx.save();
    ctx.translate(contact.x, contact.y);
    ctx.rotate((contact.orientation * Math.PI) / 180);
    ctx.strokeStyle = contact.isTouched ? "#fff" : "rgba(255,255,255,0.4)";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(0, -radius * 0.6);
    ctx.lineTo(0, radius * 0.6);
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = "#fff";
    ctx.font = "20px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(String(contact.glyphId), contact.x, contact.y + 7);
  }
}

function render(): void {
  const now = performance.now();
  playedMs += now - lastTick;
  lastTick = now;

  ctx.fillStyle = "#12121f";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  ctx.fillStyle = "rgba(255,255,255,0.08)";
  ctx.font = "32px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(GAME_NAME, WIDTH / 2, 80);
  ctx.font = "22px system-ui, sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.fillText("Touch the screen or place pieces to play", WIDTH / 2, 130);

  for (const contact of contacts.values()) {
    drawContact(contact);
  }

  requestAnimationFrame(render);
}

function updateHud(): void {
  modeEl.textContent = Board.isOnDevice
    ? `Board · SDK ${Board.sdkVersion}`
    : "Browser preview · mouse simulates touches";

  if (!Board.isOnDevice) {
    playersEl.textContent = "";
    return;
  }

  const names = Board.session.getPlayers().map((p) => p.name);
  const summary =
    names.length > 0 ? names.join(" · ") : "Waiting for players…";
  playersEl.textContent = summary;

  if (summary !== lastPlayerSummary) {
    lastPlayerSummary = summary;
    log("session", "players updated", summary);
  }
}

function encodeState(): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ playedMs, contactCount: contacts.size }),
  );
}

async function saveGame(): Promise<void> {
  if (!Board.isOnDevice || !Board.session.areServicesReady()) {
    log("save", "skipped — services not ready");
    return;
  }
  log("save", "saving…");
  try {
    const meta = await Board.save.create(
      "Autosave",
      encodeState(),
      playedMs,
      GAME_VERSION,
    );
    log("save", "saved", `id=${meta.id} · ${meta.fileSize} bytes`);
  } catch (err) {
    log("save", "save failed", String(err));
  }
}

function restart(): void {
  contacts.clear();
  prevTouched.clear();
  playedMs = 0;
  lastTick = performance.now();
  frameCount = 0;
  lastFrameLogMs = 0;
  lastFrameContactCount = -1;
  log("system", "game restarted");
}

function setupPause(): void {
  Board.pause.setContext({
    gameName: GAME_NAME,
    offerSaveOption: true,
    customButtons: [
      { id: "restart", title: "Restart", icon: "circulararrow" },
    ],
  });
  log("pause", "context set", GAME_NAME);

  pauseUnsubscribe = Board.pause.onResult((result) => {
    const audio =
      result.audioTracks?.map((t) => `${t.id}=${t.value}`).join(", ") ?? "";
    const detail = [
      result.customButtonId ? `button=${result.customButtonId}` : "",
      audio,
    ]
      .filter(Boolean)
      .join(" · ");

    log("pause", result.action, detail || undefined);

    switch (result.action) {
      case "resume":
        break;
      case "quit":
        log("pause", "quitting app");
        Board.application.quit();
        break;
      case "save_and_quit":
        void saveGame().then(() => {
          log("pause", "quitting after save");
          Board.application.quit();
        });
        break;
      case "custom_button":
        if (result.customButtonId === "restart") restart();
        break;
    }
  });
}

function scaleCanvasToViewport(): void {
  const scale = Math.min(
    window.innerWidth / WIDTH,
    window.innerHeight / HEIGHT,
  );
  canvas.style.width = `${WIDTH * scale}px`;
  canvas.style.height = `${HEIGHT * scale}px`;
}

function clientToBoard(clientX: number, clientY: number): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((clientX - rect.left) / rect.width) * WIDTH,
    y: ((clientY - rect.top) / rect.height) * HEIGHT,
  };
}

function wireDevFallback(): void {
  let nextId = 1;
  const active = new Map<number, number>();

  const emit = (id: number, phase: BoardContactPhase, x: number, y: number) => {
    const contact: BoardContact = {
      contactId: id,
      x,
      y,
      orientation: 0,
      type: BoardContactType.Finger,
      phase,
      glyphId: 0,
      isTouched: phase !== BoardContactPhase.Ended,
    };
    if (phase === BoardContactPhase.Ended) {
      onFrame([contact]);
      return;
    }
    onFrame([contact]);
  };

  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    const id = nextId++;
    active.set(e.pointerId, id);
    const { x, y } = clientToBoard(e.clientX, e.clientY);
    emit(id, BoardContactPhase.Began, x, y);
  });

  canvas.addEventListener("pointermove", (e) => {
    const id = active.get(e.pointerId);
    if (id === undefined) return;
    const { x, y } = clientToBoard(e.clientX, e.clientY);
    emit(id, BoardContactPhase.Moved, x, y);
  });

  const endPointer = (e: PointerEvent) => {
    const id = active.get(e.pointerId);
    if (id === undefined) return;
    active.delete(e.pointerId);
    const { x, y } = clientToBoard(e.clientX, e.clientY);
    emit(id, BoardContactPhase.Ended, x, y);
  };

  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
}

function subscribeToInput(context: string): void {
  if (inputSubscribed) return;
  Board.input.subscribe(onFrame);
  inputSubscribed = true;
  log("input", "subscribed to touch frames", context);
  logInputBridgeState("after subscribe");
}

function waitForTouchBridgeThenSubscribe(): void {
  logInputBridgeState("startup");

  if (hasBoardTouchBridge()) {
    subscribeToInput("boardTouch already present");
    return;
  }

  log(
    "input",
    "waiting for boardTouch",
    "BoardSDK is present but touch bridge is not ready yet",
  );

  let polls = 0;
  const poll = setInterval(() => {
    polls++;
    if (hasBoardTouchBridge()) {
      clearInterval(poll);
      subscribeToInput(`boardTouch ready after ${polls} poll(s)`);
      return;
    }
    if (polls % 5 === 0) {
      logInputBridgeState(`poll #${polls}`);
    }
    if (polls >= 50) {
      clearInterval(poll);
      log(
        "input",
        "touch bridge timeout",
        "boardTouch never appeared after 10s — input frames will not arrive",
      );
    }
  }, 200);
}

function startInputWatchdog(): void {
  inputWatchdog = setInterval(() => {
    if (frameCount > 0) return;
    logInputBridgeState("no frames yet");
    const snapshot = Board.input.getContacts();
    if (snapshot.length > 0) {
      log(
        "input",
        "getContacts snapshot",
        snapshot.map(describeContact).join("; "),
      );
    }
  }, 3000);
}

function startBoardGame(): void {
  log("system", "started on Board device", `SDK ${Board.sdkVersion}`);
  log(
    "session",
    "services ready",
    Board.session.areServicesReady() ? "yes" : "no",
  );
  waitForTouchBridgeThenSubscribe();
  startInputWatchdog();
  setupPause();
  updateHud();
  setInterval(updateHud, 2000);
}

function teardown(): void {
  if (Board.isOnDevice) {
    if (inputSubscribed) Board.input.unsubscribe(onFrame);
    inputWatchdog && clearInterval(inputWatchdog);
    pauseUnsubscribe?.();
  }
}

scaleCanvasToViewport();
window.addEventListener("resize", scaleCanvasToViewport);
window.addEventListener("beforeunload", teardown);
requestAnimationFrame(render);

if (Board.isOnDevice) {
  startBoardGame();
} else {
  log("system", "browser preview — mouse simulates touches");
  updateHud();
  wireDevFallback();
}
