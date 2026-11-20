# scalingo-watcher

Maintient à jour des applications Scalingo déployées à partir d'un buildpack
outil (Metabase, Grafana, nginx, etc.), sans intervention manuelle sur chaque
instance.

Le parc est décrit dans un manifeste versionné. Renovate surveille les nouvelles
versions de l'outil et les commits des dépôts applicatifs, et propose les mises
à jour du manifeste en pull request. Une réconciliation périodique relève l'état
réel du parc, signale ce qui a bougé hors du manifeste, puis fait converger
chaque application, une sauvegarde de ses bases précédant chaque déploiement. Ce
qui a réellement été déployé est consigné dans un lock commité à côté du
manifeste.

Elle confronte au passage les versions en service aux avis de sécurité de leur
dépôt amont et à la fin de support de leur ligne de versions, pour qu'un parc soit
prévenu avant que sa ligne cesse de recevoir des correctifs et quand une nouvelle
ligne de support long est désignée.

Le périmètre éprouvé est Metabase. Le moteur prend en charge tout outil dont le
buildpack lit sa version dans une variable d'environnement, et ce qu'il sait de
chacun tient dans un module (voir [Ajouter un outil](#ajouter-un-outil)).

La liste complète des comportements est dans [FEATURES.md](FEATURES.md).

## Distribution

| Dépôt | Contenu |
|---|---|
| `incubateur-ademe/scalingo-watcher` (ce dépôt) | Moteur, actions composites, presets Renovate, schéma du manifeste |
| [`incubateur-ademe/scalingo-parc-template`](https://github.com/incubateur-ademe/scalingo-parc-template) | Squelette d'un dépôt consommateur, tenu à jour par Renovate comme un parc |
| Dépôt consommateur | `manifest.yaml`, `lock.json`, `fgp.json`, `renovate.json` et les workflows appelants |

Un dépôt consommateur ne contient que les données de son parc. Ses workflows
appellent les actions de l'outil à une version épinglée par sha, et Renovate
fait avancer cette version.

## Démarrer un parc

Créer un dépôt depuis le [template](https://github.com/incubateur-ademe/scalingo-parc-template) et suivre la checklist de son
[README](https://github.com/incubateur-ademe/scalingo-parc-template#readme) : choix de l'accès à Scalingo, génération du
manifeste depuis l'état réel, amorçage du lock, environment et secrets, Renovate,
premier plan, activation du cron.

## Commandes

Le moteur s'exécute avec Node, sans étape de build. Les chemins relatifs partent
du répertoire courant, qui est la racine du dépôt consommateur :

```bash
node <outil>/src/audit.ts                # etat reel du parc, lecture seule
node <outil>/src/apply.ts --dry-run      # plan : ecart entre le manifeste et le lock
node <outil>/src/apply.ts                # applique, deploie, met a jour le lock
```

Dans ce dépôt, les mêmes commandes existent en scripts `pnpm`, exécutés depuis
la racine de l'outil :

| Script | Commande | Effet |
|---|---|---|
| `audit` | `src/audit.ts` | État réel du parc, lecture seule |
| `plan` | `src/apply.ts --dry-run` | Écart entre le manifeste et le lock, aucune écriture |
| `apply` | `src/apply.ts` | Applique, déploie, met à jour le lock |
| `reconcile` | `src/apply.ts --reconcile` | Relève l'état réel, signale les dérives, puis converge |
| `prune` | `src/apply.ts --prune` | Retire du lock les apps sorties du manifeste |
| `validate` | `src/apply.ts --validate` | Schéma, annotations Renovate et lock orphelin |
| `propose-db` | `src/apply.ts --propose-db` | Avance d'un cran les bases pilotées, dans le manifeste |
| `propose-security` | `src/apply.ts --propose-security` | Monte les versions que les avis de l'amont couvrent, dans le manifeste |
| `init` | `src/init.ts` | Écrit un premier manifeste depuis l'état réel |
| `fgp:blobs` | `src/fgp-blobs.ts` | Génère `fgp.json` pour le proxy FGP |
| `notifiers` | `src/notifiers.ts` | Pose les notifiers Scalingo qui appellent le relais |
| `test` | `test/test.ts`, `test/relay.test.ts`, `test/notifiers.test.ts` | Tests hors ligne |
| `typecheck` | `tsc --noEmit` | Vérification des types |

`pnpm init`, `pnpm audit` et `pnpm prune` sont des commandes de pnpm, qui
passent avant les scripts du même nom. Ces trois scripts se lancent par
`pnpm run init`, `pnpm run audit` et `pnpm run prune`.

### Options

Communes à toutes les commandes :

| Option | Défaut |
|---|---|
| `--manifest <chemin>` | `manifest.yaml` |
| `--lock <chemin>` | `lock.json` |
| `--fgp <chemin>` | `fgp.json` |
| `--out-dir <chemin>` | `$RUNNER_TEMP/scalingo-watcher` si `RUNNER_TEMP` existe, sinon un répertoire privé `scalingo-watcher-XXXXXX` du répertoire temporaire du système, nouveau à chaque passage et affiché à sa création. Créé au besoin. |

`--out-dir` reçoit les sorties d'un passage, jamais commitées : `incident.md`
(état du parc lu par l'action `signaler`), `db-proposal.json`,
`security-proposal.json`, `pr-title.txt` et `pr-body.md` (écrits par
`--propose-db` ou `--propose-security` seulement quand ils modifient le
manifeste), et la copie `fgp.json.bak` faite par `fgp-blobs`.

Les deux propositions écrivent `pr-title.txt` et `pr-body.md` au même endroit et
poussent sur deux branches distinctes : un passage ne peut pas porter les deux.

Par commande :

- `apply.ts` : `--dry-run`, `--app <fragment>`, `--force` (redéploie une app
  conforme, exige `--app`), `--reconcile`, `--prune`, `--validate`, `--adopt`
  (amorce le lock depuis l'état réel, sans déployer), `--propose-db`,
  `--propose-security`, `--async` (un passage puis rend la main, l'état en vol
  dans le lock), `--resume` (fait avancer le déploiement en cours sans en ouvrir).
- `notifiers.ts` : `--dry-run`, `--app <fragment>`, `--remove`. Lit
  `SCALINGO_API_TOKEN` et `RELAY_URL` dans l'environnement.
- `audit.ts` : `--app <fragment>`, `--region <nom>` (répétable, prime sur les
  régions du manifeste), `--json` (inventaire complet sur la sortie standard),
  `--no-build-log`.
- `init.ts` : `--region <nom>` (obligatoire, répétable), `--app <fragment>`,
  `--force` (écrase un manifeste existant).
- `fgp-blobs.ts` : `--dry-run`, `--url <adresse du proxy>`, `--no-logs`.

### Accès à Scalingo

Deux modes, au choix :

- `SCALINGO_API_TOKEN` : accès direct, avec tout le pouvoir du compte. Le jeton
  se crée depuis le dashboard Scalingo, profil puis « Tokens API ».
- `FGP_KEY` et le fichier de `--fgp` : accès par un proxy fine-grained qui borne
  chaque appel à une méthode et un chemin. L'adresse du proxy est lue dans le
  champ `url` de `fgp.json`, `https://fgp.incubateur.ademe.fr` par défaut. Le
  détail est dans [fgp.md](fgp.md).

Le proxy l'emporte quand `FGP_KEY` et `fgp.json` sont présents. `--dry-run`,
`--validate`, `--prune` et `--propose-security` fonctionnent sans aucun accès :
ce dernier rend son verdict avec les avis de l'amont et le manifeste.

`GITHUB_TOKEN`, facultatif, évite la limitation de débit de l'API GitHub.

## Actions

Cinq actions composites, appelées dans un pas d'un job du parc. Une composite ne
peut déclarer ni runner, ni environment, ni permissions, ni groupe de
concurrence : le job du parc les porte. Chaque action récupère elle-même le
dépôt du parc, copie l'outil en `.scalingo-watcher/` dans le workspace et
installe Node et pnpm aux versions de l'outil.

| Action | Rôle | Le job déclare |
|---|---|---|
| `actions/reconcile` | Relève, converge, consigne le lock, tient le tableau de bord | l'environment, `contents: write`, `issues: write`, le groupe `scalingo-apply` |
| `actions/apply` | Application à la demande, en plan seul par défaut | l'environment, `contents: write`, `issues: write`, le groupe `scalingo-apply` |
| `actions/validate` | Valide le manifeste, contrôle les appels de l'outil, publie le plan en commentaire de pull request | `contents: read`, `pull-requests: write` |
| `actions/propose-db` | Ouvre la pull request de montée de version des bases | l'environment, `contents: write`, `pull-requests: write`, un groupe propre |
| `actions/propose-security` | Ouvre la pull request de montée des versions couvertes par un avis amont | `contents: write`, `pull-requests: write`, un groupe propre |

Inputs :

| Input | Actions | Défaut |
|---|---|---|
| `dry-run` | `reconcile`, `apply` | requis pour `reconcile`, `"true"` pour `apply` |
| `fgp-key`, `scalingo-api-token` | `reconcile`, `apply`, `propose-db` | requis |
| `push-token` | toutes sauf `validate` | requis |
| `teams-webhook`, `slack-webhook`, `matrix-access-token` | `reconcile`, `apply` | requis |
| `heartbeat-url` | `reconcile` | requis (voir [Veille de silence](#veille-de-silence)) |
| `async`, `resume` | `reconcile`, `apply` | `"false"`, `"false"` (voir [Relais et notifiers](FEATURES.md#relais-et-notifiers)) |
| `matrix-homeserver`, `matrix-room-id` | `reconcile`, `apply` | `""` (notification Matrix désactivée) |
| `manifest-path`, `lock-path` | toutes | `manifest.yaml`, `lock.json` |
| `fgp-path` | toutes sauf `propose-security` | `fgp.json` |
| `app`, `force` | `apply` | `""`, `"false"` |
| `dashboard-label`, `dashboard-title` | `reconcile`, `apply` | `etat-parc`, `Parc Scalingo : etat de la convergence` |
| `lock-commit-message` | `reconcile`, `apply` | `chore(lock): etat du parc apres reconciliation` (ou `apres deploiement`) |
| `branch`, `commit-message` | `propose-db` | `montee-base`, `chore(base): proposer la montee de version des bases` |
| `branch`, `commit-message` | `propose-security` | `montee-securite`, `fix(securite): monter les versions couvertes par un avis amont` |
| `comment` | `validate` | `"true"` ; `"false"` publie le plan dans le seul résumé du job |
| `checkout` | toutes | `"true"` ; `"false"` quand le job a déjà récupéré le dépôt, à la tête de `github.ref`, avec un jeton qui peut pousser, `push-token` ne servant plus alors qu'aux pull requests des propositions |

Un input est une chaîne : `"true"` et `"false"` s'écrivent entre guillemets ou
sortent d'une expression. GitHub ne vérifie pas les inputs d'une action. Un
input inconnu ne donne qu'un avertissement, un input requis absent arrive vide.
Un input requis s'écrit donc toujours, même quand le secret qu'il porte est
vide. `dry-run` n'a pas de défaut pour `reconcile` : une clé mal orthographiée
arrête le passage au lieu de déployer.
Vides, `async` et `resume` valent `"false"`, ce qui couvre un cron ou un push
sans inputs.

Le job lit les secrets de l'environment qu'il déclare et les passe en inputs.
Les secrets d'accès et `PUSH_TOKEN` ont leur place dans l'environment, réservé à
`main` par sa politique de branches. `push-token` vide, l'action prend le
`GITHUB_TOKEN` du job.

**Le verrou de la convergence est déclaré par le parc.** Les jobs qui appellent
`reconcile` et `apply` déclarent le groupe `scalingo-apply` avec
`cancel-in-progress: false` et `queue: max`, au niveau du job. C'est la seule
garde contre deux convergences en parallèle, et le nom doit rester exactement
celui-ci. Sans `queue: max`, GitHub ne garde qu'un passage en attente par groupe
et annule le précédent, si bien qu'une reprise lancée par le relais annulerait
un passage ordinaire. Le même
groupe déclaré aussi au niveau du workflow fait annuler le run par GitHub pour
interblocage. Un `cancel-in-progress` autre que `false`, à l'un ou l'autre
niveau et quel que soit le groupe, peut annuler un passage en cours. Chaque
proposition a son propre groupe : deux propositions en parallèle se
disputeraient la même branche. `validate` refuse en pull request un workflow du
parc qui manque à ces règles ou aux inputs requis.

**Runner.** L'action tourne sur le runner du job, quelle que soit l'organisation
de l'outil : un parc peut utiliser ses runners auto-hébergés. Il faut `bash`,
`git`, `tar` et `gh`. Les runners hébergés par GitHub ont tout. L'image
`ghcr.io/actions/actions-runner` n'a pas `gh`, et les actions qui s'en servent
échouent alors avec un message explicite. Après l'action, ne pas supprimer
`.scalingo-watcher/` dans le même job, par un checkout qui nettoie le workspace
par exemple : le runner y relit les sous-actions en fin de job pour leurs pas
de clôture.

Appelant minimal :

```yaml
name: reconcilier le parc
on:
  schedule:
    - cron: "17 * * * *"
  push:
    branches: [main]
    paths: [manifest.yaml]
  workflow_dispatch:
    inputs:
      dry_run:
        type: boolean
        default: false
permissions:
  contents: write
  issues: write
jobs:
  reconcile:
    runs-on: ubuntu-latest
    environment: production
    concurrency:
      group: scalingo-apply
      cancel-in-progress: false
      queue: max
    steps:
      - uses: incubateur-ademe/scalingo-watcher/actions/reconcile@<sha> # v2.0.0
        with:
          # Le cron et le push n'ont pas d'inputs : la comparaison ramene leur
          # valeur absente a "false".
          dry-run: ${{ inputs.dry_run == true }}
          fgp-key: ${{ secrets.FGP_KEY }}
          scalingo-api-token: ${{ secrets.SCALINGO_API_TOKEN }}
          push-token: ${{ secrets.PUSH_TOKEN }}
          teams-webhook: ${{ secrets.TEAMS_WEBHOOK }}
          slack-webhook: ${{ secrets.SLACK_WEBHOOK }}
          matrix-access-token: ${{ secrets.MATRIX_ACCESS_TOKEN }}
          heartbeat-url: ${{ secrets.HEARTBEAT_URL }}
```

Les appelants complets sont dans le [template](https://github.com/incubateur-ademe/scalingo-parc-template/tree/main/.github/workflows).

### Veille de silence

Les notifications partent du job de réconciliation. Un job qui ne démarre plus,
pour un refus de facturation ou un cron arrêté, ne prévient donc personne.
Après chaque passage planifié dont le tableau de bord a été publié, `reconcile`
envoie un GET à chaque URL de `heartbeat-url`. Un lancement à la main ou une
relance ne bat pas. Un service de veille extérieur à GitHub alerte quand ces
battements cessent. Aucune donnée du parc ne part avec.

Mise en place de référence, un check par parc :

1. Créer un check pulse [updown.io](https://updown.io/doc/how-pulse-cron-monitoring-works)
   avec une période de 24 heures. Sur un mois de mesure, les déclenchements du
   cron se sont espacés de 11 heures au plus.
2. Ranger son URL dans le secret `HEARTBEAT_URL` de l'environment. L'appelant
   de `reconcile` la passe en input `heartbeat-url`. Aucune version 1.x ne
   porte le battement.
3. Déclarer deux destinataires indépendants chez le service, une adresse
   partagée et un salon. Un workflow Teams sans co-propriétaire ou un bot Tchap
   non renouvelé cessent d'envoyer sans prévenir.

Tout service qui alerte sur l'absence d'un GET convient. Plusieurs URL séparées
par des blancs battent chacune, pour doubler le service. Sans URL, le résumé du
run le dit.

### Migrer depuis les workflows réutilisables (v1)

La v2 retire les workflows réutilisables. Renovate propose la montée dans une
pull request majeure qui ne change que le sha : elle ne transforme pas un appel
de workflow en appel d'action, et casserait les appelants une fois fusionnée
telle quelle. La migration se fait à la main, tous les appelants du parc dans la
même pull request et au même sha.

Pour chaque appelant :

1. Le job perd `uses:`, `with:` et `secrets:`. Il gagne `runs-on`,
   `environment` (l'ancien input du même nom), un groupe de concurrence et un pas
   `uses: incubateur-ademe/scalingo-watcher/actions/<nom>@<sha> # v2.x.y`. Le
   groupe vaut `scalingo-apply` pour `reconcile` et `apply`, avec
   `cancel-in-progress: false` et `queue: max`,
   `scalingo-watcher-propose-db` et `scalingo-watcher-propose-security` pour les
   propositions : ce sont ceux que posait l'outil.
2. Chaque secret mappé devient un input sous `with:` : `FGP_KEY` devient
   `fgp-key`, `SCALINGO_API_TOKEN` devient `scalingo-api-token`, `PUSH_TOKEN`
   devient `push-token`, `TEAMS_WEBHOOK` devient `teams-webhook`, `SLACK_WEBHOOK`
   devient `slack-webhook`, `MATRIX_ACCESS_TOKEN` devient `matrix-access-token`,
   `HEARTBEAT_URL` devient `heartbeat-url`.
3. `dry_run` devient `dry-run`, une chaîne. Depuis un input booléen de
   `workflow_dispatch`, `${{ inputs.dry_run == true }}` donne `"true"` ou
   `"false"`.
4. Les autres inputs gardent leur nom. Un parc qui utilise le relais garde
   l'input `resume` de son `workflow_dispatch` et le passe en
   `resume: ${{ inputs.resume == true }}`.

La pull request de migration fait tourner la `validate` de la v2, qui contrôle
les autres appelants.

### Sous-actions internes

- [`actions/setup`](actions/setup/action.yml) : installe pnpm et Node aux
  versions de l'outil (`package.json` et `.nvmrc`), puis ses dépendances.
- [`actions/signaler`](actions/signaler/action.yml) : tient une issue
  permanente qui décrit l'état de la convergence, et prévient aux seuls
  changements d'état les canaux configurés : Teams, webhook au format Slack
  (Slack, Mattermost, Rocket.Chat, Tchap via
  [slack2tchap](https://github.com/betagouv/slack2tchap)), Matrix en direct
  (Tchap compris).
- [`actions/commit-lock`](actions/commit-lock/action.yml) : commite le lock
  s'il a changé, le rejoue par-dessus ce qui a été poussé entre-temps, trois
  tentatives, puis échoue explicitement.

## Presets Renovate

| Preset | Contenu |
|---|---|
| [`renovate/base`](renovate/base.json) | Lecture du manifeste par deux customManagers (commit du dépôt applicatif, version de l'outil et `defaults.policy`), aucune montée pour une application en pause, délai de cinq jours, dépôts applicatifs toujours en PR, alertes de vulnérabilité, messages de commit |
| [`renovate/metabase`](renovate/metabase.json) | Module Renovate de Metabase : versioning (lignes OSS et Enterprise séparées), ligne suivie, et politique commune étendue pour `metabase/metabase` |
| [`renovate/politique`](renovate/politique.json) | Politique de fusion selon `defaults.policy`, commune à tous les outils : sans politique, correctifs fusionnés seuls et montées fonctionnelles en PR, jamais une rupture. Étendue par chaque preset d'outil, jamais par le parc |
| [`renovate/watcher`](renovate/watcher.json) | Mises à jour de l'outil : actions épinglées par sha, presets, versions citées par la documentation et le `$schema` du manifeste, une PR groupée, proposée dès la release, jamais fusionnée seule |

Le consommateur les étend, épinglés par tag, et active les managers qui les
lisent :

```json
{
  "extends": [
    "config:recommended",
    "github>incubateur-ademe/scalingo-watcher//renovate/base#v1.0.0",
    "github>incubateur-ademe/scalingo-watcher//renovate/metabase#v1.0.0",
    "github>incubateur-ademe/scalingo-watcher//renovate/watcher#v1.0.0"
  ],
  "enabledManagers": ["custom.regex", "github-actions", "renovate-config"],
  "timezone": "Europe/Paris"
}
```

Le preset `base` porte le titre et les textes du tableau de bord Renovate, ainsi
que la plage de fusion automatique des correctifs (entre 2h et 6h). Ils décrivent
ce que fait l'outil et avancent avec son tag. Un parc qui les redéclare dans son
`renovate.json` les remplace en entier et ne reçoit plus leurs mises à jour. Le
fuseau reste dans la configuration du consommateur, et la plage se lit dans ce
fuseau.

Renovate retrouve son issue de tableau de bord par son titre. Un parc dont
l'issue porte encore le titre par défaut, `Dependency Dashboard`, la renomme en
`Parc Scalingo : etat des versions` avant de fusionner la montée du preset.
Sinon Renovate en ouvre une nouvelle et laisse l'ancienne ouverte, figée.

Le preset d'un outil étend `politique` par une référence relative, qui hérite de
son tag : elle demande Renovate 44.29.0 ou plus récent, ce que l'application
Mend hébergée fait tourner.

## Ajouter un outil

Ce que le moteur sait d'un outil vit dans un module, un fichier par outil sous
[`src/tools`](src/tools) : sa variable de version, son nom, le dépôt qui publie
ses releases, ce qui forme une ligne de versions, son nom chez endoflife.date
et son preset Renovate. `init` reconnaît une application à cette
variable, l'audit et le rapport en tirent l'amont.

1. Créer `src/tools/<outil>.ts` sur le modèle de
   [`metabase.ts`](src/tools/metabase.ts), et l'ajouter à `TOOLS` dans
   [`src/tools/index.ts`](src/tools/index.ts). N'y porter que des rapprochements
   vérifiés : un mauvais dépôt donnerait un « à jour » faux.
2. Pour que Renovate applique `defaults.policy` à ses versions, créer
   `renovate/<outil>.json`. Il étend `./politique(<dépôt>)` et pose le versioning
   qui ramène la numérotation de l'outil au contrat de la politique : `patch`
   est un correctif, `minor` une montée fonctionnelle, `major` une rupture. Un
   outil en semver strict n'a besoin d'aucun versioning sur mesure. Le module le
   nomme dans `renovatePreset`, et les parcs qui le déploient ajoutent ce preset
   à leurs `extends`.
3. Sans preset, Renovate suit les versions de l'outil mais ne fusionne jamais
   seul : la politique ne vaut que pour un versioning vérifié.

Les tests vérifient que chaque preset d'outil étend la politique avec le dépôt
de son module, qu'il ne pose aucun automerge lui-même, et qu'un outil sans
preset n'est jamais fusionné seul.

## Les fichiers d'un parc

`manifest.yaml` est la seule chose qu'on édite, à la main ou via Renovate. Il dit
quelle version doit tourner où, depuis quel dépôt applicatif. Son schéma est
[`schema/manifest.schema.json`](schema/manifest.schema.json), avec le détail de
chaque champ ; un manifeste le désigne par l'URL taguée de la version de l'outil,
que Renovate fait avancer avec elle. Un champ renommé reste accepté sous son ancien nom, avec un
avertissement.

Les commentaires `# renovate:` du manifeste sont fonctionnels : ils portent la
source des versions que lisent les customManagers. Les supprimer coupe la veille.

`lock.json` est généré, ne l'édite jamais à la main. Il consigne ce qui est
réellement déployé, les buildpacks effectivement utilisés, la dernière
sauvegarde et les mises en quarantaine. Son format est versionné : un moteur
refuse un lock d'une version plus récente que la sienne.

Quatre commandes l'écrivent. `--adopt` l'amorce depuis l'état réel du parc, une
fois. `apply` le met à jour après chaque déploiement confirmé. `--reconcile` le
remet en accord avec le parc et signale au passage ce qui a bougé hors du
watcher. `--prune` retire les entrées des apps sorties du manifeste.

`fgp.json` liste les blobs du proxy. Ils ne sont exploitables qu'avec la clé, ce
qui permet de les versionner.

## Trois points à connaître avant de s'en servir

**L'ordre des applications dans le manifeste est l'ordre de déploiement.** La
première sert d'éclaireur : si son déploiement échoue, la vague s'arrête. Range
de la moins critique à la plus critique. Une opération simplement interrompue ne
dit rien de la cible : l'application suivante reprend le rôle, et la vague ne
s'arrête qu'après deux éclaireurs interrompus.

**Une montée de version migre la base applicative.** Revenir en arrière ne se
fait pas en redéployant l'ancienne version, il faut restaurer la sauvegarde.
C'est pour ça que `backup: required` est le défaut, que l'apply refuse de
déployer si la sauvegarde échoue, et qu'il refuse aussi une cible antérieure à
la version que porte l'application : sans ce contrôle, un manifeste en retard
sur le réel redescendrait l'application sur une base déjà migrée, que l'ancien
binaire ne sait pas démarrer.

**Un déploiement conclu réussi ne dit pas que l'outil tourne.** Scalingo conclut
dès que le conteneur répond sur son port, et un outil qui migre sa base au
démarrage le fait après. L'apply relit donc l'application pendant une fenêtre
de garde, 120 secondes par défaut, puis exige que chacun de ses conteneurs soit
`running`, et met en quarantaine si elle redémarre en erreur. `settle: {window:
<secondes>}`, par application ou dans `defaults`, ajuste la fenêtre. En accès par
proxy, il faut régénérer `fgp.json` : la fenêtre lit les routes `events` et `ps`.

## Développement

```bash
pnpm install
pnpm typecheck
pnpm test
```

Node 26, épinglée dans `.nvmrc`, déclarée en minimum dans `package.json` et
reprise par `tsconfig.json` via `@tsconfig/node26`. Node exécute le TypeScript
directement, sans étape de build. La 26 passe LTS le 28 octobre 2026, la 24
entre en maintenance le 20 octobre 2026.

Les tests tournent hors ligne sur le parc fictif de `test/fixtures/`. La CI
([`ci.yml`](.github/workflows/ci.yml)) lance le typecheck, les tests, la
validation des presets de `renovate/` par `renovate-config-validator` et un plan
sur ce parc, sans aucun secret. Un second job y exécute `validate`, `apply` et
`reconcile` en plan, comme un parc les appelle.

Les releases suivent les commits conventionnels (`feat:`, `fix:`, etc.).
[`release.yml`](.github/workflows/release.yml) tient à jour une pull request
de release par release-please. Sa fusion crée le tag `vX.Y.Z` et la release
GitHub, puis déplace le tag majeur `vX` sur le même commit. Le secret
facultatif `RELEASE_TOKEN` ouvre cette pull request avec un jeton qui déclenche
la CI.

Le template est un dépôt à part, seule source de son contenu. Renovate le
tient à jour comme un parc : une pull request par release, dès sa publication,
dont la validation tourne avec la nouvelle version. La CI de
l'outil récupère le template et vérifie que chacun de ses appels est conforme à
la version qu'il épingle : inputs connus, inputs requis passés, groupe
`scalingo-apply` déclaré. Ce qu'une version en cours change est signalé en
avertissement, à reporter dans le template une fois la release publiée.

## Licence

[MIT](LICENSE).
