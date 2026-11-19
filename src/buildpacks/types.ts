/**
 * Ce que le moteur sait d'un buildpack qui installe un runtime ou un binaire,
 * la ou rien ne permet de le deriver.
 *
 * Un module decrit un format, jamais une liste de versions : la ligne du
 * journal de build qui annonce ce qui a ete installe. Une expression generique
 * du type `Installing <nom> <version>` ne tient pas lieu de detection : sur sept
 * buildpacks officiels, elle en rate trois (nodejs indente sa ligne, ruby ecrit
 * `Using Ruby version: ruby-3.4.12`, go colle son nom a sa version) et capte a
 * tort l'outillage de python (uv, Poetry, pip).
 *
 * Un module ne porte que des rapprochements verifies sur un vrai journal : une
 * ligne mal lue ferait passer un runtime pour un autre.
 */
export type Installed = {
  /** Nom tel que le journal l'annonce. */
  name: string;
  /** Version telle que le journal l'annonce. */
  version: string;
  /**
   * Faux quand la ligne ne donne que ce qui a ete demande, et non ce qui a ete
   * installe : `Installing OpenJDK 17... done` dit 17, pas quel 17.
   */
  exact?: false;
};

export type BuildpackModule = {
  /** Depot du buildpack, au format owner/name. */
  repo: string;
  /** Cle du composant dans le lock. */
  component: string;
  /** Ce qu'annonce une ligne du journal, ou null quand elle ne parle pas de ce composant. */
  read: (line: string) => Installed | null;
};
