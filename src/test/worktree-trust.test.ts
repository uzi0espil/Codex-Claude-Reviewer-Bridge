import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { inheritWorktreeTrust } from "../worktree-trust.js";

test("paired worktrees inherit only explicit repository trust through versioned Codex writes", async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-trust-"));
  const repository = path.join(fixture, "repo");
  const worktree = path.join(fixture, "worktree");
  const configFile = path.join(fixture, "config.toml");
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", repository, ...args], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    fs.mkdirSync(repository);
    fs.writeFileSync(configFile, "# keep custom configuration\n");
    git("init");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "fixture");
    git("worktree", "add", "--detach", worktree);
    const response = (projects: Record<string, any>) => ({
      config: { projects },
      layers: [{ name: { type: "user", file: configFile }, version: "v1", config: { projects } }]
    });
    const run = async (projects: Record<string, any>) => {
      const calls: any[] = [];
      const changed = await inheritWorktreeTrust(repository, worktree, configFile, async (method, params) => {
        calls.push({ method, params });
        return method === "config/read" ? response(projects) : {};
      });
      return { changed, calls };
    };
    await t.test("writes just the authenticated worktree key, preserving unrelated config", async () => {
      const { changed, calls } = await run({ [repository]: { trust_level: "trusted" } });
      assert.equal(changed, true);
      assert.deepEqual(calls[0], { method: "config/read", params: { cwd: fs.realpathSync(worktree), includeLayers: true } });
      const key = process.platform === "win32" ? fs.realpathSync(worktree).toLowerCase() : fs.realpathSync(worktree);
      assert.deepEqual(calls[1], { method: "config/value/write", params: {
        keyPath: `projects.${JSON.stringify(key)}.trust_level`, value: "trusted",
        mergeStrategy: "replace", filePath: configFile, expectedVersion: "v1"
      } });
      assert.equal(fs.readFileSync(configFile, "utf8"), "# keep custom configuration\n");
    });
    for (const [name, projects] of Object.entries({
      absent: {},
      untrustedRepository: { [repository]: { trust_level: "untrusted" } },
      untrustedWorktree: { [repository]: { trust_level: "trusted" }, [worktree]: { trust_level: "untrusted" } },
      alreadyTrusted: { [repository]: { trust_level: "trusted" }, [worktree]: { trust_level: "trusted" } }
    })) {
      await t.test(name, async () => {
        const { changed, calls } = await run(projects);
        assert.equal(changed, false);
        assert.equal(calls.length, 1);
      });
    }
    await t.test("rejects unrelated folders before reading or writing configuration", async () => {
      await assert.rejects(inheritWorktreeTrust(repository, fixture, configFile, async () => {
        assert.fail("Must authenticate first");
      }), /not a Git worktree root|Cannot inspect/);
    });
    await t.test("does not inherit trust supplied only by a project layer", async () => {
      const config = response({ [repository]: { trust_level: "trusted" } });
      config.layers[0].config.projects = {};
      assert.equal(await inheritWorktreeTrust(repository, worktree, configFile, async (method) => {
        assert.equal(method, "config/read");
        return config;
      }), false);
    });
    await t.test("trust path casing follows the host filesystem convention", async () => {
      const upperCase = repository.toUpperCase();
      const { changed } = await run({ [upperCase]: { trust_level: "trusted" } });
      // macOS may resolve the alias on its default case-insensitive filesystem.
      let aliasesRepository = false;
      try { aliasesRepository = fs.realpathSync(upperCase) === fs.realpathSync(repository); } catch { /* distinct path */ }
      assert.equal(changed, process.platform === "win32" || aliasesRepository);
    });
    await t.test("rechecks explicit denial after a concurrent config edit", async () => {
      let reads = 0;
      let writes = 0;
      assert.equal(await inheritWorktreeTrust(repository, worktree, configFile, async (method) => {
        if (method === "config/read") return response({
          [repository]: { trust_level: "trusted" },
          ...(reads++ ? { [worktree]: { trust_level: "untrusted" } } : {})
        });
        writes++;
        throw new Error("version conflict");
      }), false);
      assert.equal(reads, 2);
      assert.equal(writes, 1);
    });
    await t.test("propagates persistent config write failures", async () => {
      await assert.rejects(inheritWorktreeTrust(repository, worktree, configFile, async (method) => {
        if (method === "config/read") return response({ [repository]: { trust_level: "trusted" } });
        throw new Error("write failed");
      }), /write failed/);
    });
  } finally {
    // The fixture root was created by this test and contains all its worktrees.
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
