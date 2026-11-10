# Inventaire des comportements

Ce document liste tout ce que fait le watcher, y compris ce qu'il ne fait pas
exprès et ce qu'il ne sait pas encore faire. Chaque entrée est marquée
**[fait]** ou **[à faire]**.

---

## 1. Audit du parc (`src/audit.ts`)

**[fait]** Strictement en lecture. Le seul appel non-GET est l'échange du token
d'authentification, qui ne modifie rien. Aucune variable, aucun déploiement,
aucune application n'est touché.

**[fait]** Une seule dépendance, `yaml`, pour lire les régions du manifeste.
Node exécute le TypeScript nativement, sans étape de build.

**[fait]** Balaye les régions passées par `--region`, option répétable, à défaut
celles que déclare le manifeste, et liste toutes les applications accessibles
avec le token. Filtrable par `--app`.

**[fait]** Reconnaît les buildpacks officiels en listant les dépôts de
l'organisation Scalingo sur GitHub, pas via une liste figée. 41 dépôts au
dernier relevé. Accepte un `GITHUB_TOKEN` pour éviter la limitation de débit.

**[fait]** Détermine dynamiquement si un buildpack expose une variable de
version, en cherchant l'expansion `${<NOM>_VERSION:-` dans son `bin/compile`.
Cela évite tout registre à maintenir et fonctionne sur les buildpacks tiers.
Validé sur 14 dépôts réels sans écart : `metabase`, `grafana`, `nginx`, `clamav`,
`logstash`, `geoserver`, `opensearch-dashboards` en exposent une, `nodejs`,
`python`, `apt`, `jvm-common`, `multi-buildpack` non.

**[fait]** Reconstruit la liste des buildpacks réellement utilisés en analysant
les logs du dernier build (`Downloading Buildpack:` et `Using branch:`). C'est le
seul moyen de voir le contenu du `.buildpacks`, que l'API n'expose pas. Se
désactive avec `--no-build-log` pour aller plus vite.

**[fait]** Retombe sur `BUILDPACK_URL` quand aucun log n'est exploitable, en
signalant que la source est moins fiable.

**[fait]** Compare les versions à l'intérieur de leur ligne uniquement. Metabase
publie `0.x` pour l'OSS et `1.x` pour l'Enterprise, ce sont deux lignes
distinctes qu'il n'y a aucun sens à comparer. Le nombre de composants qui forment
une ligne est déclaré par outil.

**[fait]** Quinze types de constats : version couverte par un avis de sécurité de
son dépôt amont, avis dont la plage de versions n'a pas pu être lue, variable de
version absente, variable flottante (`*` ou `latest`), buildpack non épinglé,
retard dans la ligne majeure, ligne majeure en retard, ligne majeure absente des
releases amont, base de données montable, dernier déploiement en échec,
application jamais déployée, application arrêtée ou en échec, application
dormante au-delà de 180 jours, source de releases inconnue, erreur de collecte.
Les deux premiers sont rendus en tête, étant ce que l'audit a de plus urgent à
dire. L'énumération en annonçait neuf, pour une table qui en portait treize.

**[fait]** L'audit rend le même verdict de sécurité que la convergence, par le
même relevé des avis du dépôt amont, et sur la version qu'il vient de lire sur
l'application. Les détails de ce relevé sont en section 8.

**[fait]** Le constat de buildpack non épinglé est agrégé par buildpack et non
par paire application-buildpack, sinon il produit des dizaines de lignes
illisibles.

**[fait]** Deux sorties simultanées : inventaire lisible sur la sortie d'erreur,
JSON complet sur la sortie standard avec `--json`. Donc
`node src/audit.ts --json > inventory.json` donne le fichier et l'affichage.

**[fait]** Tolérance aux pannes par application : une erreur sur une application
est consignée et n'interrompt pas l'audit.

---

## 2. Manifeste (`manifest.yaml`)

**[fait]** Format YAML, seul fichier édité à la main ou par Renovate.

**[fait]** Schéma JSON complet (`schema/manifest.schema.json`), avec description
de chaque champ, contraintes de forme et exemples. Rattaché au manifeste par une
directive `yaml-language-server`, donc validation et autocomplétion dans
l'éditeur. Un manifeste généré par `init` désigne le schéma par son URL au tag de
la version de l'outil qui l'a produit.

**[fait]** Validation à chaque chargement par l'apply, avec sortie en erreur et
liste des écarts. Également disponible seule via `--validate`, qui contrôle en
plus les annotations Renovate et les entrées de lock orphelines.

**[fait]** Premier manifeste écrit depuis l'état réel par `init`, sans rien
modifier sur Scalingo. Chaque application dont une variable désigne un outil
connu est décrite telle qu'elle tourne : version de l'outil, dépôt et branche
liés, sha du dernier déploiement, version de sa base. Les applications sont
rangées par région puis par nom, ordre à relire avant le premier apply. Un
manifeste existant n'est écrasé qu'avec `--force`. La commande d'amorçage du
lock est affichée, pas lancée.

**[fait]** `init` écarte, en le disant, une application dont la version est
flottante, qui n'a pas de dépôt lié, dont le dépôt est lié sans branche, ou
dont le dernier déploiement ne désigne pas un commit. Seule la variable de l'outil est lue dans l'environnement de
l'application, qui contient ses secrets en clair.

**[fait]** `init` compare le propriétaire de chaque application au compte de
l'accès. Une application dont ce compte n'est pas propriétaire est écrite en
pause, avec un commentaire qui nomme son propriétaire. Derrière le proxy, le
compte n'est pas lisible : `init` le dit une fois et ne déduit aucune pause.

**[fait]** L'ordre du tableau `apps` est l'ordre de déploiement, de la moins
critique à la plus critique.

**[fait]** Politique globale dans `defaults`. Le preset `base` la relit dans le
texte brut du manifeste et la porte dans le `depType` de chaque version d'outil
(`outil minor=auto major=pr`). Le preset de l'outil en tire l'automerge, seul
`metabase` le fait aujourd'hui. Une politique écrite sous une forme que Renovate
ne lit pas, en style flow par exemple, est signalée par `--validate`.

**[fait]** Politique par application. Le `depName` vu par Renovate est le nom de
l'application Scalingo, pas le dépôt amont, donc une exception pour une seule
instance s'écrit comme une règle nominative (`matchDepNames`) dans le
`renovate.json` du consommateur.

**[fait]** Deux valeurs de politique seulement, `auto` et `pr`. Refuser une
montée consiste à ne pas fusionner la pull request.

**[fait]** Pause par application (`paused: true`) : l'application est lue à
chaque passage et jamais écrite. Son état, sa version, son commit et sa base sont
relevés, et son entrée de lock suit ce réel, comme sous `--reconcile` : les
failles signalées et le tableau de bord portent sur ce qui tourne, et à la
reprise le plan part d'un état juste. Ni déploiement, ni variable, ni
sauvegarde, ni montée ou proposition de montée de base, ni quarantaine. Un écart
avec le manifeste est affiché dans le plan et le tableau de bord (`en pause, en
écart`), sans action. Usage visé : suivre une application dont le compte de
l'accès n'est que collaborateur. Renovate ne propose aucune montée pour elle :
lever la pause lui rend ses montées au passage suivant.

**[fait]** Mode de sauvegarde par application : `required` ou `not-available`.
Cette seconde valeur se pose consciemment après vérification, jamais par défaut.

**[fait]** Fenêtre de garde par application, `settle: {window: <secondes>}`,
posable aussi dans `defaults`. Elle fait relire l'application pendant ce temps
après un déploiement conclu réussi, et le succès n'est consigné que si rien ne
l'a fait redémarrer. Absente, elle vaut 120 secondes. La surcharge se fait en
bloc, un objet ne s'héritant pas clé par clé. `window: 0` retire l'attente, pas
le contrôle de l'état des conteneurs qui la conclut.

**[fait]** Chaque application déclare son dépôt applicatif et sa branche
indépendamment : deux applications d'un même parc peuvent suivre deux dépôts
différents.

**[fait]** Les commentaires d'annotation portent la source des versions et sont
fonctionnels. Les supprimer coupe la veille silencieusement.

**[fait]** Région libre, de la forme `^[a-z0-9-]+$` : le schéma ne fige aucune
liste. Elle finit dans un nom d'hôte, rien d'autre n'y entre.

**[fait]** Un module par outil, sous `src/tools`, partagé par l'audit, l'apply
et `init`, dit où l'outil publie ses versions, indexé par sa variable de
version. Le champ `tool.upstream` le complète pour un outil sans module, ou le
surcharge. Le titre de section du rapport et les liens de release en dérivent.

**[fait]** Un champ renommé reste accepté sous son ancien nom, avec un
avertissement au `--validate` et au plan. Les deux noms présents et en
désaccord sont refusés. Aucun renommage n'est en vigueur à ce jour : le
mécanisme existe pour qu'une montée de l'outil ne casse aucun manifeste.
Les champs que Renovate, `--validate` et `--propose-db` relisent dans le texte
brut (`app`, `paused`, `source.branch`, `source.sha`, `tool.version`,
`database.version` et leurs parents) en sont exclus : le moteur refuse un alias sur eux.

---

## 3. Lock (`lock.json`)

**[fait]** Généré, jamais édité à la main. Format JSON.

**[fait]** Consigne, par application : le dépôt applicatif et son SHA déployé, la
variable de version et sa valeur, les buildpacks réellement utilisés au dernier
build, l'identifiant et le statut du dernier déploiement, la dernière sauvegarde,
et l'éventuelle quarantaine.

**[fait]** Écrit uniquement après confirmation du déploiement. Un déploiement en
échec ne met pas à jour la version consignée, il pose une quarantaine.

**[fait]** Écrit par application et non d'un bloc, donc un échec partiel laisse
les autres applications correctement consignées.

**[fait]** N'est réécrit que si l'état a réellement changé. Son horodatage date
le dernier changement, pas la dernière vérification : sinon la réconciliation
produisait un commit toutes les deux heures pour déplacer une date, soit douze
par jour sans aucune information.

**[fait]** Amorçage sur un parc existant avec `node src/apply.ts --adopt` :
relève l'état réel via l'API et écrit le lock sans rien déployer. Signale les
écarts constatés avec le manifeste. Un amorçage qui ne relève aucune
application échoue au lieu d'annoncer un lock amorcé.

**[fait]** Format versionné. Le moteur refuse un lock d'une version plus récente
que celle qu'il sait lire : un moteur plus ancien réécrirait le lock sans les
champs qu'il ne connaît pas, et les perdrait.

**[fait]** Le lock revient dans le dépôt même quand une partie des applications
a échoué. Un push refusé, parce qu'une fusion est arrivée pendant la
convergence, est rejoué par-dessus après `pull --rebase`, trois tentatives au
plus. Un lock qui ne revient pas fait échouer le job : la prochaine exécution
repartirait sinon d'un état périmé sans que personne ne le voie.

**[fait]** Deux écritures concurrentes du lock s'arbitrent par sa date au lieu
d'échouer. Quand le distant a lui aussi modifié le lock, le rebase conflicte, et
comme le conflit est déterministe les trois tentatives échouaient à l'identique :
elles ne retardaient l'échec que de quarante-cinq secondes. Le cas n'a rien
d'exceptionnel, un cron parti pendant qu'une vague finissait suffit, et c'est
arrivé le 2026-10-30. Un lock est un état relevé, pas un travail humain : il ne
s'arbitre pas ligne par ligne, c'est le relevé le plus récent qui vaut, et
`generatedAt` dit lequel l'est sans supposer que ce soit celui du passage en
cours. Le relevé le plus récent est reposé par-dessus le commit concurrent, qui
reste dans l'historique. Quand c'est le distant qui est le plus récent, le relevé
du passage est abandonné avec un avertissement et sans échec : il n'y a rien à
sauver, son état est antérieur.

**[fait]** Un conflit sur un autre fichier que le lock n'est pas arbitré. Il
garde les trois tentatives puis l'échec : ce n'est pas un état relevé, et ce
n'est pas au watcher de trancher.

---

## 4. Veille (presets `renovate/`)

**[fait]** Deux gestionnaires personnalisés de type regex, qui lisent le
manifeste, dans le preset `base`. La source des versions est écrite dans le
fichier lui-même et réinjectée par patron, donc ajouter un nouvel outil ne
demande aucune modification de configuration. Le motif de fichier couvre un
manifeste hors de la racine.

**[fait]** Suivi du dépôt applicatif via la source `git-refs` avec épinglage de
condensat : la branche sert de valeur courante, le SHA de condensat courant.
Renovate propose le nouveau SHA quand la branche avance.

**[fait]** Une application en pause n'est visée par aucune montée. Chaque
gestionnaire isole d'abord le bloc de l'application, ses lignes qui ne
commencent pas par un tiret, puis y relève `paused: true`. Le `depType` reçoit
alors ` en pause` (`source en pause`, `outil minor=auto major=pr en pause`), et
une règle du preset `base` désactive ces dépendances. Sans elle, une montée
fusionnée seule réécrirait le manifeste sans rien déployer. `--validate` refuse
une pause que ces expressions ne relisent pas (`paused: True`, un alias) et un
bloc qu'une ligne en tiret couperait.

**[fait]** Suivi de la version de l'outil via `github-tags`. Les releases GitHub ne
suffisent pas : Metabase n'en publie que pour les versions à trois nombres, si bien
que `v0.64.3.4` et `v0.64.4.2` existent en tags et se téléchargent tout en restant
invisibles de `github-releases`. Un parc épinglé sur une version à quatre nombres ne
recevait alors plus aucune proposition, la plus haute release connue étant inférieure
à sa version en service, et ce silence ressemblait à « rien à faire ». Les tags sont
un sur-ensemble des releases, et le versionnage sur mesure écarte seul les
préversions et les étiquettes mobiles.

**[fait]** La veille de Metabase est bornée à sa ligne de support long par
`allowedVersions`. C'est le prix de `github-tags` : les tags exposent la ligne
suivante, que les releases n'exposaient pas, et celle-ci peut être hors support long
avec une fin de vie plus proche que la ligne en service. Sans cette borne, le tableau
de bord porterait une montée permanente invitant à quitter le support long, soit
exactement l'alerte qu'on apprend à ignorer. La borne s'édite à la main au changement
de ligne, environ une fois l'an, et c'est la veille de fin de vie du moteur qui
signale ce moment : rien ne le disait auparavant.

**[fait]** Les règles de Metabase ne filtrent pas la source des versions, seulement
le nom du paquet. Un parc dont le manifeste porte encore l'ancienne annotation garde
donc sa politique, et déplacer la source une nouvelle fois ne demandera pas de
retoucher ces règles.

**[fait]** Versionnage sur mesure pour Metabase, dans le preset `metabase`, avec
un groupe `compatibility` qui isole les lignes OSS et Enterprise. Il ramène sa
numérotation au contrat de la politique commune : le deuxième chiffre est une
montée fonctionnelle (`minor`, 0.64 vers 0.65), le troisième et le quatrième
des correctifs (`patch`, 0.64.3 vers 0.64.4 comme 0.64.4.3 vers 0.64.4.4).
Jusqu'à la v1.3, ce versioning faisait du deuxième chiffre un `major` et du
troisième un `minor`, et les règles de fusion étaient propres à Metabase. Le
classement correctif ou montée est resté le même.

**[fait]** Délai de décantation de cinq jours avant toute proposition d'une
version d'outil, pour ne pas déployer une release publiée le matin même.

**[fait]** Fusion automatique sur les correctifs, pull request sur les montées
fonctionnelles, jamais de fusion seule d'une rupture. Ces règles vivent dans le
preset `politique`, commun à tous les outils, et sont restreintes au manifeste :
une mise à jour de l'outil lui-même n'est jamais fusionnée seule. Chaque preset
d'outil l'étend pour son seul dépôt, `./politique(metabase/metabase)`, après un
versioning qui fait de `patch` un correctif et de `minor` une montée. Un outil
sans preset reste en semver, sans fusion automatique.

**[fait]** Correctifs et montées fonctionnelles d'un même outil partent dans des
branches séparées (`separateMinorPatch`) : sinon Renovate ne propose que la plus
haute des deux, et un correctif attendrait la relecture d'une montée. Les
branches de groupe s'appellent `renovate/patch-correctifs-outils` et
`renovate/montee-fonctionnelle-des-outils`. Jusqu'à la v1.3, c'étaient
`renovate/correctifs-outils` et `renovate/major-montee-fonctionnelle-des-outils`,
et la montée des presets ferme une fois les pull requests ouvertes sous ces
noms pour les rouvrir sous les nouveaux.

**[fait]** Jamais de fusion automatique sur un changement de SHA : un condensat
n'a ni version sémantique ni journal des modifications, donc rien à classifier.

**[fait]** Les alertes de vulnérabilité sont étiquetées `securite`. Elles ne
sont pas fusionnées d'office. Renovate applique ce réglage à toute dépendance,
scalingo-watcher compris chez un consommateur, par-dessus ses règles.

**[fait]** Chaque entrée est nommée par son application. Sans cela le tableau de
bord affichait plusieurs fois `metabase/metabase v0.63.15` sans dire de quelle
instance il s'agissait, et les pull requests étaient tout aussi muettes. Le nom
du dépôt amont reste utilisé pour interroger la source des versions, il n'est
simplement plus ce qui est affiché.

**[fait]** Les deux axes sont étiquetés `source` et `outil` via le type de
dépendance, ce qui les sépare visuellement dans le tableau de bord. Le type
`outil` porte en plus la politique relue dans le manifeste
(`outil minor=auto major=pr`).

**[fait]** Les mises à jour sont groupées par nature, donc une seule pull request
pour les correctifs de tout le parc, une autre pour une montée fonctionnelle, une
troisième pour les dépôts applicatifs. Sans groupement, nommer chaque entrée par
son application en aurait produit une par instance.

**[fait]** Messages de commit explicites plutôt que le libellé générique de
Renovate : `monter Metabase en v0.63.16`, ou `monter le dépôt applicatif
alpha-metabase, branche main, en 4b7c2f1`.

**[fait]** Les mises à jour de l'outil sont suivies par le preset `watcher` : sha
des workflows appelants (gestionnaire `github-actions`) et tag des presets
(gestionnaire `renovate-config`), avancés ensemble dans une pull request
`scalingo-watcher`, dès la release, jamais fusionnée seule. Les
workflows appelants sont épinglés par sha avec la version en commentaire.

**[fait]** Le consommateur n'active que `custom.regex`, `github-actions` et
`renovate-config`. Le fuseau reste dans sa configuration : les presets ne
portent que ce qui dépend de l'outil.

**[fait]** Le titre, l'en-tête et le pied du tableau de bord Renovate, ainsi que
la plage de fusion automatique (`automergeSchedule`, entre 2h et 6h dans le
fuseau du parc), vivent dans le preset `base`. Le texte cite le délai de
décantation, l'éclaireur, les trois déploiements de front et cette plage : ce
sont des comportements de l'outil, et un texte recopié dans chaque parc
divergeait à la première évolution. Un parc créé depuis le starter affichait
ainsi le tableau de bord par défaut de Renovate, faute de textes. Un parc peut
toujours redéclarer ces clés, mais il les remplace en entier et ne reçoit plus
leurs mises à jour. Renovate retrouve son issue par le titre : un parc qui
change de titre renomme d'abord son issue existante, sinon il en obtient une
seconde.

---

## 5. Déploiement (`src/apply.ts`)

**[fait]** Mode plan (`--dry-run`) qui n'écrit jamais rien. Sans token il
fonctionne hors ligne ; avec un token il lit en plus l'état réel des
applications, pour ne pas annoncer un déploiement sur une instance éteinte.

**[fait]** Mode validation seule (`--validate`), qui vérifie le manifeste contre
son schéma, ses annotations Renovate et les entrées orphelines du lock, et
s'arrête là. Ni token ni réseau, donc utilisable en intégration continue sur
chaque pull request Renovate.

**[fait]** Filtre par application (`--app`).

**[fait]** Sauvegarde avant tout déploiement quand `backup: required`. Toutes
les bases de l'application sont sauvegardées, pas seulement la première :
n'en traiter qu'une donnerait un filet partiel tout en affichant un succès.
Obtention d'un jeton dédié par addon, déclenchement, puis attente du statut
`done` avec un délai maximal de 30 minutes. Si une sauvegarde échoue, le
déploiement n'a pas lieu.

**[fait]** Une sauvegarde déjà en cours sur l'addon est adoptée au lieu d'en
demander une seconde, que Scalingo refuserait de toute façon. Le watcher ne
garde aucune mémoire d'un passage à l'autre : sans cette adoption, une
sauvegarde qui déborde du délai devient orpheline, le passage suivant en
redemande une et se prend un `400 A backup is running`, et le blocage se
reconduit indéfiniment. Une base de 40 Mo dont la sauvegarde a mis plus d'une
heure a ainsi figé un parc entier.

**[fait]** Écriture de la variable de version en création ou modification
unitaire. Volontairement pas en mise à jour groupée, qui remplacerait le jeu de
variables et effacerait le reste de l'environnement.

**[fait]** Aucun redémarrage parasite : l'API Scalingo ne redémarre pas
l'application lors d'un changement de variable, contrairement au dashboard et à
la CLI. La valeur est posée, puis le build la consomme.

**[fait]** Trois contrôles de cohérence des références avant tout déploiement. Le
premier vérifie que le commit épinglé appartient à la branche que le manifeste
déclare suivre. Le second, plus important, vérifie que le commit **actuellement
déployé** appartient lui aussi à cette branche : si ce n'est pas le cas, ou bien
la branche du manifeste est fausse, ou bien on s'apprête à changer l'application
de branche, et les deux mettent en jeu ce que la branche d'origine apportait.
Une application peut tourner sur une branche dont le `.buildpacks` ajoute un
oauth2-proxy devant Metabase : la redéployer depuis `master` exposerait
l'instance sans authentification, sans que le statut du déploiement le signale.
Rien n'est tenté dans ce cas.

**[fait]** Le troisième de ces contrôles ne regarde plus d'où vient le commit
mais ce qu'il emporte. Les deux premiers ne voient qu'une déclaration
incohérente avec elle-même : une déclaration cohérente mais fausse, branche et
sha d'accord sur un commit qui ne porte pas le même `.buildpacks`, les passe
tous les deux. Le `.buildpacks` est donc lu sur GitHub au commit en service et
au commit visé, et un buildpack que `lock.json` relève en service et que le
commit visé ne déclare plus fait refuser le déploiement. Un fichier absent au
commit visé compte comme un retrait, c'est le cas le plus total ; seule une
panne de GitHub vaut ignorance, et elle s'annonce en échéance.

**[fait]** Après le déploiement, les buildpacks relevés dans le journal du build
sont comparés à ceux du lock, et une disparition met en quarantaine comme les
autres refus de la fenêtre de garde. Il mesure là où le contrôle préalable
déduit, donc il attrape aussi un retrait venu d'ailleurs. Un relevé vide ne vaut
pas disparition : le journal illisible et le journal sans buildpack rendent la
même liste vide, et le relevé précédent du lock est alors conservé plutôt
qu'effacé, sans quoi un seul journal illisible désarmait le contrôle préalable
du passage suivant, qui part de ce relevé.

**[fait]** Aucune valeur n'entre dans une URL de l'API GitHub sans contrôle de
forme. Le manifeste passe le schéma à chaque exécution, mais ni `lock.json` ni
le journal de build : un sha de lock peut valoir un nom de branche ou la chaîne
vide, et un nom de buildpack relevé dans le journal peut être une URL entière
quand la ligne de `.buildpacks` ne pointe pas GitHub. Hors forme, la valeur vaut
ignorance, annoncée quand elle est anormale et silencieuse quand elle est
légitime. Un buildpack hors GitHub n'est donc plus lié dans le tableau de bord,
sa colonne de mise à jour le dit non vérifiable, et son nom est posé en cellule
sans barre verticale ni accent grave, qui couperaient la ligne ou ouvriraient du
markdown dans le corps de l'issue.

**[fait]** Un quatrième contrôle, sur le sens de l'écart et non plus sur sa
cohérence. Une cible du manifeste strictement antérieure à la version que porte
la variable de l'application est refusée au lieu d'être déployée. Le manifeste
dit l'intention, pas la vérité : une application montée à la main avant que le
manifeste ne suive se ferait redescendre au passage suivant, sur une base portant
déjà les migrations de la version supérieure, que l'ancien binaire refuse de
démarrer. C'est arrivé le 2026-10-30, et seule une fusion dans la fenêtre l'a
évité. Le message nomme la variable et les deux versions, et renvoie à l'un des
deux gestes : aligner le manifeste sur ce qui tourne, ou restaurer la base puis
forcer la descente par `--force --app`.

**[fait]** Ce contrôle ne s'applique qu'à une version qu'un déploiement réussi
accompagne dans le lock. Après un échec, la variable porte déjà la cible ratée
sans que le binaire ait changé : refuser le retour en arrière serait refuser la
seule réaction sensée.

**[fait]** La comparaison est purement numérique, sans égard pour les lignes de
publication. Une descente de majeure est donc refusée comme une autre, et chez
Metabase un passage de l'édition Enterprise à l'OSS l'est aussi, puisque son
numéro est inférieur. Écarter les lignes entre elles inversait les risques : la
descente la plus destructrice, de 12.1 à 11.6, passait quand 12.1.3 vers 12.1.0
était refusée.

**[fait]** Une version en service qui ne se compare pas est tenue pour inconnue,
et la cible est refusée. Le 2026-11-04, la variable portait `latest`, alors
v0.65.2 : v0.64.4.3 est passée sur une base déjà migrée, et Metabase a refusé de
démarrer. `latest`, ou un alias en `.x`, ne dit pas ce qui tourne, donc une
descente y est indiscernable d'une montée. Le message renvoie au journal de
démarrage de l'outil pour relever la version servie, puis à `--force --app`.
Lire cette version avant de décider a été écarté : Metabase la donne à
`/api/session/properties`, muet derrière un oauth2-proxy, et dans sa ligne de
démarrage, dans des journaux hors de portée du proxy et élagués au-delà du débit
d'ingestion, où une ligne absente ne prouve rien. Une variable absente reste
hors du contrôle : c'est un état d'amorçage, qu'il bloquerait sur tout le parc.

**[fait]** Déploiement par archive via `POST /deployments`, avec une URL
d'archive GitHub que Scalingo télécharge lui-même. Aucune clé SSH, aucun dépôt à
héberger, aucun artefact intermédiaire.

**[fait]** Le `git_ref` transmis est le SHA du commit déployé, soit le format
que Scalingo produit lui-même via son intégration SCM. Une étiquette composite
serait plus lisible dans le dashboard mais le champ n'est pas documenté comme
acceptant des caractères arbitraires, et un rejet ferait échouer chaque
déploiement.

**[fait]** Attente du statut final avec un délai maximal de 20 minutes, en
reconnaissant les six statuts terminaux de Scalingo.

**[fait]** Fenêtre de garde après un déploiement conclu réussi, appliquée
d'office. Une application qui n'en déclare aucune reçoit 120 secondes : le
2026-11-04, sur un parc qui n'en déclarait pas, Metabase a refusé de démarrer
en boucle sur une base déjà migrée par une version supérieure, et le résumé a
compté le déploiement réussi pendant que le lock consignait la cible. Le statut `success` ne dit qu'une chose : le conteneur
a répondu sur son port. Metabase ouvre Jetty avant de migrer sa base, donc le
port répond en quelques secondes, Scalingo conclut, puis la migration tourne. Si
elle échoue, le processus sort en code 1 alors que le lock porte déjà `deployed`
et que l'éclaireur a donné son feu vert aux suivantes, parties à trois de front.
Pendant la fenêtre, les événements de l'application sont relus toutes les dix
secondes, et un `crash`, un `repeated_crash` ou un `restart` de raison
`unexpected_failure` met l'application en quarantaine comme un échec de
déploiement : le lock ne porte pas la nouvelle version, et l'échec sur
l'éclaireur arrête la vague.

**[fait]** Seuls comptent les événements apparus après le déploiement. Ceux déjà
là sont relevés d'abord et écartés, ce qui évite de comparer notre horloge à
celle de la plateforme.

**[fait]** Le contrôle ne connaît rien de l'outil déployé : aucun marqueur, aucun
chemin HTTP, rien que deux routes de la plateforme, `events` et `ps`. Il ne
prouve pas que l'outil a fini de démarrer, il constate qu'il n'est pas tombé dans
le temps qu'on lui a laissé.

**[fait]** Le statut de l'application est relu une dernière fois en fin de
fenêtre, et seuls `crashed` et `stopped` comptent. Il ne pouvait pas porter le
contrôle à lui seul : la plateforme ne marque `crashed` qu'au treizième crash
consécutif, soit plus de quatre heures d'attentes cumulées, et l'application se
lit `running` pendant toute la boucle. Les états transitoires, `booting`,
`restarting` et `scaling`, ne prouvent rien : refuser dessus aurait mis en
quarantaine une application que quelqu'un redimensionne pendant la fenêtre.

**[fait]** Le filtre des événements est étroit par construction : un événement
d'un type inattendu est ignoré, donc une erreur sur les noms surveillés ne peut
que faire manquer un échec, jamais refuser un déploiement sain. En revanche une
réponse sans liste d'événements interrompt, plutôt que de passer pour une
surveillance qui ne regarde rien.

**[fait]** La fenêtre se conclut sur l'état des conteneurs, lu par
`GET /v1/apps/<app>/ps` : chacun doit être `running`. Le statut de l'application
ne le dit pas, il vaut `running` dès qu'un seul conteneur tourne, et
`/containers` ne rend que la formation déclarée, sans état. Un conteneur
`crashed` met en quarantaine tout de suite. Tout autre état laisse attendre, cinq
minutes au plus, et les événements restent relus entre deux lectures : une
boucle de crash se voit là plutôt qu'au bout du délai. Au-delà, l'application est
mise en quarantaine. `stopped` attend aussi, rien ne garantissant que la
plateforme marque l'ancienne formation supprimée avant de la dire éteinte. Les
consoles one-off et les conteneurs supprimés ou créés avant le déploiement ne
comptent pas.

**[fait]** Les deux routes de la fenêtre sont lues une fois avant toute
écriture, sauvegarde comprise. Un `fgp.json` qui ne les couvre pas arrête donc le
passage avant le déploiement. Sans cette lecture préalable, l'application était
déployée, la fenêtre s'interrompait sur le refus du proxy, et le relevé suivant
consignait une cible que rien n'avait contrôlée.

**[fait]** Le relevé ne lève pas une quarantaine sur le déploiement même qu'elle
a jugé. Scalingo dit `success` un déploiement que la fenêtre a refusé : le relevé
horaire concluait la cible atteinte, levait la quarantaine, et le passage suivant
disait conforme une application en boucle de crash. Un autre déploiement réussi
sur la cible, fait hors du watcher, la lève toujours.

**[fait]** Une lecture impossible pendant la fenêtre interrompt au lieu de mettre
en quarantaine. Le refus du proxy, quand `fgp.json` ne couvre pas ses routes,
arrive plus tôt, à la lecture préalable, et son message renvoie à la régénération
des blobs.

**[fait]** Relevé des buildpacks réellement utilisés après un déploiement réussi,
consigné dans le lock à titre d'observation.

**[fait]** Un statut d'application illisible interdit le déploiement au lieu de
l'autoriser. La lecture avalait auparavant son erreur et rendait `null`, ce qui
faisait passer l'application pour déployable : le garde-fou se désactivait
silencieusement dès que l'appel échouait, et une tentative a bel et bien été
faite sur une application arrêtée pour cette raison.

**[fait]** Ce qui est écarté avant toute tentative n'arrête plus la vague. Un
manifeste qui se contredit, une branche qui a changé, un statut illisible : ces
rejets concernent une application, pas la cible. L'éclaireur existe pour détecter
une cible mauvaise, non pour laisser une application mal configurée bloquer le
reste du parc à chaque passage.

**[fait]** Une opération interrompue ne l'arrête plus non plus, pour la même
raison. Le type `Outcome` pose depuis toujours qu'une interruption ne dit rien
de la cible, mais l'éclaireur s'arrêtait dessus comme sur un échec : une base
lente sur la première application du manifeste figeait tout le parc, alors que
les bases des suivantes n'ont rien à voir avec elle. L'application suivante
reprend le rôle.

**[fait]** Le rapport d'incident nomme l'application et la raison plutôt que de
compter les échecs. Un décompte oblige à ouvrir les journaux pour savoir lequel.

**[fait]** Une application dont l'état Scalingo n'est pas déployable est laissée
intacte : `stopped` parce qu'elle a été éteinte volontairement et que la
réveiller n'appartient pas au watcher, `crashed` parce qu'un déploiement rendrait
indistinguables l'échec du déploiement et la panne préexistante, `restarting`,
`scaling` et `booting` parce que ce sont des états transitoires sur lesquels on
repassera. Ce n'est pas un échec : pas de quarantaine, pas de code de sortie non
nul, et le rôle d'éclaireur n'est pas consommé.

**[fait]** Le plan lit l'état réel des applications quand un token est
disponible, pour ne pas annoncer des déploiements sur des applications éteintes.
Sans token il fonctionne quand même et le signale.

**[fait]** L'audit affiche l'état de chaque application quand il n'est pas
`running`, et remonte un constat dédié pour celles qui sont arrêtées ou en échec.

**[fait]** Éclaireur : la première application réellement déployée, et non la
première du manifeste. Si les trois premières sont déjà conformes, c'est la
quatrième qui essuie les plâtres.

**[fait]** Un échec sur l'éclaireur arrête la vague. Les applications suivantes
ne sont pas touchées, et leur nombre est annoncé.

**[fait]** Deux éclaireurs interrompus arrêtent aussi la vague. Au-delà, ce
n'est plus une application qui est en cause mais l'accès à Scalingo, et brûler
le délai d'attente de chacune pour le redécouvrir coûterait des heures sous un
verrou que la réconciliation suivante attend.

**[fait]** Un échec ultérieur met l'application en quarantaine et le déroulement
continue.

**[fait]** Distinction entre un rejet et une interruption. Un statut terminal non
réussi rendu par Scalingo met en quarantaine, parce que la cible est en cause.
Une opération qui n'a pas pu aboutir, coupure réseau, erreur d'API, sauvegarde
impossible, attente trop longue, ne met rien en quarantaine et laisse le lock
intact : geler une application sur un 502 passager la bloquerait jusqu'à la
version suivante. Les deux comptent comme un échec pour le code de sortie.

**[fait]** Une entrée de lock sans déploiement réussi ne vaut jamais conformité,
donc un échec initial ne fige pas une application dans un état qu'elle n'a
jamais atteint.

**[fait]** La quarantaine mémorise la cible qui a échoué. Tant que le manifeste
pointe la même cible, l'application est ignorée. Dès que la cible change, elle
repart d'elle-même, sans intervention.

**[fait]** Le récapitulatif ne liste que les quarantaines encore actives sur la
cible courante, pas celles déjà levées par un changement de cible.

**[fait]** Réconciliation périodique (`--reconcile`), demandée à l'heure. GitHub
ne garantit pas ses crons et en saute une partie : mesuré sur deux jours, les
passages réels s'espacent de trois à six heures et demie. La cadence déclarée est
donc un plancher de demande, pas une promesse de délai.
Elle relève l'état réel de chaque application, signale ce qui a bougé hors du
watcher, met le lock en accord avec le parc, puis laisse l'application converger.
Elle existe parce que Renovate fusionne le manifeste et s'arrête là : il ne
repasse jamais sur une application restée en arrière après un échec.

**[fait]** La fusion d'une modification du manifeste déclenche la
réconciliation tout de suite, au lieu d'attendre le prochain créneau. Le filtre
sur le manifeste évite la boucle : le commit de lock que la réconciliation
produit ne la redéclenche pas.

**[fait]** La quarantaine survit au relevé, sinon chaque passage la lèverait et
la même cible serait retentée indéfiniment. Elle tombe en revanche si
l'application a atteint la cible entre-temps, quel qu'en soit le moyen.

**[fait]** Atteindre la cible demande un déploiement réussi, et pas seulement le
bon couple version-commit. Sur échec, la variable porte déjà la nouvelle version,
que le moteur ne remet pas, et le déploiement raté a pour `git_ref` le commit de
la cible : le relevé concluait donc que la cible était atteinte, levait la
quarantaine, et la réconciliation suivante retentait la même cible avec une
sauvegarde fraîche, toutes les heures. C'est exactement ce que la quarantaine
existe pour éviter.

**[fait]** Quand le `git_ref` du dernier déploiement n'est pas un commit, ce que
rend un déploiement déclenché depuis le dashboard, le relevé se replie sur le sha
du lock et non sur celui du manifeste. Prendre celui du manifeste fabriquait
l'égalité qui fait conclure que la cible est atteinte.

**[fait]** Le relevé conserve la dernière sauvegarde connue. Il ne la relève pas,
puisqu'elle ne se lit pas sur l'application, et l'écraser par rien faisait perdre
le point de restauration, c'est-à-dire ce dont on a besoin précisément quand une
migration a mal tourné.

**[fait]** Le même verrou de concurrence est partagé entre l'application et la
réconciliation, et aucune des deux n'annule celle qui tourne : elle peut être au
milieu d'une sauvegarde ou d'un déploiement.

**[fait]** Le plan distingue les deux axes plutôt que d'afficher deux couples
version-commit à comparer soi-même : `outil v0.63.15 -> v0.63.16, source master
3f2c1a8 -> 4b7c2f1`. Seul ce qui change est affiché.

**[fait]** Les entrées du lock sans application correspondante dans le manifeste
sont signalées, et `--prune` les retire. Le retrait est une commande à part et
jamais un nettoyage silencieux : supprimer une entrée fait perdre l'historique de
déploiement, la dernière sauvegarde et l'éventuelle quarantaine, et une
application sortie du manifeste le temps d'une investigation reviendrait en
première prise en charge, donc redéployée pour rien.

**[fait]** `--validate`, `--prune` et `--dry-run` n'écrivent que des fichiers
locaux et ne réclament aucun jeton.

**[fait]** Sur une pull request, le plan est publié en commentaire et dans le
résumé du job, application par application. Il tourne sans jeton Scalingo :
une pull request ne doit pas avoir accès à un secret qui déploie.

**[fait]** Code de sortie non nul en cas d'échec, exploitable en intégration
continue.

---

## 6. Sécurité

**[fait]** L'audit applique une liste blanche stricte à la lecture des variables.
L'API renvoie tout l'environnement en clair, secrets compris ; seuls
`BUILDPACK_URL` et les clés `*_VERSION` sont conservés en mémoire et dans la
sortie JSON.

**[fait]** Aucune clé SSH nulle part.

**[fait]** Accès par un proxy fine-grained, au choix. Le dépôt ne détient alors
pas de jeton Scalingo mais une clé, et chaque blob borne ce qu'elle autorise à une
méthode et un chemin. Une clé qui fuite permet de lire les applications du
manifeste et, sur celles qui ne sont pas en pause, de poser une variable de
version, de déployer, de sauvegarder une base et de la monter d'une version :
aucun `DELETE`, aucune création d'application, aucun changement de stack, aucun
scale, aucun redémarrage.

**[fait]** Les blobs d'API nomment chaque application du manifeste au lieu d'un
joker. Chez FGP, `*` couvre aussi les `/` : l'ancien `POST:/v1/apps/*/deployments`
laissait la clé déployer et réécrire les variables de n'importe quelle
application visible du compte. Chaque blob de région ne porte plus que deux
lectures globales, la liste des applications et celle des stacks, puis les routes
lues par le moteur pour chaque application de la région. L'écriture
(déploiement, variables) n'est ouverte qu'aux applications sans `paused: true`,
et le blob de base d'une application en pause est en lecture seule, sans
sauvegarde ni montée de version. Ajouter une application ou lever une pause
demande donc de régénérer `fgp.json`. Un appel que le proxy refuse faute de scope
(`403 scope_denied`, `X-FGP-Source: proxy`) le dit dans l'erreur, au lieu d'un
`403` muet. Un `fgp.json` généré avant reste lisible et fonctionne tel quel, avec
ses jokers, jusqu'à sa régénération.

**[fait]** Derrière le proxy, l'audit et `init` ne voient plus que les
applications du manifeste. Les autres applications de la région sont refusées
par le proxy et comptées à part, sans erreur. Une application du manifeste
refusée reste une erreur de collecte, puisque c'est `fgp.json` qui est en retard.
Relever tout le compte demande `SCALINGO_API_TOKEN`.

**[fait]** Le renouvellement des jetons est délégué au proxy, y compris le jeton
d'addon des sauvegardes qui ne vit qu'une heure et que le watcher ne voit plus
jamais. En mode direct, le jeton porteur est ré-échangé au-delà de cinquante
minutes, avant l'échéance plutôt qu'en réaction à un refus.

**[fait]** Les blobs sont versionnés dans `fgp.json`, ce qui rend la
configuration lisible et revue comme le reste. Ils ne sont exploitables qu'avec
la clé, qui vit en secret d'Actions.

**[fait]** Les trois chemins d'écriture sont éprouvés par le proxy : sauvegarde
de la base par un blob `scalingo-addon`, déploiement, et écriture de variable.
En mode proxy, les workflows ne détiennent que la clé, dont chaque blob borne
l'usage.

**[fait]** Le mode direct par `SCALINGO_API_TOKEN` reste disponible, en local
comme dans les workflows, avec tout le pouvoir du compte.

**[fait]** Un appel dirigé vers le proxy sans sa clé est refusé avant d'atteindre
le réseau, en nommant la cause. Deux appels du relevé étaient restés sur le
chemin direct et repartaient avec un `Authorization: Bearer` que le proxy
ignore : le `401 missing_key` renvoyé ne désignait pas le coupable, et la
réconciliation planifiée échouait sans qu'on sache pourquoi.

**[fait]** Les jetons d'addon pour les sauvegardes sont obtenus à la demande et
ne sont jamais consignés.

**[fait]** Les secrets, `PUSH_TOKEN` compris, vivent dans un environment GitHub
et non dans le dépôt. Seuls les jobs qui déclarent l'environment passé en input
peuvent les lire, et sa politique de branches le réserve à `main` (checklist du
template). La validation, qui tourne sur les pull requests, n'a accès ni à la
clé du proxy ni au webhook, pas plus qu'une branche qui ajouterait un job
déclarant l'environment. Sans politique de branches, toute branche du dépôt
pouvait les lire.

**[fait]** L'outil est récupéré au sha exact du workflow réutilisable appelé, sans
conserver d'identifiants dans le clone. Côté consommateur, l'épinglage par sha et
l'absence de fusion automatique des mises à jour de l'outil limitent l'effet
d'un tag malveillant, qui s'exécuterait avec les secrets d'accès à Scalingo.
La pull request est proposée sans délai de décantation : c'est sa relecture
avant fusion qui fait barrage, pas le temps écoulé depuis la release.

**[à faire]** Approbation humaine avant les montées fonctionnelles. L'environment
la rend possible en une case à cocher, mais l'imposer telle quelle bloquerait
aussi les correctifs et la réconciliation, qu'on a précisément voulus autonomes.
Il faudrait d'abord séparer les deux chemins de déploiement.

---

## 6bis. Tests

**[fait]** Les constats de l'audit vivent dans une table unique qui porte à la
fois leur ordre d'affichage et leur libellé, et dont le type dérive. Ils étaient
auparavant déclarés à trois endroits : un constat ajouté au type mais oublié dans
l'ordre était collecté puis jamais affiché, ce qui est arrivé sans que rien ne le
signale.

**[fait]** Une suite de tests hors ligne, lancée par la CI de l'outil. Elle tourne
sur le parc fictif de `test/fixtures/` et ne lit aucune donnée d'un parc réel.
Chaque test correspond à une panne réellement survenue ou à un invariant du
moteur : un constat émis sous un nom absent de la table, un manifeste généré par
`init` que les expressions de Renovate ne liraient pas, un lock d'une version
inconnue.

**[fait]** Les contrôles des données d'un parc relèvent de `--validate`, lancé
sur chaque pull request du consommateur : une annotation Renovate désignant un
autre dépôt que le champ `repo`, une annotation absente, une entrée de lock sans
application correspondante.

**[fait]** Le relevé des avis amont est couvert par ses cas réels : le `x`
littéral de l'édition, une plage illisible, une plage illisible que le correctif
annoncé tranche, une faille sans correctif atteignable, un correctif qui sort de
la ligne d'édition, un correctif rattrapé par un avis plus récent. Chaque forme
de plage éprouvée a réellement été publiée par Metabase.

**[fait]** La veille de fin de vie est couverte par ses cas limites, contre les
lignes réelles de Metabase au 2026-11-04 : une ligne morte, une ligne plus récente
mais hors support long, une ligne qui est le dernier support long, un support long
plus récent déjà mort, une édition jugée contre l'autre, une ligne sans date
annoncée, une date illisible, une borne qui n'est pas une date du tout, le seuil
au jour près, et un outil hors de la table qui n'est pas interrogé.

**[fait]** Ses cas de journal sont testés à part de ses cas de verdict. Un verdict
juste dont le passage ne dit rien est le défaut qui a échappé au premier jet :
les tests vérifiaient qu'une ligne sans date rendait un verdict non daté, jamais
que le passage le disait, et il la comptait parmi les lignes saines.

**[fait]** Le fetch simulé sait faire échouer la source de fin de vie, par
`EOL_OUTAGE=1`, comme il sait déjà faire échouer la liste des addons. Sans ce
levier la branche de source illisible n'était pas atteignable par un test, et son
défaut d'échéance n'aurait pas pu être couvert.

**[fait]** Un test qui passe aussi bien avec le défaut qu'avec sa correction ne
protège rien. Le cas du rapprochement numérique en portait un : une version courte
face à une ligne longue ne trompe ni la lecture en chiffres ni la lecture en
chaîne, et son commentaire énonçait le danger à l'envers. Le risque est la ligne
courte, `0.6` préfixant la chaîne `0.65.3`, et c'est ce sens que le test exerce.

**[fait]** Chacun des tests de cette veille a été vérifié en cassant ce qu'il
protège : la validation du calendrier, l'échéance sur source illisible, l'écart des
lignes de support long qui régressent, l'arrondi du seuil, la distinction des
raisons d'un verdict absent, le sens du rapprochement numérique, et la fin de la
ligne en service dans le constat.

**[fait]** Les tests ont été vérifiés en cassant volontairement chacun des
invariants, pour s'assurer qu'ils échouent quand ils le doivent.

**[fait]** La CI lance aussi le typecheck et un plan complet sur le parc de test,
sans aucun secret. Node exécute le TypeScript en retirant les annotations sans
les vérifier : sans typecheck, une lecture de champ inexistant n'apparaît qu'à
l'exécution. Elle valide enfin les presets de `renovate/` par
`renovate-config-validator` : Renovate ne les lit que chez les parcs, où une clé
invalide ne se voit qu'à son passage suivant.

## 7. Limites connues

**Épingler le SHA du dépôt applicatif ne fige pas les buildpacks.** Les lignes du
`.buildpacks` n'ont pas de référence, donc chaque build reclone leur HEAD. Deux
déploiements du même SHA à plusieurs mois d'écart peuvent produire des builds
différents. Les SHA de buildpacks sont relevés dans le lock à titre
d'observation, pas de contrôle. Pour les figer, il faut un dépôt applicatif dont
le `.buildpacks` porte des références : c'est un choix de dépôt, pas une option
du watcher.

**Le retour arrière ne défait pas une migration de base.** Une montée de version
de Metabase migre le schéma de la base applicative. Redéployer l'ancienne version
donne un binaire ancien face à un schéma récent. Le retour arrière réel passe par
la restauration de la sauvegarde, ou par la commande `migrate down` exécutée avec
le binaire de la version supérieure.

**Aucune sonde HTTP après déploiement.** Interroger l'application elle-même ne
fonctionnerait pas partout : derrière un oauth2-proxy, c'est le wrapper qui prend
`$PORT`, donc sa disponibilité ne dit plus rien de l'outil déployé, et son
authentification arrête la sonde avant l'outil. La vérification reste donc
extérieure à l'application : le statut du déploiement, puis la fenêtre de
garde, appliquée d'office.

**Les journaux applicatifs ne sont pas lus.** Y chercher un marqueur de fin
d'initialisation serait le signal le plus direct, c'est même ainsi que le succès
a été établi à la main le 2026-10-30. Trois raisons de ne pas le faire. Leur URL
vit sur un autre hôte que l'API, hors de portée d'un blob du proxy, et elle porte
son jeton en clair, ce qui défait la promesse du mode proxy. La plateforme jette
des lignes au-delà de son débit d'ingestion, donc un marqueur absent serait
indiscernable d'un échec. Et le marqueur appartient à l'outil, là où le moteur
n'en connaît aucun.

**La fenêtre de garde ne prouve pas le démarrage.** Elle constate qu'aucun
redémarrage en erreur n'est survenu dans le temps déclaré. Trois choses lui
échappent. Une migration plus longue que la fenêtre, qui échoue après coup sans
que rien ne le dise au passage : la fenêtre se compte sur la migration la plus
longue observée, pas sur la plus courante. Un démarrage bloqué sans crash, un
verrou de migration ou une requête qui pend, qui ne produit aucun événement et
laisse l'application `running`. Et rien n'est rejoué au passage suivant : le lock
porte un déploiement réussi, donc la cible est tenue pour atteinte.

**Deux des trois événements surveillés ne sont pas documentés.** La page des
événements de l'API ne décrit que `restart`, dont une raison possible est
`unexpected_failure`. Les types `crash` et `repeated_crash` apparaissent dans le
client Go de Scalingo et dans ses notifications, pas dans cette page. Ils sont
surveillés par précaution : s'ils n'existaient pas sous ce nom, la fenêtre
retomberait sur le seul `restart` et sur l'état des conteneurs, et jamais sur un
refus à tort.

**La fenêtre se paie en temps de passage.** L'éclaireur est déployé seul, donc sa
fenêtre s'ajoute entière, puis une fenêtre par vague de trois. Six applications à
rattraper avec une fenêtre de dix minutes coûtent une demi-heure, sous un verrou
que la réconciliation suivante attend sans annuler celle qui tourne.

**Un déploiement fait hors du watcher est cru sur la parole de Scalingo.** La
fenêtre de garde ne tourne que sur les déploiements du moteur. Le relevé, lui, ne
rejoue aucune fenêtre : un redéploiement déclenché depuis le dashboard suffit
donc à lever une quarantaine, même si l'outil est à terre derrière son port qui
répond.

**Personne n'expose la version du binaire en service.** La variable dit la
version du prochain build. Une variable changée à la main sans déploiement fait
donc refuser une cible que l'application servait déjà. Le refus est assumé : les
deux cas se résolvent du même geste, regarder pourquoi le réel et le manifeste ne
disent pas la même chose, et le refus ne déploie rien tandis que l'erreur inverse
met l'application à terre.

**Après un échec de montée, le retour arrière demande `--force`.** Si l'échec a
été suivi d'un redéploiement réussi de la même cible, hors du watcher, le lock la
porte avec un déploiement réussi et le contrôle de descente refuse de revenir en
arrière. C'est cohérent avec la limite précédente sur les migrations : un retour
arrière réel passe par la restauration de la sauvegarde, et `--force --app` le
dit.

**Un refus ne change pas le code de sortie.** Comme les deux autres contrôles de
référence, une descente refusée sort en 0 : elle est portée par le rapport
d'incident et par le marqueur du tableau de bord, pas par l'intégration continue.

**L'arbitrage du lock prend le fichier entier.** Il garde le relevé le plus
récent, pas la réunion des deux. Deux passages qui auraient touché des
applications différentes dans la même fenêtre perdent donc les entrées du plus
ancien. La réconciliation suivante les relève, puisqu'elle lit le parc réel et
non le lock.

**`--adopt` oublie la quarantaine.** L'amorçage réécrit chaque entrée depuis
l'état réel, quarantaine comprise, et ne le signale pas. C'est un ré-étalonnage
demandé à la main, mais lancé sur un parc où une application est gelée, il la
remet en piste au passage suivant.

**Le tableau de bord n'a pas d'état pour un déploiement non abouti.** Il écrit
`conforme` dès que le couple version-commit du lock correspond au manifeste et
qu'aucune quarantaine ne traîne. Une application dont le dernier déploiement a
échoué hors du watcher s'y lit donc conforme, là où la quarantaine aurait pris
le dessus si l'échec était passé par le moteur.

**Renovate ne relance jamais une application en quarantaine.** Il lit le
manifeste, pas le lock. Une fois la pull request fusionnée, le sujet est clos
pour lui, même si une application est restée en arrière.

**OSV est inutilisable pour Metabase.** La base ne le connaît pas comme paquet et
fait de la correspondance approximative de nom : une requête sur `metabase` en
version `0.47.3` remonte des vulnérabilités d'`airbyte-server`. Les sources
exploitables sont les avis de sécurité publiés par l'éditeur sur son dépôt
GitHub, et le NVD par CPE.

**La correspondance de version dans les avis de sécurité est délicate.** Metabase
mélange les formats dans ses plages (`>= x.58.0`, `<= 1.48.6`, `<55.13`,
`1.47.X`) et double la ligne d'édition. Un rapprochement naïf produit des faux
positifs dans les deux sens.

**Les buildpacks Scalingo n'ont aucune étiquette de version.** Ni `git tag`, ni
release. Il n'existe donc pas d'ordre entre deux états d'un buildpack, seulement
« différent » et « plus récent ».

**Le mapping vers les releases amont doit être déclaré.** Rien dans un buildpack
ne dit de façon standard où l'outil publie ses versions. C'est la seule
information non dérivable : elle vit dans les modules d'outil du moteur, dans
`tool.upstream`, et dans les annotations du manifeste.

**Deux hôtes d'API distincts.** Les sauvegardes et les bases passent par
`db-api.<region>.scalingo.com`, séparé de `api.<region>.scalingo.com`.

**GitHub coupe les crons d'un dépôt public sans activité depuis 60 jours.** Un
parc stable dont le lock ne bouge plus et sans pull request Renovate perd sa
réconciliation planifiée sans prévenir. Un lancement manuel ou toute activité
sur le dépôt la rétablit.

**Workflows réutilisables indisponibles sur GitHub Enterprise Server.** Le job
appelé récupère l'outil par `job.workflow_repository` et `job.workflow_sha`, que
GHES n'expose pas.

---

## 8. Non implémenté

**[fait]** Croisement avec les failles activement exploitées. Les versions en
service sont confrontées au catalogue KEV de la CISA, croisé avec les plages de
versions affectées publiées par le NVD. Les deux sources sont publiques et sans
authentification.

**[fait]** Seul le KEV est consulté, et non l'ensemble des CVE du produit. Une
faille théorique ne justifie pas de court-circuiter le délai de décantation, une
faille exploitée dans la nature si. Deux entrées concernent Metabase là où le
produit en compte des centaines : le signal reste rare, donc il veut dire quelque
chose quand il se déclenche.

**[fait]** Une faille exploitée passe en tête du rapport mais ne fait pas échouer
l'exécution. Il n'existe pas toujours de version corrigée le jour où on
l'apprend, et un parc rouge en permanence cesse d'être lu.

**[fait]** Une version glissante (`v0.63.x`) n'est confrontée ni aux failles
exploitées ni aux avis de l'amont. Elle ne désigne pas la version servie, et lue
comme `0.63.0` elle tomberait dans toute plage ouverte en début de ligne. Seule
une version épinglée déclenche une alerte.

**[fait]** Relevé des avis de sécurité du dépôt amont. Les versions en service
sont confrontées aux avis que publie le dépôt d'où sort l'outil
(`GET /repos/{owner}/{repo}/security-advisories`). C'est la seule source qui
porte l'information pour un outil hors écosystème de paquets, et le relevé est
générique par construction : l'amont est déjà déclaré pour chaque outil, par son
module sous `src/tools` ou par `tool.upstream`.

**[fait]** Renovate ne peut pas tenir ce rôle, pour la raison exacte qui lui
interdit de suivre les versions de bases Scalingo. Un outil qu'un buildpack
installe depuis une variable d'environnement n'est une dépendance d'aucun
écosystème de paquets. Une alerte Dependabot exige un avis revu, rattaché à l'un
des écosystèmes supportés, et une dépendance visible dans le graphe de
dépendances : `manifest.yaml` n'est pas un manifeste reconnu. Les alertes OSV de
Renovate ne couvrent qu'une dizaine de datasources de paquets. Le preset `base`
annonçait donc depuis le départ une veille que la plateforme ne peut pas produire
sur cet axe : son `osvVulnerabilityAlerts` a été retiré et la description de son
`vulnerabilityAlerts` corrigée, ce bloc ne valant que pour ce que la plateforme
sait voir, les workflows appelants et les presets.

**[fait]** Ni le CVE ni le score CVSS ne servent de clé. Sur les 45 avis du dépôt
Metabase au 2026-10-30, 17 n'ont aucun CVE et 29 aucun score. Le plus récent,
GHSA-v44v-x8x4-mvcw, critique, n'a ni l'un ni l'autre et est absent de la base
globale GitHub comme d'OSV. Seules les plages `vulnerable_version_range` et
`patched_versions` de l'avis sont lues.

**[fait]** L'édition écrite en `x` littéral est substituée par celle de la
version jugée. Les plages de Metabase s'écrivent `>= x.64.0, < x.64.3.4` pour
couvrir d'un seul avis la ligne OSS et la ligne Enterprise. Ce n'est pas du
semver : sans cette substitution aucune plage ne correspond jamais et tout le
parc passe pour indemne. Elle maintient de surcroît la comparaison dans la ligne
de la version jugée, les deux éditions n'étant jamais comparables entre elles.

**[fait]** Une plage dont la forme n'est pas celle qu'on sait lire ne vaut ni
affectation ni innocence : elle est tranchée par le correctif que l'avis annonce
lui-même. Au-delà du plus haut correctif qu'il nomme dans la ligne, la faille y
est corrigée quelle que soit la forme de ses plages ; en dessous, l'avis est
signalé comme non concluant plutôt que tenu pour indemne. L'amont en écrit
beaucoup et de plusieurs sortes : des disjonctions de lignes
`<x.44.5,<x.43.7,<x.42.6`, des bornes basses sans opérateur `1.55.0, < 1.55.23`,
de la prose `All enterprise versions < 1.59.x`. Sur les 104 plages des 45 avis du
dépôt Metabase, 30 ne se lisent pas. Le premier jet les signalait toutes, à
chaque passage, sur un parc dont aucune version n'était affectée : l'alerte
permanente qu'on apprend à ignorer. Deux règles les ramènent à zéro sur la ligne
`0.x`, le correctif annoncé en écartant 18 et la règle de ligne ci-dessous les 12
autres. Il en reste 6 sur la ligne `1.x`, qu'aucune des deux ne tranche.

**[fait]** Un avis qui ne nomme aucune version de la ligne en service ne la
concerne pas. Les avis qui portent sur les deux éditions s'écrivent en `x`
littéral : un avis dont tous les numéros sont d'une autre édition est un avis de
cette autre édition. Limite connue, quelques vieux avis écrivent leurs numéros
sans édition, `<55.13` pour `<0.55.13`, et passent ainsi pour étrangers à la
ligne ; ils portent sur des versions corrigées depuis des années.

**[fait]** Une application en pause n'entre jamais dans ce qui demande une
intervention, son correctif fût-il atteignable. Rien n'y est déployé et
`--propose-security` l'écarte : le tableau de bord désignerait une pull request
qui ne sera jamais ouverte, et le marqueur d'état resterait levé sur une faille
que rien dans le watcher ne peut refermer. Elle reste constatée au tableau, son
correctif nommé et dit non proposé, comme la montée de base d'une application en
pause.

**[fait]** Une application est désignée dans le manifeste par sa région et son
nom, y compris par les deux propositions quand elles l'éditent. Le nom seul ne
suffit pas et rien n'en garantit l'unicité : `init` écrit une entrée par région
et par application sans dédoublonner les noms, le schéma ne contraint pas
l'unicité et `--validate` ne la vérifie pas. Sur le nom seul, deux instances
homonymes dans deux régions rendaient le même rang dans le document : la seconde
était écartée sur un message faux, « version introuvable dans le manifeste », sa
montée n'était jamais proposée et le passage sortait en succès.

**[fait]** Un appel réseau par couple dépôt amont et version en service, et non
par application : sept instances du même outil à la même version donneraient sept
fois la même requête. Le verdict se rend en revanche par application, contre le
lock : le parc n'est pas homogène, six instances en v0.64.4.2 et une en v0.63.16
sont deux situations de sécurité distinctes.

**[fait]** Le correctif retenu est la version la plus basse de la ligne en
service qu'aucun avis ne couvre, et non la borne haute de la plage : les deux
diffèrent régulièrement, `>= x.58.0, < x.58.23` est corrigée en `x.58.24`. Il est
confronté à tous les avis et pas seulement à ceux qui couvrent la version en
service, sinon une faille apparue après elle rattraperait la version visée et la
pull request proposerait une montée vers un état encore vulnérable.

**[fait]** Une faille sans correctif atteignable dans sa ligne est constatée au
tableau de bord et n'y demande pas d'intervention. Il n'existe pas toujours de
version corrigée le jour où on l'apprend, et la réclamer à chaque passage en
ferait là encore une alerte permanente, exactement le travers de la montée de
base volontairement retenue. Monter d'édition n'est pas un correctif mais une
montée fonctionnelle, qui ne se décide pas sous la pression d'un avis.

**[fait]** La décision de monter passe par une pull request, `--propose-security`,
second et dernier endroit du projet où le watcher en ouvre une. Elle juge la
version du manifeste et non celle du lock : le manifeste est l'intention, et
c'est la seule chose que cette commande édite. Le constat du tableau de bord,
lui, juge bien ce qui tourne.

**[fait]** `--propose-security` n'a besoin d'aucun accès à Scalingo, les avis de
l'amont et le manifeste suffisant à rendre le verdict. Son workflow ne déclare
donc pas d'`environment` et ne peut pas lire la clé du proxy. Les applications en
pause sont écartées, comme pour les bases, rien n'y étant jamais déployé. Les
deux propositions refusent de tourner dans le même passage : elles écrivent
`pr-title.txt` et `pr-body.md` au même endroit et poussent sur deux branches
distinctes.

**[fait]** Aucun champ pour désactiver le relevé, ni par outil ni par
application. Il ne lit que des avis publics et n'écrit rien sans pull request :
un interrupteur ne servirait qu'à taire une faille connue, et cette décision n'a
pas sa place dans un fichier versionné. Une application qu'on ne veut pas voir
bouger se met en pause, ce qui la laisse constatée sans rien proposer. Un faux
positif se corrige par `tool.upstream`, qui désigne le bon dépôt.

**[fait]** Une surveillance muette dit qu'elle a regardé : le passage annonce le
nombre d'avis confrontés et sur combien de dépôts. Sans ce décompte, un amont qui
ne publie rien sur les versions en service et un relevé en panne rendent
exactement le même silence.

**[fait]** Veille de la fin de vie de la ligne en service. Les versions du lock
sont confrontées à ce que l'éditeur annonce pour leur ligne de versions, lu chez
endoflife.date (`GET /api/v1/products/{nom}`). L'outil savait déjà veiller sur
les failles de l'amont et sur la dépréciation d'un stack, mais rien ne disait
quand la ligne suivie cesse d'être supportée : la borne `allowedVersions` du
preset Metabase est tenue à la main, son commentaire dit de l'éditer au prochain
changement de support long, et personne n'était prévenu de ce changement. Il a
fallu une recherche manuelle pour établir que la 0.65, plus récente et donc
tentante, sortait du support long et mourait onze mois avant la 0.64 en service.

**[fait]** La version 1 de l'API est préférée à la version 0 pour une raison de
forme. La v0 écrit `eol` et `lts` tantôt en booléen tantôt en date,
`"lts":"2026-10-28"` chez nodejs, `"eol":true` sur une ligne déjà morte : lire
cette union demanderait de trancher à chaque champ ce qu'une valeur veut dire, et
une erreur y rendrait « supportée » une ligne qui ne l'est plus. La v1 sépare le
drapeau de la date, `isEol` et `eolFrom`, `isLts` et `ltsFrom`, et porte un
`schema_version`.

**[fait]** Le rapprochement entre un outil et un produit de la source est déclaré,
jamais dérivé de sa variable de version. C'est la règle que les modules d'outil
s'imposent déjà, pour la même raison : un mauvais rapprochement daterait la
fin de vie d'un autre produit, ce qui est pire qu'une fin de vie inconnue. Le nom
vient du module de l'outil ou de `tool.upstream.lifecycle`, et un outil qui n'en
a pas n'est pas interrogé du tout. Le dépôt `SonarSource/sonarqube` publie
aujourd'hui la Community Build numérotée `26.x`, donc `sonarqube-community` et non
la `sonarqube-server` numérotée par année, qui est un autre produit.

**[fait]** La ligne en service est celle dont les composants préfixent la version
jugée, la plus précise quand plusieurs le font. La lecture est numérique et non
textuelle : en chaîne, `0.65` préfixerait `0.6`. Les lignes retenues sont ensuite
celles que le champ `line` rend comparables à la version jugée. Chez Metabase le
premier chiffre désigne l'édition : sans ce filtre, une ligne `1.x` de
l'Enterprise passerait pour un support long plus récent que la `0.64` de l'OSS,
quand c'est un changement d'édition. Limite assumée, chez un outil où `line`
désigne bien la majeure, un support long de la majeure suivante n'est pas nommé ;
c'est la fin de support de la ligne en service qui est signalée, et elle seule
force la décision.

**[fait]** Deux signalements de nature différente, rangés à deux endroits. Une
fin de support proche ou dépassée est une date qui tombe, comme la dépréciation
d'un stack : elle part dans les échéances, donc au journal, dans l'issue d'état du
parc et dans la notification. Une ligne de support long plus récente n'est pas une
date mais une décision à instruire, et resterait des mois dans l'issue à chaque
passage, ce qui est exactement l'alerte permanente qu'on apprend à ignorer : elle
reste au journal. Une échéance nommant déjà le support long en cours, le constat
ne la répète pas.

**[fait]** Le seuil de l'échéance est de quatre-vingt-dix jours. La politique de
Metabase garantit au moins soixante jours à une ligne ordinaire et au moins
quatorze mois à une ligne de support long : un seuil calé sur soixante ne
laisserait aucune marge sur une ligne courte. Un trimestre laisse le temps
d'instruire la montée en pull request puis de la dérouler sur le parc, ce qui est
le délai réel entre le signal et le dernier déploiement.

**[fait]** La veille ne déploie rien, ne propose aucune pull request et n'édite
pas la borne `allowedVersions`. La ligne suivie reste une décision humaine, portée
par le preset ; cette veille dit seulement quand la reprendre.

**[fait]** Une version qu'aucune ligne de la source ne porte est dite sans
verdict, elle ne passe pas pour supportée. C'est le cas de l'édition Enterprise
de Metabase, que la source ne liste pas, et d'une version fraîchement publiée que
la source n'a pas encore référencée : `26.11.0.134175` existe en tag du dépôt
SonarQube alors que la source s'arrête à la ligne `26.10`. Une version glissante
ne tranche pas non plus, pour la raison qui l'écarte déjà des avis. Et comme pour
les avis, une veille muette dit qu'elle a regardé : le passage annonce le nombre
de lignes relevées et sur combien de produits, sans quoi une ligne que rien ne
menace et un relevé en panne rendraient le même silence.

**[fait]** Une ligne dont la source ne date pas la fin se dit elle aussi, pour la
même raison et au même endroit. Elastic n'annonce aucune date, donc les lignes de
Kibana et de Logstash n'en portent pas, et ces deux outils sont dans la table :
une fin qu'on ne sait pas dater n'est ni proche ni lointaine, et la taire la
faisait compter parmi les lignes que rien ne menace. Le premier jet le faisait,
et deux relectures indépendantes l'ont attrapé là où les tests du verdict seul ne
pouvaient pas : ils vérifiaient que le verdict n'était pas daté, jamais ce que le
passage en disait.

**[fait]** Une date est validée sur le calendrier et pas seulement sur sa forme.
`2026-13-01` et `2026-11-32` passent l'expression `\d{4}-\d{2}-\d{2}` et rendent
`NaN` à la lecture, soit exactement le `NaN` contre lequel le garde existe :
`NaN <= seuil` étant faux, la ligne ne devenait pas une échéance, et comme la
date n'était pas nulle elle ne devenait pas non plus un constat. Les deux portes
se refermaient et le passage ne disait plus qu'« aucune ligne n'approche de sa fin
de support ». `2026-02-31` ne rend pas `NaN` mais roule au 3 mars, et compter les
jours depuis une date que personne n'a annoncée est un autre faux. Le détour par
`toISOString` attrape les deux : une date impossible n'en revient jamais à
l'identique. La chaîne qui ressemble à une date était ainsi moins bien traitée que
celle qui n'y ressemble pas.

**[fait]** Une source de fin de vie injoignable laisse une échéance, et non un
parc sain. Sans elle, `warnings` redevenait vide, le rapport repassait en état
sain et l'action qui notifie annonçait un retour à la normale sur un parc dont la
ligne peut avoir cessé de recevoir des correctifs : un 503 chez la source
suffisait à envoyer cette fausse bonne nouvelle, la veille n'ayant ni colonne ni
rangée dans l'issue. C'est le garde que `readStacks` pose déjà sur une liste de
stacks illisible, avec le même motif, une surveillance muette étant indiscernable
d'un parc sain.

**[fait]** Une ligne de support long qui meurt avant la ligne en service n'est pas
nommée comme issue. C'est le travers même que cette veille existe pour éviter, un
cran plus haut : se laisser attirer par un numéro plus récent dont le support
s'arrête plus tôt. La candidate qui régresse est écartée avant le choix, donc elle
ne masque pas une ligne plus ancienne qui, elle, vit plus longtemps. Quand l'une
des deux fins n'est pas datée, rien ne se compare : la ligne est nommée avec sa
date, et c'est au lecteur de juger. Le constat porte d'ailleurs la fin de la ligne
en service à côté de celle qu'il propose, sans quoi ce lecteur ne peut voir ni ce
que la montée lui gagne, ni qu'elle ne lui gagne rien.

**[fait]** Le seuil ne dépend pas de l'heure du passage. La borne vaut minuit UTC
et l'instant de comparaison est celui de l'exécution : arrondi au plus proche, une
passe de l'après-midi voyait quatre-vingt-onze jours pleins comme quatre-vingt-dix
et déclenchait le seuil un jour trop tôt. L'arrondi au jour supérieur donne de
surcroît le compte calendaire, celui qu'un lecteur attend : du 4 novembre 2026 au
1er décembre 2027, trois cent quatre-vingt-douze jours et non trois cent
quatre-vingt-onze.

**[fait]** Les trois raisons d'un verdict absent se disent séparément : une source
illisible, une version qu'on ne sait pas lire et une version qu'aucune ligne ne
porte. Les dire sous la même phrase en rendait deux fausses, une version flottante
n'étant pas absente de la source, qui porte bien sa ligne. C'est le champ
`missing` que le relevé des avis porte déjà pour la même raison.

**[fait]** Une date hors forme est distinguée d'une absence de date, et retenue
telle quelle. Le garde qui la ramène à « pas de date » existe pour éviter un
`NaN`, puisque `NaN <= seuil` est faux et laisserait la ligne passer pour
supportée. Mais les deux cas ne demandent pas la même chose : l'absence est un
fait de l'éditeur, la forme inattendue dit que la source a changé et se corrige
dans le moteur. Les confondre perdrait le seul signal de ce changement, y compris
le retour à la forme de la version 0 de l'API, où cette borne s'écrit en booléen.
C'est la distinction que le relevé des avis fait déjà entre une plage absente et
une plage illisible.

**[fait]** Un appel réseau par outil, et un verdict par couple outil, ligne et
version. Sept instances du même outil donneraient sept fois la même requête, et
un parc hétérogène juge chaque version qu'il porte sans relire la source. Les
deux mécanismes sont distincts et un parc homogène ne les sépare pas : le test du
compteur d'appels passait sans le cache, la mémoire du verdict par couple y
suffisant. Il porte désormais deux versions du même outil.

**[fait]** Surveillance des stacks. Chaque application est confrontée à la liste
des stacks de sa région, qui portent une date de dépréciation. Un stack en fin de
vie ne casse rien le jour même : il cesse d'abord de recevoir des correctifs,
puis les builds finissent par échouer. C'est typiquement l'échéance qu'on ne voit
pas venir sans la surveiller.

**[fait]** Une échéance remonte sans faire échouer la convergence. Elle apparaît
dans l'issue et la notification, dans une section distincte des pannes, mais le
code de sortie reste nul : sinon le parc resterait rouge des mois durant alors
que rien ne cloche aujourd'hui.

**[fait]** Surveillance des versions de bases. Le champ `next_version_id` dit
qu'une montée est disponible, et c'est tout ce que l'API expose : aucune date de
fin de vie, contrairement aux stacks. Le constat est donc « il existe plus
récent », pas « celle-ci expire le tant », et il est rangé parmi les échéances,
sans urgence.

**[fait]** L'audit relève lui aussi les versions de bases, mais seulement pour
les applications qui ont un blob de sauvegarde, c'est-à-dire celles du manifeste.
Balayer toutes les applications du compte doublerait le nombre d'appels pour une
information qu'on ne suit pas.

**[fait]** Ce relevé se fait en série, après la collecte parallèle. Chaque appel
à `db-api` coûte deux requêtes Scalingo au proxy, l'échange du jeton de compte
puis l'obtention du jeton d'addon : mené dans la collecte à cinq voies, il
portait la charge à une vingtaine de requêtes simultanées et Scalingo répondait
504. Les bases à relever sont celles du manifeste : les enchaîner ne coûte que
quelques secondes.

**[fait]** Une base devient pilotée quand le manifeste déclare sa version
attendue. Sans ce champ elle reste simplement surveillée : le passage à l'un ou
l'autre régime est une décision explicite, le watcher ne s'attribue pas des bases
qu'on ne lui a pas confiées.

**[fait]** La décision de monter passe par une pull request. Un workflow
quotidien relève les bases pilotées, résout le nom de la version suivante et
ouvre une pull request qui fait avancer le manifeste d'un cran. La fusionner
autorise la montée sans la déclencher : la réconciliation l'applique ensuite,
précédée d'une sauvegarde dont l'échec l'annule.

**[fait]** Ce relevé ne touche rien d'autre que le manifeste. `--propose-db` sort
avant le chargement du lock : ni déploiement, ni sauvegarde, ni réconciliation.
Il déroulait auparavant toute la vague avant de proposer. Des déploiements réels
partaient alors dans le groupe de concurrence `propose-db`, à côté de la
réconciliation, et le lock qu'ils mettaient à jour n'était jamais commité, le
workflow n'ajoutant que le manifeste. Le workflow vérifie aussi que le lock n'a
pas bougé avant de pousser.

**[fait]** Renovate ne peut pas tenir ce rôle. Une version de base Scalingo n'est
pas une dépendance publiée quelque part mais un état de la plateforme, et aucune
datasource ne l'expose. Le watcher ouvre donc lui-même cette pull request, seul
endroit du projet où il en crée une.

**[fait]** Une montée qu'on a décidé de retenir n'est pas signalée comme une
échéance. Après avoir monté quatre bases au dernier palier de leur majeure,
chacune annonçait « une version plus récente est disponible » : c'était le saut
vers la majeure suivante, écarté volontairement. L'issue serait restée ouverte
indéfiniment à réclamer ce qu'on avait choisi de ne pas faire, ce qui est
précisément l'alerte permanente qu'on apprend à ignorer.

**[fait]** Le titre et le corps de la pull request sont réécrits à chaque
passage. `--propose-db` les écrit dans `pr-title.txt` et `pr-body.md`, sous
`--out-dir`, seulement quand il modifie le manifeste, et le workflow ouvre ou
met à jour la pull request avec. La branche étant réutilisée d'un passage à
l'autre pour ne pas accumuler une pull request par passage, une pull request
déjà relue peut se retrouver à porter autre chose : son libellé doit donc nommer
les applications qu'elle concerne maintenant, et non ce qui avait été proposé la
fois précédente.

**[fait]** Un saut de majeure du moteur, PostgreSQL 16 vers 17 par exemple, n'est
ni proposé ni appliqué sans l'avoir autorisé par `database.major: allowed`. Une
majeure ne se retourne pas, prend bien plus longtemps qu'un correctif et peut
demander des ajustements applicatifs. Rien n'oblige à la franchir tôt, les
majeures PostgreSQL restant supportées cinq ans. Le refus vaut aussi à
l'application, au cas où le manifeste aurait été édité à la main.

**[fait]** Une seule version d'écart par pull request. L'API ne sait monter que
vers la version immédiatement suivante, et le watcher refuse une cible qui n'est
pas celle-là plutôt que d'enchaîner des montées que personne n'a décidées. Un
retard de plusieurs versions se rattrape en autant de pull requests.

**[fait]** Les montées sont menées en série et jamais de front : elles coupent le
service, les mener ensemble multiplierait l'indisponibilité au lieu de l'étaler.

**[à faire]** Interface de consultation. Le tableau de bord Renovate couvre le
besoin en attendant.

**[à faire]** Gestion des dépôts applicatifs privés, qui demanderait de résoudre
une URL signée temporaire via l'API GitHub avant de la transmettre à Scalingo.

**[fait]** Le tableau de bord porte un tableau par chose surveillée : l'outil,
sous son nom, les avis de sécurité de son amont, les bases, les buildpacks.
Chacun donne la version en service, ce qui est disponible en amont, et l'état.
Les versions lient vers leur annonce : les releases GitHub du dépôt amont de
l'outil, le changelog Scalingo pour les bases, avec son ancre par version. Le
tableau des avis lie chaque avis vers sa page `security/advisories`.

**[fait]** Chaque tableau porte une légende de sa colonne `État`, juste en
dessous. Les valeurs ne veulent pas dire la même chose d'un tableau à l'autre :
`en écart` parle d'une convergence à venir, `non relevée` d'une valeur qu'on
affiche sans l'avoir constatée, `suit sa branche` d'un buildpack non épinglé. Les
laisser sans explication obligeait à connaître le code pour les lire.

**[fait]** Le tableau de bord porte les accents, contrairement aux journaux : il
est lu par des humains sur GitHub, pas dans un terminal.

**[fait]** La colonne de mise à jour dit « non » plutôt que de rester vide quand
rien n'est disponible, et nomme la version accessible sinon. Pour le dépôt
applicatif, elle distingue trois cas : un commit en avance, une branche
introuvable, ou un dépôt qui a changé depuis le dernier déploiement.

**[fait]** Les buildpacks n'étant pas épinglés, leur colonne de mise à jour
compare la tête de leur dépôt à la date du dernier déploiement. C'est la seule
façon de voir qu'un redéploiement embarquerait du code différent.

**[fait]** Une version de base non relevée est présentée comme déclarée et non
comme constatée. C'est le cas d'une base que l'accès ne permet pas de lire, faute
de blob de sauvegarde par exemple : afficher la cible du manifeste sans le dire
la ferait passer pour un constat.

**[fait]** L'équipe n'est prévenue que sur un changement d'état, pas à chaque
retouche du tableau de bord. Celui-ci bouge dès qu'une version paraît en amont,
ce qui n'est pas un évènement : le watcher pose donc un marqueur explicite que le
workflow compare à celui déjà en place. Se fonder sur le texte rendu aurait fait
sonner l'équipe à chaque release de Metabase.

**[fait]** Une issue permanente décrit l'état de la convergence, sur le modèle du
tableau de bord Renovate. Elle n'est jamais refermée : son corps est réécrit à
chaque passage et dit « rien à signaler » quand tout va bien. Le modèle
précédent, qui ouvrait puis refermait une issue par épisode, en avait produit
sept en dix jours, sans historique commun et sans endroit stable à mettre en
favori. La chaîne tourne seule la nuit : un échec ou une
quarantaine n'était connu de personne avant que quelqu'un pense à ouvrir les
exécutions.

**[fait]** Le label et le titre de cette issue sont des inputs des workflows,
`etat-parc` et `Parc Scalingo : etat de la convergence` par défaut.

**[fait]** Le corps de l'issue décrit l'état courant plutôt que l'historique.
Réécrire ce corps ne prévient personne, contrairement à un commentaire : chaque
passage peut donc le remettre à jour sans noyer l'équipe sous une notification
par créneau.

**[fait]** Le pied porte deux dates, celle du dernier changement du parc et
celle du dernier passage du watcher. Avec le seul horodatage du changement, un
parc calme et une chaîne arrêtée affichaient exactement le même tableau : rien
ne disait si la surveillance tournait encore, et il fallait ouvrir les
exécutions pour le savoir.

**[fait]** Notification sur les seuls changements d'état, vers un ou plusieurs
canaux : Teams (carte adaptative des Workflows Power Automate), webhook au
format Slack (Slack, Mattermost, Rocket.Chat, Tchap via une passerelle comme
slack2tchap), Matrix en direct avec un compte bot (Tchap compris, faute de
webhook entrant). Une quarantaine qui dure ne sonne pas
à chaque passage : passé la première alerte, le canal reste silencieux
jusqu'à ce que la situation change ou se résolve. Sans canal configuré,
seule l'issue est tenue à jour.

**[fait]** Une notification qui échoue n'échoue pas la convergence. Elle est
signalée en avertissement du job, l'issue restant de toute façon à jour.

**[à faire]** Notifications Scalingo elles-mêmes, pour les évènements que le
watcher ne voit pas : crash d'une application, dépassement de quota. Le provider
Terraform de Scalingo a une ressource dédiée, plutôt que de réécrire l'alerting.

---

## 9. Distribution

**[fait]** Workflows réutilisables (`on: workflow_call`) pour la réconciliation,
l'application, la validation et les deux propositions, montées de base et
montées de sécurité. Le dépôt consommateur ne déclare que les déclencheurs, le
cron, les permissions et le mappage des secrets. Les chemins des fichiers du
parc, le label et le titre du tableau de bord, les messages de commit et les
branches de proposition sont des inputs.

**[à faire]** Appelant de `propose-security.yml` dans le dépôt starter. Le
workflow voyage avec l'outil dès maintenant, mais le starter ne pourra l'épingler
qu'une fois cette version publiée, comme pour tout ce que l'outil ajoute.

**[fait]** Le job appelé récupère le dépôt consommateur, puis l'outil au sha du
workflow appelé, et installe Node et pnpm aux versions déclarées par l'outil
(action `setup`). Le dépôt consommateur n'a ni `package.json` ni `.nvmrc`.

**[fait]** Actions composites dans `actions/` : `setup`, `signaler` (tableau de
bord et notification), `commit-lock` (push du lock rejoué, et arbitré par sa date
quand deux passages l'ont écrit).

**[fait]** Chemins des fichiers du parc en options (`--manifest`, `--lock`,
`--fgp`), relatifs au répertoire courant. Le schéma est lu à côté du moteur, quel
que soit le répertoire courant.

**[fait]** Sorties d'un passage dans `--out-dir`, par défaut
`$RUNNER_TEMP/scalingo-watcher` en CI et en local un répertoire privé
`scalingo-watcher-XXXXXX` du répertoire temporaire du système, nouveau à chaque
passage et affiché à sa création, plus rien dans le dépôt : un fichier produit à
côté du lock finit tôt ou tard commité avec lui.

**[fait]** Deux modes d'accès à Scalingo, en local comme dans les workflows :
`SCALINGO_API_TOKEN` en direct, ou `FGP_KEY` et `fgp.json`. L'adresse du proxy
est lue dans `fgp.json`. `fgp-blobs` vise le proxy choisi par `--url` et affiche
la commande `gh secret set` pour le dépôt courant.

**[fait]** Presets Renovate versionnés avec l'outil : `base`, `metabase` et
`watcher`, étendus par tag par le consommateur.

**[fait]** Dépôt starter `incubateur-ademe/scalingo-parc-template` : manifeste
d'exemple fictif, `renovate.json`, workflows appelants, et checklist
d'installation. Seule source de son contenu, tenu à jour par Renovate comme un
parc. La CI de l'outil vérifie que ses appelants mappent les secrets du workflow
qu'ils épinglent.

**[fait]** Releases par release-please sur les commits conventionnels : pull
request de release tenue à jour, tag `vX.Y.Z` et release GitHub à la fusion,
tag majeur `vX` déplacé sur le même commit.

**[fait]** Licence MIT et `publiccode.yml` pour les catalogues de logiciels
publics.

**[fait]** Identifiants de code en anglais, messages affichés, commentaires et
documentation en français.

**[fait]** Publication : dépôt public de l'outil, ruleset qui rend les tags
`vX.Y.Z` immuables, releases depuis `v1.0.0`, dépôt starter.

**[fait]** Un job appelé qui déclare `environment:` lit la valeur d'un secret de
cet environment à condition que l'appelant mappe ce secret ; non mappé, il
arrive vide. Vérifié en production sur le premier parc.

**[à faire]** Confirmer ce comportement pour un consommateur hors de
l'organisation de l'outil.

**[à faire]** Outils autres que Metabase de bout en bout. Le moteur les prend en
charge, mais seul Metabase a un preset d'outil, et les modules se limitent aux
dépôts vérifiés. La recette d'ajout est dans le README.

## 10. Tableau de bord

`writeIncident()` écrit `incident.md` dans le répertoire de sortie, et
`actions/signaler` le publie tel quel dans une issue étiquetée `etat-parc`,
réécrite à chaque passage et jamais refermée. Le même fichier sert de rapport
d'incident. Le marqueur `<!-- etat: sain|intervention -->` sépare les tableaux
de ce qui demande une intervention, et `src/notify.ts` n'envoie que ce qui le
suit.

Le corps ne porte que l'état du parc. Le vocabulaire des colonnes et la méthode
des relevés vivent ici, et le rapport y renvoie par un lien au tag qui tourne.

### États du tableau des applications

| État | Ce qu'il dit |
| --- | --- |
| `conforme` | ce qui tourne correspond au manifeste |
| `en écart` | le manifeste demande autre chose, la convergence le rattrapera |
| `quarantaine` | une tentative a échoué sur cette cible, et elle ne sera pas retentée tant que le manifeste ne change pas |
| `en pause` | l'application est lue à chaque passage, jamais modifiée |

### États du tableau des avis de sécurité

| État | Ce qu'il dit |
| --- | --- |
| `indemne` | aucun avis ne porte sur la version en service |
| `affectée` | au moins un avis la couvre, et la colonne `Correctif` donne la version qui en sort |
| `plage illisible` | un avis existe dont la plage de versions a une forme inattendue, il reste hors du verdict |
| `sans verdict` | les avis n'ont pas pu être lus, ou la version en service est incomparable |

### États du tableau des bases de données

| État | Ce qu'il dit |
| --- | --- |
| `relevée` | la version a été lue sur Scalingo |
| `non relevée` | la valeur affichée vient du manifeste |
| `en pause` | la base est lue, jamais sauvegardée ni montée |

### États du tableau des buildpacks

| État | Ce qu'il dit |
| --- | --- |
| `suit sa branche` | le buildpack est déclaré sans référence fixe, chaque build reprend la tête de sa branche par défaut, et la colonne de mise à jour compare cette tête à la date du dernier déploiement |
| `épinglé` | une référence fixe est déclarée, et le build garde la même tant qu'on ne la change pas |

### Méthode des relevés d'avis

Les avis sont lus sur le dépôt amont de l'outil, seule source qui les porte. Un
outil installé par un buildpack depuis une variable d'environnement
n'appartient à aucun écosystème de paquets, donc aucune alerte de dépendance ne
l'atteint et Renovate ne peut pas tenir ce rôle.

La comparaison porte sur la version que le lock dit en service, qui peut
différer de celle que le manifeste demande. Le correctif indiqué est la version
la plus basse de la ligne en service qu'aucun de ces avis ne couvre, et
`--propose-security` ouvre la pull request qui la porte.

Une faille sans correctif atteignable dans sa ligne reste au tableau sans
demander d'intervention : la réclamer à chaque passage en ferait une alerte
permanente. Une application en pause y reste pour la même raison, son correctif
fût-il atteignable, puisque rien n'y est déployé.

Le catalogue KEV de la CISA est consulté à part. Il ne retient que les failles
exploitées dans la nature, et une entrée qui y figure justifie de monter la
version sans attendre le délai de décantation.
