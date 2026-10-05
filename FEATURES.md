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

**[fait]** Neuf types de constats : variable de version absente, variable
flottante (`*` ou `latest`), buildpack non épinglé, retard dans la ligne
majeure, ligne majeure en retard, ligne majeure absente des releases amont,
dernier déploiement en échec, application dormante au-delà de 180 jours, source
de releases inconnue.

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
flottante, qui n'a pas de dépôt lié ou dont le dernier déploiement ne désigne
pas un commit. Seule la variable de l'outil est lue dans l'environnement de
l'application, qui contient ses secrets en clair.

**[fait]** L'ordre du tableau `apps` est l'ordre de déploiement, de la moins
critique à la plus critique.

**[fait]** Politique globale dans `defaults`.

**[fait]** Politique par application. Le `depName` vu par Renovate est le nom de
l'application Scalingo, pas le dépôt amont, donc une exception pour une seule
instance s'écrit comme une règle nominative (`matchDepNames`) dans le
`renovate.json` du consommateur.

**[fait]** Deux valeurs de politique seulement, `auto` et `pr`. Refuser une
montée consiste à ne pas fusionner la pull request.

**[fait]** Mode de sauvegarde par application : `required` ou `not-available`.
Cette seconde valeur se pose consciemment après vérification, jamais par défaut.

**[fait]** Chaque application déclare son dépôt applicatif et sa branche
indépendamment : deux applications d'un même parc peuvent suivre deux dépôts
différents.

**[fait]** Les commentaires d'annotation portent la source des versions et sont
fonctionnels. Les supprimer coupe la veille silencieusement.

**[fait]** Région libre, de la forme `^[a-z0-9-]+$` : le schéma ne fige aucune
liste. Elle finit dans un nom d'hôte, rien d'autre n'y entre.

**[fait]** Une table d'amonts connus, partagée par l'audit et l'apply, dit où
chaque outil publie ses versions, indexée par sa variable de version. Le champ
`tool.upstream` la complète pour un outil qu'elle ne connaît pas, ou la
surcharge. Le titre de section du rapport et les liens de release en dérivent.

**[fait]** Un champ renommé reste accepté sous son ancien nom, avec un
avertissement au `--validate` et au plan. Les deux noms présents et en
désaccord sont refusés. Aucun renommage n'est en vigueur à ce jour : le
mécanisme existe pour qu'une montée de l'outil ne casse aucun manifeste.
Les champs que Renovate, `--validate` et `--propose-db` relisent dans le texte
brut (`app`, `source.branch`, `source.sha`, `tool.version`, `database.version`
et leurs parents) en sont exclus : le moteur refuse un alias sur eux.

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

**[fait]** Suivi de la version de l'outil via `github-releases`.

**[fait]** Versionnage sur mesure pour Metabase, dans le preset `metabase`, avec
un groupe `compatibility` qui isole les lignes OSS et Enterprise. Effet de bord
à connaître : `major` désigne le deuxième chiffre (0.63 vers 0.64, montée
fonctionnelle) et `minor` le troisième (0.63.15 vers 0.63.16, correctif).

**[fait]** Délai de décantation de cinq jours avant toute proposition, pour ne
pas déployer une release publiée le matin même.

**[fait]** Fusion automatique sur les correctifs, pull request sur les montées
fonctionnelles. Les deux règles sont restreintes au manifeste : une mise à jour
de l'outil lui-même n'est jamais fusionnée seule. Elles ne visent que Metabase,
dont le versioning fait du troisième chiffre un correctif. Un autre outil reste
en semver, sans fusion automatique.

**[fait]** Jamais de fusion automatique sur un changement de SHA : un condensat
n'a ni version sémantique ni journal des modifications, donc rien à classifier.

**[fait]** Les alertes de vulnérabilité passent devant le délai de décantation et
sont étiquetées `securite`. Elles ne sont pas fusionnées d'office. Renovate
applique ce réglage à toute dépendance, scalingo-watcher compris chez un
consommateur, par-dessus ses règles.

**[fait]** Chaque entrée est nommée par son application. Sans cela le tableau de
bord affichait plusieurs fois `metabase/metabase v0.63.15` sans dire de quelle
instance il s'agissait, et les pull requests étaient tout aussi muettes. Le nom
du dépôt amont reste utilisé pour interroger la source des versions, il n'est
simplement plus ce qui est affiché.

**[fait]** Les deux axes sont étiquetés `source` et `outil` via le type de
dépendance, ce qui les sépare visuellement dans le tableau de bord.

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
`scalingo-watcher`, un jour après la release, jamais fusionnée seule. Les
workflows appelants sont épinglés par sha avec la version en commentaire.

**[fait]** Le consommateur n'active que `custom.regex`, `github-actions` et
`renovate-config`. Le fuseau, le planning, le tableau de bord et ses textes
restent dans sa configuration : les presets ne portent que ce qui dépend de
l'outil.

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

**[fait]** Deux contrôles de cohérence des références avant tout déploiement. Le
premier vérifie que le commit épinglé appartient à la branche que le manifeste
déclare suivre. Le second, plus important, vérifie que le commit **actuellement
déployé** appartient lui aussi à cette branche : si ce n'est pas le cas, ou bien
la branche du manifeste est fausse, ou bien on s'apprête à changer l'application
de branche, et les deux mettent en jeu ce que la branche d'origine apportait.
Une application peut tourner sur une branche dont le `.buildpacks` ajoute un
oauth2-proxy devant Metabase : la redéployer depuis `master` exposerait
l'instance sans authentification, sans que le statut du déploiement le signale.
Rien n'est tenté dans ce cas.

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
méthode et un chemin. Une clé qui fuite permet de lire, de poser une variable de
version, de déployer, de sauvegarder une base et de la monter d'une version :
aucun `DELETE`, aucune création d'application, aucun changement de stack, aucun
scale, aucun redémarrage.

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
conserver d'identifiants dans le clone. Côté consommateur, l'épinglage par sha,
la décantation d'un jour et l'absence de fusion automatique des mises à jour
de l'outil limitent l'effet d'un tag malveillant, qui s'exécuterait avec les
secrets d'accès à Scalingo.

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

**[fait]** Les tests ont été vérifiés en cassant volontairement chacun des
invariants, pour s'assurer qu'ils échouent quand ils le doivent.

**[fait]** La CI lance aussi le typecheck et un plan complet sur le parc de test,
sans aucun secret. Node exécute le TypeScript en retirant les annotations sans
les vérifier : sans typecheck, une lecture de champ inexistant n'apparaît qu'à
l'exécution.

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

**Aucune sonde HTTP après déploiement.** La vérification s'arrête au statut du
déploiement. Interroger l'application elle-même ne fonctionnerait pas partout :
une instance derrière un oauth2-proxy bloquerait la sonde.

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
information non dérivable : elle vit dans la table d'amonts du moteur, dans
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
sous son nom, les bases, les buildpacks. Chacun donne la version en service, ce
qui est disponible en amont, et l'état. Les versions lient vers leur annonce :
les releases GitHub du dépôt amont de l'outil, le changelog Scalingo pour les
bases, avec son ancre par version.

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
comme constatée. C'est le cas d'une application en pause, dont la base n'est pas
interrogée : afficher la cible du manifeste sans le dire la ferait passer pour un
constat.

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
l'application, la validation et la proposition des montées de base. Le dépôt
consommateur ne déclare que les déclencheurs, le cron, les permissions et le
mappage des secrets. Les chemins des fichiers du parc, le label et le titre du
tableau de bord, les messages de commit et la branche de proposition sont des
inputs.

**[fait]** Le job appelé récupère le dépôt consommateur, puis l'outil au sha du
workflow appelé, et installe Node et pnpm aux versions déclarées par l'outil
(action `setup`). Le dépôt consommateur n'a ni `package.json` ni `.nvmrc`.

**[fait]** Actions composites dans `actions/` : `setup`, `signaler` (tableau de
bord et notification), `commit-lock` (push du lock rejoué).

**[fait]** Chemins des fichiers du parc en options (`--manifest`, `--lock`,
`--fgp`), relatifs au répertoire courant. Le schéma est lu à côté du moteur, quel
que soit le répertoire courant.

**[fait]** Sorties d'un passage dans `--out-dir`, par défaut
`$RUNNER_TEMP/scalingo-watcher` en CI et le répertoire temporaire du système en
local, plus rien dans le dépôt : un fichier produit à côté du lock finit tôt ou
tard commité avec lui.

**[fait]** Deux modes d'accès à Scalingo, en local comme dans les workflows :
`SCALINGO_API_TOKEN` en direct, ou `FGP_KEY` et `fgp.json`. L'adresse du proxy
est lue dans `fgp.json`. `fgp-blobs` vise le proxy choisi par `--url` et affiche
la commande `gh secret set` pour le dépôt courant.

**[fait]** Presets Renovate versionnés avec l'outil : `base`, `metabase` et
`watcher`, étendus par tag par le consommateur.

**[fait]** Dossier `template/`, contenu du dépôt starter : manifeste d'exemple
fictif, `renovate.json`, workflows appelants, et checklist d'installation.

**[fait]** Releases par release-please sur les commits conventionnels : pull
request de release tenue à jour, tag `vX.Y.Z` et release GitHub à la fusion,
tag majeur `vX` déplacé sur le même commit.

**[fait]** Licence MIT et `publiccode.yml` pour les catalogues de logiciels
publics.

**[fait]** Identifiants de code en anglais, messages affichés, commentaires et
documentation en français.

**[à faire]** Publication : dépôt public de l'outil, ruleset de tags, première
release `v1.0.0`, dépôt starter créé depuis `template/`.

**[à faire]** Valider, au premier consommateur hors de l'organisation de
l'outil, qu'un job appelé qui déclare `environment:` lit bien les secrets de cet
environment dans le dépôt appelant.

**[à faire]** Outils autres que Metabase de bout en bout. Le moteur les prend en
charge, mais seul Metabase a un preset de versioning, et la table d'amonts se
limite aux dépôts vérifiés.
