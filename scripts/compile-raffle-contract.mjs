import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const silverscriptDir = path.join(root, ".tools", "silverscript");
const sourceName = process.argv[2] ?? "raffle_round";
const artifactName = sourceName.replaceAll("_", "-");
const sourcePath = path.join(root, "src", "contracts", `${sourceName}.sil`);
const outputPath = path.join(root, "src", "contracts", "compiled", `${artifactName}.silverc.json`);
const runtimeArtifactPath = path.join(root, "src", "contracts", "compiled", `${artifactName}.artifact.json`);

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

function buildWindowsGnuLinkerStub(env) {
  const stubDir = path.join(os.tmpdir(), "kaspa_silverscript");
  const stubC = path.join(stubDir, "linker_stub.c");
  const stubO = path.join(stubDir, "linker_stub.o");

  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(
    stubC,
    `#include <stddef.h>

static unsigned char SILVERC_STUB_HEAP[1048576];
static size_t SILVERC_STUB_OFFSET = 0;

void* sys_alloc_aligned(size_t size, size_t alignment) {
    size_t mask = alignment ? alignment - 1 : 0;
    size_t start = (SILVERC_STUB_OFFSET + mask) & ~mask;
    if (start + size > sizeof(SILVERC_STUB_HEAP)) {
        return (void*)0;
    }
    SILVERC_STUB_OFFSET = start + size;
    return (void*)(SILVERC_STUB_HEAP + start);
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

function assertKeyedBlake2bBuiltin() {
  const compilePath = path.join(silverscriptDir, "silverscript-lang", "src", "compiler", "compile.rs");
  const debugTypesPath = path.join(silverscriptDir, "silverscript-lang", "src", "compiler", "debug_value_types.rs");
  const compileSource = fs.readFileSync(compilePath, "utf8");
  const debugTypesSource = fs.readFileSync(debugTypesPath, "utf8");

  if (
    !compileSource.includes('"OpBlake2bWithKey" => compile_opcode_builtin_call') ||
    !debugTypesSource.includes('"OpBlake2bWithKey"')
  ) {
    throw new Error("SilverScript is missing the pinned OpBlake2bWithKey compiler patch.");
  }
}

if (!fs.existsSync(silverscriptDir)) {
  throw new Error("Missing .tools/silverscript. Clone https://github.com/kaspanet/silverscript.git there first.");
}

assertKeyedBlake2bBuiltin();

const env = { ...process.env };

if (process.platform === "win32") {
  const cargoBin = path.join(os.homedir(), ".cargo", "bin");
  const mingwBin = "C:\\msys64\\mingw64\\bin";
  env.Path = [mingwBin, cargoBin, env.Path].filter(Boolean).join(path.delimiter);

  if (commandExists("gcc", env)) {
    const stubO = buildWindowsGnuLinkerStub(env);
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

const compiled = JSON.parse(fs.readFileSync(outputPath, "utf8"));
const entrypoints = compiled.ast.functions.filter((fn) => fn.entrypoint).map((fn, selector) => ({ name: fn.name, selector }));
const stateFields = (compiled.ast.fields ?? []).map((field) => ({
  name: field.name,
  type: field.type_span?.trim() ?? field.type_ref?.base ?? "unknown"
}));
const runtimeArtifact = {
  contract: compiled.contract_name,
  compilerVersion: compiled.compiler_version,
  source: `../${sourceName}.sil`,
  generatedAt: new Date().toISOString(),
  script: Buffer.from(compiled.script).toString("hex"),
  scriptLength: compiled.script.length,
  withoutSelector: compiled.without_selector,
  abi: compiled.abi.map((entry) => ({
    ...entry,
    selector: entrypoints.find((candidate) => candidate.name === entry.name)?.selector ?? null
  })),
  stateLayout: compiled.state_layout,
  stateFields
};

fs.writeFileSync(runtimeArtifactPath, `${JSON.stringify(runtimeArtifact, null, 2)}\n`, "utf8");
console.log(`Wrote runtime covenant artifact to ${runtimeArtifactPath}`);
