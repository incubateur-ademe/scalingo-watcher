/**
 * Previent les canaux configures d'un changement d'etat du parc. Lance par
 * l'action signaler, apres actions/setup, avec ses parametres en variables
 * d'environnement.
 *
 * Canaux, tous facultatifs et cumulables :
 * - Teams : webhook Workflows Power Automate, carte adaptative. Les connecteurs
 *   Office 365 qui n'admettaient que le message card sont hors service depuis
 *   mai 2026.
 * - Webhook au format Slack ({"text": ...}) : Slack, Mattermost, Rocket.Chat, et
 *   Tchap via une passerelle comme betagouv/slack2tchap.
 * - Matrix : envoi direct dans un salon avec le jeton d'un compte bot. Tchap n'a
 *   pas de webhook entrant, c'est la voie sans passerelle.
 *
 * Un canal en echec produit un avertissement sans faire echouer le job : le
 * tableau de bord est deja a jour, et un canal en panne ne doit pas masquer les
 * autres.
 */

import { readFileSync } from "node:fs";

type Env = Record<string, string | undefined>;
type Link = { label: string; url: string };
export type Message = { state: string; title: string; detail: string; links: Link[] };

const TITLES: Record<string, string> = {
  opened: "Suivi du parc Scalingo ouvert",
  changed: "L'etat du parc a change",
  resolved: "Le parc est revenu a la normale",
};

const DETAIL_MAX = 1200;

/**
 * Ce qui demande une intervention, tire du rapport. Le rapport commence par les
 * tableaux du parc, qui depassent a eux seuls la place d'un message : seule la
 * partie qui suit le marqueur d'etat est envoyee.
 */
export function actionPart(report: string): string {
  const marker = /<!-- etat: [a-z]+ -->\s*/.exec(report);
  return (marker ? report.slice(marker.index + marker[0].length) : report).trim().slice(0, DETAIL_MAX).trim();
}

export function compose(env: Env, readReport: (path: string) => string): Message {
  const state = env.STATE ?? "";
  const issue = (env.ISSUE ?? "").trim();
  const links: Link[] = [
    { label: "Tableau de bord", url: issue ? `${env.REPO_URL}/issues/${issue}` : "" },
    { label: "Execution", url: env.RUN_URL ?? "" },
  ].filter((l) => l.url);
  const detail =
    state === "resolved"
      ? "Plus rien a signaler sur le parc."
      : actionPart(readReport(env.REPORT ?? "")) || "Aucun detail.";
  return { state, title: TITLES[state] ?? "Etat du parc", detail, links };
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" })[c]!);

async function send(name: string, url: string, payload: unknown, init: RequestInit = {}): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      ...init,
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) {
      console.log(`${name} prevenu (${res.status})`);
      return true;
    }
    const body = await res.text().catch(() => "");
    console.log(`::warning::notification ${name} en echec (${res.status}) : ${body.slice(0, 300)}`);
  } catch (e) {
    console.log(`::warning::notification ${name} en echec : ${(e as Error).message}`);
  }
  return false;
}

export function teamsPayload(m: Message) {
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            {
              type: "TextBlock",
              text: m.title,
              weight: "Bolder",
              size: "Medium",
              wrap: true,
              color: m.state === "resolved" ? "Good" : "Attention",
            },
            { type: "TextBlock", text: m.detail, wrap: true },
          ],
          actions: m.links.map((l) => ({ type: "Action.OpenUrl", title: l.label, url: l.url })),
        },
      },
    ],
  };
}

// Les URL nues plutot qu'une syntaxe de lien : Slack (<url|texte>) et Mattermost
// ([texte](url)) ne s'accordent pas, et une passerelle ne garantit ni l'une ni
// l'autre.
export const slackPayload = (m: Message) => ({
  text: [`*${m.title}*`, "", m.detail, "", ...m.links.map((l) => `${l.label} : ${l.url}`)].join("\n"),
});

export function matrixPayload(m: Message) {
  return {
    msgtype: "m.text",
    body: [m.title, "", m.detail, "", ...m.links.map((l) => `${l.label} : ${l.url}`)].join("\n"),
    format: "org.matrix.custom.html",
    formatted_body:
      `<p><strong>${escapeHtml(m.title)}</strong></p><pre>${escapeHtml(m.detail)}</pre><p>` +
      m.links.map((l) => `<a href="${escapeHtml(l.url)}">${escapeHtml(l.label)}</a>`).join(" | ") +
      "</p>",
  };
}

export async function notify(env: Env, readReport: (path: string) => string): Promise<number> {
  const m = compose(env, readReport);
  let sent = 0;
  if (env.TEAMS_WEBHOOK) sent += Number(await send("Teams", env.TEAMS_WEBHOOK, teamsPayload(m)));
  if (env.SLACK_WEBHOOK) sent += Number(await send("webhook Slack", env.SLACK_WEBHOOK, slackPayload(m)));
  const [homeserver, room, token] = ["MATRIX_HOMESERVER", "MATRIX_ROOM_ID", "MATRIX_ACCESS_TOKEN"].map((k) => (env[k] ?? "").trim());
  if (homeserver && room && token) {
    // Identifiant de transaction stable par execution et par etat : un nouvel
    // essai du job n'envoie pas deux fois le meme message.
    const txn = `scalingo-watcher-${env.GITHUB_RUN_ID ?? "0"}-${env.GITHUB_RUN_ATTEMPT ?? "1"}-${m.state}`;
    const url =
      `${homeserver.replace(/\/+$/, "")}/_matrix/client/v3/rooms/${encodeURIComponent(room)}` +
      `/send/m.room.message/${encodeURIComponent(txn)}`;
    sent += Number(await send("Matrix", url, matrixPayload(m), { method: "PUT", headers: { Authorization: `Bearer ${token}` } }));
  } else if (homeserver || room || token) {
    console.log("::warning::configuration Matrix incomplete : homeserver, salon et jeton sont tous trois requis");
  }
  if (sent === 0) console.log("aucun canal de notification prevenu");
  return sent;
}

if (import.meta.main) {
  await notify(process.env, (path) => readFileSync(path, "utf8"));
}
