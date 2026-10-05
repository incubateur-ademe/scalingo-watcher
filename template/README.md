# Parc Scalingo

Ce dépôt décrit un parc d'applications Scalingo tenu à jour par
[scalingo-watcher](https://github.com/incubateur-ademe/scalingo-watcher). Il ne
contient que des données. Le moteur, les workflows et les presets Renovate
viennent de l'outil, à une version épinglée.

| Fichier | Rôle |
|---|---|
| `manifest.yaml` | Ce qui doit tourner sur chaque app. Édité à la main ou par Renovate. |
| `lock.json` | Ce qui tourne réellement. Écrit par le moteur, jamais à la main. |
| `fgp.json` | Blobs du proxy FGP, en accès par proxy uniquement. |
| `renovate.json` | Veille des versions du parc et des mises à jour de l'outil. |
| `.github/workflows/` | Appelants des workflows réutilisables de l'outil. |

Le manifeste livré avec ce template est fictif. L'installation le remplace par
celui du parc réel.

## Installation

Prérequis en local : Node et pnpm aux versions de l'outil (`.nvmrc` et
`packageManager` de son `package.json`), la CLI `gh`, et un jeton d'API
Scalingo d'un compte qui voit les apps du parc (dashboard Scalingo, profil puis
« Tokens API »).

### 1. Créer le dépôt

Créer le dépôt depuis ce template (« Use this template »).

Si l'organisation n'autorise que certaines actions (Settings, Actions,
« Allow select actions and reusable workflows »), autoriser
`incubateur-ademe/scalingo-watcher/*`, `pnpm/action-setup@*` et les actions
créées par GitHub.

### 2. Récupérer l'outil en local

Dans le dépôt, au même emplacement que dans les workflows. Le dossier est
ignoré par git.

```bash
git clone --depth 1 --branch v1.0.0 https://github.com/incubateur-ademe/scalingo-watcher .scalingo-watcher
pnpm --dir .scalingo-watcher install --frozen-lockfile
```

Les commandes suivantes se lancent depuis la racine du dépôt : le moteur lit
et écrit `manifest.yaml`, `lock.json` et `fgp.json` dans le répertoire courant.
Les scripts `pnpm` de l'outil, eux, s'exécutent dans son propre dossier, d'où
l'appel direct à `node`.

### 3. Générer le manifeste

```bash
export SCALINGO_API_TOKEN=tk-us-xxxxxxxx
node .scalingo-watcher/src/init.ts --region osc-fr1 --region osc-secnum-fr1 --force
```

`init` lit l'état réel de Scalingo sans rien modifier, et décrit chaque app dont
une variable d'environnement désigne un outil connu : version de l'outil, dépôt
et branche liés, sha déployé, version de la base. `--force` remplace le
manifeste d'exemple. `--app <fragment>` restreint aux apps dont le nom contient
ce fragment.

Relire ensuite l'ordre des apps. C'est l'ordre de déploiement : la première sert
d'éclaireur, et si son déploiement échoue la vague s'arrête. Ranger de la moins
critique à la plus critique.

### 4. Choisir l'accès à Scalingo

Deux modes, au choix :

- **Accès direct** : le secret `SCALINGO_API_TOKEN`, avec tout le pouvoir du
  compte. Rien à générer.
- **Proxy FGP** : le secret `FGP_KEY` et le fichier `fgp.json`, versionné. Chaque
  blob borne ce que la clé autorise à une méthode et un chemin. Le détail est
  dans [fgp.md](https://github.com/incubateur-ademe/scalingo-watcher/blob/v1.0.0/fgp.md).

Pour le proxy, générer `fgp.json` depuis le manifeste :

```bash
export FGP_KEY='<cle de 24 a 256 caracteres ASCII imprimables, sans espace>'
node .scalingo-watcher/src/fgp-blobs.ts --dry-run   # montre ce qui serait genere
node .scalingo-watcher/src/fgp-blobs.ts             # ecrit fgp.json
```

`--url <adresse>` vise un autre proxy que celui par défaut. Le jeton de compte
part chiffré dans les blobs et n'a plus à exister ensuite.

### 5. Amorcer le lock

```bash
node .scalingo-watcher/src/apply.ts --adopt
node .scalingo-watcher/src/apply.ts --dry-run
```

`--adopt` écrit l'état réel dans `lock.json` sans rien déployer. Le plan qui suit
doit annoncer chaque app « deja conforme ». Sans cet amorçage, tout apparaît
inconnu et le premier `apply` redéploierait le parc entier.

Commiter `manifest.yaml`, `lock.json` et, en accès par proxy, `fgp.json`, puis
pousser.

### 6. Créer l'environment et ses secrets

Les secrets vivent dans l'environment `production`, réservé à la branche
`main`. Seuls les jobs qui le déclarent les lisent, et seulement depuis `main`.
La validation, qui tourne sur les pull requests, n'y a pas accès, ni une branche
qui ajouterait un job déclarant l'environment.

```bash
gh api --method PUT "repos/{owner}/{repo}/environments/production" --input - <<'EOF'
{"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
EOF
gh api --method POST "repos/{owner}/{repo}/environments/production/deployment-branch-policies" -f name=main
gh api "repos/{owner}/{repo}/environments/production" --jq .deployment_branch_policy   # doit etre non nul
gh secret set FGP_KEY --env production              # ou SCALINGO_API_TOKEN en acces direct
```

Sans politique de branches, toute branche du dépôt peut déclarer l'environment
et lire ses secrets.

Les appelants de `.github/workflows/` mappent déjà chaque secret : le job appelé
ne lit la valeur de l'environment que pour un secret qu'on lui passe. Un secret
ajouté plus tard à l'environment doit aussi figurer dans leur bloc `secrets:`.

Notifications aux changements d'état, facultatives et cumulables. Les secrets
vont dans l'environment `production`.

| Canal | Configuration |
|---|---|
| Teams | Secret `TEAMS_WEBHOOK` : URL d'un webhook Workflows Power Automate |
| Slack, Mattermost, Rocket.Chat | Secret `SLACK_WEBHOOK` : URL de webhook entrant au format Slack |
| Tchap via passerelle | Secret `SLACK_WEBHOOK` : URL d'une passerelle au format Slack, comme [slack2tchap](https://github.com/betagouv/slack2tchap) |
| Tchap ou Matrix en direct | Secret `MATRIX_ACCESS_TOKEN` (jeton d'un compte bot membre du salon), inputs `matrix-homeserver` et `matrix-room-id` dans `reconcile.yml` et `apply.yml` |

```bash
gh secret set SLACK_WEBHOOK --env production
gh secret set MATRIX_ACCESS_TOKEN --env production
```

Sans canal configuré, seule l'issue de tableau de bord est tenue à jour.

### 7. Protéger `main` (recommandé)

Avec une branche protégée, le push du lock et l'ouverture des pull requests de
montée de base passent par un secret `PUSH_TOKEN`. C'est un PAT fine-grained
limité au dépôt, avec les droits Contents et Pull requests en écriture, d'un
compte autorisé à contourner la protection. Un jeton d'installation de GitHub
App ne convient pas, car il expire une heure après sa création.

```bash
gh secret set PUSH_TOKEN --env production
```

Il contourne la protection de `main`, donc il vit dans l'environment comme les
secrets d'accès, hors de portée des autres branches.

Sans `PUSH_TOKEN`, le `GITHUB_TOKEN` est utilisé. Il faut alors cocher « Allow
GitHub Actions to create and approve pull requests » (Settings, Actions,
General) pour que les montées de base soient proposées, et la validation ne se
déclenche pas sur ces pull requests.

Un dépôt privé d'une organisation sur plan gratuit ne peut pas protéger sa
branche.

### 8. Installer Renovate

Installer l'[app Renovate](https://github.com/apps/renovate) sur le dépôt. Il
contient déjà `renovate.json`, donc Renovate n'ouvre pas de pull request
d'accueil. Il ouvre directement celle qui épingle les workflows appelants par
sha (`@<sha> # v1.0.0`) : la fusionner.

### 9. Premier plan en CI

Lancer « appliquer le manifeste » depuis l'onglet Actions, `dry_run` coché (la
valeur par défaut). Le job lit l'état réel avec les secrets de l'environment.
Vérifier dans son journal que chaque app est conforme. Un plan ne touche pas au
tableau de bord.

### 10. Activer les déclencheurs

Décommenter `push` et `schedule` dans `.github/workflows/reconcile.yml`, et
`schedule` dans `.github/workflows/propose-db.yml`, puis pousser. Chaque fusion
du manifeste déclenche alors la convergence, et le cron rattrape ce qui a
divergé. Le premier passage réel, au prochain créneau du cron ou lancé à la
main, ouvre l'issue étiquetée `etat-parc`.

GitHub coupe les crons d'un dépôt public sans activité depuis 60 jours. Les
commits de lock et les pull requests Renovate suffisent à l'éviter ; sinon,
relancer un workflow à la main.

## Au quotidien

- Renovate propose les versions de l'outil (Metabase) et les commits du dépôt
  applicatif de chaque app. Les correctifs sont fusionnés seuls, les montées
  fonctionnelles attendent une relecture.
- Sur chaque pull request, « valider le manifeste » publie en commentaire ce que
  la fusion entraînera.
- La réconciliation relève l'état réel, signale les dérives, puis fait converger
  le parc. L'issue `etat-parc` décrit l'état courant.
- « proposer les montées de base » ouvre une pull request quand une base pilotée
  peut monter d'une version.

En local, depuis la racine du dépôt :

```bash
node .scalingo-watcher/src/audit.ts             # etat reel du parc, lecture seule
node .scalingo-watcher/src/apply.ts --dry-run   # ecart entre le manifeste et le lock
node .scalingo-watcher/src/apply.ts --validate  # schema et annotations du manifeste
node .scalingo-watcher/src/apply.ts --prune     # retire du lock les apps sorties du manifeste
```

## Mises à jour de l'outil

Une release de scalingo-watcher arrive dans une seule pull request Renovate,
7 jours après sa publication : elle avance le sha des workflows appelants et le
tag des presets de `renovate.json`. La validation y tourne avec la nouvelle
version. Elle n'est jamais fusionnée automatiquement : la fusionner après
lecture du CHANGELOG de l'outil.

Mettre ensuite le clone local à la même version :

```bash
git -C .scalingo-watcher fetch --depth 1 origin tag vX.Y.Z
git -C .scalingo-watcher checkout vX.Y.Z
pnpm --dir .scalingo-watcher install --frozen-lockfile
```
