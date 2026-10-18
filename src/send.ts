export interface Mail {
  from: string;
  to: string[];
  subject: string;
  text: string;
  cc?: string[];
  bcc?: string[];
}

export interface Delivery {
  delivered: string[];
  queued: string[];
  permanent_bounces: string[];
}

export interface Credentials {
  accountId: string;
  token: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAddressList(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

export async function sendEmail(
  mail: Mail,
  auth: Credentials,
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<Delivery> {
  let response: Response;
  let data: unknown;
  try {
    response = await request(
      `https://api.cloudflare.com/client/v4/accounts/${auth.accountId}/email/sending/send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(mail),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      },
    );
    data = await response.json();
  } catch {
    throw new Error(
      "Delivery unconfirmed; the message may be accepted. Check Email Sending activity before retrying.",
    );
  }

  if (!response.ok || !isRecord(data) || data.success !== true) {
    const details =
      isRecord(data) && Array.isArray(data.errors)
        ? data.errors
            .filter(isRecord)
            .map((error) =>
              typeof error.message === "string"
                ? error.message.replaceAll(auth.token, "[redacted]")
                : "Unknown API error",
            )
            .join("; ")
        : "";
    throw new Error(
      `Cloudflare rejected the request (HTTP ${response.status})${details ? `: ${details}` : "."}`,
    );
  }

  const result = data.result;
  if (
    !isRecord(result) ||
    !isAddressList(result.delivered) ||
    !isAddressList(result.queued) ||
    !isAddressList(result.permanent_bounces)
  ) {
    throw new Error(
      "Unexpected delivery result. Check Email Sending activity before retrying.",
    );
  }

  const reported = new Set(
    [...result.delivered, ...result.queued, ...result.permanent_bounces].map(
      (address) => address.toLowerCase(),
    ),
  );
  if (
    [...mail.to, ...(mail.cc ?? []), ...(mail.bcc ?? [])].some(
      (address) => !reported.has(address.toLowerCase()),
    )
  ) {
    throw new Error(
      "Missing recipient status. Check Email Sending activity before retrying.",
    );
  }

  return {
    delivered: result.delivered,
    queued: result.queued,
    permanent_bounces: result.permanent_bounces,
  };
}
