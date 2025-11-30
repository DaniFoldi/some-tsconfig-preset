import fs from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import pc from "picocolors"
import prompts from "prompts"
import { detect } from "detect-package-manager"
import semver from "semver"

type PackageJson = {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  scripts?: Record<string, string>
  version?: string
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PRESETS_DIR = path.resolve(__dirname, "..", "presets")
const PACKAGE_NAME = "some-tsconfig-preset"
const FALLBACK_TYPESCRIPT_RANGE = "^5.9.3"

const AVAILABLE_PRESETS = ["base", "node", "react", "react-native", "workers"] as const
type PresetName = (typeof AVAILABLE_PRESETS)[number]

const DETECTION_RULES: Array<{ preset: PresetName; markers: string[] }> = [
  { preset: "react", markers: ["vite"] },
  { preset: "react-native", markers: ["react-native"] },
  { preset: "workers", markers: ["@cloudflare/workers-types"] },
]

const stepIcons = {
  start: pc.cyan("➤"),
  ok: pc.green("✔"),
  fail: pc.red("✖"),
}

async function main() {
  const args = process.argv.slice(2)
  const yes = args.includes("-y") || args.includes("--yes")
  const userPreset = args.find((arg) => !arg.startsWith("-")) as PresetName | undefined

  printHeader()

  try {
    logStep("Checking for package.json", "start")
    const { pkg, pkgPath } = await loadPackageJson(process.cwd())
    logStep("Found package.json", "ok")

    logStep("Ensuring dev dependencies", "start")
    const pm = await detectPackageManager(process.cwd())
    await ensureDevDependencies(pkg, pm, yes)
    logStep("Dev dependencies confirmed", "ok")

    logStep("Resolving preset", "start")
    const preset = await resolvePreset({ pkg, presetArg: userPreset, yes })
    logStep(`Using preset: ${pc.bold(preset)}`, "ok")

    logStep("Setting up scripts", "start")
    await ensureTypecheckScript(pkg, pkgPath)
    logStep("Scripts updated", "ok")

    logStep("Copying preset files", "start")
    await copyPreset(preset, process.cwd())
    logStep("Files copied", "ok")

    logStep(pc.bold(pc.green("All set!")), "ok")
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    logStep(message, "fail")
    process.exitCode = 1
  }
}

function printHeader() {
  const title = pc.bold(pc.cyan("some-tsconfig-preset"))
  const subtitle = pc.dim("Copy a preset into your project with a guided flow.")
  console.log(`${title} ${pc.dim("init")}`)
  console.log(subtitle)
  console.log()
}

function logStep(message: string, kind: "start" | "ok" | "fail") {
  const icon = stepIcons[kind]
  console.log(`${icon} ${message}`)
}

async function loadPackageJson(
  cwd: string,
): Promise<{ pkg: PackageJson; pkgPath: string }> {
  const pkgPath = path.join(cwd, "package.json")
  const exists = await existsFile(pkgPath)
  if (!exists) {
    throw new Error("No package.json found in the current directory.")
  }

  const content = await fs.readFile(pkgPath, "utf8")
  return { pkg: JSON.parse(content) as PackageJson, pkgPath }
}

async function resolvePreset(options: {
  pkg: PackageJson
  presetArg?: PresetName
  yes: boolean
}): Promise<PresetName> {
  const { pkg, presetArg, yes } = options
  const allDependencies = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
  }

  if (presetArg) {
    if (!AVAILABLE_PRESETS.includes(presetArg)) {
      throw new Error(
        `Unknown preset "${presetArg}". Available: ${AVAILABLE_PRESETS.join(", ")}.`,
      )
    }
    return presetArg
  }

  const detected = DETECTION_RULES.find((rule) =>
    rule.markers.some((marker) => marker in allDependencies),
  )

  if (detected) {
    if (yes) {
      return detected.preset
    }
    const confirmed = await confirmPreset(`Use detected preset "${detected.preset}"?`)
    if (confirmed) return detected.preset
  }

  return await selectPreset()
}

async function confirmPreset(question: string): Promise<boolean> {
  const result = await prompts({
    type: "confirm",
    name: "confirm",
    message: question,
    initial: true,
  })

  return Boolean(result.confirm)
}

async function selectPreset(): Promise<PresetName> {
  const result = await prompts({
    type: "select",
    name: "preset",
    message: "Select a preset to copy into this project:",
    choices: AVAILABLE_PRESETS.map((name) => ({
      title: name,
      description: presetDescription(name),
      value: name,
    })),
  })

  if (!result.preset) {
    throw new Error("No preset selected.")
  }

  return result.preset as PresetName
}

async function ensureDevDependencies(
  pkg: PackageJson,
  pm: string,
  yes: boolean,
) {
  const toInstall: Array<{ name: string; version: string }> = []

  const tsRange = await getPeerTypescriptRange()

  const hasTs =
    (pkg.devDependencies && pkg.devDependencies.typescript) ||
    (pkg.dependencies && pkg.dependencies.typescript)
  if (!hasTs) {
    toInstall.push({ name: "typescript", version: tsRange })
  }

  const hasPreset =
    (pkg.devDependencies && pkg.devDependencies[PACKAGE_NAME]) ||
    (pkg.dependencies && pkg.dependencies[PACKAGE_NAME])
  const currentPresetVersion = await getCurrentPackageVersion()
  const presetSpec = currentPresetVersion ? `^${currentPresetVersion}` : "latest"
  if (!hasPreset) {
    toInstall.push({ name: PACKAGE_NAME, version: presetSpec })
  } else if (currentPresetVersion) {
    const existingRange =
      pkg.devDependencies?.[PACKAGE_NAME] ?? pkg.dependencies?.[PACKAGE_NAME]
    const existingMin = existingRange ? semver.minVersion(existingRange) : null
    if (existingMin && semver.lt(existingMin, currentPresetVersion)) {
      toInstall.push({ name: PACKAGE_NAME, version: presetSpec })
    }
  }

  if (toInstall.length === 0) return

  const list = toInstall.map((m) => `${m.name}@${m.version}`).join(", ")
  if (!yes) {
    const result = await prompts({
      type: "confirm",
      name: "confirm",
      message: `Install devDependencies (${list}) using ${pm}?`,
      initial: true,
    })
    if (!result.confirm) return
  }

  const specs = toInstall.map((m) => `${m.name}@${m.version}`)
  const [cmd, ...args] = buildInstallCommand(pm, specs)
  console.log(pc.dim(`Installing devDependencies with ${cmd} ${args.join(" ")}`))
  await runInstall(cmd, args)
  logStep(`Installed devDependencies: ${list}`, "ok")
}

async function ensureTypecheckScript(pkg: PackageJson, pkgPath: string) {
  const scripts = pkg.scripts ?? {}
  if (scripts.typecheck === "tsc -b --noEmit") return

  let message = 'Add package.json script "typecheck": "tsc -b --noEmit"?'
  if (scripts.typecheck && scripts.typecheck !== "tsc -b --noEmit") {
    message = `Replace existing "typecheck" script (${scripts.typecheck}) with "tsc -b --noEmit"?`
  }

  const result = await prompts({
    type: "confirm",
    name: "confirm",
    message,
    initial: true,
  })
  if (!result.confirm) return

  pkg.scripts = { ...scripts, typecheck: "tsc -b --noEmit" }
  await writePackageJson(pkgPath, pkg)
  logStep('Set script "typecheck": "tsc -b --noEmit"', "ok")
}

function presetDescription(preset: PresetName) {
  switch (preset) {
    case "base":
      return "Type-checking and sensible defaults for any project"
    case "node":
      return "Server-side code or scripts with Node APIs"
    case "react":
      return "React web projects"
    case "react-native":
      return "React Native/Expo projects"
    case "workers":
      return "Cloudflare Workers"
    default:
      return ""
  }
}

async function copyPreset(preset: PresetName, destination: string) {
  const presetPath = path.join(PRESETS_DIR, preset)
  const exists = await existsFile(presetPath)
  if (!exists) {
    throw new Error(`Preset "${preset}" was not found in the package.`)
  }

  await fs.cp(presetPath, destination, { recursive: true, force: true })
}

async function existsFile(target: string) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function detectPackageManager(cwd: string) {
  try {
    return await detect({ cwd })
  } catch {
    const ua = process.env.npm_config_user_agent ?? ""
    if (ua.startsWith("pnpm")) return "pnpm"
    if (ua.startsWith("yarn")) return "yarn"
    if (ua.startsWith("npm")) return "npm"
    return "npm"
  }
}

async function writePackageJson(pkgPath: string, pkg: PackageJson) {
  const content = `${JSON.stringify(pkg, null, 2)}\n`
  await fs.writeFile(pkgPath, content, "utf8")
}

function buildInstallCommand(pm: string, specs: string[]): [string, ...string[]] {
  switch (pm) {
    case "pnpm":
      return ["pnpm", "add", "-D", ...specs]
    case "yarn":
      return ["yarn", "add", "-D", ...specs]
    case "bun":
      return ["bun", "add", "-d", ...specs]
    default:
      return ["npm", "install", "-D", ...specs]
  }
}

async function runInstall(cmd: string, args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) return resolve()
      reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`))
    })
  })
}

async function getPeerTypescriptRange() {
  const pkgPath = path.resolve(__dirname, "..", "package.json")
  try {
    const raw = await fs.readFile(pkgPath, "utf8")
    const parsed = JSON.parse(raw) as PackageJson & { peerDependencies?: Record<string, string> }
    const range = parsed.peerDependencies?.typescript
    if (range) return range
  } catch {
    // ignore and fall back
  }
  return FALLBACK_TYPESCRIPT_RANGE
}

async function getCurrentPackageVersion(): Promise<string | null> {
  const pkgPath = path.resolve(__dirname, "..", "package.json")
  try {
    const raw = await fs.readFile(pkgPath, "utf8")
    const parsed = JSON.parse(raw) as PackageJson
    if (parsed.version && semver.valid(parsed.version)) {
      return parsed.version
    }
  } catch {
    // ignore
  }
  return null
}

void main()
