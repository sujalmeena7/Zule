// ============================================
// Zule AI — Draggable Hook
// ============================================

import { useState, useRef, useCallback, useEffect } from 'react';
import { clampPosition } from '../utils/geometry';

interface Position {
  x: number;
  y: number;
}

interface DraggableHook {
  position: Position;
  setPosition: React.Dispatch<React.SetStateAction<Position>>;
  isDragging: boolean;
  dragRef: React.RefObject<HTMLDivElement | null>;
  handleRef: React.RefObject<HTMLDivElement | null>;
}

export function useDraggable(initialPosition?: Position): DraggableHook {
  const [position, setPosition] = useState<Position>(
    initialPosition || { x: Math.max(20, (window.innerWidth - 400) / 3), y: 60 }
  );
  const [isDragging, setIsDragging] = useState(false);

  const dragRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<HTMLDivElement | null>(null);
  const offsetRef = useRef<Position>({ x: 0, y: 0 });

  const isDraggingRef = useRef(false);

  const onMouseMove = useCallback((e: MouseEvent) => {
    const newX = e.clientX - offsetRef.current.x;
    const newY = e.clientY - offsetRef.current.y;

    // Keep within viewport bounds
    const el = dragRef.current;
    if (el) {
      const rect = el.getBoundingClientRect();
      const maxX = window.innerWidth - rect.width;
      const maxY = window.innerHeight - rect.height;
      setPosition({
        x: Math.max(0, Math.min(newX, maxX)),
        y: Math.max(0, Math.min(newY, maxY)),
      });
    } else {
      setPosition({ x: newX, y: newY });
    }
  }, []);

  const onMouseUp = useCallback(() => {
    setIsDragging(false);
    isDraggingRef.current = false;
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
  }, [onMouseMove]);

  const onMouseDown = useCallback((e: MouseEvent) => {
    // Only allow dragging from the handle
    if (handleRef.current && !handleRef.current.contains(e.target as Node)) return;

    e.preventDefault();
    setIsDragging(true);
    isDraggingRef.current = true;
    const el = dragRef.current;
    if (el) {
      const rect = el.getBoundingClientRect();
      offsetRef.current = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };
    }
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'grabbing';
  }, [onMouseMove, onMouseUp]);

  useEffect(() => {
    const handle = handleRef.current;
    if (handle) {
      handle.addEventListener('mousedown', onMouseDown);
      return () => {
        handle.removeEventListener('mousedown', onMouseDown);
        // Clean up any active document-level drag listeners if unmounting mid-drag
        if (isDraggingRef.current) {
          document.removeEventListener('mousemove', onMouseMove);
          document.removeEventListener('mouseup', onMouseUp);
          document.body.style.userSelect = '';
          document.body.style.cursor = '';
          isDraggingRef.current = false;
        }
      };
    }
  }, [onMouseDown, onMouseMove, onMouseUp]);

  // Resize re-clamp: keep overlay fully on-screen when viewport changes (Req 12.3)
  useEffect(() => {
    const handleResize = () => {
      const el = dragRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const clamped = clampPosition(
        { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        { viewportWidth: window.innerWidth, viewportHeight: window.innerHeight },
      );
      setPosition({ x: clamped.x, y: clamped.y });
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return {
    position,
    setPosition,
    isDragging,
    dragRef,
    handleRef,
  };
}
