import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, HardDrive, LoaderCircle, Monitor, WifiOff } from "lucide-react";
import { api, type ExecutorTarget, type RemoteWorkerStatus } from "./api";
import {
  buildExecutorOptions,
  executorIsOnline,
  executorSummary,
  executorValue,
  parseExecutorValue,
} from "./remote-executor";
import { forgetExecutorTarget, rememberExecutorTarget } from "./remote-executor-state";
import { readSelectedConversationId, subscribeSelectedConversation } from "./conversation-selection";
import "./remote-executor.css";

const STATUS_POLL_MS = 8_000;

type ExecutorSnapshot = {
  target: ExecutorTarget;
  canChange: boolean;
};

function findPortalTarget(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".chat-header-actions");
}

export function RemoteExecutorDock() {
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(() => findPortalTarget());
  const [conversationId, setConversationId] = useState<string | null>(() => readSelectedConversationId());
  const [snapshot, setSnapshot] = useState<ExecutorSnapshot | null>(null);
  const [workers, setWorkers] = useState<RemoteWorkerStatus[]>([]);
  const [remoteEnabled, setRemoteEnabled] = useState(false);
  const [ownerAccess, setOwnerAccess] = useState<"unknown" | "allowed" | "denied">("unknown");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const requestGenerationRef = useRef(0);

  useEffect(() => {
    const syncTarget = () => {
      const next = findPortalTarget();
      setPortalTarget((current) => current === next ? current : next);
    };
    syncTarget();
    const observer = new MutationObserver(syncTarget);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    return subscribeSelectedConversation((next) => {
      setConversationId((current) => current === next ? current : next);
    });
  }, []);

  const refresh = useCallback(async (id: string, showErrors = false) => {
    const generation = ++requestGenerationRef.current;
    const [workerResult, executorResult] = await Promise.allSettled([
      api.remoteWorkers(),
      api.conversationExecutor(id),
    ]);
    if (generation !== requestGenerationRef.current || readSelectedConversationId() !== id) return;

    if (workerResult.status === "fulfilled") {
      setOwnerAccess("allowed");
      setWorkers(workerResult.value.workers);
      setRemoteEnabled(Boolean(workerResult.value.enabled));
    } else {
      const message = workerResult.reason instanceof Error ? workerResult.reason.message : "";
      if (/只有所有者|403/.test(message)) setOwnerAccess("denied");
      else if (showErrors) setError(message || "远端电脑状态读取失败");
    }

    if (executorResult.status === "fulfilled") {
      const next = {
        target: executorResult.value.executor,
        canChange: executorResult.value.canChange,
      };
      setSnapshot(next);
      rememberExecutorTarget(id, next.target);
    } else if (showErrors) {
      setError(executorResult.reason instanceof Error ? executorResult.reason.message : "执行位置读取失败");
    }
  }, []);

  useEffect(() => {
    setOpen(false);
    setError("");
    setSnapshot(null);
    if (!conversationId) return;
    void refresh(conversationId, true);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh(conversationId);
    }, STATUS_POLL_MS);
    return () => {
      window.clearInterval(timer);
      requestGenerationRef.current += 1;
    };
  }, [conversationId, refresh]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);

  useEffect(() => {
    const remote = Boolean(conversationId && snapshot?.target.kind === "remote");
    if (remote) {
      document.documentElement.dataset.executorKind = "remote";
      document.documentElement.dataset.executorConversation = conversationId!;
    } else {
      delete document.documentElement.dataset.executorKind;
      delete document.documentElement.dataset.executorConversation;
    }
    return () => {
      if (document.documentElement.dataset.executorConversation === conversationId) {
        delete document.documentElement.dataset.executorKind;
        delete document.documentElement.dataset.executorConversation;
      }
    };
  }, [conversationId, snapshot?.target]);

  useEffect(() => () => {
    if (conversationId) forgetExecutorTarget(conversationId);
  }, [conversationId]);

  const options = useMemo(
    () => snapshot ? buildExecutorOptions(workers, snapshot.target) : [],
    [snapshot, workers],
  );
  const summary = useMemo(
    () => snapshot ? executorSummary(snapshot.target, workers) : null,
    [snapshot, workers],
  );
  const online = useMemo(
    () => snapshot ? executorIsOnline(snapshot.target, workers) && (snapshot.target.kind === "tenant" || remoteEnabled) : false,
    [remoteEnabled, snapshot, workers],
  );

  async function choose(value: string) {
    const id = conversationId;
    const target = parseExecutorValue(value);
    if (!id || !target || !snapshot || busy) return;
    if (executorValue(snapshot.target) === value) { setOpen(false); return; }
    if (!snapshot.canChange) {
      setError("执行位置已锁定。请新建任务后选择其他位置。");
      return;
    }
    if (target.kind === "remote" && !remoteEnabled) {
      setError("远端执行服务尚未启用。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await api.updateConversationExecutor(id, target);
      if (readSelectedConversationId() !== id) return;
      setSnapshot({ target: result.executor, canChange: result.canChange });
      rememberExecutorTarget(id, result.executor);
      setOpen(false);
    } catch (reason) {
      if (readSelectedConversationId() === id) {
        setError(reason instanceof Error ? reason.message : "执行位置保存失败");
      }
    } finally {
      if (readSelectedConversationId() === id) setBusy(false);
    }
  }

  if (!portalTarget || !conversationId || !snapshot || ownerAccess !== "allowed" || !summary) return null;

  const selectedValue = executorValue(snapshot.target);
  const remoteSelected = snapshot.target.kind === "remote";
  const lockedReason = snapshot.canChange
    ? ""
    : "保存草稿或开始任务后执行位置会锁定；需要更换时请新建任务。";

  return createPortal(<div ref={rootRef} className={`remote-executor-dock ${remoteSelected ? "remote" : "tenant"} ${online ? "online" : "offline"}`}>
    <button
      type="button"
      className="remote-executor-trigger"
      aria-haspopup="listbox"
      aria-expanded={open}
      title={lockedReason || `${summary.label} · ${summary.description}`}
      onClick={() => setOpen((current) => !current)}
    >
      <span className="remote-executor-status-dot" aria-hidden="true" />
      {remoteSelected ? <Monitor size={15} /> : <HardDrive size={15} />}
      <span className="remote-executor-trigger-copy">
        <small>执行位置</small>
        <strong>{summary.label}</strong>
      </span>
      {busy ? <LoaderCircle className="spin" size={14} /> : !online && remoteSelected ? <WifiOff size={14} /> : <ChevronDown size={14} />}
    </button>

    {open && <section className="remote-executor-panel" role="dialog" aria-label="选择执行位置">
      <header>
        <div><strong>执行位置</strong><span>仅发送逻辑项目标识，不向服务器公开本机路径</span></div>
        <span className={`remote-executor-availability ${remoteEnabled ? "enabled" : "disabled"}`}>
          {remoteEnabled ? `${workers.length} 台电脑在线` : "远端服务未启用"}
        </span>
      </header>
      <div className="remote-executor-options" role="listbox" aria-label="执行位置">
        {options.map((option) => {
          const selected = option.value === selectedValue;
          const unavailable = option.target.kind === "remote" && (!remoteEnabled || !option.online);
          return <button
            type="button"
            role="option"
            aria-selected={selected}
            key={option.value}
            className={`${selected ? "selected" : ""} ${unavailable ? "unavailable" : ""}`}
            disabled={busy || unavailable || (!snapshot.canChange && !selected)}
            onClick={() => void choose(option.value)}
          >
            <span className="remote-executor-option-icon">{option.target.kind === "tenant" ? <HardDrive size={16} /> : option.online ? <Monitor size={16} /> : <WifiOff size={16} />}</span>
            <span><strong>{option.label}</strong><small>{option.description}</small></span>
            {selected && <Check size={15} />}
          </button>;
        })}
      </div>
      {workers.length === 0 && remoteEnabled && <p className="remote-executor-empty">没有远端电脑在线。启动 Remote Worker 后，已登记的项目会自动出现在这里。</p>}
      {remoteSelected && <p className={`remote-executor-note ${online ? "" : "warning"}`}>
        {online
          ? "网页附件会经受认证的 Worker 通道复制到一次性目录（单文件 8 MiB、合计 16 MiB），任务结束后自动清理；生成文件仍保留在项目目录中。"
          : "当前项目离线。历史仍可查看，新任务会保持失败关闭，不会回退到服务器容器。"}
      </p>}
      {!snapshot.canChange && <p className="remote-executor-note locked">{lockedReason}</p>}
      {error && <p className="remote-executor-error" role="alert">{error}</p>}
    </section>}
  </div>, portalTarget);
}
