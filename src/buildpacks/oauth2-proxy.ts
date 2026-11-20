import type { BuildpackModule } from "./types.ts";

const LINE = /^downloading oauth2-proxy (v?\d[\w.+-]*) from GitHub/;

/**
 * Le binaire oauth2-proxy que betagouv/oauth2-proxy-buildpack installe devant
 * l'outil.
 *
 * Releve seulement, sans prevision ni verdict. Sa version est le defaut que le
 * buildpack ecrit en dur, `${OAUTH2_PROXY_VERSION:=...}`, avec la somme de
 * controle qui va avec : la corriger passe par une pull request sur ce
 * buildpack, ou Renovate monte les deux d'un meme commit, et non par le
 * watcher. Un rebuild reprend ensuite ce defaut, ce que fait la regle d'age.
 */
export default {
  repo: "betagouv/oauth2-proxy-buildpack",
  component: "oauth2-proxy",
  read: (line) => {
    const m = LINE.exec(line);
    return m ? { name: "oauth2-proxy", version: m[1] } : null;
  },
} satisfies BuildpackModule;
