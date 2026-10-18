# cf-mail

Send transactional email through Cloudflare. No Worker deployment needed.

```sh
cf-mail example@myregion.com -m "Some body" -t "Some title" -cc "cc@example.com" to@example.com
```

## Install

Requires Bun and Node.js 22+.

```sh
bun install
bun run build
bun link
```

Keep this folder in place and Bun's binary directory on `PATH`.
Use `cf-mail` or `bunx --no-install cf-mail` from any folder.
The latter avoids registry downloads. Run `bun unlink` here to remove the link.

## Setup

Onboard your sender domain, such as `myregion.com`, in **Cloudflare > Compute > Email Service > Email Sending**.
Email Routing alone is insufficient.

The CLI reuses and refreshes your Wrangler login. It opens browser login when needed, including for missing email permissions.
With multiple accounts, choose once. The CLI remembers your choice; no environment setup required.
Run `cf-mail login` in a terminal to log in or select another account.

Wrangler manages credentials and its keychain setting.
The CLI stores only your account ID in `~/.config/cf-mail/config.json`, respecting `XDG_CONFIG_HOME` or Windows `APPDATA`.

Optional overrides: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
The account override takes priority over your saved choice.
Tokens need **Email Sending: Edit**; automatic account discovery also needs account visibility.
With both overrides, discovery is unnecessary.

## Usage

The first address is the sender; remaining addresses are To recipients.
Use plain addresses without display names. Options can appear anywhere.

| Option | Purpose |
| --- | --- |
| `-m`, `--message` | Required plain text body |
| `-t`, `--title` | Required subject |
| `-cc`, `--cc` | CC recipients |
| `-bcc`, `--bcc` | BCC recipients |
| `--dry-run` | Preview JSON without login or network access |
| `-h`, `--help` | Usage |
| `-v`, `--version` | Version |

Repeat CC/BCC flags or separate addresses with commas. Maximum: 50 To/CC/BCC recipients combined.
Add `--dry-run` to preview; omit it to send.

Output distinguishes delivered, queued, and bounced recipients. Queued does not confirm delivery.
Invalid inputs, bounces, and API failures return a nonzero exit code.
Sends time out after 30 seconds without automatic retries.
For uncertain delivery, check Email Sending activity before retrying to avoid duplicates.

## Development

```sh
bun run check
bun run check:fix
bun run typecheck
bun run build
```

Biome checks formatting, imports, and lint. Rebuild after source changes to update the linked command.

Cloudflare docs: [setup](https://developers.cloudflare.com/email-service/get-started/send-emails/),
[authentication](https://developers.cloudflare.com/workers/wrangler/commands/general/),
[API](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/).
