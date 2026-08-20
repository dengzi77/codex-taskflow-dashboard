(() => {
  "use strict";

  const VERSION = "taskflow-1.5.3";
  const SOURCE_HASH = window.__CODEX_TASKBOARD_SOURCE_HASH__;
  const SENTINEL_KEY = "__codexTaskboardInjection__";
  const DEFAULT_TASKBOARD_URL = "http://127.0.0.1:47823/?host=codex";
  const ENTRY_ID = "codex-taskboard-entry";
  const PAGE_ID = "codex-taskboard-page";
  const FRAME_ID = "codex-taskboard-frame";
  const DRAG_REGION_ID = "codex-taskboard-drag-region";
  const NO_DRAG_LEFT_ID = "codex-taskboard-no-drag-left";
  const NO_DRAG_RIGHT_ID = "codex-taskboard-no-drag-right";
  const STATUS_ID = "codex-taskboard-status";
  const STYLE_ID = "codex-taskboard-inject-style";
  const OWNED_ATTRIBUTE = "data-codex-taskboard-owned";
  const HIDDEN_ATTRIBUTE = "data-codex-taskboard-native-hidden";
  const HOST_ATTRIBUTE = "data-codex-taskboard-page-host";
  const NATIVE_SELECTED_ATTRIBUTE = "data-codex-taskboard-native-selected";
  const HOST_BINDING_NAME = "__codexTaskboardHostV1";
  const HOST_HEARTBEAT_NAME = "__codexTaskboardHostHeartbeatV1";
  const REATTACH_DELAY_MS = 160;
  const FRAME_READY_TIMEOUT_MS = 12_000;
  const HOST_REQUEST_TIMEOUT_MS = 12_000;
  const HOST_HEARTBEAT_MAX_AGE_MS = 8_000;
  const MACOS_TITLEBAR_SAFE_LEFT = 80;
  const FRAME_REFRESH_PARAM = "__codex_taskboard_refresh";
  const QUEUE_STORAGE_KEY = "taskflow.codex-queue.v1";
  const QUEUE_SETTINGS_KEY = "taskflow.codex-queue-settings.v1";
  const ACCEPTED_STORAGE_KEY = "taskflow.accepted-thread-ids.v1";
  const THREAD_PRIORITIES_STORAGE_KEY = "taskflow.thread-priorities.v1";
  const NOTICE_READ_STORAGE_KEY = "taskflow.notice-read-at.v1";
  const VIEW_STORAGE_KEY = "taskflow.last-view.v1";
  const QUEUE_TICK_MS = 5_000;
  const COMPLETED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
  const PLUGIN_LABELS = ["插件", "plugins"];
  const NATIVE_PAGE_LABELS = [
    "新建任务",
    "new task",
    "new chat",
    "拉取请求",
    "pull requests",
    "站点",
    "sites",
    "已安排",
    "scheduled",
    "插件",
    "plugins",
  ];
  const PROJECT_SECTION_LABELS = ["projects", "项目"];
  const TASK_SECTION_LABELS = ["tasks", "任务", "chats", "对话"];
  const NATIVE_RIGHT_SIDEBAR_TRIGGER_LABELS = [
    "显示/隐藏侧边栏",
    "show/hide sidebar",
  ];

  const previous = window[SENTINEL_KEY];
  if (previous?.sourceHash === SOURCE_HASH && typeof previous.refresh === "function") {
    previous.refresh();
    return;
  }
  try {
    previous?.destroy?.();
  } catch (_) {}

  let entry = null;
  let page = null;
  let frame = null;
  let dragRegion = null;
  let noDragLeft = null;
  let noDragRight = null;
  let status = null;
  let frameOrigin = "";
  let frameReady = false;
  let frameReadyWaiters = new Set();
  let hostRequests = new Map();
  let hostRequestSequence = 0;
  let observer = null;
  let reattachTimer = null;
  let mountRetryTimer = null;
  let lastFocusedElement = null;
  let hostContextSnapshot = null;
  let mutedNativeSelections = new Map();
  let openGeneration = 0;
  let pendingThreadCreation = null;
  let lastNativeThreadId = "";
  let active = false;
  let destroyed = false;
  let queueTimer = null;
  let queueRunning = false;
  let inlineRefreshTimer = null;
  let inlineAccountRefreshTimer = null;
  let inlineToastTimer = null;
  let draggedItemId = "";
  let pendingScrollExcludedItemId = "";
  const inlineState = {
    threads: [],
    automations: [],
    rateLimits: null,
    hostContext: null,
    loading: true,
    error: "",
    automationsLoading: true,
    automationsError: "",
    query: "",
    view: "all",
    selectedId: "",
    selectedResult: "",
    selectedResultLoading: false,
    selectedAutomationId: "",
    showNotices: false,
    showSettings: false,
    showCreate: false,
    toast: "",
    noticeReadAt: 0,
    acceptedIds: new Set(),
    lastSyncedAt: 0,
    threadRequestId: "",
    automationRequestId: "",
    quotaRequestId: "",
    refreshing: false,
    refreshRequestIds: new Set(),
    deviceWorkspaces: {},
    projectLoading: false,
    projectLoadError: "",
    modalFocusPending: false,
  };

  function readStoredJson(key, fallback) {
    try {
      const value = JSON.parse(window.localStorage.getItem(key) || "null");
      return value ?? fallback;
    } catch (_) {
      return fallback;
    }
  }

  function normalizePriority(value) {
    return ["high", "normal", "low"].includes(value) ? value : "normal";
  }

  function normalizeQueueItems(value) {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      const id = typeof item?.id === "string" ? item.id.trim() : "";
      const title = typeof item?.title === "string" ? item.title.trim() : "";
      const prompt = typeof item?.prompt === "string" ? item.prompt.trim() : "";
      const cwd = typeof item?.cwd === "string" ? item.cwd.trim() : "";
      const workspaceMode = item?.workspaceMode === "none" ? "none" : "project";
      if (!id || !title || !prompt || (workspaceMode === "project" && !cwd)) return [];
      return [{
        id,
        kind: item.kind === "任务" ? "任务" : "聊天",
        title,
        prompt,
        cwd,
        workspaceMode,
        projectId: typeof item?.projectId === "string" ? item.projectId.trim() : "",
        projectName: typeof item?.projectName === "string" ? item.projectName.trim() : "",
        priority: normalizePriority(item.priority),
        createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
        status: ["queued", "starting", "failed"].includes(item.status) ? item.status : "queued",
        ...(typeof item.lastError === "string" && item.lastError ? { lastError: item.lastError } : {}),
        ...(typeof item.startedThreadId === "string" && item.startedThreadId ? { startedThreadId: item.startedThreadId } : {}),
      }];
    });
  }

  function normalizeQueueSettings(value) {
    const intervalMinutes = Math.max(1, Math.min(1440, Math.round(Number(value?.intervalMinutes) || 5)));
    const maxConcurrent = Math.max(1, Math.min(10, Math.round(Number(value?.maxConcurrent) || 5)));
    return {
      enabled: value?.enabled === true,
      intervalMinutes,
      maxConcurrent,
      lastClaimAt: Number.isFinite(value?.lastClaimAt) ? value.lastClaimAt : 0,
      nextClaimAt: Number.isFinite(value?.nextClaimAt) ? value.nextClaimAt : 0,
    };
  }

  let queueItems = normalizeQueueItems(readStoredJson(QUEUE_STORAGE_KEY, []));
  let queueSettings = normalizeQueueSettings(readStoredJson(QUEUE_SETTINGS_KEY, {}));
  let threadPriorities = readStoredJson(THREAD_PRIORITIES_STORAGE_KEY, {});
  if (!threadPriorities || typeof threadPriorities !== "object" || Array.isArray(threadPriorities)) {
    threadPriorities = {};
  }
  inlineState.acceptedIds = new Set(
    readStoredJson(ACCEPTED_STORAGE_KEY, []).filter?.((id) => typeof id === "string") || [],
  );
  inlineState.noticeReadAt = Number(window.localStorage.getItem(NOTICE_READ_STORAGE_KEY) || 0);
  inlineState.view = ["all", "chats", "tasks", "automations"].includes(
    window.localStorage.getItem(VIEW_STORAGE_KEY),
  ) ? window.localStorage.getItem(VIEW_STORAGE_KEY) : "all";

  function persistQueue() {
    window.localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(queueItems));
    window.localStorage.setItem(QUEUE_SETTINGS_KEY, JSON.stringify(queueSettings));
  }

  function postQueueState() {
    postToFrame({
      type: "taskflow:queue-state",
      payload: {
        items: queueItems,
        settings: { ...queueSettings, busy: queueRunning },
      },
    });
  }

  function normalizedLabel(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function normalizeThreadId(value) {
    return String(value || "").trim().replace(/^(?:local|cloud):/i, "");
  }

  function resolveTaskboardUrl() {
    const configured = typeof window.__CODEX_TASKBOARD_URL__ === "string"
      ? window.__CODEX_TASKBOARD_URL__.trim()
      : "";
    try {
      const url = new URL(configured || DEFAULT_TASKBOARD_URL);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Unsupported taskboard URL protocol");
      }
      if (!url.searchParams.has("host")) url.searchParams.set("host", "codex");
      return url;
    } catch (_) {
      return new URL(DEFAULT_TASKBOARD_URL);
    }
  }

  function isLocalTaskboardOrigin(origin) {
    try {
      const { protocol, hostname } = new URL(origin);
      return (protocol === "http:" || protocol === "https:")
        && (hostname === "127.0.0.1" || hostname === "localhost");
    } catch (_) {
      return false;
    }
  }

  function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.setAttribute(OWNED_ATTRIBUTE, "true");
    style.textContent = `
      #${ENTRY_ID}[aria-current="page"] {
        background: var(--color-token-list-hover-background, color-mix(in srgb, currentColor 8%, transparent));
        color: var(--color-token-foreground, inherit);
      }
      #${ENTRY_ID}:focus-visible {
        outline: 2px solid var(--color-token-border, Highlight);
        outline-offset: 2px;
      }
      [${HOST_ATTRIBUTE}="true"] {
        position: relative !important;
        z-index: 31 !important;
        pointer-events: none !important;
      }
      [${HIDDEN_ATTRIBUTE}="true"] {
        visibility: hidden !important;
        pointer-events: none !important;
      }
      [${NATIVE_SELECTED_ATTRIBUTE}="true"] {
        background-color: transparent !important;
      }
      [${NATIVE_SELECTED_ATTRIBUTE}="true"] [class*="text-token-list-active-selection"] {
        color: var(--color-token-foreground, inherit) !important;
      }
      #${PAGE_ID} {
        position: absolute;
        top: 0;
        right: 0;
        bottom: 0;
        left: 0;
        z-index: 1;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
        background: Canvas;
        color: CanvasText;
        pointer-events: auto;
      }
      #${PAGE_ID}[hidden] {
        display: none !important;
      }
      #${FRAME_ID} {
        display: block;
        width: 100%;
        height: 100%;
        border: 0;
        background: Canvas;
      }
      #${FRAME_ID}[hidden] {
        display: none !important;
      }
      #${DRAG_REGION_ID} {
        position: absolute;
        z-index: 2;
        background: transparent;
        pointer-events: none;
        -webkit-app-region: drag;
      }
      #${NO_DRAG_LEFT_ID},
      #${NO_DRAG_RIGHT_ID} {
        position: absolute;
        z-index: 2;
        background: transparent;
        pointer-events: none;
        -webkit-app-region: no-drag;
      }
      #${DRAG_REGION_ID}[hidden],
      #${NO_DRAG_LEFT_ID}[hidden],
      #${NO_DRAG_RIGHT_ID}[hidden] {
        display: none !important;
      }
      #${STATUS_ID} {
        position: absolute;
        inset: 0;
        display: grid;
        place-items: center;
        padding: 24px;
        color: var(--color-token-text-secondary, color-mix(in srgb, CanvasText 60%, transparent));
        font: 13px/1.5 system-ui, sans-serif;
        text-align: center;
      }
      #${STATUS_ID}[hidden] {
        display: none !important;
      }
      #${STATUS_ID} button {
        min-height: 40px;
        margin-top: 10px;
        border: 1px solid var(--color-token-border, color-mix(in srgb, CanvasText 16%, transparent));
        border-radius: 9px;
        padding: 0 14px;
        background: var(--color-token-main-surface-secondary, Canvas);
        color: var(--color-token-foreground, CanvasText);
        cursor: pointer;
        touch-action: manipulation;
      }
      #${FRAME_ID}[data-render-mode="native"] {
        --tf-ink: #1f2937;
        --tf-muted: #7b8798;
        --tf-line: #e3e8ef;
        --tf-blue: #526df0;
        --tf-amber: #e4a12f;
        --tf-green: #2ca36b;
        height: 100%;
        position: relative;
        overflow: hidden;
        color: var(--tf-ink);
        background: #f5f7fa;
        font: 13px/1.45 Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
      }
      #${FRAME_ID} * { box-sizing: border-box; }
      #${FRAME_ID} button, #${FRAME_ID} input, #${FRAME_ID} select, #${FRAME_ID} textarea { font: inherit; }
      #${FRAME_ID} button { cursor: pointer; touch-action: manipulation; transition: transform .08s ease, filter .12s ease, background-color .12s ease; }
      #${FRAME_ID} button:not(:disabled):hover { filter: brightness(.98); }
      #${FRAME_ID} button:not(:disabled):active { transform: scale(.97); filter: brightness(.96); }
      #${FRAME_ID} button:disabled { cursor: not-allowed; opacity: .5; }
      #${FRAME_ID} button:focus-visible, #${FRAME_ID} input:focus-visible, #${FRAME_ID} select:focus-visible, #${FRAME_ID} textarea:focus-visible { outline: 2px solid #6377ed; outline-offset: 2px; }
      #${FRAME_ID} .tf-shell { height: 100%; min-height: 0; display: flex; flex-direction: column; padding: 22px 24px 18px; overflow: hidden; }
      #${FRAME_ID} .tf-topbar { min-width: 0; flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 18px; }
      #${FRAME_ID} .tf-top-left, #${FRAME_ID} .tf-actions, #${FRAME_ID} .tf-account { min-width: 0; display: flex; align-items: center; gap: 9px; }
      #${FRAME_ID} .tf-tabs { display: flex; padding: 4px; border: 1px solid #dce2ea; border-radius: 11px; background: #fff; }
      #${FRAME_ID} .tf-tabs button { min-height: 42px; padding: 0 16px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; border: 0; border-radius: 8px; color: #667085; background: transparent; font-weight: 700; line-height: 1; white-space: nowrap; }
      #${FRAME_ID} .tf-tabs button .tf-icon { flex: 0 0 auto; vertical-align: 0; }
      #${FRAME_ID} .tf-tabs button.active { color: #445bd8; background: #eef1ff; }
      #${FRAME_ID} .tf-icon { width: 16px; height: 16px; display: inline-block; vertical-align: -3px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
      #${FRAME_ID} .tf-expand, #${FRAME_ID} .tf-icon-button, #${FRAME_ID} .tf-secondary, #${FRAME_ID} .tf-primary { min-height: 42px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; border-radius: 9px; white-space: nowrap; font-weight: 700; }
      #${FRAME_ID} .tf-expand, #${FRAME_ID} .tf-secondary { padding: 0 14px; color: #5f6978; border: 1px solid #dde3ea; background: #fff; }
      #${FRAME_ID} .tf-primary { padding: 0 15px; color: #fff; border: 1px solid #526df0; background: #526df0; }
      #${FRAME_ID} .tf-icon-button { position: relative; width: 42px; padding: 0; color: #5f6978; border: 1px solid #dde3ea; background: #fff; }
      #${FRAME_ID} .tf-search { width: min(290px, 25vw); height: 44px; display: flex; align-items: center; gap: 8px; padding: 0 8px 0 12px; border: 1px solid #dce2ea; border-radius: 10px; background: #fff; }
      #${FRAME_ID} .tf-search input { width: 100%; min-width: 0; outline: 0; border: 0; color: #344054; background: transparent; }
      #${FRAME_ID} .tf-search button { width: 32px; min-width: 32px; height: 32px; padding: 0; display: grid; place-items: center; border: 0; border-radius: 7px; color: #929baa; background: transparent; }
      #${FRAME_ID} .tf-badge { position: absolute; top: -7px; right: -5px; min-width: 18px; height: 18px; display: grid; place-items: center; padding: 0 4px; color: #fff; border: 2px solid #fff; border-radius: 10px; background: #ef6262; font-size: 9px; font-weight: 800; }
      #${FRAME_ID} .tf-account-chip { max-width: 210px; min-height: 42px; display: flex; align-items: center; gap: 9px; padding: 5px 10px 5px 6px; border: 1px solid #dce2ea; border-radius: 10px; background: #fff; }
      #${FRAME_ID} .tf-avatar { width: 31px; height: 31px; flex: 0 0 auto; display: grid; place-items: center; color: #fff; border-radius: 9px; background: #263449; font-weight: 800; }
      #${FRAME_ID} .tf-account-copy { min-width: 0; display: grid; }
      #${FRAME_ID} .tf-account-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #${FRAME_ID} .tf-account-copy small { color: #8792a3; font-size: 9px; }
      #${FRAME_ID} .tf-summary-row { min-width: 0; flex: 0 0 auto; margin: 18px 0; display: flex; align-items: stretch; gap: 10px; }
      #${FRAME_ID} .tf-summary { min-width: 142px; height: 66px; display: flex; align-items: center; gap: 11px; padding: 11px 14px; border: 1px solid var(--tf-line); border-radius: 11px; background: #fff; }
      #${FRAME_ID} button.tf-summary { text-align: left; }
      #${FRAME_ID} .tf-summary-icon { width: 37px; height: 37px; flex: 0 0 auto; display: grid; place-items: center; border-radius: 10px; }
      #${FRAME_ID} .tf-summary-icon.queued { color: #758196; background: #edf0f4; }
      #${FRAME_ID} .tf-summary-icon.running { color: var(--tf-blue); background: #edf0ff; }
      #${FRAME_ID} .tf-summary-icon.review { color: #c98920; background: #fff3da; }
      #${FRAME_ID} .tf-summary-icon.done { color: #238b5c; background: #e8f7ef; }
      #${FRAME_ID} .tf-summary b, #${FRAME_ID} .tf-summary small { display: block; }
      #${FRAME_ID} .tf-summary b { font-size: 21px; line-height: 1; }
      #${FRAME_ID} .tf-summary small { margin-top: 5px; color: var(--tf-muted); font-size: 10px; }
      #${FRAME_ID} .tf-sync { min-width: 0; margin-left: auto; align-self: center; color: #8590a0; font-size: 10px; }
      #${FRAME_ID} .tf-sync.ok { color: #279866; }
      #${FRAME_ID} .tf-message { flex: 0 0 auto; margin: -8px 0 12px; padding: 9px 11px; display: flex; align-items: center; gap: 7px; color: #596879; border: 1px solid #e2e7ef; border-radius: 9px; background: #fff; }
      #${FRAME_ID} .tf-message.error { color: #9a4d3f; border-color: #efd6d0; background: #fff8f6; }
      #${FRAME_ID} .tf-board { min-width: 0; min-height: 0; flex: 1; display: grid; grid-template-columns: repeat(4, minmax(230px, 1fr)); gap: 12px; overflow-x: auto; overflow-y: hidden; }
      #${FRAME_ID} .tf-column { position: relative; min-width: 230px; min-height: 0; display: flex; flex-direction: column; padding: 13px 11px 11px; border: 1px solid #dde3ea; border-radius: 13px; background: #eef1f5; box-shadow: inset 0 3px 0 #99a4b4; }
      #${FRAME_ID} .tf-column.running { background: #eef1ff; border-color: #dce1ff; box-shadow: inset 0 3px 0 var(--tf-blue); }
      #${FRAME_ID} .tf-column.review { background: #fff7e8; border-color: #f4e4c2; box-shadow: inset 0 3px 0 var(--tf-amber); }
      #${FRAME_ID} .tf-column.done { background: #edf8f2; border-color: #d7eee2; box-shadow: inset 0 3px 0 var(--tf-green); }
      #${FRAME_ID} .tf-column.drop-active { outline: 2px solid #7385ed; outline-offset: -2px; }
      #${FRAME_ID} .tf-column-head { height: 34px; flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 0 3px 9px; }
      #${FRAME_ID} .tf-dot { width: 7px; height: 7px; border-radius: 50%; background: #99a4b4; }
      #${FRAME_ID} .tf-dot.running { background: var(--tf-blue); } #${FRAME_ID} .tf-dot.review { background: var(--tf-amber); } #${FRAME_ID} .tf-dot.done { background: var(--tf-green); }
      #${FRAME_ID} .tf-count { min-width: 22px; height: 20px; display: grid; place-items: center; padding: 0 5px; border-radius: 6px; color: #6f7886; background: #dde2e8; font-size: 10px; font-weight: 800; }
      #${FRAME_ID} .tf-card-list { min-width: 0; min-height: 0; flex: 1; overflow-x: hidden; overflow-y: auto; display: grid; align-content: start; gap: 9px; padding: 1px 3px 7px 1px; scrollbar-width: thin; }
      #${FRAME_ID} .tf-card { min-width: 0; padding: 13px; border: 1px solid #e0e5eb; border-radius: 10px; background: #fff; box-shadow: 0 2px 7px #1d29390b; }
      #${FRAME_ID} .tf-card[draggable="true"] { cursor: grab; }
      #${FRAME_ID} .tf-card.dragging { opacity: .45; }
      #${FRAME_ID} .tf-card-top, #${FRAME_ID} .tf-card-foot { min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      #${FRAME_ID} .tf-kind { display: inline-flex; align-items: center; gap: 5px; color: #6578e3; font-size: 10px; font-weight: 800; line-height: 1; } #${FRAME_ID} .tf-kind.chat { color: #8b61ca; }
      #${FRAME_ID} .tf-kind .tf-icon { flex: 0 0 auto; vertical-align: 0; }
      #${FRAME_ID} .tf-card-labels { min-width: 0; display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
      #${FRAME_ID} .tf-priority { min-height: 21px; padding: 0 7px; display: inline-flex; align-items: center; gap: 3px; border-radius: 6px; color: #687385; background: #eef1f4; font-size: 9px; font-weight: 750; white-space: nowrap; }
      #${FRAME_ID} .tf-priority .tf-icon { width: 12px; height: 12px; }
      #${FRAME_ID} .tf-priority.high { color: #b34d41; background: #fff0ed; } #${FRAME_ID} .tf-priority.low { color: #2b8b63; background: #eaf7f0; }
      #${FRAME_ID} .tf-title { width: 100%; min-width: 0; min-height: 40px; margin: 4px 0 0; padding: 8px 4px; display: -webkit-box; overflow: hidden; overflow-wrap: anywhere; word-break: break-word; -webkit-box-orient: vertical; -webkit-line-clamp: 3; text-align: left; color: var(--tf-ink); border: 0; border-radius: 7px; background: transparent; font-weight: 750; line-height: 1.4; }
      #${FRAME_ID} .tf-title:hover { color: #4f66df; }
      #${FRAME_ID} .tf-meta { min-width: 0; overflow: hidden; overflow-wrap: anywhere; color: #8a94a4; font-size: 10px; }
      #${FRAME_ID} .tf-card-foot { margin-top: 14px; }
      #${FRAME_ID} .tf-card-actions { min-width: 0; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 5px; }
      #${FRAME_ID} .tf-mini { min-height: 36px; padding: 0 11px; display: inline-flex; align-items: center; justify-content: center; gap: 4px; border: 0; border-radius: 8px; color: #596de0; background: #eef1ff; font-size: 9px; font-weight: 750; }
      #${FRAME_ID} .tf-mini.review { color: #b77719; background: #fff2d6; } #${FRAME_ID} .tf-mini.danger { color: #9b5147; background: #fff0ed; }
      #${FRAME_ID} .tf-ai { width: 25px; height: 25px; display: grid; place-items: center; flex: 0 0 auto; border-radius: 8px; color: #fff; background: #263449; font-size: 8px; font-weight: 800; }
      #${FRAME_ID} .tf-running-state { margin-top: 11px; padding: 8px 10px; display: flex; align-items: center; gap: 7px; color: #5368dc; border-radius: 8px; background: #eef1ff; font-size: 10px; font-weight: 750; }
      #${FRAME_ID} .tf-running-spinner { width: 14px; height: 14px; flex: 0 0 auto; border: 2px solid #cfd6ff; border-top-color: #526df0; border-radius: 50%; animation: tf-spin .7s linear infinite; }
      #${FRAME_ID} .tf-empty { min-height: 120px; display: grid; place-items: center; align-content: center; gap: 6px; color: #9da6b3; text-align: center; border: 1px dashed #d0d6de; border-radius: 10px; font-size: 10px; }
      #${FRAME_ID} .tf-add { min-height: 44px; flex: 0 0 auto; margin-top: 8px; border: 1px solid #d9deeb; border-radius: 9px; color: #586cdf; background: #fff; font-weight: 750; }
      #${FRAME_ID} .tf-automation { min-height: 0; flex: 1; display: flex; flex-direction: column; overflow: hidden; border: 1px solid #e2e7ed; border-radius: 13px; background: #fff; }
      #${FRAME_ID} .tf-automation-head { min-height: 65px; flex: 0 0 auto; padding: 13px 15px; display: flex; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 1px solid #edf0f3; }
      #${FRAME_ID} .tf-automation-list { min-height: 0; flex: 1; overflow-y: auto; display: grid; align-content: start; grid-template-columns: repeat(auto-fill,minmax(260px,1fr)); gap: 11px; padding: 14px; }
      #${FRAME_ID} .tf-auto-item { min-width: 0; padding: 14px; border: 1px solid #e4e8ee; border-radius: 11px; background: #fbfcfd; }
      #${FRAME_ID} .tf-auto-item h3 { margin: 13px 0 7px; overflow-wrap: anywhere; }
      #${FRAME_ID} .tf-auto-item p { min-height: 43px; margin: 0; display: -webkit-box; overflow: hidden; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 3; color: #6f7a89; font-size: 10px; }
      #${FRAME_ID} .tf-auto-meta { margin: 12px 0; display: grid; gap: 3px; color: #8e98a6; font-size: 9px; }
      #${FRAME_ID} .tf-notice { position: absolute; z-index: 40; top: 66px; right: 24px; width: min(340px, calc(100% - 48px)); height: 520px; max-height: calc(100% - 90px); overflow: hidden; display: flex; flex-direction: column; border: 1px solid #e1e6ec; border-radius: 12px; background: #fff; box-shadow: 0 18px 45px #18223022; }
      #${FRAME_ID} .tf-notice-head { flex: 0 0 auto; padding: 13px 14px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #edf0f3; }
      #${FRAME_ID} .tf-notice-list { min-height: 0; flex: 1; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: #bcc4cf transparent; }
      #${FRAME_ID} .tf-notice-list::-webkit-scrollbar { width: 6px; }
      #${FRAME_ID} .tf-notice-list::-webkit-scrollbar-thumb { border-radius: 6px; background: #bcc4cf; }
      #${FRAME_ID} .tf-notice-item { width: 100%; min-height: 58px; padding: 14px 16px; display: grid; align-content: center; gap: 4px; text-align: left; border: 0; border-bottom: 1px solid #f0f2f4; background: #fff; }
      #${FRAME_ID} .tf-notice-item:hover { background: #fafbff; } #${FRAME_ID} .tf-notice-item small { color: #98a1ae; }
      #${FRAME_ID} .tf-loading-overlay { position: absolute; inset: 0; z-index: 55; display: grid; place-items: center; background: #f5f7fad9; backdrop-filter: blur(1px); }
      #${FRAME_ID} .tf-loading-content { min-width: 220px; padding: 22px 26px; display: grid; justify-items: center; gap: 8px; color: #52606f; border: 1px solid #e0e5ec; border-radius: 14px; background: #fff; box-shadow: 0 18px 48px #18223018; }
      #${FRAME_ID} .tf-loading-content small { color: #8a94a4; }
      #${FRAME_ID} .tf-spinner { width: 28px; height: 28px; border: 3px solid #dfe4ff; border-top-color: var(--tf-blue); border-radius: 50%; animation: tf-spin .7s linear infinite; }
      #${FRAME_ID} .tf-refresh-button.loading .tf-icon { animation: tf-spin .7s linear infinite; }
      @keyframes tf-spin { to { transform: rotate(360deg); } }
      #${FRAME_ID} .tf-modal-backdrop { position: absolute; inset: 0; z-index: 60; padding: 20px; display: grid; place-items: center; background: #18223066; backdrop-filter: blur(4px); }
      #${FRAME_ID} .tf-modal { width: min(490px,100%); height: min(640px, calc(100% - 40px)); min-height: 0; overflow: hidden; display: flex; flex-direction: column; border: 1px solid #e4e8ed; border-radius: 16px; background: #fff; box-shadow: 0 24px 70px #10182830; }
      #${FRAME_ID} .tf-modal-head { flex: 0 0 auto; padding: 20px 21px 16px; display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; border-bottom: 1px solid #edf0f3; background: #fff; }
      #${FRAME_ID} .tf-modal-head h2 { margin: 4px 0 0; overflow-wrap: anywhere; font-size: 17px; } #${FRAME_ID} .tf-kicker { margin: 0; color: #6578e3; font-size: 9px; font-weight: 800; text-transform: uppercase; }
      #${FRAME_ID} .tf-close { width: 40px; height: 40px; flex: 0 0 auto; display: grid; place-items: center; border: 0; border-radius: 9px; color: #77808e; background: #f2f4f7; }
      #${FRAME_ID} .tf-modal-body { padding: 18px 21px; color: #657080; } #${FRAME_ID} .tf-modal-body p { overflow-wrap: anywhere; white-space: pre-wrap; }
      #${FRAME_ID} .tf-modal-scroll { min-height: 0; flex: 1 1 auto; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; scrollbar-width: thin; scrollbar-color: #bcc4cf transparent; }
      #${FRAME_ID} .tf-modal-scroll::-webkit-scrollbar { width: 7px; }
      #${FRAME_ID} .tf-modal-scroll::-webkit-scrollbar-thumb { border: 2px solid transparent; border-radius: 7px; background: #bcc4cf; background-clip: padding-box; }
      #${FRAME_ID} .tf-modal-actions { flex: 0 0 auto; padding: 14px 21px 20px; display: flex; justify-content: flex-end; gap: 8px; border-top: 1px solid #edf0f3; background: #fff; }
      #${FRAME_ID} .tf-field { margin: 16px 21px 0; display: grid; gap: 7px; color: #515b69; font-size: 10px; font-weight: 700; }
      #${FRAME_ID} .tf-field input, #${FRAME_ID} .tf-field select, #${FRAME_ID} .tf-field textarea { width: 100%; min-width: 0; min-height: 42px; padding: 9px 10px; outline: 0; color: #344054; border: 1px solid #dfe3e9; border-radius: 8px; background: #fff; }
      #${FRAME_ID} .tf-field textarea { min-height: 105px; resize: vertical; }
      #${FRAME_ID} .tf-choice-group { margin: 16px 21px 0; padding: 0; display: grid; gap: 8px; border: 0; }
      #${FRAME_ID} .tf-choice-group legend { margin-bottom: 7px; color: #515b69; font-size: 10px; font-weight: 700; }
      #${FRAME_ID} .tf-choice { min-width: 0; padding: 12px 13px; display: flex; align-items: flex-start; gap: 10px; border: 1px solid #dfe3e9; border-radius: 10px; background: #fff; cursor: pointer; }
      #${FRAME_ID} .tf-choice:has(input:checked) { border-color: #8796ef; background: #f4f6ff; box-shadow: 0 0 0 1px #8796ef inset; }
      #${FRAME_ID} .tf-choice input { width: 16px; height: 16px; flex: 0 0 auto; margin: 2px 0 0; accent-color: #526df0; }
      #${FRAME_ID} .tf-choice-copy { min-width: 0; display: grid; gap: 3px; }
      #${FRAME_ID} .tf-choice-copy strong { color: #344054; font-size: 11px; }
      #${FRAME_ID} .tf-choice-copy small, #${FRAME_ID} .tf-field small { color: #7d8796; font-size: 9px; font-weight: 500; }
      #${FRAME_ID} .tf-project-select[hidden] { display: none; }
      #${FRAME_ID} .tf-inline-status { min-height: 110px; padding: 24px; display: grid; place-items: center; align-content: center; gap: 9px; color: #697586; text-align: center; }
      #${FRAME_ID} .tf-setting-row { margin: 16px 21px; padding: 13px; display: flex; align-items: center; justify-content: space-between; gap: 13px; border: 1px solid #e6eaf0; border-radius: 10px; background: #fafbfc; }
      #${FRAME_ID} .tf-setting-row p { margin: 4px 0 0; color: #7d8796; font-size: 9px; }
      #${FRAME_ID} .tf-switch { position: relative; width: 50px; height: 44px; padding: 0; flex: 0 0 auto; border: 0; background: transparent; } #${FRAME_ID} .tf-switch::before { content: ""; position: absolute; inset: 10px 4px; border-radius: 14px; background: #cfd4dc; transition: background-color .18s ease-out; } #${FRAME_ID} .tf-switch::after { content: ""; position: absolute; top: 13px; left: 7px; width: 18px; height: 18px; border-radius: 50%; background: #fff; transition: transform .18s ease-out; } #${FRAME_ID} .tf-switch.on::before { background: #6075ed; } #${FRAME_ID} .tf-switch.on::after { transform: translateX(18px); }
      #${FRAME_ID} .tf-toast { position: absolute; z-index: 80; left: 50%; bottom: 24px; transform: translateX(-50%); padding: 10px 14px; color: #fff; border-radius: 9px; background: #253243; box-shadow: 0 12px 30px #1d29392d; }
      #${FRAME_ID}[data-theme="dark"] { --tf-ink: #edf1f7; --tf-muted: #98a3b3; --tf-line: #363c47; color-scheme: dark; background: #171a1f; }
      #${FRAME_ID}[data-theme="dark"] .tf-tabs, #${FRAME_ID}[data-theme="dark"] .tf-search, #${FRAME_ID}[data-theme="dark"] .tf-expand, #${FRAME_ID}[data-theme="dark"] .tf-secondary, #${FRAME_ID}[data-theme="dark"] .tf-icon-button, #${FRAME_ID}[data-theme="dark"] .tf-account-chip, #${FRAME_ID}[data-theme="dark"] .tf-summary, #${FRAME_ID}[data-theme="dark"] .tf-card, #${FRAME_ID}[data-theme="dark"] .tf-add, #${FRAME_ID}[data-theme="dark"] .tf-automation, #${FRAME_ID}[data-theme="dark"] .tf-auto-item, #${FRAME_ID}[data-theme="dark"] .tf-notice, #${FRAME_ID}[data-theme="dark"] .tf-notice-item, #${FRAME_ID}[data-theme="dark"] .tf-modal, #${FRAME_ID}[data-theme="dark"] .tf-loading-content, #${FRAME_ID}[data-theme="dark"] .tf-choice { color: #dfe5ee; border-color: #3a414d; background: #22262d; }
      #${FRAME_ID}[data-theme="dark"] .tf-column { border-color: #343b46; background: #20242a; }
      #${FRAME_ID}[data-theme="dark"] .tf-column.running { border-color: #39446d; background: #20263a; }
      #${FRAME_ID}[data-theme="dark"] .tf-column.review { border-color: #59492d; background: #30291e; }
      #${FRAME_ID}[data-theme="dark"] .tf-column.done { border-color: #315344; background: #1f3029; }
      #${FRAME_ID}[data-theme="dark"] .tf-field input, #${FRAME_ID}[data-theme="dark"] .tf-field select, #${FRAME_ID}[data-theme="dark"] .tf-field textarea { color: #e6ebf2; border-color: #444b57; background: #1b1e24; }
      #${FRAME_ID}[data-theme="dark"] .tf-choice:has(input:checked), #${FRAME_ID}[data-theme="dark"] .tf-tabs button.active { background: #29304b; }
      #${FRAME_ID}[data-theme="dark"] .tf-choice-copy strong, #${FRAME_ID}[data-theme="dark"] .tf-modal-head h2 { color: #edf1f7; }
      #${FRAME_ID}[data-theme="dark"] .tf-modal-head, #${FRAME_ID}[data-theme="dark"] .tf-modal-actions, #${FRAME_ID}[data-theme="dark"] .tf-notice-head, #${FRAME_ID}[data-theme="dark"] .tf-automation-head { border-color: #353b45; background: #22262d; }
      #${FRAME_ID}[data-theme="dark"] .tf-close { color: #b8c0cc; background: #30353e; }
      @media (max-width: 1050px) { #${FRAME_ID} .tf-shell { padding: 18px 16px 14px; } #${FRAME_ID} .tf-topbar { align-items: flex-start; } #${FRAME_ID} .tf-actions { flex-wrap: wrap; justify-content: flex-end; } #${FRAME_ID} .tf-search { width: 210px; } #${FRAME_ID} .tf-account-chip { max-width: 170px; } #${FRAME_ID} .tf-sync { display: none; } #${FRAME_ID} .tf-notice { right: 16px; } }
      @media (max-width: 820px) { #${FRAME_ID} .tf-topbar { flex-direction: column; align-items: stretch; gap: 10px; } #${FRAME_ID} .tf-top-left { overflow-x: auto; scrollbar-width: none; } #${FRAME_ID} .tf-actions { width: 100%; justify-content: flex-start; } #${FRAME_ID} .tf-search { width: 100%; flex: 1 1 100%; } #${FRAME_ID} .tf-account { margin-left: auto; } #${FRAME_ID} .tf-account-chip { width: 43px; padding-right: 5px; } #${FRAME_ID} .tf-account-copy { display: none; } #${FRAME_ID} .tf-summary-row { overflow-x: auto; padding-bottom: 3px; } #${FRAME_ID} .tf-board { grid-template-columns: repeat(4, minmax(calc(100% - 12px), 1fr)); } }
      @media (max-width: 520px) { #${FRAME_ID} .tf-shell { padding: 12px 10px 10px; } #${FRAME_ID} .tf-tabs { min-width: 100%; } #${FRAME_ID} .tf-tabs button { min-width: 0; flex: 1; padding: 0 5px; gap: 4px; font-size: 11px; } #${FRAME_ID} .tf-actions > .tf-secondary { flex: 1 1 auto; } #${FRAME_ID} .tf-summary { min-width: 132px; } #${FRAME_ID} .tf-modal-backdrop { padding: 8px; } #${FRAME_ID} .tf-modal { height: calc(100% - 4px); border-radius: 13px; } #${FRAME_ID} .tf-modal-actions { flex-wrap: wrap; } #${FRAME_ID} .tf-modal-actions button { flex: 1 1 auto; } #${FRAME_ID} .tf-notice { top: 118px; right: 10px; width: calc(100% - 20px); max-height: calc(100% - 130px); } }
      @media (pointer: coarse) { #${FRAME_ID} button, #${FRAME_ID} .tf-choice { min-height: 44px; } #${FRAME_ID} .tf-tabs button, #${FRAME_ID} .tf-mini, #${FRAME_ID} .tf-close { min-height: 44px; } }
      @media (prefers-reduced-motion: reduce) { #${FRAME_ID} *, #${FRAME_ID} *::before, #${FRAME_ID} *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; } }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function buttonMatches(button, labels) {
    if (!button) return false;
    const text = normalizedLabel(button.textContent || button.getAttribute("aria-label"));
    return labels.includes(text);
  }

  function findReferenceButton() {
    const scroll = document.querySelector("[data-app-action-sidebar-scroll]");
    if (!scroll) return null;
    const buttons = Array.from(scroll.querySelectorAll("button"));
    const plugin = buttons.find((button) => buttonMatches(button, PLUGIN_LABELS));
    if (plugin) return plugin;

    const firstSection = scroll.querySelector("[data-app-action-sidebar-section]");
    const sectionTop = firstSection?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
    const groups = Array.from(scroll.querySelectorAll("div")).filter((element) => {
      const directButtons = Array.from(element.children).filter((child) => child.tagName === "BUTTON");
      return directButtons.length >= 3 && element.getBoundingClientRect().top < sectionTop;
    });
    const group = groups.sort((left, right) => right.children.length - left.children.length)[0];
    return Array.from(group?.children || []).filter((child) => child.tagName === "BUTTON").at(-1) || null;
  }

  function replaceEntryIcon(button) {
    const icon = button.querySelector("svg");
    if (!icon) return;
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "1.8");
    icon.setAttribute("stroke-linecap", "round");
    icon.setAttribute("stroke-linejoin", "round");
    icon.innerHTML = `
      <rect x="3.5" y="4" width="17" height="16" rx="2.5"></rect>
      <path d="M9 4v16M14.5 8h2.5M14.5 12h2.5M14.5 16h2.5"></path>
    `;
  }

  function createEntry(reference) {
    const button = reference.cloneNode(true);
    button.id = ENTRY_ID;
    button.type = "button";
    button.removeAttribute("disabled");
    button.removeAttribute("aria-expanded");
    button.removeAttribute("aria-controls");
    button.removeAttribute("aria-describedby");
    button.removeAttribute("data-state");
    button.setAttribute("aria-label", "打开任务流看板");
    button.setAttribute("title", "任务流看板");
    button.setAttribute(OWNED_ATTRIBUTE, "true");
    button.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
    const label = button.querySelector(".text-fade-truncate")
      || Array.from(button.querySelectorAll("span")).find((node) => buttonMatches(node, PLUGIN_LABELS));
    if (label) label.textContent = "任务流看板";
    else button.textContent = "任务流看板";
    replaceEntryIcon(button);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openTaskboard();
    });
    return button;
  }

  function syncEntryState() {
    if (!entry) return;
    if (active && entry.getAttribute("aria-current") !== "page") {
      entry.setAttribute("aria-current", "page");
    } else if (!active && entry.hasAttribute("aria-current")) {
      entry.removeAttribute("aria-current");
    }
  }

  function ensureEntry() {
    if (destroyed || !document.body) return;
    installStyles();
    const reference = findReferenceButton();
    if (!reference?.parentElement) return;
    if (!entry) entry = createEntry(reference);
    if (entry.parentElement !== reference.parentElement || entry.previousElementSibling !== reference) {
      reference.after(entry);
    }
    syncEntryState();
  }

  function findPageHost() {
    const direct = document.querySelector(".app-shell-main-content-frame");
    if (direct?.closest?.("[data-app-shell-main-content-layout]")) return direct;

    const viewport = document.querySelector("[data-app-shell-main-content-layout]");
    if (!viewport) return null;
    const viewportRect = viewport.getBoundingClientRect();
    const headerBottom = document.querySelector("main > header")?.getBoundingClientRect().bottom
      ?? viewportRect.top;
    const findCandidate = (minWidthRatio, minHeightRatio) => (
      Array.from(viewport.children).find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.width > 0
          && rect.height > 0
          && rect.width >= viewportRect.width * minWidthRatio
          && rect.height >= viewportRect.height * minHeightRatio
          && rect.top >= headerBottom - 1;
      }) || null
    );
    return findCandidate(0.8, 0.7)
      || findCandidate(0.5, 0.5)
      || viewport.querySelector("main")
      || viewport;
  }

  function findPageMount() {
    const frameHost = findPageHost();
    const viewport = frameHost?.closest?.("[data-app-shell-main-content-layout]");
    const surface = viewport?.parentElement;
    if (frameHost && surface?.closest("main")) return { frameHost, surface };
    const main = document.querySelector("main");
    if (!main) return null;
    return { frameHost: frameHost ?? main, surface: main };
  }

  function muteNativeSelection() {
    if (!active) return;
    document.querySelectorAll('aside nav[role="navigation"] [aria-current]')
      .forEach((node) => {
        if (node === entry || node.closest(`#${ENTRY_ID}`)) return;
        if (!mutedNativeSelections.has(node)) {
          mutedNativeSelections.set(node, node.getAttribute("aria-current"));
        }
        node.removeAttribute("aria-current");
        node.setAttribute(NATIVE_SELECTED_ATTRIBUTE, "true");
      });
  }

  function restoreNativeSelection() {
    mutedNativeSelections.forEach((ariaCurrent, node) => {
      if (!node.isConnected) return;
      node.setAttribute("aria-current", ariaCurrent);
      node.removeAttribute(NATIVE_SELECTED_ATTRIBUTE);
    });
    mutedNativeSelections.clear();
    document.querySelectorAll(`[${NATIVE_SELECTED_ATTRIBUTE}="true"]`)
      .forEach((node) => node.removeAttribute(NATIVE_SELECTED_ATTRIBUTE));
  }

  function hideNativeHeader() {
    document.querySelectorAll('[data-testid="app-shell-header-context-menu-surface"]')
      .forEach((surface) => {
        Array.from(surface.children).forEach((child) => {
          if (child.getAttribute(OWNED_ATTRIBUTE) !== "true") {
            child.setAttribute(HIDDEN_ATTRIBUTE, "true");
          }
        });
      });
  }

  function currentTheme() {
    const root = document.documentElement;
    const explicit = String(root.dataset.theme || root.getAttribute("data-color-theme") || "").toLowerCase();
    if (explicit.includes("dark") || root.classList.contains("dark")) return "dark";
    if (explicit.includes("light") || root.classList.contains("light")) return "light";
    try {
      return window.getComputedStyle(root).colorScheme.includes("dark") ? "dark" : "light";
    } catch (_) {
      return "light";
    }
  }

  function threadIdFromLocation() {
    const source = `${window.location.pathname || ""}${window.location.search || ""}${window.location.hash || ""}`;
    const match = source.match(/(?:session|conversation|thread)(?:\/|=|:|-)([A-Za-z0-9_.-]+)/i)
      || source.match(/\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:[/?#]|$)/)
      || source.match(/\/([A-Za-z0-9_-]{24,})(?:[/?#]|$)/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  function activeThreadRow() {
    const rows = Array.from(document.querySelectorAll("[data-app-action-sidebar-thread-id]"));
    return rows.find((row) => row.getAttribute("data-app-action-sidebar-thread-active") === "true")
      || rows.find((row) => ["page", "true"].includes(row.getAttribute("aria-current")))
      || null;
  }

  function readCodexProjects() {
    const seen = new Set();
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-project-row]"))
      .flatMap((row) => {
        const id = row.getAttribute("data-app-action-sidebar-project-id")?.trim();
        const name = (
          row.getAttribute("data-app-action-sidebar-project-label")
          || row.getAttribute("aria-label")
          || ""
        ).trim();
        if (!id || !name || seen.has(id)) return [];
        seen.add(id);
        return [{ id, name }];
      });
  }

  function findProjectsSection() {
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-section-heading]"))
      .find((node) => PROJECT_SECTION_LABELS.includes(normalizedLabel(
        node.getAttribute("data-app-action-sidebar-section-heading") || node.textContent,
      )))
      ?.closest("[data-app-action-sidebar-section]") || null;
  }

  function findTasksSection() {
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-section]"))
      .find((section) => {
        const heading = section.querySelector("[data-app-action-sidebar-section-heading]");
        const label = heading?.getAttribute("data-app-action-sidebar-section-heading")
          || heading?.textContent
          || section.textContent;
        return TASK_SECTION_LABELS.includes(normalizedLabel(label));
      }) || null;
  }

  async function captureHostContext() {
    let projects = readCodexProjects();
    let section = findProjectsSection();
    const sectionDeadline = Date.now() + 1_200;
    while (!section && Date.now() < sectionDeadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 40));
      section = findProjectsSection();
    }
    const tasksSection = findTasksSection();
    const expandedSections = [section, tasksSection].filter((candidate) => (
      candidate?.getAttribute("data-app-action-sidebar-section-collapsed") === "true"
    ));
    expandedSections.forEach((candidate) => (
      candidate.querySelector("[data-app-action-sidebar-section-toggle]")?.click()
    ));
    if (expandedSections.length > 0) {
      const deadline = Date.now() + 1_200;
      do {
        await new Promise((resolve) => window.setTimeout(resolve, 40));
        projects = readCodexProjects();
      } while ((projects.length === 0 || !activeThreadRow()) && Date.now() < deadline);
    }
    const context = readHostContext(projects);
    expandedSections.forEach((candidate) => {
      if (candidate.isConnected && candidate.getAttribute("data-app-action-sidebar-section-collapsed") === "false") {
        candidate.querySelector("[data-app-action-sidebar-section-toggle]")?.click();
      }
    });
    return context;
  }

  function workspaceFromLocation() {
    try {
      const url = new URL(window.location.href);
      return url.searchParams.get("workspace") || url.searchParams.get("cwd") || "";
    } catch (_) {
      return "";
    }
  }

  function titlebarLeftInset() {
    if (!/Macintosh|Mac OS X/.test(navigator.userAgent)) return 0;
    if (nativeSidebarCollapsed()) return MACOS_TITLEBAR_SAFE_LEFT;
    const surfaceLeft = findPageMount()?.surface.getBoundingClientRect().left;
    if (!Number.isFinite(surfaceLeft)) return 0;
    return Math.max(0, Math.ceil(MACOS_TITLEBAR_SAFE_LEFT - surfaceLeft));
  }

  function nativeSidebarTrigger() {
    const triggers = Array.from(
      document.querySelectorAll('[data-app-shell-sidebar-trigger="true"]'),
    );
    return triggers.find((trigger) => getComputedStyle(trigger).visibility !== "hidden")
      || triggers[0]
      || null;
  }

  function nativeSidebarCollapsed() {
    const label = normalizedLabel(nativeSidebarTrigger()?.getAttribute("aria-label"));
    return label.startsWith("显示") || label.startsWith("show ");
  }

  function expandNativeSidebar() {
    const trigger = nativeSidebarTrigger();
    if (!trigger || !nativeSidebarCollapsed()) return;
    trigger.click();
    window.setTimeout(postHostContext, REATTACH_DELAY_MS);
  }

  function closeNativeRightSidebar() {
    const viewportRight = document.documentElement.clientWidth || window.innerWidth;
    const sidebarOpen = Array.from(
      document.querySelectorAll('[data-slot="thread-summary-panel-item-button"]'),
    ).some((item) => {
      const rect = item.getBoundingClientRect();
      return getComputedStyle(item).visibility !== "hidden"
        && rect.width > 0
        && rect.right >= viewportRight - 80;
    });
    if (!sidebarOpen) return;

    const trigger = Array.from(document.querySelectorAll("button[aria-label]"))
      .find((button) => (
        getComputedStyle(button).visibility !== "hidden"
        && button.getBoundingClientRect().right > viewportRight / 2
        && NATIVE_RIGHT_SIDEBAR_TRIGGER_LABELS.includes(
          normalizedLabel(button.getAttribute("aria-label")),
        )
      ));
    trigger?.click();
  }

  function closeNativeBrowserPanel() {
    const viewportRight = document.documentElement.clientWidth || window.innerWidth;
    const webview = Array.from(document.querySelectorAll("webview"))
      .find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return getComputedStyle(candidate).visibility !== "hidden"
          && rect.width > 0
          && rect.height > 0
          && rect.right >= viewportRight - 1;
      });
    if (!webview) return false;

    const panel = webview.closest("aside");
    const closeTab = Array.from(
      (panel || document).querySelectorAll("button[aria-label]"),
    ).find((button) => {
      const label = normalizedLabel(button.getAttribute("aria-label"));
      const rect = button.getBoundingClientRect();
      const isCloseTab = (label.startsWith("关闭") && label.endsWith("标签页"))
        || (label.startsWith("close ") && label.endsWith(" tab"));
      return isCloseTab
        && getComputedStyle(button).visibility !== "hidden"
        && rect.width > 0
        && rect.height > 0;
    });
    if (!closeTab) return false;
    closeTab.click();
    return true;
  }

  function userIdFromName(name) {
    const slug = name.normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 96);
    if (slug) return slug;
    let hash = 2166136261;
    for (const character of name) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return `codex-user-${(hash >>> 0).toString(36)}`;
  }

  function readCodexUser() {
    const avatar = Array.from(document.querySelectorAll("img"))
      .find((image) => image.src.includes("cdn.auth0.com/avatars/"));
    const profileButton = avatar?.closest("button")
      || Array.from(document.querySelectorAll('button[aria-haspopup="menu"]')).find((button) => (
        normalizedLabel(button.getAttribute("aria-label")).includes("profile")
        || normalizedLabel(button.getAttribute("aria-label")).includes("个人资料")
      ));
    const name = profileButton?.textContent?.replace(/\s+/g, " ").trim();
    if (!name) return null;
    const avatarUrl = avatar?.currentSrc || avatar?.src || null;
    return {
      type: "user",
      id: userIdFromName(name),
      name,
      avatarUrl,
    };
  }

  function readHostContext(projects = readCodexProjects()) {
    const row = activeThreadRow();
    const activeThreadId = normalizeThreadId(row?.getAttribute("data-app-action-sidebar-thread-id"));
    if (activeThreadId) lastNativeThreadId = activeThreadId;
    const threadId = activeThreadId || lastNativeThreadId || normalizeThreadId(threadIdFromLocation());
    const projectList = row?.closest?.("[data-app-action-sidebar-project-list-id]");
    const projectRow = row?.closest?.("[data-app-action-sidebar-project-id]")
      || document.querySelector('[data-app-action-sidebar-project-row][aria-current="page"]')
      || document.querySelector('[data-app-action-sidebar-project-row][data-app-action-sidebar-project-active="true"]');
    const projectId = projectList?.getAttribute("data-app-action-sidebar-project-list-id")
      || projectRow?.getAttribute("data-app-action-sidebar-project-id")
      || "";
    const workspacePath = workspaceFromLocation();
    const payload = {
      theme: currentTheme(),
      projects,
      user: readCodexUser() ?? undefined,
      titlebarLeftInset: titlebarLeftInset(),
      sidebarCollapsed: nativeSidebarCollapsed(),
    };
    if (workspacePath) payload.workspacePath = workspacePath;
    if (projectId) payload.projectId = projectId;
    if (threadId) payload.threadId = threadId;
    return payload;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function taskflowIcon(name) {
    const paths = {
      menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
      chat: '<path d="M5 6.5A3.5 3.5 0 0 1 8.5 3h7A3.5 3.5 0 0 1 19 6.5v4a3.5 3.5 0 0 1-3.5 3.5H11l-4.5 3v-3.4A3.5 3.5 0 0 1 5 10.7Z"/><path d="M9 8h6M9 11h4"/>',
      task: '<rect x="5" y="3.5" width="14" height="17" rx="2"/><path d="M8.5 8h7M8.5 12h7M8.5 16h4"/>',
      clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
      search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4 4"/>',
      bell: '<path d="M6.5 16.5h11l-1.3-2V10a4.2 4.2 0 0 0-8.4 0v4.5Z"/><path d="M10 19h4"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
      settings: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.5 1a8 8 0 0 0-1.8-1L14.2 3h-4.4l-.4 3.1a8 8 0 0 0-1.8 1l-2.5-1-2 3.4 2 1.5a7 7 0 0 0 0 2l-2 1.5 2 3.4 2.5-1a8 8 0 0 0 1.8 1l.4 3.1h4.4l.4-3.1a8 8 0 0 0 1.8-1l2.5 1 2-3.4-2-1.5a7 7 0 0 0 .1-1Z"/>',
      check: '<path d="m5 12.5 4.2 4L19 7"/>',
      warning: '<path d="M12 4 3.5 19h17Z"/><path d="M12 9v4M12 16h.01"/>',
      refresh: '<path d="M19 7v5h-5"/><path d="M18 12a6.5 6.5 0 1 1-1.8-4.5L19 10"/>',
      eye: '<path d="M3 12s3.2-5 9-5 9 5 9 5-3.2 5-9 5-9-5-9-5Z"/><circle cx="12" cy="12" r="2.5"/>',
      arrow: '<path d="M5 12h14M14 7l5 5-5 5"/>',
      play: '<path d="m9 7 8 5-8 5Z"/>',
      flag: '<path d="M6 21V4m0 1h10l-2 3 2 3H6"/>',
      close: '<path d="m7 7 10 10M17 7 7 17"/>',
    };
    return `<svg class="tf-icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.task}</svg>`;
  }

  function workspaceName(cwd = "") {
    const parts = String(cwd).replace(/\/$/, "").split("/").filter(Boolean);
    return parts.at(-1) || "Codex";
  }

  function relativeTime(seconds) {
    const time = Number(seconds) * 1000;
    const minutes = Math.floor(Math.max(0, Date.now() - time) / 60_000);
    if (minutes < 1) return "刚刚";
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    if (hours < 48) return "昨天";
    return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(new Date(time));
  }

  function isToday(seconds) {
    const time = Number(seconds) * 1000;
    if (!Number.isFinite(time) || time <= 0) return false;
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return time >= start.getTime() && time < start.getTime() + 24 * 60 * 60 * 1000;
  }

  function priorityLabel(priority) {
    return priority === "high" ? "高优先级" : priority === "low" ? "低优先级" : "普通";
  }

  function formatDateTime(value) {
    if (value === null || value === undefined || value === "") return "暂无下次运行时间";
    const raw = typeof value === "number" && value < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return "暂无下次运行时间";
    return new Intl.DateTimeFormat("zh-CN", {
      month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
    }).format(date);
  }

  function automationSchedule(item) {
    const rule = String(item?.rrule || "");
    const interval = rule.match(/FREQ=MINUTELY;INTERVAL=(\d+)/i)?.[1];
    if (interval) return `每 ${interval} 分钟`;
    if (/FREQ=HOURLY/i.test(rule)) return "每小时";
    if (/FREQ=DAILY/i.test(rule)) return "每天";
    if (/FREQ=WEEKLY/i.test(rule)) return "每周";
    return rule || "计划时间由 Codex 管理";
  }

  function rateLimitSummary(response) {
    const snapshots = response?.rateLimitsByLimitId
      ? Object.values(response.rateLimitsByLimitId)
      : [];
    const snapshot = response?.rateLimitsByLimitId?.codex
      || response?.rateLimits
      || snapshots.find((entry) => entry?.limitId === "codex")
      || snapshots[0]
      || null;
    if (!snapshot) return { plan: "Codex 账号", quota: "额度暂不可用", reset: "" };
    const windows = [snapshot.primary, snapshot.secondary].filter(Boolean)
      .sort((left, right) => Number(right.usedPercent || 0) - Number(left.usedPercent || 0));
    const tightest = windows[0];
    const used = tightest ? Math.max(0, Math.min(100, Math.round(Number(tightest.usedPercent || 0)))) : null;
    const rawPlan = String(snapshot.planType || "").trim();
    const reset = Number.isFinite(tightest?.resetsAt)
      ? `${new Date(Number(tightest.resetsAt) * 1000).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} 重置`
      : "";
    return {
      plan: rawPlan ? `${rawPlan.charAt(0).toUpperCase()}${rawPlan.slice(1)} 套餐` : "Codex 账号",
      quota: used === null ? "额度暂不可用" : `本周已用 ${used}%`,
      reset,
    };
  }

  function inlineItems() {
    const queued = queueItems.map((item) => ({
      id: `queue:${item.id}`,
      threadId: item.startedThreadId || "",
      queueId: item.id,
      kind: item.kind,
      title: item.title,
      priority: normalizePriority(item.priority),
      status: "queued",
      meta: `${relativeTime(item.createdAt / 1000)} · ${item.workspaceMode === "none" ? "不需要项目" : item.projectName || workspaceName(item.cwd)} · ${item.status === "starting" ? "正在创建 Codex 对话" : item.status === "failed" ? `启动失败：${item.lastError || "未知错误"}` : "等待 Codex 自动认领"}`,
      result: item.prompt,
      error: item.status === "failed",
      updatedAt: item.createdAt / 1000,
    }));
    const threads = inlineState.threads.map((thread) => {
      const nativeStatus = thread?.status?.type || "notLoaded";
      const updatedAt = Number(thread.updatedAt || 0);
      const status = nativeStatus === "active"
        ? "running"
        : inlineState.acceptedIds.has(thread.id) || !isToday(updatedAt) ? "done" : "review";
      const title = thread.name?.trim()
        || thread.preview?.trim().split("\n")[0]?.slice(0, 80)
        || "未命名任务";
      const automated = /^Automation:/i.test(thread.preview || "") || thread.threadSource === "automation";
      return {
        id: thread.id,
        threadId: thread.id,
        queueId: "",
        kind: automated ? "任务" : "聊天",
        title,
        priority: normalizePriority(threadPriorities[thread.id] || thread.priority),
        status,
        meta: `${relativeTime(thread.updatedAt)} · ${workspaceName(thread.cwd)}`,
        result: thread.preview?.trim() || "该任务没有可用摘要，请在 Codex 中查看完整记录。",
        error: nativeStatus === "systemError",
        updatedAt,
      };
    });
    return [...queued, ...threads];
  }

  function lastCodexReply(thread) {
    const replies = (Array.isArray(thread?.turns) ? thread.turns : [])
      .flatMap((turn) => (Array.isArray(turn?.items) ? turn.items : []))
      .filter((item) => item?.type === "agentMessage" && typeof item.text === "string" && item.text.trim());
    return replies.findLast((item) => item.phase === "final_answer")?.text.trim()
      || replies.at(-1)?.text.trim()
      || "该任务没有可用的 Codex 回复，请打开对话查看完整记录。";
  }

  async function openInlineResult(id) {
    const item = inlineItems().find((entry) => entry.id === id);
    inlineState.selectedId = id;
    inlineState.selectedResult = item?.queueId ? item.result : "";
    inlineState.selectedResultLoading = Boolean(item?.threadId && !item.queueId);
    inlineState.showNotices = false;
    inlineState.modalFocusPending = true;
    renderInlineBoard();
    if (!inlineState.selectedResultLoading) return;
    try {
      const response = await requestCodexAppServer("thread/read", {
        threadId: item.threadId,
        includeTurns: true,
      });
      if (inlineState.selectedId !== id) return;
      inlineState.selectedResult = lastCodexReply(response?.thread);
    } catch {
      if (inlineState.selectedId !== id) return;
      inlineState.selectedResult = "暂时无法读取最后一次回复，请打开对话查看完整记录。";
    } finally {
      if (inlineState.selectedId !== id) return;
      inlineState.selectedResultLoading = false;
      renderInlineBoard();
    }
  }

  function showInlineToast(message) {
    inlineState.toast = message;
    if (inlineToastTimer !== null) window.clearTimeout(inlineToastTimer);
    inlineToastTimer = window.setTimeout(() => {
      inlineState.toast = "";
      inlineToastTimer = null;
      renderInlineBoard();
    }, 2600);
    renderInlineBoard();
  }

  function persistAcceptedIds() {
    window.localStorage.setItem(ACCEPTED_STORAGE_KEY, JSON.stringify([...inlineState.acceptedIds]));
  }

  function persistThreadPriorities() {
    window.localStorage.setItem(THREAD_PRIORITIES_STORAGE_KEY, JSON.stringify(threadPriorities));
  }

  function setInlineView(view) {
    if (!["all", "chats", "tasks", "automations"].includes(view)) return;
    inlineState.view = view;
    window.localStorage.setItem(VIEW_STORAGE_KEY, view);
    renderInlineBoard();
  }

  function cardHtml(item) {
    const isQueue = Boolean(item.queueId);
    const action = isQueue
      ? `<button class="tf-mini" data-action="queue-start" data-id="${escapeHtml(item.queueId)}">${taskflowIcon("play")} 立即执行</button><button class="tf-mini danger" data-action="queue-delete" data-id="${escapeHtml(item.queueId)}">移除</button>`
      : item.status === "running"
        ? `<button class="tf-mini" data-action="open-thread" data-id="${escapeHtml(item.threadId)}">${taskflowIcon("arrow")} 打开对话</button>`
        : `<button class="tf-mini ${item.status === "review" ? "review" : ""}" data-action="select-item" data-id="${escapeHtml(item.id)}">${taskflowIcon("eye")} ${item.status === "review" ? "快速验收" : "查看摘要"}</button><button class="tf-mini" data-action="open-thread" data-id="${escapeHtml(item.threadId)}">${taskflowIcon("arrow")} 打开对话</button>`;
    return `<article class="tf-card${item.error ? " priority" : ""}" draggable="${item.status !== "running"}" data-item-id="${escapeHtml(item.id)}">
      <div class="tf-card-top"><div class="tf-card-labels"><span class="tf-kind ${item.kind === "聊天" ? "chat" : "task"}">${taskflowIcon(item.kind === "聊天" ? "chat" : "task")} ${escapeHtml(item.kind)}</span><span class="tf-priority ${escapeHtml(item.priority)}">${taskflowIcon("flag")} ${escapeHtml(priorityLabel(item.priority))}</span></div><span>${taskflowIcon(item.status === "running" ? "clock" : "menu")}</span></div>
      <button class="tf-title" data-action="select-item" data-id="${escapeHtml(item.id)}">${escapeHtml(item.title)}</button>
      <div class="tf-meta">${escapeHtml(item.meta)}</div>
      ${item.status === "running" ? '<div class="tf-running-state"><span class="tf-running-spinner"></span><span>Codex 正在处理中</span></div>' : ""}
      <div class="tf-card-foot"><span class="tf-ai">AI</span><div class="tf-card-actions">${action}</div></div>
    </article>`;
  }

  function resultModalHtml(item) {
    if (!item) return "";
    const queued = Boolean(item.queueId);
    return `<div class="tf-modal-backdrop" data-action="modal-backdrop"><section class="tf-modal tf-result-modal" role="dialog" aria-modal="true" aria-labelledby="tf-result-title">
      <div class="tf-modal-head"><div><p class="tf-kicker">${escapeHtml(item.kind)}</p><h2 id="tf-result-title">${escapeHtml(item.title)}</h2></div><button class="tf-close" data-action="close-modal" aria-label="关闭">${taskflowIcon("close")}</button></div>
      <div class="tf-modal-scroll"><div class="tf-modal-body"><strong>${queued ? "已加入待处理队列" : item.status === "done" ? "已确认完成" : item.status === "running" ? "Codex 正在处理" : "处理已结束，等待你验收"}</strong><p><span class="tf-priority ${escapeHtml(item.priority)}">${taskflowIcon("flag")} ${escapeHtml(priorityLabel(item.priority))}</span></p><p>${escapeHtml(item.result)}</p></div></div>
      <div class="tf-modal-actions">${queued ? `<button class="tf-secondary" data-action="queue-delete" data-id="${escapeHtml(item.queueId)}">移除</button>` : ""}<button class="tf-secondary" data-action="close-modal">关闭</button>${queued ? `<button class="tf-primary" data-action="queue-start" data-id="${escapeHtml(item.queueId)}">立即执行</button>` : `<button class="tf-secondary" data-action="open-thread" data-id="${escapeHtml(item.threadId)}">打开对话</button>`}${item.status === "review" ? `<button class="tf-primary" data-action="mark-done" data-id="${escapeHtml(item.id)}">确认并完成</button>` : ""}</div>
    </section></div>`;
  }

  function automationModalHtml(item) {
    if (!item) return "";
    return `<div class="tf-modal-backdrop" data-action="modal-backdrop"><section class="tf-modal" role="dialog" aria-modal="true" aria-labelledby="tf-automation-title">
      <div class="tf-modal-head"><div><p class="tf-kicker">Automation</p><h2 id="tf-automation-title">${escapeHtml(item.name || "未命名自动化")}</h2></div><button class="tf-close" data-action="close-modal" aria-label="关闭">${taskflowIcon("close")}</button></div>
      <div class="tf-modal-scroll"><div class="tf-modal-body"><strong>${escapeHtml(automationSchedule(item))} · 下次 ${escapeHtml(formatDateTime(item.nextRunAt))}</strong><p>${escapeHtml(item.prompt || "暂无可预览内容")}</p></div></div>
      <div class="tf-modal-actions"><button class="tf-secondary" data-action="close-modal">关闭</button><button class="tf-primary" data-action="open-scheduled">前往计划入口</button></div>
    </section></div>`;
  }

  function requestDeviceWorkspaces() {
    return new Promise((resolve, reject) => {
      const bridge = window.electronBridge;
      if (!bridge || typeof bridge.sendMessageFromView !== "function") {
        reject(new Error("当前 Codex 版本无法读取项目"));
        return;
      }
      const requestId = `taskflow-workspaces-${crypto.randomUUID()}`;
      const finish = (callback, value) => {
        window.clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        callback(value);
      };
      const onMessage = (event) => {
        const message = event.data;
        if (!message || message.type !== "fetch-response" || message.requestId !== requestId) return;
        if (!Number.isInteger(message.status) || message.status < 200 || message.status >= 300) {
          finish(reject, new Error(`项目接口返回 ${message.status || "异常"}`));
          return;
        }
        try {
          const payload = message.bodyJsonString ? JSON.parse(message.bodyJsonString) : {};
          finish(resolve, payload?.workspaces && typeof payload.workspaces === "object" ? payload.workspaces : {});
        } catch (_) {
          finish(reject, new Error("项目数据格式异常"));
        }
      };
      const timeout = window.setTimeout(
        () => finish(reject, new Error("读取项目超时")),
        8_000,
      );
      window.addEventListener("message", onMessage);
      Promise.resolve(bridge.sendMessageFromView({
        type: "fetch",
        requestId,
        method: "GET",
        url: `${resolveTaskboardUrl().origin}/api/device-workspaces`,
      })).catch((error) => finish(reject, error));
    });
  }

  async function openCreateModal() {
    inlineState.showCreate = true;
    inlineState.projectLoading = true;
    inlineState.projectLoadError = "";
    inlineState.modalFocusPending = false;
    renderInlineBoard();
    try {
      inlineState.deviceWorkspaces = await requestDeviceWorkspaces();
    } catch (error) {
      inlineState.deviceWorkspaces = {};
      inlineState.projectLoadError = error instanceof Error ? error.message : "无法读取项目";
    } finally {
      inlineState.projectLoading = false;
      inlineState.modalFocusPending = true;
      renderInlineBoard();
    }
  }

  function createModalHtml() {
    if (inlineState.projectLoading) {
      return `<div class="tf-modal-backdrop" data-action="modal-backdrop"><section class="tf-modal" role="dialog" aria-modal="true" aria-labelledby="tf-create-title">
        <div class="tf-modal-head"><div><p class="tf-kicker">Queue</p><h2 id="tf-create-title">加入待处理</h2></div><button type="button" class="tf-close" data-action="close-modal" aria-label="关闭">${taskflowIcon("close")}</button></div>
        <div class="tf-modal-scroll"><div class="tf-inline-status" role="status" aria-live="polite"><span class="tf-spinner"></span><span>正在读取 Codex 项目…</span></div></div>
      </section></div>`;
    }
    const projects = (inlineState.hostContext?.projects || []).filter((project) => (
      typeof inlineState.deviceWorkspaces?.[project.id] === "string"
      && inlineState.deviceWorkspaces[project.id].trim()
    ));
    const defaultProjectId = projects.some((project) => project.id === inlineState.hostContext?.projectId)
      ? inlineState.hostContext.projectId
      : projects[0]?.id || "";
    const hasProjects = projects.length > 0;
    return `<div class="tf-modal-backdrop" data-action="modal-backdrop"><form class="tf-modal" data-form="queue-create" role="dialog" aria-modal="true" aria-labelledby="tf-create-title">
      <div class="tf-modal-head"><div><p class="tf-kicker">Queue</p><h2 id="tf-create-title">加入待处理</h2></div><button type="button" class="tf-close" data-action="close-modal" aria-label="关闭">${taskflowIcon("close")}</button></div>
      <div class="tf-modal-scroll">
        <label class="tf-field">类型<select name="kind"><option value="聊天">聊天</option><option value="任务">任务</option></select></label>
        <label class="tf-field">名称<input name="title" required autofocus placeholder="例如：整理本周产品需求"></label>
        <label class="tf-field">优先级<select name="priority"><option value="high">高优先级</option><option value="normal" selected>普通</option><option value="low">低优先级</option></select></label>
        <label class="tf-field">交给 Codex 的内容<textarea name="prompt" required placeholder="完整写下需要 Codex 执行的事情"></textarea></label>
        <fieldset class="tf-choice-group"><legend>在哪里处理</legend>
          <label class="tf-choice"><input type="radio" name="workspaceMode" value="project" ${hasProjects ? "checked" : "disabled"}><span class="tf-choice-copy"><strong>在项目中处理</strong><small>使用所选 Codex 项目的文件和上下文</small></span></label>
          <label class="tf-choice"><input type="radio" name="workspaceMode" value="none" ${hasProjects ? "" : "checked"}><span class="tf-choice-copy"><strong>不需要项目</strong><small>适合翻译、总结、写作等通用任务</small></span></label>
        </fieldset>
        <label class="tf-field tf-project-select" ${hasProjects ? "" : "hidden"}>选择项目<select name="projectId" ${hasProjects ? "required" : "disabled"}>${projects.map((project) => `<option value="${escapeHtml(project.id)}" ${project.id === defaultProjectId ? "selected" : ""}>${escapeHtml(project.name)}</option>`).join("")}</select><small>只显示项目名称，不需要选择目录。</small></label>
        ${inlineState.projectLoadError ? `<div class="tf-modal-body" role="status">项目暂不可用（${escapeHtml(inlineState.projectLoadError)}），仍可选择“不需要项目”。</div>` : ""}
        <div class="tf-modal-body">保存后会停留在“待处理”；到达设置的间隔后，Codex 会创建真实对话并提交这段内容。</div>
      </div>
      <div class="tf-modal-actions"><button type="button" class="tf-secondary" data-action="close-modal">取消</button><button class="tf-primary" type="submit">加入队列</button></div>
    </form></div>`;
  }

  function settingsModalHtml() {
    const next = queueSettings.enabled && queueSettings.nextClaimAt
      ? new Date(queueSettings.nextClaimAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
      : "未计划";
    return `<div class="tf-modal-backdrop" data-action="modal-backdrop"><section class="tf-modal" role="dialog" aria-modal="true" aria-labelledby="tf-settings-title">
      <div class="tf-modal-head"><div><p class="tf-kicker">Taskflow</p><h2 id="tf-settings-title">看板配置</h2></div><button class="tf-close" data-action="close-modal" aria-label="关闭">${taskflowIcon("close")}</button></div>
      <div class="tf-modal-scroll">
        <div class="tf-setting-row"><div><strong>自动认领待处理</strong><p>按间隔逐个创建真实 Codex 对话；达到同时处理上限后等待。</p></div><button class="tf-switch ${queueSettings.enabled ? "on" : ""}" data-action="toggle-auto" aria-pressed="${queueSettings.enabled}"></button></div>
        <label class="tf-field">认领间隔（分钟）<input id="tf-interval" type="number" min="1" max="1440" value="${queueSettings.intervalMinutes}"><small>当前 ${queueItems.length} 项待处理 · 下次认领：${escapeHtml(next)}</small></label>
        <label class="tf-field">同时处理任务数<input id="tf-concurrency" type="number" min="1" max="10" value="${queueSettings.maxConcurrent}"><small>自动认领最多允许 1–10 个任务同时处于“正在处理”，默认 5。</small></label>
        <div class="tf-modal-body">“确认完成”只保存在这台设备，不会暂停、删除或修改自动化计划。</div>
      </div>
      <div class="tf-modal-actions"><button class="tf-secondary" data-action="claim-next" ${queueItems.length ? "" : "disabled"}>立即认领下一项</button><button class="tf-primary" data-action="save-queue-settings">保存设置</button></div>
    </section></div>`;
  }

  function automationBoardHtml() {
    const keyword = inlineState.query.trim().toLowerCase();
    const items = inlineState.automations.filter((item) => !keyword
      || `${item.name || ""}\n${item.prompt || ""}`.toLowerCase().includes(keyword));
    let content = "";
    if (inlineState.automationsLoading) content = '<div class="tf-empty">正在读取计划任务…</div>';
    else if (inlineState.automationsError) content = `<div class="tf-empty">${escapeHtml(inlineState.automationsError)}<button class="tf-secondary" data-action="refresh-account">重新读取</button></div>`;
    else if (!items.length) content = '<div class="tf-empty">还没有计划任务<br>在 Codex「已安排」中创建的计划会显示在这里。</div>';
    else content = items.map((item) => `<article class="tf-auto-item"><div class="tf-card-top"><strong>${escapeHtml(item.status === "ACTIVE" ? "运行中" : item.status === "PAUSED" ? "已暂停" : item.status || "计划中")}</strong><span class="tf-meta">${escapeHtml(automationSchedule(item))}</span></div><h3>${escapeHtml(item.name || "未命名自动化")}</h3><p>${escapeHtml(item.prompt || "暂无可预览内容")}</p><div class="tf-auto-meta"><span>${escapeHtml(item.model || "Codex")}${item.reasoningEffort ? ` · ${escapeHtml(item.reasoningEffort)}` : ""}</span><span>下次：${escapeHtml(formatDateTime(item.nextRunAt))}</span></div><div class="tf-card-actions"><button class="tf-secondary" data-action="preview-automation" data-id="${escapeHtml(item.id)}">预览内容</button><button class="tf-primary" data-action="open-scheduled">打开计划</button></div></article>`).join("");
    return `<section class="tf-automation"><div class="tf-automation-head"><div><strong>计划任务</strong><div class="tf-meta">当前 Codex 已创建的自动化计划</div></div><button class="tf-secondary" data-action="open-scheduled">${taskflowIcon("arrow")} 前往「已安排」</button></div><div class="tf-automation-list">${content}</div></section>`;
  }

  function captureInlineScroll(excludedItemId = "") {
    if (!frame) return null;
    const board = frame.querySelector(".tf-board");
    const columns = {};
    frame.querySelectorAll(".tf-column[data-status]").forEach((column) => {
      const list = column.querySelector(".tf-card-list");
      if (!list) return;
      const listRect = list.getBoundingClientRect();
      const cards = Array.from(list.querySelectorAll("[data-item-id]"));
      const anchor = cards.find((card) => card.dataset.itemId !== excludedItemId
        && card.getBoundingClientRect().bottom > listRect.top);
      columns[column.dataset.status] = {
        scrollTop: list.scrollTop,
        anchorId: anchor?.dataset.itemId || "",
        anchorOffset: anchor ? anchor.getBoundingClientRect().top - listRect.top : 0,
      };
    });
    return { boardLeft: board?.scrollLeft || 0, columns };
  }

  function restoreInlineScroll(snapshot) {
    if (!snapshot || !frame) return;
    const board = frame.querySelector(".tf-board");
    if (board) board.scrollLeft = snapshot.boardLeft;
    Object.entries(snapshot.columns).forEach(([statusKey, position]) => {
      const list = frame.querySelector(`.tf-column[data-status="${statusKey}"] .tf-card-list`);
      if (!list) return;
      list.scrollTop = position.scrollTop;
      if (!position.anchorId) return;
      const anchor = Array.from(list.querySelectorAll("[data-item-id]"))
        .find((card) => card.dataset.itemId === position.anchorId);
      if (!anchor) return;
      list.scrollTop += anchor.getBoundingClientRect().top
        - list.getBoundingClientRect().top
        - position.anchorOffset;
    });
  }

  function renderInlineBoard() {
    if (!frame?.isConnected || frame.dataset.renderMode !== "native") return;
    const scrollSnapshot = captureInlineScroll(pendingScrollExcludedItemId);
    const activeModalControl = frame.querySelector(".tf-modal")?.contains(document.activeElement)
      ? {
          name: document.activeElement?.getAttribute?.("name") || "",
          action: document.activeElement?.getAttribute?.("data-action") || "",
        }
      : null;
    pendingScrollExcludedItemId = "";
    const items = inlineItems();
    const retainedItems = items.filter((item) => item.status !== "done"
      || item.updatedAt * 1000 >= Date.now() - COMPLETED_RETENTION_MS);
    const keyword = inlineState.query.trim().toLowerCase();
    const visible = retainedItems.filter((item) => (
      (!keyword || item.title.toLowerCase().includes(keyword))
      && (inlineState.view === "all"
        || (inlineState.view === "chats" && item.kind === "聊天")
        || (inlineState.view === "tasks" && item.kind === "任务"))
    ));
    const statuses = [
      ["queued", "待处理", "Codex 中暂无等待启动的任务"],
      ["running", "正在处理", "当前没有运行中的任务"],
      ["review", "待验收", "当前没有待验收结果"],
      ["done", "已完成", "还没有确认完成的任务"],
    ];
    const counts = Object.fromEntries(statuses.map(([key]) => [key, retainedItems.filter((item) => item.status === key).length]));
    const unread = retainedItems.filter((item) => item.status === "review" && item.updatedAt * 1000 > inlineState.noticeReadAt).length;
    const notices = retainedItems.filter((item) => item.status === "review").slice(0, 20);
    const quota = rateLimitSummary(inlineState.rateLimits);
    const accountName = inlineState.hostContext?.user?.name || "当前账号";
    const selectedItem = items.find((item) => item.id === inlineState.selectedId);
    const selected = selectedItem ? {
      ...selectedItem,
      result: inlineState.selectedResultLoading
        ? "正在读取最后一次回复…"
        : inlineState.selectedResult || selectedItem.result,
    } : null;
    const selectedAutomation = inlineState.automations.find((item) => item.id === inlineState.selectedAutomationId);
    const tabs = [["all", "全部", ""], ["chats", "聊天", "chat"], ["tasks", "任务", "task"], ["automations", "自动化", "clock"]]
      .map(([key, label, icon]) => `<button role="tab" aria-selected="${inlineState.view === key}" data-action="view" data-view="${key}" class="${inlineState.view === key ? "active" : ""}">${icon ? taskflowIcon(icon) : ""}${label}</button>`).join("");
    const summary = inlineState.view === "automations" ? "" : `<section class="tf-summary-row" aria-label="状态概览">
      <div class="tf-summary"><span class="tf-summary-icon queued">${taskflowIcon("clock")}</span><div><b>${counts.queued}</b><small>待处理</small></div></div>
      <div class="tf-summary"><span class="tf-summary-icon running">${taskflowIcon("refresh")}</span><div><b>${counts.running}</b><small>正在处理</small></div></div>
      <button class="tf-summary" data-action="focus-review"><span class="tf-summary-icon review">${taskflowIcon("warning")}</span><div><b>${counts.review}</b><small>等待你验收</small></div></button>
      <div class="tf-summary"><span class="tf-summary-icon done">${taskflowIcon("check")}</span><div><b>${counts.done}</b><small>已确认完成</small></div></div>
      <div class="tf-sync ${inlineState.error ? "" : "ok"}">${inlineState.loading ? "正在同步账号数据" : inlineState.error ? "同步失败" : "真实数据已连接"}${inlineState.lastSyncedAt ? ` · ${new Date(inlineState.lastSyncedAt).toLocaleTimeString("zh-CN")}` : ""}</div>
    </section>`;
    const board = inlineState.view === "automations" ? automationBoardHtml() : `<main class="tf-board" aria-label="任务状态看板">${statuses.map(([key, title, empty]) => {
      const cards = visible.filter((item) => item.status === key);
      const headingId = `tf-column-${key}`;
      return `<section class="tf-column ${key}" data-status="${key}" aria-labelledby="${headingId}"><div class="tf-column-head"><span class="tf-dot ${key}"></span><strong id="${headingId}">${title}</strong><span class="tf-count" aria-label="${cards.length} 项">${cards.length}</span></div><div class="tf-card-list">${cards.length ? cards.map(cardHtml).join("") : `<div class="tf-empty" role="status">${keyword ? "没有匹配结果" : empty}</div>`}</div>${key === "queued" ? `<button class="tf-add" data-action="show-create">${taskflowIcon("plus")} 加入待处理</button>` : ""}</section>`;
    }).join("")}</main>`;
    const noticePanel = inlineState.showNotices ? `<section class="tf-notice" aria-label="待验收提醒"><div class="tf-notice-head"><strong>待验收提醒</strong><button class="tf-mini" data-action="mark-read" ${unread ? "" : "disabled"}>${unread ? "全部已读" : "已全部读"}</button></div><div class="tf-notice-list">${notices.length ? notices.map((item) => `<button class="tf-notice-item" data-action="select-item" data-id="${escapeHtml(item.id)}"><span>“${escapeHtml(item.title)}”已停止运行，等待你验收</span><small>${escapeHtml(relativeTime(item.updatedAt))}</small></button>`).join("") : '<div class="tf-empty" role="status">暂无待验收任务</div>'}</div></section>` : "";
    const loadingOverlay = inlineState.refreshing ? `<div class="tf-loading-overlay" role="status" aria-live="polite"><div class="tf-loading-content"><span class="tf-spinner"></span><strong>正在刷新数据</strong><small>正在同步任务、自动化、额度和待处理队列…</small></div></div>` : "";
    frame.innerHTML = `<div class="tf-shell"><header class="tf-topbar"><div class="tf-top-left">${inlineState.hostContext?.sidebarCollapsed ? `<button class="tf-expand" data-action="expand-sidebar">${taskflowIcon("menu")} 展开侧边栏</button>` : ""}<nav class="tf-tabs" role="tablist" aria-label="内容类型">${tabs}</nav></div><div class="tf-actions"><label class="tf-search">${taskflowIcon("search")}<input data-role="search" aria-label="${inlineState.view === "automations" ? "搜索自动化" : "搜索任务或聊天"}" value="${escapeHtml(inlineState.query)}" placeholder="${inlineState.view === "automations" ? "搜索自动化" : "搜索任务或聊天"}">${inlineState.query ? `<button data-action="clear-search" aria-label="清除搜索">${taskflowIcon("close")}</button>` : ""}</label><button class="tf-secondary" data-action="new-thread">${taskflowIcon("plus")} 立即新建</button><button class="tf-secondary tf-refresh-button ${inlineState.refreshing ? "loading" : ""}" data-action="refresh-data" title="刷新任务、自动化、额度和待处理队列" ${inlineState.refreshing ? "disabled" : ""}>${taskflowIcon("refresh")} ${inlineState.refreshing ? "刷新中" : "刷新数据"}</button><button class="tf-icon-button" data-action="toggle-notices" aria-label="通知" aria-expanded="${inlineState.showNotices}">${taskflowIcon("bell")}${unread ? `<span class="tf-badge">${Math.min(unread, 99)}</span>` : ""}</button><div class="tf-account"><div class="tf-account-chip" title="${escapeHtml(`${accountName} · ${quota.quota}${quota.reset ? ` · ${quota.reset}` : ""}`)}"><span class="tf-avatar">${escapeHtml(accountName.slice(0, 1).toUpperCase())}</span><span class="tf-account-copy"><small>${escapeHtml(`${quota.plan} · ${quota.quota}`)}</small>${quota.reset ? `<small>${escapeHtml(quota.reset)}</small>` : ""}</span></div><button class="tf-icon-button" data-action="show-settings" aria-label="看板配置">${taskflowIcon("settings")}</button></div></div></header>${summary}${inlineState.error ? `<div class="tf-message error" role="alert">${taskflowIcon("warning")} ${escapeHtml(inlineState.error)} <button class="tf-mini" data-action="refresh-data">重新连接</button></div>` : inlineState.loading ? `<div class="tf-message" role="status">${taskflowIcon("refresh")} 正在读取当前账号的 Codex 任务…</div>` : ""}${board}</div>${noticePanel}${selected ? resultModalHtml(selected) : ""}${selectedAutomation ? automationModalHtml(selectedAutomation) : ""}${inlineState.showCreate ? createModalHtml() : ""}${inlineState.showSettings ? settingsModalHtml() : ""}${loadingOverlay}${inlineState.toast ? `<div class="tf-toast" role="status" aria-live="polite">${taskflowIcon("check")} ${escapeHtml(inlineState.toast)}</div>` : ""}`;
    restoreInlineScroll(scrollSnapshot);
    const modal = frame.querySelector('.tf-modal[role="dialog"]');
    if (modal) {
      const restoredControl = activeModalControl?.name
        ? modal.querySelector(`[name="${CSS.escape(activeModalControl.name)}"]`)
        : activeModalControl?.action
          ? modal.querySelector(`[data-action="${CSS.escape(activeModalControl.action)}"]`)
          : null;
      const defaultFocus = modal.querySelector("[autofocus]")
        || modal.querySelector("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)");
      const nextFocus = inlineState.modalFocusPending ? defaultFocus : restoredControl || defaultFocus;
      if (inlineState.modalFocusPending || document.activeElement === document.body) nextFocus?.focus?.();
    }
    inlineState.modalFocusPending = false;
  }

  function handleInlineBoardMessage(message) {
    if (!message || typeof message !== "object") return;
    let changed = false;
    if (message.type === "taskboard:theme") {
      if (frame) frame.dataset.theme = message.theme === "dark" ? "dark" : "light";
      return;
    } else if (message.type === "taskboard:host-context") {
      const next = message.payload || null;
      const visibleContext = (value) => JSON.stringify({
        name: value?.user?.name || "",
        workspacePath: value?.workspacePath || "",
        projectId: value?.projectId || "",
        projects: value?.projects || [],
        sidebarCollapsed: value?.sidebarCollapsed === true,
      });
      changed = visibleContext(next) !== visibleContext(inlineState.hostContext);
      inlineState.hostContext = next;
      if (frame) frame.dataset.theme = next?.theme === "dark" ? "dark" : "light";
    } else if (message.type === "taskflow:queue-state") {
      const nextItems = normalizeQueueItems(message.payload?.items || []);
      const nextSettings = normalizeQueueSettings(message.payload?.settings || {});
      nextSettings.busy = message.payload?.settings?.busy === true;
      changed = JSON.stringify([nextItems, nextSettings]) !== JSON.stringify([queueItems, queueSettings]);
      queueItems = nextItems;
      queueSettings = nextSettings;
    } else if (message.type === "taskflow:threads-response") {
      if (message.payload?.requestId !== inlineState.threadRequestId) return;
      const refreshFinished = finishInlineRefresh(message.payload?.requestId);
      const nextLoading = false;
      const nextError = message.payload?.ok ? "" : message.payload?.error || "无法读取 Codex 账号任务";
      const nextThreads = message.payload?.ok && Array.isArray(message.payload?.threads) ? message.payload.threads : [];
      const threadSignature = (threads) => JSON.stringify(threads.map((thread) => [
        thread?.id,
        thread?.name,
        thread?.preview,
        thread?.cwd,
        thread?.updatedAt,
        thread?.status?.type,
        thread?.threadSource,
      ]));
      changed = refreshFinished
        || inlineState.loading !== nextLoading
        || inlineState.error !== nextError
        || threadSignature(inlineState.threads) !== threadSignature(nextThreads);
      inlineState.loading = false;
      inlineState.error = nextError;
      inlineState.threads = nextThreads;
      if (message.payload?.ok) inlineState.lastSyncedAt = Date.now();
    } else if (message.type === "taskflow:automations-response") {
      if (message.payload?.requestId !== inlineState.automationRequestId) return;
      const refreshFinished = finishInlineRefresh(message.payload?.requestId);
      const nextError = message.payload?.ok ? "" : message.payload?.error || "无法读取计划任务";
      const nextItems = message.payload?.ok && Array.isArray(message.payload?.items) ? message.payload.items : [];
      changed = refreshFinished
        || inlineState.automationsLoading
        || inlineState.automationsError !== nextError
        || JSON.stringify(inlineState.automations) !== JSON.stringify(nextItems);
      inlineState.automationsLoading = false;
      inlineState.automationsError = nextError;
      inlineState.automations = nextItems;
    } else if (message.type === "taskflow:quota-response") {
      if (message.payload?.requestId !== inlineState.quotaRequestId) return;
      const refreshFinished = finishInlineRefresh(message.payload?.requestId);
      changed = refreshFinished;
      if (message.payload?.ok) {
        const next = message.payload?.result || null;
        changed = changed || JSON.stringify(inlineState.rateLimits) !== JSON.stringify(next);
        inlineState.rateLimits = next;
      }
    } else return;
    if (changed) renderInlineBoard();
  }

  function postToFrame(message) {
    if (frame?.dataset?.renderMode === "native") {
      handleInlineBoardMessage(message);
      return;
    }
    if (!frame?.contentWindow || !frameOrigin) return;
    frame.contentWindow.postMessage(message, frameOrigin);
  }

  function dispatchHostMessage(message) {
    window.postMessage(message, window.location.origin);
  }

  function postHostContext() {
    if (!frame) return;
    const liveContext = readHostContext();
    const payload = hostContextSnapshot
      ? {
          ...hostContextSnapshot,
          ...liveContext,
          projects: liveContext.projects.length > 0
            ? liveContext.projects
            : hostContextSnapshot.projects,
        }
      : liveContext;
    postToFrame({ type: "taskboard:host-context", payload });
    postToFrame({ type: "taskboard:theme", theme: payload.theme });
  }

  function findThreadRow(threadId) {
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-thread-id]"))
      .find((row) => normalizeThreadId(row.getAttribute("data-app-action-sidebar-thread-id")) === normalizeThreadId(threadId)) || null;
  }

  function routeForThread(threadId) {
    return `/local/${encodeURIComponent(threadId)}`;
  }

  async function openThread(threadId) {
    if (typeof threadId !== "string" || !threadId.trim()) return;
    const normalizedThreadId = normalizeThreadId(threadId);
    lastNativeThreadId = normalizedThreadId;
    const row = findThreadRow(normalizedThreadId);
    closeTaskboard(false);

    if (row?.isConnected) {
      row.click?.();
      return;
    }

    try {
      await dispatchHostMessage({
        type: "navigate-to-route",
        path: routeForThread(normalizedThreadId),
      });
    } catch (_) {}
  }

  function projectRowById(projectId) {
    if (typeof projectId !== "string" || !projectId.trim()) return null;
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-project-row]"))
      .find((row) => row.getAttribute("data-app-action-sidebar-project-id") === projectId.trim()) || null;
  }

  function projectRowByLabel(label) {
    if (typeof label !== "string" || !label.trim()) return null;
    const expected = normalizedLabel(label);
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-project-row]"))
      .find((row) => normalizedLabel(row.getAttribute("data-app-action-sidebar-project-label")) === expected) || null;
  }

  async function ensureProjectRows() {
    let section = findProjectsSection();
    const deadline = Date.now() + 1_200;
    while (!section && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 40));
      section = findProjectsSection();
    }
    if (section?.getAttribute("data-app-action-sidebar-section-collapsed") === "true") {
      section.querySelector("[data-app-action-sidebar-section-toggle]")?.click();
    }
    while (readCodexProjects().length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 40));
    }
  }

  async function waitForPreparedComposer(identifier, skillPath) {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const editor = document.querySelector('[data-codex-composer="true"][contenteditable="true"]');
      if (editor && editor.getClientRects().length > 0) {
        const containsIdentifier = normalizedLabel(editor.textContent).includes(normalizedLabel(identifier));
        const skillMention = Array.from(editor.querySelectorAll("[skill-mention-name]"))
          .find((mention) => (
            mention.getAttribute("skill-mention-name") === "manage-taskboard"
            && mention.getAttribute("skill-mention-path") === skillPath
          ));
        if (containsIdentifier && skillMention) return editor;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 80));
    }
    throw new Error("Codex 对话输入框没有生成 manage-taskboard Skill 引用");
  }

  async function createThreadForTask(payload) {
    const taskId = typeof payload?.taskId === "string" ? payload.taskId.trim() : "";
    const identifier = typeof payload?.identifier === "string" ? payload.identifier.trim() : "";
    const instruction = typeof payload?.instruction === "string" ? payload.instruction.trim() : "";
    const skillName = typeof payload?.skillName === "string" ? payload.skillName.trim() : "";
    const skillDisplayName = typeof payload?.skillDisplayName === "string"
      ? payload.skillDisplayName.trim()
      : "";
    const skillPath = typeof payload?.skillPath === "string" ? payload.skillPath.trim() : "";
    const workspacePath = typeof payload?.workspacePath === "string"
      ? payload.workspacePath.trim()
      : "";
    if (
      !taskId
      || !identifier
      || !instruction
      || !skillName
      || !skillDisplayName
      || !skillPath
      || pendingThreadCreation
    ) return;
    pendingThreadCreation = taskId;
    try {
      const bridge = window.electronBridge;
      if (!bridge || typeof bridge.sendMessageFromView !== "function") {
        throw new Error("当前 Codex 版本没有提供原生对话导航能力");
      }

      if (workspacePath) {
        await bridge.sendMessageFromView({
          type: "electron-set-active-workspace-root",
          root: workspacePath,
        });
      } else {
        await ensureProjectRows();
        const snapshotProjectId = hostContextSnapshot?.projectId || "";
        const requestedProjectId = typeof payload.codexProjectId === "string"
          ? payload.codexProjectId.trim()
          : "";
        const row = projectRowByLabel(payload.workspaceLabel)
          || projectRowById(requestedProjectId)
          || projectRowById(snapshotProjectId)
          || projectRowByLabel(payload.projectName);
        if (row?.getAttribute("data-app-action-sidebar-project-collapsed") === "true") {
          row.click?.();
          await new Promise((resolve) => window.setTimeout(resolve, 120));
        }
        const selectProject = row?.querySelector("[data-app-action-sidebar-select-project]");
        selectProject?.click?.();
        if (selectProject) await new Promise((resolve) => window.setTimeout(resolve, 120));
      }

      closeTaskboard(false);
      await dispatchHostMessage({
        type: "navigate-to-route",
        path: "/",
        state: {
          focusComposerNonce: Date.now(),
        },
      });
      await requestHostTaskComposerPrefill({
        instruction,
        skillDisplayName,
        skillName,
        skillPath,
      });
      await waitForPreparedComposer(identifier, skillPath);
      postToFrame({ type: "taskboard:thread-prepared", payload: { taskId } });
    } catch (error) {
      postToFrame({
        type: "taskboard:thread-create-error",
        payload: { taskId, error: error instanceof Error ? error.message : "无法创建 Codex 对话" },
      });
    } finally {
      pendingThreadCreation = null;
    }
  }

  function buildAutomationHostPayload(payload) {
    return {
      requestId: payload.requestId,
      operation: payload.operation,
      taskboardProjectId: payload.taskboardProjectId,
      codexProjectId: payload.codexProjectId,
      projectName: payload.projectName,
      workspacePath: payload.workspacePath,
      skillPath: payload.skillPath,
      ...(payload.automationId === undefined ? {} : { automationId: payload.automationId }),
      enabledByUser: payload.enabledByUser,
      quotaAware: payload.quotaAware,
      intervalMinutes: payload.intervalMinutes,
      model: payload.model,
      reasoningEffort: payload.reasoningEffort,
    };
  }

  async function handleAutomationRequest(payload) {
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : "";
    if (!requestId) return;
    if (frame?.dataset?.renderMode !== "native" && !isLocalTaskboardOrigin(frameOrigin)) {
      postToFrame({
        type: "taskboard:automation-response",
        payload: { requestId, ok: false, error: "仅本地任务面板可用" },
      });
      return;
    }
    try {
      const response = await requestHost(
        "automation",
        buildAutomationHostPayload(payload),
      );
      postToFrame({
        type: "taskboard:automation-response",
        payload: response.error
          ? { requestId, ok: false, error: response.error }
          : {
              requestId,
              ok: true,
              item: response.item,
              items: response.items,
              quota: response.quota,
              policy: response.policy,
            },
      });
    } catch (error) {
      postToFrame({
        type: "taskboard:automation-response",
        payload: {
          requestId,
          ok: false,
          error: error instanceof Error ? error.message : "Codex 自动任务操作失败",
        },
      });
    }
  }

  function requestCodexAppServer(method, params) {
    return new Promise((resolve, reject) => {
      const bridge = window.electronBridge;
      if (!bridge || typeof bridge.sendMessageFromView !== "function") {
        reject(new Error("当前 Codex 版本没有提供账号任务读取能力"));
        return;
      }
      const id = `taskflow-${crypto.randomUUID()}`;
      const finish = (callback, value) => {
        window.clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        callback(value);
      };
      const onMessage = (event) => {
        const response = event.data;
        if (
          !response
          || response.type !== "mcp-response"
          || response.hostId !== "local"
          || String(response.message?.id) !== id
        ) return;
        if (response.message?.error) {
          finish(reject, new Error(response.message.error.message || `Codex 拒绝了 ${method}`));
          return;
        }
        finish(resolve, response.message?.result);
      };
      const timeout = window.setTimeout(
        () => finish(reject, new Error("读取 Codex 账号任务超时")),
        30_000,
      );
      window.addEventListener("message", onMessage);
      Promise.resolve(bridge.sendMessageFromView({
        type: "mcp-request",
        request: { id, method, params },
        hostId: "local",
        priority: "critical",
        source: method.startsWith("turn/") ? "turn" : "thread",
        timeoutMs: 30_000,
        expiresAtMs: Date.now() + 30_000,
      })).catch((error) => finish(reject, error));
    });
  }

  function requestCodexAutomationList() {
    return new Promise((resolve, reject) => {
      const bridge = window.electronBridge;
      if (!bridge || typeof bridge.sendMessageFromView !== "function") {
        reject(new Error("当前 Codex 版本没有提供原生计划任务能力"));
        return;
      }
      const requestId = `taskflow-automations-${crypto.randomUUID()}`;
      const finish = (callback, value) => {
        window.clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        callback(value);
      };
      const onMessage = (event) => {
        const message = event.data;
        if (!message || message.type !== "fetch-response" || message.requestId !== requestId) return;
        if (!Number.isInteger(message.status) || message.status < 200 || message.status >= 300) {
          finish(reject, new Error(`Codex 计划任务接口返回 ${message.status || "异常"}`));
          return;
        }
        try {
          finish(resolve, message.bodyJsonString ? JSON.parse(message.bodyJsonString) : {});
        } catch (_) {
          finish(reject, new Error("Codex 计划任务数据格式异常"));
        }
      };
      const timeout = window.setTimeout(
        () => finish(reject, new Error("读取 Codex 计划任务超时")),
        15_000,
      );
      window.addEventListener("message", onMessage);
      Promise.resolve(bridge.sendMessageFromView({
        type: "fetch",
        requestId,
        method: "POST",
        url: "vscode://codex/list-automations",
        body: "{}",
      })).catch((error) => finish(reject, error));
    });
  }

  async function listCodexThreads() {
    const threads = [];
    let cursor = null;
    for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
      const result = await requestCodexAppServer("thread/list", {
        archived: false,
        cursor,
        limit: 100,
        sortKey: "updated_at",
        sortDirection: "desc",
      });
      if (Array.isArray(result?.data)) threads.push(...result.data);
      cursor = typeof result?.nextCursor === "string" && result.nextCursor
        ? result.nextCursor
        : null;
      if (!cursor) break;
    }
    return threads;
  }

  function scheduleNextClaim(from = Date.now()) {
    queueSettings.nextClaimAt = queueSettings.enabled && queueItems.length > 0
      ? from + queueSettings.intervalMinutes * 60_000
      : 0;
  }

  function addQueueItem(payload) {
    const title = typeof payload?.title === "string" ? payload.title.trim() : "";
    const prompt = typeof payload?.prompt === "string" ? payload.prompt.trim() : "";
    const cwd = typeof payload?.cwd === "string" ? payload.cwd.trim() : "";
    const workspaceMode = payload?.workspaceMode === "none" ? "none" : "project";
    if (!title || !prompt || (workspaceMode === "project" && !cwd)) return;
    queueItems.push({
      id: crypto.randomUUID(),
      kind: payload.kind === "任务" ? "任务" : "聊天",
      title,
      prompt,
      cwd,
      workspaceMode,
      projectId: typeof payload?.projectId === "string" ? payload.projectId.trim() : "",
      projectName: typeof payload?.projectName === "string" ? payload.projectName.trim() : "",
      priority: normalizePriority(payload.priority),
      createdAt: Date.now(),
      status: "queued",
    });
    if (queueSettings.enabled && !queueSettings.nextClaimAt) scheduleNextClaim();
    persistQueue();
    postQueueState();
  }

  function deleteQueueItem(payload) {
    const id = typeof payload?.id === "string" ? payload.id.trim() : "";
    if (!id) return;
    queueItems = queueItems.filter((item) => item.id !== id);
    if (queueItems.length === 0) queueSettings.nextClaimAt = 0;
    persistQueue();
    postQueueState();
  }

  function updateQueueSettings(payload) {
    const wasEnabled = queueSettings.enabled;
    if (typeof payload?.enabled === "boolean") queueSettings.enabled = payload.enabled;
    if (payload?.intervalMinutes !== undefined) {
      queueSettings.intervalMinutes = Math.max(1, Math.min(1440, Math.round(Number(payload.intervalMinutes) || 5)));
    }
    if (payload?.maxConcurrent !== undefined) {
      queueSettings.maxConcurrent = Math.max(1, Math.min(10, Math.round(Number(payload.maxConcurrent) || 5)));
    }
    if (!queueSettings.enabled) {
      queueSettings.nextClaimAt = 0;
    } else if (!wasEnabled || payload?.intervalMinutes !== undefined || !queueSettings.nextClaimAt) {
      scheduleNextClaim();
    }
    persistQueue();
    postQueueState();
  }

  async function claimQueueItem(id, options = {}) {
    if (queueRunning) return false;
    const index = id
      ? queueItems.findIndex((item) => item.id === id)
      : queueItems.findIndex((item) => item.status !== "starting");
    if (index < 0) return false;
    const item = queueItems[index];
    queueRunning = true;
    item.status = "starting";
    delete item.lastError;
    persistQueue();
    postQueueState();
    try {
      if (!options.ignoreActive) {
        const threads = await listCodexThreads();
        const activeCount = threads.filter((thread) => thread?.status?.type === "active").length;
        if (activeCount >= queueSettings.maxConcurrent) {
          item.status = "queued";
          persistQueue();
          return false;
        }
      }

      let threadId = item.startedThreadId;
      if (!threadId) {
        const startResult = await requestCodexAppServer("thread/start", {
          cwd: item.workspaceMode === "none" ? null : item.cwd,
        });
        threadId = startResult?.thread?.id;
        if (!threadId) throw new Error("Codex 已创建对话，但没有返回对话编号");
        item.startedThreadId = threadId;
        persistQueue();
      }
      await requestCodexAppServer("thread/name/set", { threadId, name: item.title });
      await requestCodexAppServer("turn/start", {
        threadId,
        input: [{ type: "text", text: item.prompt, text_elements: [] }],
      });
      threadPriorities[threadId] = normalizePriority(item.priority);
      persistThreadPriorities();
      queueItems = queueItems.filter((entry) => entry.id !== item.id);
      queueSettings.lastClaimAt = Date.now();
      scheduleNextClaim(queueSettings.lastClaimAt);
      persistQueue();
      postQueueState();
      return true;
    } catch (error) {
      item.status = "failed";
      item.lastError = error instanceof Error ? error.message : "Codex 无法开始执行";
      persistQueue();
      postQueueState();
      return false;
    } finally {
      queueRunning = false;
      postQueueState();
    }
  }

  async function queueTick() {
    if (
      destroyed
      || queueRunning
      || !queueSettings.enabled
      || queueItems.length === 0
    ) return;
    if (!queueSettings.nextClaimAt) {
      scheduleNextClaim();
      persistQueue();
      postQueueState();
      return;
    }
    if (Date.now() < queueSettings.nextClaimAt) return;
    await claimQueueItem(null, { ignoreActive: false });
  }

  function startQueueScheduler() {
    if (queueTimer !== null) return;
    if (queueSettings.enabled && queueItems.length > 0 && !queueSettings.nextClaimAt) {
      scheduleNextClaim();
      persistQueue();
    }
    queueTimer = window.setInterval(() => void queueTick(), QUEUE_TICK_MS);
    void queueTick();
  }

  async function handleThreadsRequest(payload) {
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : "";
    if (!requestId) return;
    try {
      const threads = await listCodexThreads();
      postToFrame({
        type: "taskflow:threads-response",
        payload: { requestId, ok: true, threads },
      });
    } catch (error) {
      postToFrame({
        type: "taskflow:threads-response",
        payload: {
          requestId,
          ok: false,
          error: error instanceof Error ? error.message : "无法读取 Codex 账号任务",
        },
      });
    }
  }

  async function handleAutomationsRequest(payload) {
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : "";
    if (!requestId) return;
    try {
      const result = await requestCodexAutomationList();
      const items = Array.isArray(result?.items)
        ? result.items
        : Array.isArray(result?.automations)
          ? result.automations
          : [];
      postToFrame({ type: "taskflow:automations-response", payload: { requestId, ok: true, items } });
    } catch (error) {
      postToFrame({
        type: "taskflow:automations-response",
        payload: { requestId, ok: false, error: error instanceof Error ? error.message : "无法读取 Codex 计划任务" },
      });
    }
  }

  async function handleQuotaRequest(payload) {
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : "";
    if (!requestId) return;
    try {
      const result = await requestCodexAppServer("account/rateLimits/read", {});
      postToFrame({ type: "taskflow:quota-response", payload: { requestId, ok: true, result } });
    } catch (error) {
      postToFrame({
        type: "taskflow:quota-response",
        payload: { requestId, ok: false, error: error instanceof Error ? error.message : "无法读取 Codex 账号额度" },
      });
    }
  }

  function openNativeScheduled() {
    const scheduled = Array.from(document.querySelectorAll("[data-app-action-sidebar-scroll] button"))
      .find((node) => ["已安排", "scheduled"].includes(normalizedLabel(node.textContent || node.getAttribute("aria-label"))));
    closeTaskboard(false);
    scheduled?.click?.();
  }

  function openNewCodexThread() {
    closeTaskboard(false);
    void dispatchHostMessage({
      type: "navigate-to-route",
      path: "/",
      state: { focusComposerNonce: Date.now() },
    });
  }

  function onFrameMessage(event) {
    if (!frame || event.source !== frame.contentWindow || event.origin !== frameOrigin) return;
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.type === "taskboard:ready") {
      frameReady = true;
      frameReadyWaiters.forEach(({ resolve, timer }) => {
        window.clearTimeout(timer);
        resolve();
      });
      frameReadyWaiters.clear();
      if (active) showFrame();
      postHostContext();
      postQueueState();
      return;
    }
    if (message.type === "taskboard:drag-region") {
      updateDragRegion(message.payload);
      return;
    }
    if (message.type === "taskboard:open-thread") {
      void openThread(message.payload?.threadId);
      return;
    }
    if (message.type === "taskboard:expand-sidebar") {
      expandNativeSidebar();
      return;
    }
    if (message.type === "taskboard:automation-request") {
      void handleAutomationRequest(message.payload);
      return;
    }
    if (message.type === "taskflow:threads-request") {
      void handleThreadsRequest(message.payload);
      return;
    }
    if (message.type === "taskflow:automations-request") {
      void handleAutomationsRequest(message.payload);
      return;
    }
    if (message.type === "taskflow:quota-request") {
      void handleQuotaRequest(message.payload);
      return;
    }
    if (message.type === "taskflow:open-scheduled") {
      openNativeScheduled();
      return;
    }
    if (message.type === "taskflow:queue-request") {
      postQueueState();
      return;
    }
    if (message.type === "taskflow:queue-add") {
      addQueueItem(message.payload);
      return;
    }
    if (message.type === "taskflow:queue-delete") {
      deleteQueueItem(message.payload);
      return;
    }
    if (message.type === "taskflow:queue-settings") {
      updateQueueSettings(message.payload);
      return;
    }
    if (message.type === "taskflow:queue-start-now") {
      void claimQueueItem(message.payload?.id, { ignoreActive: true });
      return;
    }
    if (message.type === "taskflow:queue-claim-next") {
      void claimQueueItem(null, { ignoreActive: false });
      return;
    }
    if (message.type === "taskflow:new-thread") {
      openNewCodexThread();
      return;
    }
    if (message.type === "taskboard:create-thread") void createThreadForTask(message.payload);
  }

  function finishInlineRefresh(requestId) {
    if (!inlineState.refreshRequestIds.delete(requestId)) return false;
    if (inlineState.refreshRequestIds.size > 0) return false;
    inlineState.refreshing = false;
    return true;
  }

  function refreshInlineThreads(options = {}) {
    if (inlineState.refreshing && !options.track) return;
    const requestId = `inline-threads-${crypto.randomUUID()}`;
    inlineState.threadRequestId = requestId;
    if (options.track) inlineState.refreshRequestIds.add(requestId);
    void handleThreadsRequest({ requestId });
  }

  function refreshInlineAccount(options = {}) {
    if (inlineState.refreshing && !options.track) return;
    const automationRequestId = `inline-automations-${crypto.randomUUID()}`;
    const quotaRequestId = `inline-quota-${crypto.randomUUID()}`;
    inlineState.automationRequestId = automationRequestId;
    inlineState.quotaRequestId = quotaRequestId;
    inlineState.automationsLoading = true;
    if (options.track) {
      inlineState.refreshRequestIds.add(automationRequestId);
      inlineState.refreshRequestIds.add(quotaRequestId);
    }
    void handleAutomationsRequest({ requestId: automationRequestId });
    void handleQuotaRequest({ requestId: quotaRequestId });
  }

  function closeInlineModal() {
    inlineState.selectedId = "";
    inlineState.selectedResult = "";
    inlineState.selectedResultLoading = false;
    inlineState.selectedAutomationId = "";
    inlineState.showCreate = false;
    inlineState.showSettings = false;
    renderInlineBoard();
    window.requestAnimationFrame(() => frame?.querySelector('[data-action="show-create"], [data-action="show-settings"]')?.focus?.());
  }

  function completeReviewItem(id) {
    pendingScrollExcludedItemId = id;
    inlineState.acceptedIds.add(id);
    persistAcceptedIds();
    inlineState.selectedId = "";
    inlineState.selectedResult = "";
    inlineState.selectedResultLoading = false;
    showInlineToast("已确认验收并移入已完成");
  }

  function onInlineClick(event) {
    const target = event.target?.closest?.("[data-action]");
    const clickedInsideNotice = Boolean(event.target?.closest?.(".tf-notice"));
    const clickedNoticeTrigger = target?.dataset?.action === "toggle-notices";
    if (inlineState.showNotices && !clickedInsideNotice && !clickedNoticeTrigger) {
      inlineState.showNotices = false;
      frame?.querySelector(".tf-notice")?.remove();
    }
    if (!target || !frame?.contains(target)) return;
    const action = target.dataset.action;
    const id = target.dataset.id || "";
    if (action === "view") setInlineView(target.dataset.view);
    else if (action === "clear-search") {
      inlineState.query = "";
      renderInlineBoard();
    } else if (action === "toggle-notices") {
      inlineState.showNotices = !inlineState.showNotices;
      renderInlineBoard();
    } else if (action === "mark-read") {
      inlineState.noticeReadAt = Date.now();
      window.localStorage.setItem(NOTICE_READ_STORAGE_KEY, String(inlineState.noticeReadAt));
      showInlineToast("待验收通知已全部标为已读");
    } else if (action === "show-settings") {
      inlineState.showSettings = true;
      inlineState.modalFocusPending = true;
      renderInlineBoard();
    } else if (action === "show-create") {
      void openCreateModal();
    } else if (action === "close-modal") closeInlineModal();
    else if (action === "modal-backdrop" && event.target === target) closeInlineModal();
    else if (action === "select-item") {
      void openInlineResult(id);
    } else if (action === "open-thread") void openThread(id);
    else if (action === "mark-done") {
      completeReviewItem(id);
    } else if (action === "queue-start") {
      void claimQueueItem(id, { ignoreActive: true });
      closeInlineModal();
      showInlineToast("正在创建 Codex 对话并开始执行");
    } else if (action === "queue-delete") {
      deleteQueueItem({ id });
      closeInlineModal();
      showInlineToast("已从待处理队列移除");
    } else if (action === "preview-automation") {
      inlineState.selectedAutomationId = id;
      inlineState.modalFocusPending = true;
      renderInlineBoard();
    } else if (action === "open-scheduled") openNativeScheduled();
    else if (action === "new-thread") openNewCodexThread();
    else if (action === "expand-sidebar") expandNativeSidebar();
    else if (action === "toggle-auto") updateQueueSettings({ enabled: !queueSettings.enabled });
    else if (action === "save-queue-settings") {
      const minutes = frame.querySelector("#tf-interval")?.value;
      const maxConcurrent = frame.querySelector("#tf-concurrency")?.value;
      updateQueueSettings({ intervalMinutes: minutes, maxConcurrent });
      showInlineToast("自动认领设置已保存");
    } else if (action === "claim-next") {
      void claimQueueItem(null, { ignoreActive: false });
      showInlineToast("正在认领下一项待处理任务");
    } else if (action === "refresh-data") {
      if (inlineState.refreshing) return;
      inlineState.refreshing = true;
      inlineState.refreshRequestIds.clear();
      inlineState.showNotices = false;
      refreshInlineThreads({ track: true });
      refreshInlineAccount({ track: true });
      postQueueState();
      renderInlineBoard();
    } else if (action === "refresh-account") refreshInlineAccount();
    else if (action === "focus-review") {
      inlineState.view = "all";
      window.localStorage.setItem(VIEW_STORAGE_KEY, "all");
      renderInlineBoard();
      frame.querySelector('.tf-column[data-status="review"]')?.scrollIntoView({ behavior: "smooth", inline: "center" });
    }
  }

  function onInlineInput(event) {
    if (event.target?.dataset?.role !== "search") return;
    inlineState.query = event.target.value;
    renderInlineBoard();
    const input = frame?.querySelector('[data-role="search"]');
    input?.focus?.();
    input?.setSelectionRange?.(inlineState.query.length, inlineState.query.length);
  }

  function onInlineChange(event) {
    if (event.target?.name !== "workspaceMode") return;
    const form = event.target.closest?.('[data-form="queue-create"]');
    const projectField = form?.querySelector(".tf-project-select");
    const projectSelect = projectField?.querySelector('select[name="projectId"]');
    const usesProject = event.target.value === "project";
    if (projectField) projectField.hidden = !usesProject;
    if (projectSelect) projectSelect.disabled = !usesProject;
  }

  function onInlineKeyDown(event) {
    const modal = frame?.querySelector('.tf-modal[role="dialog"]');
    if (event.key === "Escape") {
      if (modal) {
        event.preventDefault();
        closeInlineModal();
      } else if (inlineState.showNotices) {
        inlineState.showNotices = false;
        renderInlineBoard();
      }
      return;
    }
    if (event.key !== "Tab" || !modal) return;
    const focusable = Array.from(modal.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'))
      .filter((element) => element.getClientRects().length > 0);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function onInlineSubmit(event) {
    const form = event.target?.closest?.('[data-form="queue-create"]');
    if (!form) return;
    event.preventDefault();
    const data = new FormData(form);
    const workspaceMode = data.get("workspaceMode") === "none" ? "none" : "project";
    const projectId = workspaceMode === "project" ? String(data.get("projectId") || "").trim() : "";
    const project = (inlineState.hostContext?.projects || []).find((candidate) => candidate.id === projectId);
    const payload = {
      kind: data.get("kind") === "任务" ? "任务" : "聊天",
      title: String(data.get("title") || "").trim(),
      priority: normalizePriority(data.get("priority")),
      prompt: String(data.get("prompt") || "").trim(),
      workspaceMode,
      projectId,
      projectName: project?.name || "",
      cwd: workspaceMode === "project" ? String(inlineState.deviceWorkspaces?.[projectId] || "").trim() : "",
    };
    if (!payload.title || !payload.prompt || (payload.workspaceMode === "project" && !payload.cwd)) return;
    addQueueItem(payload);
    inlineState.showCreate = false;
    showInlineToast("已加入待处理队列");
  }

  function onInlineDragStart(event) {
    const card = event.target?.closest?.("[data-item-id]");
    if (!card || card.getAttribute("draggable") !== "true") return;
    draggedItemId = card.dataset.itemId || "";
    card.classList.add("dragging");
    event.dataTransfer?.setData("text/plain", draggedItemId);
  }

  function onInlineDragEnd() {
    draggedItemId = "";
    frame?.querySelectorAll(".dragging,.drop-active").forEach((node) => node.classList.remove("dragging", "drop-active"));
  }

  function onInlineDragOver(event) {
    const column = event.target?.closest?.("[data-status]");
    if (!column) return;
    event.preventDefault();
    frame?.querySelectorAll(".drop-active").forEach((node) => node.classList.remove("drop-active"));
    column.classList.add("drop-active");
  }

  function onInlineDrop(event) {
    const column = event.target?.closest?.("[data-status]");
    if (!column) return;
    event.preventDefault();
    const id = draggedItemId || event.dataTransfer?.getData("text/plain") || "";
    const target = column.dataset.status;
    const item = inlineItems().find((entry) => entry.id === id);
    onInlineDragEnd();
    if (!item || item.status === target) return;
    if (item.queueId && target === "running") {
      void claimQueueItem(item.queueId, { ignoreActive: true });
      showInlineToast("正在创建 Codex 对话并开始执行");
    } else if (item.queueId) showInlineToast("待处理任务可拖到“正在处理”立即执行");
    else if (item.status === "review" && target === "done") {
      completeReviewItem(item.id);
    } else if (item.status === "done" && target === "review") {
      inlineState.acceptedIds.delete(item.id);
      persistAcceptedIds();
      showInlineToast("已重新移入待验收");
    } else showInlineToast(item.status === "running" ? "运行状态由 Codex 自动更新" : "该状态由 Codex 的真实运行状态决定");
  }

  function startInlineRefresh() {
    if (inlineRefreshTimer === null) {
      inlineRefreshTimer = window.setInterval(refreshInlineThreads, 5_000);
    }
    if (inlineAccountRefreshTimer === null) {
      inlineAccountRefreshTimer = window.setInterval(refreshInlineAccount, 60_000);
    }
  }

  function updateDragRegion(payload) {
    if (!dragRegion || !noDragLeft || !noDragRight) return;
    const [x, y, width, height] = [payload?.x, payload?.y, payload?.width, payload?.height];
    if (![x, y, width, height].every((value) => Number.isFinite(value)) || width <= 0 || height <= 0) {
      dragRegion.hidden = true;
      noDragLeft.hidden = true;
      noDragRight.hidden = true;
      return;
    }
    const left = Math.max(0, x);
    const right = left + width;
    dragRegion.style.left = `${left}px`;
    dragRegion.style.top = `${Math.max(0, y)}px`;
    dragRegion.style.width = `${width}px`;
    dragRegion.style.height = `${height}px`;
    noDragLeft.style.left = "0";
    noDragLeft.style.top = `${Math.max(0, y)}px`;
    noDragLeft.style.width = `${left}px`;
    noDragLeft.style.height = `${height}px`;
    noDragRight.style.left = `${right}px`;
    noDragRight.style.top = `${Math.max(0, y)}px`;
    noDragRight.style.right = "0";
    noDragRight.style.height = `${height}px`;
    dragRegion.hidden = false;
    noDragLeft.hidden = left <= 0;
    noDragRight.hidden = right >= page.clientWidth;
  }

  function createPage() {
    const section = document.createElement("section");
    section.id = PAGE_ID;
    section.hidden = true;
    section.setAttribute(OWNED_ATTRIBUTE, "true");
    section.setAttribute("role", "region");
    section.setAttribute("aria-label", "任务流看板");

    status = document.createElement("div");
    status.id = STATUS_ID;
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    section.appendChild(status);

    dragRegion = document.createElement("div");
    dragRegion.id = DRAG_REGION_ID;
    dragRegion.hidden = true;
    dragRegion.setAttribute(OWNED_ATTRIBUTE, "true");
    dragRegion.setAttribute("aria-hidden", "true");
    section.appendChild(dragRegion);

    noDragLeft = document.createElement("div");
    noDragLeft.id = NO_DRAG_LEFT_ID;
    noDragLeft.hidden = true;
    noDragLeft.setAttribute(OWNED_ATTRIBUTE, "true");
    noDragLeft.setAttribute("aria-hidden", "true");
    section.appendChild(noDragLeft);

    noDragRight = document.createElement("div");
    noDragRight.id = NO_DRAG_RIGHT_ID;
    noDragRight.hidden = true;
    noDragRight.setAttribute(OWNED_ATTRIBUTE, "true");
    noDragRight.setAttribute("aria-hidden", "true");
    section.appendChild(noDragRight);
    return section;
  }

  function showLoading() {
    if (!status) return;
    status.replaceChildren(document.createTextNode("正在启动任务面板…"));
    status.hidden = false;
    if (frame) frame.hidden = true;
  }

  function showFrame() {
    if (status) status.hidden = true;
    if (frame) {
      frame.hidden = false;
      frame.focus?.();
    }
  }

  function showLoadError(message) {
    if (!status) return;
    const content = document.createElement("div");
    const text = document.createElement("div");
    text.textContent = message;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "重新启动";
    retry.addEventListener("click", openTaskboard, { once: true });
    content.append(text, retry);
    status.replaceChildren(content);
    status.hidden = false;
    if (frame) frame.hidden = true;
  }

  function cancelFrameReadyWaiters(error) {
    frameReadyWaiters.forEach(({ reject, timer }) => {
      window.clearTimeout(timer);
      reject(error);
    });
    frameReadyWaiters.clear();
  }

  function waitForFrameReady() {
    if (frameReady) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: window.setTimeout(() => {
          frameReadyWaiters.delete(waiter);
          reject(new Error("任务面板页面加载超时"));
        }, FRAME_READY_TIMEOUT_MS),
      };
      frameReadyWaiters.add(waiter);
    });
  }

  function loadTaskboardFrame(cacheBust = false) {
    cancelFrameReadyWaiters(new Error("任务面板正在重新加载"));
    frame?.remove();
    frame = null;
    frameReady = false;
    if (dragRegion) dragRegion.hidden = true;
    if (noDragLeft) noDragLeft.hidden = true;
    if (noDragRight) noDragRight.hidden = true;

    frameOrigin = "inline://codex-taskflow";
    const nextFrame = document.createElement("div");
    nextFrame.id = FRAME_ID;
    nextFrame.hidden = true;
    nextFrame.dataset.renderMode = "native";
    nextFrame.dataset.source = cacheBust ? `inline-${Date.now().toString(36)}` : "inline";
    nextFrame.setAttribute("role", "application");
    nextFrame.setAttribute("aria-label", "任务流看板");
    nextFrame.addEventListener("click", onInlineClick);
    nextFrame.addEventListener("input", onInlineInput);
    nextFrame.addEventListener("change", onInlineChange);
    nextFrame.addEventListener("keydown", onInlineKeyDown);
    nextFrame.addEventListener("submit", onInlineSubmit);
    nextFrame.addEventListener("dragstart", onInlineDragStart);
    nextFrame.addEventListener("dragend", onInlineDragEnd);
    nextFrame.addEventListener("dragover", onInlineDragOver);
    nextFrame.addEventListener("drop", onInlineDrop);
    frame = nextFrame;
    page.appendChild(nextFrame);
    frameReady = true;
    frameReadyWaiters.forEach(({ resolve, timer }) => {
      window.clearTimeout(timer);
      resolve();
    });
    frameReadyWaiters.clear();
    renderInlineBoard();
    startInlineRefresh();
    postHostContext();
    postQueueState();
    refreshInlineThreads();
    refreshInlineAccount();
    if (active) showFrame();
  }

  function reloadFrame() {
    if (!frame) return false;
    const generation = ++openGeneration;
    if (active) showLoading();
    loadTaskboardFrame(true);
    if (active) {
      void waitForFrameReady()
        .then(() => {
          if (!active || generation !== openGeneration) return;
          showFrame();
          postHostContext();
        })
        .catch((error) => {
          if (!active || generation !== openGeneration) return;
          showLoadError(error.message);
        });
    }
    return true;
  }

  function managedTaskboardOrigin() {
    const configured = typeof window.__CODEX_TASKBOARD_MANAGED_ORIGIN__ === "string"
      ? window.__CODEX_TASKBOARD_MANAGED_ORIGIN__.trim()
      : "";
    try {
      return new URL(configured || DEFAULT_TASKBOARD_URL).origin;
    } catch (_) {
      return new URL(DEFAULT_TASKBOARD_URL).origin;
    }
  }

  function hasLiveHostBinding() {
    const heartbeat = Number(window[HOST_HEARTBEAT_NAME]);
    return typeof window[HOST_BINDING_NAME] === "function"
      && Number.isFinite(heartbeat)
      && Date.now() - heartbeat <= HOST_HEARTBEAT_MAX_AGE_MS;
  }

  function requestHost(action, payload = {}) {
    const binding = window[HOST_BINDING_NAME];
    if (!hasLiveHostBinding()) {
      return Promise.reject(new Error("Taskboard 启动器未运行，无法操作 Codex 对话输入框"));
    }

    const id = `${Date.now().toString(36)}-${(++hostRequestSequence).toString(36)}`;
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        hostRequests.delete(id);
        reject(new Error("任务面板启动器没有响应"));
      }, HOST_REQUEST_TIMEOUT_MS);
      hostRequests.set(id, { resolve, reject, timeout });
      try {
        binding(JSON.stringify({ ...payload, id, action }));
      } catch (error) {
        window.clearTimeout(timeout);
        hostRequests.delete(id);
        reject(error);
      }
    });
  }

  function requestHostEnsure(taskboardUrl) {
    if (taskboardUrl.origin !== managedTaskboardOrigin() || !hasLiveHostBinding()) {
      return Promise.resolve({ managed: false, restarted: false });
    }
    return requestHost("ensure");
  }

  function requestHostTaskComposerPrefill({
    instruction,
    skillDisplayName,
    skillName,
    skillPath,
  }) {
    return requestHost("prefill-task-composer", {
      instruction,
      skillDisplayName,
      skillName,
      skillPath,
    });
  }

  function frameMatchesTaskboardUrl(taskboardUrl) {
    return Boolean(frame?.isConnected && frame.dataset?.renderMode === "native");
  }

  function onHostResponse(response) {
    if (!response || typeof response !== "object" || typeof response.id !== "string") return;
    const pending = hostRequests.get(response.id);
    if (!pending) return;
    window.clearTimeout(pending.timeout);
    hostRequests.delete(response.id);
    if (response.ok) pending.resolve(response);
    else pending.reject(new Error(response.error || "任务面板服务启动失败"));
  }

  async function prepareTaskboard(generation) {
    const taskboardUrl = resolveTaskboardUrl();
    const canReuseFrame = Boolean(
      frameReady
      && frame?.isConnected
      && frameMatchesTaskboardUrl(taskboardUrl),
    );
    if (canReuseFrame) showFrame();
    else showLoading();

    try {
      const context = await captureHostContext();
      if (!active || generation !== openGeneration) return;
      hostContextSnapshot = context;
      if (!frameReady || !frameMatchesTaskboardUrl(taskboardUrl)) {
        showLoading();
        loadTaskboardFrame();
        await waitForFrameReady();
      }
      if (!active || generation !== openGeneration) return;
      showFrame();
      postHostContext();
    } catch (error) {
      if (!active || generation !== openGeneration) return;
      const bindingAvailable = hasLiveHostBinding();
      showLoadError(bindingAvailable
        ? error.message
        : "任务面板服务未就绪。请保持 Taskboard 启动器运行后重试。");
    }
  }

  function restoreNativeContent() {
    document.querySelectorAll(`[${HIDDEN_ATTRIBUTE}="true"]`)
      .forEach((node) => node.removeAttribute(HIDDEN_ATTRIBUTE));
    document.querySelectorAll(`[${HOST_ATTRIBUTE}="true"]`)
      .forEach((node) => node.removeAttribute(HOST_ATTRIBUTE));
  }

  function mountActivePage() {
    if (!active) return;
    if (!page) page = createPage();
    const mount = findPageMount();
    if (!mount) return;
    const { surface } = mount;

    if (page.parentElement !== surface) {
      restoreNativeContent();
      surface.appendChild(page);
    }
    surface.setAttribute(HOST_ATTRIBUTE, "true");
    Array.from(surface.children).forEach((child) => {
      if (child !== page && child.getAttribute(OWNED_ATTRIBUTE) !== "true") {
        child.setAttribute(HIDDEN_ATTRIBUTE, "true");
      }
    });
    hideNativeHeader();
    muteNativeSelection();
    page.hidden = false;
    document.documentElement.setAttribute("data-codex-taskboard-open", "true");
  }

  function closeTaskboard(restoreFocus = true) {
    if (!active && page?.hidden !== false) return;
    openGeneration += 1;
    active = false;
    if (mountRetryTimer !== null) {
      window.clearTimeout(mountRetryTimer);
      mountRetryTimer = null;
    }
    if (page) page.hidden = true;
    restoreNativeContent();
    restoreNativeSelection();
    document.documentElement.removeAttribute("data-codex-taskboard-open");
    syncEntryState();
    if (restoreFocus) lastFocusedElement?.focus?.();
    lastFocusedElement = null;
    hostContextSnapshot = null;
  }

  function retryMountActivePage(generation, attemptsLeft = 25) {
    if (destroyed || !active || generation !== openGeneration) return;
    mountActivePage();
    if (page?.isConnected) {
      mountRetryTimer = null;
      void prepareTaskboard(generation);
      return;
    }
    if (attemptsLeft <= 0) return;
    mountRetryTimer = window.setTimeout(
      () => retryMountActivePage(generation, attemptsLeft - 1),
      80,
    );
  }

  function openTaskboard() {
    if (destroyed) return;
    if (closeNativeBrowserPanel()) {
      window.requestAnimationFrame(openTaskboard);
      return;
    }
    closeNativeRightSidebar();
    if (!active) {
      lastFocusedElement = document.activeElement;
      hostContextSnapshot = null;
    }
    const generation = ++openGeneration;
    active = true;
    ensureEntry();
    mountActivePage();
    syncEntryState();
    if (page?.isConnected) {
      void prepareTaskboard(generation);
    } else {
      retryMountActivePage(generation);
    }
  }

  function isNativePageNavigation(target) {
    const clickable = target?.closest?.("button,a,[role='button'],[data-app-action-sidebar-thread-id]");
    if (!clickable || clickable === entry || clickable.closest(`#${ENTRY_ID}`)) return false;
    if (!clickable.closest("aside nav[role='navigation']")) return false;
    if (clickable.hasAttribute("data-app-action-sidebar-section-toggle")) return false;
    if (buttonMatches(clickable, NATIVE_PAGE_LABELS)) return true;
    return Boolean(clickable.closest(
      "[data-app-action-sidebar-thread-id],"
      + "[data-app-action-sidebar-project-row],"
      + "[data-app-action-sidebar-project-id]",
    ));
  }

  function onDocumentClick(event) {
    const threadRow = event.target?.closest?.("[data-app-action-sidebar-thread-id]");
    const clickedThreadId = normalizeThreadId(threadRow?.getAttribute?.("data-app-action-sidebar-thread-id"));
    if (clickedThreadId) lastNativeThreadId = clickedThreadId;
    if (!active || !isNativePageNavigation(event.target)) return;
    closeTaskboard(false);
  }

  function scheduleRefresh(records) {
    if (
      Array.isArray(records)
      && records.length > 0
      && page
      && records.every((record) => record.target === page || page.contains(record.target))
    ) return;
    if (destroyed || reattachTimer !== null) return;
    reattachTimer = window.setTimeout(() => {
      reattachTimer = null;
      ensureEntry();
      mountActivePage();
      postHostContext();
    }, REATTACH_DELAY_MS);
  }

  function refresh() {
    ensureEntry();
    mountActivePage();
    postHostContext();
  }

  function mount() {
    document.removeEventListener("DOMContentLoaded", mount);
    if (destroyed || observer || !document.documentElement) return;
    ensureEntry();
    startQueueScheduler();
    observer = new MutationObserver(scheduleRefresh);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "class",
        "data-theme",
        "data-color-theme",
        "data-app-action-sidebar-thread-active",
        "aria-label",
        "aria-current",
      ],
    });
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (reattachTimer !== null) window.clearTimeout(reattachTimer);
    reattachTimer = null;
    if (mountRetryTimer !== null) window.clearTimeout(mountRetryTimer);
    mountRetryTimer = null;
    if (queueTimer !== null) window.clearInterval(queueTimer);
    queueTimer = null;
    if (inlineRefreshTimer !== null) window.clearInterval(inlineRefreshTimer);
    inlineRefreshTimer = null;
    if (inlineAccountRefreshTimer !== null) window.clearInterval(inlineAccountRefreshTimer);
    inlineAccountRefreshTimer = null;
    if (inlineToastTimer !== null) window.clearTimeout(inlineToastTimer);
    inlineToastTimer = null;
    observer?.disconnect();
    observer = null;
    cancelFrameReadyWaiters(new Error("任务面板已关闭"));
    hostRequests.forEach(({ reject, timeout }) => {
      window.clearTimeout(timeout);
      reject(new Error("任务面板已关闭"));
    });
    hostRequests.clear();
    pendingThreadCreation = null;
    document.removeEventListener("DOMContentLoaded", mount);
    document.removeEventListener("click", onDocumentClick, true);
    window.removeEventListener("message", onFrameMessage);
    window.removeEventListener("popstate", onNativeRouteChange);
    window.removeEventListener("hashchange", onNativeRouteChange);
    window.removeEventListener("resize", scheduleRefresh);
    closeTaskboard(false);
    document.querySelectorAll(`[${OWNED_ATTRIBUTE}="true"]`).forEach((node) => node.remove());
    entry = null;
    page = null;
    frame = null;
    dragRegion = null;
    noDragLeft = null;
    noDragRight = null;
    status = null;
    frameOrigin = "";
    if (window[SENTINEL_KEY] === api) delete window[SENTINEL_KEY];
  }

  function onNativeRouteChange() {
    if (active) closeTaskboard(false);
  }

  const api = {
    version: VERSION,
    sourceHash: SOURCE_HASH,
    refresh,
    reloadFrame,
    open: openTaskboard,
    close: closeTaskboard,
    destroy,
    hostResponse: onHostResponse,
  };
  window[SENTINEL_KEY] = api;

  window.addEventListener("message", onFrameMessage);
  window.addEventListener("popstate", onNativeRouteChange);
  window.addEventListener("hashchange", onNativeRouteChange);
  window.addEventListener("resize", scheduleRefresh);
  document.addEventListener("click", onDocumentClick, true);
  if (document.documentElement) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
})();
