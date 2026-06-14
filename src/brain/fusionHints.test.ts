import { describe, it, expect } from 'vitest';
import { detectFusionHints } from './fusionHints';

describe('detectFusionHints', () => {
  it('returns empty array when screenText is empty', () => {
    expect(detectFusionHints('', ['Hello World'])).toEqual([]);
  });

  it('returns empty array when transcript is empty', () => {
    expect(detectFusionHints('Some Screen Text', [])).toEqual([]);
  });

  it('returns empty array when there are no overlapping entities', () => {
    const screen = 'The dashboard shows revenue for Project Alpha.';
    const transcript = ['We need to discuss the timeline for delivery.'];
    expect(detectFusionHints(screen, transcript)).toEqual([]);
  });

  it('detects overlapping capitalised multi-word phrases', () => {
    const screen = 'Q3 Budget is displayed. Alice Smith presented.';
    const transcript = ['Alice Smith mentioned the Q3 Budget yesterday.'];
    const hints = detectFusionHints(screen, transcript);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain('Alice Smith');
    expect(hints[0]).toContain('Q3 Budget');
    expect(hints[0]).toMatch(/^Both screen and audio mention:/);
  });

  it('detects overlapping single capitalised words (non-stop words)', () => {
    const screen = 'Alice joined the meeting about Kubernetes.';
    const transcript = ['Alice was explaining Kubernetes features.'];
    const hints = detectFusionHints(screen, transcript);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain('Alice');
    expect(hints[0]).toContain('Kubernetes');
  });

  it('detects overlapping numbers', () => {
    const screen = 'Total revenue: $500,000. Growth: 15%.';
    const transcript = ['We hit $500,000 in revenue this quarter, which is 15% growth.'];
    const hints = detectFusionHints(screen, transcript);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain('$500,000');
    expect(hints[0]).toContain('15%');
  });

  it('detects overlapping URLs', () => {
    const screen = 'Visit https://example.com/docs for more info.';
    const transcript = ['Check https://example.com/docs for the API reference.'];
    const hints = detectFusionHints(screen, transcript);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain('https://example.com/docs');
  });

  it('excludes stop words from single-word matches', () => {
    const screen = 'The project is going well. This is great.';
    const transcript = ['The team thinks This is a great approach.'];
    // 'The' and 'This' are stop words and should not match
    expect(detectFusionHints(screen, transcript)).toEqual([]);
  });

  it('caps overlapping entities at 8', () => {
    // Create text with many overlapping entities
    const names = Array.from({ length: 12 }, (_, i) => `Entity${String.fromCharCode(65 + i)}`);
    const screen = names.join(' ');
    const transcript = [names.join(' ')];
    const hints = detectFusionHints(screen, transcript);
    expect(hints).toHaveLength(1);
    // Count the quoted entities in the hint
    const quotedMatches = hints[0].match(/'/g);
    // Each entity is wrapped in single quotes (2 per entity), max 8 entities = 16 quotes
    expect(quotedMatches!.length).toBeLessThanOrEqual(16);
  });

  it('returns deterministic output (sorted entities)', () => {
    const screen = 'Zebra Corp and Alpha Inc are partners.';
    const transcript = ['Alpha Inc and Zebra Corp signed a deal.'];
    const hints1 = detectFusionHints(screen, transcript);
    const hints2 = detectFusionHints(screen, transcript);
    expect(hints1).toEqual(hints2);
    // Alpha Inc should come before Zebra Corp alphabetically
    const idx1 = hints1[0].indexOf('Alpha Inc');
    const idx2 = hints1[0].indexOf('Zebra Corp');
    expect(idx1).toBeLessThan(idx2);
  });
});
