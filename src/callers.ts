/**
 * Controle les workflows d'un parc qui appellent les actions de l'outil.
 *
 * Une action composite ne declare ni concurrence ni secrets : le job appelant
 * les porte, et GitHub n'en verifie rien. Un input inconnu ne donne qu'un
 * avertissement, un input marque required qui manque arrive vide. Sans ce
 * controle, un groupe scalingo-apply oublie laissait deux convergences tourner
 * en parallele sans que rien ne le signale, et un secret non passe faisait
 * tourner le parc sans acces.
 *
 *   node src/callers.ts [--workflows .github/workflows]
 *
 * Lance par l'action validate depuis la racine du depot du parc. Les inputs
 * sont confrontes aux actions de la copie de l'outil qui l'execute.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { flagValue } from "./options.ts";

export const LOCK_GROUP = "scalingo-apply";

/** Actions qui font converger le parc : elles tournent sous le verrou. */
const CONVERGING = new Set(["reconcile", "apply"]);
/** Propositions : chacune a son groupe, deux passages poussant en force la meme branche. */
const PROPOSING = new Set(["propose-db", "propose-security"]);

const ACTION_REF = /^[\w.-]+\/scalingo-watcher\/actions\/([\w-]+)@(\S+)$/;
const WORKFLOW_REF = /^[\w.-]+\/scalingo-watcher\/\.github\/workflows\/([\w-]+)\.ya?ml@\S+$/;

export type ActionInputs = Record<string, { required?: boolean } | null>;
/** Inputs de l'action `name` a la version `ref`, null si elle n'y existe pas. */
export type InputsAt = (name: string, ref: string) => ActionInputs | null;

type Concurrency = string | { group?: unknown; "cancel-in-progress"?: unknown } | null | undefined;
type Step = { uses?: unknown; with?: unknown } | null;
type Job = { uses?: unknown; steps?: unknown; concurrency?: Concurrency } | null;
type Workflow = { concurrency?: Concurrency; jobs?: Record<string, Job> } | null;

export type Call = { file: string; job: string; action: string; ref: string };

const groupOf = (c: Concurrency) => (typeof c === "string" ? c : c?.group);
// Une expression ne se lit pas avant l'execution : seul un false litteral
// garantit qu'un passage en cours n'est jamais annule.
const mayCancel = (c: Concurrency) => typeof c === "object" && c !== null && c["cancel-in-progress"] !== undefined && c["cancel-in-progress"] !== false;

// Les deux niveaux comptent : un groupe annulable au niveau du workflow annule
// le run entier, job sous verrou compris, quel que soit le groupe du job.
function concurrencyErrors(where: string, action: string, top: Concurrency, own: Concurrency): string[] {
  const errors: string[] = [];
  const [atTop, atJob] = [groupOf(top), groupOf(own)];
  if (atTop !== undefined && atTop === atJob) {
    errors.push(`${where} : groupe ${String(atTop)} declare au niveau du workflow et du job, GitHub annule le run pour interblocage. Le garder au seul niveau du job.`);
  }
  if (CONVERGING.has(action) && atTop !== LOCK_GROUP && atJob !== LOCK_GROUP) {
    errors.push(
      `${where} : actions/${action} converge hors du groupe de concurrence ${LOCK_GROUP}, deux convergences pourraient tourner en parallele. ` +
        `Declarer sur le job : concurrency: { group: ${LOCK_GROUP}, cancel-in-progress: false }`,
    );
  }
  if (PROPOSING.has(action) && !atTop && !atJob) {
    errors.push(
      `${where} : actions/${action} tourne sans groupe de concurrence, deux passages pousseraient en force la meme branche. ` +
        `Declarer sur le job : concurrency: { group: scalingo-watcher-${action}, cancel-in-progress: false }`,
    );
  }
  if (PROPOSING.has(action) && (atTop === LOCK_GROUP || atJob === LOCK_GROUP)) {
    errors.push(
      `${where} : actions/${action} tourne sous le verrou ${LOCK_GROUP} de la convergence, qu'elle retiendrait sans y toucher. ` +
        `Declarer sur le job : concurrency: { group: scalingo-watcher-${action}, cancel-in-progress: false }`,
    );
  }
  if (mayCancel(top) || mayCancel(own)) {
    errors.push(`${where} : cancel-in-progress doit valoir false au niveau du workflow comme du job, un passage annule peut l'etre en pleine sauvegarde, en plein deploiement ou en plein push.`);
  }
  return errors;
}

/**
 * Les inputs sont lus dans une seule version de l'outil. Renovate avance tous
 * les appels ensemble, donc une divergence vient d'une modification a la main
 * et fausserait le controle.
 */
export function misalignedRefs(calls: readonly Call[]): string | null {
  const refs = [...new Set(calls.map((c) => c.ref))];
  return refs.length > 1 ? `les appels de l'outil n'epinglent pas tous la meme version (${refs.join(", ")}) : les aligner` : null;
}

/**
 * `errors` vaut pour la version que `inputsAt` consulte, nommee par `version`
 * quand ce n'est pas celle que l'appel epingle. `retired` liste les appels des
 * workflows reutilisables de la v1, qui ne sont des erreurs qu'une fois
 * l'appelant passe a la v2.
 */
export function checkCallers(
  files: readonly { file: string; text: string }[],
  inputsAt: InputsAt,
  version?: string,
): { calls: Call[]; errors: string[]; retired: string[] } {
  const calls: Call[] = [];
  const errors: string[] = [];
  const retired: string[] = [];
  for (const { file, text } of files) {
    let workflow: Workflow;
    try {
      workflow = parse(text) as Workflow;
    } catch (e) {
      errors.push(`${file} : YAML illisible (${(e as Error).message})`);
      continue;
    }
    for (const [id, job] of Object.entries(workflow?.jobs ?? {})) {
      const where = `${file}, job ${id}`;
      const old = typeof job?.uses === "string" ? WORKFLOW_REF.exec(job.uses) : null;
      if (old) {
        retired.push(`${where} : appelle le workflow reutilisable ${old[1]}, retire de l'outil en v2. Le remplacer par l'action actions/${old[1]} dans un pas du job.`);
      }
      for (const step of Array.isArray(job?.steps) ? (job.steps as Step[]) : []) {
        const m = typeof step?.uses === "string" ? ACTION_REF.exec(step.uses) : null;
        if (!m) continue;
        const [, action, ref] = m;
        calls.push({ file, job: id, action, ref });
        const inputs = inputsAt(action, ref);
        if (!inputs) {
          errors.push(`${where} : actions/${action} n'existe pas a ${version ?? ref}`);
          continue;
        }
        const given = step?.with && typeof step.with === "object" ? Object.keys(step.with) : [];
        for (const key of given.filter((k) => !Object.hasOwn(inputs, k))) {
          errors.push(`${where} : actions/${action} n'a pas d'input ${key}. Inputs : ${Object.keys(inputs).join(", ")}.`);
        }
        for (const key of Object.keys(inputs).filter((k) => inputs[k]?.required && !given.includes(k))) {
          errors.push(`${where} : actions/${action} attend l'input ${key}, a ecrire meme quand le secret qu'il porte est vide.`);
        }
        errors.push(...concurrencyErrors(where, action, workflow?.concurrency, job?.concurrency));
      }
    }
  }
  return { calls, errors, retired };
}

/** Inputs des actions de cette copie de l'outil, quelle que soit la version demandee. */
const localInputs: InputsAt = (name) => {
  const file = join(import.meta.dirname, "..", "actions", name, "action.yml");
  if (!existsSync(file)) return null;
  return ((parse(readFileSync(file, "utf8")) as { inputs?: ActionInputs } | null)?.inputs ?? {}) as ActionInputs;
};

if (import.meta.main) {
  const dir = flagValue(process.argv, "--workflows") ?? join(".github", "workflows");
  const names = existsSync(dir) ? readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort() : [];
  const files = names.map((f) => ({ file: join(dir, f), text: readFileSync(join(dir, f), "utf8") }));
  const { calls, errors, retired } = checkCallers(files, localInputs);
  errors.push(...retired);
  const misaligned = misalignedRefs(calls);
  if (misaligned) errors.push(misaligned);

  for (const e of errors) console.log(`::error::${e}`);
  if (errors.length > 0) process.exit(1);
  // validate est lui-meme un appel : n'en voir aucun veut dire que le controle
  // n'a pas lu les workflows du parc, pas qu'ils sont conformes.
  if (calls.length === 0) {
    console.log(`::warning::aucun appel des actions de l'outil reconnu dans ${dir} : le depot du parc est-il a la racine du workspace ?`);
  } else {
    console.log(`${calls.length} appel(s) des actions de l'outil controle(s) dans ${dir}`);
  }
}
