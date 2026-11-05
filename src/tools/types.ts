/**
 * Ce que le moteur sait d'un outil, la ou rien ne permet de le deriver.
 *
 * Le nom de la variable de version dit quel buildpack la lit, pas ou l'outil
 * publie ses releases ni comment il numerote ses versions. Un module ne porte
 * que des rapprochements verifies : un mauvais depot produirait un "a jour"
 * faux, ce qui est pire que "amont inconnu".
 *
 * Le champ tool.upstream du manifeste complete ou surcharge `upstream`, app
 * par app. Le reste ne se surcharge pas.
 */
export type ToolModule = {
  /** Variable lue par le buildpack, qui sert de cle au module. */
  env: `${string}_VERSION`;
  /** Nom affiche dans le rapport et les pull requests. */
  name: string;
  upstream: {
    /** Depot GitHub qui publie les releases, au format owner/name. */
    repo: string;
    /**
     * Nombre de composants de tete qui forment une ligne de versions. Une
     * version n'est comparee qu'aux releases de sa propre ligne.
     */
    line: number;
    /**
     * Nom de l'outil chez endoflife.date. Absent quand le rapprochement n'est
     * pas verifie : la veille de fin de vie se tait alors sur cet outil.
     */
    lifecycle?: string;
  };
  /**
   * Preset renovate/<preset>.json qui pose le versioning de l'outil et etend la
   * politique commune. Absent, Renovate suit les versions sans jamais fusionner
   * seul : la politique ne vaut que pour un versioning verifie.
   */
  renovatePreset?: string;
};
