/**
 * Pose sur chaque app du parc le notifier qui previent le relais de la fin d'un
 * deploiement ou d'une sauvegarde, pour que le relais relance le workflow du
 * parc en reprise.
 *
 * A lancer en local par un administrateur, jamais en CI.
 *
 *   export SCALINGO_API_TOKEN=tk-us-xxxxxxxx
 *   export RELAY_URL='https://<relais>/<RELAY_SECRET>'
 *   node src/notifiers.ts                  # cree ou met a jour
 *   node src/notifiers.ts --dry-run        # montre ce qui serait fait
 *   node src/notifiers.ts --app alpha      # apps dont le nom contient alpha
 *   node src/notifiers.ts --remove         # retire le notifier du watcher
 *
 * RELAY_URL porte le secret du relais : elle se lit dans l'environnement, jamais
 * en argument, que l'historique du shell garderait. Rien de ce qui s'affiche
 * n'en montre plus que l'hote.
 *
 * Seul le notifier webhook nomme scalingo-watcher est cree, modifie ou supprime.
 * Un notifier de ce nom sur une autre plateforme n'est pas le sien : l'app passe
 * en echec sans ecriture, et --remove le laisse en place. Une app en pause est
 * ignoree. Une app dont le compte du jeton n'est pas proprietaire est ecartee :
 * un compte voit aussi les apps dont il n'est que collaborateur.
 *
 * Pas de proxy FGP : ses blobs ne couvrent pas les notifiers, et
 * auth.scalingo.com, qui donne le compte du jeton, n'y est pas joignable.
 */

import { readManifest } from "./apply.ts";
import { flagValue, resolvePaths, shown } from "./options.ts";

export const NOTIFIER_NAME = "scalingo-watcher";
export const PLATFORM = "webhook";
export const EVENTS = ["app_deployed", "database_backup_succeeded", "database_backup_failed"] as const;

type Env = Record<string, string | undefined>;

/** Notifier tel que l'API le rend ; seuls les champs compares sont lus. */
export type Notifier = {
  id: string;
  name?: string;
  active?: boolean;
  platform_id?: string;
  notification_platform_id?: string;
  type?: string;
  send_all_events?: boolean;
  send_all_alerts?: boolean;
  selected_event_ids?: string[] | null;
  type_data?: { webhook_url?: string } | null;
};

/** Notifier attendu sur une app, ids resolus dans sa region. */
export type Desired = { platformId: string; eventIds: string[]; url: string };

export type Field = "url" | "evenements" | "alertes" | "actif" | "plateforme" | "nom";

/** Notifier qui porte le nom du watcher sur une autre plateforme. */
export type Namesake = { id: string; platform: string };

export type Plan =
  | { action: "create" }
  | { action: "update"; id: string; changes: Field[] }
  | { action: "none"; id: string }
  | { action: "foreign"; notifiers: Namesake[] }
  | { action: "duplicate"; ids: string[] };

/**
 * Vrai si le notifier est un webhook. L'id de plateforme et le type doivent
 * concorder quand l'API rend les deux ; sans aucun des deux, rien ne prouve que
 * c'en est un.
 */
export function isWebhook(n: Notifier, webhookPlatformId: string): boolean {
  const id = n.platform_id || n.notification_platform_id || undefined;
  const type = n.type || undefined;
  if (id === undefined && type === undefined) return false;
  return (id === undefined || id === webhookPlatformId) && (type === undefined || type === PLATFORM);
}

/** Champs du notifier en place qui different de l'attendu. */
export function differences(current: Notifier, desired: Desired): Field[] {
  const changes: Field[] = [];
  if (current.type_data?.webhook_url !== desired.url) changes.push("url");
  const selected = new Set(current.selected_event_ids ?? []);
  const sameEvents = selected.size === desired.eventIds.length && desired.eventIds.every((id) => selected.has(id));
  // Un booleen absent de la reponse vaut faux, comme a la serialisation.
  if (current.send_all_events === true || !sameEvents) changes.push("evenements");
  if (current.send_all_alerts === true) changes.push("alertes");
  if (current.active !== true) changes.push("actif");
  if (!isWebhook(current, desired.platformId)) changes.push("plateforme");
  if (current.name !== NOTIFIER_NAME) changes.push("nom");
  return changes;
}

/** Notifiers nommes comme celui du watcher sans etre des webhooks : pas les siens. */
export const namesakes = (existing: readonly Notifier[], webhookPlatformId: string): Namesake[] =>
  existing
    .filter((n) => n.name === NOTIFIER_NAME && !isWebhook(n, webhookPlatformId))
    .map((n) => ({ id: n.id, platform: n.type || n.platform_id || n.notification_platform_id || "plateforme illisible" }));

/** Que faire du notifier du watcher, au vu de tous ceux de l'app. */
export function planNotifier(existing: readonly Notifier[], desired: Desired): Plan {
  // Converti par PATCH, un notifier d'une autre equipe cesserait de la prevenir.
  const others = namesakes(existing, desired.platformId);
  if (others.length > 0) return { action: "foreign", notifiers: others };
  const ours = existing.filter((n) => n.name === NOTIFIER_NAME);
  if (ours.length === 0) return { action: "create" };
  // Deux notifiers doubleraient chaque relance ; lequel garder n'est pas a
  // deviner.
  if (ours.length > 1) return { action: "duplicate", ids: ours.map((n) => n.id) };
  const changes = differences(ours[0], desired);
  return changes.length > 0 ? { action: "update", id: ours[0].id, changes } : { action: "none", id: ours[0].id };
}

/** Ids des notifiers du watcher, les seuls que --remove supprime. */
export const notifiersToRemove = (existing: readonly Notifier[], webhookPlatformId: string): string[] =>
  existing.filter((n) => n.name === NOTIFIER_NAME && isWebhook(n, webhookPlatformId)).map((n) => n.id);

/** Corps de creation comme de modification. */
export const notifierBody = (desired: Desired) => ({
  notifier: {
    platform_id: desired.platformId,
    name: NOTIFIER_NAME,
    active: true,
    send_all_events: false,
    send_all_alerts: false,
    selected_event_ids: desired.eventIds,
    type_data: { webhook_url: desired.url },
  },
});

// Le relais ne sert que POST /<RELAY_SECRET> et ne lit son secret que sur ce
// segment. Il rejetterait chaque evenement envoye a un autre chemin.
const SECRET_PATH = /^\/[A-Za-z0-9._~-]{32,}$/;

/** RELAY_URL validee, ou la raison du refus, qui ne la cite jamais. */
export function readRelayUrl(raw: string | undefined): { url: string; host: string } | { refused: string } {
  const value = raw?.trim();
  if (!value) return { refused: "RELAY_URL est requise : l'adresse complete du relais, secret compris." };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { refused: "RELAY_URL n'est pas une URL lisible." };
  }
  if (url.protocol !== "https:") return { refused: `RELAY_URL doit etre en https, pas en ${url.protocol.slice(0, -1)}.` };
  if (url.username || url.password) return { refused: "RELAY_URL ne doit porter ni identifiant ni mot de passe." };
  // Un "?" ou un "#" final ne laisse ni search ni hash a l'URL analysee.
  if (/[?#]/.test(value)) return { refused: "RELAY_URL ne doit porter ni parametre de requete ni fragment." };
  if (!SECRET_PATH.test(url.pathname)) {
    return {
      refused:
        "RELAY_URL doit etre de la forme https://<relais>/<RELAY_SECRET> : un seul segment de chemin, 32 caracteres au moins, lettres, chiffres et . _ ~ - seulement.",
    };
  }
  // La forme analysee est celle dont le chemin vient d'etre verifie. La saisie
  // peut porter des segments . ou .., des tabulations ou des \ que l'analyse
  // retire ou convertit.
  return { url: url.href, host: url.host };
}

const decoded = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * Texte sans l'adresse du relais, hote excepte. Une erreur de Scalingo peut
 * reprendre la valeur recue, entiere ou en partie, telle quelle ou echappee.
 *
 * A appliquer avant toute coupe du texte. Une coupe au milieu du secret en
 * laisserait passer le debut, que le masquage ne reconnait plus.
 */
export function redact(text: string, relay: string | undefined): string {
  const raw = relay?.trim();
  if (!raw) return text;
  const fragments = new Set<string>();
  const parts = [raw];
  try {
    const url = new URL(raw);
    fragments.add(url.href);
    parts.push(
      `${url.pathname}${url.search}${url.hash}`,
      ...url.pathname.split("/"),
      ...url.searchParams.values(),
      url.hash.slice(1),
      url.username,
      url.password,
    );
  } catch {
    // illisible : seule la valeur brute est connue
  }
  // Plus court, un morceau ne se distingue plus d'un mot du message, et le
  // masquer rendrait la sortie illisible sans rien proteger.
  for (const part of parts) for (const form of [part, decoded(part)]) if (form.length >= 20) fragments.add(form);
  if (raw.length >= 8) fragments.add(raw);
  let out = text;
  for (const f of [...fragments].sort((a, b) => b.length - a.length)) {
    out = out.replaceAll(f, "<relais>").replaceAll(f.replaceAll("/", "\\/"), "<relais>");
  }
  return out;
}

const SWITCHES = ["--dry-run", "--remove"];
const VALUED = ["--app", "--manifest"];

/** Arguments inconnus, reduits a leur nom : une valeur egaree peut etre l'URL du relais. */
export function unknownArguments(argv: readonly string[]): string[] {
  const unknown: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (SWITCHES.includes(arg)) continue;
    if (VALUED.includes(arg)) {
      i++;
      continue;
    }
    if (VALUED.some((flag) => arg.startsWith(`${flag}=`))) continue;
    unknown.push(arg.startsWith("--") ? arg.split("=")[0] : "<valeur>");
  }
  return unknown;
}

type Api = <T>(method: string, url: string, body?: unknown) => Promise<T>;
type Mask = (text: string) => string;

const apiHost = (region: string) => `https://api.${region}.scalingo.com`;

async function exchangeToken(token: string): Promise<string> {
  const res = await fetch("https://auth.scalingo.com/v1/tokens/exchange", {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`:${token}`).toString("base64")}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`echange du jeton refuse : ${res.status}`);
  const { token: bearer } = (await res.json()) as { token?: string };
  if (!bearer) throw new Error("echange du jeton : reponse sans champ token");
  return bearer;
}

function client(bearer: string, mask: Mask): Api {
  return async <T>(method: string, url: string, body?: unknown): Promise<T> => {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text().catch(() => "");
    const excerpt = () => {
      const kept = mask(text).slice(0, 200);
      return kept ? ` :: ${kept}` : "";
    };
    if (!res.ok) throw new Error(`${res.status} sur ${method} ${url}${excerpt()}`);
    try {
      return (text ? JSON.parse(text) : undefined) as T;
    } catch {
      // Le message de JSON.parse recopie une dizaine de caracteres autour de
      // l'erreur, coupes avant tout masquage.
      throw new Error(`${res.status} sur ${method} ${url}, reponse illisible${excerpt()}`);
    }
  };
}

type Named = { id: string; name: string };

/** Id de la plateforme webhook dans la region. */
async function webhookPlatform(api: Api, region: string): Promise<string> {
  const { notification_platforms: platforms } = await api<{ notification_platforms?: Named[] }>(
    "GET",
    `${apiHost(region)}/v1/notification_platforms`,
  );
  const platformId = platforms?.find((p) => p.name === PLATFORM)?.id;
  if (!platformId) throw new Error(`${region} : plateforme de notification ${PLATFORM} introuvable`);
  return platformId;
}

/** Ids des evenements du watcher dans la region, dans l'ordre de EVENTS. */
async function watchedEvents(api: Api, region: string): Promise<string[]> {
  const { event_types: types } = await api<{ event_types?: Named[] }>("GET", `${apiHost(region)}/v1/event_types`);
  const found = EVENTS.map((name) => types?.find((t) => t.name === name)?.id);
  const missing = EVENTS.filter((_, i) => !found[i]);
  if (missing.length > 0) throw new Error(`${region} : type(s) d'evenement introuvable(s) : ${missing.join(", ")}`);
  return found as string[];
}

type Kind = "cree" | "modifie" | "inchange" | "supprime" | "absent" | "ecartee" | "echec";
type Outcome = { kind: Kind; text: string };

/** Ce qui vaut pour toutes les apps d'une region ; desired est null pour --remove. */
type Target = { platformId: string; desired: Desired | null };

async function handleApp(
  api: Api,
  ref: { app: string; region: string },
  accountId: string,
  target: Target,
  dryRun: boolean,
): Promise<Outcome> {
  const base = `${apiHost(ref.region)}/v1/apps/${ref.app}`;
  const { app } = await api<{ app?: { owner?: { id?: string; username?: string } } }>("GET", base);
  const owner = app?.owner;
  if (!owner?.id) throw new Error("proprietaire illisible : reponse sans owner.id");
  if (owner.id !== accountId) {
    return { kind: "ecartee", text: `ecartee, proprietaire ${owner.username ?? owner.id} hors du compte du jeton` };
  }
  const { notifiers } = await api<{ notifiers?: Notifier[] }>("GET", `${base}/notifiers`);
  if (!Array.isArray(notifiers)) throw new Error("reponse sans liste de notifiers");

  const removal = (ids: readonly string[]) =>
    `scalingo --region ${ref.region} --app ${ref.app} notifiers-remove ${ids.length === 1 ? ids[0] : "<id>"}`;
  const listed = (others: readonly Namesake[]) => others.map((n) => `${n.id} (${n.platform})`).join(", ");

  const { desired } = target;
  if (!desired) {
    const ids = notifiersToRemove(notifiers, target.platformId);
    const others = namesakes(notifiers, target.platformId);
    const kept = others.length > 0 ? ` ; laisse(s) en place, autre plateforme : ${listed(others)}` : "";
    if (ids.length === 0) return { kind: "absent", text: `aucun notifier ${PLATFORM} ${NOTIFIER_NAME}${kept}` };
    if (!dryRun) for (const id of ids) await api("DELETE", `${base}/notifiers/${encodeURIComponent(id)}`);
    const what = ids.length > 1 ? `${ids.length} notifiers` : "notifier";
    const done = dryRun ? "a supprimer" : ids.length > 1 ? "supprimes" : "supprime";
    return { kind: "supprime", text: `${what} ${done}${kept}` };
  }

  const plan = planNotifier(notifiers, desired);
  if (plan.action === "foreign") {
    return {
      kind: "echec",
      text: `echec : notifier(s) ${listed(plan.notifiers)} nomme(s) ${NOTIFIER_NAME} sur une autre plateforme que ${PLATFORM} ; le retirer ou le renommer a la main (${removal(plan.notifiers.map((n) => n.id))}), puis relancer`,
    };
  }
  if (plan.action === "duplicate") {
    return {
      kind: "echec",
      text: `echec : ${plan.ids.length} notifiers ${NOTIFIER_NAME} sur ${ref.app} (${plan.ids.join(", ")}), un seul attendu ; retirer ceux en trop avec ${removal(plan.ids)}, puis relancer`,
    };
  }
  if (plan.action === "none") return { kind: "inchange", text: "notifier inchange" };
  const created = plan.action === "create";
  if (dryRun) {
    return created
      ? { kind: "cree", text: "notifier a creer" }
      : { kind: "modifie", text: `notifier a modifier (${plan.changes.join(", ")})` };
  }
  const written = created
    ? await api<{ notifier?: Notifier } | undefined>("POST", `${base}/notifiers`, notifierBody(desired))
    : await api<{ notifier?: Notifier } | undefined>(
        "PATCH",
        `${base}/notifiers/${encodeURIComponent(plan.id)}`,
        notifierBody(desired),
      );
  // Scalingo peut ignorer un champ sans refuser l'ecriture. L'ecart se lit sur
  // le notifier rendu.
  const verb = created ? "cree" : "modifie";
  if (!written?.notifier) return { kind: "echec", text: `echec : notifier ${verb}, sans notifier rendu a verifier` };
  const gaps = differences(written.notifier, desired);
  if (gaps.length > 0) {
    return { kind: "echec", text: `echec : notifier ${verb}, ecart restant apres ecriture (${gaps.join(", ")})` };
  }
  return created
    ? { kind: "cree", text: "notifier cree" }
    : { kind: "modifie", text: `notifier modifie (${plan.changes.join(", ")})` };
}

async function converge(argv: readonly string[], env: Env, say: (line?: string) => void, cwd: string): Promise<number> {
  const unknown = unknownArguments(argv);
  if (unknown.length > 0) {
    throw new Error(
      `argument(s) inconnu(s) : ${unknown.join(", ")}. RELAY_URL et SCALINGO_API_TOKEN se lisent dans l'environnement.`,
    );
  }
  const dryRun = argv.includes("--dry-run");
  const remove = argv.includes("--remove");
  const fragment = flagValue(argv, "--app");
  const paths = resolvePaths(argv, env, cwd);
  const mask: Mask = (text) => redact(text, env.RELAY_URL);

  let relay: { url: string; host: string } | null = null;
  if (!remove) {
    const read = readRelayUrl(env.RELAY_URL);
    if ("refused" in read) throw new Error(read.refused);
    relay = read;
  }
  const token = env.SCALINGO_API_TOKEN;
  if (!token) throw new Error("SCALINGO_API_TOKEN est requis : le jeton du compte proprietaire des apps.");

  // Region et nom d'app entrent dans des URL qui portent le jeton du compte.
  const { manifest, errors } = readManifest(paths.manifest);
  if (errors.length > 0) throw new Error(`${shown(paths.manifest, cwd)} invalide :\n  ${errors.join("\n  ")}`);
  const selected = fragment ? manifest.apps.filter((a) => a.app.includes(fragment)) : manifest.apps;
  if (selected.length === 0) {
    say("aucune app ne correspond au filtre.");
    return 0;
  }
  const scope = relay ? `relais ${relay.host}` : `retrait du notifier ${NOTIFIER_NAME}`;
  say(`${selected.length} app(s)${fragment ? ` contenant "${fragment}"` : ""}, ${scope}${dryRun ? ", --dry-run : rien ne sera ecrit" : ""}\n`);

  const api = client(await exchangeToken(token), mask);
  const { user } = await api<{ user?: { id?: string } }>("GET", "https://auth.scalingo.com/v1/users/self").catch(
    (e: Error) => {
      throw new Error(`compte du jeton illisible : ${e.message}`);
    },
  );
  if (!user?.id) throw new Error("compte du jeton illisible : reponse sans user.id");

  // Resolus avant toute ecriture : un evenement introuvable dans une region
  // laisserait sinon une partie du parc posee et l'autre non.
  const targets = new Map<string, Target>();
  const regions = [...new Set(selected.filter((a) => !a.paused).map((a) => a.region))].sort();
  for (const region of regions) {
    const platformId = await webhookPlatform(api, region);
    const desired = relay ? { platformId, eventIds: await watchedEvents(api, region), url: relay.url } : null;
    targets.set(region, { platformId, desired });
  }

  const width = Math.max(...selected.map((a) => `${a.region}/${a.app}`.length));
  const tally = new Map<Kind, number>();
  for (const entry of selected) {
    const outcome: Outcome = entry.paused
      ? { kind: "ecartee", text: "ecartee, en pause" }
      : await handleApp(api, entry, user.id, targets.get(entry.region)!, dryRun).catch(
          (e: Error): Outcome => ({ kind: "echec", text: `echec : ${mask(e.message).slice(0, 300)}` }),
        );
    tally.set(outcome.kind, (tally.get(outcome.kind) ?? 0) + 1);
    say(`  ${`${entry.region}/${entry.app}`.padEnd(width)}  ${outcome.text}`);
  }

  const n = (kind: Kind) => tally.get(kind) ?? 0;
  const done = remove
    ? [`${n("supprime")} ${dryRun ? "a supprimer" : "supprime(s)"}`, `${n("absent")} sans notifier`]
    : [
        `${n("cree")} ${dryRun ? "a creer" : "cree(s)"}`,
        `${n("modifie")} ${dryRun ? "a modifier" : "modifie(s)"}`,
        `${n("inchange")} inchange(s)`,
      ];
  say(`\nRecapitulatif : ${[...done, `${n("ecartee")} ecartee(s)`, `${n("echec")} en echec`].join(", ")}.`);
  if (dryRun) say("--dry-run : rien n'a ete ecrit.");
  return n("echec") > 0 ? 1 : 0;
}

/**
 * Code de sortie. Le masquage se fait a l'affichage, pour couvrir aussi les
 * messages que la commande ne compose pas elle-meme.
 */
export async function run(
  argv: readonly string[],
  env: Env,
  print: (line: string) => void = console.log,
  cwd: string = process.cwd(),
): Promise<number> {
  const say = (line = "") => print(redact(line, env.RELAY_URL));
  try {
    return await converge(argv, env, say, cwd);
  } catch (e) {
    say(`\nEchec: ${(e as Error).message}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await run(process.argv.slice(2), process.env);
}
