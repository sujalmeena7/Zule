export interface ArtifactManifest {
  schemaVersion: 1;
  buildHash: string;
  artifacts: Record<string, string>;
}
export function createArtifactManifest(artifactsDirectory: string): ArtifactManifest;
export function main(argv: string[]): ArtifactManifest;
