// ============================================
// Zule AI — Model Download Registry
// ============================================
//
// A centralised registry that collects progress events from all model
// download sources (embedding model, Whisper model, Tesseract language
// packs, and any future models). The `ModelLoader` component subscribes
// to this registry to render a single unified progress queue rather than
// overlapping toasts or separate indicators.
//
// Requirements:
// - (20.4) Single ModelLoader queue for all background asset downloads.
// - (21.4) Percentage progress with user-initiated cancel.

// ---- Types ----

export type DownloadStatus = 'downloading' | 'ready' | 'error' | 'cancelled';

export interface DownloadTask {
  /** Unique id for this download task (e.g. 'embedding-model', 'whisper-model', 'tesseract-en'). */
  id: string;
  /** Human-readable label. */
  label: string;
  /** Current status. */
  status: DownloadStatus;
  /** Progress percentage 0–100. */
  progress: number;
  /** Bytes loaded so far. */
  loaded: number;
  /** Total bytes (0 if unknown). */
  total: number;
  /** Error message if status === 'error'. */
  errorMessage?: string;
  /** Cancel function provided by the source. Undefined if not cancellable. */
  cancel?: () => void;
}

export type RegistryListener = (tasks: ReadonlyMap<string, DownloadTask>) => void;

// ---- Registry implementation ----

class ModelDownloadRegistryImpl {
  private tasks: Map<string, DownloadTask> = new Map();
  private listeners: Set<RegistryListener> = new Set();

  /**
   * Register or update a download task in the queue.
   */
  upsert(task: DownloadTask): void {
    this.tasks.set(task.id, { ...task });
    this.notify();
  }

  /**
   * Remove a task from the queue (e.g. after it completes and the UI has
   * dismissed it).
   */
  remove(id: string): void {
    this.tasks.delete(id);
    this.notify();
  }

  /**
   * Cancel a specific task by id.
   */
  cancel(id: string): void {
    const task = this.tasks.get(id);
    if (task && task.cancel) {
      task.cancel();
      this.tasks.set(id, { ...task, status: 'cancelled', progress: task.progress });
      this.notify();
    }
  }

  /**
   * Get the current snapshot of all tasks.
   */
  getAll(): ReadonlyMap<string, DownloadTask> {
    return this.tasks;
  }

  /**
   * Subscribe to changes. Returns an unsubscribe function.
   */
  subscribe(listener: RegistryListener): () => void {
    this.listeners.add(listener);
    // Immediately deliver the current state
    listener(this.tasks);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this.tasks);
    }
  }
}

/**
 * Singleton registry. Imported by progress sources (vectorStore, whisper,
 * OCR worker) and the ModelLoader component.
 */
export const modelDownloadRegistry = new ModelDownloadRegistryImpl();
