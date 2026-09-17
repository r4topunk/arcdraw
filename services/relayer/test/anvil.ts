import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import type { Abi, Hex } from "viem";

export const CONTRACTS_OUT = fileURLToPath(new URL("../../../contracts/out", import.meta.url));

export const anvilAvailable = (): boolean =>
  spawnSync("anvil", ["--version"], { stdio: "ignore" }).status === 0 &&
  existsSync(`${CONTRACTS_OUT}/ArcDrawCoordinator.sol/ArcDrawCoordinator.json`) &&
  existsSync(`${CONTRACTS_OUT}/MockUSDC.sol/MockUSDC.json`);

export function artifact(file: string, name: string): { abi: Abi; bytecode: Hex } {
  const json = JSON.parse(readFileSync(`${CONTRACTS_OUT}/${file}/${name}.json`, "utf8"));
  return { abi: json.abi, bytecode: json.bytecode.object };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === "object" && addr ? resolve(addr.port) : reject(new Error("no port"))));
    });
  });
}

/** Local anvil with the Osaka hardfork (EIP-2537 precompiles). Uses anvil's unlocked dev accounts: no keys handled here. */
export async function startAnvil(opts: { timestamp: bigint }): Promise<{ url: string; stop: () => void }> {
  const port = await freePort();
  const proc: ChildProcess = spawn(
    "anvil",
    ["--port", String(port), "--hardfork", "osaka", "--timestamp", opts.timestamp.toString(), "--silent"],
    { stdio: "ignore" },
  );
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) return { url, stop: () => proc.kill("SIGTERM") };
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill("SIGKILL");
  throw new Error("anvil did not start");
}
