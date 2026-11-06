import { bearerJson, requestJson } from "../connectors/http";
import type { Env } from "../env";

type OwnMailSettings = Pick<Env, "RESEND_API_KEY" | "OWLSEEN_MAIL_FROM">;

const EMAILS = "https://api.resend.com/emails";

/**
 * The instance's own mail to its members, through Resend (https://resend.com/docs/api-reference/emails/send-email):
 * sign-in links and invitations. What a workspace connects stays with each workspace's
 * own connection. An instance without a key simply sends none of its own.
 */
export async function sendOwnMail(settings: OwnMailSettings, fetchUrl: typeof fetch, mail: { to: string; subject: string; text: string }): Promise<boolean> {
  if (!settings.RESEND_API_KEY) return false;
  await requestJson(fetchUrl, "Resend", EMAILS, {
    method: "POST",
    headers: bearerJson(settings.RESEND_API_KEY),
    body: JSON.stringify({ from: settings.OWLSEEN_MAIL_FROM, to: [mail.to], subject: mail.subject, text: mail.text }),
  });
  return true;
}
