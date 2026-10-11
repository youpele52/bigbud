export interface CheckpointTestFixture {
  directory: string;
  build: string;
  toolchain: {
    version: string;
    policy: { packageManager: string; supported: string };
    options: object;
  };
  env: {
    BIGBUD_CHECKPOINT_FIXTURE: string;
    BIGBUD_CHECKPOINT_FIXTURE_TICKET: string;
    BIGBUD_CHECKPOINT_OWNED_TREE: string;
  };
  dispose(): Promise<void>;
}
export function createCheckpointTestFixture(options?: {
  temporaryRoot?: string;
}): Promise<CheckpointTestFixture>;
export function checkpointTestFixtureFromEnvironment(): Promise<string>;
