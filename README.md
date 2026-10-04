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

Le périmètre éprouvé est Metabase. Le moteur prend en charge tout outil dont le
buildpack lit sa version dans une variable d'environnement.

La liste complète des comportements est dans [FEATURES.md](FEATURES.md).

## Distribution

| Dépôt | Contenu |
|---|---|
| `incubateur-ademe/scalingo-watcher` (ce dépôt) | Moteur, workflows réutilisables, actions composites, presets Renovate, schéma du manifeste |
| `incubateur-ademe/scalingo-parc-template` | Squelette d'un dépôt consommateur, issu du dossier [`template/`](template/) |
| Dépôt consommateur | `manifest.yaml`, `lock.json`, `fgp.json`, `renovate.json` et les workflows appelants |

Un dépôt consommateur ne contient que les données de son parc. Ses workflows
appellent ceux de l'outil à une version épinglée par sha, et Renovate fait
avancer cette version.

## Démarrer un parc

Créer un dépôt depuis le template et suivre la checklist de son
[README](template/README.md) : choix de l'accès à Scalingo, génération du
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
| `init` | `src/init.ts` | Écrit un premier manifeste depuis l'état réel |
| `fgp:blobs` | `src/fgp-blobs.ts` | Génère `fgp.json` pour le proxy FGP |
| `test` | `test/test.ts` | Tests hors ligne |
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
| `--out-dir <chemin>` | `$RUNNER_TEMP/scalingo-watcher` si `RUNNER_TEMP` existe, sinon `scalingo-watcher` dans le répertoire temporaire du système. Créé au besoin. |

`--out-dir` reçoit les sorties d'un passage, jamais commitées : `incident.md`
(état du parc lu par l'action `signaler`), `db-proposal.json`, `pr-title.txt` et
`pr-body.md` (écrits par `--propose-db` seulement quand il modifie le
manifeste), et la copie `fgp.json.bak` faite par `fgp-blobs`.

Par commande :

- `apply.ts` : `--dry-run`, `--app <fragment>`, `--force` (redéploie une app
  conforme, exige `--app`), `--reconcile`, `--prune`, `--validate`, `--adopt`
  (amorce le lock depuis l'état réel, sans déployer), `--propose-db`.
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
`--validate` et `--prune` fonctionnent sans aucun accès.

`GITHUB_TOKEN`, facultatif, évite la limitation de débit de l'API GitHub.

## Workflows réutilisables

Déclarés en `on: workflow_call` dans `.github/workflows/`. Le déclencheur, le
cron et les permissions sont déclarés par le workflow appelant. Le job appelé
récupère le dépôt appelant, puis l'outil à `job.workflow_sha` dans
`.scalingo-watcher/`, et installe Node et pnpm aux versions de l'outil par
l'action `setup`.

| Workflow | Rôle | Permissions de l'appelant |
|---|---|---|
| `reconcile.yml` | Relève, converge, consigne le lock, tient le tableau de bord | `contents: write`, `issues: write` |
| `apply.yml` | Application à la demande, en plan seul par défaut | `contents: write`, `issues: write` |
| `validate.yml` | Valide le manifeste, publie le plan en commentaire de pull request | `contents: read`, `pull-requests: write` |
| `propose-db.yml` | Ouvre la pull request de montée de version des bases | `contents: write`, `pull-requests: write` |

Inputs :

| Input | Workflows | Défaut |
|---|---|---|
| `environment` | `reconcile`, `apply`, `propose-db` | requis |
| `manifest-path`, `lock-path`, `fgp-path` | tous | `manifest.yaml`, `lock.json`, `fgp.json` |
| `dry_run` | `reconcile`, `apply` | `false` pour `reconcile`, `true` pour `apply` |
| `app`, `force` | `apply` | `""`, `false` |
| `dashboard-label`, `dashboard-title` | `reconcile`, `apply` | `etat-parc`, `Parc Scalingo : etat de la convergence` |
| `matrix-homeserver`, `matrix-room-id` | `reconcile`, `apply` | `""` (notification Matrix désactivée) |
| `lock-commit-message` | `reconcile`, `apply` | `chore(lock): etat du parc apres reconciliation` (ou `apres deploiement`) |
| `branch`, `commit-message` | `propose-db` | `montee-base`, `chore(base): proposer la montee de version des bases` |

Secrets, tous facultatifs : `SCALINGO_API_TOKEN` ou `FGP_KEY` pour l'accès,
`TEAMS_WEBHOOK`, `SLACK_WEBHOOK` et `MATRIX_ACCESS_TOKEN` pour les
notifications, `PUSH_TOKEN` pour pousser le lock
et ouvrir les pull requests sur une branche protégée. `secrets: inherit` ne
fonctionne pas entre organisations : l'appelant mappe ses secrets de dépôt. Les
secrets de l'environment passé en input sont lus directement par le job appelé,
et l'emportent sur un secret mappé. Les secrets d'accès et `PUSH_TOKEN` ont leur
place dans l'environment, réservé à `main` par sa politique de branches.

`reconcile` et `apply` partagent le groupe de concurrence
`scalingo-apply` et n'annulent jamais un passage en cours. `propose-db`
a son propre groupe.

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
permissions:
  contents: write
  issues: write
jobs:
  reconcile:
    uses: incubateur-ademe/scalingo-watcher/.github/workflows/reconcile.yml@<sha> # v1.0.0
    with:
      environment: production
```

Les quatre appelants complets sont dans [`template/.github/workflows/`](template/.github/workflows/).

## Actions composites

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
| [`renovate/base`](renovate/base.json) | Lecture du manifeste par deux customManagers (commit du dépôt applicatif, version de l'outil), délai de cinq jours, dépôts applicatifs toujours en PR, alertes de vulnérabilité, messages de commit |
| [`renovate/metabase`](renovate/metabase.json) | Versioning Metabase (lignes OSS et Enterprise séparées), correctifs fusionnés seuls, montées fonctionnelles en PR |
| [`renovate/watcher`](renovate/watcher.json) | Mises à jour de l'outil : workflows épinglés par sha, une PR groupée, sept jours de délai, jamais fusionnée seule |

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

Le fuseau, le planning et les textes du tableau de bord restent dans la
configuration du consommateur.

## Les fichiers d'un parc

`manifest.yaml` est la seule chose qu'on édite, à la main ou via Renovate. Il dit
quelle version doit tourner où, depuis quel dépôt applicatif. Son schéma est
[`schema/manifest.schema.json`](schema/manifest.schema.json), avec le détail de
chaque champ ; un manifeste le désigne par l'URL taguée de la version qui l'a
généré. Un champ renommé reste accepté sous son ancien nom, avec un
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

## Deux points à connaître avant de s'en servir

**L'ordre des applications dans le manifeste est l'ordre de déploiement.** La
première sert d'éclaireur : si son déploiement échoue, la vague s'arrête. Range
de la moins critique à la plus critique. Une opération simplement interrompue ne
dit rien de la cible : l'application suivante reprend le rôle, et la vague ne
s'arrête qu'après deux éclaireurs interrompus.

**Une montée de version migre la base applicative.** Revenir en arrière ne se
fait pas en redéployant l'ancienne version, il faut restaurer la sauvegarde.
C'est pour ça que `backup: required` est le défaut et que l'apply refuse de
déployer si la sauvegarde échoue.

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
([`ci.yml`](.github/workflows/ci.yml)) lance le typecheck, les tests et un plan
sur ce parc, sans aucun secret.

Les releases suivent les commits conventionnels (`feat:`, `fix:`, etc.).
[`release.yml`](.github/workflows/release.yml) tient à jour une pull request
de release par release-please. Sa fusion crée le tag `vX.Y.Z` et la release
GitHub, puis déplace le tag majeur `vX` sur le même commit. Le secret
facultatif `RELEASE_TOKEN` ouvre cette pull request avec un jeton qui déclenche
la CI.

## Licence

[MIT](LICENSE).
