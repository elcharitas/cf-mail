import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Credentials } from "./send.js";

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const wrangler = join(
  dirname(require.resolve("wrangler/package.json")),
  "bin/wrangler.js",
);
const assets = fileURLToPath(new URL("../assets/", import.meta.url));
const accountIdPattern = /^[a-f\d]{32}$/i;

interface Account {
  id: string;
  name: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function command(args: string[]): string[] {
  return [
    wrangler,
    ...args,
    "--config",
    join(assets, "wrangler.json"),
    "--env-file",
    join(assets, "empty.env"),
  ];
}

function environment(env: NodeJS.ProcessEnv, interactive = false) {
  return {
    ...env,
    WRANGLER_OUTPUT_FILE_DIRECTORY: undefined,
    WRANGLER_OUTPUT_FILE_PATH: undefined,
    ...(interactive ? {} : { CI: "true" }),
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_WRITE_LOGS: "false",
    WRANGLER_LOG: "log",
    WRANGLER_LOG_SANITIZE: "true",
    WRANGLER_NO_SKILLS_UPDATE_PROMPTS: "true",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };
}

async function json(args: string[], env: NodeJS.ProcessEnv): Promise<unknown> {
  let stdout: string;
  try {
    ({ stdout } = await execute(
      process.execPath,
      command([...args, "--json"]),
      {
        cwd: assets,
        env: environment(env),
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
    ));
  } catch (error) {
    // Child errors may contain tokens; keep them private.
    const output = isRecord(error)
      ? `${typeof error.stdout === "string" ? error.stdout : ""}\n${typeof error.stderr === "string" ? error.stderr : ""}`
      : "";
    if (
      /Not logged in|not authenticated|token-expired-non-interactive|token has expired and could not be refreshed/i.test(
        output,
      )
    ) {
      return null;
    }
    throw new Error(
      "Wrangler authentication failed. Check your connection or run cf-mail login.",
    );
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error("Wrangler returned an unexpected authentication response.");
  }
}

async function browserLogin(env: NodeJS.ProcessEnv): Promise<void> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error("Run cf-mail login in a terminal, then retry.");
  }
  console.error("Opening Cloudflare login in your browser...");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, command(["login"]), {
      cwd: assets,
      env: environment(env, true),
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", () =>
      reject(new Error("Could not start Cloudflare login.")),
    );
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error("Login incomplete. Retry cf-mail login."));
    });
  });
}

function configPath(env: NodeJS.ProcessEnv): string {
  const base =
    env.XDG_CONFIG_HOME ||
    (process.platform === "win32" ? env.APPDATA : undefined) ||
    join(homedir(), ".config");
  return join(base, "cf-mail", "config.json");
}

async function savedAccount(
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  try {
    const config: unknown = JSON.parse(await readFile(configPath(env), "utf8"));
    if (isRecord(config) && typeof config.accountId === "string") {
      return accountIdPattern.test(config.accountId)
        ? config.accountId
        : undefined;
    }
    return undefined;
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      (isRecord(error) && error.code === "ENOENT")
    ) {
      return undefined;
    }
    throw new Error("Could not read the saved cf-mail account selection.");
  }
}

async function saveAccount(
  accountId: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const path = configPath(env);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, `${JSON.stringify({ accountId }, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function selectAccount(
  accounts: Account[],
  env: NodeJS.ProcessEnv,
  chooseAgain: boolean,
): Promise<string> {
  const explicit = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (explicit) {
    if (!accountIdPattern.test(explicit)) {
      throw new Error(
        "CLOUDFLARE_ACCOUNT_ID must be a 32-character account ID.",
      );
    }
    if (!accounts.some((account) => account.id === explicit)) {
      throw new Error("Your login cannot access CLOUDFLARE_ACCOUNT_ID.");
    }
    return explicit;
  }
  const saved = chooseAgain ? undefined : await savedAccount(env);
  if (saved && accounts.some((account) => account.id === saved)) return saved;

  let selected = accounts.length === 1 ? accounts[0] : undefined;
  if (accounts.length === 0) {
    throw new Error("No accessible Cloudflare accounts.");
  }
  if (!selected) {
    if (!process.stdin.isTTY || !process.stderr.isTTY) {
      throw new Error("Multiple accounts. Run cf-mail login to choose one.");
    }
    console.error("Choose a Cloudflare account:");
    accounts.forEach((account, index) => {
      console.error(`  ${index + 1}. ${account.name} (${account.id})`);
    });
    const prompt = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    try {
      while (!selected) {
        const answer = (await prompt.question("Account number: ")).trim();
        if (/^[1-9]\d*$/.test(answer)) selected = accounts[Number(answer) - 1];
        if (!selected) console.error("Enter a listed account number.");
      }
    } finally {
      prompt.close();
    }
  }
  await saveAccount(selected.id, env);
  return selected.id;
}

export async function credentials(
  env: NodeJS.ProcessEnv,
  forceLogin = false,
): Promise<Credentials> {
  const explicitAccount = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const explicitToken = env.CLOUDFLARE_API_TOKEN?.trim();
  if (explicitAccount && !accountIdPattern.test(explicitAccount)) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID must be a 32-character account ID.");
  }
  if (explicitToken && /\s/.test(explicitToken)) {
    throw new Error("CLOUDFLARE_API_TOKEN must not contain whitespace.");
  }
  if (!forceLogin && explicitAccount && explicitToken) {
    return { accountId: explicitAccount, token: explicitToken };
  }
  const sessionEnv = { ...env };
  if (forceLogin) {
    for (const name of [
      "CLOUDFLARE_API_TOKEN",
      "CF_API_TOKEN",
      "CLOUDFLARE_API_KEY",
      "CF_API_KEY",
      "CLOUDFLARE_EMAIL",
      "CF_EMAIL",
    ])
      delete sessionEnv[name];
    await browserLogin(sessionEnv);
  }

  let auth = await json(["auth", "token"], sessionEnv);
  if (auth === null) {
    await browserLogin(sessionEnv);
    auth = await json(["auth", "token"], sessionEnv);
  }
  if (
    !isRecord(auth) ||
    !["oauth", "api_token"].includes(String(auth.type)) ||
    typeof auth.token !== "string" ||
    !auth.token ||
    /\s/.test(auth.token)
  ) {
    throw new Error("No usable token. Run cf-mail login.");
  }

  let identity = await json(["whoami"], sessionEnv);
  if (
    auth.type === "oauth" &&
    isRecord(identity) &&
    Array.isArray(identity.tokenPermissions) &&
    !identity.tokenPermissions.includes("email_sending:write")
  ) {
    console.error("Login needs email sending permission.");
    await browserLogin(sessionEnv);
    auth = await json(["auth", "token"], sessionEnv);
    identity = await json(["whoami"], sessionEnv);
  }

  if (
    !isRecord(auth) ||
    typeof auth.token !== "string" ||
    !auth.token ||
    /\s/.test(auth.token) ||
    !isRecord(identity) ||
    identity.loggedIn !== true ||
    !Array.isArray(identity.accounts)
  ) {
    throw new Error("Account discovery failed. Run cf-mail login.");
  }
  const accounts = identity.accounts.filter(
    (account): account is Account =>
      isRecord(account) &&
      typeof account.id === "string" &&
      accountIdPattern.test(account.id) &&
      typeof account.name === "string",
  );
  return {
    accountId: await selectAccount(accounts, sessionEnv, forceLogin),
    token: auth.token,
  };
}
