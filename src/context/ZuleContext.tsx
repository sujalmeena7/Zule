// ============================================
// Zule AI — Global State Context
// ============================================

import {
  createContext,
  useContext,
  useReducer,
  useEffect,
  useCallback,
  type ReactNode,
} from 'react';
import { database as storage, type StoredMeeting, type CustomMode } from '../data/database';
import type { CopilotMode } from '../brain/modePrompts';
import { isElectron } from '../hooks/useElectronBridge';

// ---- Page & Hash Routing ----

export type Page = 'landing' | 'auth' | 'dashboard' | 'copilot' | 'meeting-detail' | 'settings' | 'diagnostics' | 'blog' | 'blog-post';

const PAGE_TO_HASH: Record<Page, string> = {
  landing: '',
  auth: '#auth',
  dashboard: '#dashboard',
  copilot: '#copilot',
  'meeting-detail': '#meeting-detail',
  settings: '#settings',
  diagnostics: '#diagnostics',
  blog: '#blog',
  'blog-post': '#blog-post',
};

const HASH_TO_PAGE: Record<string, Page> = {
  '': 'landing',
  '#': 'landing',
  '#auth': 'auth',
  '#dashboard': 'dashboard',
  '#copilot': 'copilot',
  '#meeting-detail': 'meeting-detail',
  '#settings': 'settings',
  '#diagnostics': 'diagnostics',
  '#blog': 'blog',
  '#blog-post': 'blog-post',
};

function pageFromHash(): Page {
  const hash = window.location.hash;
  if (!hash || hash === '#') {
    // Desktop app skips the marketing landing page and goes straight to dashboard
    return isElectron() ? 'dashboard' : 'landing';
  }
  return HASH_TO_PAGE[hash] ?? (isElectron() ? 'dashboard' : 'landing');
}

// ---- State ----

export interface ZuleState {
  currentPage: Page;
  apiKey: string;
  theme: 'dark' | 'light';
  defaultMode: CopilotMode;
  meetings: StoredMeeting[];
  selectedMeeting: StoredMeeting | null;
  customModes: CustomMode[];
  isCopilotActive: boolean;
  activeBlogPost: string | null;
}

const initialState: ZuleState = {
  currentPage: pageFromHash(),
  apiKey: '',
  theme: 'dark',
  defaultMode: 'assist',
  meetings: [],
  selectedMeeting: null,
  customModes: [],
  isCopilotActive: false,
  activeBlogPost: null,
};

// ---- Actions ----

type ZuleAction =
  | { type: 'SET_PAGE'; payload: Page }
  | { type: 'SET_API_KEY'; payload: string }
  | { type: 'SET_THEME'; payload: 'dark' | 'light' }
  | { type: 'SET_DEFAULT_MODE'; payload: CopilotMode }
  | { type: 'SET_MEETINGS'; payload: StoredMeeting[] }
  | { type: 'SET_SELECTED_MEETING'; payload: StoredMeeting | null }
  | { type: 'SET_CUSTOM_MODES'; payload: CustomMode[] }
  | { type: 'START_COPILOT'; payload?: CopilotMode }
  | { type: 'STOP_COPILOT'; payload: StoredMeeting }
  | { type: 'ADD_MEETING'; payload: StoredMeeting }
  | { type: 'DELETE_MEETING'; payload: string }
  | { type: 'SET_ACTIVE_BLOG_POST'; payload: string | null };

function zuleReducer(state: ZuleState, action: ZuleAction): ZuleState {
  switch (action.type) {
    case 'SET_PAGE':
      return { ...state, currentPage: action.payload };

    case 'SET_API_KEY':
      return { ...state, apiKey: action.payload };

    case 'SET_THEME':
      return { ...state, theme: action.payload };

    case 'SET_DEFAULT_MODE':
      return { ...state, defaultMode: action.payload };

    case 'SET_MEETINGS':
      return { ...state, meetings: action.payload };

    case 'SET_SELECTED_MEETING':
      return { ...state, selectedMeeting: action.payload };

    case 'SET_CUSTOM_MODES':
      return { ...state, customModes: action.payload };

    case 'START_COPILOT':
      return {
        ...state,
        defaultMode: action.payload ?? state.defaultMode,
        isCopilotActive: true,
        currentPage: 'copilot',
      };

    case 'STOP_COPILOT':
      return {
        ...state,
        isCopilotActive: false,
        selectedMeeting: action.payload,
        currentPage: 'meeting-detail',
      };

    case 'ADD_MEETING':
      return {
        ...state,
        meetings: [action.payload, ...state.meetings],
      };

    case 'DELETE_MEETING':
      return {
        ...state,
        meetings: state.meetings.filter((m) => m.id !== action.payload),
        selectedMeeting:
          state.selectedMeeting?.id === action.payload
            ? null
            : state.selectedMeeting,
        currentPage:
          state.selectedMeeting?.id === action.payload
            ? 'dashboard'
            : state.currentPage,
      };

    case 'SET_ACTIVE_BLOG_POST':
      return { ...state, activeBlogPost: action.payload };

    default:
      return state;
  }
}

// ---- Context Shape ----

interface ZuleActions {
  navigateTo: (page: Page) => void;
  updateApiKey: (key: string) => Promise<void>;
  updateTheme: (theme: 'dark' | 'light') => Promise<void>;
  updateDefaultMode: (mode: CopilotMode) => Promise<void>;
  startCopilot: (mode?: CopilotMode) => void;
  stopCopilot: (meeting: StoredMeeting) => Promise<void>;
  viewMeeting: (meeting: StoredMeeting) => void;
  deleteMeeting: (id: string) => Promise<void>;
  saveCustomMode: (mode: CustomMode) => Promise<void>;
  deleteCustomMode: (id: string) => Promise<void>;
  viewBlogPost: (slug: string) => void;
}

interface ZuleContextValue {
  state: ZuleState;
  actions: ZuleActions;
  dispatch: React.Dispatch<ZuleAction>;
}

const ZuleContext = createContext<ZuleContextValue | null>(null);

// ---- Provider ----

interface ZuleProviderProps {
  children: ReactNode;
}

export function ZuleProvider({ children }: ZuleProviderProps) {
  const [state, dispatch] = useReducer(zuleReducer, initialState);

  // --- Load initial state from IndexedDB ---
  useEffect(() => {
    async function loadPersistedState() {
      const [apiKey, theme, defaultMode, meetings, customModes] = await Promise.all([
        storage.getSetting<string>('apiKey', ''),
        storage.getSetting<'dark' | 'light'>('theme', 'dark'),
        storage.getSetting<CopilotMode>('defaultMode', 'assist'),
        storage.getAllMeetings(),
        storage.getAllCustomModes(),
      ]);
      dispatch({ type: 'SET_API_KEY', payload: apiKey });
      dispatch({ type: 'SET_THEME', payload: theme });
      dispatch({ type: 'SET_DEFAULT_MODE', payload: defaultMode });
      dispatch({ type: 'SET_MEETINGS', payload: meetings });
      dispatch({ type: 'SET_CUSTOM_MODES', payload: customModes });
    }
    loadPersistedState();
  }, []);

  // --- Apply theme to document ---
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', state.theme);
  }, [state.theme]);

  // --- Sync hash with current page ---
  // --- Sync hash with current page ---
  useEffect(() => {
    // Skip hash sync entirely in the overlay window. The overlay loads at
    // #overlay (used by main.tsx and FloatingCopilot to detect overlay mode)
    // and has no Page mapping, so syncing would clobber the hash with
    // #dashboard and break overlay detection mid-session.
    if ((window as Window & { __zuleIsOverlay?: boolean }).__zuleIsOverlay) {
      return;
    }
    const targetHash = PAGE_TO_HASH[state.currentPage];
    if (window.location.hash !== targetHash) {
      window.location.hash = targetHash;
    }
  }, [state.currentPage]);

  // --- Listen for browser back/forward ---
  useEffect(() => {
    function handleHashChange() {
      const page = pageFromHash();
      dispatch({ type: 'SET_PAGE', payload: page });
    }
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  // --- Action creators (dispatch + IndexedDB sync) ---

  const navigateTo = useCallback(
    (page: Page) => {
      dispatch({ type: 'SET_PAGE', payload: page });
    },
    [],
  );

  const updateApiKey = useCallback(
    async (key: string) => {
      dispatch({ type: 'SET_API_KEY', payload: key });
      await storage.setSetting('apiKey', key);
    },
    [],
  );

  const updateTheme = useCallback(
    async (theme: 'dark' | 'light') => {
      dispatch({ type: 'SET_THEME', payload: theme });
      await storage.setSetting('theme', theme);
    },
    [],
  );

  const updateDefaultMode = useCallback(
    async (mode: CopilotMode) => {
      dispatch({ type: 'SET_DEFAULT_MODE', payload: mode });
      await storage.setSetting('defaultMode', mode);
    },
    [],
  );

  const startCopilot = useCallback(
    (mode?: CopilotMode) => {
      dispatch({ type: 'START_COPILOT', payload: mode });
      // In Electron: spawn the overlay as a separate always-on-top window
      if (isElectron()) {
        window.electronAPI!.startOverlay();
      }
    },
    [],
  );

  const stopCopilot = useCallback(
    async (meeting: StoredMeeting) => {
      dispatch({ type: 'STOP_COPILOT', payload: meeting });
      // In Electron: destroy the overlay window
      if (isElectron()) {
        window.electronAPI!.stopOverlay();
      }
      await storage.saveMeeting(meeting);
      const updated = await storage.getAllMeetings();
      dispatch({ type: 'SET_MEETINGS', payload: updated });
    },
    [],
  );

  const viewMeeting = useCallback(
    (meeting: StoredMeeting) => {
      dispatch({ type: 'SET_SELECTED_MEETING', payload: meeting });
      dispatch({ type: 'SET_PAGE', payload: 'meeting-detail' });
    },
    [],
  );

  const deleteMeeting = useCallback(
    async (id: string) => {
      dispatch({ type: 'DELETE_MEETING', payload: id });
      await storage.deleteMeeting(id);
      const updated = await storage.getAllMeetings();
      dispatch({ type: 'SET_MEETINGS', payload: updated });
    },
    [],
  );

  const saveCustomMode = useCallback(
    async (mode: CustomMode) => {
      await storage.saveCustomMode(mode);
      const updated = await storage.getAllCustomModes();
      dispatch({ type: 'SET_CUSTOM_MODES', payload: updated });
    },
    []
  );

  const deleteCustomMode = useCallback(
    async (id: string) => {
      await storage.deleteCustomMode(id);
      const updated = await storage.getAllCustomModes();
      dispatch({ type: 'SET_CUSTOM_MODES', payload: updated });
    },
    []
  );

  const viewBlogPost = useCallback(
    (slug: string) => {
      dispatch({ type: 'SET_ACTIVE_BLOG_POST', payload: slug });
      dispatch({ type: 'SET_PAGE', payload: 'blog-post' });
    },
    []
  );

  const actions: ZuleActions = {
    navigateTo,
    updateApiKey,
    updateTheme,
    updateDefaultMode,
    startCopilot,
    stopCopilot,
    viewMeeting,
    deleteMeeting,
    saveCustomMode,
    deleteCustomMode,
    viewBlogPost,
  };

  return (
    <ZuleContext.Provider value={{ state, actions, dispatch }}>
      {children}
    </ZuleContext.Provider>
  );
}

// ---- Hook ----

export function useZule(): ZuleContextValue {
  const context = useContext(ZuleContext);
  if (!context) {
    throw new Error('useZule must be used within a ZuleProvider');
  }
  return context;
}
