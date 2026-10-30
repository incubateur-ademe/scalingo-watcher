/**
 * Scopes des blobs du proxy, et lecture de ses refus.
 *
 * Chez FGP, un scope est `METHODES:chemin`. Le chemin est compare sans sa query,
 * et `*` y remplace n'importe quelle suite non vide de caracteres, `/` compris :
 * `/v1/apps/*` couvre donc aussi `/v1/apps/x/variables`. C'est pourquoi chaque
 * route d'app est ecrite avec le nom de l'app en toutes lettres.
 *
 * Ce que le watcher fait, et rien de plus. Notamment aucun DELETE, aucune
 * creation d'app, aucun changement de stack, aucun scale.
 */

export type ScopedApp = { app: string; paused?: boolean };

// Lectures sans app : la liste sert a l'audit et a init, et les stacks portent
// leur date de depreciation, ce qui permet de voir venir une echeance.
const GLOBAL_READS = ["GET:/v1/apps", "GET:/v1/features/stacks"];

function appScopes({ app, paused }: ScopedApp): string[] {
  const base = `/v1/apps/${app}`;
  // Une app en pause n'est ni deployee ni reconfiguree : sa cle ne doit pas le
  // permettre non plus, meme si elle fuit.
  const write = (method: string) => (paused ? "GET" : `GET|${method}`);
  return [
    `GET:${base}`,
    `${write("POST")}:${base}/variables`,
    ...(paused ? [] : [`PATCH:${base}/variables/*`]),
    `${write("POST")}:${base}/deployments`,
    // Le detail d'un deploiement et son journal de build.
    `GET:${base}/deployments/*`,
    // La fenetre de garde, apres un deploiement, y cherche un redemarrage que
    // personne n'a demande. Inutile a une app en pause, qu'on ne deploie pas.
    ...(paused ? [] : [`GET:${base}/events`]),
    `GET:${base}/addons`,
    `GET:${base}/scm_repo_link`,
  ];
}

/** Scopes du blob d'API d'une region, pour les apps du manifeste dans cette region. */
export function apiScopes(apps: readonly ScopedApp[]): string[] {
  const sorted = [...apps].sort((a, b) => a.app.localeCompare(b.app));
  return [...GLOBAL_READS, ...sorted.flatMap(appScopes)];
}

/**
 * Scopes du blob de base d'une app. Le mode scalingo-addon fige deja l'addon
 * dans le blob : le jeton qu'il obtient ne vaut que pour cette base. En pause,
 * ni sauvegarde ni montee de version, la lecture seule suffit au rapport.
 */
export function backupScopes(paused = false): string[] {
  if (paused) return ["GET:/api/databases/*", "GET:/api/database_type_versions/*", "GET:/api/operations/*"];
  return [
    "GET|POST:/api/databases/*/backups",
    "GET:/api/databases/*",
    // Montee de version, decidee par une pull request qui bump le manifeste. Le
    // scope reste borne a cette route : ni suppression, ni changement de plan.
    "POST:/api/databases/*/upgrade",
    "GET:/api/database_type_versions/*",
    "GET:/api/operations/*",
  ];
}

// Court : les rapports tronquent les messages d'erreur a 240 caracteres.
export const REGENERATE_HINT =
  "appel hors des scopes de fgp.json, a regenerer avec fgp-blobs.ts apres l'ajout d'une app au manifeste ou la levee d'une pause";

/**
 * Vrai quand c'est le proxy, et non Scalingo, qui refuse l'appel faute de scope.
 * L'en-tete X-FGP-Source distingue les deux : un 403 de Scalingo arrive avec
 * `upstream`.
 */
export function deniedByProxy(res: Response, body: string): boolean {
  if (res.status !== 403 || res.headers.get("X-FGP-Source") !== "proxy") return false;
  try {
    return (JSON.parse(body) as { error?: unknown }).error === "scope_denied";
  } catch {
    return false;
  }
}
