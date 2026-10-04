/**
 * Chemins communs aux commandes du moteur.
 *
 *   --manifest <chemin>   manifeste du parc (defaut manifest.yaml)
 *   --lock <chemin>       etat constate du parc (defaut lock.json)
 *   --fgp <chemin>        blobs du proxy FGP (defaut fgp.json)
 *   --out-dir <chemin>    sorties d'un passage : incident.md, db-proposal.json,
 *                         pr-title.txt, pr-body.md, fgp.json.bak
 *
 * Les chemins relatifs partent du repertoire courant, c'est-a-dire de la racine
 * du depot qui porte le parc. Les sorties vont par defaut hors de ce depot : un
 * fichier produit a cote du lock finit tot ou tard commite avec lui.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export type Paths = { manifest: string; lock: string; fgp: string; outDir: string };

export const DEFAULT_FGP_URL = "https://fgp.incubateur.ademe.fr";

/**
 * Valeurs d'une option, sous ses deux formes `--flag valeur` et `--flag=valeur`.
 *
 * Une option sans valeur est une erreur et non une absence : ignoree, elle
 * ferait retomber la commande sur son defaut, par exemple un autre parc ou une
 * autre region que celle qu'on croit designer.
 */
export function flagValues(argv: readonly string[], flag: string): string[] {
  const values: string[] = [];
  argv.forEach((arg, i) => {
    if (arg.startsWith(`${flag}=`)) {
      const value = arg.slice(flag.length + 1);
      if (!value) throw new Error(`${flag} attend une valeur`);
      values.push(value);
    } else if (arg === flag) {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`${flag} attend une valeur`);
      values.push(value);
    }
  });
  return values;
}

/** Valeur d'une option qui n'en prend qu'une : la derniere donnee, ou null. */
export const flagValue = (argv: readonly string[], flag: string): string | null => flagValues(argv, flag).at(-1) ?? null;

export type Fgp = { url: string; api: Record<string, string>; backup: Record<string, string> };

/** Blobs du proxy, ou null sans fichier. Un fichier illisible est une erreur. */
export function readFgpFile(file: string): Fgp | null {
  if (!existsSync(file)) return null;
  const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Fgp>;
  return { url: raw.url ?? DEFAULT_FGP_URL, api: raw.api ?? {}, backup: raw.backup ?? {} };
}

export function resolvePaths(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): Paths {
  const at = (flag: string, fallback: string) => resolve(cwd, flagValue(argv, flag) ?? fallback);
  return {
    manifest: at("--manifest", "manifest.yaml"),
    lock: at("--lock", "lock.json"),
    fgp: at("--fgp", "fgp.json"),
    outDir: at("--out-dir", join(env.RUNNER_TEMP || tmpdir(), "scalingo-watcher")),
  };
}

/** Chemin d'une sortie, repertoire cree au besoin. */
export function outFile(paths: Paths, name: string): string {
  mkdirSync(paths.outDir, { recursive: true });
  return join(paths.outDir, name);
}

/** Chemin tel qu'on l'afficherait : relatif s'il est sous le repertoire courant. */
export function shown(path: string, cwd: string = process.cwd()): string {
  const rel = relative(cwd, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}

/** Les deux facons de donner acces a Scalingo, pour le message d'absence d'acces. */
export function accessModes(fgpFile: string): string[] {
  const proxy = `FGP_KEY + ${shown(fgpFile)}`;
  const width = Math.max(proxy.length, "SCALINGO_API_TOKEN".length) + 3;
  return [
    `  soit ${proxy.padEnd(width)}(proxy, acces borne : voir fgp.md)`,
    `  soit ${"SCALINGO_API_TOKEN".padEnd(width)}(direct, tout le pouvoir du compte)`,
  ];
}
