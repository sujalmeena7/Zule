// ============================================
// Zule AI — Unified Model Loader Queue UI
// ============================================
//
// A single floating indicator that displays progress for ALL model
// downloads in the application: embedding model, Whisper model, Tesseract
// language packs, and any future downloadable assets.
//
// Requirements:
// - (20.4) Single ModelLoader queue for all background asset downloads,
//   not overlapping toasts.
// - (21.4) Percentage progress with user-initiated cancel.
//
// The component subscribes to the centralised `modelDownloadRegistry`
// which aggregates progress from vectorStore, WhisperProvider, and
// OCR language pack loading.

import React, { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Brain, CheckCircle2, XCircle, X, AlertTriangle } from 'lucide-react';
import {
  modelDownloadRegistry,
  type DownloadTask,
  type DownloadStatus,
} from '../../brain/modelDownloadRegistry';

// ---- Helper to convert map to sorted array ----

function tasksToArray(tasks: ReadonlyMap<string, DownloadTask>): DownloadTask[] {
  return Array.from(tasks.values());
}

// ---- Sub-component: single task row ----

interface TaskRowProps {
  task: DownloadTask;
  onCancel: (id: string) => void;
  onDismiss: (id: string) => void;
}

const statusIcon = (status: DownloadStatus) => {
  switch (status) {
    case 'downloading':
      return <Brain className="w-4 h-4 text-blue-400 animate-pulse" />;
    case 'ready':
      return <CheckCircle2 className="w-4 h-4 text-green-400" />;
    case 'error':
      return <AlertTriangle className="w-4 h-4 text-red-400" />;
    case 'cancelled':
      return <XCircle className="w-4 h-4 text-gray-400" />;
  }
};

const TaskRow: React.FC<TaskRowProps> = ({ task, onCancel, onDismiss }) => {
  const isActive = task.status === 'downloading';
  const isDone = task.status === 'ready';
  const isTerminal = task.status === 'ready' || task.status === 'error' || task.status === 'cancelled';

  return (
    <motion.div
      layout
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      className="flex items-center gap-2 px-3 py-2"
    >
      {/* Status icon */}
      <div className="flex-shrink-0">{statusIcon(task.status)}</div>

      {/* Label and progress */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-white truncate">
            {task.label}
          </span>
          {isActive && (
            <span className="text-[10px] text-gray-400 ml-2 flex-shrink-0">
              {Math.round(task.progress)}%
            </span>
          )}
        </div>
        {isActive && (
          <div className="h-1 w-full bg-[#1a1a24] rounded-full mt-1 overflow-hidden">
            <motion.div
              className="h-full bg-gradient-to-r from-blue-500 to-purple-500"
              initial={{ width: 0 }}
              animate={{ width: `${task.progress}%` }}
              transition={{ ease: 'linear', duration: 0.2 }}
            />
          </div>
        )}
        {task.status === 'error' && task.errorMessage && (
          <span className="text-[10px] text-red-400 truncate block mt-0.5">
            {task.errorMessage}
          </span>
        )}
      </div>

      {/* Action button: cancel (while downloading) or dismiss (when done) */}
      {isActive && task.cancel && (
        <button
          onClick={() => onCancel(task.id)}
          className="flex-shrink-0 p-0.5 rounded hover:bg-white/10 transition-colors"
          aria-label={`Cancel ${task.label} download`}
          title="Cancel download"
        >
          <X className="w-3.5 h-3.5 text-gray-400 hover:text-white" />
        </button>
      )}
      {isTerminal && (
        <button
          onClick={() => onDismiss(task.id)}
          className="flex-shrink-0 p-0.5 rounded hover:bg-white/10 transition-colors"
          aria-label={`Dismiss ${task.label}`}
          title={isDone ? 'Dismiss' : 'Remove'}
        >
          <X className="w-3.5 h-3.5 text-gray-500 hover:text-white" />
        </button>
      )}
    </motion.div>
  );
};

// ---- Main component ----

export const ModelLoader: React.FC = () => {
  const [tasks, setTasks] = useState<DownloadTask[]>([]);

  useEffect(() => {
    const unsubscribe = modelDownloadRegistry.subscribe((taskMap) => {
      setTasks(tasksToArray(taskMap));
    });
    return unsubscribe;
  }, []);

  // Auto-dismiss completed tasks after 3 seconds
  useEffect(() => {
    const completedIds = tasks
      .filter((t) => t.status === 'ready')
      .map((t) => t.id);

    if (completedIds.length === 0) return;

    const timers = completedIds.map((id) =>
      setTimeout(() => {
        modelDownloadRegistry.remove(id);
      }, 3000),
    );

    return () => {
      timers.forEach(clearTimeout);
    };
  }, [tasks]);

  const handleCancel = useCallback((id: string) => {
    modelDownloadRegistry.cancel(id);
  }, []);

  const handleDismiss = useCallback((id: string) => {
    modelDownloadRegistry.remove(id);
  }, []);

  const visibleTasks = tasks.filter(
    (t) => t.status !== 'cancelled' || true, // show cancelled briefly
  );
  const isVisible = visibleTasks.length > 0;

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          initial={{ opacity: 0, y: 20, scale: 0.9 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 10, scale: 0.95 }}
          className="fixed bottom-6 right-6 z-50 bg-[#111116] border border-[#2a2a35] rounded-xl shadow-2xl overflow-hidden"
          style={{ backdropFilter: 'blur(10px)', minWidth: '260px', maxWidth: '340px' }}
          role="status"
          aria-live="polite"
          aria-label="Model download progress"
        >
          {/* Header */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-[#2a2a35]">
            <Brain className="w-4 h-4 text-blue-400" />
            <span className="text-xs font-semibold text-white">
              {tasks.some((t) => t.status === 'downloading')
                ? 'Downloading Models...'
                : 'Model Status'}
            </span>
          </div>

          {/* Task queue */}
          <div className="divide-y divide-[#1a1a24]">
            <AnimatePresence>
              {visibleTasks.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  onCancel={handleCancel}
                  onDismiss={handleDismiss}
                />
              ))}
            </AnimatePresence>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
