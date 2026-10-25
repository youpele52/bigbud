import { runV2ProductionGenerationsFixture } from "./Orchestration.production.generations.fixture.ts";

// Test-only compiler entry. Production modules, HTTP dispatcher, SQLite and immutable handlers
// are bundled with release compiler policy; synthetic native eligibility is never a shipping entry.
console.log(JSON.stringify(await runV2ProductionGenerationsFixture()));
