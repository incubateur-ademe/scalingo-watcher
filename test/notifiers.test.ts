/**
 * Tests de la commande qui pose les notifiers, contre un Scalingo simule.
 *
 *   node test/notifiers.test.ts
 *
 * Aucun appel ne sort : fetch est remplace avant tout passage, et les passages
 * lances en processus chargent un fetch qui refuse tout. Rien n'est ecrit sur
 * le disque, le parc est lu en place dans test/fixtures.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  differences,
  EVENTS,
  isWebhook,
  namesakes,
  NOTIFIER_NAME,
  notifierBody,
  notifiersToRemove,
  planNotifier,
  readRelayUrl,
  redact,
  run,
  unknownArguments,
  type Desired,
  type Notifier,
} from "../src/notifiers.ts";

const ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "src", "notifiers.ts");
const MANIFEST = join(import.meta.dirname, "fixtures", "manifest.yaml");

let failures = 0;
let passed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  ECHEC ${name}\n        obtenu  ${a}\n        attendu ${b}`);
  }
}

// Forme exigee par le relais : https://<hote>/<secret>, secret de 40 caracteres.
// Les deux secrets n'ont aucun morceau de 8 caracteres en commun, pour que la
// fuite de l'un ne passe pas pour celle de l'autre.
const SECRET = "secret-du-relais-0123456789abcdefghijklm";
const RELAY = `https://relais.test/${SECRET}`;
const OLD_SECRET = "ancien.jeton.fedcba9876543210ZYXWVUTSRQP";
const OLD_RELAY = `https://ancien.relais.test/${OLD_SECRET}`;
const TOKEN = "tk-us-jeton-de-test";
const ENV = { SCALINGO_API_TOKEN: TOKEN, RELAY_URL: RELAY };

/** Morceaux de 8 caracteres du secret que porte le texte ; tout morceau plus long en contient un. */
const pieces = (text: string, secret: string) => {
  const found: string[] = [];
  for (let i = 0; i + 8 <= secret.length; i++) if (text.includes(secret.slice(i, i + 8))) found.push(secret.slice(i, i + 8));
  return found;
};

// Toute sortie produite, pour verifier a la fin qu'aucune ne porte de secret.
const outputs: string[] = [];

const blocked = (async () => {
  throw new Error("appel reseau hors du Scalingo simule");
}) as typeof fetch;
globalThis.fetch = blocked;

// Catalogue d'evenements du faux Scalingo, ecrit en dur avec les noms reels et
// des ids inventes. Tire de EVENTS, il accepterait un nom faux.
const CATALOG: Record<string, string> = {
  app_crashed: "01",
  app_deployed: "02",
  app_restarted: "03",
  app_scaled: "04",
  app_stopped: "05",
  app_created: "06",
  database_backup_succeeded: "07",
  database_backup_failed: "08",
};
const eventIds = (region: string) => [`ev-${region}-02`, `ev-${region}-07`, `ev-${region}-08`];
const platformId = (region: string) => `np-webhook-${region}`;
const desiredFor = (region: string, url = RELAY): Desired => ({ platformId: platformId(region), eventIds: eventIds(region), url });

/** Notifier du watcher conforme a l'attendu de la region, sauf surcharges. */
const ours = (region: string, over: Partial<Notifier> = {}): Notifier => ({
  id: `no-${region}-watcher`,
  name: NOTIFIER_NAME,
  active: true,
  platform_id: platformId(region),
  type: "webhook",
  send_all_events: false,
  send_all_alerts: false,
  selected_event_ids: eventIds(region),
  type_data: { webhook_url: RELAY },
  ...over,
});

const foreign = (id: string, name: string): Notifier => ({
  id,
  name,
  active: true,
  platform_id: "np-slack",
  type: "slack",
  send_all_events: true,
  send_all_alerts: true,
  selected_event_ids: [],
  type_data: { webhook_url: "https://hooks.exemple.test/equipe" },
});

console.log("\nEvenements suivis");

check("EVENTS figee sur les noms reels", EVENTS, ["app_deployed", "database_backup_succeeded", "database_backup_failed"]);

console.log("\nPlan pour une app");

{
  const d = desiredFor("osc-fr1");
  check("aucun notifier : creation", planNotifier([], d), { action: "create" });
  check("seulement d'autres notifiers : creation", planNotifier([foreign("no-slack", "slack-equipe")], d), { action: "create" });
  check(
    "identique, evenements dans un autre ordre : rien",
    planNotifier([foreign("no-slack", "slack-equipe"), ours("osc-fr1", { selected_event_ids: [...eventIds("osc-fr1")].reverse() })], d),
    { action: "none", id: "no-osc-fr1-watcher" },
  );
  check(
    "URL differente : seule l'url est a modifier",
    planNotifier([ours("osc-fr1", { type_data: { webhook_url: OLD_RELAY } })], d),
    { action: "update", id: "no-osc-fr1-watcher", changes: ["url"] },
  );
  check(
    "un evenement en moins : seuls les evenements sont a modifier",
    planNotifier([ours("osc-fr1", { selected_event_ids: eventIds("osc-fr1").slice(0, 2) })], d),
    { action: "update", id: "no-osc-fr1-watcher", changes: ["evenements"] },
  );
  check(
    "un evenement en trop : seuls les evenements sont a modifier",
    differences(ours("osc-fr1", { selected_event_ids: [...eventIds("osc-fr1"), "ev-autre"] }), d),
    ["evenements"],
  );
  check("tous les evenements envoyes : evenements", differences(ours("osc-fr1", { send_all_events: true }), d), ["evenements"]);
  check("toutes les alertes envoyees : alertes", differences(ours("osc-fr1", { send_all_alerts: true }), d), ["alertes"]);
  check("inactif : actif", differences(ours("osc-fr1", { active: false }), d), ["actif"]);
  check("autre plateforme : plateforme", differences(ours("osc-fr1", { platform_id: "np-slack" }), d), ["plateforme"]);
  check("autre nom : nom", differences(ours("osc-fr1", { name: "autre" }), d), ["nom"]);
  check(
    "plateforme lue sur notification_platform_id a defaut de platform_id",
    differences(ours("osc-fr1", { platform_id: undefined, notification_platform_id: platformId("osc-fr1") }), d),
    [],
  );
  check(
    "sans id de plateforme, le type la designe",
    differences(ours("osc-fr1", { platform_id: undefined, type: "slack" }), d),
    ["plateforme"],
  );
  check(
    "URL et evenements : les deux, et eux seuls",
    differences(ours("osc-fr1", { type_data: { webhook_url: OLD_RELAY }, selected_event_ids: null }), d),
    ["url", "evenements"],
  );
  check(
    "deux notifiers du watcher : ni creation ni modification",
    planNotifier([ours("osc-fr1"), ours("osc-fr1", { id: "no-double" })], d),
    { action: "duplicate", ids: ["no-osc-fr1-watcher", "no-double"] },
  );
  check("corps du notifier", notifierBody(d), {
    notifier: {
      platform_id: "np-webhook-osc-fr1",
      name: "scalingo-watcher",
      active: true,
      send_all_events: false,
      send_all_alerts: false,
      selected_event_ids: ["ev-osc-fr1-02", "ev-osc-fr1-07", "ev-osc-fr1-08"],
      type_data: { webhook_url: RELAY },
    },
  });
}

console.log("\nNotifier du meme nom sur une autre plateforme");

{
  const d = desiredFor("osc-fr1");
  const webhook = platformId("osc-fr1");
  check("webhook par l'id et le type", isWebhook(ours("osc-fr1"), webhook), true);
  check("webhook par le type seul", isWebhook(ours("osc-fr1", { platform_id: undefined }), webhook), true);
  check("id webhook mais type slack : pas un webhook", isWebhook(ours("osc-fr1", { type: "slack" }), webhook), false);
  check("ni id ni type : pas un webhook", isWebhook(ours("osc-fr1", { platform_id: undefined, type: undefined }), webhook), false);
  check(
    "homonyme slack seul : ni creation ni conversion",
    planNotifier([foreign("no-homonyme", NOTIFIER_NAME)], d),
    { action: "foreign", notifiers: [{ id: "no-homonyme", platform: "slack" }] },
  );
  check(
    "homonyme slack a cote du notifier du watcher : rien non plus",
    planNotifier([ours("osc-fr1"), foreign("no-homonyme", NOTIFIER_NAME)], d),
    { action: "foreign", notifiers: [{ id: "no-homonyme", platform: "slack" }] },
  );
  check(
    "homonyme sans plateforme lisible : nomme tel quel",
    namesakes([ours("osc-fr1", { id: "no-flou", platform_id: undefined, type: undefined })], webhook),
    [{ id: "no-flou", platform: "plateforme illisible" }],
  );
  check(
    "le retrait ne vise que les webhooks du watcher",
    notifiersToRemove(
      [foreign("no-slack", "slack-equipe"), ours("osc-fr1"), foreign("no-homonyme", NOTIFIER_NAME), foreign("no-mail", "scalingo-watcher-copie")],
      webhook,
    ),
    ["no-osc-fr1-watcher"],
  );
}

console.log("\nAdresse du relais et arguments");

{
  const refusals: [string, string][] = [
    ["http", `http://relais.test/${SECRET}`],
    ["identifiants", `https://compte:${SECRET}@relais.test/${SECRET}`],
    ["parametre de requete", `${RELAY}?cle=valeur`],
    ["point d'interrogation final", `${RELAY}?`],
    ["fragment", `${RELAY}#${SECRET}`],
    ["chemin a plusieurs segments", `https://relais.test/v1/ping/${SECRET}`],
    ["barre finale", `${RELAY}/`],
    ["chemin vide", "https://relais.test/"],
    ["segment de 31 caracteres", `https://relais.test/${SECRET.slice(0, 31)}`],
    ["caractere hors du jeu du relais", `https://relais.test/${SECRET.slice(0, 32)}%41`],
    ["espace dans le secret", `https://relais.test/${SECRET.slice(0, 20)} ${SECRET.slice(20)}`],
  ];
  for (const [what, value] of refusals) {
    const read = readRelayUrl(value);
    check(`RELAY_URL refusee : ${what}, sans morceau du secret`, "refused" in read ? pieces(read.refused, SECRET) : "acceptee", []);
  }
  check("RELAY_URL absente refusee", "refused" in readRelayUrl(undefined), true);
  check("RELAY_URL illisible refusee", "refused" in readRelayUrl(SECRET), true);
  check("RELAY_URL en https acceptee, hote seul a afficher", readRelayUrl(` ${RELAY} `), { url: RELAY, host: "relais.test" });
  check(
    "segment de 32 caracteres accepte",
    readRelayUrl(`https://relais.test:8443/${SECRET.slice(0, 32)}`),
    { url: `https://relais.test:8443/${SECRET.slice(0, 32)}`, host: "relais.test:8443" },
  );
  check(
    "adresse retenue sous sa forme analysee",
    readRelayUrl(`https://RELAIS.test/v1/../${SECRET}`),
    { url: RELAY, host: "relais.test" },
  );

  check(
    "masquage de l'adresse, entiere, echappee et en morceaux",
    redact(`a ${RELAY} b ${RELAY.replaceAll("/", "\\/")} c /${SECRET} d ${SECRET} e`, RELAY),
    "a <relais> b <relais> c <relais> d <relais> e",
  );
  check("l'hote reste lisible", redact("relais relais.test", RELAY), "relais relais.test");
  check(
    "secret en parametre de requete masque, meme dans une adresse refusee",
    redact("valeur recue : jeton-de-relais-tres-long-42", "https://relais.test/ping?cle=jeton-de-relais-tres-long-42"),
    "valeur recue : <relais>",
  );

  check(
    "options connues acceptees, sous leurs deux formes",
    unknownArguments(["--dry-run", "--remove", "--app", "alpha", "--manifest=parc/manifest.yaml"]),
    [],
  );
  check(
    "argument inconnu nomme sans sa valeur",
    unknownArguments([RELAY, `--relay=${RELAY}`, "--dryrun"]),
    ["<valeur>", "--relay", "--dryrun"],
  );
}

console.log("\nCommande contre un Scalingo simule");

type FakeApp = { owner: { id: string; username: string }; notifiers: Notifier[] };
type Scenario = {
  // region/app -> etat de l'app
  apps: Record<string, FakeApp>;
  missingEvents?: string[];
  failingLists?: string[];
  // Refus de creation dont le corps recopie l'URL recue a partir de cet index.
  echoAt?: number;
  // Creation acceptee, reponse en JSON invalide qui recopie le chemin recu.
  garbledCreate?: boolean;
  // Champs que Scalingo ignorerait a l'ecriture, sans la refuser.
  ignoreOnWrite?: (keyof Notifier)[];
  // Ecriture acceptee, reponse sans notifier.
  bareWrites?: boolean;
};

const ACCOUNT = { id: "us-compte", username: "compte-du-jeton" };
const OTHER = { id: "us-autre", username: "autre-equipe" };
const app = (notifiers: Notifier[], owner = ACCOUNT): FakeApp => ({ owner, notifiers });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function fakeScalingo(s: Scenario) {
  const calls: string[] = [];
  const bodies: Record<string, unknown> = {};
  let created = 0;
  const kept = (notifier: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(notifier).filter(([k]) => !s.ignoreOnWrite?.includes(k as keyof Notifier)));
  const impl = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    calls.push(`${method} ${url}`);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (body !== undefined) bodies[`${method} ${url}`] = body;
    const auth = new Headers(init.headers).get("Authorization");

    if (method === "POST" && url === "https://auth.scalingo.com/v1/tokens/exchange") {
      return auth === `Basic ${Buffer.from(`:${TOKEN}`).toString("base64")}` ? json({ token: "porteur" }) : json({}, 401);
    }
    if (auth !== "Bearer porteur") return json({ error: "non authentifie" }, 401);
    if (method === "GET" && url === "https://auth.scalingo.com/v1/users/self") {
      return json({ user: { ...ACCOUNT, email: "compte@exemple.test" } });
    }
    const m = /^https:\/\/api\.([a-z0-9-]+)\.scalingo\.com\/v1\/(.+)$/.exec(url);
    if (!m) return json({ error: "hote imprevu" }, 500);
    const [, region, route] = m;
    let r: RegExpExecArray | null;

    if (method === "GET" && route === "notification_platforms") {
      return json({ notification_platforms: [{ id: "np-slack", name: "slack" }, { id: platformId(region), name: "webhook" }] });
    }
    if (method === "GET" && route === "event_types") {
      const listed = Object.entries(CATALOG).filter(([name]) => !s.missingEvents?.includes(name));
      return json({ event_types: listed.map(([name, n]) => ({ id: `ev-${region}-${n}`, name })) });
    }
    if ((r = /^apps\/([^/]+)$/.exec(route)) && method === "GET") {
      const a = s.apps[`${region}/${r[1]}`];
      return a ? json({ app: { id: `id-${r[1]}`, name: r[1], owner: { ...a.owner, email: "x@exemple.test" } } }) : json({}, 404);
    }
    if ((r = /^apps\/([^/]+)\/notifiers$/.exec(route))) {
      const key = `${region}/${r[1]}`;
      const a = s.apps[key];
      if (!a) return json({}, 404);
      if (method === "GET") return s.failingLists?.includes(key) ? json({ error: "indisponible" }, 503) : json({ notifiers: a.notifiers });
      if (method === "POST") {
        const received: string = body.notifier.type_data.webhook_url;
        if (s.echoAt !== undefined) {
          const head = '{"errors":{"webhook_url":["';
          const filler = "adresse injoignable ; ".repeat(20).slice(0, s.echoAt - head.length);
          return new Response(`${head}${filler}${received} refusee"]}}`, { status: 422 });
        }
        if (s.garbledCreate) return new Response(`{"notifier": {"webhook_url": ${new URL(received).pathname}}}`, { status: 201 });
        const notifier = { id: `no-cree-${++created}`, ...kept(body.notifier) } as Notifier;
        a.notifiers.push(notifier);
        return s.bareWrites ? json({}, 201) : json({ notifier }, 201);
      }
    }
    if ((r = /^apps\/([^/]+)\/notifiers\/([^/]+)$/.exec(route))) {
      const a = s.apps[`${region}/${r[1]}`];
      const i = a ? a.notifiers.findIndex((n) => n.id === r![2]) : -1;
      if (!a || i < 0) return json({}, 404);
      if (method === "PATCH") {
        a.notifiers[i] = { ...a.notifiers[i], ...kept(body.notifier) };
        return s.bareWrites ? json({}) : json({ notifier: a.notifiers[i] });
      }
      if (method === "DELETE") {
        a.notifiers.splice(i, 1);
        return new Response(null, { status: 204 });
      }
    }
    return json({ error: "appel imprevu" }, 500);
  };
  return { fetch: impl as typeof fetch, calls, bodies };
}

async function command(s: Scenario, args: string[], env: Record<string, string | undefined> = ENV) {
  const fake = fakeScalingo(s);
  const lines: string[] = [];
  globalThis.fetch = fake.fetch;
  let code: number;
  try {
    code = await run([...args, "--manifest", MANIFEST], env, (line) => lines.push(line), ROOT);
  } finally {
    globalThis.fetch = blocked;
  }
  const output = lines.join("\n");
  outputs.push(output);
  const writes = fake.calls.filter((c) => !c.startsWith("GET ") && !c.endsWith("/tokens/exchange"));
  return { code, output, calls: fake.calls, writes, bodies: fake.bodies };
}

/** Ce qu'annonce la ligne d'une app, sans son nom. */
const lineOf = (output: string, key: string) =>
  output
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith(`${key} `))
    ?.slice(key.length)
    .trim() ?? null;

const FR = "https://api.osc-fr1.scalingo.com/v1/apps";
const SECNUM = "https://api.osc-secnum-fr1.scalingo.com/v1/apps";
const GAMMA_PATCH = `PATCH ${SECNUM}/gamma-metabase/notifiers/no-osc-secnum-fr1-watcher`;

/** Le parc de test : alpha sans notifier du watcher, gamma avec l'ancienne URL, delta a un autre compte. */
const firstFleet = (): Scenario => ({
  apps: {
    "osc-fr1/alpha-metabase": app([foreign("no-slack", "slack-equipe")]),
    "osc-fr1/beta-metabase": app([]),
    "osc-secnum-fr1/gamma-metabase": app([ours("osc-secnum-fr1", { type_data: { webhook_url: OLD_RELAY } })]),
    "osc-secnum-fr1/delta-metabase": app([], OTHER),
  },
});

{
  const s = firstFleet();
  const res = await command(s, []);
  check("pose : sortie 0", res.code, 0);
  check("pose : seules ecritures, la creation sur alpha et la modification sur gamma", res.writes, [
    `POST ${FR}/alpha-metabase/notifiers`,
    GAMMA_PATCH,
  ]);
  check("pose : notifier cree tel qu'attendu dans sa region", res.bodies[`POST ${FR}/alpha-metabase/notifiers`], notifierBody(desiredFor("osc-fr1")));
  check("pose : les autres notifiers de l'app restent intacts", s.apps["osc-fr1/alpha-metabase"].notifiers[0], foreign("no-slack", "slack-equipe"));
  check("pose : alpha annoncee creee", lineOf(res.output, "osc-fr1/alpha-metabase"), "notifier cree");
  check("pose : gamma annoncee modifiee, sur l'url seule", lineOf(res.output, "osc-secnum-fr1/gamma-metabase"), "notifier modifie (url)");
  check(
    "pose : gamma porte desormais l'adresse du relais",
    s.apps["osc-secnum-fr1/gamma-metabase"].notifiers[0].type_data?.webhook_url === RELAY,
    true,
  );
  check(
    "pose : app en pause ignoree, sans aucun appel",
    [lineOf(res.output, "osc-fr1/beta-metabase"), res.calls.filter((c) => c.includes("beta-metabase"))],
    ["ecartee, en pause", []],
  );
  check(
    "pose : app d'un autre proprietaire ecartee, son proprietaire nomme",
    lineOf(res.output, "osc-secnum-fr1/delta-metabase"),
    "ecartee, proprietaire autre-equipe hors du compte du jeton",
  );
  check(
    "pose : rien n'est lu ni ecrit dans les notifiers de l'app d'un autre",
    res.calls.filter((c) => c.includes("delta-metabase/notifiers")),
    [],
  );
  check("pose : seul l'hote du relais est affiche", res.output.includes("relais relais.test"), true);
  check(
    "pose : recapitulatif",
    res.output.includes("Recapitulatif : 1 cree(s), 1 modifie(s), 0 inchange(s), 2 ecartee(s), 0 en echec."),
    true,
  );
  check(
    "pose : aucun appel hors de Scalingo",
    res.calls.filter((c) => !/^\w+ https:\/\/(auth|api\.[a-z0-9-]+)\.scalingo\.com\//.test(c)),
    [],
  );

  const again = await command(s, []);
  check("relance sur le parc pose : rien a ecrire", [again.code, again.writes], [0, []]);
  check(
    "relance sur le parc pose : alpha et gamma inchangees",
    [lineOf(again.output, "osc-fr1/alpha-metabase"), lineOf(again.output, "osc-secnum-fr1/gamma-metabase")],
    ["notifier inchange", "notifier inchange"],
  );
}

{
  const s: Scenario = {
    apps: {
      ...firstFleet().apps,
      "osc-fr1/alpha-metabase": app([ours("osc-fr1")]),
      "osc-secnum-fr1/gamma-metabase": app([ours("osc-secnum-fr1", { selected_event_ids: eventIds("osc-secnum-fr1").slice(0, 1) })]),
    },
  };
  const res = await command(s, []);
  check("evenements differents : seule gamma est modifiee", res.writes, [GAMMA_PATCH]);
  check("evenements differents : annonce sur les evenements seuls", lineOf(res.output, "osc-secnum-fr1/gamma-metabase"), "notifier modifie (evenements)");
  check(
    "evenements differents : la modification porte les trois evenements",
    (res.bodies[GAMMA_PATCH] as ReturnType<typeof notifierBody> | undefined)?.notifier.selected_event_ids,
    ["ev-osc-secnum-fr1-02", "ev-osc-secnum-fr1-07", "ev-osc-secnum-fr1-08"],
  );
}

{
  const s = firstFleet();
  const res = await command(s, ["--dry-run"]);
  check("--dry-run : sortie 0 et aucune ecriture", [res.code, res.writes], [0, []]);
  check(
    "--dry-run : annonce ce qui serait fait",
    [lineOf(res.output, "osc-fr1/alpha-metabase"), lineOf(res.output, "osc-secnum-fr1/gamma-metabase")],
    ["notifier a creer", "notifier a modifier (url)"],
  );
  check("--dry-run : le dit en fin de sortie", res.output.trimEnd().endsWith("--dry-run : rien n'a ete ecrit."), true);
  check("--dry-run : le parc simule est intact", s, firstFleet());
}

{
  const s = firstFleet();
  const res = await command(s, ["--app", "gamma"]);
  check("--app : sortie 0, une app retenue", [res.code, res.output.split("\n")[0]], [0, '1 app(s) contenant "gamma", relais relais.test']);
  check("--app : l'app visee est traitee", lineOf(res.output, "osc-secnum-fr1/gamma-metabase"), "notifier modifie (url)");
  check("--app : seule ecriture, la modification de gamma", res.writes, [GAMMA_PATCH]);
  check("--app : aucune autre app lue", res.calls.filter((c) => c.includes("/v1/apps/") && !c.includes("/gamma-metabase")), []);
  check("--app : la region hors du filtre n'est pas interrogee", res.calls.filter((c) => c.includes("api.osc-fr1.")), []);
  check("--app : une seule ligne d'app", res.output.split("\n").filter((l) => l.includes("-metabase")).length, 1);

  const none = await command(firstFleet(), ["--app", "inconnue"]);
  check("--app sans correspondance : sortie 0, aucun appel, dit", [none.code, none.calls, none.output], [0, [], "aucune app ne correspond au filtre."]);
}

{
  const removalFleet = (): Scenario => ({
    apps: {
      "osc-fr1/alpha-metabase": app([foreign("no-slack", "slack-equipe"), ours("osc-fr1")]),
      "osc-fr1/beta-metabase": app([ours("osc-fr1", { id: "no-beta" })]),
      "osc-secnum-fr1/gamma-metabase": app([ours("osc-secnum-fr1"), foreign("no-mail", "astreinte")]),
      "osc-secnum-fr1/delta-metabase": app([ours("osc-secnum-fr1", { id: "no-delta" })], OTHER),
    },
  });
  const s = removalFleet();
  const dry = await command(s, ["--remove", "--dry-run"], { SCALINGO_API_TOKEN: TOKEN });
  check("--remove --dry-run : aucune suppression", [dry.code, dry.writes], [0, []]);
  check("--remove --dry-run : annonce", lineOf(dry.output, "osc-fr1/alpha-metabase"), "notifier a supprimer");

  const only = removalFleet();
  const one = await command(only, ["--remove", "--app", "alpha"], { SCALINGO_API_TOKEN: TOKEN });
  check(
    "--remove --app : seule l'app visee perd son notifier",
    [one.code, one.writes, lineOf(one.output, "osc-fr1/alpha-metabase")],
    [0, [`DELETE ${FR}/alpha-metabase/notifiers/no-osc-fr1-watcher`], "notifier supprime"],
  );
  check("--remove --app : gamma garde le sien", only.apps["osc-secnum-fr1/gamma-metabase"].notifiers.length, 2);

  const res = await command(s, ["--remove"], { SCALINGO_API_TOKEN: TOKEN });
  check("--remove : sortie 0, sans RELAY_URL", res.code, 0);
  check("--remove : ne supprime que le notifier du watcher, chez le compte du jeton", res.writes, [
    `DELETE ${FR}/alpha-metabase/notifiers/no-osc-fr1-watcher`,
    `DELETE ${SECNUM}/gamma-metabase/notifiers/no-osc-secnum-fr1-watcher`,
  ]);
  check(
    "--remove : les autres notifiers restent",
    [s.apps["osc-fr1/alpha-metabase"].notifiers.map((n) => n.id), s.apps["osc-secnum-fr1/gamma-metabase"].notifiers.map((n) => n.id)],
    [["no-slack"], ["no-mail"]],
  );
  check(
    "--remove : app en pause et app d'un autre laissees en l'etat",
    [s.apps["osc-fr1/beta-metabase"].notifiers.length, s.apps["osc-secnum-fr1/delta-metabase"].notifiers.length],
    [1, 1],
  );
  check("--remove : recapitulatif", res.output.includes("Recapitulatif : 2 supprime(s), 0 sans notifier, 2 ecartee(s), 0 en echec."), true);

  const twice = await command(s, ["--remove"], { SCALINGO_API_TOKEN: TOKEN });
  check(
    "--remove relance : rien a supprimer",
    [twice.writes, lineOf(twice.output, "osc-fr1/alpha-metabase")],
    [[], "aucun notifier webhook scalingo-watcher"],
  );
}

{
  const s: Scenario = {
    apps: {
      ...firstFleet().apps,
      "osc-fr1/alpha-metabase": app([foreign("no-homonyme", NOTIFIER_NAME)]),
    },
  };
  const res = await command(s, []);
  check("homonyme slack : sortie 1", res.code, 1);
  check(
    "homonyme slack : l'app en echec nomme l'id et la commande de retrait",
    lineOf(res.output, "osc-fr1/alpha-metabase"),
    "echec : notifier(s) no-homonyme (slack) nomme(s) scalingo-watcher sur une autre plateforme que webhook ; le retirer ou le renommer a la main (scalingo --region osc-fr1 --app alpha-metabase notifiers-remove no-homonyme), puis relancer",
  );
  check("homonyme slack : rien d'ecrit sur l'app, les autres traitees", res.writes, [GAMMA_PATCH]);
  check("homonyme slack : laisse intact", s.apps["osc-fr1/alpha-metabase"].notifiers, [foreign("no-homonyme", NOTIFIER_NAME)]);

  const r: Scenario = {
    apps: {
      ...firstFleet().apps,
      "osc-fr1/alpha-metabase": app([foreign("no-homonyme", NOTIFIER_NAME), ours("osc-fr1")]),
      "osc-secnum-fr1/gamma-metabase": app([foreign("no-homonyme-2", NOTIFIER_NAME)]),
    },
  };
  const removed = await command(r, ["--remove"], { SCALINGO_API_TOKEN: TOKEN });
  check("homonyme slack, --remove : seul le webhook est supprime", [removed.code, removed.writes], [
    0,
    [`DELETE ${FR}/alpha-metabase/notifiers/no-osc-fr1-watcher`],
  ]);
  check(
    "homonyme slack, --remove : chaque homonyme laisse en place est nomme",
    [lineOf(removed.output, "osc-fr1/alpha-metabase"), lineOf(removed.output, "osc-secnum-fr1/gamma-metabase")],
    [
      "notifier supprime ; laisse(s) en place, autre plateforme : no-homonyme (slack)",
      "aucun notifier webhook scalingo-watcher ; laisse(s) en place, autre plateforme : no-homonyme-2 (slack)",
    ],
  );
  check(
    "homonyme slack, --remove : les homonymes restent",
    [r.apps["osc-fr1/alpha-metabase"].notifiers.map((n) => n.id), r.apps["osc-secnum-fr1/gamma-metabase"].notifiers.map((n) => n.id)],
    [["no-homonyme"], ["no-homonyme-2"]],
  );
}

{
  const events = await command({ ...firstFleet(), ignoreOnWrite: ["selected_event_ids"] }, []);
  check("evenements ignores a la creation : sortie 1", events.code, 1);
  check(
    "evenements ignores a la creation : l'ecart restant est un echec",
    [lineOf(events.output, "osc-fr1/alpha-metabase"), lineOf(events.output, "osc-secnum-fr1/gamma-metabase")],
    ["echec : notifier cree, ecart restant apres ecriture (evenements)", "notifier modifie (url)"],
  );
  check("evenements ignores a la creation : recapitulatif", events.output.includes("0 cree(s), 1 modifie(s), 0 inchange(s), 2 ecartee(s), 1 en echec."), true);

  const url = await command({ ...firstFleet(), ignoreOnWrite: ["type_data"] }, []);
  check(
    "adresse ignoree a la modification : l'ecart restant est un echec",
    [url.code, lineOf(url.output, "osc-secnum-fr1/gamma-metabase")],
    [1, "echec : notifier modifie, ecart restant apres ecriture (url)"],
  );

  const bare = await command({ ...firstFleet(), bareWrites: true }, []);
  check(
    "ecriture sans notifier rendu : echec",
    [bare.code, lineOf(bare.output, "osc-fr1/alpha-metabase"), lineOf(bare.output, "osc-secnum-fr1/gamma-metabase")],
    [1, "echec : notifier cree, sans notifier rendu a verifier", "echec : notifier modifie, sans notifier rendu a verifier"],
  );
}

{
  const res = await command(firstFleet(), [], { ...ENV, RELAY_URL: `http://relais.test/${SECRET}` });
  check("RELAY_URL en http : sortie 1 sans aucun appel", [res.code, res.calls], [1, []]);
  check("RELAY_URL en http : le refus dit pourquoi", res.output.includes("doit etre en https"), true);

  const path = await command(firstFleet(), [], { ...ENV, RELAY_URL: `https://relais.test/v1/ping/${SECRET}` });
  check("RELAY_URL a plusieurs segments : sortie 1 sans aucun appel", [path.code, path.calls], [1, []]);
  check("RELAY_URL a plusieurs segments : la forme attendue dite", path.output.includes("https://<relais>/<RELAY_SECRET>"), true);

  const missing = await command(firstFleet(), [], { SCALINGO_API_TOKEN: TOKEN });
  check("RELAY_URL absente : sortie 1 sans aucun appel", [missing.code, missing.calls], [1, []]);

  const noToken = await command(firstFleet(), [], { RELAY_URL: RELAY });
  check("SCALINGO_API_TOKEN absent : sortie 1 sans aucun appel", [noToken.code, noToken.calls], [1, []]);

  const stray = await command(firstFleet(), [RELAY], { SCALINGO_API_TOKEN: TOKEN });
  check("URL passee en argument : sortie 1 sans aucun appel", [stray.code, stray.calls], [1, []]);
  check("URL passee en argument : jamais reprise", stray.output.includes(SECRET), false);
}

{
  const res = await command({ ...firstFleet(), missingEvents: ["database_backup_failed"] }, []);
  check("evenement introuvable : sortie 1 et aucune ecriture", [res.code, res.writes], [1, []]);
  check("evenement introuvable : nomme", res.output.includes("database_backup_failed"), true);
}

{
  const s = { ...firstFleet(), failingLists: ["osc-fr1/alpha-metabase"] };
  const res = await command(s, []);
  check("app en echec : sortie 1", res.code, 1);
  check("app en echec : annoncee avec le message", lineOf(res.output, "osc-fr1/alpha-metabase")?.startsWith("echec : 503 sur GET"), true);
  check("app en echec : les suivantes sont traitees", res.writes, [GAMMA_PATCH]);
  check("app en echec : comptee au recapitulatif", res.output.includes("1 en echec."), true);
}

{
  const s: Scenario = { apps: { ...firstFleet().apps, "osc-fr1/alpha-metabase": app([ours("osc-fr1"), ours("osc-fr1", { id: "no-double" })]) } };
  const res = await command(s, []);
  check("deux notifiers du watcher : sortie 1", res.code, 1);
  check(
    "deux notifiers du watcher : l'app, les ids et une commande ciblee nommes",
    lineOf(res.output, "osc-fr1/alpha-metabase"),
    "echec : 2 notifiers scalingo-watcher sur alpha-metabase (no-osc-fr1-watcher, no-double), un seul attendu ; retirer ceux en trop avec scalingo --region osc-fr1 --app alpha-metabase notifiers-remove <id>, puis relancer",
  );
  check("deux notifiers du watcher : jamais --remove, qui viserait tout le parc", res.output.includes("--remove"), false);
  check("deux notifiers du watcher : rien d'ecrit sur l'app", res.writes.filter((c) => c.includes("alpha-metabase")), []);
}

{
  const res = await command({ ...firstFleet(), echoAt: 30 }, ["--app", "alpha"]);
  check("refus qui reprend l'URL : app en echec", lineOf(res.output, "osc-fr1/alpha-metabase")?.startsWith("echec : 422 sur POST"), true);
  check("refus qui reprend l'URL : masquee dans la sortie", [res.output.includes(SECRET), res.output.includes("<relais> refusee")], [false, true]);

  const at170 = await command({ ...firstFleet(), echoAt: 169 }, ["--app", "alpha"]);
  check(
    "URL reprise a partir du 170e caractere : masquee avant la coupe",
    [lineOf(at170.output, "osc-fr1/alpha-metabase")?.includes("<relais>"), pieces(at170.output, SECRET)],
    [true, []],
  );
  const leaks: number[] = [];
  for (let at = 120; at < 200; at++) {
    const cut = await command({ ...firstFleet(), echoAt: at }, ["--app", "alpha"]);
    if (pieces(cut.output, SECRET).length > 0) leaks.push(at);
  }
  check("URL reprise a toute position autour de la coupe : aucun morceau du secret", leaks, []);

  const garbled = await command({ ...firstFleet(), garbledCreate: true }, ["--app", "alpha"]);
  check(
    "reponse illisible qui reprend le secret : echec, sans morceau du secret",
    [lineOf(garbled.output, "osc-fr1/alpha-metabase")?.includes("reponse illisible"), pieces(garbled.output, SECRET)],
    [true, []],
  );
}

console.log("\nCommande lancee en processus");

// Un fetch qui refuse tout et compte ses appels : la commande ne doit jamais
// atteindre le reseau dans ces passages.
const BLOCKER = `data:text/javascript,${encodeURIComponent(
  'let n=0;globalThis.fetch=async()=>{n++;throw new Error("appel reseau interdit")};process.on("exit",()=>process.stderr.write("\\nappels-reseau="+n+"\\n"))',
)}`;
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k]) => !["SCALINGO_API_TOKEN", "RELAY_URL", "FGP_KEY", "FGP_URL", "RUNNER_TEMP", "GITHUB_REPOSITORY", "NODE_OPTIONS"].includes(k),
  ),
);

function spawn(args: string[], env: Record<string, string>) {
  const child = spawnSync(process.execPath, ["--import", BLOCKER, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...cleanEnv, ...env },
  });
  const output = `${child.stdout}${child.stderr}`;
  outputs.push(output);
  return { status: child.status, output, calls: Number(/appels-reseau=(\d+)/.exec(output)?.[1] ?? -1) };
}

{
  const http = spawn([SCRIPT, "--manifest", MANIFEST], { SCALINGO_API_TOKEN: TOKEN, RELAY_URL: `http://relais.test/${SECRET}` });
  check("processus, RELAY_URL en http : sortie 1, aucun appel", [http.status, http.calls], [1, 0]);

  const down = spawn([SCRIPT, "--manifest", MANIFEST], { SCALINGO_API_TOKEN: TOKEN, RELAY_URL: RELAY });
  check("processus, echange du jeton impossible : sortie 1 apres un seul appel", [down.status, down.calls, down.output.includes("Echec:")], [1, 1, true]);

  const imported = spawn(["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(SCRIPT).href)})`], {
    SCALINGO_API_TOKEN: TOKEN,
    RELAY_URL: RELAY,
  });
  check(
    "import du module : aucun effet",
    [imported.status, imported.calls, imported.output.trim()],
    [0, 0, "appels-reseau=0"],
  );
}

console.log("\nSecrets");

check("aucune sortie ne porte de morceau du secret", outputs.filter((o) => pieces(o, SECRET).length > 0).length, 0);
check("aucune sortie ne porte de morceau de l'ancien secret", outputs.filter((o) => pieces(o, OLD_SECRET).length > 0).length, 0);
check("aucune sortie ne porte le jeton", outputs.filter((o) => o.includes(TOKEN)).length, 0);

console.log(`\n${passed} ok, ${failures} echec(s)`);
if (failures > 0) process.exit(1);
