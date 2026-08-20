import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { BridgeState, FeaturePair } from "./types.js";
import { featureKey, runtimeDirectory, statePath } from "./paths.js";

const emptyState = (): BridgeState => ({ version: 1, pairs: {} });

export class StateStore {
  private state: BridgeState;

  constructor(private readonly filename = statePath) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.state = this.load();
  }

  private load(): BridgeState {
    if (!fs.existsSync(this.filename)) return emptyState();
    const parsed = JSON.parse(fs.readFileSync(this.filename, "utf8")) as BridgeState;
    if (parsed.version !== 1 || !parsed.pairs) throw new Error("Unsupported bridge state format.");
    return parsed;
  }

  all(): FeaturePair[] {
    return Object.values(this.state.pairs);
  }

  get(feature: string): FeaturePair | undefined {
    return this.state.pairs[featureKey(feature)];
  }

  ensure(feature: string, projectRoot: string): FeaturePair {
    const key = featureKey(feature);
    let pair = this.state.pairs[key];
    if (!pair) {
      pair = {
        feature: key,
        displayName: feature.trim(),
        projectRoot: path.resolve(projectRoot),
        mode: "manual",
        status: "idle",
        autoRound: 0,
        pmSeeded: false,
        updatedAt: new Date().toISOString()
      };
      this.state.pairs[key] = pair;
      this.save();
    } else if (path.resolve(projectRoot) !== pair.projectRoot) {
      throw new Error(`Feature '${feature}' is already paired with ${pair.projectRoot}.`);
    }
    return pair;
  }

  update(feature: string, mutate: (pair: FeaturePair) => void): FeaturePair {
    const pair = this.get(feature);
    if (!pair) throw new Error(`Unknown feature '${feature}'. Launch a paired session first.`);
    mutate(pair);
    pair.updatedAt = new Date().toISOString();
    this.save();
    return pair;
  }

  newPendingId(): string {
    return randomUUID();
  }

  private save(): void {
    fs.mkdirSync(runtimeDirectory, { recursive: true });
    const temporary = `${this.filename}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.filename);
  }
}
