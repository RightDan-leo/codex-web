import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronDown, LoaderCircle, Monitor, Server, WifiOff, X } from "lucide-react";
import { api, type ExecutorTarget, type RemoteWorkerStatus } from "./api";
import "./remote-executor.css";

const SELECTED_CONVERSATION_KEY = "codex-web:selected-conversation";

type ExecutorState = {
  executor: ExecutorTarget;
  online: boolean;
  canChange: boolean;
};

type ProjectOption = {
  id: string;
  name: string;
  workerId: string;
  workerName: string;
};

function selectedConversationId(): string | null {
  try { return window.localStorage.getItem(SELECTED_CONVERSATION_KEY); }
  catch { return null; }
}

export function RemoteExecutorDock() {
  const [conversationId, setConversationId] = useState<string | null>(() => selectedConversationId());
  const [workers, setWorkers] = useState<RemoteWorkerStatus[]>([]);
  const [executorState, setExecutorState] = useState<ExecutorState | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [authenticated, setAuthenticated] = useState(true);

  const projects = useMemo<ProjectOption[]>(() => workers.flatMap((worker) => worker.projects.map((project) => ({
    id: project.id,
    name: project.name,
    workerId: worker.workerId,
    workerName: worker.displayName,
  }))), [workers]);

  const refresh = useCallback(async (id: string, quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const [workerResult, executorResult] = await Promise.all([
        api.remoteWorkers(),
        api.conversationExecutor(id),
      ]);
      setAuthenticated(true);
      setWorkers(workerResult.workers);
      setExecutorState(executorResult);
      setError("");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "执行位置加载失败";
      if (/请先登录/.test(message)) {
        setAuthenticated(false);
        setOpen(false);
      } else {
        setError(message);
      }
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const sync = () => {
      const next = selectedConversationId();
      setConversationId((current) => current === next ? current : next);
    };
    sync();
    const timer = window.setInterval(sync, 500);
    window.addEventListener("storage", sync);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("storage", sync);
    };
  }, []);

  useEffect(() => {
    setOpen(false);
    setExecutorState(null);
    setError("");
    if (!conversationId) return;
    void refresh(conversationId);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh(conversationId, true);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [conversationId, refresh]);

  async function selectExecutor(executor: ExecutorTarget) {
    if (!conversationId || saving || !executorState?.canChange) return;
    setSaving(true);
    setError("");
    try {
      const result = await api.updateConversationExecutor(conversationId, executor);
      setExecutorState(result);
      setOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "执行位置保存失败");
      await refresh(conversationId, true).catch(() => undefined);
    } finally {
      setSaving(false);
    }
  }

  const remoteProjectId = executorState?.executor.kind === "remote"
    ? executorState.executor.projectId
    : undefined;
  const selectedProject = remoteProjectId
    ? projects.find((project) => project.id === remoteProjectId)
    : undefined;
  const hasRemoteChoice = projects.length > 0;
  const shouldRender = authenticated && Boolean(conversationId) && Boolean(
    loading || hasRemoteChoice || executorState?.executor.kind === "remote",
  );
  if (!shouldRender) return null;

  const selectedLabel = remoteProjectId
    ? selectedProject?.name ?? remoteProjectId
    : "隔离工作区";
  const remoteOffline = executorState?.executor.kind === "remote" && !executorState.online;

  return <aside className={`remote-executor-dock ${open ? "open" : ""}`} aria-label="任务执行位置">
    {open && <section className="remote-executor-panel">
      <header>
        <div><Server size={16} /><span><strong>执行位置</strong><small>仅空白新任务可切换</small></span></div>
        <button type="button" aria-label="关闭执行位置选择" onClick={() => setOpen(false)}><X size={15} /></button>
      </header>
      <div className="remote-executor-options" role="listbox" aria-label="选择任务执行位置">
        <ExecutorOption
          icon={<Server size={17} />}
          title="隔离工作区"
          description="在服务器 Docker tenant 中执行，默认且最安全"
          selected={executorState?.executor.kind !== "remote"}
          disabled={saving || !executorState?.canChange}
          onClick={() => void selectExecutor({ kind: "tenant" })}
        />
        {projects.map((project) => <ExecutorOption
          key={`${project.workerId}:${project.id}`}
          icon={<Monitor size={17} />}
          title={project.name}
          description={`${project.workerName} · ${project.id}`}
          selected={executorState?.executor.kind === "remote" && executorState.executor.projectId === project.id}
          disabled={saving || !executorState?.canChange}
          onClick={() => void selectExecutor({ kind: "remote", projectId: project.id })}
        />)}
      </div>
      {!hasRemoteChoice && <p className="remote-executor-empty"><WifiOff size={14} />没有在线的远程电脑</p>}
      {!executorState?.canChange && <p className="remote-executor-note">任务已有消息、草稿或排队内容，执行位置已锁定。</p>}
      {executorState?.executor.kind === "remote" && <p className="remote-executor-warning">远程任务会直接读写该电脑登记的真实项目目录；当前 MVP 暂不传输会话附件或服务器结果文件。</p>}
      {error && <p className="remote-executor-error">{error}</p>}
    </section>}
    <button
      type="button"
      className={`remote-executor-trigger ${remoteOffline ? "offline" : ""}`}
      aria-haspopup="listbox"
      aria-expanded={open}
      title={remoteOffline ? "远程项目离线" : "选择任务执行位置"}
      onClick={() => setOpen((value) => !value)}
    >
      {loading || saving ? <LoaderCircle className="spin" size={16} /> : remoteOffline ? <WifiOff size={16} /> : executorState?.executor.kind === "remote" ? <Monitor size={16} /> : <Server size={16} />}
      <span>{remoteOffline ? `${selectedLabel}（离线）` : selectedLabel}</span>
      <ChevronDown size={14} />
    </button>
  </aside>;
}

function ExecutorOption({ icon, title, description, selected, disabled, onClick }: {
  icon: ReactNode;
  title: string;
  description: string;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return <button type="button" role="option" aria-selected={selected} disabled={disabled} className={selected ? "selected" : ""} onClick={onClick}>
    <span className="remote-executor-option-icon">{icon}</span>
    <span className="remote-executor-option-copy"><strong>{title}</strong><small>{description}</small></span>
    {selected && <Check size={15} />}
  </button>;
}
