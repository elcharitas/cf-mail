#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { credentials } from "./auth.js";
import { type Mail, sendEmail } from "./send.js";

const help = `Usage: cf-mail <from> [options] <to> [more recipients...]
       cf-mail login

Send through Cloudflare. Login and account selection are automatic.

Options:
  -m, --message <body>    Required plain text body
  -t, --title <subject>   Required subject
  -cc, --cc <addresses>   CC; repeat or use commas
  -bcc, --bcc <addresses> BCC; repeat or use commas
  --dry-run              Preview JSON; no login or network
  -h, --help             Usage
  -v, --version          Version

Optional overrides:
  CLOUDFLARE_ACCOUNT_ID  Account
  CLOUDFLARE_API_TOKEN   API token instead of browser login

Example:
  cf-mail example@myregion.com -m "Some body" -t "Some title" -cc "cc@example.com" to@example.com

Onboard your sender domain for Cloudflare Email Sending first.
`;

function address(value: string): string {
  const trimmed = value.trim();
  if (
    /\p{Cc}/u.test(value) ||
    trimmed.length > 254 ||
    !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(trimmed)
  ) {
    throw new Error("Use plain email addresses such as name@example.com.");
  }
  return trimmed;
}

function addresses(values: string[]): string[] {
  return values.flatMap((value) => value.split(",").map(address));
}

async function main(): Promise<void> {
  const aliases: Record<string, string> = { "-cc": "--cc", "-bcc": "--bcc" };
  // Preserve values when expanding -cc and -bcc.
  const args = process.argv.slice(2);
  let isValue = false;
  let isPositional = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (isPositional) continue;
    if (isValue) {
      isValue = false;
      continue;
    }
    if (arg === "--") {
      isPositional = true;
      continue;
    }
    const [name, ...value] = arg.split("=");
    if (name && aliases[name]) {
      args[index] =
        `${aliases[name]}${value.length ? `=${value.join("=")}` : ""}`;
    }
    isValue =
      value.length === 0 &&
      [
        "-m",
        "--message",
        "-t",
        "--title",
        "-cc",
        "--cc",
        "-bcc",
        "--bcc",
      ].includes(arg);
  }

  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      message: { type: "string", short: "m" },
      title: { type: "string", short: "t" },
      cc: { type: "string", multiple: true },
      bcc: { type: "string", multiple: true },
      "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });

  if (values.help || args.length === 0) {
    process.stdout.write(help);
    return;
  }
  if (values.version) {
    const metadata: { version: string } = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    console.log(metadata.version);
    return;
  }
  if (positionals[0] === "login") {
    if (positionals.length !== 1 || Object.keys(values).length !== 0) {
      throw new Error("Use cf-mail login without options or recipients.");
    }
    const auth = await credentials(process.env, true);
    console.log(`Cloudflare login ready. Account: ${auth.accountId}`);
    return;
  }

  const [from, ...to] = positionals;
  if (!from || to.length === 0) {
    throw new Error("Provide a sender and recipient. See cf-mail --help.");
  }
  if (!values.title?.trim() || /\p{Cc}/u.test(values.title)) {
    throw new Error(
      "Use -t with a non-empty subject and no control characters.",
    );
  }
  if (!values.message?.trim()) {
    throw new Error("Use -m with a non-empty message.");
  }

  const mail: Mail = {
    from: address(from),
    to: addresses(to),
    subject: values.title,
    text: values.message,
  };
  if (values.cc) mail.cc = addresses(values.cc);
  if (values.bcc) mail.bcc = addresses(values.bcc);
  if (mail.to.length + (mail.cc?.length ?? 0) + (mail.bcc?.length ?? 0) > 50) {
    throw new Error("Maximum: 50 To/CC/BCC recipients combined.");
  }

  if (values["dry-run"]) {
    console.log(JSON.stringify(mail, null, 2));
    return;
  }

  const result = await sendEmail(mail, await credentials(process.env));
  if (result.delivered.length) {
    console.log(`Delivered: ${result.delivered.join(", ")}`);
  }
  if (result.queued.length) {
    console.log(`Queued: ${result.queued.join(", ")}`);
  }
  if (result.permanent_bounces.length) {
    console.error(`Bounced: ${result.permanent_bounces.join(", ")}`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(
    `cf-mail: ${error instanceof Error ? error.message : "Unexpected error."}`,
  );
  process.exitCode = 1;
});
