import type { ArtifactManifest } from './artifact-manifest.mjs';
export interface EvidenceArchive {
  evidence: { buildHash: string; artifactHashes: Record<string, string>; matrix: unknown[]; results: unknown[]; assembledAt: string };
  evidenceSignature: string;
  decision: { outcome: 'approved' | 'failed'; buildHash: string | null; approvalId: string | null; failures: Array<{ reason: string }> };
  archivedAt: string;
}
export function expectedMatrix(): unknown[];
export function assembleEvidence(manifest: ArtifactManifest, results: unknown[], assembledAt?: string): EvidenceArchive;
export function main(argv: string[]): EvidenceArchive;
