/**
 * Les buildpacks dont le moteur sait lire ce qu'ils installent, un module par
 * buildpack.
 *
 * Ajouter un buildpack : un fichier ici, dont la ligne est verifiee sur un vrai
 * journal de build, et un test sur cette ligne.
 */
import jvmCommon from "./jvm-common.ts";
import oauth2Proxy from "./oauth2-proxy.ts";
import type { BuildpackModule } from "./types.ts";

export type { BuildpackModule, Installed } from "./types.ts";

export const BUILDPACKS: readonly BuildpackModule[] = [jvmCommon, oauth2Proxy];
