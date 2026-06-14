// ============================================
// Zule AI — Copilot Session Context
// ============================================

import {
  createContext,
  useContext,
  useReducer,
  useCallback,
  type ReactNode,
} from 'react';
import type { CopilotMode } from '../brain/modePrompts';
import type { AIResponse } from '../brain/aiProvider';
import type { SentimentResult } from '../brain/sentimentAnalyzer';

// ---- State ----

export interface CopilotState {
  activeMode: CopilotMode;
  isLoading: boolean;
  isStreaming: boolean;
  streamingText: string;
  aiResponse: AIResponse | null;
  aiSuggestionCount: number;
  elapsedTime: number;
  coaching: SentimentResult | null;
}

const initialState: CopilotState = {
  activeMode: 'assist',
  isLoading: false,
  isStreaming: false,
  streamingText: '',
  aiResponse: null,
  aiSuggestionCount: 0,
  elapsedTime: 0,
  coaching: null,
};

// ---- Actions ----

type CopilotAction =
  | { type: 'SET_ACTIVE_MODE'; payload: CopilotMode }
  | { type: 'SET_LOADING'; payload: boolean }
  | { type: 'START_STREAMING' }
  | { type: 'UPDATE_STREAMING_TEXT'; payload: string }
  | { type: 'STOP_STREAMING' }
  | { type: 'SET_AI_RESPONSE'; payload: AIResponse | null }
  | { type: 'INCREMENT_SUGGESTION_COUNT' }
  | { type: 'SET_ELAPSED_TIME'; payload: number }
  | { type: 'SET_COACHING'; payload: SentimentResult | null }
  | { type: 'RESET' };

function copilotReducer(state: CopilotState, action: CopilotAction): CopilotState {
  switch (action.type) {
    case 'SET_ACTIVE_MODE':
      return { ...state, activeMode: action.payload };

    case 'SET_LOADING':
      return { ...state, isLoading: action.payload };

    case 'START_STREAMING':
      return {
        ...state,
        isStreaming: true,
        streamingText: '',
        aiResponse: null,
      };

    case 'UPDATE_STREAMING_TEXT':
      return { ...state, streamingText: action.payload };

    case 'STOP_STREAMING':
      return { ...state, isStreaming: false };

    case 'SET_AI_RESPONSE':
      return {
        ...state,
        aiResponse: action.payload,
        isLoading: false,
        isStreaming: false,
      };

    case 'INCREMENT_SUGGESTION_COUNT':
      return { ...state, aiSuggestionCount: state.aiSuggestionCount + 1 };

    case 'SET_ELAPSED_TIME':
      return { ...state, elapsedTime: action.payload };

    case 'SET_COACHING':
      return { ...state, coaching: action.payload };

    case 'RESET':
      return { ...initialState };

    default:
      return state;
  }
}

// ---- Context Shape ----

interface CopilotActions {
  setActiveMode: (mode: CopilotMode) => void;
  setLoading: (loading: boolean) => void;
  startStreaming: () => void;
  updateStreamingText: (text: string) => void;
  stopStreaming: () => void;
  setAiResponse: (response: AIResponse | null) => void;
  incrementSuggestionCount: () => void;
  setElapsedTime: (seconds: number) => void;
  setCoaching: (result: SentimentResult | null) => void;
  reset: () => void;
}

interface CopilotContextValue {
  state: CopilotState;
  actions: CopilotActions;
  dispatch: React.Dispatch<CopilotAction>;
}

const CopilotContext = createContext<CopilotContextValue | null>(null);

// ---- Provider ----

interface CopilotProviderProps {
  initialMode?: CopilotMode;
  children: ReactNode;
}

export function CopilotProvider({ initialMode, children }: CopilotProviderProps) {
  const [state, dispatch] = useReducer(copilotReducer, {
    ...initialState,
    activeMode: initialMode ?? initialState.activeMode,
  });

  // --- Action creators ---

  const setActiveMode = useCallback(
    (mode: CopilotMode) => dispatch({ type: 'SET_ACTIVE_MODE', payload: mode }),
    [],
  );

  const setLoading = useCallback(
    (loading: boolean) => dispatch({ type: 'SET_LOADING', payload: loading }),
    [],
  );

  const startStreaming = useCallback(
    () => dispatch({ type: 'START_STREAMING' }),
    [],
  );

  const updateStreamingText = useCallback(
    (text: string) => dispatch({ type: 'UPDATE_STREAMING_TEXT', payload: text }),
    [],
  );

  const stopStreaming = useCallback(
    () => dispatch({ type: 'STOP_STREAMING' }),
    [],
  );

  const setAiResponse = useCallback(
    (response: AIResponse | null) => dispatch({ type: 'SET_AI_RESPONSE', payload: response }),
    [],
  );

  const incrementSuggestionCount = useCallback(
    () => dispatch({ type: 'INCREMENT_SUGGESTION_COUNT' }),
    [],
  );

  const setElapsedTime = useCallback(
    (seconds: number) => dispatch({ type: 'SET_ELAPSED_TIME', payload: seconds }),
    [],
  );

  const setCoaching = useCallback(
    (result: SentimentResult | null) => dispatch({ type: 'SET_COACHING', payload: result }),
    [],
  );

  const reset = useCallback(
    () => dispatch({ type: 'RESET' }),
    [],
  );

  const actions: CopilotActions = {
    setActiveMode,
    setLoading,
    startStreaming,
    updateStreamingText,
    stopStreaming,
    setAiResponse,
    incrementSuggestionCount,
    setElapsedTime,
    setCoaching,
    reset,
  };

  return (
    <CopilotContext.Provider value={{ state, actions, dispatch }}>
      {children}
    </CopilotContext.Provider>
  );
}

// ---- Hook ----

export function useCopilot(): CopilotContextValue {
  const context = useContext(CopilotContext);
  if (!context) {
    throw new Error('useCopilot must be used within a CopilotProvider');
  }
  return context;
}
