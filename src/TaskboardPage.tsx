import { useEffect, useMemo, useState, type DragEvent, type FormEvent } from "react";
import {
  Archive, ArrowRight, Bot, ChevronDown, ExternalLink, FolderKanban,
  GitBranch, GripVertical, HardDrive, LoaderCircle, Monitor, Plus, ShieldCheck, TriangleAlert, X,
} from "lucide-react";
import {
  api,
  type ExecutorTarget,
  type RemoteWorkerStatus,
  type TaskboardPriority,
  type TaskboardProject,
  type TaskboardProjectDetail,
  type TaskboardRisk,
  type TaskboardStatus,
  type TaskboardTask,
} from "./api";
import { executorOnline, taskDraft, transitionLabel } from "./taskboard";
import "./taskboard.css";

const COLUMNS: Array<{ status: TaskboardStatus; label: string; hint: string }> = [
  { status: "backlog", label: "待规划", hint: "尚未进入开发队列" },
  { status: "ready", label: "待开发", hint: "依赖满足后可以开始" },
  { status: "running", label: "开发中", hint: "Codex 正在处理" },
  { status: "review", label: "待验收", hint: "等待 Owner 确认" },
  { status: "blocked", label: "已阻塞", hint: "需要处理前置问题" },
  { status: "done", label: "已完成", hint: "已通过人工验收" },
  { status: "cancelled", label: "已取消", hint: "不再继续执行" },
];

const PRIORITY_LABELS: Record<TaskboardPriority, string> = {
  urgent: "紧急", high: "高", medium: "中", low: "低",
};

const RISK_LABELS: Record<TaskboardRisk, string> = {
  low: "低风险", medium: "中风险", high: "高风险",
};

export function TaskboardPage({
  onOpenConversation,
}: {
  onOpenConversation: (conversationId: string, draft: string) => void;
}) {
  const [projects, setProjects] = useState<TaskboardProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskboardProjectDetail | null>(null);
  const [workers, setWorkers] = useState<RemoteWorkerStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [projectFormOpen, setProjectFormOpen] = useState(false);
  const [taskFormOpen, setTaskFormOpen] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([api.taskboardProjects(), api.remoteWorkers()])
      .then(([projectResult, workerResult]) => {
        if (!active) return;
        setProjects(projectResult.projects);
        setWorkers(workerResult.workers);
        setSelectedProjectId((current) => current && projectResult.projects.some((project) => project.id === current)
          ? current
          : projectResult.projects[0]?.id ?? null);
      })
      .catch((reason) => active && setError(reason instanceof Error ? reason.message : "看板加载失败"))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!selectedProjectId) { setDetail(null); return; }
    let active = true;
    setLoading(true);
    api.taskboardProject(selectedProjectId)
      .then((value) => {
        if (!active) return;
        setDetail(value);
        setProjects((current) => current.map((project) => project.id === value.project.id ? value.project : project));
      })
      .catch((reason) => active && setError(reason instanceof Error ? reason.message : "项目加载失败"))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId || !detail?.tasks.some((task) => task.status === "running")) return;
    let active = true;
    const timer = window.setInterval(() => {
      void api.taskboardProject(selectedProjectId).then((value) => {
        if (!active) return;
        setDetail(value);
        setProjects((current) => current.map((project) => project.id === value.project.id ? value.project : project));
      }).catch(() => undefined);
    }, 2_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [selectedProjectId, detail?.tasks.some((task) => task.status === "running")]);

  const selectedTask = detail?.tasks.find((task) => task.id === selectedTaskId) ?? null;
  const online = detail ? executorOnline(detail.project.executor, workers) : true;

  async function refresh(projectId = selectedProjectId) {
    if (!projectId) return;
    const value = await api.taskboardProject(projectId);
    setDetail(value);
    setProjects((current) => current.map((project) => project.id === value.project.id ? value.project : project));
  }

  async function createProject(input: { name: string; description: string; executor: ExecutorTarget }) {
    setBusy(true); setError("");
    try {
      const result = await api.createTaskboardProject(input);
      setProjects((current) => [result.project, ...current]);
      setSelectedProjectId(result.project.id);
      setProjectFormOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "项目创建失败");
    } finally { setBusy(false); }
  }

  async function createTask(input: CreateTaskInput) {
    if (!detail) return;
    setBusy(true); setError("");
    try {
      await api.createTaskboardTask(detail.project.id, input);
      await refresh(detail.project.id);
      setTaskFormOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "任务创建失败");
    } finally { setBusy(false); }
  }

  async function transition(task: TaskboardTask, status: TaskboardStatus, reason = "") {
    if (!task.allowedTransitions.includes(status)) return;
    if (status === "running") { await startTask(task); return; }
    setBusy(true); setError("");
    try {
      await api.transitionTaskboardTask(task.id, task.version, status, reason);
      await refresh(task.projectId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "任务状态更新失败");
      await refresh(task.projectId).catch(() => undefined);
    } finally { setBusy(false); }
  }

  async function startTask(task: TaskboardTask) {
    if (!executorOnline(task.executor, workers)) {
      setError("任务对应的远端项目当前离线；不会回退到 Tenant。");
      return;
    }
    if (!window.confirm(`启动“${task.title}”？系统会立即创建持久任务并交给 Codex 执行。`)) return;
    setBusy(true); setError("");
    try {
      await api.startTaskboardTask(task.id, task.version);
      await refresh(task.projectId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "任务启动失败");
      await refresh(task.projectId).catch(() => undefined);
    } finally { setBusy(false); }
  }

  async function archiveTask(task: TaskboardTask) {
    if (!window.confirm(`归档“${task.title}”？归档后会从当前看板隐藏。`)) return;
    setBusy(true); setError("");
    try {
      await api.archiveTaskboardTask(task.id, task.version);
      setSelectedTaskId(null);
      await refresh(task.projectId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "任务归档失败");
      await refresh(task.projectId).catch(() => undefined);
    } finally { setBusy(false); }
  }

  async function archiveProject() {
    if (!detail || !window.confirm(`收起项目“${detail.project.name}”？项目会从当前列表隐藏。`)) return;
    setBusy(true); setError("");
    try {
      await api.archiveTaskboardProject(detail.project.id, detail.project.version);
      const remaining = projects.filter((project) => project.id !== detail.project.id);
      setProjects(remaining);
      setDetail(null);
      setSelectedProjectId(remaining[0]?.id ?? null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "项目归档失败");
      await refresh(detail.project.id).catch(() => undefined);
    } finally { setBusy(false); }
  }

  async function saveTask(task: TaskboardTask, input: UpdateTaskInput) {
    setBusy(true); setError("");
    try {
      await api.updateTaskboardTask(task.id, { version: task.version, ...input });
      await refresh(task.projectId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "任务保存失败");
      await refresh(task.projectId).catch(() => undefined);
    } finally { setBusy(false); }
  }

  async function saveDependencies(task: TaskboardTask, dependencyIds: string[]) {
    setBusy(true); setError("");
    try {
      await api.updateTaskboardDependencies(task.id, task.version, dependencyIds);
      await refresh(task.projectId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "依赖保存失败");
      await refresh(task.projectId).catch(() => undefined);
    } finally { setBusy(false); }
  }

  async function openWorkConversation(task: TaskboardTask) {
    if (!detail || !executorOnline(task.executor, workers)) {
      setError("任务对应的远端项目当前离线，不能创建工作会话。");
      return;
    }
    setBusy(true); setError("");
    let conversationId = task.conversationId;
    let createdConversationId: string | null = null;
    try {
      if (!conversationId) {
        const created = await api.createConversation();
        conversationId = created.conversation.id;
        createdConversationId = conversationId;
        if (task.executor.kind === "remote") await api.updateConversationExecutor(conversationId, task.executor);
        const linked = await api.updateTaskboardTask(task.id, { version: task.version, conversationId });
        await refresh(task.projectId);
        conversationId = linked.task.conversationId;
      }
      if (!conversationId) throw new Error("工作会话创建失败。");
      onOpenConversation(conversationId, taskDraft(task));
    } catch (failure) {
      if (createdConversationId) await api.deleteConversation(createdConversationId).catch(() => undefined);
      setError(failure instanceof Error ? failure.message : "工作会话创建失败");
    } finally { setBusy(false); }
  }

  function dragStart(task: TaskboardTask, event: DragEvent) {
    setDraggingTaskId(task.id);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", task.id);
  }

  function drop(status: TaskboardStatus, event: DragEvent) {
    event.preventDefault();
    const id = event.dataTransfer.getData("text/plain") || draggingTaskId;
    setDraggingTaskId(null);
    const task = detail?.tasks.find((candidate) => candidate.id === id);
    if (task?.allowedTransitions.includes(status)) void transition(task, status);
  }

  if (loading && projects.length === 0) return <section className="taskboard-loading"><LoaderCircle className="spin" size={24} /><span>正在加载项目看板…</span></section>;

  return <section className="taskboard-page">
    <header className="taskboard-header">
      <div className="taskboard-heading">
        <span className="taskboard-heading-icon"><FolderKanban size={22} /></span>
        <div><span>REMOTE CODEX</span><h1>智能项目看板</h1></div>
      </div>
      <div className="taskboard-header-actions">
        {projects.length > 0 && <label className="taskboard-project-select"><span>当前项目</span><select value={selectedProjectId ?? ""} onChange={(event) => setSelectedProjectId(event.target.value)}>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select><ChevronDown size={15} /></label>}
        <button type="button" className="taskboard-secondary-button" onClick={() => setProjectFormOpen(true)}><Plus size={16} />新建项目</button>
        {detail && <button type="button" className="taskboard-primary-button" onClick={() => setTaskFormOpen(true)}><Plus size={16} />新建任务</button>}
      </div>
    </header>

    {error && <div className="taskboard-alert" role="alert"><TriangleAlert size={16} /><span>{error}</span><button type="button" onClick={() => setError("")}><X size={15} /></button></div>}

    {!detail ? <div className="taskboard-empty">
      <FolderKanban size={42} /><h2>创建第一个项目</h2><p>选择 Tenant 或已登记的 Remote 项目，然后用任务卡管理完整开发流程。</p>
      <button type="button" className="taskboard-primary-button" onClick={() => setProjectFormOpen(true)}><Plus size={16} />新建项目</button>
    </div> : <>
      <div className="taskboard-project-summary">
        <div><strong>{detail.project.name}</strong><span>{detail.project.description || "尚未填写项目说明"}</span></div>
        <div className="taskboard-project-chips">
          <span className={online ? "online" : "offline"}>{detail.project.executor.kind === "tenant" ? <HardDrive size={14} /> : <Monitor size={14} />}{executorLabel(detail.project.executor, workers)}</span>
          <span><ShieldCheck size={14} />人工验收</span>
          <span><Bot size={14} />当前为人工模式</span>
          <button type="button" className="taskboard-archive-project" disabled={busy} onClick={() => void archiveProject()}><Archive size={14} />收起项目</button>
        </div>
      </div>

      <div className="taskboard-columns" aria-label="项目任务看板">
        {COLUMNS.map((column) => {
          const tasks = detail.tasks.filter((task) => task.status === column.status);
          return <section className={`taskboard-column status-${column.status}`} key={column.status}
            onDragOver={(event) => event.preventDefault()} onDrop={(event) => drop(column.status, event)}>
            <header><div><strong>{column.label}</strong><span>{tasks.length}</span></div><small>{column.hint}</small></header>
            <div className="taskboard-card-list">
              {tasks.map((task) => <TaskCard key={task.id} task={task} detail={detail} dragging={task.id === draggingTaskId}
                onDragStart={dragStart} onOpen={() => setSelectedTaskId(task.id)} />)}
              {tasks.length === 0 && <div className="taskboard-column-empty">拖动允许的任务到这里</div>}
            </div>
          </section>;
        })}
      </div>
    </>}

    {projectFormOpen && <ProjectForm workers={workers} busy={busy} onCancel={() => setProjectFormOpen(false)} onSubmit={createProject} />}
    {taskFormOpen && detail && <TaskForm detail={detail} busy={busy} onCancel={() => setTaskFormOpen(false)} onSubmit={createTask} />}
    {selectedTask && detail && <TaskDetailDialog key={`${selectedTask.id}:${selectedTask.version}`} task={selectedTask} detail={detail} busy={busy}
      online={executorOnline(selectedTask.executor, workers)} onClose={() => setSelectedTaskId(null)} onSave={saveTask}
      onSaveDependencies={saveDependencies} onTransition={transition} onStart={startTask} onArchive={archiveTask} onOpenConversation={openWorkConversation} />}
  </section>;
}

type CreateTaskInput = {
  title: string;
  description?: string;
  parentTaskId?: string | null;
  priority?: TaskboardPriority;
  risk?: TaskboardRisk;
  estimatePoints?: number | null;
  acceptanceCriteria?: string;
};

type UpdateTaskInput = Omit<CreateTaskInput, "title"> & { title?: string };

function TaskCard({ task, detail, dragging, onDragStart, onOpen }: {
  task: TaskboardTask;
  detail: TaskboardProjectDetail;
  dragging: boolean;
  onDragStart: (task: TaskboardTask, event: DragEvent) => void;
  onOpen: () => void;
}) {
  const dependencies = detail.dependencies.filter((relation) => relation.task_id === task.id);
  const parent = task.parentTaskId ? detail.tasks.find((candidate) => candidate.id === task.parentTaskId) : null;
  return <article className={`taskboard-card priority-${task.priority} ${dragging ? "dragging" : ""}`} draggable
    onDragStart={(event) => onDragStart(task, event)} onDragEnd={() => undefined}>
    <button type="button" className="taskboard-card-open" onClick={onOpen}>
      <span className="taskboard-card-top"><GripVertical size={14} /><span className={`priority-pill ${task.priority}`}>{PRIORITY_LABELS[task.priority]}</span><span className={`risk-pill ${task.risk}`}>{RISK_LABELS[task.risk]}</span></span>
      <strong>{task.title}</strong>
      {parent && <small className="taskboard-parent"><GitBranch size={12} />{parent.title}</small>}
      {task.description && <p>{task.description}</p>}
      <span className="taskboard-card-meta">
        {dependencies.length > 0 && <span><GitBranch size={12} />{dependencies.length} 个依赖</span>}
        {task.estimatePoints && <span>{task.estimatePoints} 点</span>}
        {task.conversationId && <span><ExternalLink size={12} />已关联会话</span>}
        {task.status === "running" && <span className={`execution-${task.executionStatus ?? "missing"}`}><Bot size={12} />{executionLabel(task.executionStatus)}</span>}
      </span>
    </button>
  </article>;
}

function ProjectForm({ workers, busy, onCancel, onSubmit }: {
  workers: RemoteWorkerStatus[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: { name: string; description: string; executor: ExecutorTarget }) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [executorValue, setExecutorValue] = useState("tenant");
  const remoteProjects = useMemo(() => {
    const seen = new Set<string>();
    return workers.flatMap((worker) => worker.projects.map((project) => ({ ...project, worker: worker.displayName })))
      .filter((project) => !seen.has(project.id) && Boolean(seen.add(project.id)));
  }, [workers]);
  function submit(event: FormEvent) {
    event.preventDefault();
    const executor: ExecutorTarget = executorValue === "tenant"
      ? { kind: "tenant" }
      : { kind: "remote", projectId: executorValue.slice("remote:".length) };
    onSubmit({ name, description, executor });
  }
  return <div className="taskboard-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
    <form className="taskboard-dialog compact" onSubmit={submit}>
      <header><div><FolderKanban size={19} /><strong>新建项目</strong></div><button type="button" onClick={onCancel} aria-label="关闭"><X size={18} /></button></header>
      <label>项目名称<input autoFocus required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：Remote Codex 看板" /></label>
      <label>项目说明<textarea maxLength={20_000} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="目标、范围和重要约束" /></label>
      <label>执行位置<select value={executorValue} onChange={(event) => setExecutorValue(event.target.value)}>
        <option value="tenant">隔离 Tenant（默认）</option>
        {remoteProjects.map((project) => <option key={project.id} value={`remote:${project.id}`}>{project.name} · {project.worker}</option>)}
      </select></label>
      <p className="taskboard-form-note">服务器只保存逻辑项目标识；Remote 真实路径仍只存在于 Worker 本机。</p>
      <footer><button type="button" className="taskboard-secondary-button" onClick={onCancel}>取消</button><button className="taskboard-primary-button" disabled={busy || !name.trim()}>{busy ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}创建项目</button></footer>
    </form>
  </div>;
}

function TaskForm({ detail, busy, onCancel, onSubmit }: {
  detail: TaskboardProjectDetail;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: CreateTaskInput) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [acceptanceCriteria, setAcceptanceCriteria] = useState("");
  const [parentTaskId, setParentTaskId] = useState("");
  const [priority, setPriority] = useState<TaskboardPriority>("medium");
  const [risk, setRisk] = useState<TaskboardRisk>("medium");
  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit({ title, description, acceptanceCriteria, parentTaskId: parentTaskId || null, priority, risk });
  }
  return <div className="taskboard-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
    <form className="taskboard-dialog" onSubmit={submit}>
      <header><div><Plus size={19} /><strong>新建任务</strong></div><button type="button" onClick={onCancel} aria-label="关闭"><X size={18} /></button></header>
      <label>任务标题<input autoFocus required maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>任务说明<textarea maxLength={30_000} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="需要完成的工作和限制" /></label>
      <label>验收标准<textarea maxLength={15_000} value={acceptanceCriteria} onChange={(event) => setAcceptanceCriteria(event.target.value)} placeholder="满足什么条件才算完成" /></label>
      <div className="taskboard-form-grid">
        <label>父任务<select value={parentTaskId} onChange={(event) => setParentTaskId(event.target.value)}><option value="">无</option>{detail.tasks.filter((task) => !["done", "cancelled"].includes(task.status)).map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label>
        <label>优先级<select value={priority} onChange={(event) => setPriority(event.target.value as TaskboardPriority)}><option value="urgent">紧急</option><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></label>
        <label>风险<select value={risk} onChange={(event) => setRisk(event.target.value as TaskboardRisk)}><option value="low">低风险</option><option value="medium">中风险</option><option value="high">高风险</option></select></label>
      </div>
      <footer><button type="button" className="taskboard-secondary-button" onClick={onCancel}>取消</button><button className="taskboard-primary-button" disabled={busy || !title.trim()}>{busy ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}创建任务</button></footer>
    </form>
  </div>;
}

function TaskDetailDialog({ task, detail, busy, online, onClose, onSave, onSaveDependencies, onTransition, onStart, onArchive, onOpenConversation }: {
  task: TaskboardTask;
  detail: TaskboardProjectDetail;
  busy: boolean;
  online: boolean;
  onClose: () => void;
  onSave: (task: TaskboardTask, input: UpdateTaskInput) => void;
  onSaveDependencies: (task: TaskboardTask, dependencyIds: string[]) => void;
  onTransition: (task: TaskboardTask, status: TaskboardStatus, reason?: string) => void;
  onStart: (task: TaskboardTask) => void;
  onArchive: (task: TaskboardTask) => void;
  onOpenConversation: (task: TaskboardTask) => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [criteria, setCriteria] = useState(task.acceptanceCriteria);
  const [priority, setPriority] = useState(task.priority);
  const [risk, setRisk] = useState(task.risk);
  const [dependencyIds, setDependencyIds] = useState(() => detail.dependencies.filter((relation) => relation.task_id === task.id).map((relation) => relation.depends_on_task_id));
  const dependenciesEditable = ["backlog", "ready", "blocked"].includes(task.status);
  const metadataDirty = title !== task.title || description !== task.description || criteria !== task.acceptanceCriteria || priority !== task.priority || risk !== task.risk;
  const originalDependencies = detail.dependencies.filter((relation) => relation.task_id === task.id).map((relation) => relation.depends_on_task_id).sort();
  const dependenciesDirty = JSON.stringify([...dependencyIds].sort()) !== JSON.stringify(originalDependencies);

  return <div className="taskboard-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="taskboard-dialog task-detail-dialog" role="dialog" aria-modal="true" aria-label={`任务 ${task.title}`}>
      <header><div><span className={`task-status-dot ${task.status}`} /><strong>{COLUMNS.find((column) => column.status === task.status)?.label}</strong></div><button type="button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header>
      <label>任务标题<input maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>任务说明<textarea maxLength={30_000} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
      <label>验收标准<textarea maxLength={15_000} value={criteria} onChange={(event) => setCriteria(event.target.value)} /></label>
      <div className="taskboard-form-grid two">
        <label>优先级<select value={priority} onChange={(event) => setPriority(event.target.value as TaskboardPriority)}><option value="urgent">紧急</option><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></label>
        <label>风险<select value={risk} onChange={(event) => setRisk(event.target.value as TaskboardRisk)}><option value="low">低风险</option><option value="medium">中风险</option><option value="high">高风险</option></select></label>
      </div>
      <fieldset className="taskboard-dependencies" disabled={!dependenciesEditable || busy}><legend>前置依赖</legend>
        {detail.tasks.filter((candidate) => candidate.id !== task.id).length === 0 ? <p>当前没有其他任务</p> : detail.tasks.filter((candidate) => candidate.id !== task.id).map((candidate) => <label key={candidate.id}><input type="checkbox" checked={dependencyIds.includes(candidate.id)} onChange={(event) => setDependencyIds((current) => event.target.checked ? [...current, candidate.id] : current.filter((id) => id !== candidate.id))} /><span>{candidate.title}</span><small>{COLUMNS.find((column) => column.status === candidate.status)?.label}</small></label>)}
      </fieldset>
      <div className="taskboard-dialog-actions">
        <button type="button" className="taskboard-secondary-button" disabled={busy || !metadataDirty || !title.trim()} onClick={() => onSave(task, { title, description, acceptanceCriteria: criteria, priority, risk })}>保存内容</button>
        <button type="button" className="taskboard-secondary-button" disabled={busy || !dependenciesDirty || !dependenciesEditable} onClick={() => onSaveDependencies(task, dependencyIds)}>保存依赖</button>
        {!(task.status === "running" && !task.executionStatus) && <button type="button" className="taskboard-work-button" disabled={busy || !online} onClick={() => onOpenConversation(task)}>{task.conversationId ? <ExternalLink size={15} /> : <Bot size={15} />}{task.conversationId ? "打开工作会话" : "建立工作会话"}</button>}
        {task.status === "running" && !task.executionStatus && <button type="button" className="taskboard-start-button" disabled={busy || !online} onClick={() => onStart(task)}><Bot size={15} />立即启动开发</button>}
      </div>
      <div className="taskboard-transition-actions">
        {task.allowedTransitions.map((status) => <button type="button" key={status} disabled={busy} className={status === "done" ? "accept" : status === "cancelled" ? "danger" : ""} onClick={() => onTransition(task, status)}>{transitionLabel(task.status, status)}<ArrowRight size={14} /></button>)}
      </div>
      {["done", "cancelled"].includes(task.status) && <button type="button" className="taskboard-archive-task" disabled={busy} onClick={() => onArchive(task)}><Archive size={15} />归档任务</button>}
      {task.status === "review" && <p className="taskboard-review-note"><ShieldCheck size={15} />只有你点击“验收通过”后，这张任务卡才会完成。</p>}
      {task.status === "blocked" && task.executionMessage && <p className="taskboard-blocked-note"><TriangleAlert size={15} />{task.executionMessage}</p>}
      {!online && <p className="taskboard-offline-note"><TriangleAlert size={15} />远端项目离线；任务保持原执行位置，不会回退到 Tenant。</p>}
    </section>
  </div>;
}

function executorLabel(target: ExecutorTarget, workers: RemoteWorkerStatus[]): string {
  if (target.kind === "tenant") return "隔离 Tenant";
  for (const worker of workers) {
    const project = worker.projects.find((candidate) => candidate.id === target.projectId);
    if (project) return `${project.name} · ${worker.displayName}`;
  }
  return `${target.projectId} · 离线`;
}

function executionLabel(status: TaskboardTask["executionStatus"]): string {
  if (status === "queued") return "已进入持久队列";
  if (status === "running") return "Codex 正在执行";
  if (status === "completed") return "执行完成";
  if (status === "failed") return "执行失败";
  if (status === "cancelled") return "执行已取消";
  if (status === "interrupted") return "执行已中断";
  return "尚未真正启动";
}
