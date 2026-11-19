/**
 * Ce que dit le journal d'un build Scalingo : les buildpacks qu'il a charges et
 * ce qu'ils ont installe. C'est la seule trace de l'un comme de l'autre, l'API
 * n'exposant ni le contenu du `.buildpacks` ni les versions installees.
 */
import { BUILDPACKS } from "./buildpacks/index.ts";

/**
 * Depot et ref d'une entree de buildpack. La meme forme d'URL s'ecrit dans le
 * `.buildpacks` du depot applicatif et se relit dans le journal de build : un
 * seul parseur garde les deux releves comparables entre eux.
 */
export const parseBuildpackRef = (url: string): { repo: string; ref: string | null } => {
  const [raw, ref] = url.split("#");
  // multi-buildpack retire les barres finales avant de telecharger.
  const bare = raw.replace(/\/+$/, "");
  const m = /github\.com[/:]([^/]+\/[^/#]+?)(?:\.git)?$/.exec(bare);
  return { repo: m ? m[1] : bare, ref: ref || null };
};

/** Buildpacks que le journal annonce, dans l'ordre du `.buildpacks`. */
export function readBuildpackLines(text: string): Array<{ repo: string; ref: string | null }> {
  const out: Array<{ repo: string; ref: string | null }> = [];
  for (const line of text.split("\n")) {
    const dl = /Downloading Buildpack:\s*(\S+)/.exec(line);
    if (dl) {
      out.push(parseBuildpackRef(dl[1]));
      continue;
    }
    const br = /Using branch:\s*(\S+)/.exec(line);
    if (br && out.length > 0) out[out.length - 1].ref = br[1];
  }
  return out;
}

/** Un runtime ou un binaire installe par un buildpack, tel que le journal l'annonce. */
export type Runtime = {
  /** Cle du module qui sait lire sa ligne, sous src/buildpacks. */
  component: string;
  name: string;
  version: string;
  /** Buildpack dont le chargement precede la ligne, ou null si aucun ne la precede. */
  buildpack: string | null;
  /** Faux quand la ligne ne donne que ce qui a ete demande. */
  exact?: false;
  /**
   * Vrai quand le buildpack est charge par une URL qui ne finit pas par
   * `.git` : multi-buildpack telecharge alors l'archive de la reference sans
   * jamais l'ecrire au journal, et rien ne dit s'il etait epingle.
   */
  refHidden?: true;
};

const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * Runtimes que le journal annonce, chacun rattache au buildpack dont le
 * chargement le precede : multi-buildpack les deroule un par un, dans l'ordre.
 */
export function readRuntimes(text: string): Runtime[] {
  const out: Runtime[] = [];
  let current: string | null = null;
  let hidden = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(ANSI, "").trim();
    const dl = /Downloading Buildpack:\s*(\S+)/.exec(line);
    if (dl) {
      current = parseBuildpackRef(dl[1]).repo;
      hidden = !/\.git$/.test(dl[1].split("#")[0].replace(/\/+$/, ""));
      continue;
    }
    for (const module of BUILDPACKS) {
      const seen = module.read(line);
      if (!seen) continue;
      out.push({
        component: module.component,
        name: seen.name,
        version: seen.version,
        buildpack: current,
        ...(seen.exact === false ? { exact: false as const } : {}),
        ...(current && hidden ? { refHidden: true as const } : {}),
      });
      break;
    }
  }
  return out;
}
