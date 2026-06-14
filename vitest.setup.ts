// Vitest setup file.
// - Wires fake-indexeddb so modules that touch IndexedDB work under jsdom.
// - Loads jest-dom matchers for component-level tests.
import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';
