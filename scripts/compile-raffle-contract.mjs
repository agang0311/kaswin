import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const silverscriptDir = path.join(root, ".tools", "silverscript");
const sourcePath = path.join(root, "src", "contracts", "raffle_round.sil");
const outputPath = path.join(root, "src", "contracts", "compiled", "raffle-round.silverc.json");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    shell: false,
    stdio: "inherit"
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function commandExists(command, env = process.env) {
  const probe = spawnSync(process.platform === "win32" ? "where.exe" : "which", [command], {
    env,
    shell: false,
    stdio: "ignore"
  });

  return probe.status === 0;
}

function buildWindowsGnuRisc0Stub(env) {
  const stubDir = path.join(os.tmpdir(), "kaspa_silverscript");
  const stubC = path.join(stubDir, "risc0_stub.c");
  const stubO = path.join(stubDir, "risc0_stub.o");

  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(
    stubC,
    `#include <stddef.h>

static unsigned char RISC0_STUB_HEAP[1048576];
static size_t RISC0_STUB_OFFSET = 0;

void* sys_alloc_aligned(size_t size, size_t alignment) {
    size_t mask = alignment ? alignment - 1 : 0;
    size_t start = (RISC0_STUB_OFFSET + mask) & ~mask;
    if (start + size > sizeof(RISC0_STUB_HEAP)) {
        return (void*)0;
    }
    RISC0_STUB_OFFSET = start + size;
    return (void*)(RISC0_STUB_HEAP + start);
}

void sys_free_aligned(void* ptr) {
    (void)ptr;
}
`,
    "utf8"
  );

  run("gcc", ["-c", stubC, "-o", stubO], { env });
  return stubO;
}

if (!fs.existsSync(silverscriptDir)) {
  throw new Error("Missing .tools/silverscript. Clone https://github.com/kaspanet/silverscript.git there first.");
}

const env = { ...process.env };

if (process.platform === "win32") {
  const cargoBin = path.join(os.homedir(), ".cargo", "bin");
  const mingwBin = "C:\\msys64\\mingw64\\bin";
  env.Path = [mingwBin, cargoBin, env.Path].filter(Boolean).join(path.delimiter);

  if (commandExists("gcc", env)) {
    const stubO = buildWindowsGnuRisc0Stub(env);
    env.RUSTFLAGS = [env.RUSTFLAGS, `-C link-arg=${stubO}`].filter(Boolean).join(" ");
  }
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });

const cargo = process.platform === "win32" ? "rustup" : "cargo";
const cargoArgs =
  process.platform === "win32"
    ? [
        "run",
        "stable-x86_64-pc-windows-gnu",
        "cargo",
        "run",
        "-p",
        "silverscript-lang",
        "--bin",
        "silverc",
        "--",
        sourcePath,
        "-o",
        outputPath
      ]
    : ["run", "-p", "silverscript-lang", "--bin", "silverc", "--", sourcePath, "-o", outputPath];

run(cargo, cargoArgs, { cwd: silverscriptDir, env });
console.log(`Compiled ${sourcePath} to ${outputPath}`);
